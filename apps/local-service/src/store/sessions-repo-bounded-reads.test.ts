/**
 * Tests for the bounded reads of `./sessions-repo.ts`: the scoped session-list
 * page behind `GET /sessions` ({@link SessionsRepo.listWithinFolders}) and the
 * progress tail a reopen replays ({@link SessionsRepo.listProgressTail}).
 *
 * Both exist so that a read stays proportional to what one screen needs rather
 * than to everything a developer ever stored, so the suite checks the answer
 * **and** the work behind it:
 *
 * - the session list is scoped in SQL exactly as `requireProjectScope` scopes
 *   an editor — a folder covers itself and what lies beneath `folder/`, never a
 *   sibling that merely shares a prefix — pages in a stable order with a real
 *   `total`, reads the cleanup summary from `session_cleanup_summaries` without
 *   the document ever being read (by SQLite or in JavaScript), and prepares
 *   exactly one `COUNT(*)` and one page select, each served by
 *   `idx_sessions_project_root`, neither naming `record`;
 * - a stored row that cannot be read is left out, counted and still consumed;
 * - the cleanup summary tracks every write path inside the write's own
 *   transaction, cascades with its session, admits exactly protocol's
 *   `CLEANUP_STATUSES`, and is created and backfilled by schema version 4 —
 *   for a version-3 store and for an adopted, unstamped one alike;
 * - the progress tail is the last N rows in append order plus the stored
 *   total, read with `ORDER BY id DESC LIMIT ?` on
 *   `idx_session_progress_session_id_id`.
 *
 * The store is the real one — `openStore` against a file in an `mkdtemp`
 * sandbox — so the real DDL, indexes and pragmas are exercised, and records are
 * built through protocol's `parseSessionRecord`, so no shape is hand-rolled.
 * Every fixture path is neutral (`/w/…`), no environment variable is read, no
 * socket is opened and nothing under `$DEBUGGEN_HOME` is touched.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLEANUP_STATUSES, parseSessionRecord, sessionListItemSchema } from '@debuggen/protocol';
import type { SessionCleanup, SessionRecord, SessionStatus } from '@debuggen/protocol';
import { isErr, newModificationId, newSessionId, unwrap } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';

import { loadSchemaSql, openStore } from './db.js';
import type { Store } from './db.js';
import { STORE_SCHEMA_VERSION, applyMigrations } from './migrations.js';
import { MAX_SESSION_LIST_LIMIT, createSessionsRepo } from './sessions-repo.js';
import type { SessionSummaryPage, SessionsRepo } from './sessions-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** A fixed epoch-millisecond base every stamp below is offset from. */
const BASE_TIME = 1_760_000_000_000;

/** A synthetic 64-character lowercase hex digest. */
const DIGEST = 'ab'.repeat(32);

/** What {@link makeSession} may override. */
interface SessionOverrides {
  readonly id?: SessionId;
  readonly projectRoot?: string;
  readonly status?: SessionStatus;
  readonly updatedAt?: number;
  readonly cleanup?: SessionCleanup;
}

/**
 * A valid session record, built through protocol's own parser.
 *
 * @param overrides The members a test cares about.
 * @returns The record.
 */
function makeSession(overrides: SessionOverrides = {}): SessionRecord {
  const updatedAt = overrides.updatedAt ?? BASE_TIME;
  const projectRoot = overrides.projectRoot ?? '/w/a';

  return unwrap(
    parseSessionRecord({
      id: overrides.id ?? newSessionId(),
      projectRoot,
      projectName: projectRoot.split('/').at(-1) ?? 'project',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: BASE_TIME,
      updatedAt,
      status: overrides.status ?? 'ready',
      question: 'Why is handlerAlpha slow?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: overrides.cleanup ?? { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/**
 * A cleanup outcome that preserved `count` conflicting files.
 *
 * @param sessionId The session the conflicts belong to.
 * @param count How many conflicts to record.
 * @param completedAt When the pass completed.
 * @returns The cleanup member.
 */
function conflictedCleanup(
  sessionId: SessionId,
  count: number,
  completedAt: number,
): SessionCleanup {
  return {
    status: 'conflict',
    completedAt,
    conflicts: Array.from({ length: count }, (_, index) => ({
      recordId: newModificationId(),
      sessionId,
      file: `src/module${String(index)}.ts`,
      reason: 'content-changed' as const,
      expectedHash: DIGEST,
      actualHash: 'cd'.repeat(32),
      backupPath: `/w/backups/${sessionId}/${DIGEST}`,
      detectedAt: completedAt,
      message: 'The file was edited while instrumented and was not overwritten.',
    })),
  };
}

let directory: string;
let store: Store;
let sessions: SessionsRepo;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-sessions-repo-'));
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  sessions = createSessionsRepo({ store, now: () => BASE_TIME });
});

afterEach(() => {
  vi.restoreAllMocks();

  if (!store.isClosed) {
    store.close();
  }

  rmSync(directory, { recursive: true, force: true });
  expect(existsSync(directory)).toBe(false);
});

/**
 * Stores a session and returns its id.
 *
 * @param overrides The members a test cares about.
 * @returns The stored session's id.
 */
function seed(overrides: SessionOverrides = {}): SessionId {
  return unwrap(sessions.insert(makeSession(overrides))).id;
}

/**
 * Reads one scoped page, failing the test on a refusal.
 *
 * @param folders The scope.
 * @param limit The page size.
 * @param offset The page offset.
 * @returns The page.
 */
function page(folders: readonly string[], limit: number, offset = 0): SessionSummaryPage {
  return unwrap(sessions.listWithinFolders({ folders, limit, offset }));
}

/** The ids of a page's rows, in order. */
function idsOf(listed: SessionSummaryPage): string[] {
  return listed.items.map((item) => item.id);
}

/* -------------------------------------------------------------------------------------------------
 * listWithinFolders — scope
 * ---------------------------------------------------------------------------------------------- */

describe('listWithinFolders scopes the list in SQL exactly as requireProjectScope does', () => {
  let own: SessionId;
  let nested: SessionId;
  let sharedPrefix: SessionId;
  let dashed: SessionId;
  let parent: SessionId;
  let elsewhere: SessionId;

  beforeEach(() => {
    own = seed({ projectRoot: '/w/a', updatedAt: BASE_TIME + 6 });
    nested = seed({ projectRoot: '/w/a/b', updatedAt: BASE_TIME + 5 });
    sharedPrefix = seed({ projectRoot: '/w/ab', updatedAt: BASE_TIME + 4 });
    dashed = seed({ projectRoot: '/w/a-b', updatedAt: BASE_TIME + 3 });
    parent = seed({ projectRoot: '/w', updatedAt: BASE_TIME + 2 });
    elsewhere = seed({ projectRoot: '/x/a', updatedAt: BASE_TIME + 1 });
  });

  it('covers the folder itself and what lies beneath it, never a sibling sharing its prefix', () => {
    const listed = page(['/w/a'], 50);

    expect(idsOf(listed)).toEqual([own, nested]);
    expect(listed.total).toBe(2);
    expect(listed.consumed).toBe(2);
    expect(listed.unreadable).toBe(0);
  });

  it('covers only the nested root for a nested folder', () => {
    expect(idsOf(page(['/w/a/b'], 50))).toEqual([nested]);
  });

  it('unions several folders and folds a nested or repeated one away', () => {
    expect(idsOf(page(['/w/a', '/w/ab'], 50))).toEqual([own, nested, sharedPrefix]);
    expect(idsOf(page(['/w/a/b', '/w/a', '/w/a'], 50))).toEqual([own, nested]);
    expect(page(['/w/a/b', '/w/a', '/w/a'], 50).total).toBe(2);
  });

  it('normalises a folder before binding it, as isWithin does', () => {
    expect(idsOf(page(['/w/a/'], 50))).toEqual([own, nested]);
    expect(idsOf(page(['/w/./a/b/..'], 50))).toEqual([own, nested]);
  });

  it('treats the filesystem root as covering every absolute root', () => {
    const listed = page(['/'], 50);

    expect(idsOf(listed)).toEqual([own, nested, sharedPrefix, dashed, parent, elsewhere]);
    expect(listed.total).toBe(6);
  });

  it('selects nothing for an empty folder list', () => {
    expect(page([], 50)).toEqual({ items: [], total: 0, consumed: 0, unreadable: 0 });
  });

  it('prepares one COUNT(*) and one page select, both served by idx_sessions_project_root', () => {
    const prepared: string[] = [];
    const statement = store.statement.bind(store);
    vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
      prepared.push(sql);
      return statement(sql);
    });

    page(['/w/a'], 50);

    expect(prepared).toHaveLength(2);
    const [count, select] = prepared;
    expect(count).toMatch(/^SELECT COUNT\(\*\) AS total FROM sessions WHERE /);
    expect(select).toMatch(/ORDER BY updated_at DESC, id DESC LIMIT \? OFFSET \?$/);

    const scope = ['/w/a', '/w/a/', '/w/a0'];
    const plans = [
      store.db.prepare(`EXPLAIN QUERY PLAN ${count ?? ''}`).all(...scope),
      store.db.prepare(`EXPLAIN QUERY PLAN ${select ?? ''}`).all(...scope, 50, 0),
    ];

    for (const plan of plans) {
      const details = plan.map((row) => String(row['detail']));
      expect(details.some((detail) => detail.includes('idx_sessions_project_root'))).toBe(true);
      expect(details.some((detail) => detail.startsWith('SCAN sessions'))).toBe(false);
    }

    // The page's cleanup facts come from one primary-key lookup per row, never
    // from a scan of the summary table.
    const selectDetails = (plans[1] ?? []).map((row) => String(row['detail']));
    expect(
      selectDetails.some((detail) =>
        /^SEARCH summary USING PRIMARY KEY \(session_id=\?\)/.test(detail),
      ),
    ).toBe(true);
    expect(selectDetails.some((detail) => detail.startsWith('SCAN summary'))).toBe(false);
  });

  it('names no record column in either statement it prepares', () => {
    const prepared: string[] = [];
    const statement = store.statement.bind(store);
    vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
      prepared.push(sql);
      return statement(sql);
    });

    page(['/w/a'], 50);

    expect(prepared).toHaveLength(2);
    for (const sql of prepared) {
      expect(sql).not.toMatch(/\brecord\b/i);
    }
  });

  it('lists a row with its true cleanup summary although its document is not JSON', () => {
    // Proof that the document is never read: were it read — by SQLite's JSON
    // functions or in JavaScript — this row would be unreadable.
    const conflicted = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: conflicted,
          status: 'ended',
          updatedAt: BASE_TIME + 9,
          cleanup: conflictedCleanup(conflicted, 4, BASE_TIME + 9),
        }),
      ),
    );
    store.db.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('not json', conflicted);

    const listed = page(['/w/a'], 50);

    expect(listed.items[0]).toEqual({
      id: conflicted,
      projectRoot: '/w/a',
      projectName: 'a',
      status: 'ended',
      question: 'Why is handlerAlpha slow?',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 9,
      cleanup: { status: 'conflict', completedAt: BASE_TIME + 9, conflictCount: 4 },
    });
    expect(idsOf(listed)).toEqual([conflicted, own, nested]);
    expect(listed).toMatchObject({ total: 3, consumed: 3, unreadable: 0 });
  });

  it('never parses a stored document in JavaScript', () => {
    const parse = vi.spyOn(JSON, 'parse');

    page(['/w/a'], 50);

    expect(parse).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------------
 * listWithinFolders — paging, ordering, rows
 * ---------------------------------------------------------------------------------------------- */

describe('listWithinFolders pages in a stable order with a real total', () => {
  it('walks every in-scope session exactly once across pages, most recently updated first', () => {
    const newest = seed({ updatedAt: BASE_TIME + 9 });
    // Three sessions updated in the same millisecond: the id breaks the tie.
    const tied = [
      seed({ updatedAt: BASE_TIME + 5 }),
      seed({ updatedAt: BASE_TIME + 5 }),
      seed({ updatedAt: BASE_TIME + 5 }),
    ].sort((left, right) => (left < right ? 1 : -1));
    const oldest = seed({ updatedAt: BASE_TIME + 1 });
    seed({ projectRoot: '/x/other', updatedAt: BASE_TIME + 7 });

    const first = page(['/w/a'], 2, 0);
    const second = page(['/w/a'], 2, 2);
    const third = page(['/w/a'], 2, 4);

    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([first.consumed, second.consumed, third.consumed]).toEqual([2, 2, 1]);
    expect([...idsOf(first), ...idsOf(second), ...idsOf(third)]).toEqual([newest, ...tied, oldest]);
  });

  it('answers a count-only request and a window past the end without rows', () => {
    seed();
    seed();

    expect(page(['/w/a'], 0)).toEqual({ items: [], total: 2, consumed: 0, unreadable: 0 });
    expect(page(['/w/a'], 10, 2)).toEqual({ items: [], total: 2, consumed: 0, unreadable: 0 });
    expect(page(['/w/a'], 10, 50)).toEqual({ items: [], total: 2, consumed: 0, unreadable: 0 });
  });

  it('projects each row to exactly the protocol list row, cleanup summarised', () => {
    const conflicted = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: conflicted,
          status: 'ended',
          updatedAt: BASE_TIME + 2,
          cleanup: conflictedCleanup(conflicted, 3, BASE_TIME + 2),
        }),
      ),
    );
    const clean = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: clean,
          status: 'ended',
          updatedAt: BASE_TIME + 1,
          cleanup: { status: 'clean', completedAt: BASE_TIME + 1, conflicts: [] },
        }),
      ),
    );
    const pending = seed({ updatedAt: BASE_TIME });

    const listed = page(['/w/a'], 50);

    expect(listed.items).toEqual([
      {
        id: conflicted,
        projectRoot: '/w/a',
        projectName: 'a',
        status: 'ended',
        question: 'Why is handlerAlpha slow?',
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME + 2,
        cleanup: { status: 'conflict', completedAt: BASE_TIME + 2, conflictCount: 3 },
      },
      {
        id: clean,
        projectRoot: '/w/a',
        projectName: 'a',
        status: 'ended',
        question: 'Why is handlerAlpha slow?',
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME + 1,
        cleanup: { status: 'clean', completedAt: BASE_TIME + 1, conflictCount: 0 },
      },
      {
        id: pending,
        projectRoot: '/w/a',
        projectName: 'a',
        status: 'ready',
        question: 'Why is handlerAlpha slow?',
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        cleanup: { status: 'pending', conflictCount: 0 },
      },
    ]);
    for (const item of listed.items) {
      expect(sessionListItemSchema.safeParse(item).success).toBe(true);
      expect(item).not.toHaveProperty('modifications');
    }
  });

  it('leaves an unreadable row out, counts it, and still consumes it', () => {
    const first = seed({ updatedAt: BASE_TIME + 4 });
    const unsummarised = seed({ updatedAt: BASE_TIME + 3 });
    const unknownStatus = seed({ updatedAt: BASE_TIME + 2 });
    const last = seed({ updatedAt: BASE_TIME + 1 });
    // A session without a summary row — what the version-4 backfill leaves for
    // a document it could not read — and one whose status projection is bogus.
    store.db
      .prepare('DELETE FROM session_cleanup_summaries WHERE session_id = ?')
      .run(unsummarised);
    store.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('bogus', unknownStatus);

    const head = page(['/w/a'], 3, 0);
    const tail = page(['/w/a'], 3, 3);

    expect(idsOf(head)).toEqual([first]);
    expect(head).toMatchObject({ total: 4, consumed: 3, unreadable: 2 });
    expect(idsOf(tail)).toEqual([last]);
    expect(tail).toMatchObject({ total: 4, consumed: 1, unreadable: 0 });
  });

  it('refuses a window or a scope outside its domain', () => {
    const refusals = [
      sessions.listWithinFolders({ folders: ['/w/a'], limit: MAX_SESSION_LIST_LIMIT + 1 }),
      sessions.listWithinFolders({ folders: ['/w/a'], limit: -1 }),
      sessions.listWithinFolders({ folders: ['/w/a'], limit: 1.5 }),
      sessions.listWithinFolders({ folders: ['/w/a'], offset: -1 }),
      sessions.listWithinFolders({ folders: [''] }),
      sessions.listWithinFolders({ folders: ['/w/\u0000a'] }),
      sessions.listWithinFolders({
        folders: Array.from({ length: 257 }, (_, index) => `/w/folder${String(index)}`),
      }),
    ];

    for (const refusal of refusals) {
      expect(isErr(refusal)).toBe(true);
      if (isErr(refusal)) {
        expect(refusal.error.code).toBe('STORE_ERROR');
        expect(refusal.error.details?.['reason']).toBe('invalid-argument');
      }
    }
  });

  it('binds a wide scope in a bounded number of statement shapes', () => {
    const inside = seed({ projectRoot: '/w/folder200' });
    const folders = Array.from({ length: 256 }, (_, index) => `/w/folder${String(index)}`);

    const listed = page(folders, 10);

    expect(idsOf(listed)).toEqual([inside]);
    expect(listed.total).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * session_cleanup_summaries — the list's projection of record.cleanup
 * ---------------------------------------------------------------------------------------------- */

/** One summary row as stored, or `undefined` when the session has none. */
interface StoredSummary {
  readonly status: unknown;
  readonly completed_at: unknown;
  readonly conflict_count: unknown;
}

/**
 * Reads a session's summary row straight from the table.
 *
 * @param db The connection to read through.
 * @param sessionId The session.
 * @returns The row's three facts, or `undefined` when there is no row.
 */
function summaryOf(db: DatabaseSync, sessionId: SessionId): StoredSummary | undefined {
  const row = db
    .prepare(
      'SELECT status, completed_at, conflict_count FROM session_cleanup_summaries WHERE session_id = ?',
    )
    .get(sessionId);

  return row === undefined
    ? undefined
    : {
        status: row['status'],
        completed_at: row['completed_at'],
        conflict_count: row['conflict_count'],
      };
}

/** How many summary rows the store holds. */
function summaryCount(db: DatabaseSync): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM session_cleanup_summaries').get()?.['n'];
}

/**
 * Reads a stored session, failing the test when it is absent.
 *
 * @param sessionId The session.
 * @returns Its record.
 */
function stored(sessionId: SessionId): SessionRecord {
  const record = unwrap(sessions.get(sessionId));

  if (record === undefined) {
    throw new Error('The session under test is not stored.');
  }

  return record;
}

describe('the cleanup summary tracks every write of the session document', () => {
  it('is written by insert, update (insert and replace) and setStatus', () => {
    // insert
    const id = seed();
    expect(summaryOf(store.db, id)).toEqual({
      status: 'pending',
      completed_at: null,
      conflict_count: 0,
    });

    // update, replacing: a cleanup status change with a conflicts count change
    unwrap(
      sessions.update({
        ...stored(id),
        status: 'ended',
        cleanup: conflictedCleanup(id, 2, BASE_TIME + 5),
      }),
    );
    expect(summaryOf(store.db, id)).toEqual({
      status: 'conflict',
      completed_at: BASE_TIME + 5,
      conflict_count: 2,
    });

    // update, replacing: the conflicts count alone
    unwrap(sessions.update({ ...stored(id), cleanup: conflictedCleanup(id, 5, BASE_TIME + 6) }));
    expect(summaryOf(store.db, id)).toEqual({
      status: 'conflict',
      completed_at: BASE_TIME + 6,
      conflict_count: 5,
    });

    // update, replacing: a resolved cleanup
    unwrap(
      sessions.update({
        ...stored(id),
        cleanup: { status: 'clean', completedAt: BASE_TIME + 7, conflicts: [] },
      }),
    );
    expect(summaryOf(store.db, id)).toEqual({
      status: 'clean',
      completed_at: BASE_TIME + 7,
      conflict_count: 0,
    });

    // setStatus rewrites the summary with the document: a row removed behind
    // the repository's back is written again.
    store.db.prepare('DELETE FROM session_cleanup_summaries WHERE session_id = ?').run(id);
    unwrap(sessions.setStatus(id, 'failed'));
    expect(summaryOf(store.db, id)).toEqual({
      status: 'clean',
      completed_at: BASE_TIME + 7,
      conflict_count: 0,
    });

    // update, inserting a session the store did not hold
    const created = newSessionId();
    unwrap(
      sessions.update(
        makeSession({
          id: created,
          status: 'ended',
          cleanup: { status: 'partial', completedAt: BASE_TIME + 8, conflicts: [] },
        }),
      ),
    );
    expect(summaryOf(store.db, created)).toEqual({
      status: 'partial',
      completed_at: BASE_TIME + 8,
      conflict_count: 0,
    });

    // Whatever was written, the list row and the document agree.
    for (const sessionId of [id, created]) {
      const record = stored(sessionId);
      const row = page(['/w/a'], 50).items.find((item) => item.id === sessionId);
      expect(row?.cleanup).toEqual({
        status: record.cleanup.status,
        ...(record.cleanup.completedAt === undefined
          ? {}
          : { completedAt: record.cleanup.completedAt }),
        conflictCount: record.cleanup.conflicts.length,
      });
    }
  });

  it('canonicalises cleanup.completedAt to whole milliseconds, in the document and the summary alike', () => {
    const id = newSessionId();
    const written = unwrap(
      sessions.insert(
        makeSession({
          id,
          status: 'ended',
          cleanup: { status: 'clean', completedAt: BASE_TIME + 1.6, conflicts: [] },
        }),
      ),
    );

    expect(written.cleanup.completedAt).toBe(BASE_TIME + 2);
    expect(stored(id).cleanup.completedAt).toBe(BASE_TIME + 2);
    expect(summaryOf(store.db, id)?.completed_at).toBe(BASE_TIME + 2);
  });

  it('commits with the document or not at all', () => {
    const id = newSessionId();
    // With the summary table gone the summary write fails, and it must take
    // the document write with it.
    store.db.exec('DROP TABLE session_cleanup_summaries');

    const refused = sessions.insert(makeSession({ id }));

    expect(isErr(refused)).toBe(true);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(id)?.['n']).toBe(
      0,
    );
  });

  it('is deleted with its session by the cascade', () => {
    const doomed = seed();
    const kept = seed();
    expect(summaryCount(store.db)).toBe(2);

    expect(unwrap(sessions.delete(doomed))).toBe(1);

    expect(summaryOf(store.db, doomed)).toBeUndefined();
    expect(summaryOf(store.db, kept)).toBeDefined();
    expect(summaryCount(store.db)).toBe(1);
  });

  it("admits exactly protocol's CLEANUP_STATUSES, in their order, and no negative count", () => {
    const definition = store.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get('session_cleanup_summaries')?.['sql'];
    const checked = /status\s+TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(
      String(definition),
    )?.[1];

    expect(checked?.split(',').map((member) => member.trim().replace(/^'|'$/g, ''))).toEqual([
      ...CLEANUP_STATUSES,
    ]);

    const id = seed();
    const write = store.db.prepare(
      `INSERT INTO session_cleanup_summaries (session_id, status, completed_at, conflict_count)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT (session_id) DO UPDATE SET status = excluded.status, conflict_count = excluded.conflict_count`,
    );

    for (const status of CLEANUP_STATUSES) {
      expect(() => write.run(id, status, 0)).not.toThrow();
    }
    expect(() => write.run(id, 'bogus', 0)).toThrow(/CHECK constraint failed/);
    expect(() => write.run(id, 'clean', -1)).toThrow(/CHECK constraint failed/);
  });
});

/* -------------------------------------------------------------------------------------------------
 * getAccessTarget — the admission read that never touches the document
 * ---------------------------------------------------------------------------------------------- */

describe('getAccessTarget', () => {
  it('answers the id and project root by primary key, never naming the document', () => {
    const id = seed({ projectRoot: '/w/a/b' });
    const prepared: string[] = [];
    const statement = store.statement.bind(store);
    vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
      prepared.push(sql);
      return statement(sql);
    });
    const parse = vi.spyOn(JSON, 'parse');

    expect(unwrap(sessions.getAccessTarget(id))).toEqual({ id, projectRoot: '/w/a/b' });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]).not.toMatch(/\brecord\b/i);
    expect(parse).not.toHaveBeenCalled();
    const plan = store.db
      .prepare(`EXPLAIN QUERY PLAN ${prepared[0] ?? ''}`)
      .all(id)
      .map((row) => String(row['detail']));
    expect(plan.some((detail) => detail.startsWith('SEARCH sessions USING INDEX'))).toBe(true);
  });

  it('finds a session whose document is not JSON, which get refuses', () => {
    const id = seed();
    store.db.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('not json', id);

    expect(unwrap(sessions.getAccessTarget(id))).toEqual({ id, projectRoot: '/w/a' });
    expect(isErr(sessions.get(id))).toBe(true);
  });

  it('answers undefined for an unknown session and refuses an id that is not one', () => {
    seed();

    expect(unwrap(sessions.getAccessTarget(newSessionId()))).toBeUndefined();

    const refused = sessions.getAccessTarget('');
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('STORE_ERROR');
      expect(refused.error.details?.['reason']).toBe('invalid-argument');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Schema version 4 — creating and backfilling the summary on an existing store
 * ---------------------------------------------------------------------------------------------- */

/** One captured log record. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that records every call.
 *
 * @param sink Where records go.
 * @param bindings Fields every record carries.
 * @returns The logger.
 */
function capturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
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
      capturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/** Every `sessions` row, for a before-and-after comparison. */
function sessionRows(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT * FROM sessions ORDER BY id').all();
}

describe('schema version 4 creates and backfills the cleanup summary', () => {
  let logs: CapturedLog[];

  beforeEach(() => {
    logs = [];
  });

  /**
   * Closes the store, lets `rewind` turn the file back into what an older build
   * left behind on a raw connection, and reopens it through `openStore`, whose
   * migration ladder then runs.
   *
   * @param rewind The legacy edit.
   */
  function reopenAfter(rewind: (legacy: DatabaseSync) => void): void {
    const databasePath = store.path;
    store.close();

    const legacy = new DatabaseSync(databasePath);
    try {
      rewind(legacy);
    } finally {
      legacy.close();
    }

    store = unwrap(openStore({ databasePath, logger: capturingLogger(logs) }));
    sessions = createSessionsRepo({ store, now: () => BASE_TIME });
  }

  it('backfills a version-3 store from its documents, and summarises only what they say', () => {
    const conflicted = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: conflicted,
          status: 'ended',
          updatedAt: BASE_TIME + 6,
          cleanup: conflictedCleanup(conflicted, 3, BASE_TIME + 6),
        }),
      ),
    );
    const clean = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: clean,
          status: 'ended',
          updatedAt: BASE_TIME + 5,
          cleanup: { status: 'clean', completedAt: BASE_TIME + 5, conflicts: [] },
        }),
      ),
    );
    const pending = seed({ updatedAt: BASE_TIME + 4 });
    const fractional = seed({ updatedAt: BASE_TIME + 3 });
    const notJson = seed({ updatedAt: BASE_TIME + 2 });
    const unknownCleanup = seed({ updatedAt: BASE_TIME + 1 });
    let before: unknown[] = [];

    reopenAfter((legacy) => {
      // A version-3 build had no summary table, and wrote documents the
      // current write path would canonicalise or could not have written.
      legacy.exec('DROP TABLE session_cleanup_summaries');
      legacy
        .prepare(
          `UPDATE sessions SET record = json_set(record, '$.cleanup.status', 'clean', '$.cleanup.completedAt', ?) WHERE id = ?`,
        )
        .run(BASE_TIME + 3.6, fractional);
      legacy.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('{not json', notJson);
      legacy
        .prepare(
          `UPDATE sessions SET record = json_set(record, '$.cleanup.status', ?) WHERE id = ?`,
        )
        .run('bogus', unknownCleanup);
      legacy.exec('PRAGMA user_version = 3');
      before = sessionRows(legacy);
    });

    // A version-3 store climbs the whole ladder: step 4 (this summary),
    // step 5 (telemetry_events.clock_offset_ms), step 6
    // (session_root_identities) and step 7 (the tab bindings re-keyed by
    // holder and tab), which leave every session row and summary as step 4
    // wrote them.
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(STORE_SCHEMA_VERSION).toBe(7);
    expect(summaryOf(store.db, conflicted)).toEqual({
      status: 'conflict',
      completed_at: BASE_TIME + 6,
      conflict_count: 3,
    });
    expect(summaryOf(store.db, clean)).toEqual({
      status: 'clean',
      completed_at: BASE_TIME + 5,
      conflict_count: 0,
    });
    expect(summaryOf(store.db, pending)).toEqual({
      status: 'pending',
      completed_at: null,
      conflict_count: 0,
    });
    // Rounded as the write path rounds it.
    expect(summaryOf(store.db, fractional)).toEqual({
      status: 'clean',
      completed_at: BASE_TIME + 4,
      conflict_count: 0,
    });
    expect(summaryOf(store.db, notJson)).toBeUndefined();
    expect(summaryOf(store.db, unknownCleanup)).toBeUndefined();

    // Additive: not one `sessions` row was touched.
    expect(sessionRows(store.db)).toEqual(before);

    // The two documents that yield no summary are listed as unreadable.
    const listed = page(['/w/a'], 50);
    expect(idsOf(listed)).toEqual([conflicted, clean, pending, fractional]);
    expect(listed).toMatchObject({ total: 6, consumed: 6, unreadable: 2 });

    // Reported by count, and by count only.
    expect(logs.some((entry) => entry.message.startsWith('applied store migration 4 ('))).toBe(
      true,
    );
    expect(logs.some((entry) => entry.message.startsWith('applied store migration 5 ('))).toBe(
      true,
    );
    // Step 6 warns separately, by its own count, about the sessions that carry
    // no recorded project-root identity; this step's warning is the one that
    // counts unsummarised sessions.
    const warned = logs.filter(
      (entry) => entry.level === 'warn' && entry.fields['unsummarisedSessions'] !== undefined,
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ unsummarisedSessions: 2 });
    expect(JSON.stringify(logs)).not.toContain(notJson);
    expect(JSON.stringify(logs)).not.toContain('handlerAlpha');
  });

  it('completes an adopted store — stamped 0 with the schema present — with the table created and backfilled', () => {
    const conflicted = newSessionId();
    unwrap(
      sessions.insert(
        makeSession({
          id: conflicted,
          status: 'ended',
          cleanup: conflictedCleanup(conflicted, 2, BASE_TIME + 1),
        }),
      ),
    );
    const pending = seed();
    const databasePath = store.path;
    store.close();

    const legacy = new DatabaseSync(databasePath);
    try {
      // What a build that predated version stamping left behind.
      legacy.exec('DROP TABLE session_cleanup_summaries');
      legacy.exec('PRAGMA user_version = 0');

      const outcome = unwrap(applyMigrations(legacy, { ddl: unwrap(loadSchemaSql()) }));

      expect(outcome).toEqual({
        fromVersion: 0,
        toVersion: STORE_SCHEMA_VERSION,
        applied: [2, 3, 4, 5, 6, 7],
        adopted: true,
      });
      expect(summaryOf(legacy, conflicted)).toEqual({
        status: 'conflict',
        completed_at: BASE_TIME + 1,
        conflict_count: 2,
      });
      expect(summaryOf(legacy, pending)).toEqual({
        status: 'pending',
        completed_at: null,
        conflict_count: 0,
      });
    } finally {
      legacy.close();
    }

    store = unwrap(openStore({ databasePath }));
    sessions = createSessionsRepo({ store, now: () => BASE_TIME });

    expect(page(['/w/a'], 50)).toMatchObject({ total: 2, consumed: 2, unreadable: 0 });
  });

  it('re-derives a summary row the table already held from the document, idempotently', () => {
    const id = seed();

    reopenAfter((legacy) => {
      // The table survives, holding a row that disagrees with the document.
      legacy
        .prepare(
          'UPDATE session_cleanup_summaries SET status = ?, conflict_count = ? WHERE session_id = ?',
        )
        .run('conflict', 9, id);
      legacy.exec('PRAGMA user_version = 3');
    });

    expect(summaryOf(store.db, id)).toEqual({
      status: 'pending',
      completed_at: null,
      conflict_count: 0,
    });
    expect(summaryCount(store.db)).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * listProgressTail — the most recent progress lines, in append order
 * ---------------------------------------------------------------------------------------------- */

/**
 * Appends `count` progress lines to a session, numbered from `from`, inside
 * one transaction.
 *
 * @param sessionId The session.
 * @param count How many lines to append.
 * @param from The number of the first line.
 */
function appendLines(sessionId: SessionId, count: number, from = 1): void {
  store.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      unwrap(
        sessions.appendProgress({
          sessionId,
          stage: 'understand',
          status: 'running',
          message: `line ${String(from + index)}`,
          ts: BASE_TIME + from + index,
        }),
      );
    }
  });
}

describe('listProgressTail', () => {
  let sessionId: SessionId;

  beforeEach(() => {
    sessionId = seed();
  });

  it('returns the last N lines in append order with the stored total', () => {
    appendLines(sessionId, 7);
    appendLines(seed({ projectRoot: '/w/other' }), 4);

    const tail = unwrap(sessions.listProgressTail(sessionId, 3));

    expect(tail.total).toBe(7);
    expect(tail.entries.map((entry) => entry.message)).toEqual(['line 5', 'line 6', 'line 7']);
    expect(tail.entries.map((entry) => entry.id)).toEqual(
      [...tail.entries.map((entry) => entry.id)].sort((left, right) => left - right),
    );
    expect(tail.entries.every((entry) => entry.sessionId === sessionId)).toBe(true);
  });

  it('returns every line when fewer than N are stored, and only the total for 0', () => {
    appendLines(sessionId, 2);

    const tail = unwrap(sessions.listProgressTail(sessionId, 500));

    expect(tail.total).toBe(2);
    expect(tail.entries.map((entry) => entry.message)).toEqual(['line 1', 'line 2']);
    expect(tail.entries).toEqual(unwrap(sessions.listProgress(sessionId)));
    expect(unwrap(sessions.listProgressTail(sessionId, 0))).toEqual({ entries: [], total: 2 });
    expect(unwrap(sessions.listProgressTail(newSessionId(), 5))).toEqual({ entries: [], total: 0 });
  });

  it('never reads a line older than the tail', () => {
    appendLines(sessionId, 6);
    const [oldest] = unwrap(sessions.listProgress(sessionId, { limit: 1 }));
    // An unreadable line outside the tail: reading it would fail the whole read.
    store.db
      .prepare('UPDATE session_progress SET status = ? WHERE id = ?')
      .run('bogus', oldest?.id ?? -1);

    const tail = unwrap(sessions.listProgressTail(sessionId, 5));

    expect(tail.total).toBe(6);
    expect(tail.entries.map((entry) => entry.message)).toEqual([
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
    ]);

    // Inside the tail, the same corruption fails the read, as listProgress does.
    const refused = sessions.listProgressTail(sessionId, 6);
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.details?.['reason']).toBe('corrupt-row');
    }
  });

  it('reads the tail and the count on idx_session_progress_session_id_id', () => {
    appendLines(sessionId, 3);
    const prepared: string[] = [];
    const statement = store.statement.bind(store);
    vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
      prepared.push(sql);
      return statement(sql);
    });

    unwrap(sessions.listProgressTail(sessionId, 2));

    expect(prepared).toHaveLength(2);
    const [count, select] = prepared;
    expect(select).toMatch(/ORDER BY id DESC\s+LIMIT \?$/);
    const plans = [
      store.db.prepare(`EXPLAIN QUERY PLAN ${count ?? ''}`).all(sessionId),
      store.db.prepare(`EXPLAIN QUERY PLAN ${select ?? ''}`).all(sessionId, 2),
    ];

    for (const plan of plans) {
      const details = plan.map((row) => String(row['detail']));
      expect(details.some((detail) => detail.includes('idx_session_progress_session_id_id'))).toBe(
        true,
      );
      expect(details.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false);
    }
  });

  it('refuses a limit or a session id outside its domain', () => {
    for (const refusal of [
      sessions.listProgressTail(sessionId, -1),
      sessions.listProgressTail(sessionId, 2.5),
      sessions.listProgressTail('', 5),
    ]) {
      expect(isErr(refusal)).toBe(true);
      if (isErr(refusal)) {
        expect(refusal.error.details?.['reason']).toBe('invalid-argument');
      }
    }
  });
});
