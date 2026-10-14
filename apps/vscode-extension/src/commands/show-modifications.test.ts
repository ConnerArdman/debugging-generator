/**
 * Tests for `./show-modifications.ts`: `debuggen.showModifications`.
 *
 * The command runs against a fake {@link CommandContext} whose store is the
 * real `ExtensionState` — so what is asserted is the list and the counted
 * total the view renders — and whose service client scripts
 * `getModifications` page by page. Every UI call is a spy. `vi.mock`
 * substitutes the `vscode` module: the store needs its `EventEmitter`, and
 * `../service/client` (where the journal walk lives) only has to resolve.
 *
 * What is pinned:
 *
 * - the view is revealed and focused on its modifications section before the
 *   first page is requested;
 * - every page of a multi-page journal is read from the session's owning
 *   endpoint, and every record reaches the store in journal order together
 *   with the journal's total, followed by the one informational notice that
 *   names the total;
 * - a walk a later page's failure cut short keeps the records it loaded and
 *   the total, and is reported by one warning saying how many of the total
 *   were loaded, why, and how to load the rest;
 * - an older read that finishes after a newer one never lowers the total the
 *   newer one counted, so the list still reads as partial and both notices
 *   say so;
 * - a failed first page is one failure notice and changes nothing in the
 *   store;
 * - no file path or backup path reaches a log record.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  ListPageRequest,
  ModificationRecord,
  ModificationsResponse,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import type { SessionEndpointCallOptions } from '../service/client';
import { ExtensionState } from '../state';

import type { CommandContext, CommandNotice, FailureNoticeOptions } from './index';
import { showModifications } from './show-modifications';

vi.mock('vscode', () => {
  /** The part of `vscode.EventEmitter` `ExtensionState` uses, delivering synchronously. */
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
  return { EventEmitter, workspace: {} };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const SESSION_ID = 'ses_show_modifications';

/** The service that owns the session. */
const OWNER = 'http://127.0.0.1:43118';

/** The service `debuggen.serviceUrl` names now: not the owner. */
const CURRENT = 'http://127.0.0.1:43117';

/** A complete, schema-shaped session record. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/workspace/show-modifications',
    projectName: 'show-modifications',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    question: 'Why does the list render twice?',
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
    ...overrides,
  };
}

/** Record `n` of the session's journal. */
function record(n: number): ModificationRecord {
  return {
    id: `${SESSION_ID}-mod-${String(n)}`,
    sessionId: SESSION_ID,
    planVersion: 1,
    file: `src/lib/module-${String(n)}.ts`,
    originalHash: 'a'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${SESSION_ID}/${'a'.repeat(64)}`,
    instrumentedHash: 'b'.repeat(64),
    appliedAt: T0 + n,
    status: 'applied',
    diff: `--- a/src/lib/module-${String(n)}.ts\n+++ b/src/lib/module-${String(n)}.ts\n`,
  };
}

/** A journal page carrying `records`. */
function page(
  records: readonly ModificationRecord[],
  offset: number,
  total: number,
  nextOffset: number | null,
): ModificationsResponse {
  return { modifications: [...records], total, limit: 256, offset, nextOffset };
}

/** Every store a case created, disposed after it. */
const stores: ExtensionState[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.dispose();
  }
});

/** One log record the fake logger captured. */
interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records every call. */
function recordingLogger(logs: LogRecord[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
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

/** One `getModifications` call. */
interface PageCall {
  readonly window: ListPageRequest | undefined;
  readonly endpoint: string | undefined;
}

/** The fake context and every spy a case asserts on. */
interface Harness {
  readonly ctx: CommandContext;
  readonly state: ExtensionState;
  readonly events: string[];
  readonly logs: LogRecord[];
  readonly calls: PageCall[];
  readonly notify: Mock<(notice: CommandNotice) => Promise<string | undefined>>;
  readonly notifyFailure: Mock<
    (error: DebuggenError, options?: FailureNoticeOptions) => Promise<string | undefined>
  >;
}

/**
 * Builds the fake context: the session adopted from {@link OWNER}, and a client
 * answering the scripted pages in call order. A page scripted as a promise is
 * answered when that promise settles, so a case can hold one read's answer
 * back while another read runs.
 */
function createHarness(
  pages: readonly (
    | Result<ModificationsResponse, DebuggenError>
    | Promise<Result<ModificationsResponse, DebuggenError>>
  )[],
  options: { readonly active?: boolean } = {},
): Harness {
  const events: string[] = [];
  const logs: LogRecord[] = [];
  const calls: PageCall[] = [];
  const state = new ExtensionState({ serviceUrl: CURRENT, provider: 'deterministic' });
  stores.push(state);
  if (options.active !== false) {
    state.adoptSession(sessionRecord(), OWNER);
  }

  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    events.push('notify');
    return Promise.resolve<string | undefined>(undefined);
  });
  const notifyFailure = vi.fn((error: DebuggenError, failureOptions?: FailureNoticeOptions) => {
    void error;
    void failureOptions;
    events.push('notifyFailure');
    return Promise.resolve<string | undefined>(undefined);
  });

  const ctx = {
    state,
    client: {
      getModifications: (
        sessionId: string,
        window?: ListPageRequest,
        callOptions?: SessionEndpointCallOptions,
      ) => {
        expect(sessionId).toBe(SESSION_ID);
        calls.push({ window, endpoint: callOptions?.endpoint });
        events.push('getModifications');
        const answer = pages[calls.length - 1];
        if (answer === undefined) {
          throw new Error(`unscripted page request ${String(calls.length)}`);
        }
        return Promise.resolve(answer);
      },
    },
    sessionView: {
      postFocus: (section: string) => {
        events.push(`focus:${section}`);
      },
    },
    logger: recordingLogger(logs),
    ui: {
      notify,
      notifyFailure,
      executeCommand: (command: string) => {
        events.push(`execute:${command}`);
        return Promise.resolve(undefined);
      },
    },
    guards: {
      requireActiveSession: () => {
        const sessionId = state.activeSessionId;
        return sessionId === undefined ? undefined : { sessionId, session: state.activeSession };
      },
    },
  } as unknown as CommandContext;

  return { ctx, state, events, logs, calls, notify, notifyFailure };
}

/** The one notice the command showed. */
function onlyNotice(harness: Harness): CommandNotice {
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(harness.notifyFailure).not.toHaveBeenCalled();
  const [call] = harness.notify.mock.calls;
  if (call === undefined) {
    throw new Error('expected a notice');
  }
  return call[0];
}

/** Asserts that no log record names a file, a backup path or a diff. */
function expectNoContentLogged(harness: Harness): void {
  const serialised = JSON.stringify(harness.logs);
  expect(serialised).not.toContain('src/lib/module-');
  expect(serialised).not.toContain('/tmp/debuggen-home/backups');
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('debuggen.showModifications', () => {
  it('reads every page from the owning endpoint and records the whole journal with its total', async () => {
    const harness = createHarness([
      ok(page([record(1), record(2)], 0, 4, 2)),
      ok(page([record(3)], 2, 4, 3)),
      ok(page([record(4)], 3, 4, null)),
    ]);

    await showModifications(harness.ctx);

    expect(harness.events.slice(0, 3)).toEqual([
      'execute:debuggen.session.focus',
      'focus:modifications',
      'getModifications',
    ]);
    expect(harness.calls).toEqual([
      { window: undefined, endpoint: OWNER },
      { window: { offset: 2 }, endpoint: OWNER },
      { window: { offset: 3 }, endpoint: OWNER },
    ]);
    expect(harness.state.modifications.map((held) => held.id)).toEqual(
      [1, 2, 3, 4].map((n) => record(n).id),
    );
    expect(harness.state.modificationsTotal).toBe(4);
    expect(harness.state.toWebviewState().modificationsTotal).toBe(4);
    expect(onlyNotice(harness)).toEqual({
      level: 'info',
      message: '4 file modifications are recorded for this session.',
      detail:
        'Each one is listed under File modifications with its status and the exact diff that was applied.',
    });
    expectNoContentLogged(harness);
  });

  it('reads a one-page journal with a single request and reports a single modification', async () => {
    const harness = createHarness([ok(page([record(1)], 0, 1, null))]);

    await showModifications(harness.ctx, { kind: 'from-a-menu' });

    expect(harness.calls).toEqual([{ window: undefined, endpoint: OWNER }]);
    expect(onlyNotice(harness).message).toBe('1 file modification is recorded for this session.');
    expect(harness.state.modificationsTotal).toBe(1);
  });

  it('reports an empty journal as no modification', async () => {
    const harness = createHarness([ok(page([], 0, 0, null))]);

    await showModifications(harness.ctx);

    expect(onlyNotice(harness)).toEqual({
      level: 'info',
      message: 'No files were modified for this session.',
      detail:
        'Debug Generator patches a source file only to time a named function; every other signal comes from runtime hooks.',
    });
    expect(harness.state.modificationsTotal).toBe(0);
  });

  it('keeps what a cut-short walk loaded, stores the total and warns how many of it were loaded', async () => {
    const failure = new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The modifications.list request timed out after 15000 ms',
      { hint: 'The local service did not answer in time.' },
    );
    const harness = createHarness([ok(page([record(1), record(2)], 0, 5, 2)), err(failure)]);

    await showModifications(harness.ctx);

    expect(harness.calls).toHaveLength(2);
    expect(harness.state.modifications.map((held) => held.id)).toEqual([
      record(1).id,
      record(2).id,
    ]);
    expect(harness.state.modificationsTotal).toBe(5);
    const notice = onlyNotice(harness);
    expect(notice.level).toBe('warning');
    expect(notice.message).toBe('Loaded 2 of 5 file modifications recorded for this session.');
    expect(notice.detail).toBe(
      'The modifications.list request timed out after 15000 ms. The local service did not answer in time. Run "Debug Generator: Show File Modifications" again, or choose "Load all modifications" under File modifications, to load the rest.',
    );
    const warned = harness.logs.filter((entry) => entry.level === 'warn');
    expect(warned.map((entry) => entry.fields)).toEqual([
      {
        command: 'debuggen.showModifications',
        count: 5,
        listed: 2,
        loaded: 2,
        pages: 1,
        complete: false,
        projected: true,
        code: 'TRANSPORT_DISCONNECTED',
      },
    ]);
    expectNoContentLogged(harness);
  });

  it('keeps the larger count when an older read finishes after a newer one, and still warns that the list is partial', async () => {
    let answerOlderRead: (answer: Result<ModificationsResponse, DebuggenError>) => void = () =>
      undefined;
    const olderRead = new Promise<Result<ModificationsResponse, DebuggenError>>((resolve) => {
      answerOlderRead = resolve;
    });
    const failure = new DebuggenError(
      'TRANSPORT_DISCONNECTED',
      'The connection to the local service was lost',
    );
    const harness = createHarness([
      // Read A's only page, held back until read B has finished.
      olderRead,
      // Read B: two of three records, then a failed second page.
      ok(page([record(1), record(2)], 0, 3, 2)),
      err(failure),
    ]);

    const readA = showModifications(harness.ctx);
    const readB = showModifications(harness.ctx);
    await readB;
    // Read A counted the journal before its third record was written.
    answerOlderRead(ok(page([record(1), record(2)], 0, 2, null)));
    await readA;

    expect(harness.calls).toHaveLength(3);
    expect(harness.state.modificationsTotal).toBe(3);
    const snapshot = harness.state.toWebviewState();
    expect(snapshot.modifications.map((held) => held.id)).toEqual([record(1).id, record(2).id]);
    expect(snapshot.modificationsTotal).toBe(3);
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(
      harness.notify.mock.calls.map(([notice]) => [notice.level, notice.message, notice.detail]),
    ).toEqual([
      [
        'warning',
        'Loaded 2 of 3 file modifications recorded for this session.',
        'The connection to the local service was lost. Run "Debug Generator: Show File Modifications" again, or choose "Load all modifications" under File modifications, to load the rest.',
      ],
      [
        'warning',
        'Loaded 2 of 3 file modifications recorded for this session.',
        'Run "Debug Generator: Show File Modifications" again, or choose "Load all modifications" under File modifications, to load the rest.',
      ],
    ]);
    expectNoContentLogged(harness);
  });

  it('reports a failed first page once, as a failure, and leaves the store as it was', async () => {
    const failure = new DebuggenError('SESSION_NOT_FOUND', 'No such session', {
      hint: 'Reopen the session from the Sessions view.',
    });
    const harness = createHarness([err(failure)]);

    await showModifications(harness.ctx);

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).toHaveBeenCalledTimes(1);
    expect(harness.notifyFailure).toHaveBeenCalledWith(failure, {
      prefix: 'Could not load file modifications',
    });
    expect(harness.state.modifications).toEqual([]);
    expect(harness.state.modificationsTotal).toBeUndefined();
  });

  it('requests nothing without an active session', async () => {
    const harness = createHarness([], { active: false });

    await showModifications(harness.ctx);

    expect(harness.calls).toEqual([]);
    expect(harness.events).toEqual([]);
  });
});
