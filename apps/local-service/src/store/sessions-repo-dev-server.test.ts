/**
 * Unit suite for the sessions repository's indexed dev-server lookup,
 * {@link SessionsRepo.findLatestByDevServer} — how `session.bind` without a
 * session id finds the session debugging a page's origin.
 *
 * ## What is proved
 *
 * - **The newest active match wins.** Sessions are considered most recently
 *   updated first (`updated_at DESC, id DESC`), only in the statuses asked
 *   for, and only when the caller's predicate accepts the stored URL; ended
 *   sessions and other origins never win.
 * - **No document is read.** The lookup answers from the `id`,
 *   `dev_server_url` and `updated_at` projections: every statement it runs is
 *   recorded and none selects `record`, and ended sessions whose JSON document
 *   is corrupt — which `get` would refuse to parse — do not disturb it.
 * - **It is indexed and bounded.** The statements are planned on
 *   `idx_sessions_status`, not a walk of the `updated_at` index over every
 *   session, and a small `batchSize` pages through the candidates with a keyset
 *   cursor that neither repeats nor skips one, stopping at the first match.
 * - **Canonicalisation stays the caller's.** The predicate is the binding
 *   route's own `serializedOriginOf` comparison, so a stored URL with an
 *   upper-case host or a path still matches its origin.
 * - **Arguments are validated** like the session list's: an empty status
 *   filter selects nothing, and an unknown status or an out-of-range page size
 *   is a typed `STORE_ERROR`.
 *
 * The store is the real one — `openStore` on an `mkdtemp` sandbox, so the
 * real DDL, pragmas and migrations are what the statements run against.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_STATUSES } from '@debuggen/protocol';
import type { SessionRecord, SessionStatus } from '@debuggen/protocol';
import { isErr, newSessionId, unwrap } from '@debuggen/shared';
import type { SessionId } from '@debuggen/shared';

import { serializedOriginOf } from '../server/routes/binding.js';
import { isTerminalSessionStatus } from '../sessions/state-machine.js';
import { openStore } from './db.js';
import type { Store } from './db.js';
import { MAX_SESSION_LIST_LIMIT, createSessionsRepo } from './sessions-repo.js';
import type { SessionsRepo } from './sessions-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The first stamp of the suite's clock, in epoch milliseconds. */
const BASE_TIME = 1_767_225_600_000;

/** The origin most sessions of the suite are served from. */
const ORIGIN = 'http://127.0.0.1:20131';

/** A second origin, which must never match {@link ORIGIN}. */
const OTHER_ORIGIN = 'http://127.0.0.1:20132';

/** The first element of a list the state machine guarantees is non-empty. */
function firstOf<T>(values: readonly T[], what: string): T {
  const [first] = values;
  if (first === undefined) {
    throw new Error(`Expected at least one ${what}.`);
  }
  return first;
}

/** The statuses a tab can be bound in: every status the state machine does not treat as terminal. */
const ACTIVE_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => !isTerminalSessionStatus(status),
);

/** The terminal statuses, which the lookup must never answer with. */
const TERMINAL_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter((status) =>
  isTerminalSessionStatus(status),
);

/** One terminal status, for the ended sessions of the fixtures. */
const ENDED: SessionStatus = firstOf(TERMINAL_STATUSES, 'terminal session status');

/** The sandbox directory holding one test's database. */
let directory: string;

/** The store under the repository. */
let store: Store;

/** The repository under test, over {@link recordingStore}. */
let repo: SessionsRepo;

/** The reading of the repository's injected clock. */
let clock = BASE_TIME;

/** Every statement text the repository prepared since the last reset. */
let statements: string[] = [];

/**
 * A store that records every statement text the repository asks for and
 * delegates everything to the real one.
 */
function recordingStore(inner: Store): Store {
  return {
    get path() {
      return inner.path;
    },
    get db() {
      return inner.db;
    },
    get schemaVersion() {
      return inner.schemaVersion;
    },
    get isClosed() {
      return inner.isClosed;
    },
    statement: (sql) => {
      statements.push(sql);
      return inner.statement(sql);
    },
    transaction: (fn) => inner.transaction(fn),
    checkpoint: () => {
      inner.checkpoint();
    },
    close: () => {
      inner.close();
    },
  };
}

/** A valid session record served from `devServerUrl`, stamped `updatedAt`. */
function sessionRecord(id: SessionId, devServerUrl: string, updatedAt: number): SessionRecord {
  return {
    id,
    projectRoot: '/home/dev/projects/example',
    projectName: 'example',
    devServerUrl,
    createdAt: BASE_TIME,
    updatedAt,
    status: 'created',
    question: 'Why is this interaction slow?',
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
  };
}

/**
 * Stores a session in `status`, last updated at `updatedAt`, through the
 * repository's own write path.
 */
function seed(
  devServerUrl: string,
  updatedAt: number,
  status: SessionStatus,
  id: SessionId = newSessionId(),
): SessionId {
  clock = updatedAt;
  unwrap(repo.update(sessionRecord(id, devServerUrl, updatedAt)));
  if (status !== 'created') {
    unwrap(repo.setStatus(id, status));
  }
  return id;
}

/** Replaces a session's JSON document with text that is not JSON at all. */
function corruptDocument(id: SessionId): void {
  store.statement('UPDATE sessions SET record = ? WHERE id = ?').run('{"id": "unterminated', id);
}

/** The binding route's predicate: the stored URL canonicalises to `origin`. */
function sameOriginAs(origin: string): (devServerUrl: string) => boolean {
  return (devServerUrl) => serializedOriginOf(devServerUrl) === origin;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-sessions-'));
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  clock = BASE_TIME;
  statements = [];
  repo = createSessionsRepo({ store: recordingStore(store), now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * findLatestByDevServer
 * ---------------------------------------------------------------------------------------------- */

describe('findLatestByDevServer', () => {
  it('answers the most recently updated active session of the origin', () => {
    seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');
    const newest = seed(`${ORIGIN}/`, BASE_TIME + 30, 'capturing');
    seed(`${ORIGIN}/`, BASE_TIME + 20, 'created');

    expect(
      unwrap(
        repo.findLatestByDevServer({ statuses: ACTIVE_STATUSES, matches: sameOriginAs(ORIGIN) }),
      ),
    ).toBe(newest);
  });

  it('skips ended sessions and sessions of other origins, however recent', () => {
    const active = seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');
    seed(`${ORIGIN}/`, BASE_TIME + 40, ENDED);
    seed(`${OTHER_ORIGIN}/`, BASE_TIME + 50, 'capturing');

    expect(
      unwrap(
        repo.findLatestByDevServer({ statuses: ACTIVE_STATUSES, matches: sameOriginAs(ORIGIN) }),
      ),
    ).toBe(active);
    expect(
      unwrap(
        repo.findLatestByDevServer({
          statuses: ACTIVE_STATUSES,
          matches: sameOriginAs('http://127.0.0.1:20133'),
        }),
      ),
    ).toBeUndefined();
  });

  it('answers undefined when every session of the origin has ended', () => {
    seed(`${ORIGIN}/`, BASE_TIME + 10, ENDED);

    expect(
      unwrap(
        repo.findLatestByDevServer({ statuses: ACTIVE_STATUSES, matches: sameOriginAs(ORIGIN) }),
      ),
    ).toBeUndefined();
  });

  it('never reads a session document: corrupt ended records do not disturb it', () => {
    const active = seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');
    const corrupt: SessionId[] = [];
    for (let index = 1; index <= 5; index += 1) {
      corrupt.push(seed(`${ORIGIN}/`, BASE_TIME + 100 + index, ENDED));
    }
    // An active session of another origin whose document is corrupt is a
    // candidate the predicate rejects, and is still never parsed.
    corrupt.push(seed(`${OTHER_ORIGIN}/`, BASE_TIME + 200, 'capturing'));
    for (const id of corrupt) {
      corruptDocument(id);
    }
    statements = [];

    const found = repo.findLatestByDevServer({
      statuses: ACTIVE_STATUSES,
      matches: sameOriginAs(ORIGIN),
    });

    expect(unwrap(found)).toBe(active);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql).not.toMatch(/\brecord\b/u);
    }
    // The corrupt documents really are unreadable: reading one refuses it.
    for (const id of corrupt) {
      const read = repo.get(id);
      expect(isErr(read) && read.error.details?.['reason'], id).toBe('corrupt-row');
    }
  });

  it('reads the candidates through idx_sessions_status, never by walking every session', () => {
    // A history dominated by ended sessions, with statistics gathered: the
    // shape under which a planner is tempted to walk `idx_sessions_updated_at`
    // to avoid sorting, reading every ended session on the way.
    seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');
    seed(`${ORIGIN}/`, BASE_TIME + 11, 'capturing');
    store.transaction(() => {
      for (let index = 0; index < 200; index += 1) {
        seed(`${ORIGIN}/`, BASE_TIME + 1_000 + index, ENDED);
      }
    });
    store.db.exec('ANALYZE');
    statements = [];
    unwrap(
      repo.findLatestByDevServer({
        statuses: ACTIVE_STATUSES,
        matches: () => false,
        batchSize: 1,
      }),
    );

    // Both shapes ran: the first page and a cursor page.
    const lookups = [...new Set(statements)];
    expect(lookups).toHaveLength(2);
    for (const sql of lookups) {
      const placeholders = (sql.match(/\?/gu) ?? []).length;
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: placeholders }, () => null))
        .map((row) => String(row['detail']));
      expect(plan.join(' | ')).toContain('idx_sessions_status');
      expect(plan.join(' | ')).not.toContain('idx_sessions_updated_at');
    }
  });

  it('matches a stored URL that is not in canonical form through the caller’s origin predicate', () => {
    const upperCase = seed('HTTP://LOCALHOST:20131/app/', BASE_TIME + 10, 'ready');
    const withPath = seed('http://localhost:20132/dashboard/reports?tab=1', BASE_TIME + 5, 'ready');

    expect(
      unwrap(
        repo.findLatestByDevServer({
          statuses: ACTIVE_STATUSES,
          matches: sameOriginAs('http://localhost:20131'),
        }),
      ),
    ).toBe(upperCase);
    expect(
      unwrap(
        repo.findLatestByDevServer({
          statuses: ACTIVE_STATUSES,
          matches: sameOriginAs('http://localhost:20132'),
        }),
      ),
    ).toBe(withPath);
  });

  it('pages newest first with a keyset cursor, visiting each candidate once and stopping at the first match', () => {
    // Two sessions share a stamp, so the id (descending) breaks the tie across
    // a page edge.
    const [tieLow, tieHigh] = [newSessionId(), newSessionId()].sort();
    if (tieLow === undefined || tieHigh === undefined) {
      throw new Error('Unreachable: two ids were minted.');
    }
    seed(`${OTHER_ORIGIN}/`, BASE_TIME + 40, 'ready', tieLow);
    seed(`${OTHER_ORIGIN}/`, BASE_TIME + 40, 'ready', tieHigh);
    const middle = seed(`${OTHER_ORIGIN}/`, BASE_TIME + 30, 'ready');
    const target = seed(`${ORIGIN}/`, BASE_TIME + 20, 'ready');
    const older = seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');

    const visited: SessionId[] = [];
    const found = repo.findLatestByDevServer({
      statuses: ACTIVE_STATUSES,
      batchSize: 2,
      matches: (devServerUrl, sessionId) => {
        visited.push(sessionId);
        return serializedOriginOf(devServerUrl) === ORIGIN;
      },
    });

    expect(unwrap(found)).toBe(target);
    expect(visited).toEqual([tieHigh, tieLow, middle, target]);
    expect(visited).not.toContain(older);

    // Excluding the winner through the predicate reaches the next-newest match.
    expect(
      unwrap(
        repo.findLatestByDevServer({
          statuses: ACTIVE_STATUSES,
          batchSize: 1,
          matches: (devServerUrl, sessionId) =>
            sessionId !== target && serializedOriginOf(devServerUrl) === ORIGIN,
        }),
      ),
    ).toBe(older);
  });

  it('answers undefined for an empty status filter, and refuses an unknown status or page size', () => {
    seed(`${ORIGIN}/`, BASE_TIME + 10, 'ready');
    statements = [];

    expect(
      unwrap(repo.findLatestByDevServer({ statuses: [], matches: () => true })),
    ).toBeUndefined();
    expect(statements).toEqual([]);

    const unknown = repo.findLatestByDevServer({
      statuses: ['not-a-status' as SessionStatus],
      matches: () => true,
    });
    expect(isErr(unknown) && unknown.error.code).toBe('STORE_ERROR');
    expect(isErr(unknown) && unknown.error.details?.['reason']).toBe('unknown-status');

    for (const batchSize of [0, 1.5, MAX_SESSION_LIST_LIMIT + 1]) {
      const refused = repo.findLatestByDevServer({
        statuses: ACTIVE_STATUSES,
        matches: () => true,
        batchSize,
      });
      expect(isErr(refused) && refused.error.code, String(batchSize)).toBe('STORE_ERROR');
      expect(isErr(refused) && refused.error.details?.['reason'], String(batchSize)).toBe(
        'invalid-argument',
      );
    }
  });
});
