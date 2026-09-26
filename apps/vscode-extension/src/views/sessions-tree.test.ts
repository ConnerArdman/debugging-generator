/**
 * Tests for `./sessions-tree.ts`: how the Sessions tree walks every page of
 * `GET /sessions` into the store and renders the result (AAP §0.7.3: the tree
 * lists past sessions, and selecting one reopens it).
 *
 * The provider is driven against the real `ExtensionState` — the one store the
 * tree writes the gathered rows into and renders from — and a substituted
 * `listSessions` that serves protocol-valid pages from an in-memory listing,
 * so every case follows the production path
 * `getChildren → listSessions × pages → setSessionList → render`. The cases pin:
 *
 * - every stored session is listed and carries its reopen command, however many
 *   pages the listing spans, and the pages requested are exactly
 *   `{ limit: 500, offset: 0 | 500 | 1000 | … }`;
 * - a row two pages both carry is stored once, as the earlier page served it;
 * - a later page's failure keeps the rows gathered, renders the failure row
 *   and the "not listed" row, logs by code only, and is retried;
 * - a first page's failure writes nothing, as before;
 * - the page cap stops the walk and the "not listed" row says so;
 * - disposal mid-walk aborts the request in flight and writes nothing;
 * - concurrent renders share one walk, and a refresh during a walk queues
 *   exactly one follow-up walk;
 * - a complete listing renders no "not listed" row, and an empty listing still
 *   renders the empty state;
 * - the cleanup wording reads the row's `conflictCount`;
 * - a `session.updated` record of a listed session reaches the tree as its
 *   list row, never as the whole record.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable package
 * provides it, so `vi.mock` registers a factory for the bare specifier. It
 * carries what the provider and the store reach: `EventEmitter`, `TreeItem`,
 * `TreeItemCollapsibleState`, `ThemeIcon`, `ThemeColor`, `Disposable` and
 * `window.registerTreeDataProvider`.
 */

import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  SESSION_LIST_MAX_LIMIT,
  sessionListResponseSchema,
  toSessionListItem,
} from '@debuggen/protocol';
import type {
  ListPageRequest,
  SessionListItem,
  SessionListResponse,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger } from '@debuggen/shared';

import { ExtensionState } from '../state';

import {
  RETRY_INTERVAL_MS,
  SESSION_LIST_PAGE_CAP,
  SessionsTreeProvider,
  describeSession,
  type MessageNode,
  type ProjectNode,
  type SessionNode,
  type SessionsTreeClient,
  type SessionsTreeNode,
} from './sessions-tree';

vi.mock('vscode', () => {
  /** The `vscode.EventEmitter` surface, delivered synchronously. */
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  /** A tree row: the label and collapsible state, plus the members the provider assigns. */
  class TreeItem {
    id?: string;
    description?: string;
    tooltip?: string;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;

    constructor(
      readonly label: string,
      readonly collapsibleState: number,
    ) {}
  }

  class ThemeIcon {
    constructor(
      readonly id: string,
      readonly color?: unknown,
    ) {}
  }

  class ThemeColor {
    constructor(readonly id: string) {}
  }

  class Disposable {
    constructor(private readonly release: () => void) {}

    static from(...disposables: { dispose(): unknown }[]): Disposable {
      return new Disposable(() => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      });
    }

    dispose(): void {
      this.release();
    }
  }

  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    Disposable,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      registerTreeDataProvider: () => new Disposable(() => undefined),
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The developer's workspace folder: absolute, POSIX, on their own machine. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A project-relative source path. */
const SOURCE_FILE = 'src/lib/thing.ts';

/** A base timestamp: every fixture is created on the same local day. */
const CREATED_AT = 1_758_000_000_000;

/**
 * A 64-character lowercase hexadecimal digest from a repeating seed: it only has
 * to look like a SHA-256, and a low-entropy value keeps `check:secrets` quiet.
 */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

/** A session id of the service's shape, low-entropy and distinct per letter. */
function sessionId(letter: string): string {
  return `ses_${letter.repeat(16)}`;
}

/** A list row as `GET /sessions` sends it. */
function row(letter: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: sessionId(letter),
    projectRoot: PROJECT_ROOT,
    projectName: 'site',
    status: 'generated',
    question: `Why does step ${letter} take so long?`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 60_000,
    cleanup: { status: 'clean', completedAt: CREATED_AT + 59_000, conflictCount: 0 },
    ...overrides,
  };
}

/** A second workspace, so a large listing groups into more than one project. */
const OTHER_PROJECT_ROOT = '/home/example/workspace/admin';

/** One hour, in milliseconds: numbered sessions are created an hour apart. */
const HOUR_MS = 3_600_000;

/**
 * Stored session number `index` of a large listing, as `GET /sessions` sends
 * its row. Index `0` is the most recently updated, matching the service's
 * `updatedAt`-descending order; sessions alternate between two projects and
 * are created an hour apart, so they span many day rows.
 */
function numberedRow(index: number): SessionListItem {
  const createdAt = CREATED_AT - index * HOUR_MS;
  const inOtherProject = index % 2 === 1;
  return {
    id: `ses_${String(index).padStart(16, '0')}`,
    projectRoot: inOtherProject ? OTHER_PROJECT_ROOT : PROJECT_ROOT,
    projectName: inOtherProject ? 'admin' : 'site',
    status: 'generated',
    question: `Why does request ${String(index)} take so long?`,
    createdAt,
    updatedAt: createdAt + 60_000,
    cleanup: { status: 'clean', completedAt: createdAt + 59_000, conflictCount: 0 },
  };
}

/** `count` numbered rows, most recently updated first. */
function numberedRows(count: number): SessionListItem[] {
  return Array.from({ length: count }, (_, index) => numberedRow(index));
}

/**
 * The page the service answers for `window` over `listing`: the window's slice,
 * the listing's size as `total`, and `nextOffset` just past the window while
 * rows remain. Parsed with the protocol's own `sessionListResponseSchema`, so a
 * fixture that breaks the paging rules fails the case instead of passing it.
 */
function pageOf(
  listing: readonly SessionListItem[],
  window: ListPageRequest | undefined,
): SessionListResponse {
  const limit = window?.limit ?? 100;
  const offset = window?.offset ?? 0;
  const end = offset + limit;
  return sessionListResponseSchema.parse({
    sessions: listing.slice(offset, end),
    total: listing.length,
    limit,
    offset,
    nextOffset: end < listing.length ? end : null,
  });
}

/** A `listSessions` that serves `listing` page by page, as the service would. */
function serving(listing: readonly SessionListItem[]): SessionsTreeClient['listSessions'] {
  return (window) => Promise.resolve(ok(pageOf(listing, window)));
}

/** A failed `listSessions` answer with `code`. */
function failed(code: DebuggenErrorCode, message: string, hint?: string) {
  return err(new DebuggenError(code, message, hint === undefined ? {} : { hint }));
}

/** A promise the case settles by hand. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A whole record of session `letter`, carrying a plan and a diff a row must never hold. */
function wholeRecord(letter: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = sessionId(letter);
  return {
    id,
    projectRoot: PROJECT_ROOT,
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 120_000,
    status: 'capturing',
    question: `Why does step ${letter} take so long?`,
    followUps: [],
    relevantFiles: [],
    plans: [
      {
        version: 1,
        planVersion: 1,
        sessionId: id,
        objective: 'Determine where the time is spent.',
        hypotheses: ['The server does the work.'],
        capture: ['server request spans'],
        instrumentationTargets: [],
      },
    ],
    modifications: [
      {
        id: 'mod_aaaaaaaaaaaaaaaa',
        sessionId: id,
        planVersion: 1,
        file: SOURCE_FILE,
        originalHash: hashFixture('1a'),
        backupPath: `/home/example/.debuggen/backups/${id}/${hashFixture('1a')}`,
        instrumentedHash: hashFixture('2b'),
        appliedAt: CREATED_AT + 500,
        status: 'applied',
        diff: '--- a/src/lib/thing.ts\n+++ b/src/lib/thing.ts\n',
      },
    ],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** A logger that records every call, so a case can read what was logged. */
function recordingLogger(): Logger & { readonly records: { level: string; fields?: LogFields }[] } {
  const records: { level: string; fields?: LogFields }[] = [];
  const at =
    (level: string) =>
    (_message: string, fields?: LogFields): void => {
      records.push(fields === undefined ? { level } : { level, fields });
    };
  const logger: Logger & { readonly records: typeof records } = {
    level: 'trace',
    records,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/** Everything a case needs: the provider, the real store and the client spy. */
interface Harness {
  readonly provider: SessionsTreeProvider;
  readonly state: ExtensionState;
  readonly listSessions: Mock<SessionsTreeClient['listSessions']>;
  readonly logger: ReturnType<typeof recordingLogger>;
}

const disposables: { dispose(): void }[] = [];

/**
 * A provider whose `GET /sessions` serves `listing` page by page, or answers
 * through `listing` itself when it is a `listSessions` implementation.
 *
 * @param listing The stored rows, or the client method to call.
 * @param now The provider's clock; defaults to a fixed instant.
 */
function harness(
  listing: readonly SessionListItem[] | SessionsTreeClient['listSessions'],
  now: () => number = () => CREATED_AT,
): Harness {
  const state = new ExtensionState({
    serviceUrl: 'http://127.0.0.1:43117',
    provider: 'deterministic',
  });
  const listSessions = vi.fn<SessionsTreeClient['listSessions']>(
    typeof listing === 'function' ? listing : serving(listing),
  );
  const logger = recordingLogger();
  const provider = new SessionsTreeProvider({
    state,
    client: { listSessions },
    logger,
    locale: 'en-US',
    now,
  });
  disposables.push(provider, state);
  return { provider, state, listSessions, logger };
}

/** The windows `listSessions` was asked for, in call order. */
function requestedWindows(
  listSessions: Mock<SessionsTreeClient['listSessions']>,
): (ListPageRequest | undefined)[] {
  return listSessions.mock.calls.map(([window]) => window);
}

/** The windows of a walk from offset `0` over `pages` pages of 500 rows. */
function walkWindows(pages: number): ListPageRequest[] {
  return Array.from({ length: pages }, (_, index) => ({
    limit: SESSION_LIST_MAX_LIMIT,
    offset: index * SESSION_LIST_MAX_LIMIT,
  }));
}

/** A tree item with the label the `vscode` substitute stores. */
type LabelledItem = vscode.TreeItem & { readonly label: string };

/** The root rows of `kind: 'message'`. */
function messages(nodes: readonly SessionsTreeNode[]): MessageNode[] {
  return nodes.filter((node): node is MessageNode => node.kind === 'message');
}

/** Every session row of the tree, walked from the root rows. */
async function sessionRows(
  provider: SessionsTreeProvider,
  roots: readonly SessionsTreeNode[],
): Promise<SessionNode[]> {
  const found: SessionNode[] = [];
  for (const project of roots.filter((node): node is ProjectNode => node.kind === 'project')) {
    for (const day of await provider.getChildren(project)) {
      for (const node of await provider.getChildren(day)) {
        if (node.kind === 'session') {
          found.push(node);
        }
      }
    }
  }
  return found;
}

afterEach(() => {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose();
  }
});

// ---------------------------------------------------------------------------
// Walking the listing
// ---------------------------------------------------------------------------

/** A root row's kind, or a message row's key, so a case can pin the root's shape. */
function kindOrKey(node: SessionsTreeNode): string {
  return node.kind === 'message' ? node.key : node.kind;
}

/** The row at `index`; a case that indexes past its fixture fails loudly. */
function rowAt(rows: readonly SessionListItem[], index: number): SessionListItem {
  const found = rows[index];
  if (found === undefined) {
    throw new Error(`the fixture holds no row at index ${String(index)}`);
  }
  return found;
}

/** The only log fields the tree may write: error codes and counts, never content. */
const LOGGABLE_FIELDS: ReadonlySet<string> = new Set(['code', 'pages', 'rows', 'total']);

describe('SessionsTreeProvider — every page of GET /sessions', () => {
  it('lists all 1 234 stored sessions across three pages, each one selectable', async () => {
    const listing = numberedRows(1_234);
    const { provider, state, listSessions, logger } = harness(listing);

    const roots = await provider.getChildren();

    expect(requestedWindows(listSessions)).toEqual([
      { limit: 500, offset: 0 },
      { limit: 500, offset: 500 },
      { limit: 500, offset: 1_000 },
    ]);
    for (const [, options] of listSessions.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(state.sessionList.map((listed) => listed.id)).toEqual(
      listing.map((listed) => listed.id),
    );
    expect(state.sessionListTotal).toBe(1_234);
    expect(roots.map(kindOrKey)).toEqual(['project', 'project']);

    const rows = await sessionRows(provider, roots);
    expect(rows).toHaveLength(1_234);
    expect(new Set(rows.map((node) => node.sessionId))).toEqual(
      new Set(listing.map((listed) => listed.id)),
    );
    for (const node of rows) {
      const item = provider.getTreeItem(node);
      expect(item.contextValue).toBe('debuggen.session');
      expect(item.command).toEqual({
        command: 'debuggen.reopenSession',
        title: 'Reopen Session',
        arguments: [node.sessionId],
      });
    }

    expect(logger.records).toContainEqual({
      level: 'debug',
      fields: { pages: 3, rows: 1_234, total: 1_234 },
    });
  });

  it('stores a row two pages both carry once, as the earlier page served it', async () => {
    const listing = numberedRows(1_234);
    const original = listing.map((listed) => listed.id);
    const firstPageLast = rowAt(listing, 499);
    let calls = 0;
    const { provider, state, listSessions } = harness((window) => {
      calls += 1;
      if (calls === 2) {
        // A session created between the first and the second request lands at
        // the front, so every older row moves down one place and the first
        // page's last row is served again at the top of the second page — here
        // with a different question, so the case can tell the two apart.
        listing.unshift({
          ...numberedRow(0),
          id: 'ses_createdbetweenpages',
          question: 'A session created between two page requests',
          createdAt: CREATED_AT + HOUR_MS,
          updatedAt: CREATED_AT + HOUR_MS + 60_000,
        });
        listing[500] = { ...firstPageLast, question: 'The same session, served a second time' };
      }
      return Promise.resolve(ok(pageOf(listing, window)));
    });

    const roots = await provider.getChildren();

    expect(requestedWindows(listSessions)).toEqual(walkWindows(3));
    expect(state.sessionList.map((listed) => listed.id)).toEqual(original);
    expect(new Set(state.sessionList.map((listed) => listed.id)).size).toBe(1_234);
    expect(state.sessionList.find((listed) => listed.id === firstPageLast.id)?.question).toBe(
      firstPageLast.question,
    );
    expect(state.sessionListTotal).toBe(1_235);
    // The walk reached the end of the listing, so nothing is reported as left out.
    expect(messages(roots)).toEqual([]);
  });

  it('keeps the rows gathered when a later page fails, shows the failure, and retries', async () => {
    const listing = numberedRows(1_234);
    let clock = CREATED_AT;
    let failSecondPage = true;
    const { provider, state, listSessions, logger } = harness(
      (window) => {
        if (window?.offset === 500 && failSecondPage) {
          failSecondPage = false;
          return Promise.resolve(
            failed(
              'TRANSPORT_DISCONNECTED',
              'The local service is not reachable',
              'Start it with Debug Generator: Start Local Service.',
            ),
          );
        }
        return Promise.resolve(ok(pageOf(listing, window)));
      },
      () => clock,
    );

    const roots = await provider.getChildren();

    expect(requestedWindows(listSessions)).toEqual(walkWindows(2));
    expect(state.sessionList.map((listed) => listed.id)).toEqual(
      listing.slice(0, 500).map((listed) => listed.id),
    );
    expect(state.sessionListTotal).toBe(1_234);
    expect(roots.map(kindOrKey)).toEqual([
      'service-unreachable',
      'project',
      'project',
      'sessions-not-listed',
    ]);
    expect(await sessionRows(provider, roots)).toHaveLength(500);

    const failure = provider.getTreeItem(roots.at(0) as MessageNode);
    expect(failure.command).toEqual({
      command: 'debuggen.startService',
      title: 'Start Local Service',
    });
    expect(failure.tooltip).toBe(
      'The local service is not reachable\nStart it with Debug Generator: Start Local Service.',
    );
    const notListed = provider.getTreeItem(roots.at(-1) as MessageNode) as LabelledItem;
    expect(notListed.label).toBe('734 more sessions not listed');
    expect(notListed.description).toBe('500 of 1234 shown');
    expect(notListed.tooltip).toBe(
      'The local service holds 1234 stored sessions for this workspace. ' +
        'A later page of the listing could not be loaded, so this view lists only the 500 most recently updated; ' +
        'the other 734 are not listed until the listing loads again.',
    );
    expect(notListed.command).toBeUndefined();

    expect(logger.records).toContainEqual({
      level: 'warn',
      fields: { code: 'TRANSPORT_DISCONNECTED' },
    });
    expect(logger.records).toContainEqual({
      level: 'debug',
      fields: { pages: 1, rows: 500, total: 1_234 },
    });
    const loggedKeys = logger.records.flatMap((record) => Object.keys(record.fields ?? {}));
    expect(loggedKeys.filter((key) => !LOGGABLE_FIELDS.has(key))).toEqual([]);

    // Within the retry interval a render requests nothing.
    await provider.getChildren();
    expect(listSessions).toHaveBeenCalledTimes(2);

    // After it, the next render walks the whole listing again from offset 0.
    clock += RETRY_INTERVAL_MS;
    const retried = await provider.getChildren();

    expect(requestedWindows(listSessions).slice(2)).toEqual(walkWindows(3));
    expect(state.sessionList).toHaveLength(1_234);
    expect(retried.map(kindOrKey)).toEqual(['project', 'project']);
  });

  it('uses the singular when a later page failure leaves one session out', async () => {
    const listing = numberedRows(501);
    const { provider } = harness((window) =>
      Promise.resolve(
        window?.offset === 500
          ? failed('INTERNAL', 'The session listing could not be read')
          : ok(pageOf(listing, window)),
      ),
    );

    const roots = await provider.getChildren();

    expect(roots.map(kindOrKey)).toEqual([
      'load-failed',
      'project',
      'project',
      'sessions-not-listed',
    ]);
    const notListed = provider.getTreeItem(roots.at(-1) as MessageNode) as LabelledItem;
    expect(notListed.label).toBe('1 more session not listed');
    expect(notListed.description).toBe('500 of 501 shown');
    expect(notListed.tooltip).toContain(
      'the other one is not listed until the listing loads again.',
    );
  });

  it('writes nothing when the first page fails and renders the failure row alone', async () => {
    const { provider, state, listSessions, logger } = harness(() =>
      Promise.resolve(failed('TRANSPORT_DISCONNECTED', 'The local service is not reachable')),
    );

    const roots = await provider.getChildren();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(state.sessionList).toEqual([]);
    expect(state.sessionListTotal).toBe(0);
    expect(roots.map(kindOrKey)).toEqual(['service-unreachable']);
    expect(logger.records).toEqual([{ level: 'warn', fields: { code: 'TRANSPORT_DISCONNECTED' } }]);
  });

  it('keeps the listed rows beneath the failure row when a later load fails on its first page', async () => {
    const listing = numberedRows(3);
    let down = false;
    const { provider, state, listSessions } = harness((window) =>
      Promise.resolve(
        down
          ? failed('TRANSPORT_DISCONNECTED', 'The local service is not reachable')
          : ok(pageOf(listing, window)),
      ),
    );
    await provider.getChildren();

    down = true;
    await provider.refresh();
    const roots = await provider.getChildren();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(state.sessionList).toHaveLength(3);
    expect(state.sessionListTotal).toBe(3);
    expect(roots.map(kindOrKey)).toEqual(['service-unreachable', 'project', 'project']);
  });

  it('stops at the page cap and says how many older sessions it leaves out, and why', async () => {
    const capacity = SESSION_LIST_PAGE_CAP * SESSION_LIST_MAX_LIMIT;
    const listing = numberedRows(capacity + 250);
    const { provider, state, listSessions, logger } = harness(listing);

    const roots = await provider.getChildren();

    expect(SESSION_LIST_PAGE_CAP).toBe(20);
    expect(requestedWindows(listSessions)).toEqual(walkWindows(20));
    expect(state.sessionList).toHaveLength(10_000);
    expect(state.sessionList.at(-1)?.id).toBe(rowAt(listing, 9_999).id);
    expect(state.sessionListTotal).toBe(10_250);
    expect(messages(roots).map((node) => node.key)).toEqual(['sessions-not-listed']);

    const item = provider.getTreeItem(roots.at(-1) as MessageNode) as LabelledItem;
    expect(item.label).toBe('250 more sessions not listed');
    expect(item.description).toBe('10000 of 10250 shown');
    expect(item.tooltip).toBe(
      'The local service holds 10250 stored sessions for this workspace. ' +
        'This view lists at most 10000 sessions per load (20 pages of 500), the most recently updated first; ' +
        'the other 250 are not listed here.',
    );
    expect(item.command).toBeUndefined();
    expect(item.id).toBe('message:sessions-not-listed');

    expect(logger.records).toContainEqual({
      level: 'debug',
      fields: { pages: 20, rows: 10_000, total: 10_250 },
    });
  });

  it('renders no "not listed" row when the last page the cap allows ends the listing', async () => {
    const listing = numberedRows(SESSION_LIST_PAGE_CAP * SESSION_LIST_MAX_LIMIT);
    const { provider, state, listSessions } = harness(listing);

    const roots = await provider.getChildren();

    expect(requestedWindows(listSessions)).toEqual(walkWindows(20));
    expect(state.sessionList).toHaveLength(10_000);
    expect(messages(roots)).toEqual([]);
  });

  it('aborts the walk on dispose: the request in flight is cancelled and nothing is written', async () => {
    const listing = numberedRows(1_234);
    const secondPage = deferred<Awaited<ReturnType<SessionsTreeClient['listSessions']>>>();
    const { provider, state, listSessions } = harness((window) =>
      window?.offset === 500 ? secondPage.promise : Promise.resolve(ok(pageOf(listing, window))),
    );

    const rendering = provider.getChildren();
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledTimes(2);
    });
    const signal = listSessions.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    provider.dispose();

    expect(signal?.aborted).toBe(true);
    // Even a successful answer that arrives after disposal is written nowhere.
    secondPage.resolve(ok(pageOf(listing, { limit: 500, offset: 500 })));
    expect(await rendering).toEqual([]);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(state.sessionList).toEqual([]);
    expect(state.sessionListTotal).toBe(0);
  });

  it('shares one walk between concurrent renders, and a refresh during it queues exactly one more', async () => {
    const listing = numberedRows(1_234);
    const gate = deferred<undefined>();
    let calls = 0;
    const { provider, state, listSessions } = harness(async (window) => {
      calls += 1;
      if (calls === 2) {
        await gate.promise;
      }
      return ok(pageOf(listing, window));
    });

    const renders = [provider.getChildren(), provider.getChildren()];
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    const refreshes = [provider.refresh(), provider.refresh()];
    gate.resolve(undefined);
    await Promise.all([...renders, ...refreshes]);

    expect(requestedWindows(listSessions)).toEqual([...walkWindows(3), ...walkWindows(3)]);
    expect(state.sessionList).toHaveLength(1_234);
  });

  it('renders no "not listed" row when the listing fits one page', async () => {
    const { provider, state, listSessions } = harness([row('a'), row('b')]);

    const roots = await provider.getChildren();

    expect(requestedWindows(listSessions)).toEqual(walkWindows(1));
    expect(state.sessionListTotal).toBe(2);
    expect(roots.map((node) => node.kind)).toEqual(['project']);
  });

  it('still renders the empty state for an empty listing', async () => {
    const { provider } = harness([]);

    const roots = await provider.getChildren();

    expect(messages(roots).map((node) => node.key)).toEqual(['empty']);
  });
});

// ---------------------------------------------------------------------------
// Row content
// ---------------------------------------------------------------------------

describe('describeSession — the cleanup line reads conflictCount', () => {
  it('counts the conflicting files a cleanup kept', () => {
    const text = describeSession(
      row('a', { cleanup: { status: 'conflict', completedAt: CREATED_AT, conflictCount: 2 } }),
      { locale: 'en-US' },
    );

    expect(text.split('\n').at(-1)).toBe('Cleanup: conflict (2 conflicting files kept)');
  });

  it('uses the singular for one conflicting file', () => {
    const text = describeSession(
      row('a', { cleanup: { status: 'partial', completedAt: CREATED_AT, conflictCount: 1 } }),
      { locale: 'en-US' },
    );

    expect(text.split('\n').at(-1)).toBe('Cleanup: partial (1 conflicting file kept)');
  });

  it('names the status alone when no conflict was kept, and omits a clean cleanup', () => {
    const pending = describeSession(
      row('a', { cleanup: { status: 'pending', conflictCount: 0 } }),
      { locale: 'en-US' },
    );
    const clean = describeSession(row('a'), { locale: 'en-US' });

    expect(pending.split('\n').at(-1)).toBe('Cleanup: pending');
    expect(clean).not.toContain('Cleanup:');
  });
});

describe('SessionsTreeProvider — a pushed record reaches the tree as its row', () => {
  it('renders the refreshed status from the projection, never the whole record', async () => {
    const { provider, state } = harness([row('a', { status: 'ready' })]);
    await provider.getChildren();

    const record = wholeRecord('a');
    state.applySessionRecord(record);
    const [session] = await sessionRows(provider, await provider.getChildren());

    expect(session?.session).toEqual(toSessionListItem(record));
    expect(session?.session).not.toHaveProperty('plans');
    expect(session?.session).not.toHaveProperty('modifications');
    const item = provider.getTreeItem(session as SessionNode);
    expect(item.description).toBe('capturing');
    expect(item.command).toEqual({
      command: 'debuggen.reopenSession',
      title: 'Reopen Session',
      arguments: [sessionId('a')],
    });
  });
});
