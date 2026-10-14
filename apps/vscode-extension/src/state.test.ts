/**
 * Tests for `./state.ts`: the Sessions list half of `ExtensionState`.
 *
 * The store holds exactly one whole session record — the session in view — and
 * list rows (`SessionListItem`) for every session the Sessions tree lists. These
 * cases pin that split down where it is easiest to lose:
 *
 * - `setSessionList` keeps the page's rows and the listing's `total`, and never
 *   lets `total` fall below the rows it lists;
 * - a `session.updated` record of a listed session replaces that session's row
 *   with the protocol's `toSessionListItem` projection — no plan, modification,
 *   analysis or conflict diff reaches the list — whether or not the record is
 *   of the session in view, which only `adoptSession` makes active;
 * - a record older than the listed row, a record whose row is unchanged, and a
 *   record of a session the list does not hold change nothing and notify
 *   nothing;
 * - the caller's record is neither frozen nor retained by the list.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable package
 * provides it, so `vi.mock` registers a factory for the bare specifier. The
 * store reaches only `vscode.EventEmitter`, substituted by a synchronous
 * emitter with the same `event` / `fire` / `dispose` surface.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toSessionListItem } from '@debuggen/protocol';
import type { SessionListItem, SessionRecord } from '@debuggen/protocol';

import { ExtensionState } from './state';

vi.mock('vscode', () => {
  /** The `vscode.EventEmitter` surface the store uses, delivered synchronously. */
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

  return { EventEmitter };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The session the list holds and a record of it later refreshes. */
const LISTED_ID = 'ses_aaaaaaaaaaaaaaaa';

/** A second listed session, used as the session in view. */
const ACTIVE_ID = 'ses_bbbbbbbbbbbbbbbb';

/** A session the list does not hold. */
const UNLISTED_ID = 'ses_cccccccccccccccc';

/** The developer's workspace folder: absolute, POSIX, on their own machine. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A project-relative source path. */
const SOURCE_FILE = 'src/lib/thing.ts';

/** When the listed row was last updated. */
const LISTED_UPDATED_AT = 1_758_000_060_000;

/** The service base URL the store is configured with, which owns every adopted session. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** The members a list row carries, and nothing else. */
const LIST_ROW_KEYS = [
  'cleanup',
  'createdAt',
  'id',
  'projectName',
  'projectRoot',
  'question',
  'status',
  'updatedAt',
];

/**
 * A 64-character lowercase hexadecimal digest from a repeating seed: it only has
 * to look like a SHA-256, and a low-entropy value keeps `check:secrets` quiet.
 */
function hashFixture(seed: string): string {
  return seed.repeat(32).slice(0, 64);
}

/**
 * A whole session record with the heavy collections a list must never retain:
 * a plan, a modification with its diff, a conflict with its three-way diff.
 */
function sessionRecord(
  id: string,
  overrides: Partial<Omit<SessionRecord, 'id'>> = {},
): SessionRecord {
  return {
    id,
    projectRoot: PROJECT_ROOT,
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    createdAt: 1_758_000_000_000,
    updatedAt: LISTED_UPDATED_AT,
    status: 'generated',
    question: 'Why does the orders list render twice?',
    followUps: [],
    relevantFiles: [{ file: SOURCE_FILE, reason: 'Renders the orders list.', score: 0.9 }],
    plans: [
      {
        version: 1,
        planVersion: 1,
        sessionId: id,
        objective: 'Determine why the list renders twice.',
        hypotheses: ['A parent re-renders with a new prop identity.'],
        capture: ['react renders'],
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
        appliedAt: 1_758_000_000_500,
        status: 'conflict',
        diff: '--- a/src/lib/thing.ts\n+++ b/src/lib/thing.ts\n@@ -1 +1 @@\n-a\n+b\n',
      },
    ],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: {
      status: 'conflict',
      completedAt: 1_758_000_059_000,
      conflicts: [
        {
          recordId: 'mod_aaaaaaaaaaaaaaaa',
          sessionId: id,
          file: SOURCE_FILE,
          reason: 'content-changed',
          expectedHash: hashFixture('2b'),
          actualHash: hashFixture('3c'),
          backupPath: `/home/example/.debuggen/backups/${id}/${hashFixture('1a')}`,
          detectedAt: 1_758_000_059_000,
          message: 'src/lib/thing.ts was edited while instrumented.',
          diffs: { instrumentedToCurrent: '--- a\n+++ b\n' },
        },
      ],
    },
    promptVersions: {},
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** The list row the service would send for `record`. */
function listRow(record: SessionRecord): SessionListItem {
  return toSessionListItem(record);
}

/** Every store a case created, disposed after it. */
const created: ExtensionState[] = [];

/** A store with a fixed clock, disposed after each case. */
function createState(): ExtensionState {
  const state = new ExtensionState({
    serviceUrl: SERVICE_URL,
    provider: 'deterministic',
    now: () => 1_758_000_100_000,
  });
  created.push(state);
  return state;
}

/**
 * Puts `id` in view the only way the store allows — `adoptSession`, as the
 * commands do with the service's answer — because a pushed record never
 * becomes the active session on its own.
 */
function adoptInView(state: ExtensionState, id: string): void {
  state.adoptSession(sessionRecord(id), SERVICE_URL);
}

/** Counts the store's coalesced change events. */
function countChanges(state: ExtensionState): { readonly count: () => number } {
  let changes = 0;
  state.onDidChange(() => {
    changes += 1;
  });
  return { count: () => changes };
}

/** Lets the store's microtask flush run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  for (const state of created.splice(0)) {
    state.dispose();
  }
});

// ---------------------------------------------------------------------------
// setSessionList
// ---------------------------------------------------------------------------

describe('ExtensionState.setSessionList — a page of rows and the listing total', () => {
  it('holds no rows and a total of 0 before the list loads', () => {
    const state = createState();

    expect(state.sessionList).toEqual([]);
    expect(state.sessionListTotal).toBe(0);
  });

  it('stores the page rows and the total the service counted', async () => {
    const state = createState();
    const changes = countChanges(state);
    const rows = [listRow(sessionRecord(LISTED_ID)), listRow(sessionRecord(ACTIVE_ID))];

    state.setSessionList({ sessions: rows, total: 140 });
    await settle();

    expect(state.sessionList).toEqual(rows);
    expect(state.sessionListTotal).toBe(140);
    expect(changes.count()).toBe(1);
  });

  it('owns the rows: a frozen copy that the caller can no longer change', () => {
    const state = createState();
    const row = listRow(sessionRecord(LISTED_ID));

    state.setSessionList({ sessions: [row], total: 1 });
    row.question = 'changed by the caller afterwards';

    const [held] = state.sessionList;
    expect(held?.question).toBe('Why does the orders list render twice?');
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held?.cleanup)).toBe(true);
    expect(Object.isFrozen(row)).toBe(false);
  });

  it('never holds a total below the rows the page lists', () => {
    const state = createState();
    const rows = [listRow(sessionRecord(LISTED_ID)), listRow(sessionRecord(ACTIVE_ID))];

    state.setSessionList({ sessions: rows, total: 1 });
    expect(state.sessionListTotal).toBe(2);

    state.setSessionList({ sessions: rows, total: Number.NaN });
    expect(state.sessionListTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// refreshListedSession, through applySessionRecord
// ---------------------------------------------------------------------------

describe('ExtensionState.applySessionRecord — listed sessions keep rows, never records', () => {
  it('replaces the row of a listed session that is not in view with its projection', async () => {
    const state = createState();
    adoptInView(state, ACTIVE_ID);
    state.setSessionList({
      sessions: [listRow(sessionRecord(LISTED_ID, { status: 'capturing' }))],
      total: 7,
    });
    await settle();
    const changes = countChanges(state);

    const record = sessionRecord(LISTED_ID, { updatedAt: LISTED_UPDATED_AT + 1_000 });
    state.applySessionRecord(record);
    await settle();

    const [row] = state.sessionList;
    expect(row).toEqual(toSessionListItem(record));
    expect(Object.keys(row ?? {}).sort()).toEqual(LIST_ROW_KEYS);
    expect(row).not.toHaveProperty('plans');
    expect(row).not.toHaveProperty('modifications');
    expect(row).not.toHaveProperty('analyses');
    expect(row).not.toHaveProperty('relevantFiles');
    expect(row?.cleanup).toEqual({
      status: 'conflict',
      completedAt: 1_758_000_059_000,
      conflictCount: 1,
    });
    expect(row?.cleanup).not.toHaveProperty('conflicts');
    expect(Object.isFrozen(row)).toBe(true);
    expect(state.sessionListTotal).toBe(7);
    expect(state.activeSessionId).toBe(ACTIVE_ID);
    expect(changes.count()).toBe(1);
  });

  it('neither freezes nor retains the caller’s record when it only refreshes a row', () => {
    const state = createState();
    adoptInView(state, ACTIVE_ID);
    state.setSessionList({ sessions: [listRow(sessionRecord(LISTED_ID))], total: 1 });

    const record = sessionRecord(LISTED_ID, { updatedAt: LISTED_UPDATED_AT + 1_000 });
    state.applySessionRecord(record);
    record.question = 'mutated by the caller afterwards';
    record.cleanup.conflicts.length = 0;

    expect(Object.isFrozen(record)).toBe(false);
    expect(state.sessionList[0]?.question).toBe('Why does the orders list render twice?');
    expect(state.sessionList[0]?.cleanup.conflictCount).toBe(1);
  });

  it('keeps the whole record for the session in view and a projection for its row', () => {
    const state = createState();
    state.setSessionList({ sessions: [listRow(sessionRecord(LISTED_ID))], total: 3 });
    adoptInView(state, LISTED_ID);

    const record = sessionRecord(LISTED_ID, {
      status: 'ended',
      updatedAt: LISTED_UPDATED_AT + 5_000,
    });
    state.applySessionRecord(record);

    expect(state.activeSessionId).toBe(LISTED_ID);
    expect(state.activeSession?.status).toBe('ended');
    expect(state.activeSession?.plans).toHaveLength(1);
    expect(state.modifications).toHaveLength(1);
    const [row] = state.sessionList;
    expect(row).not.toBe(state.activeSession);
    expect(row).not.toHaveProperty('plans');
    expect(row?.status).toBe('ended');
    expect(row?.updatedAt).toBe(LISTED_UPDATED_AT + 5_000);
    expect(state.sessionListTotal).toBe(3);
  });

  it('ignores a record older than the listed row and notifies nothing', async () => {
    const state = createState();
    adoptInView(state, ACTIVE_ID);
    const listed = listRow(sessionRecord(LISTED_ID, { status: 'ended' }));
    state.setSessionList({ sessions: [listed], total: 1 });
    await settle();
    const changes = countChanges(state);

    state.applySessionRecord(
      sessionRecord(LISTED_ID, { status: 'capturing', updatedAt: LISTED_UPDATED_AT - 1 }),
    );
    await settle();

    expect(state.sessionList).toEqual([listed]);
    expect(changes.count()).toBe(0);
  });

  it('reports no change for a record whose row equals the listed one', async () => {
    const state = createState();
    adoptInView(state, ACTIVE_ID);
    const record = sessionRecord(LISTED_ID);
    state.setSessionList({ sessions: [listRow(record)], total: 1 });
    await settle();
    const before = state.sessionList;
    const changes = countChanges(state);

    state.applySessionRecord(sessionRecord(LISTED_ID));
    await settle();

    expect(state.sessionList).toBe(before);
    expect(changes.count()).toBe(0);
  });

  it('never adds a session the list does not hold', async () => {
    const state = createState();
    adoptInView(state, ACTIVE_ID);
    const listed = listRow(sessionRecord(LISTED_ID));
    state.setSessionList({ sessions: [listed], total: 4 });
    await settle();
    const changes = countChanges(state);

    state.applySessionRecord(sessionRecord(UNLISTED_ID, { updatedAt: LISTED_UPDATED_AT + 9 }));
    await settle();

    expect(state.sessionList).toEqual([listed]);
    expect(state.sessionListTotal).toBe(4);
    expect(state.activeSessionId).toBe(ACTIVE_ID);
    expect(changes.count()).toBe(0);
  });
});
