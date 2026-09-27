/**
 * Tests for the two bounded capture lookups of `./sessions-repo.ts` —
 * `getLatestCapture` and `getPanelCapture` — and for its rewrite of a
 * follow-up that carries no attempt id, `replaceLatestFollowUp`.
 *
 * Both lookups exist for the panel-data resolver (`../panels/data.ts`) and the
 * panel-data route, and each replaces a read that answered correctly only by
 * reading too much or by reading the wrong thing:
 *
 * 1. **`getLatestCapture` is `listCaptures().at(-1)`, read as one row.** The
 *    resolver needs a session's newest capture on every panel node it serves,
 *    and taking the last element of the full listing parsed every capture and
 *    its summary to keep one. The suite pins the equivalence where it is
 *    easiest to break — two captures started in the same millisecond, and a
 *    capture written after a newer one but started before it — and pins the
 *    plan: one ordered read of `idx_captures_session_id_started_at`, no sort,
 *    no scan.
 * 2. **`getPanelCapture` answers a panel from its own capture.** A rendered
 *    panel must be resolved against the capture it was generated from, never
 *    against whichever capture is the session's newest, or an older panel
 *    silently shows a newer, perhaps still running, capture under its original
 *    findings. The suite links a panel to one capture, starts a newer one, and
 *    proves the lookup still names the first; it distinguishes an unknown panel
 *    (and another session's panel) from a known panel linked to no capture —
 *    never linked, or unlinked by the schema's `ON DELETE SET NULL` when the
 *    capture was purged — and refuses, as corrupt, a link the store's own
 *    writers can never produce.
 *
 * **`replaceLatestFollowUp` stamps only the entry it can prove it is.** The
 * session manager writes a follow-up's outcome links to its `followups` row in
 * the transaction that writes them to the record; for an entry stored before
 * attempts carried an identity there is no attempt id to find the row by, so
 * the session's newest row is rewritten in place — its id, its order and every
 * other row kept — and only when it carries no attempt id either and the same
 * `askedAt`. A missing or disagreeing row, or a record that does carry an
 * attempt id, is refused with nothing written. The question is never compared,
 * and never reaches a log line or an error.
 *
 * **A session's project-root identity is stored with the session or not at
 * all.** Schema version 6 of `./migrations.ts` adds `session_root_identities`,
 * the canonical path each session's root was admitted under, which the session
 * manager holds every sink to across a restart. The suite pins the step — a new
 * store carries the table with its constraints, the step is idempotent, and a
 * version-5 store gains it with every row kept and nothing backfilled — and the
 * repository's half: `insert` with `canonicalRoot` writes the session and its
 * identity in one transaction, so a refused identity leaves no session behind;
 * `getRootIdentity` reads it back, answers `undefined` for a session stored
 * without one, and refuses a blank id; deleting the session removes the row
 * through `ON DELETE CASCADE`; and no log line or error carries the path.
 *
 * The store is the real one: `openStore` against a file in an `mkdtemp`
 * sandbox — never `:memory:` — so the real DDL, the migration ladder and the
 * `foreign_keys` pragma (which is what performs the `SET NULL`) are exercised.
 * Sessions and captures are written through the repository under test, and
 * panels through the real `createPanelsRepo`, which validates every document
 * with `parsePanelSpec`, so no fixture is a shape the service never writes. Raw
 * SQL is used only to damage a row on purpose or to read the `followups` row
 * ids the repository does not expose. Nothing under `$DEBUGGEN_HOME`
 * is touched, no environment variable is read and no socket is opened, which
 * is the contract of the `local-service` Vitest project; each test owns its
 * sandbox, store and clock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PanelSpec } from '@debuggen/panel-schema';
import { FOLLOW_UP_ATTEMPT_ID_PREFIX, parseSessionRecord } from '@debuggen/protocol';
import type { FollowUpRecord, SessionRecord } from '@debuggen/protocol';
import {
  isErr,
  newAnalysisId,
  newCaptureId,
  newId,
  newPanelId,
  newSessionId,
  noopLogger,
  unwrap,
} from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  PanelId,
  Result,
  SessionId,
} from '@debuggen/shared';

import { openStore } from './db.js';
import type { Store } from './db.js';
import { STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from './migrations.js';
import { createPanelsRepo } from './panels-repo.js';
import type { PanelsRepo } from './panels-repo.js';
import { createSessionsRepo } from './sessions-repo.js';
import type { PanelCaptureLookup, SessionsRepo, StoredCapture } from './sessions-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The epoch-millisecond reading every test's clock starts from. */
const CLOCK_START = 1_767_225_600_000;

/**
 * The string the privacy assertions look for, planted in a damaged row.
 *
 * Shaped like something that must never be logged and unlikely to occur by
 * accident, so a match is unambiguous.
 */
const SENTINEL = 'CAPTURE-SENTINEL-5b2e9d71-never-log-me';

/** The sandbox directory holding the database — and nothing else — for one test. */
let directory: string;

/** The store under the repositories. */
let store: Store;

/** Every call the repositories made on the capturing logger. */
let logs: CapturedLog[];

/** The repository under test. */
let sessions: SessionsRepo;

/** The panel repository that writes the `panels` rows the join reads. */
let panels: PanelsRepo;

/** The session most tests work in. */
let sessionA: SessionId;

/** A second session, for the scoping assertions. */
let sessionB: SessionId;

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A {@link Logger} that records every call as `{ level, message, fields }`,
 * bindings merged under each call's own fields, with no formatting layer that
 * could drop a value before the privacy assertions look at it.
 *
 * @param sink Where every call is recorded.
 * @param bindings The fields a {@link Logger.child} added.
 * @returns The logger.
 */
function createCapturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (childBindings: LogFields): Logger =>
      createCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/**
 * A new session's record, built through the protocol's own validator so the
 * repository receives exactly the shape the session manager writes.
 */
function makeSession(id: SessionId): SessionRecord {
  return unwrap(
    parseSessionRecord({
      id,
      projectRoot: '/workspace/project-one',
      projectName: 'project-one',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: CLOCK_START,
      updatedAt: CLOCK_START,
      status: 'capturing',
      question: 'Why is handlerAlpha slow?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/**
 * Opens a capture window at `startedAt` and, unless `open` is set, closes it one
 * millisecond later — the store refuses a second open capture per session, so
 * a history of several captures is written one window at a time.
 *
 * @returns The capture's id.
 */
function recordCapture(sessionId: SessionId, startedAt: number, open = false): CaptureId {
  const captureId = newCaptureId();

  unwrap(sessions.startCapture({ sessionId, planVersion: 1, captureId, startedAt }));

  if (!open) {
    unwrap(sessions.stopCapture({ captureId, stoppedAt: startedAt + 1 }));
  }

  return captureId;
}

/**
 * A minimal valid panel: one event-log node over the `events` source. A version
 * above the first supersedes the session's previous panel, as a regenerated
 * panel does, so every document is one `parsePanelSpec` accepts.
 */
function makePanel(sessionId: SessionId, panelVersion = 1, supersedes?: PanelId): PanelSpec {
  return {
    version: 1,
    id: newPanelId(),
    sessionId,
    panelVersion,
    ...(supersedes === undefined ? {} : { supersedes }),
    title: 'Panel alpha',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** Stores a panel through the real panel repository, optionally linked to a capture. */
function storePanel(spec: PanelSpec, captureId?: CaptureId): PanelId {
  return unwrap(panels.insertPanel(spec, captureId === undefined ? {} : { captureId })).id;
}

/** The refusal a call answered with; fails the test when it succeeded. */
function refusalOf(result: Result<unknown, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('The call succeeded where the test expected a refusal.');
  }

  return result.error;
}

/** Everything an error carries, as one searchable string. */
function errorText(error: DebuggenError): string {
  return JSON.stringify({ message: error.message, hint: error.hint, details: error.details });
}

/** The capture a lookup found; fails the test when the panel was unknown or unlinked. */
function linkedCapture(result: Result<PanelCaptureLookup, DebuggenError>): StoredCapture {
  const lookup = unwrap(result);

  if (lookup.panel !== 'found' || lookup.capture === undefined) {
    throw new Error('The lookup found no linked capture where the test expected one.');
  }

  return lookup.capture;
}

/**
 * A store handle that records the text of every statement prepared through it
 * and is otherwise the real store, so a plan assertion explains the exact text
 * the repository ran rather than a copy of it.
 *
 * @param real The suite's store.
 * @param texts Receives each statement text, in the order it was prepared.
 * @returns The recording handle.
 */
function recordingStore(real: Store, texts: string[]): Store {
  const statement: Store['statement'] = (sql) => {
    texts.push(sql);

    return real.statement(sql);
  };

  return new Proxy(real, {
    get(target, property): unknown {
      if (property === 'statement') {
        return statement;
      }

      const value: unknown = Reflect.get(target, property, target);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Runs one read through a repository over a {@link recordingStore} and returns
 * the one statement it prepared.
 *
 * @param read The repository call.
 * @returns The statement text.
 */
function statementRunBy(read: (repo: SessionsRepo) => Result<unknown, DebuggenError>): string {
  const texts: string[] = [];
  const result = read(createSessionsRepo({ store: recordingStore(store, texts) }));

  if (isErr(result)) {
    throw new Error(`A plan case expected its read to succeed: ${result.error.code}`);
  }

  expect(texts).toHaveLength(1);

  const [sql] = texts;

  if (sql === undefined) {
    throw new Error('The read prepared no statement.');
  }

  return sql;
}

/** The `EXPLAIN QUERY PLAN` lines of a statement, joined. */
function queryPlan(sql: string): string {
  return store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row['detail']))
    .join(' | ');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-sessions-'));
  logs = [];

  const logger = createCapturingLogger(logs);
  const now = (): number => CLOCK_START;

  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  sessions = createSessionsRepo({ store, logger, now });
  panels = createPanelsRepo({ store, now });
  sessionA = newSessionId();
  sessionB = newSessionId();

  unwrap(sessions.insert(makeSession(sessionA)));
  unwrap(sessions.insert(makeSession(sessionB)));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * The contract
 * ---------------------------------------------------------------------------------------------- */

describe('the contract', () => {
  it('exposes both bounded capture lookups beside the listing they replace', () => {
    for (const member of ['listCaptures', 'getLatestCapture', 'getPanelCapture'] as const) {
      expect(typeof sessions[member]).toBe('function');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * getLatestCapture
 * ---------------------------------------------------------------------------------------------- */

describe('getLatestCapture', () => {
  it('answers undefined for a session with no capture and for one the store does not hold', () => {
    expect(unwrap(sessions.getLatestCapture(sessionA))).toBeUndefined();
    expect(unwrap(sessions.getLatestCapture(newSessionId()))).toBeUndefined();
  });

  it('equals the last capture listCaptures lists, including a same-millisecond tie', () => {
    const first = recordCapture(sessionA, CLOCK_START);
    const tiedEarlier = recordCapture(sessionA, CLOCK_START + 10);
    // Same started_at as the capture above, written after it: the listing
    // breaks the tie by rowid, so this one is the newest.
    const tiedLater = recordCapture(sessionA, CLOCK_START + 10);
    // Written last but started first: start time, not insertion order, decides.
    const backdated = recordCapture(sessionA, CLOCK_START - 5);
    // Another session's later capture must never be reached.
    recordCapture(sessionB, CLOCK_START + 100);

    const listed = unwrap(sessions.listCaptures(sessionA));

    expect(listed.map((stored) => stored.capture.id)).toEqual([
      backdated,
      first,
      tiedEarlier,
      tiedLater,
    ]);

    const latest = unwrap(sessions.getLatestCapture(sessionA));

    expect(latest).toEqual(listed.at(-1));
    expect(latest?.capture.id).toBe(tiedLater);
    expect(latest?.sessionId).toBe(sessionA);
  });

  it('returns the open capture while it is the newest one', () => {
    recordCapture(sessionA, CLOCK_START);
    const running = recordCapture(sessionA, CLOCK_START + 10, true);

    const latest = unwrap(sessions.getLatestCapture(sessionA));

    expect(latest?.capture.id).toBe(running);
    expect(latest?.capture.stoppedAt).toBeUndefined();
    expect(latest).toEqual(unwrap(sessions.getActiveCapture(sessionA)));
    expect(latest).toEqual(unwrap(sessions.listCaptures(sessionA)).at(-1));
  });

  it('refuses a blank session id before it reaches the store', () => {
    const refusal = refusalOf(sessions.getLatestCapture(''));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('invalid-argument');
    expect(refusal.details?.['field']).toBe('sessionId');
  });

  it('reports an unreadable newest row as corrupt, by id and never by content', () => {
    recordCapture(sessionA, CLOCK_START);
    const damaged = recordCapture(sessionA, CLOCK_START + 10);

    store
      .statement('UPDATE captures SET summary = ? WHERE id = ?')
      .run(`{"note": "${SENTINEL}"`, damaged);

    const refusal = refusalOf(sessions.getLatestCapture(sessionA));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('corrupt-row');
    expect(refusal.details?.['captureId']).toBe(damaged);
    expect(errorText(refusal)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(
      logs.some((record) => record.level === 'warn' && record.fields['reason'] === 'corrupt-row'),
    ).toBe(true);
  });

  it('reads one ordered row of idx_captures_session_id_started_at, with no sort and no scan', () => {
    recordCapture(sessionA, CLOCK_START);
    recordCapture(sessionA, CLOCK_START + 10);

    const plan = queryPlan(statementRunBy((repo) => repo.getLatestCapture(sessionA)));

    expect(plan).toContain(
      'SEARCH captures USING INDEX idx_captures_session_id_started_at (session_id=?)',
    );
    expect(plan).not.toContain('TEMP B-TREE');
    expect(plan).not.toContain('SCAN captures');
  });
});

/* -------------------------------------------------------------------------------------------------
 * getPanelCapture
 * ---------------------------------------------------------------------------------------------- */

describe('getPanelCapture', () => {
  it('answers unknown for a panel id the store does not hold', () => {
    recordCapture(sessionA, CLOCK_START);

    expect(unwrap(sessions.getPanelCapture(sessionA, newPanelId()))).toEqual({ panel: 'unknown' });
  });

  it('answers unknown for a panel of another session, even one linked to a capture', () => {
    const captureOfB = recordCapture(sessionB, CLOCK_START);
    const panelOfB = storePanel(makePanel(sessionB), captureOfB);

    expect(unwrap(sessions.getPanelCapture(sessionA, panelOfB))).toEqual({ panel: 'unknown' });
    expect(linkedCapture(sessions.getPanelCapture(sessionB, panelOfB)).capture.id).toBe(captureOfB);
  });

  it('names the capture a panel was generated from, not the session\u2019s newest one', () => {
    const generatedFrom = recordCapture(sessionA, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), generatedFrom);
    // A newer capture — still running — opened after the panel was generated.
    const newer = recordCapture(sessionA, CLOCK_START + 10, true);

    const found = linkedCapture(sessions.getPanelCapture(sessionA, panelId));

    expect(found.capture.id).toBe(generatedFrom);
    expect(found).toEqual(unwrap(sessions.getCapture(generatedFrom)));
    expect(unwrap(sessions.getLatestCapture(sessionA))?.capture.id).toBe(newer);
  });

  it('answers found with no capture for a panel stored without one', () => {
    const linked = recordCapture(sessionA, CLOCK_START);
    const first = storePanel(makePanel(sessionA), linked);
    const unlinked = storePanel(makePanel(sessionA, 2, first));

    expect(unwrap(sessions.getPanelCapture(sessionA, unlinked))).toEqual({
      panel: 'found',
      capture: undefined,
    });
  });

  it('answers found with no capture once the panel\u2019s capture has been purged', () => {
    const purged = recordCapture(sessionA, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), purged);

    // The schema's ON DELETE SET NULL unlinks the panel; the panel stays.
    store.statement('DELETE FROM captures WHERE id = ?').run(purged);

    expect(unwrap(sessions.getPanelCapture(sessionA, panelId))).toEqual({
      panel: 'found',
      capture: undefined,
    });
  });

  it('refuses a blank session id or panel id before it reaches the store', () => {
    const panelId = storePanel(makePanel(sessionA));

    for (const [call, field] of [
      [() => sessions.getPanelCapture('', panelId), 'sessionId'],
      [() => sessions.getPanelCapture(sessionA, ''), 'panelId'],
    ] as const) {
      const refusal = refusalOf(call());

      expect(refusal.code).toBe('STORE_ERROR');
      expect(refusal.details?.['reason']).toBe('invalid-argument');
      expect(refusal.details?.['field']).toBe(field);
    }
  });

  it('reports an unreadable linked capture as corrupt, by id and never by content', () => {
    const damaged = recordCapture(sessionA, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), damaged);

    store
      .statement('UPDATE captures SET summary = ? WHERE id = ?')
      .run(`{"note": "${SENTINEL}"`, damaged);

    const refusal = refusalOf(sessions.getPanelCapture(sessionA, panelId));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('corrupt-row');
    expect(refusal.details?.['captureId']).toBe(damaged);
    expect(errorText(refusal)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it('refuses a link to another session\u2019s capture as corrupt instead of returning it', () => {
    const own = recordCapture(sessionA, CLOCK_START);
    const foreign = recordCapture(sessionB, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), own);

    // The panel repository refuses such a link on write, so only an altered
    // row can hold one.
    store.statement('UPDATE panels SET capture_id = ? WHERE id = ?').run(foreign, panelId);

    const refusal = refusalOf(sessions.getPanelCapture(sessionA, panelId));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('corrupt-row');
    expect(refusal.details?.['mismatch']).toBe('session');
    expect(refusal.details?.['panelId']).toBe(panelId);
    expect(errorText(refusal)).not.toContain(sessionB);
  });

  it('refuses a dangling link, possible only without the foreign key, as corrupt', () => {
    const vanished = recordCapture(sessionA, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), vanished);

    // With the pragma off, deleting the capture leaves the panel's link in place.
    store.db.exec('PRAGMA foreign_keys = OFF');
    store.statement('DELETE FROM captures WHERE id = ?').run(vanished);
    store.db.exec('PRAGMA foreign_keys = ON');

    const refusal = refusalOf(sessions.getPanelCapture(sessionA, panelId));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('corrupt-row');
    expect(refusal.details?.['mismatch']).toBe('capture-missing');
    expect(refusal.details?.['captureId']).toBe(vanished);
  });

  it('reads the panel and its capture by primary key, with no scan', () => {
    const captureId = recordCapture(sessionA, CLOCK_START);
    const panelId = storePanel(makePanel(sessionA), captureId);

    const plan = queryPlan(statementRunBy((repo) => repo.getPanelCapture(sessionA, panelId)));

    expect(plan).toMatch(/SEARCH p USING (?:COVERING )?INDEX \S+ \(id=\?\)/u);
    expect(plan).toMatch(/SEARCH c USING (?:COVERING )?INDEX \S+ \(id=\?\) LEFT-JOIN/u);
    expect(plan).not.toContain('SCAN');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});

/* -------------------------------------------------------------------------------------------------
 * replaceLatestFollowUp
 * ---------------------------------------------------------------------------------------------- */

describe('replaceLatestFollowUp', () => {
  /** A follow-up stored before attempts carried an identity; its question carries the sentinel. */
  function legacyFollowUp(askedAt: number): FollowUpRecord {
    return { question: `Which request waits longest? ${SENTINEL}`, askedAt };
  }

  /** The outcome links an answer stamps, freshly minted. */
  function answered(followUp: FollowUpRecord): FollowUpRecord {
    return {
      ...followUp,
      needsNewCapture: false,
      captureId: newCaptureId(),
      analysisId: newAnalysisId(),
      panelId: newPanelId(),
    };
  }

  /** The row ids of a session's follow-ups, in the order they were asked. */
  function followUpRowIds(sessionId: SessionId): unknown[] {
    return store
      .statement('SELECT id FROM followups WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId)
      .map((row) => row['id']);
  }

  it('rewrites the newest unidentified row in place, leaving every other row as it was', () => {
    const older = legacyFollowUp(CLOCK_START);
    const newest = legacyFollowUp(CLOCK_START + 10);
    const otherSession = legacyFollowUp(CLOCK_START + 10);
    unwrap(sessions.appendFollowUp(sessionA, older));
    unwrap(sessions.appendFollowUp(sessionA, newest));
    unwrap(sessions.appendFollowUp(sessionB, otherSession));
    const ids = followUpRowIds(sessionA);
    const stamped = answered(newest);

    expect(unwrap(sessions.replaceLatestFollowUp(sessionA, stamped))).toEqual(stamped);

    expect(unwrap(sessions.listFollowUps(sessionA))).toEqual([older, stamped]);
    expect(followUpRowIds(sessionA)).toEqual(ids);
    expect(unwrap(sessions.listFollowUps(sessionB))).toEqual([otherSession]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it('refuses a session that logs no follow-up, writing nothing', () => {
    const refusal = refusalOf(
      sessions.replaceLatestFollowUp(sessionA, answered(legacyFollowUp(CLOCK_START))),
    );

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('follow-up-not-found');
    expect(unwrap(sessions.listFollowUps(sessionA))).toEqual([]);
    expect(errorText(refusal)).not.toContain(SENTINEL);
  });

  it.each([
    {
      newest: 'carries an attempt id',
      logged: (entry: FollowUpRecord): FollowUpRecord => ({
        ...entry,
        attemptId: newId(FOLLOW_UP_ATTEMPT_ID_PREFIX),
        attempt: 1,
      }),
    },
    {
      newest: 'was asked at another instant',
      logged: (entry: FollowUpRecord): FollowUpRecord => ({
        ...entry,
        askedAt: entry.askedAt + 1,
      }),
    },
  ])('refuses the rewrite when the newest row $newest, writing nothing', ({ logged }) => {
    const entry = legacyFollowUp(CLOCK_START + 10);
    // An older row that would match is not the newest, so it is never taken.
    unwrap(sessions.appendFollowUp(sessionA, entry));
    unwrap(sessions.appendFollowUp(sessionA, logged(entry)));
    const rowsBefore = unwrap(sessions.listFollowUps(sessionA));

    const refusal = refusalOf(sessions.replaceLatestFollowUp(sessionA, answered(entry)));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('follow-up-log-disagrees');
    expect(unwrap(sessions.listFollowUps(sessionA))).toEqual(rowsBefore);
    expect(errorText(refusal)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(
      logs.some(
        (record) =>
          record.level === 'warn' && record.fields['reason'] === 'follow-up-log-disagrees',
      ),
    ).toBe(true);
  });

  it('refuses a record carrying an attempt id, which is rewritten by that id instead', () => {
    unwrap(sessions.appendFollowUp(sessionA, legacyFollowUp(CLOCK_START)));
    const rowsBefore = unwrap(sessions.listFollowUps(sessionA));

    const refusal = refusalOf(
      sessions.replaceLatestFollowUp(sessionA, {
        ...answered(legacyFollowUp(CLOCK_START)),
        attemptId: newId(FOLLOW_UP_ATTEMPT_ID_PREFIX),
        attempt: 1,
      }),
    );

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('invalid-follow-up');
    expect(unwrap(sessions.listFollowUps(sessionA))).toEqual(rowsBefore);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Schema version 6 — the persisted project-root identity
 * ---------------------------------------------------------------------------------------------- */

/** The table schema version 6 adds. */
const IDENTITY_TABLE = 'session_root_identities';

/** The description the version-6 ladder step logs and reports. */
const VERSION_6_DESCRIPTION =
  'record the canonical project-root identity each session was admitted under';

/** The SQLite extended result code of a `CHECK` constraint failure. */
const SQLITE_CONSTRAINT_CHECK = 275;

/** The SQLite extended result code of a `STRICT` column refusing a value of another type. */
const SQLITE_CONSTRAINT_DATATYPE = 3091;

/** The SQLite extended result code of a `NOT NULL` constraint failure. */
const SQLITE_CONSTRAINT_NOTNULL = 1299;

/** The SQLite extended result code of a `REFERENCES` edge that found no parent row. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/** A raw insert into {@link IDENTITY_TABLE}, past the repository on purpose. */
const RAW_IDENTITY_INSERT_SQL = `INSERT INTO ${IDENTITY_TABLE} (session_id, canonical_root, recorded_at) VALUES (?, ?, ?)`;

/** The canonical path the identity cases record: absolute and never a real directory. */
const CANONICAL_ROOT = '/private/workspace/project-one';

/**
 * The SQLite extended result code a statement failed with, or `undefined` when
 * it succeeded. A throw that carries no code is rethrown.
 */
function errcodeOf(action: () => void): number | undefined {
  try {
    action();
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'errcode' in cause) {
      const { errcode } = cause;

      return typeof errcode === 'number' ? errcode : undefined;
    }

    throw cause;
  }

  return undefined;
}

/** The DDL `db` holds for {@link IDENTITY_TABLE}, or `undefined` when it has none. */
function identityTableSql(db: DatabaseSync): string | undefined {
  const sql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(IDENTITY_TABLE)?.['sql'];

  return typeof sql === 'string' ? sql : undefined;
}

/** Every identity row, by session id. */
function identityRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${IDENTITY_TABLE} ORDER BY session_id`).all();
}

/** Every `sessions` row and every cleanup summary, as stored. */
function sessionTables(db: DatabaseSync): Record<string, unknown> {
  return {
    sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
    summaries: db.prepare('SELECT * FROM session_cleanup_summaries ORDER BY session_id').all(),
  };
}

describe('schema version 6 adds the persisted project-root identity', () => {
  it('declares the step on the ladder and stamps a new store at the current version', () => {
    const step = STORE_MIGRATIONS.find((candidate) => candidate.version === 6);

    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(step?.description).toBe(VERSION_6_DESCRIPTION);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(store.db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(
      STORE_SCHEMA_VERSION,
    );
  });

  it('gives a new store a STRICT, WITHOUT ROWID table keyed by the session and removed with it', () => {
    expect(
      store.db
        .prepare(`SELECT name, type, pk FROM pragma_table_info('${IDENTITY_TABLE}') ORDER BY cid`)
        .all(),
    ).toEqual([
      { name: 'session_id', type: 'TEXT', pk: 1 },
      { name: 'canonical_root', type: 'TEXT', pk: 0 },
      { name: 'recorded_at', type: 'INTEGER', pk: 0 },
    ]);
    expect(
      store.db
        .prepare('SELECT strict, wr FROM pragma_table_list WHERE name = ?')
        .get(IDENTITY_TABLE),
    ).toEqual({ strict: 1, wr: 1 });
    expect(
      store.db
        .prepare(
          `SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('${IDENTITY_TABLE}')`,
        )
        .all(),
    ).toEqual([{ table: 'sessions', from: 'session_id', to: 'id', on_delete: 'CASCADE' }]);
  });

  it('has the database itself refuse an empty, mistyped, missing or orphaned identity', () => {
    const insert = store.db.prepare(RAW_IDENTITY_INSERT_SQL);

    expect(errcodeOf(() => insert.run(sessionA, '', CLOCK_START))).toBe(SQLITE_CONSTRAINT_CHECK);
    // `STRICT` converts only losslessly: a timestamp that is not a number is refused.
    expect(errcodeOf(() => insert.run(sessionA, CANONICAL_ROOT, 'yesterday'))).toBe(
      SQLITE_CONSTRAINT_DATATYPE,
    );
    expect(errcodeOf(() => insert.run(sessionA, null, CLOCK_START))).toBe(
      SQLITE_CONSTRAINT_NOTNULL,
    );
    expect(errcodeOf(() => insert.run(newSessionId(), CANONICAL_ROOT, CLOCK_START))).toBe(
      SQLITE_CONSTRAINT_FOREIGNKEY,
    );
    expect(identityRows(store.db)).toEqual([]);

    // A well-formed identity of a stored session is storable.
    expect(errcodeOf(() => insert.run(sessionA, CANONICAL_ROOT, CLOCK_START))).toBeUndefined();
    expect(identityRows(store.db)).toEqual([
      { session_id: sessionA, canonical_root: CANONICAL_ROOT, recorded_at: CLOCK_START },
    ]);
  });

  it('is idempotent: the step leaves a store that already has the table, and its rows, untouched', () => {
    const step = STORE_MIGRATIONS.find((candidate) => candidate.version === 6);

    if (step === undefined) {
      throw new Error('the ladder has no version-6 step');
    }

    store.db.prepare(RAW_IDENTITY_INSERT_SQL).run(sessionA, CANONICAL_ROOT, CLOCK_START);
    const tableBefore = identityTableSql(store.db);
    const rowsBefore = identityRows(store.db);

    step.apply(store.db, { ddl: '', logger: noopLogger, now: () => CLOCK_START });

    expect(identityTableSql(store.db)).toBe(tableBefore);
    expect(identityRows(store.db)).toEqual(rowsBefore);
  });

  it('migrates a version-5 store forward, keeping every row and backfilling no identity', () => {
    // One of the two sessions has ended: the step's report counts only the
    // sessions whose sinks the manager would now refuse.
    unwrap(sessions.setStatus(sessionB, 'ended'));
    const databasePath = store.path;

    store.close();

    // Turn the file back into what a version-5 build left behind: stamped 5,
    // with no identity table, every session row intact.
    const legacy = new DatabaseSync(databasePath);
    let before: Record<string, unknown>;

    try {
      legacy.exec(`DROP TABLE ${IDENTITY_TABLE}`);
      legacy.exec('PRAGMA user_version = 5');

      expect(identityTableSql(legacy)).toBeUndefined();

      before = sessionTables(legacy);
    } finally {
      legacy.close();
    }

    const migrationLogs: CapturedLog[] = [];
    const logger = createCapturingLogger(migrationLogs);

    store = unwrap(openStore({ databasePath, logger }));
    sessions = createSessionsRepo({ store, logger, now: () => CLOCK_START });

    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(store.db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(
      STORE_SCHEMA_VERSION,
    );
    expect(
      store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.['value'],
    ).toBe(String(STORE_SCHEMA_VERSION));
    expect(identityTableSql(store.db)).toContain('WITHOUT ROWID');

    // Every rung above version 5 ran once, lowest first: version 6 leads.
    const applied = migrationLogs.filter((record) =>
      record.message.startsWith('applied store migration'),
    );

    expect(applied).toHaveLength(STORE_SCHEMA_VERSION - 5);
    expect(applied[0]?.message).toBe(`applied store migration 6 (${VERSION_6_DESCRIPTION})`);

    // Additive, and nothing identified after the fact: every session row and
    // summary is as it was, and no session gained an identity.
    expect(sessionTables(store.db)).toEqual(before);
    expect(identityRows(store.db)).toEqual([]);
    expect(unwrap(sessions.getRootIdentity(sessionA))).toBeUndefined();

    // The live session left without an identity is reported by count only.
    expect(
      migrationLogs
        .filter((record) => record.fields['unidentifiedSessions'] !== undefined)
        .map((record) => [record.level, record.fields['unidentifiedSessions']] as const),
    ).toEqual([['warn', 1]]);

    const logged = JSON.stringify(migrationLogs);

    for (const needle of [sessionA, sessionB, '/workspace/project-one']) {
      expect(logged).not.toContain(needle);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The project-root identity, stored with its session
 * ---------------------------------------------------------------------------------------------- */

describe('insert with canonicalRoot and getRootIdentity', () => {
  /** A canonical path carrying the privacy sentinel, for the cases that assert it is never logged. */
  const SENTINEL_ROOT = `/private/workspace/${SENTINEL}`;

  /** The temporary trigger that refuses every identity write, dropped by the case that plants it. */
  const REFUSE_IDENTITY_TRIGGER = 'sessions_suite_refuse_root_identity';

  it('stores the session and its identity in one write, and reads the identity back', () => {
    const sessionC = newSessionId();

    const stored = unwrap(sessions.insert(makeSession(sessionC), { canonicalRoot: SENTINEL_ROOT }));

    expect(stored).toEqual(unwrap(sessions.get(sessionC)));
    expect(unwrap(sessions.getRootIdentity(sessionC))).toBe(SENTINEL_ROOT);
    expect(identityRows(store.db).filter((row) => row['session_id'] === sessionC)).toEqual([
      { session_id: sessionC, canonical_root: SENTINEL_ROOT, recorded_at: CLOCK_START },
    ]);

    // The store line says an identity was recorded, never which.
    expect(
      logs
        .filter(
          (record) =>
            record.message === 'session stored' && record.fields['sessionId'] === sessionC,
        )
        .map((record) => record.fields['rootIdentity']),
    ).toEqual([true]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it('answers undefined for a session stored without an identity and for an id the store does not hold', () => {
    expect(unwrap(sessions.getRootIdentity(sessionA))).toBeUndefined();
    expect(unwrap(sessions.getRootIdentity(newSessionId()))).toBeUndefined();
    expect(
      logs
        .filter(
          (record) =>
            record.message === 'session stored' && record.fields['sessionId'] === sessionA,
        )
        .map((record) => record.fields['rootIdentity']),
    ).toEqual([false]);
  });

  it('stores nothing when the identity cannot be written: the session’s insert rolls back with it', () => {
    const sessionC = newSessionId();

    store.db.exec(
      `CREATE TEMP TRIGGER ${REFUSE_IDENTITY_TRIGGER} BEFORE INSERT ON ${IDENTITY_TABLE}
       BEGIN SELECT RAISE(ABORT, 'injected identity write failure'); END`,
    );

    try {
      const refusal = refusalOf(
        sessions.insert(makeSession(sessionC), { canonicalRoot: SENTINEL_ROOT }),
      );

      expect(refusal.code).toBe('STORE_ERROR');
      expect(refusal.details?.['reason']).toBe('store-failed');
      expect(errorText(refusal)).not.toContain(SENTINEL);
    } finally {
      store.db.exec(`DROP TRIGGER IF EXISTS temp.${REFUSE_IDENTITY_TRIGGER}`);
    }

    // Neither the session, nor its summary, nor an identity was left behind…
    expect(unwrap(sessions.get(sessionC))).toBeUndefined();
    expect(
      store.db
        .prepare('SELECT session_id FROM session_cleanup_summaries WHERE session_id = ?')
        .get(sessionC),
    ).toBeUndefined();
    expect(unwrap(sessions.getRootIdentity(sessionC))).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);

    // …so the same session can be stored whole once the write is possible again.
    unwrap(sessions.insert(makeSession(sessionC), { canonicalRoot: SENTINEL_ROOT }));
    expect(unwrap(sessions.getRootIdentity(sessionC))).toBe(SENTINEL_ROOT);
  });

  it('refuses an identity that could never be a path before anything is written, naming only the field', () => {
    for (const canonicalRoot of ['', `${SENTINEL_ROOT}\u0000/tail`]) {
      const sessionC = newSessionId();

      const refusal = refusalOf(sessions.insert(makeSession(sessionC), { canonicalRoot }));

      expect(refusal.code).toBe('STORE_ERROR');
      expect(refusal.details?.['reason']).toBe('invalid-argument');
      expect(refusal.details?.['field']).toBe('canonicalRoot');
      expect(errorText(refusal)).not.toContain(SENTINEL);
      expect(unwrap(sessions.get(sessionC))).toBeUndefined();
    }

    expect(identityRows(store.db)).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it('refuses a blank session id before it reaches the store', () => {
    const refusal = refusalOf(sessions.getRootIdentity(''));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('invalid-argument');
    expect(refusal.details?.['field']).toBe('sessionId');
  });

  it('reports a row altered past the table’s CHECK as corrupt, by id and never by content', () => {
    const sessionC = newSessionId();
    unwrap(sessions.insert(makeSession(sessionC), { canonicalRoot: SENTINEL_ROOT }));

    // What only a writer that switched the constraint off could leave behind.
    store.db.exec('PRAGMA ignore_check_constraints = ON');

    try {
      store.db
        .prepare(`UPDATE ${IDENTITY_TABLE} SET canonical_root = '' WHERE session_id = ?`)
        .run(sessionC);
    } finally {
      store.db.exec('PRAGMA ignore_check_constraints = OFF');
    }

    const refusal = refusalOf(sessions.getRootIdentity(sessionC));

    expect(refusal.code).toBe('STORE_ERROR');
    expect(refusal.details?.['reason']).toBe('corrupt-row');
    expect(refusal.details?.['table']).toBe(IDENTITY_TABLE);
    expect(refusal.details?.['sessionId']).toBe(sessionC);
    expect(
      logs.some(
        (record) =>
          record.level === 'warn' &&
          record.fields['operation'] === 'getRootIdentity' &&
          record.fields['reason'] === 'corrupt-row',
      ),
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it('removes the identity with its session through ON DELETE CASCADE', () => {
    const sessionC = newSessionId();
    unwrap(sessions.insert(makeSession(sessionC), { canonicalRoot: SENTINEL_ROOT }));
    unwrap(sessions.insert(makeSession(newSessionId()), { canonicalRoot: CANONICAL_ROOT }));

    expect(unwrap(sessions.delete(sessionC))).toBe(1);

    expect(unwrap(sessions.getRootIdentity(sessionC))).toBeUndefined();
    expect(identityRows(store.db).map((row) => row['canonical_root'])).toEqual([CANONICAL_ROOT]);
  });

  it('reads the identity by primary key, with no scan', () => {
    const sql = statementRunBy((repo) => repo.getRootIdentity(sessionA));

    expect(sql).toContain(IDENTITY_TABLE);
    expect(queryPlan(sql)).toMatch(
      /SEARCH session_root_identities USING PRIMARY KEY \(session_id=\?\)/u,
    );
  });
});
