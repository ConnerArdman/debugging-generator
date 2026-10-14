/**
 * Tests for `./end-session.ts`: the modification journal `debuggen.endSession`
 * loads for a `partial` or `conflict` cleanup.
 *
 * When `session.end` answers a status alone, the command reads the session's
 * record and its modification journal from the owning service before its one
 * notice, so a window whose socket is closed still shows every modification.
 * The command runs against a fake {@link CommandContext} whose store is the
 * real `ExtensionState` and whose client scripts `endSession`, `getSession`
 * and `getModifications`; `vi.mock` substitutes the `vscode` module the store
 * and `../service/client` load.
 *
 * What is pinned:
 *
 * - every page of the journal is read from the owning endpoint, each within
 *   what is left of the details' bound, and every record reaches the store
 *   with the journal's total;
 * - a later page's failure, or the bound elapsing, keeps the records already
 *   read and the total, so the view can state what is missing, and is logged
 *   by counts and code only;
 * - the notice still names the conflicted file and its backup, and no file
 *   path or backup path reaches a log record.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  ListPageRequest,
  ModificationConflict,
  ModificationRecord,
  ModificationsResponse,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import type { SessionEndpointCallOptions } from '../service/client';
import { ExtensionState } from '../state';

import { endSession } from './end-session';
import type { CommandContext, CommandNotice } from './index';

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
const SESSION_ID = 'ses_end_session_journal';

/** The service that owns the session. */
const OWNER = 'http://127.0.0.1:43118';

/** The bound `loadCleanupDetails` gives the whole journal walk, in milliseconds. */
const DETAIL_BOUND_MS = 3_000;

/** A complete, schema-shaped session record. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/workspace/end-session',
    projectName: 'end-session',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0,
    status: 'capturing',
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

/** Record `n` of the session's journal, in `status`. */
function record(n: number, status: ModificationRecord['status'] = 'reverted'): ModificationRecord {
  return {
    id: `${SESSION_ID}-mod-${String(n)}`,
    sessionId: SESSION_ID,
    planVersion: 1,
    file: `src/lib/module-${String(n)}.ts`,
    originalHash: 'a'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${SESSION_ID}/${String(n).repeat(64).slice(0, 64)}`,
    instrumentedHash: 'b'.repeat(64),
    appliedAt: T0 + n,
    status,
    diff: '',
  };
}

/** The conflict cleanup reports for record 1: edited while instrumented. */
const CONFLICT: ModificationConflict = {
  recordId: record(1).id,
  sessionId: SESSION_ID,
  file: record(1).file,
  reason: 'content-changed',
  expectedHash: 'b'.repeat(64),
  actualHash: 'c'.repeat(64),
  backupPath: record(1).backupPath,
  detectedAt: T0 + 50,
  message: `${record(1).file} could not be restored; the original is still at ${record(1).backupPath}.`,
};

/** The owner's authoritative record once cleanup left record 1 in conflict. */
function endedRecord(): SessionRecord {
  return sessionRecord({
    status: 'ended',
    updatedAt: T0 + 60,
    modifications: [record(1, 'conflict')],
    cleanup: { status: 'conflict', completedAt: T0 + 60, conflicts: [CONFLICT] },
  });
}

/**
 * A plan-version-2 record layered on record 1's result: the same file, its
 * `originalHash` record 1's `instrumentedHash`, and its own backup therefore
 * record 1's instrumented output — bytes that still carry the tool's wrapper.
 * Only record 1, the chain root, backed up the pristine file.
 */
function layeredRecord(status: ModificationRecord['status'] = 'conflict'): ModificationRecord {
  const root = record(1);
  return {
    ...root,
    id: `${SESSION_ID}-mod-layered`,
    planVersion: 2,
    originalHash: root.instrumentedHash,
    backupPath: `/tmp/debuggen-home/backups/${SESSION_ID}/${root.instrumentedHash}`,
    instrumentedHash: 'd'.repeat(64),
    appliedAt: T0 + 10,
    status,
    previousRecordId: root.id,
  };
}

/**
 * The conflict cleanup reports for the layered record: edited while
 * instrumented, its own backup beside the chain root's pristine one.
 */
const CHAINED_CONFLICT: ModificationConflict = {
  recordId: layeredRecord().id,
  sessionId: SESSION_ID,
  file: layeredRecord().file,
  reason: 'content-changed',
  expectedHash: layeredRecord().instrumentedHash,
  actualHash: 'e'.repeat(64),
  backupPath: layeredRecord().backupPath,
  originalBackupPath: record(1).backupPath,
  detectedAt: T0 + 50,
  message: `${layeredRecord().file} could not be restored; the original is still at ${record(1).backupPath}.`,
};

/** A second, unchained file of the same session, edited while instrumented. */
const UNCHAINED_CONFLICT: ModificationConflict = {
  recordId: record(2).id,
  sessionId: SESSION_ID,
  file: record(2).file,
  reason: 'content-changed',
  expectedHash: record(2).instrumentedHash,
  actualHash: 'c'.repeat(64),
  backupPath: record(2).backupPath,
  detectedAt: T0 + 55,
  message: `${record(2).file} could not be restored; the original is still at ${record(2).backupPath}.`,
};

/** The owner's record once cleanup left the layered record (and its root) in conflict. */
function chainedEndedRecord(
  conflicts: readonly ModificationConflict[] = [CHAINED_CONFLICT],
): SessionRecord {
  return sessionRecord({
    status: 'ended',
    updatedAt: T0 + 60,
    modifications: [record(1, 'conflict'), layeredRecord()],
    cleanup: { status: 'conflict', completedAt: T0 + 60, conflicts: [...conflicts] },
  });
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
  readonly timeoutMs: number | undefined;
}

/** What one scripted page answers; a function runs when the page is requested. */
type PageAnswer =
  | Result<ModificationsResponse, DebuggenError>
  | (() => Result<ModificationsResponse, DebuggenError>);

/** The fake context and every spy a case asserts on. */
interface Harness {
  readonly ctx: CommandContext;
  readonly state: ExtensionState;
  readonly logs: LogRecord[];
  readonly calls: PageCall[];
  readonly notify: Mock<(notice: CommandNotice) => Promise<string | undefined>>;
}

/** Every store a case created, disposed after it. */
const stores: ExtensionState[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.dispose();
  }
  vi.useRealTimers();
});

/**
 * Builds the fake context: the session adopted from {@link OWNER} with one
 * applied patch, a closed socket, `session.end` answering `conflict`, the
 * owner's ended record, and the scripted journal pages.
 *
 * @param pages The journal pages `getModifications` answers, in order.
 * @param ownerRecord The record `getSession` answers; {@link endedRecord} by
 *   default.
 */
function createHarness(
  pages: readonly PageAnswer[],
  ownerRecord: () => SessionRecord = endedRecord,
): Harness {
  const logs: LogRecord[] = [];
  const calls: PageCall[] = [];
  const state = new ExtensionState({ serviceUrl: OWNER, provider: 'deterministic' });
  stores.push(state);
  state.adoptSession(sessionRecord({ modifications: [record(1, 'applied')] }), OWNER);

  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    return Promise.resolve<string | undefined>(undefined);
  });

  const ctx = {
    state,
    client: {
      baseUrl: OWNER,
      state: 'closed',
      configurationError: undefined,
      endSession: (sessionId: string, options?: SessionEndpointCallOptions) => {
        expect(sessionId).toBe(SESSION_ID);
        expect(options?.endpoint).toBe(OWNER);
        return Promise.resolve(ok({ cleanup: 'conflict' as const }));
      },
      getSession: (sessionId: string, options?: SessionEndpointCallOptions) => {
        expect(sessionId).toBe(SESSION_ID);
        expect(options?.endpoint).toBe(OWNER);
        return Promise.resolve(ok(ownerRecord()));
      },
      getModifications: (
        sessionId: string,
        window?: ListPageRequest,
        options?: SessionEndpointCallOptions,
      ) => {
        expect(sessionId).toBe(SESSION_ID);
        calls.push({ window, endpoint: options?.endpoint, timeoutMs: options?.timeoutMs });
        const answer = pages[calls.length - 1];
        if (answer === undefined) {
          throw new Error(`unscripted page request ${String(calls.length)}`);
        }
        return Promise.resolve(typeof answer === 'function' ? answer() : answer);
      },
    },
    logger: recordingLogger(logs),
    ui: {
      notify,
      notifyFailure: () => Promise.reject(new Error('no failure is expected')),
      executeCommand: () => Promise.resolve(undefined),
    },
    guards: {
      requireActiveSession: () => {
        const sessionId = state.activeSessionId;
        return sessionId === undefined ? undefined : { sessionId, session: state.activeSession };
      },
    },
  } as unknown as CommandContext;

  return { ctx, state, logs, calls, notify };
}

/** The one notice the command showed. */
function onlyNotice(harness: Harness): CommandNotice {
  expect(harness.notify).toHaveBeenCalledTimes(1);
  const [call] = harness.notify.mock.calls;
  if (call === undefined) {
    throw new Error('expected a notice');
  }
  return call[0];
}

/** Asserts that no log record names a file or a backup path. */
function expectNoPathLogged(harness: Harness): void {
  const serialised = JSON.stringify(harness.logs);
  expect(serialised).not.toContain('src/lib/module-');
  expect(serialised).not.toContain('/tmp/debuggen-home/backups');
}

/** The fields of the log records with `message`. */
function fieldsOf(harness: Harness, message: string): (LogFields | undefined)[] {
  return harness.logs.filter((entry) => entry.message === message).map((entry) => entry.fields);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('debuggen.endSession — the journal of a conflicted cleanup', () => {
  it('reads every page from the owner, within the bound, and records the whole journal with its total', async () => {
    const harness = createHarness([
      ok(page([record(1, 'conflict'), record(2)], 0, 3, 2)),
      ok(page([record(3)], 2, 3, null)),
    ]);

    await endSession(harness.ctx);

    expect(harness.calls.map(({ window, endpoint }) => ({ window, endpoint }))).toEqual([
      { window: undefined, endpoint: OWNER },
      { window: { offset: 2 }, endpoint: OWNER },
    ]);
    for (const { timeoutMs } of harness.calls) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(DETAIL_BOUND_MS);
    }
    expect(harness.state.modifications.map((held) => [held.id, held.status])).toEqual([
      [record(1).id, 'conflict'],
      [record(2).id, 'reverted'],
      [record(3).id, 'reverted'],
    ]);
    expect(harness.state.modificationsTotal).toBe(3);

    const notice = onlyNotice(harness);
    expect(notice.message).toBe(
      `${CONFLICT.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${CONFLICT.backupPath}.`,
    );
    expect(fieldsOf(harness, 'Cleanup details loaded')).toEqual([
      {
        command: 'debuggen.endSession',
        sessionId: SESSION_ID,
        conflicts: 1,
        modifications: 3,
        listed: 3,
        complete: true,
      },
    ]);
    expect(fieldsOf(harness, 'Modification journal read stopped before its end')).toEqual([]);
    expectNoPathLogged(harness);
  });

  it('keeps the records and the total a later page’s failure left, and logs counts only', async () => {
    const harness = createHarness([
      ok(page([record(1, 'conflict'), record(2)], 0, 3, 2)),
      err(new DebuggenError('TRANSPORT_DISCONNECTED', 'The service went away')),
    ]);

    await endSession(harness.ctx);

    expect(harness.calls).toHaveLength(2);
    expect(harness.state.modifications.map((held) => held.id)).toEqual([
      record(1).id,
      record(2).id,
    ]);
    expect(harness.state.modificationsTotal).toBe(3);
    expect(fieldsOf(harness, 'Modification journal read stopped before its end')).toEqual([
      {
        command: 'debuggen.endSession',
        sessionId: SESSION_ID,
        total: 3,
        listed: 2,
        complete: false,
        code: 'TRANSPORT_DISCONNECTED',
      },
    ]);
    expect(onlyNotice(harness).message).toContain(CONFLICT.file);
    expectNoPathLogged(harness);
  });

  it('stops the walk once the bound has elapsed, keeping what was read', async () => {
    vi.useFakeTimers({ now: T0 + 1_000_000, toFake: ['Date'] });
    const harness = createHarness([
      () => {
        vi.setSystemTime(Date.now() + DETAIL_BOUND_MS);
        return ok(page([record(1, 'conflict')], 0, 2, 1));
      },
    ]);

    await endSession(harness.ctx);

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.timeoutMs).toBe(DETAIL_BOUND_MS);
    expect(harness.state.modifications.map((held) => held.id)).toEqual([record(1).id]);
    expect(harness.state.modificationsTotal).toBe(2);
    expect(fieldsOf(harness, 'Modification journal read stopped before its end')).toEqual([
      {
        command: 'debuggen.endSession',
        sessionId: SESSION_ID,
        total: 2,
        listed: 1,
        complete: false,
        code: 'TRANSPORT_DISCONNECTED',
      },
    ]);
    expect(onlyNotice(harness).message).toContain(CONFLICT.file);
  });
});

describe('debuggen.endSession — the original a chained conflict names', () => {
  it('quotes the chain root’s pristine backup, never the layered record’s instrumented one', async () => {
    const harness = createHarness(
      [ok(page([record(1, 'conflict'), layeredRecord()], 0, 2, null))],
      () => chainedEndedRecord(),
    );

    await endSession(harness.ctx);

    const notice = onlyNotice(harness);
    expect(notice.message).toBe(
      `${CHAINED_CONFLICT.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${record(1).backupPath}.`,
    );
    expect(notice.message).not.toContain(layeredRecord().backupPath);
    // The report keeps the record's own backup beside the pristine one.
    expect(harness.state.cleanup.conflicts).toEqual([CHAINED_CONFLICT]);
    expectNoPathLogged(harness);
  });

  it('names each file’s pristine original: the chain root’s for a chained file, its own otherwise', async () => {
    const harness = createHarness(
      [ok(page([record(1, 'conflict'), layeredRecord(), record(2, 'conflict')], 0, 3, null))],
      () => chainedEndedRecord([CHAINED_CONFLICT, UNCHAINED_CONFLICT]),
    );

    await endSession(harness.ctx);

    const notice = onlyNotice(harness);
    expect(notice.message).toBe(
      'Session ended, but 2 files were left untouched. Debug Generator will not overwrite them.',
    );
    const detail = notice.detail ?? '';
    expect(detail).toContain(
      `${CHAINED_CONFLICT.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${record(1).backupPath}.`,
    );
    expect(detail).toContain(
      `${UNCHAINED_CONFLICT.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${record(2).backupPath}.`,
    );
    expect(detail).not.toContain(layeredRecord().backupPath);
    expectNoPathLogged(harness);
  });

  it('keeps the service’s own message for a chained conflict of another reason', async () => {
    // A deleted file has no bytes to hash, so the report carries no actualHash.
    const missing: ModificationConflict = {
      recordId: CHAINED_CONFLICT.recordId,
      sessionId: SESSION_ID,
      file: CHAINED_CONFLICT.file,
      reason: 'file-missing',
      expectedHash: CHAINED_CONFLICT.expectedHash,
      backupPath: CHAINED_CONFLICT.backupPath,
      originalBackupPath: record(1).backupPath,
      detectedAt: T0 + 50,
      message: `${CHAINED_CONFLICT.file} is missing; the original is still at ${record(1).backupPath}.`,
    };
    const harness = createHarness(
      [ok(page([record(1, 'conflict'), layeredRecord()], 0, 2, null))],
      () => chainedEndedRecord([missing]),
    );

    await endSession(harness.ctx);

    expect(onlyNotice(harness).message).toBe(missing.message);
  });
});
