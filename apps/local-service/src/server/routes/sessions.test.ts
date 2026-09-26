/**
 * Tests for the two paged listings of `./sessions.ts`: `GET /sessions` and
 * `GET /sessions/:id/modifications`.
 *
 * Each handler is exercised through an in-process hono application — no
 * socket, no server — whose one middleware stands in for `../auth.ts`'s by
 * placing a resolved principal on the context. The session store and the
 * modification journal are the real repositories over a store opened in an
 * `mkdtemp` sandbox, so the pages are read by the real SQL; every other
 * collaborator of `createSessionRoutes` is a stub that fails the test if a
 * listing ever reaches it.
 *
 * What is on trial is the wire contract protocol's Section C.1 fixes and the
 * two responses' schemas enforce: the window read from `limit`/`offset` with
 * its defaults echoed, the `total`, a `nextOffset` a paging loop can follow to
 * the end without repeating or skipping an item, the `400` of a malformed
 * window, the editor's workspace scope, and — for the journal — the diff budget
 * that ends a page early. Every response is parsed with protocol's own
 * `parseHttpResponse`, the parser a client applies.
 *
 * The last suite covers the state-root separation (AAP §0.4.2): `POST /sessions`
 * and `POST /sessions/:id/question` refuse a project root that is, contains or
 * lies inside the canonical state root the routes were built with, before the
 * revocation fence, the manager or the orchestrator is reached. Its folders are
 * real directories under a realpath'd `mkdtemp` sandbox, so the symbolic-link
 * and not-yet-existing cases run through the real `fs.realpath`.
 *
 * The purge suite covers `POST /sessions/purge`: the sweep's scope is exactly
 * the editor's announced folders, sweeps of one folder set are shared and
 * sweeps of two are serialised, and the scope admits a stored root only when
 * its canonical location lies under a canonical folder — so a link inside the
 * workspace that resolves out of it, a root that cannot be resolved and every
 * root under a folder that cannot be resolved are refused. Those folders are
 * real directories and links under a realpath'd `mkdtemp` sandbox, resolved
 * by the real `fs.realpath`; a self-referential link stands for an
 * unresolvable path, because it fails with `ELOOP` even for root.
 *
 * Fixtures are neutral (`/w/…`, `src/moduleN.ts`); no environment variable is
 * read and nothing under `$DEBUGGEN_HOME` is touched.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createModificationRecord } from '@debuggen/instrumentation';
import type { ModificationRecord } from '@debuggen/instrumentation';
import {
  HTTP_ROUTES,
  MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  MODIFICATIONS_PAGE_DIFF_BUDGET,
  SESSION_LIST_DEFAULT_LIMIT,
  modificationsDiffBytes,
  parseHttpResponse,
  parseSessionRecord,
} from '@debuggen/protocol';
import type {
  HttpOperationId,
  ModificationsResponse,
  SessionListResponse,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, newSessionId, ok, unwrap } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, Result, SessionId } from '@debuggen/shared';

import { STATE_HOME_OVERLAP_MESSAGE } from '../../config.js';
import { openStore } from '../../store/db.js';
import type { RetentionReport, RetentionScope } from '../../store/retention.js';
import type { Store } from '../../store/db.js';
import { createModificationsRepo } from '../../store/modifications-repo.js';
import type { ModificationsRepo } from '../../store/modifications-repo.js';
import { createSessionsRepo } from '../../store/sessions-repo.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import { AUTH_FAILURE_REASONS } from '../auth.js';
import type {
  DevtoolsPrincipal,
  EditorPrincipal,
  Principal,
  ServerEnv,
  TabBinding,
} from '../auth.js';
import { createSessionRoutes } from './sessions.js';
import type { SessionRoutes, SessionRoutesDeps } from './sessions.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** A fixed epoch-millisecond base every stamp below is offset from. */
const BASE_TIME = 1_760_000_000_000;

/** One captured log record. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that records every call, so an assertion can say exactly what a
 * handler logged — and what it did not.
 *
 * @param sink Where records go.
 * @param bindings Fields every record carries.
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

/** Fails the test: a listing must never reach this collaborator. */
function unused(): never {
  throw new Error('A paged listing reached a collaborator it must not use.');
}

/**
 * An editor principal announcing `folders`.
 *
 * @param folders The announced workspace folders.
 * @returns The principal.
 */
function editor(folders: readonly string[]): EditorPrincipal {
  return {
    role: 'vscode',
    tokenHash: 'e'.repeat(64),
    issuedAt: BASE_TIME,
    scope: { kind: 'machine-user', workspaceFolders: folders },
  };
}

/** A DevTools principal of one paired extension. */
const DEVTOOLS: DevtoolsPrincipal = {
  role: 'devtools',
  tokenHash: 'd'.repeat(64),
  issuedAt: BASE_TIME,
  scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
};

/**
 * The inspected tab every DevTools request of this suite acts for, as
 * `../auth.ts`'s middleware verifies it from the acting-tab header: a DevTools
 * principal is admitted only through a binding of that very tab.
 */
const INSPECTED_TAB_ID = 7;

/** What {@link makeSession} may override. */
interface SessionOverrides {
  readonly id?: SessionId;
  readonly projectRoot?: string;
  readonly updatedAt?: number;
}

/**
 * A valid session record, built through protocol's own parser.
 *
 * @param overrides The members a test cares about.
 * @returns The record.
 */
function makeSession(overrides: SessionOverrides = {}): SessionRecord {
  const projectRoot = overrides.projectRoot ?? '/w/a';

  return unwrap(
    parseSessionRecord({
      id: overrides.id ?? newSessionId(),
      projectRoot,
      projectName: projectRoot.split('/').at(-1) ?? 'project',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: BASE_TIME,
      updatedAt: overrides.updatedAt ?? BASE_TIME,
      status: 'ready',
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

let directory: string;
let store: Store;
let sessions: SessionsRepo;
let modifications: ModificationsRepo;
let logs: CapturedLog[];
let principal: Principal | undefined;
/** The acting tab the stand-in middleware verifies for a DevTools principal, if any. */
let actingTab: number | undefined;
let binding: TabBinding | undefined;
let app: Hono<ServerEnv>;
/** The manager's whole-record read, observed: the journal listing must never make it. */
let managerGet: Mock<SessionsRepo['get']>;
/** The store's id-and-root read, observed: what the journal listing admits on. */
let accessTargetRead: Mock<SessionsRepo['getAccessTarget']>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'debuggen-session-routes-'));
  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite') }));
  sessions = createSessionsRepo({ store, now: () => BASE_TIME });
  modifications = createModificationsRepo({ store, now: () => BASE_TIME });
  logs = [];
  principal = editor(['/w/a']);
  actingTab = INSPECTED_TAB_ID;
  binding = undefined;
  managerGet = vi.fn((sessionId: SessionId) => sessions.get(sessionId));
  accessTargetRead = vi.fn((sessionId: SessionId) => sessions.getAccessTarget(sessionId));

  const routes: SessionRoutes = createSessionRoutes({
    manager: {
      create: unused,
      get: managerGet,
      list: unused,
      end: unused,
      fail: unused,
      patch: unused,
    },
    reopener: { reopen: unused },
    orchestrator: {
      run: unused,
      beginCapture: unused,
      completeCapture: unused,
      followUp: unused,
      cancel: unused,
      activeRun: unused,
      releaseSession: unused,
    },
    sessions: {
      getActiveCapture: unused,
      getCapture: unused,
      listWithinFolders: (options) => sessions.listWithinFolders(options),
      getAccessTarget: accessTargetRead,
    },
    panels: { getLatestPanel: unused, getPanel: unused },
    modifications,
    bindings: {
      bindingForSession: (sessionId) => (binding?.sessionId === sessionId ? binding : undefined),
      sendToBoundTab: unused,
    },
    retention: { purge: unused },
    // Only a `POST` passes the revocation fence; both listings are `GET`s.
    auth: { requireLiveCredential: unused },
    logger: createCapturingLogger(logs),
  });

  app = new Hono<ServerEnv>();
  // Stands in for `../auth.ts`'s middleware: the resolved principal, if any,
  // and — for a DevTools principal — the acting tab it verified.
  app.use('*', async (c, next) => {
    if (principal !== undefined) {
      c.set('principal', principal);
      if (principal.role === 'devtools' && actingTab !== undefined) {
        c.set('actingTabId', actingTab);
      }
    }
    await next();
  });
  for (const operation of ['session.list', 'modifications.list'] as const) {
    app.get(HTTP_ROUTES[operation].pattern, routes[operation]);
  }
});

afterEach(() => {
  if (!store.isClosed) {
    store.close();
  }

  rmSync(directory, { recursive: true, force: true });
  expect(existsSync(directory)).toBe(false);
});

/** One answered request: status, header and parsed JSON body. */
interface Answer {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly body: unknown;
}

/**
 * Sends one `GET` through the in-process application.
 *
 * @param path The path and query string.
 * @returns The answer.
 */
async function get(path: string): Promise<Answer> {
  const response = await app.request(path);

  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  };
}

/**
 * Sends one `GET` that must succeed, and parses its body with protocol's
 * response parser for `operation`.
 *
 * @param operation The listing.
 * @param path The path and query string.
 * @returns The parsed body.
 */
async function listed<O extends HttpOperationId>(operation: O, path: string) {
  const answer = await get(path);
  expect(answer.status).toBe(200);
  expect(answer.cacheControl).toBe('no-store');

  return unwrap(parseHttpResponse(operation, answer.body));
}

/**
 * Stores a session and returns its id.
 *
 * @param overrides The members a test cares about.
 * @returns The id.
 */
function seed(overrides: SessionOverrides = {}): SessionId {
  return unwrap(sessions.insert(makeSession(overrides))).id;
}

/**
 * Follows `nextOffset` from offset 0 to the end, collecting every page.
 *
 * @param limit The page size to request.
 * @returns The pages, in order.
 */
async function everySessionPage(limit: number): Promise<SessionListResponse[]> {
  const pages: SessionListResponse[] = [];
  let offset: number | null = 0;

  while (offset !== null) {
    const listedPage: SessionListResponse = await listed(
      'session.list',
      `/sessions?limit=${String(limit)}&offset=${String(offset)}`,
    );
    pages.push(listedPage);
    offset = listedPage.nextOffset;
    expect(pages.length).toBeLessThan(100);
  }

  return pages;
}

/* -------------------------------------------------------------------------------------------------
 * GET /sessions
 * ---------------------------------------------------------------------------------------------- */

describe('GET /sessions answers one scoped page of list rows', () => {
  it('applies and echoes the default window, and lists only the announced workspace', async () => {
    const own = seed({ updatedAt: BASE_TIME + 3 });
    const nested = seed({ projectRoot: '/w/a/b', updatedAt: BASE_TIME + 2 });
    seed({ projectRoot: '/w/ab', updatedAt: BASE_TIME + 1 });
    seed({ projectRoot: '/x/a', updatedAt: BASE_TIME + 4 });

    const page = await listed('session.list', '/sessions');

    expect(page).toEqual({
      sessions: [
        expect.objectContaining({ id: own, cleanup: { status: 'pending', conflictCount: 0 } }),
        expect.objectContaining({ id: nested, projectRoot: '/w/a/b' }),
      ],
      total: 2,
      limit: SESSION_LIST_DEFAULT_LIMIT,
      offset: 0,
      nextOffset: null,
    });
    for (const row of page.sessions) {
      expect(Object.keys(row).sort()).toEqual([
        'cleanup',
        'createdAt',
        'id',
        'projectName',
        'projectRoot',
        'question',
        'status',
        'updatedAt',
      ]);
    }
  });

  it('pages through every in-scope session exactly once by following nextOffset', async () => {
    const expected = Array.from({ length: 7 }, (_, index) =>
      seed({ updatedAt: BASE_TIME + 10 - index }),
    );
    seed({ projectRoot: '/x/other', updatedAt: BASE_TIME + 20 });

    const pages = await everySessionPage(3);

    expect(pages.map((page) => [page.offset, page.sessions.length, page.nextOffset])).toEqual([
      [0, 3, 3],
      [3, 3, 6],
      [6, 1, null],
    ]);
    expect(pages.every((page) => page.total === 7 && page.limit === 3)).toBe(true);
    expect(pages.flatMap((page) => page.sessions.map((row) => row.id))).toEqual(expected);
  });

  it('moves past an unreadable row it leaves out, and logs only counts', async () => {
    const first = seed({ updatedAt: BASE_TIME + 3 });
    const corrupt = seed({ updatedAt: BASE_TIME + 2 });
    const last = seed({ updatedAt: BASE_TIME + 1 });
    // A session without a cleanup summary row is the list's unreadable row.
    store.db.prepare('DELETE FROM session_cleanup_summaries WHERE session_id = ?').run(corrupt);

    const head = await listed('session.list', '/sessions?limit=2');
    const tail = await listed(
      'session.list',
      `/sessions?limit=2&offset=${String(head.nextOffset)}`,
    );

    expect(head.sessions.map((row) => row.id)).toEqual([first]);
    expect(head).toMatchObject({ total: 3, limit: 2, offset: 0, nextOffset: 2 });
    expect(tail.sessions.map((row) => row.id)).toEqual([last]);
    expect(tail).toMatchObject({ total: 3, offset: 2, nextOffset: null });

    const warned = logs.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ unreadable: 1, outOfScope: 0 });
    expect(JSON.stringify(logs)).not.toContain('/w/a');
    expect(JSON.stringify(logs)).not.toContain('handlerAlpha');
  });

  it('lists a session whose stored document is not JSON, from its projections alone', async () => {
    const own = seed({ updatedAt: BASE_TIME + 1 });
    store.db.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('not json', own);

    const page = await listed('session.list', '/sessions');

    expect(page.sessions).toEqual([
      expect.objectContaining({ id: own, cleanup: { status: 'pending', conflictCount: 0 } }),
    ]);
    expect(page).toMatchObject({ total: 1, nextOffset: null });
    expect(managerGet).not.toHaveBeenCalled();
  });

  it('never lists a stored root that escapes its folder lexically', async () => {
    const escaped = seed({ updatedAt: BASE_TIME + 2 });
    const own = seed({ updatedAt: BASE_TIME + 1 });
    store.db.prepare('UPDATE sessions SET project_root = ? WHERE id = ?').run('/w/a/../b', escaped);

    const page = await listed('session.list', '/sessions');

    expect(page.sessions.map((row) => row.id)).toEqual([own]);
    expect(page.nextOffset).toBeNull();
  });

  it('answers a count-only request and a window past the end with no rows', async () => {
    seed();
    seed();

    expect(await listed('session.list', '/sessions?limit=0')).toEqual({
      sessions: [],
      total: 2,
      limit: 0,
      offset: 0,
      nextOffset: null,
    });
    expect(await listed('session.list', '/sessions?offset=40')).toEqual({
      sessions: [],
      total: 2,
      limit: SESSION_LIST_DEFAULT_LIMIT,
      offset: 40,
      nextOffset: null,
    });
  });

  it('lists nothing for an editor that announced no workspace folder', async () => {
    seed();
    principal = editor([]);

    expect(await listed('session.list', '/sessions')).toMatchObject({ sessions: [], total: 0 });
  });

  it('refuses a malformed window with 400, before any store read', async () => {
    for (const query of [
      'limit=501',
      'limit=abc',
      'limit=-1',
      'offset=01',
      'page=2',
      'limit=1e3',
    ]) {
      const answer = await get(`/sessions?${query}`);
      expect(answer.status, query).toBe(400);
      expect(answer.cacheControl).toBe('no-store');
      expect(answer.body).toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    }
  });

  it('authorizes exactly as before: a DevTools credential is refused, a missing principal is 401', async () => {
    principal = DEVTOOLS;
    expect((await get('/sessions')).status).toBe(403);

    principal = undefined;
    expect((await get('/sessions')).status).toBe(401);
  });
});

/* -------------------------------------------------------------------------------------------------
 * GET /sessions/:id/modifications
 * ---------------------------------------------------------------------------------------------- */

/** A string no log record may ever carry: it stands for the developer's source. */
const DIFF_SENTINEL = 'DIFF-SENTINEL-4b1e-never-log-me';

/** How many records {@link journal} has written, so each patches its own file. */
let journalled = 0;

/**
 * Journals one `applied`-shaped record of `sessionId` whose diff is exactly
 * `diffLength` UTF-16 code units, padded with `filler`, through the real
 * journal.
 *
 * @param sessionId The owning session.
 * @param diffLength The diff's `string.length`.
 * @param filler One code unit of padding — `'+'` is one UTF-8 byte, `'€'` three.
 * @returns The record as journalled.
 */
async function journal(
  sessionId: SessionId,
  diffLength = 64,
  filler = '+',
): Promise<ModificationRecord> {
  journalled += 1;
  const file = `src/module${String(journalled)}.ts`;
  const header = `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+// ${DIFF_SENTINEL}\n`;
  const originalHash = journalled.toString(16).padStart(64, '0');
  const record = unwrap(
    createModificationRecord(
      {
        sessionId,
        planVersion: 1,
        file,
        originalHash,
        backupPath: join(directory, 'backups', sessionId, originalHash),
        instrumentedHash: journalled.toString(16).padStart(64, 'f'),
        diff: `${header}${filler.repeat(Math.max(0, diffLength - header.length))}`,
      },
      { now: () => BASE_TIME },
    ),
  );

  return unwrap(await modifications.append(record));
}

/**
 * Follows `nextOffset` through a session's journal from offset 0 to the end.
 *
 * @param sessionId The session.
 * @returns The pages, in order.
 */
async function everyJournalPage(sessionId: SessionId): Promise<ModificationsResponse[]> {
  const pages: ModificationsResponse[] = [];
  let offset: number | null = 0;

  while (offset !== null) {
    const journalPage: ModificationsResponse = await listed(
      'modifications.list',
      `/sessions/${sessionId}/modifications?offset=${String(offset)}`,
    );
    pages.push(journalPage);
    offset = journalPage.nextOffset;
    expect(pages.length).toBeLessThan(100);
  }

  return pages;
}

describe('GET /sessions/:id/modifications answers one diff-budgeted page of the journal', () => {
  let sessionId: SessionId;

  beforeEach(() => {
    sessionId = seed();
  });

  it('applies and echoes the default window, in application order', async () => {
    const records = [await journal(sessionId), await journal(sessionId), await journal(sessionId)];
    await journal(seed({ projectRoot: '/w/a/other' }));

    const page = await listed('modifications.list', `/sessions/${sessionId}/modifications`);

    expect(page.modifications.map((record) => record.id)).toEqual(records.map((r) => r.id));
    expect(page).toMatchObject({
      total: 3,
      limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
      offset: 0,
      nextOffset: null,
    });
  });

  it('ends a page early at the UTF-8 byte budget and resumes at nextOffset', async () => {
    // A million code units of '€' each: three bytes a unit, so two diffs fit
    // the 6 MiB budget and a third does not — while all three together hold
    // fewer code units than the budget, which a code-unit measure would admit.
    const records = [
      await journal(sessionId, 1_000_000, '€'),
      await journal(sessionId, 1_000_000, '€'),
      await journal(sessionId, 1_000_000, '€'),
    ];
    expect(records.reduce((units, record) => units + record.diff.length, 0)).toBeLessThan(
      MODIFICATIONS_PAGE_DIFF_BUDGET,
    );

    const pages = await everyJournalPage(sessionId);

    expect(pages.map((page) => [page.offset, page.modifications.length, page.nextOffset])).toEqual([
      [0, 2, 2],
      [2, 1, null],
    ]);
    for (const page of pages) {
      expect(page.total).toBe(3);
      expect(modificationsDiffBytes(page.modifications)).toBeLessThanOrEqual(
        MODIFICATIONS_PAGE_DIFF_BUDGET,
      );
    }
    expect(modificationsDiffBytes(records)).toBeGreaterThan(MODIFICATIONS_PAGE_DIFF_BUDGET);
    expect(pages.flatMap((page) => page.modifications.map((record) => record.id))).toEqual(
      records.map((record) => record.id),
    );
    expect(JSON.stringify(logs)).not.toContain(DIFF_SENTINEL);
  });

  it('counts without a diff for limit=0, and pages by count below the budget', async () => {
    await journal(sessionId);
    await journal(sessionId);

    expect(
      await listed('modifications.list', `/sessions/${sessionId}/modifications?limit=0`),
    ).toEqual({ modifications: [], total: 2, limit: 0, offset: 0, nextOffset: null });

    const first = await listed(
      'modifications.list',
      `/sessions/${sessionId}/modifications?limit=1`,
    );
    expect(first).toMatchObject({ total: 2, limit: 1, offset: 0, nextOffset: 1 });
    expect(first.modifications).toHaveLength(1);

    expect(
      await listed('modifications.list', `/sessions/${sessionId}/modifications?offset=9`),
    ).toEqual({
      modifications: [],
      total: 2,
      limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
      offset: 9,
      nextOffset: null,
    });
  });

  it('refuses a malformed window with 400', async () => {
    for (const query of ['limit=257', 'offset=x', 'limit=2&cursor=1']) {
      const answer = await get(`/sessions/${sessionId}/modifications?${query}`);
      expect(answer.status, query).toBe(400);
      expect(answer.body).toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    }
  });

  it('admits exactly the principals it admitted before', async () => {
    await journal(sessionId);
    const path = `/sessions/${sessionId}/modifications`;

    principal = editor(['/x']);
    expect((await get(path)).status).toBe(403);

    principal = DEVTOOLS;
    expect((await get(path)).status).toBe(403);

    binding = { tabId: INSPECTED_TAB_ID, sessionId, boundBy: DEVTOOLS.tokenHash };
    expect((await get(path)).status).toBe(200);

    // The same credential acting for another tab, or naming no tab, is not the binding.
    actingTab = INSPECTED_TAB_ID + 1;
    expect((await get(path)).status).toBe(403);
    actingTab = undefined;
    expect((await get(path)).status).toBe(403);
    actingTab = INSPECTED_TAB_ID;

    principal = editor(['/w/a']);
    expect((await get(`/sessions/${newSessionId()}/modifications`)).status).toBe(404);
  });

  it('admits on the id and project root alone, never hydrating the session record', async () => {
    await journal(sessionId);
    await journal(sessionId);
    const path = `/sessions/${sessionId}/modifications`;

    expect((await listed('modifications.list', path)).modifications).toHaveLength(2);
    expect(await listed('modifications.list', `${path}?limit=0`)).toEqual({
      modifications: [],
      total: 2,
      limit: 0,
      offset: 0,
      nextOffset: null,
    });

    // Every refusal too: out of scope, unbound, unknown.
    principal = editor(['/x']);
    expect((await get(path)).status).toBe(403);
    principal = DEVTOOLS;
    expect((await get(path)).status).toBe(403);
    principal = editor(['/w/a']);
    expect((await get(`/sessions/${newSessionId()}/modifications`)).status).toBe(404);

    expect(managerGet).not.toHaveBeenCalled();
    expect(accessTargetRead).toHaveBeenCalledTimes(4);
  });

  it('lists the journal of a session whose stored document is not JSON', async () => {
    const records = [await journal(sessionId), await journal(sessionId)];
    store.db.prepare('UPDATE sessions SET record = ? WHERE id = ?').run('not json', sessionId);

    const page = await listed('modifications.list', `/sessions/${sessionId}/modifications`);

    expect(page.modifications.map((record) => record.id)).toEqual(records.map((r) => r.id));
    expect(page).toMatchObject({ total: 2, nextOffset: null });
  });

  it('keeps the admission order: a DevTools binding is checked before any store read', async () => {
    principal = DEVTOOLS;
    const unknown = newSessionId();

    // Unbound, the answer for an unknown session equals the one for an existing
    // session: 403, and the store was never asked.
    const refusedUnknown = await get(`/sessions/${unknown}/modifications`);
    const refusedKnown = await get(`/sessions/${sessionId}/modifications`);

    expect(refusedUnknown.status).toBe(403);
    expect(refusedUnknown.body).toEqual(refusedKnown.body);
    expect(refusedUnknown.body).toMatchObject({ code: 'TAB_NOT_BOUND' });
    expect(accessTargetRead).not.toHaveBeenCalled();

    // Bound to a session the store does not hold: the existence check follows.
    binding = { tabId: INSPECTED_TAB_ID, sessionId: unknown, boundBy: DEVTOOLS.tokenHash };
    const missing = await get(`/sessions/${unknown}/modifications`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    // A malformed id and a missing principal are refused before any of it.
    principal = editor(['/w/a']);
    expect((await get('/sessions/not-a-session/modifications')).status).toBe(404);
    principal = undefined;
    expect((await get(`/sessions/${sessionId}/modifications`)).status).toBe(401);

    expect(accessTargetRead).toHaveBeenCalledTimes(1);
    expect(managerGet).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------------
 * POST /sessions and POST /sessions/:id/question keep the project apart from the state root
 * ---------------------------------------------------------------------------------------------- */

describe('POST /sessions and POST /sessions/:id/question refuse a project that overlaps the state root', () => {
  /** The realpath'd sandbox of the running test; every folder below lives in it. */
  let sandbox: string;

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-session-state-home-')));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    expect(existsSync(sandbox)).toBe(false);
  });

  /**
   * Creates `path` (and its parents) and returns it.
   *
   * @param path The absolute directory.
   * @returns `path`.
   */
  function folder(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** The routes under test and the collaborators a refusal must never reach. */
  interface StateHomeHarness {
    readonly app: Hono<ServerEnv>;
    readonly create: Mock<SessionRoutesDeps['manager']['create']>;
    readonly followUp: Mock<SessionRoutesDeps['orchestrator']['followUp']>;
    readonly liveCredential: Mock<SessionRoutesDeps['auth']['requireLiveCredential']>;
  }

  /**
   * Builds `POST /sessions` and `POST /sessions/:id/question` over the shared
   * session store with `canonicalStateHome` as the state root. The manager's
   * `create` and the orchestrator's `followUp` answer `409` so a request that
   * passes the check ends there; the revocation fence always admits.
   *
   * @param canonicalStateHome The canonical state root.
   * @returns The application and its observed collaborators.
   */
  function stateHomeHarness(canonicalStateHome: string): StateHomeHarness {
    const refused = () =>
      Promise.resolve(
        err(new DebuggenError('SESSION_INVALID_STATE', 'The test harness stores no session.')),
      );
    const create = vi.fn<SessionRoutesDeps['manager']['create']>(refused);
    const followUp = vi.fn<SessionRoutesDeps['orchestrator']['followUp']>(refused);
    const liveCredential = vi.fn<SessionRoutesDeps['auth']['requireLiveCredential']>(() =>
      ok(undefined),
    );

    const routes: SessionRoutes = createSessionRoutes({
      manager: {
        create,
        get: (sessionId) => sessions.get(sessionId),
        // No earlier session of the project: the new one has no dev-server URL.
        list: () => ok([]),
        end: unused,
        fail: unused,
        patch: unused,
      },
      reopener: { reopen: unused },
      orchestrator: {
        run: unused,
        beginCapture: unused,
        completeCapture: unused,
        followUp,
        cancel: unused,
        activeRun: unused,
        releaseSession: unused,
      },
      sessions: {
        getActiveCapture: unused,
        getCapture: unused,
        listWithinFolders: unused,
        getAccessTarget: (sessionId) => sessions.getAccessTarget(sessionId),
      },
      panels: { getLatestPanel: unused, getPanel: unused },
      modifications,
      bindings: { bindingForSession: () => undefined, sendToBoundTab: unused },
      retention: { purge: unused },
      auth: { requireLiveCredential: liveCredential },
      canonicalStateHome,
      logger: createCapturingLogger(logs),
    });

    const stateApp = new Hono<ServerEnv>();
    stateApp.use('*', async (c, next) => {
      if (principal !== undefined) {
        c.set('principal', principal);
      }
      await next();
    });
    for (const operation of ['session.create', 'session.question'] as const) {
      stateApp.post(HTTP_ROUTES[operation].pattern, routes[operation]);
    }
    return { app: stateApp, create, followUp, liveCredential };
  }

  /**
   * Sends one JSON `POST` through `target`.
   *
   * @param target The application.
   * @param path The path.
   * @param body The JSON body.
   * @returns The answer.
   */
  async function post(target: Hono<ServerEnv>, path: string, body: unknown): Promise<Answer> {
    const response = await target.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    };
  }

  /**
   * Asserts the one refusal the check answers: `400 FS_UNSAFE_PATH` in its
   * constant words, naming no path — in the reply or in the service log.
   *
   * @param answer The answer.
   */
  function expectStateHomeRefusal(answer: Answer): void {
    expect(answer.status).toBe(400);
    expect(answer.cacheControl).toBe('no-store');
    expect(answer.body).toEqual({ code: 'FS_UNSAFE_PATH', message: STATE_HOME_OVERLAP_MESSAGE });
    expect(JSON.stringify(answer.body)).not.toContain(sandbox);
    expect(JSON.stringify(logs)).not.toContain(sandbox);
  }

  it('refuses a new session whose project contains the state root, before the fence and the manager', async () => {
    const project = folder(join(sandbox, 'shop'));
    const harness = stateHomeHarness(folder(join(project, 'debuggen-state')));
    principal = editor([project]);

    const answer = await post(harness.app, '/sessions', {
      projectRoot: project,
      question: 'Why is handlerAlpha slow?',
    });

    expectStateHomeRefusal(answer);
    expect(harness.liveCredential).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('refuses a project inside the state root, the state root itself, and one not created yet', async () => {
    const home = folder(join(sandbox, 'home'));
    const harness = stateHomeHarness(home);
    principal = editor([sandbox]);

    for (const projectRoot of [
      folder(join(home, 'project')),
      home,
      join(home, 'not-yet', 'created'),
    ]) {
      expectStateHomeRefusal(
        await post(harness.app, '/sessions', { projectRoot, question: 'Why is it slow?' }),
      );
    }
    expect(harness.liveCredential).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('refuses a project reached through a symbolic link that resolves into the state root', async () => {
    const home = folder(join(sandbox, 'home'));
    const link = join(sandbox, 'linked-project');
    symlinkSync(folder(join(home, 'project')), link);
    const harness = stateHomeHarness(home);
    principal = editor([sandbox]);

    expectStateHomeRefusal(
      await post(harness.app, '/sessions', { projectRoot: link, question: 'Why is it slow?' }),
    );
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('admits a sibling whose name merely extends the state root, and one that does not exist yet', async () => {
    const harness = stateHomeHarness(folder(join(sandbox, 'shop-state')));
    const sibling = folder(join(sandbox, 'shop'));
    const absent = join(sandbox, 'shop-next');
    principal = editor([sandbox]);

    for (const projectRoot of [sibling, absent]) {
      const answer = await post(harness.app, '/sessions', {
        projectRoot,
        question: 'Why is handlerAlpha slow?',
      });
      // Past the check, the fence and the manager are reached; the harness's
      // manager then refuses to store the session.
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ code: 'SESSION_INVALID_STATE' });
    }
    expect(harness.liveCredential).toHaveBeenCalledTimes(2);
    expect(harness.create.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ projectRoot: sibling }),
      expect.objectContaining({ projectRoot: absent }),
    ]);
  });

  it('refuses a follow-up on a stored session whose project overlaps the state root', async () => {
    const project = folder(join(sandbox, 'shop'));
    const harness = stateHomeHarness(folder(join(project, '.debuggen')));
    const overlapping = seed({ projectRoot: project, updatedAt: BASE_TIME + 1 });
    principal = editor([project]);

    expectStateHomeRefusal(
      await post(harness.app, `/sessions/${overlapping}/question`, {
        question: 'And the second render?',
      }),
    );
    expect(harness.liveCredential).not.toHaveBeenCalled();
    expect(harness.followUp).not.toHaveBeenCalled();
  });

  it('lets a follow-up on a project apart from the state root reach the orchestrator', async () => {
    const project = folder(join(sandbox, 'shop'));
    const harness = stateHomeHarness(folder(join(sandbox, 'shop-state')));
    const apart = seed({ projectRoot: project, updatedAt: BASE_TIME + 1 });
    principal = editor([project]);

    const answer = await post(harness.app, `/sessions/${apart}/question`, {
      question: 'And the second render?',
    });

    expect(answer.status).toBe(409);
    expect(harness.liveCredential).toHaveBeenCalledTimes(1);
    expect(harness.followUp).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * POST /sessions/purge sweeps only the requesting editor's workspace
 * ---------------------------------------------------------------------------------------------- */

describe("POST /sessions/purge sweeps only the requesting editor's workspace", () => {
  /** The header the stand-in middleware reads the editor's announced folders from, as JSON. */
  const WORKSPACE_HEADER = 'x-test-workspace';

  /** A sweep report whose `sessionsDeleted` tells two sweeps apart. */
  function reportOf(sessionsDeleted: number): RetentionReport {
    return {
      cutoff: BASE_TIME,
      sessionsDeleted,
      sessionIdsDeleted: [],
      telemetryEventsDeleted: 0,
      panelsDeleted: 0,
      analysesDeleted: 0,
      modificationsDeleted: 0,
      backupDirsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
      bytesReclaimed: 0,
      durationMs: 1,
      errors: [],
      omitted: {
        sessionIdsDeleted: 0,
        sessionsRetainedForConflicts: 0,
        sessionsRetainedActive: 0,
        errors: 0,
      },
    };
  }

  /** A sweep the test finishes when it chooses. */
  interface PendingSweep {
    readonly promise: Promise<Result<RetentionReport, DebuggenError>>;
    finish(report: RetentionReport): void;
  }

  function pendingSweep(): PendingSweep {
    let finish: (report: RetentionReport) => void = unused;
    const promise = new Promise<Result<RetentionReport, DebuggenError>>((resolve) => {
      finish = (report) => {
        resolve(ok(report));
      };
    });
    return { promise, finish: (report) => finish(report) };
  }

  /**
   * `POST /sessions/purge` over `purge`, behind a stand-in middleware that
   * resolves an editor announcing the folders of {@link WORKSPACE_HEADER} —
   * one principal per request, so concurrent requests may differ. The
   * revocation fence admits every request unless `requireLiveCredential` says
   * otherwise.
   */
  function purgeApp(
    purge: Mock<SessionRoutesDeps['retention']['purge']>,
    requireLiveCredential: SessionRoutesDeps['auth']['requireLiveCredential'] = () => ok(undefined),
  ): Hono<ServerEnv> {
    const routes: SessionRoutes = createSessionRoutes({
      manager: {
        create: unused,
        get: unused,
        list: unused,
        end: unused,
        fail: unused,
        patch: unused,
      },
      reopener: { reopen: unused },
      orchestrator: {
        run: unused,
        beginCapture: unused,
        completeCapture: unused,
        followUp: unused,
        cancel: unused,
        activeRun: unused,
        releaseSession: unused,
      },
      sessions: {
        getActiveCapture: unused,
        getCapture: unused,
        listWithinFolders: unused,
        getAccessTarget: unused,
      },
      panels: { getLatestPanel: unused, getPanel: unused },
      modifications,
      bindings: { bindingForSession: () => undefined, sendToBoundTab: unused },
      retention: { purge },
      auth: { requireLiveCredential },
      logger: createCapturingLogger(logs),
    });
    const target = new Hono<ServerEnv>();
    target.use('*', async (c, next) => {
      const folders = c.req.header(WORKSPACE_HEADER);
      if (folders !== undefined) {
        c.set('principal', editor(JSON.parse(folders) as string[]));
      }
      await next();
    });
    target.post(HTTP_ROUTES['session.purge'].pattern, routes['session.purge']);
    return target;
  }

  /** Sends one purge as an editor announcing `folders`, and parses the reply. */
  async function purgeAs(
    target: Hono<ServerEnv>,
    folders: readonly string[],
  ): Promise<{ readonly status: number; readonly sessionsDeleted: unknown }> {
    const response = await target.request(HTTP_ROUTES['session.purge'].pattern, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKSPACE_HEADER]: JSON.stringify(folders) },
      body: '{}',
    });
    const body = (await response.json()) as { readonly sessionsDeleted?: unknown };
    return { status: response.status, sessionsDeleted: body.sessionsDeleted };
  }

  /** The `joinedRunningSweep` of every purge the handler logged, in order. */
  function joinedFlags(): unknown[] {
    return logs
      .filter((entry) => entry.message === 'Ran the retention sweep on request')
      .map((entry) => entry.fields['joinedRunningSweep']);
  }

  it("hands the sweep a scope of exactly the editor's announced folders", async () => {
    const purge = vi.fn<SessionRoutesDeps['retention']['purge']>(() =>
      Promise.resolve(ok(reportOf(3))),
    );
    const target = purgeApp(purge);

    const answer = await purgeAs(target, ['/w/a', '/w/c']);

    expect(answer).toEqual({ status: 200, sessionsDeleted: 3 });
    expect(purge).toHaveBeenCalledTimes(1);
    const scope = purge.mock.calls[0]?.[0];
    expect(scope).toBeTypeOf('function');
    // None of these exists, so each resolves through `/` to itself and the
    // canonical check agrees with the lexical one.
    expect(
      await Promise.all(
        ['/w/a', '/w/a/b', '/w/c/d', '/w/ab', '/w', '/x/a'].map((root) =>
          Promise.resolve(scope?.(root)),
        ),
      ),
    ).toEqual([true, true, true, false, false, false]);
  });

  it('never hands one workspace a sweep started for another, and joins only a sweep of the same folders', async () => {
    const sweeps: PendingSweep[] = [];
    const purge = vi.fn<SessionRoutesDeps['retention']['purge']>(() => {
      const sweep = pendingSweep();
      sweeps.push(sweep);
      return sweep.promise;
    });
    const target = purgeApp(purge);

    const forA = purgeAs(target, ['/w/a']);
    await vi.waitFor(() => {
      expect(purge).toHaveBeenCalledTimes(1);
    });
    const forB = purgeAs(target, ['/w/b']);
    // The same folder set, spelled differently: it shares A's sweep.
    const forAAgain = purgeAs(target, ['/w/a/']);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // B's sweep waits for A's instead of running beside it or joining it.
    expect(purge).toHaveBeenCalledTimes(1);
    sweeps[0]?.finish(reportOf(1));
    expect(await forA).toEqual({ status: 200, sessionsDeleted: 1 });
    expect(await forAAgain).toEqual({ status: 200, sessionsDeleted: 1 });

    await vi.waitFor(() => {
      expect(purge).toHaveBeenCalledTimes(2);
    });
    const scopeB = purge.mock.calls[1]?.[0];
    expect(await scopeB?.('/w/b/x')).toBe(true);
    expect(await scopeB?.('/w/a')).toBe(false);
    sweeps[1]?.finish(reportOf(2));
    expect(await forB).toEqual({ status: 200, sessionsDeleted: 2 });

    expect(joinedFlags().sort()).toEqual([false, false, true]);

    // Once settled, a later purge of A starts a sweep of its own.
    const later = purgeAs(target, ['/w/a']);
    await vi.waitFor(() => {
      expect(purge).toHaveBeenCalledTimes(3);
    });
    sweeps[2]?.finish(reportOf(4));
    expect(await later).toEqual({ status: 200, sessionsDeleted: 4 });
  });

  it('runs no sweep for a credential retired while the workspace folders resolved', async () => {
    const purge = vi.fn<SessionRoutesDeps['retention']['purge']>(() =>
      Promise.resolve(ok(reportOf(1))),
    );
    // Live at the first fence, retired by the second: the rotation landed
    // while the purge was canonicalising the editor's folders.
    const liveCredential = vi
      .fn<SessionRoutesDeps['auth']['requireLiveCredential']>()
      .mockReturnValueOnce(ok(undefined))
      .mockReturnValue(
        err(
          new DebuggenError('UNAUTHORIZED', AUTH_FAILURE_REASONS['unknown-credential'].message, {
            details: { reason: 'unknown-credential' },
          }),
        ),
      );

    const answer = await purgeAs(purgeApp(purge, liveCredential), ['/w/a']);

    expect(answer.status).toBe(401);
    expect(liveCredential).toHaveBeenCalledTimes(2);
    expect(purge).not.toHaveBeenCalled();
    expect(joinedFlags()).toEqual([]);
  });

  describe('the scope resolves every folder and root to its canonical location', () => {
    /** The realpath'd sandbox of the running test; every folder below lives in it. */
    let sandbox: string;

    beforeEach(() => {
      sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-purge-scope-')));
    });

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true });
      expect(existsSync(sandbox)).toBe(false);
    });

    /**
     * Creates `path` (and its parents) and returns it.
     *
     * @param path The absolute directory.
     * @returns `path`.
     */
    function folder(path: string): string {
      mkdirSync(path, { recursive: true });
      return path;
    }

    /**
     * Plants a symbolic link at `path` that names itself, so resolving it — or
     * anything beneath it — fails with `ELOOP`.
     *
     * @param path The link's absolute path.
     * @returns `path`.
     */
    function loop(path: string): string {
      symlinkSync(path, path);
      return path;
    }

    /**
     * Sends one purge as an editor announcing `folders` and returns the scope
     * the handler handed its sweep.
     *
     * @param folders The announced workspace folders.
     * @returns The scope.
     */
    async function scopeFor(folders: readonly string[]): Promise<RetentionScope> {
      const purge = vi.fn<SessionRoutesDeps['retention']['purge']>(() =>
        Promise.resolve(ok(reportOf(0))),
      );
      expect(await purgeAs(purgeApp(purge), folders)).toEqual({ status: 200, sessionsDeleted: 0 });
      const scope = purge.mock.calls[0]?.[0];
      if (scope === undefined) {
        throw new Error('The purge handed its sweep no scope.');
      }
      return scope;
    }

    it('refuses a root inside the workspace whose symbolic link resolves outside it', async () => {
      const workspace = folder(join(sandbox, 'a'));
      const elsewhere = folder(join(sandbox, 'b', 'app'));
      const linkOut = join(workspace, 'link-to-b');
      symlinkSync(elsewhere, linkOut);
      const scope = await scopeFor([workspace]);

      expect(await scope(linkOut)).toBe(false);
      expect(await scope(join(linkOut, 'packages', 'web'))).toBe(false);
      // What the link points at is outside the announced folder in its own right.
      expect(await scope(elsewhere)).toBe(false);
    });

    it('refuses a root whose canonical location cannot be established', async () => {
      const workspace = folder(join(sandbox, 'a'));
      const looped = loop(join(workspace, 'looped'));
      const scope = await scopeFor([workspace]);

      expect(await scope(looped)).toBe(false);
      expect(await scope(join(looped, 'app'))).toBe(false);
    });

    it('admits a real root in the workspace, one no longer on disk, and one under a linked folder', async () => {
      const workspace = folder(join(sandbox, 'a'));
      const project = folder(join(workspace, 'app'));
      const realWorkspace = folder(join(sandbox, 'real-c'));
      const linkedWorkspace = join(sandbox, 'c');
      symlinkSync(realWorkspace, linkedWorkspace);
      folder(join(realWorkspace, 'app'));
      const scope = await scopeFor([workspace, linkedWorkspace]);

      expect(await scope(workspace)).toBe(true);
      expect(await scope(project)).toBe(true);
      // A project deleted since its session aged is judged by its nearest existing ancestor.
      expect(await scope(join(workspace, 'deleted-project'))).toBe(true);
      // The folder was announced through a link; the root, spelled the same way, lives under it.
      expect(await scope(join(linkedWorkspace, 'app'))).toBe(true);
      // A sibling that merely extends the folder's name is not inside it.
      expect(await scope(folder(join(sandbox, 'a-sibling')))).toBe(false);
    });

    it('lets a workspace folder that cannot be resolved admit nothing, and logs only a count', async () => {
      const unresolvable = loop(join(sandbox, 'looped-workspace'));
      const workspace = folder(join(sandbox, 'a'));
      const scope = await scopeFor([unresolvable, workspace]);
      // The folder is repaired after the scope was built: the purge resolved
      // its folders once, and this one could not be resolved then.
      rmSync(unresolvable);
      const repaired = folder(join(unresolvable, 'app'));

      expect(await scope(repaired)).toBe(false);
      expect(await scope(unresolvable)).toBe(false);
      // The folder beside it is unaffected.
      expect(await scope(folder(join(workspace, 'app')))).toBe(true);

      const warnings = logs.filter((entry) =>
        entry.message.startsWith('Workspace folders could not be resolved on disk'),
      );
      expect(warnings.map((entry) => entry.fields['unresolvedFolders'])).toEqual([1]);
      expect(JSON.stringify(logs)).not.toContain(sandbox);
    });

    it('admits nothing when no announced folder can be resolved', async () => {
      const unresolvable = loop(join(sandbox, 'looped-workspace'));
      const scope = await scopeFor([unresolvable]);
      rmSync(unresolvable);

      expect(await scope(folder(join(unresolvable, 'app')))).toBe(false);
    });
  });
});
