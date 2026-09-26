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
 * Fixtures are neutral (`/w/…`, `src/moduleN.ts`); no environment variable is
 * read and nothing under `$DEBUGGEN_HOME` is touched.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { newSessionId, unwrap } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';

import { openStore } from '../../store/db.js';
import type { Store } from '../../store/db.js';
import { createModificationsRepo } from '../../store/modifications-repo.js';
import type { ModificationsRepo } from '../../store/modifications-repo.js';
import { createSessionsRepo } from '../../store/sessions-repo.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import type {
  DevtoolsPrincipal,
  EditorPrincipal,
  Principal,
  ServerEnv,
  TabBinding,
} from '../auth.js';
import { createSessionRoutes } from './sessions.js';
import type { SessionRoutes } from './sessions.js';

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
