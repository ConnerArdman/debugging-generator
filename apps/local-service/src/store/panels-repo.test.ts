/**
 * Tests for the version-ladder rules `./panels-repo.ts` enforces when a panel
 * or an analysis is stored.
 *
 * A follow-up answered from existing evidence stores version *n + 1* of both
 * documents with `supersedes` naming version *n* (AAP 0.4.2). The store is where
 * that chain is kept true: it is the one place every writer passes, and the one
 * place that sees the rows a write lands beside, because its checks run inside
 * the insert's `BEGIN IMMEDIATE` transaction. The suite pins, for **both**
 * ladders — `panels` and `analyses` share one implementation, and a rule that
 * held on one of them alone is exactly the drift that shared descriptor exists
 * to prevent:
 *
 * 1. an unbroken chain v1 → v2 → v3 is accepted, read back in order and
 *    followed by the latest-read (and, for panels, by `listSupersededBy`);
 * 2. every broken link is refused as `STORE_ERROR` with its own
 *    `details.reason`, and writes nothing to either table: a predecessor the
 *    ladder does not hold (`supersedes-unknown`), one of another session
 *    (`supersedes-other-session`), one that is not earlier
 *    (`supersedes-not-earlier`), one that is no longer the latest
 *    (`supersedes-stale` — two follow-ups that decided against the same rung,
 *    on one handle and across two connections), a version that skips a rung
 *    (`supersedes-not-adjacent`), and a later version that names no
 *    predecessor (`supersedes-missing`);
 * 3. what the constraints decide is unchanged: a second first version is
 *    `version-taken`, a stored id offered again is `duplicate-id`, and storing
 *    a stored document again is refused by a constraint rather than reported
 *    as a ladder fault;
 * 4. the rule is judged at insert only: a successor whose predecessor row was
 *    purged afterwards stays readable, stays the latest, is still found by the
 *    purged id, and can itself be superseded;
 * 5. the latest-rung read the rule adds is one index seek.
 *
 * The store is the real one: `openStore` against a file in an `mkdtemp`
 * sandbox — never `:memory:` — so the DDL, the `UNIQUE` ladders and the
 * transaction model are exercised, and a second handle can open the same
 * database. Sessions and captures are written through the real
 * `createSessionsRepo`, documents are built by the constructors the service
 * uses and validated on the way in, and raw SQL is used only to count rows, to
 * purge one row on purpose and to explain a statement's plan. No environment
 * variable is read and no socket is opened, which is the contract of the
 * `local-service` Vitest project; each test owns its sandbox, store and clock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PanelSpec } from '@debuggen/panel-schema';
import {
  ANALYSIS_VERSION_START,
  createAnalysisResult,
  parseAnalysisResult,
  parseSessionRecord,
} from '@debuggen/protocol';
import type { AnalysisResult, SessionRecord } from '@debuggen/protocol';
import {
  isErr,
  map,
  newAnalysisId,
  newCaptureId,
  newPanelId,
  newSessionId,
  unwrap,
} from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  Result,
  SessionId,
} from '@debuggen/shared';

import { openStore } from './db.js';
import type { Store } from './db.js';
import {
  PANELS_REPO_FAILURE_REASONS,
  createPanelsRepo,
  isPanelsRepoFailureReason,
} from './panels-repo.js';
import type { PanelsRepo, PanelsRepoFailureReason } from './panels-repo.js';
import { createSessionsRepo } from './sessions-repo.js';
import type { SessionsRepo } from './sessions-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The epoch-millisecond reading every test's clock returns. */
const CLOCK_START = 1_767_225_600_000;

/**
 * The reasons the ladder rules report, in the order the checks run — the order
 * {@link PANELS_REPO_FAILURE_REASONS} documents. Typed as reasons, so a name the
 * repository does not export fails to compile before it fails to match.
 */
const LADDER_REASONS: readonly PanelsRepoFailureReason[] = [
  'supersedes-unknown',
  'supersedes-other-session',
  'supersedes-not-earlier',
  'supersedes-stale',
  'supersedes-not-adjacent',
  'supersedes-missing',
];

/**
 * Every key a refusal's `details` may carry: bindings, ids, versions and the
 * enumerated reason. Anything else would be document content reaching an error,
 * which the repository's privacy note forbids.
 */
const ALLOWED_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'subsystem',
  'repo',
  'operation',
  'panelId',
  'analysisId',
  'sessionId',
  'captureId',
  'panelVersion',
  'analysisVersion',
  'supersedes',
  'latestId',
  'latestVersion',
  'supersededVersion',
  'reason',
]);

/** Both tables' row counts, across every session, in one read. */
const COUNT_DOCUMENTS_SQL =
  'SELECT (SELECT COUNT(*) FROM panels) AS panels, (SELECT COUNT(*) FROM analyses) AS analyses';

/** Purges one row, as an independent retention of a superseded document would. */
const DELETE_DOCUMENT_SQL = {
  panels: 'DELETE FROM panels WHERE id = ?',
  analyses: 'DELETE FROM analyses WHERE id = ?',
} as const;

/** The sandbox directory holding the database — and nothing else — for one test. */
let directory: string;

/** The database file inside {@link directory}, for a second handle. */
let databasePath: string;

/** The store under the repositories. */
let store: Store;

/** Every call the panel repository made on the capturing logger. */
let logs: CapturedLog[];

/** The session repository that writes the sessions and captures documents need. */
let sessions: SessionsRepo;

/** The repository under test. */
let panels: PanelsRepo;

/** The session most tests work in. */
let sessionA: SessionId;

/** A second session, for the cross-session rule. */
let sessionB: SessionId;

/** The capture of {@link sessionA} its documents are drawn from. */
let captureA: CaptureId;

/** The capture of {@link sessionB} its documents are drawn from. */
let captureB: CaptureId;

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A {@link Logger} that records every call as `{ level, message, fields }`,
 * bindings merged under each call's own fields.
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

/** A new session's record, built through the protocol's own validator. */
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

/** Opens and closes one capture window of a session, returning its id. */
function recordCapture(sessionId: SessionId): CaptureId {
  const captureId = newCaptureId();

  unwrap(sessions.startCapture({ sessionId, planVersion: 1, captureId, startedAt: CLOCK_START }));
  unwrap(sessions.stopCapture({ captureId, stoppedAt: CLOCK_START + 1 }));

  return captureId;
}

/** The capture a session's documents are drawn from. */
function captureOf(sessionId: SessionId): CaptureId {
  if (sessionId === sessionA) {
    return captureA;
  }

  if (sessionId === sessionB) {
    return captureB;
  }

  throw new Error('The suite holds no capture for that session.');
}

/** What a test decides about the document it offers for storage. */
interface RungInput {
  readonly sessionId: SessionId;
  readonly version: number;
  readonly supersedes?: string | undefined;

  /** A fixed id, to offer a stored document again; a fresh one otherwise. */
  readonly id?: string | undefined;
}

/** A stored document's position on its ladder, the same shape for both. */
interface Rung {
  readonly id: string;
  readonly sessionId: string;
  readonly version: number;
  readonly supersedes: string | undefined;
}

/**
 * A minimal valid panel: one event-log node over the `events` source, which
 * `parsePanelSpec` accepts at any version.
 */
function makePanel(input: RungInput): PanelSpec {
  return {
    version: 1,
    id: input.id ?? newPanelId(),
    sessionId: input.sessionId,
    panelVersion: input.version,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    title: 'Panel alpha',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/**
 * A minimal valid analysis, assembled by the protocol's constructor and
 * validated by its parser, drawn from its session's capture.
 */
function makeAnalysis(input: RungInput): AnalysisResult {
  return unwrap(
    parseAnalysisResult(
      createAnalysisResult(
        { observed: [], likelyCauses: [] },
        {
          id: input.id ?? newAnalysisId(),
          sessionId: input.sessionId,
          captureId: captureOf(input.sessionId),
          analysisVersion: input.version,
          supersedes: input.supersedes,
          createdAt: CLOCK_START,
          metrics: [],
        },
      ),
    ),
  );
}

/** A panel's rung. */
function panelRung(spec: PanelSpec): Rung {
  return {
    id: spec.id,
    sessionId: spec.sessionId,
    version: spec.panelVersion,
    supersedes: spec.supersedes,
  };
}

/** An analysis's rung. */
function analysisRung(result: AnalysisResult): Rung {
  return {
    id: result.id,
    sessionId: result.sessionId,
    version: result.analysisVersion,
    supersedes: result.supersedes,
  };
}

/**
 * One ladder, driven through one repository with documents reduced to their
 * rungs, so every rule is asserted once and run against both tables.
 */
interface LadderDriver {
  /** The table the ladder lives in. */
  readonly table: 'panels' | 'analyses';

  /** The version a session's first document carries. */
  readonly firstVersion: number;

  /** An id of this ladder's shape that no row holds. */
  mintId(): string;

  /** Builds and stores one document. */
  store(input: RungInput): Result<Rung, DebuggenError>;

  /** Reads one document by its id. */
  get(id: string): Result<Rung | undefined, DebuggenError>;

  /** Reads a session's newest document. */
  latest(sessionId: SessionId): Result<Rung | undefined, DebuggenError>;

  /** Lists a session's documents, oldest version first. */
  history(sessionId: SessionId): Result<Rung[], DebuggenError>;

  /** The version the session's next document must carry. */
  nextVersion(sessionId: SessionId): Result<number, DebuggenError>;
}

/** The panel ladder of a repository. */
function panelDriver(repo: PanelsRepo): LadderDriver {
  return {
    table: 'panels',
    // `panelSpecSchema`'s lower bound on `panelVersion`.
    firstVersion: 1,
    mintId: newPanelId,
    store: (input) =>
      map(repo.insertPanel(makePanel(input), { captureId: captureOf(input.sessionId) }), panelRung),
    get: (id) =>
      map(repo.getPanel(id), (spec) => (spec === undefined ? undefined : panelRung(spec))),
    latest: (sessionId) =>
      map(repo.getLatestPanel(sessionId), (spec) =>
        spec === undefined ? undefined : panelRung(spec),
      ),
    history: (sessionId) => map(repo.listPanels(sessionId), (specs) => specs.map(panelRung)),
    nextVersion: (sessionId) => repo.nextPanelVersion(sessionId),
  };
}

/** The analysis ladder of a repository. */
function analysisDriver(repo: PanelsRepo): LadderDriver {
  return {
    table: 'analyses',
    firstVersion: ANALYSIS_VERSION_START,
    mintId: newAnalysisId,
    store: (input) => map(repo.insertAnalysis(makeAnalysis(input)), analysisRung),
    get: (id) =>
      map(repo.getAnalysis(id), (result) =>
        result === undefined ? undefined : analysisRung(result),
      ),
    latest: (sessionId) =>
      map(repo.getLatestAnalysis(sessionId), (result) =>
        result === undefined ? undefined : analysisRung(result),
      ),
    history: (sessionId) =>
      map(repo.listAnalyses(sessionId), (results) => results.map(analysisRung)),
    nextVersion: (sessionId) => repo.nextAnalysisVersion(sessionId),
  };
}

/** Both ladders, by the noun the suite names them with. */
const LADDERS = [
  { noun: 'panel', build: panelDriver },
  { noun: 'analysis', build: analysisDriver },
] as const;

/** Stores a session's first document. */
function storeFirst(driver: LadderDriver, sessionId: SessionId): Rung {
  return unwrap(driver.store({ sessionId, version: driver.firstVersion }));
}

/** Stores the document directly above `previous`, superseding it. */
function storeAfter(driver: LadderDriver, previous: Rung): Rung {
  return unwrap(
    driver.store({
      sessionId: previous.sessionId,
      version: previous.version + 1,
      supersedes: previous.id,
    }),
  );
}

/** Both tables' row counts, across every session. */
function documentRows(): { readonly panels: number; readonly analyses: number } {
  const row = store.db.prepare(COUNT_DOCUMENTS_SQL).get();

  return { panels: Number(row?.['panels']), analyses: Number(row?.['analyses']) };
}

/** The refusal a call answered with; fails the test when it succeeded. */
function refusalOf(result: Result<unknown, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('The call succeeded where the test expected a refusal.');
  }

  return result.error;
}

/**
 * Runs one insert and asserts it was refused as `STORE_ERROR` with `reason`,
 * that neither table gained or lost a row, that the refusal was logged at
 * `warn` with the same reason, and that its details carry nothing beyond ids,
 * versions and the reason.
 *
 * @param attempt The insert.
 * @param reason The `details.reason` expected.
 * @returns The refusal, for assertions of its own.
 */
function expectRefused(
  attempt: () => Result<unknown, DebuggenError>,
  reason: PanelsRepoFailureReason,
): DebuggenError {
  const before = documentRows();
  const logged = logs.length;
  const error = refusalOf(attempt());

  expect(error.code).toBe('STORE_ERROR');
  expect(error.details?.['reason']).toBe(reason);
  expect(documentRows()).toStrictEqual(before);
  expect(
    logs
      .slice(logged)
      .filter((record) => record.level === 'warn')
      .map((record) => record.fields['reason']),
  ).toStrictEqual([reason]);

  for (const key of Object.keys(error.details ?? {})) {
    expect(ALLOWED_DETAIL_KEYS.has(key)).toBe(true);
  }

  return error;
}

/**
 * {@link expectRefused} for a ladder rule, whose hint must also tell the
 * caller that nothing was written.
 */
function expectLadderRefusal(
  attempt: () => Result<unknown, DebuggenError>,
  reason: PanelsRepoFailureReason,
): DebuggenError {
  const error = expectRefused(attempt, reason);

  expect(error.hint).toMatch(/Nothing was written\.$/);

  return error;
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

/** The `EXPLAIN QUERY PLAN` lines of a statement, joined. */
function queryPlan(sql: string): string {
  return store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row['detail']))
    .join(' | ');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-panels-'));
  databasePath = join(directory, 'sessions.sqlite');
  logs = [];

  const now = (): number => CLOCK_START;

  store = unwrap(openStore({ databasePath }));
  sessions = createSessionsRepo({ store, now });
  panels = createPanelsRepo({ store, logger: createCapturingLogger(logs), now });
  sessionA = newSessionId();
  sessionB = newSessionId();

  unwrap(sessions.insert(makeSession(sessionA)));
  unwrap(sessions.insert(makeSession(sessionB)));

  captureA = recordCapture(sessionA);
  captureB = recordCapture(sessionB);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * The contract
 * ---------------------------------------------------------------------------------------------- */

describe('the ladder failure reasons', () => {
  it('sit between the capture checks and the constraint reasons, in check order', () => {
    const start = PANELS_REPO_FAILURE_REASONS.indexOf('capture-session-mismatch');
    const end = PANELS_REPO_FAILURE_REASONS.indexOf('duplicate-id');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(PANELS_REPO_FAILURE_REASONS.slice(start + 1, end)).toStrictEqual(LADDER_REASONS);
  });

  it('are each recognised as a reason the repository reports', () => {
    for (const reason of LADDER_REASONS) {
      expect(isPanelsRepoFailureReason(reason)).toBe(true);
    }

    expect(isPanelsRepoFailureReason('supersedes-absent')).toBe(false);
    expect(isPanelsRepoFailureReason(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The rules, on both ladders
 * ---------------------------------------------------------------------------------------------- */

for (const ladder of LADDERS) {
  describe(`the ${ladder.noun} ladder`, () => {
    /** The ladder driven through the suite's repository. */
    let driver: LadderDriver;

    beforeEach(() => {
      driver = ladder.build(panels);
    });

    it('accepts an unbroken chain, each version superseding the one directly below it', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);
      const third = storeAfter(driver, second);

      expect(first).toStrictEqual({
        id: first.id,
        sessionId: sessionA,
        version: driver.firstVersion,
        supersedes: undefined,
      });
      expect(second.supersedes).toBe(first.id);
      expect(third.supersedes).toBe(second.id);
      expect(unwrap(driver.latest(sessionA))).toStrictEqual(third);
      expect(unwrap(driver.history(sessionA))).toStrictEqual([first, second, third]);
      expect(unwrap(driver.nextVersion(sessionA))).toBe(driver.firstVersion + 3);
      expect(documentRows()[driver.table]).toBe(3);
    });

    it('refuses a predecessor id that no stored row holds as supersedes-unknown', () => {
      const first = storeFirst(driver, sessionA);
      const unknown = driver.mintId();
      const refusal = expectLadderRefusal(
        () =>
          driver.store({ sessionId: sessionA, version: first.version + 1, supersedes: unknown }),
        'supersedes-unknown',
      );

      expect(refusal.details?.['supersedes']).toBe(unknown);
      expect(unwrap(driver.latest(sessionA))).toStrictEqual(first);
    });

    it('refuses an unknown predecessor on an empty session as supersedes-unknown', () => {
      expectLadderRefusal(
        () =>
          driver.store({
            sessionId: sessionA,
            version: driver.firstVersion + 1,
            supersedes: driver.mintId(),
          }),
        'supersedes-unknown',
      );

      expect(unwrap(driver.history(sessionA))).toStrictEqual([]);
    });

    it('refuses a predecessor of another session as supersedes-other-session', () => {
      const own = storeFirst(driver, sessionA);
      const foreign = storeFirst(driver, sessionB);

      expectLadderRefusal(
        () =>
          driver.store({ sessionId: sessionA, version: own.version + 1, supersedes: foreign.id }),
        'supersedes-other-session',
      );

      expect(unwrap(driver.latest(sessionA))).toStrictEqual(own);
      expect(unwrap(driver.latest(sessionB))).toStrictEqual(foreign);
    });

    it('refuses a predecessor that is not an earlier version as supersedes-not-earlier', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);

      expectLadderRefusal(
        () => driver.store({ sessionId: sessionA, version: second.version, supersedes: second.id }),
        'supersedes-not-earlier',
      );

      expect(unwrap(driver.latest(sessionA))).toStrictEqual(second);
    });

    it('refuses a predecessor that is no longer the latest as supersedes-stale', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);
      const refusal = expectLadderRefusal(
        () =>
          driver.store({ sessionId: sessionA, version: second.version + 1, supersedes: first.id }),
        'supersedes-stale',
      );

      expect(refusal.details).toMatchObject({
        supersedes: first.id,
        latestId: second.id,
        latestVersion: second.version,
      });
      expect(refusal.hint).toMatch(/no longer the latest/);
      expect(refusal.hint).toMatch(/Re-read the latest/);
      expect(unwrap(driver.latest(sessionA))).toStrictEqual(second);
    });

    it('refuses the second of two follow-ups decided against the same rung as supersedes-stale', () => {
      const first = storeFirst(driver, sessionA);

      // Both follow-ups read the ladder before either stores its answer.
      const decidedAgainst = unwrap(driver.latest(sessionA));
      const version = unwrap(driver.nextVersion(sessionA));

      expect(decidedAgainst).toStrictEqual(first);

      const winner = unwrap(
        driver.store({ sessionId: sessionA, version, supersedes: decidedAgainst?.id }),
      );

      expectLadderRefusal(
        () => driver.store({ sessionId: sessionA, version, supersedes: decidedAgainst?.id }),
        'supersedes-stale',
      );

      expect(unwrap(driver.history(sessionA))).toStrictEqual([first, winner]);
    });

    it('refuses the follow-up that lost the race on another connection as supersedes-stale', () => {
      const second = unwrap(openStore({ databasePath }));

      try {
        const other = ladder.build(createPanelsRepo({ store: second, now: () => CLOCK_START }));
        const first = storeFirst(driver, sessionA);
        const version = unwrap(driver.nextVersion(sessionA));

        expect(unwrap(other.latest(sessionA))).toStrictEqual(first);
        expect(unwrap(other.nextVersion(sessionA))).toBe(version);

        const winner = unwrap(other.store({ sessionId: sessionA, version, supersedes: first.id }));

        expectLadderRefusal(
          () => driver.store({ sessionId: sessionA, version, supersedes: first.id }),
          'supersedes-stale',
        );

        expect(unwrap(driver.latest(sessionA))).toStrictEqual(winner);
      } finally {
        second.close();
      }
    });

    it('refuses a version that skips a rung as supersedes-not-adjacent', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);
      const refusal = expectLadderRefusal(
        () =>
          driver.store({ sessionId: sessionA, version: second.version + 2, supersedes: second.id }),
        'supersedes-not-adjacent',
      );

      expect(refusal.details).toMatchObject({
        supersedes: second.id,
        supersededVersion: second.version,
      });
      expect(unwrap(driver.nextVersion(sessionA))).toBe(second.version + 1);
    });

    it('refuses a version above the first that names no predecessor as supersedes-missing', () => {
      expectLadderRefusal(
        () => driver.store({ sessionId: sessionA, version: driver.firstVersion + 1 }),
        'supersedes-missing',
      );

      const first = storeFirst(driver, sessionA);

      expectLadderRefusal(
        () => driver.store({ sessionId: sessionA, version: first.version + 1 }),
        'supersedes-missing',
      );

      expect(unwrap(driver.history(sessionA))).toStrictEqual([first]);
    });

    it('leaves a second first version to the UNIQUE ladder as version-taken', () => {
      const first = storeFirst(driver, sessionA);

      expectRefused(
        () => driver.store({ sessionId: sessionA, version: driver.firstVersion }),
        'version-taken',
      );

      expect(unwrap(driver.history(sessionA))).toStrictEqual([first]);
    });

    it('leaves storing a stored document again to the constraints, never to a ladder rule', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);
      const before = documentRows();
      const repeats = [
        { id: second.id, sessionId: sessionA, version: second.version, supersedes: first.id },
        { id: first.id, sessionId: sessionA, version: first.version },
      ];

      for (const repeat of repeats) {
        const refusal = refusalOf(driver.store(repeat));

        // Both the primary key and the version ladder refuse an identical
        // document; which one SQLite reports first is its own business.
        expect(refusal.code).toBe('STORE_ERROR');
        expect(['duplicate-id', 'version-taken']).toContain(refusal.details?.['reason']);
      }

      expect(documentRows()).toStrictEqual(before);
      expect(unwrap(driver.history(sessionA))).toStrictEqual([first, second]);
    });

    it('reports a stored id offered as the first version of another session as duplicate-id', () => {
      const first = storeFirst(driver, sessionA);

      expectRefused(
        () => driver.store({ id: first.id, sessionId: sessionB, version: driver.firstVersion }),
        'duplicate-id',
      );

      expect(unwrap(driver.history(sessionB))).toStrictEqual([]);
    });

    it('keeps a successor readable, and extendable, after its predecessor row is purged', () => {
      const first = storeFirst(driver, sessionA);
      const second = storeAfter(driver, first);

      store.db.prepare(DELETE_DOCUMENT_SQL[driver.table]).run(first.id);

      expect(unwrap(driver.get(first.id))).toBeUndefined();
      expect(unwrap(driver.get(second.id))).toStrictEqual(second);
      expect(unwrap(driver.latest(sessionA))).toStrictEqual(second);
      expect(unwrap(driver.history(sessionA))).toStrictEqual([second]);

      // The dangling pointer is history: the surviving rung is still the one a
      // follow-up supersedes, while naming the purged id is refused at insert.
      expectLadderRefusal(
        () =>
          driver.store({ sessionId: sessionA, version: second.version + 1, supersedes: first.id }),
        'supersedes-unknown',
      );

      const third = storeAfter(driver, second);

      expect(unwrap(driver.history(sessionA))).toStrictEqual([second, third]);
    });

    it('reads the latest rung with one index seek on the version ladder', () => {
      const texts: string[] = [];
      const recorded = ladder.build(
        createPanelsRepo({ store: recordingStore(store, texts), now: () => CLOCK_START }),
      );
      const first = storeFirst(recorded, sessionA);

      storeAfter(recorded, first);

      const latestRungReads = texts.filter((sql) =>
        new RegExp(`^SELECT id, [^*]*FROM ${driver.table}\\s+WHERE session_id = \\?`).test(sql),
      );

      expect(latestRungReads).toHaveLength(1);

      const plan = queryPlan(latestRungReads[0] ?? '');

      expect(plan).toMatch(
        new RegExp(`^SEARCH ${driver.table} USING INDEX \\S+ \\(session_id=\\?\\)$`),
      );
      expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    });
  });
}

/* -------------------------------------------------------------------------------------------------
 * Across the two ladders
 * ---------------------------------------------------------------------------------------------- */

describe('the two ladders', () => {
  it('refuse a predecessor that lives on the other ladder as supersedes-unknown', () => {
    const panelLadder = panelDriver(panels);
    const analysisLadder = analysisDriver(panels);
    const panel = storeFirst(panelLadder, sessionA);
    const analysis = storeFirst(analysisLadder, sessionA);

    expectLadderRefusal(
      () => panelLadder.store({ sessionId: sessionA, version: 2, supersedes: analysis.id }),
      'supersedes-unknown',
    );
    expectLadderRefusal(
      () => analysisLadder.store({ sessionId: sessionA, version: 2, supersedes: panel.id }),
      'supersedes-unknown',
    );

    expect(documentRows()).toStrictEqual({ panels: 1, analyses: 1 });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Panel lineage reads
 * ---------------------------------------------------------------------------------------------- */

describe('listSupersededBy', () => {
  it('walks an accepted chain one successor at a time', () => {
    const ladder = panelDriver(panels);
    const first = storeFirst(ladder, sessionA);
    const second = storeAfter(ladder, first);
    const third = storeAfter(ladder, second);

    expect(unwrap(panels.listSupersededBy(first.id)).map(panelRung)).toStrictEqual([second]);
    expect(unwrap(panels.listSupersededBy(second.id)).map(panelRung)).toStrictEqual([third]);
    expect(unwrap(panels.listSupersededBy(third.id))).toStrictEqual([]);
  });

  it('still returns the successors of a panel purged after they were stored', () => {
    const ladder = panelDriver(panels);
    const first = storeFirst(ladder, sessionA);
    const second = storeAfter(ladder, first);

    store.db.prepare(DELETE_DOCUMENT_SQL.panels).run(first.id);

    expect(unwrap(panels.listSupersededBy(first.id)).map(panelRung)).toStrictEqual([second]);
  });
});
