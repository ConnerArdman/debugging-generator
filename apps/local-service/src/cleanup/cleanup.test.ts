/**
 * Tests for `./cleanup.ts`: the service-layer orchestration around the
 * `@debuggen/instrumentation` cleanup engine.
 *
 * What is on trial is only what this module decides — which collaborators it
 * calls, in which order, with which arguments, and what it reports. The engine's
 * own guarantees (byte-identical restores, reverse-order chain unwinding, the
 * per-status reconciliation table, deletion only after verification, the
 * conflict verdict) are pinned by `packages/instrumentation/src/cleanup.test.ts`,
 * `patch/patcher.test.ts` and `patch/conflict.test.ts`; the wired conflict path
 * by `test/integration/cleanup-conflict.test.ts`; and the demo's clean working
 * tree by `tests/e2e/cleanup.spec.ts`. None of that is asserted again here.
 *
 * The invariants this suite exists for, because each fails silently:
 *
 * 1. **The start-up reconciliation set is never scoped by session status**
 *    (AAP §0.5.1): the records come from `listAllOpen()`, every owning status
 *    reaches the engine, and a record whose session row is gone is left exactly
 *    as it is and counted `unresolved`.
 * 2. **The watcher is stopped, and the hooks disarmed, before the first
 *    restore**: a restore write is a digest change, and the watcher's one
 *    mutation turns a digest change into a `conflict`.
 * 3. **Runtime hooks are disabled by delegation, and a disarm is confirmed by
 *    its receipt**: one disarm and one release per session, the disarm carries
 *    no capture id, the module builds no agent or preload configuration of its
 *    own, and a disarm that failed, cannot say who received it, or names
 *    producers that did not, reports `partial` with the files still restored —
 *    upgraded to `clean` exactly once, through the sink, only when the service
 *    later confirms a named shortfall dormant.
 * 4. **One delivery of the outcome**: `run` returns it once for
 *    `SessionManager.end` to record and broadcast; the start-up pass hands each
 *    session's verdict to the injected sink exactly once, or writes only the
 *    record's `cleanup` sub-object when there is no sink — never its status.
 * 5. **A restart never leaves a session capturing what it removed**:
 *    `settleInterruptedSessions` reads every interrupted session before acting,
 *    fails an interrupted install and any ready or capturing session whose
 *    records the reconciliation held, resumes a runtime-only capture with its
 *    own plan version, and contains a per-session failure.
 *
 * and, around them: a developer-edited file is never overwritten, no backup is
 * deleted by this module, the independent end-state verification can only make
 * a verdict worse, `aggregateCleanupStatus` is total and never answers
 * `pending`, passes are serialised and idempotent, expected failures are typed
 * results rather than throws, cancellation stops new work and says what was
 * done, nothing sensitive reaches a log record, and the start-up report is
 * deterministic JSON.
 *
 * Every collaborator is an injected recording double that appends to one
 * shared call log, so ordering is asserted directly. The engine is substituted
 * through `vi.mock` of the package specifier — `./cleanup.ts` imports
 * `cleanupSession` and `reconcileModifications` directly — and scripted per
 * record; it moves records through the injected journal exactly as the real
 * engine does. Fixtures are built through the real `createModificationRecord`,
 * `parseModificationConflict`, `parseSessionRecord` and `captureRecordSchema`,
 * so a schema change breaks this suite loudly. Each test gets its own
 * `mkdtemp` sandbox holding a `0700` state directory and a project whose files
 * are real, because the module's end-state verification re-hashes them; every
 * digest is computed at run time and every name is invented.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_HOOK_KEYS,
  SERVER_AGENT_SIGNAL_KEYS,
  cleanupSession,
  createBackupStore,
  createModificationRecord,
  parseModificationConflict,
  reconcileModifications,
} from '@debuggen/instrumentation';
import type {
  BackupStore,
  CleanupContext,
  CleanupFailure,
  CleanupOutcome,
  InstrumentationPlan,
  ModificationConflict,
  ModificationRecord,
  ModificationStatus,
  ReconcileOptions,
  ReconcileOutcome,
} from '@debuggen/instrumentation';
import {
  CLEANUP_STATUSES,
  SESSION_STATUSES,
  captureRecordSchema,
  parseSessionProgressPayload,
  parseSessionRecord,
} from '@debuggen/protocol';
import type {
  CleanupStatus,
  ProgressStage,
  SessionProgressPayload,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  err,
  isErr,
  isOk,
  ok,
  unwrap,
} from '@debuggen/shared';
import type { LogRecord, Logger, Result } from '@debuggen/shared';
import { sha256Hex, sha256OfFile } from '@debuggen/shared/node';

import type { SessionCleanupOutcome } from '../sessions/manager.js';
import type { SessionProgress } from '../sessions/progress.js';
import type { SessionFailure } from '../sessions/state-machine.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import { MAX_SESSION_LIST_LIMIT } from '../store/sessions-repo.js';
import type {
  ListSessionsOptions,
  SessionListItem,
  SessionsRepo,
  StoredCapture,
} from '../store/sessions-repo.js';
import {
  CLEANUP_TRIGGERS,
  aggregateCleanupStatus,
  createCleanupContextFactory,
  createSessionCleanup,
  reconcileModificationsOnStartup,
  settleInterruptedSessions,
} from './cleanup.js';
import type {
  CaptureReleaseRequest,
  CaptureReleaser,
  CleanupContextRequest,
  CleanupCounts,
  CleanupDisarmOutcome,
  CleanupDisarmRequest,
  CleanupOutcomeSink,
  CleanupVerdictHold,
  InstrumentationContextFactory,
  InstrumentationDisabler,
  InstrumentationSuspender,
  InterruptedSessionDeps,
  InterruptedSessionsReport,
  ReleasedCaptureVerdict,
  SessionCleanup,
  SessionCleanupDeps,
  SessionFailer,
  SessionReconciliationSummary,
  StartupReconciliationDeps,
  StartupReconciliationReport,
} from './cleanup.js';

// ---------------------------------------------------------------------------
// The substituted engine
// ---------------------------------------------------------------------------

/**
 * `@debuggen/instrumentation` with its two cleanup entry points replaced by
 * mocks and everything else — the schemas, the record and conflict builders,
 * the backup store — real. The default implementation refuses to run, so an
 * engine call a test did not script fails loudly instead of touching disk;
 * {@link installEngine} scripts both per harness.
 */
vi.mock('@debuggen/instrumentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@debuggen/instrumentation')>();
  const unscripted = (): Promise<never> =>
    Promise.reject(new Error('The cleanup engine was called without a scripted harness.'));

  return {
    ...actual,
    cleanupSession: vi.fn(unscripted),
    reconcileModifications: vi.fn(unscripted),
  };
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The instant every injected clock reads. */
const FIXED_NOW = 1_700_000_000_000;

/** The injected clock. */
const now = (): number => FIXED_NOW;

/** When every seeded record was journaled: a minute before {@link FIXED_NOW}. */
const SEEDED_AT = FIXED_NOW - 60_000;

/** A recognisable string inside every seeded diff, which must never reach a log record. */
const DIFF_MARKER = 'dg-synthetic-diff-marker';

/** A recognisable string inside every seeded file's bytes, which must never reach a log record. */
const CONTENT_MARKER = 'dg-synthetic-content-marker';

/** Invented session ids, one per owning state the reconciliation must not filter on. */
const SESSION = Object.freeze({
  failed: 'ses_lanternfailed',
  capturing: 'ses_lanterncapturing',
  generated: 'ses_lanterngenerated',
  midCleanup: 'ses_lanternmidcleanup',
  missing: 'ses_lanternvanished',
});

/** Invented, project-relative fixture paths. */
const FILE = Object.freeze({
  dial: 'src/meridian/dial-face.ts',
  needle: 'src/meridian/needle-sweep.ts',
  bezel: 'src/meridian/bezel-ring.ts',
  gauge: 'lib/orbit/gauge-plate.ts',
  drift: 'lib/orbit/drift-log.ts',
});

// ---------------------------------------------------------------------------
// The shared call log
// ---------------------------------------------------------------------------

/** Who a recorded call went to. */
type Actor =
  | 'modifications'
  | 'sessions'
  | 'sink'
  | 'context'
  | 'instrumentation'
  | 'watcher'
  | 'progress'
  | 'backups'
  | 'engine'
  | 'manager';

/** One call a double received, in the order every double received them. */
interface CallEntry {
  readonly actor: Actor;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** `actor.method` for every call, in order. */
function order(h: Harness): string[] {
  return h.calls.map((call) => `${call.actor}.${call.method}`);
}

/** The calls one actor (and optionally one method) received, in order. */
function callsOf(h: Harness, actor: Actor, method?: string): CallEntry[] {
  return h.calls.filter(
    (call) => call.actor === actor && (method === undefined || call.method === method),
  );
}

/** Index of the first `actor.method` call, or `-1`. */
function firstIndex(h: Harness, entry: string): number {
  return order(h).indexOf(entry);
}

/** Every string reachable from a value, walking arrays and plain objects. */
function stringLeaves(value: unknown, into: string[] = [], seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);

    for (const member of Array.isArray(value) ? value : Object.values(value)) {
      stringLeaves(member, into, seen);
    }
  }

  return into;
}

// ---------------------------------------------------------------------------
// Recording doubles for every port
// ---------------------------------------------------------------------------

/** The journal double: the full `ModificationsRepo` over an array, every call logged. */
interface MemoryModifications extends ModificationsRepo {
  /** Every record, in append order; `updateStatus` replaces an element. */
  readonly records: ModificationRecord[];

  /** Seeds a record without logging a call: fixtures are not the module's reads. */
  seed(record: ModificationRecord): void;

  /** The open records as they stand now, read by the scripted engine without logging. */
  openRecords(): ModificationRecord[];

  /** `listAllOpen: true` makes that call answer `err`, as a journal that will not answer does. */
  readonly faults: { listAllOpen: boolean };
}

function createMemoryModifications(calls: CallEntry[]): MemoryModifications {
  const records: ModificationRecord[] = [];
  const faults = { listAllOpen: false };
  const note = (method: string, args: readonly unknown[]): void => {
    calls.push({ actor: 'modifications', method, args });
  };
  const bySession = (sessionId: string): ModificationRecord[] =>
    records.filter((record) => record.sessionId === sessionId);
  const open = (): ModificationRecord[] => records.filter((record) => record.status !== 'reverted');
  const unknownRecord = (): Result<never> =>
    err(new DebuggenError('STORE_ERROR', 'No modification record has that id.'));

  return {
    records,
    faults,
    seed(record) {
      records.push(record);
    },
    openRecords: open,
    append(record) {
      note('append', [record.id]);
      records.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus(id, status, patch) {
      note('updateStatus', [id, status]);
      const index = records.findIndex((record) => record.id === id);
      const current = records[index];

      if (current === undefined) {
        return Promise.resolve(unknownRecord());
      }

      const updated: ModificationRecord = { ...current, ...patch, status };
      records[index] = updated;
      return Promise.resolve(ok(updated));
    },
    listBySession(sessionId, options) {
      note('listBySession', [sessionId, options]);
      const statuses = options?.statuses;
      return Promise.resolve(
        ok(
          bySession(sessionId).filter(
            (record) => statuses === undefined || statuses.includes(record.status),
          ),
        ),
      );
    },
    listPageBySession(sessionId, window) {
      note('listPageBySession', [sessionId, window.limit, window.offset]);
      const all = bySession(sessionId);
      return Promise.resolve(
        ok({ records: all.slice(window.offset, window.offset + window.limit), total: all.length }),
      );
    },
    listOpen(sessionId) {
      note('listOpen', [sessionId]);
      return Promise.resolve(
        ok(open().filter((record) => sessionId === undefined || record.sessionId === sessionId)),
      );
    },
    listAllOpen(...args: readonly unknown[]) {
      // Rest parameters so an argument the port does not declare — a status or
      // session filter smuggled in — would still be recorded and caught.
      note('listAllOpen', args);
      return Promise.resolve(
        faults.listAllOpen
          ? err(new DebuggenError('STORE_ERROR', 'The synthetic journal did not answer.'))
          : ok(open()),
      );
    },
    get(id) {
      note('get', [id]);
      return Promise.resolve(ok(records.find((record) => record.id === id)));
    },
    listByFile(sessionId, file) {
      note('listByFile', [sessionId, file]);
      return Promise.resolve(ok(bySession(sessionId).filter((record) => record.file === file)));
    },
    latestRecordForFile(sessionId, file) {
      note('latestRecordForFile', [sessionId, file]);
      return Promise.resolve(
        ok(
          bySession(sessionId)
            .filter((record) => record.file === file)
            .at(-1),
        ),
      );
    },
    listChain(recordId) {
      note('listChain', [recordId]);
      const record = records.find((candidate) => candidate.id === recordId);
      return Promise.resolve(record === undefined ? unknownRecord() : ok([record]));
    },
    listConflicts(sessionId) {
      note('listConflicts', [sessionId]);
      return Promise.resolve(
        ok(
          records.filter(
            (record) =>
              record.status === 'conflict' &&
              (sessionId === undefined || record.sessionId === sessionId),
          ),
        ),
      );
    },
    listBackupPaths(options) {
      note('listBackupPaths', [options]);
      return Promise.resolve(ok([...new Set(records.map((record) => record.backupPath))].sort()));
    },
    countBySession(sessionId) {
      note('countBySession', [sessionId]);
      return Promise.resolve(ok(bySession(sessionId).length));
    },
    deleteBySession(sessionId) {
      note('deleteBySession', [sessionId]);
      const before = records.length;
      const kept = records.filter((record) => record.sessionId !== sessionId);
      records.splice(0, records.length, ...kept);
      return Promise.resolve(ok(before - kept.length));
    },
  };
}

/** The session-store double: exactly the three members the module is typed to use. */
interface MemorySessions extends Pick<SessionsRepo, 'get' | 'update' | 'getActiveCapture'> {
  readonly rows: Map<string, SessionRecord>;
  readonly captures: Map<string, StoredCapture>;

  /** Every record `update` was handed, in order. */
  readonly updates: SessionRecord[];

  /** Session ids whose `get` answers `err`, as a corrupt row does. */
  readonly unreadable: Set<string>;
}

function createMemorySessions(calls: CallEntry[]): MemorySessions {
  const rows = new Map<string, SessionRecord>();
  const captures = new Map<string, StoredCapture>();
  const updates: SessionRecord[] = [];
  const unreadable = new Set<string>();
  const note = (method: string, args: readonly unknown[]): void => {
    calls.push({ actor: 'sessions', method, args });
  };

  return {
    rows,
    captures,
    updates,
    unreadable,
    get(id) {
      note('get', [id]);
      return unreadable.has(id)
        ? err(new DebuggenError('STORE_ERROR', 'The synthetic session row does not parse.'))
        : ok(rows.get(id));
    },
    update(record) {
      note('update', [record]);
      updates.push(record);
      rows.set(record.id, record);
      return ok(record);
    },
    getActiveCapture(sessionId) {
      note('getActiveCapture', [sessionId]);
      return ok(captures.get(sessionId));
    },
  };
}

/** The session-record form of an outcome, as `SessionManager.recordCleanupOutcome` stores it. */
function storedCleanup(outcome: SessionCleanupOutcome): SessionRecord['cleanup'] {
  return outcome.status === 'pending'
    ? { status: outcome.status, conflicts: [...outcome.conflicts] }
    : {
        status: outcome.status,
        completedAt: outcome.completedAt,
        conflicts: [...outcome.conflicts],
      };
}

/** The outcome sink double: records each delivery and persists it as the manager would. */
interface RecordingSink extends CleanupOutcomeSink {
  readonly delivered: { readonly sessionId: string; readonly outcome: SessionCleanupOutcome }[];
}

function createRecordingSink(calls: CallEntry[], sessions: MemorySessions): RecordingSink {
  const delivered: { sessionId: string; outcome: SessionCleanupOutcome }[] = [];

  return {
    delivered,
    recordCleanupOutcome(sessionId, outcome) {
      calls.push({ actor: 'sink', method: 'recordCleanupOutcome', args: [sessionId, outcome] });
      delivered.push({ sessionId, outcome });
      const row = sessions.rows.get(sessionId);

      // Written straight into the rows, not through `update`: the manager owns
      // this persistence, and the module under test must not be credited with it.
      if (row !== undefined) {
        sessions.rows.set(sessionId, { ...row, cleanup: storedCleanup(outcome) });
      }

      return ok(outcome);
    },
  };
}

/** How a double that can fail fails. */
type Fault = 'none' | 'err' | 'throw';

/** A mutable fault switch a double reads on every call. */
interface FaultSwitch {
  fault: Fault;
}

/** The conflict-watcher double. */
interface RecordingWatcher extends InstrumentationSuspender {
  /** Every session the watcher was told to stop watching, in order. */
  readonly stopped: string[];
  readonly faults: FaultSwitch;
}

function createRecordingWatcher(calls: CallEntry[]): RecordingWatcher {
  const stopped: string[] = [];
  const faults: FaultSwitch = { fault: 'none' };

  return {
    stopped,
    faults,
    stopSession(sessionId) {
      calls.push({ actor: 'watcher', method: 'stopSession', args: [sessionId] });
      stopped.push(sessionId);

      if (faults.fault !== 'none') {
        throw new Error('The synthetic watcher could not be stopped.');
      }
    },
  };
}

/** What a scripted disarm reports as `pending`: a list, or no `pending` member at all. */
type PendingScript = readonly string[] | 'unreported';

/** The instrumentation-service double: the runtime-hook half of cleanup. */
interface RecordingDisabler extends InstrumentationDisabler {
  /** Sessions reported as still installing. */
  readonly installing: Set<string>;

  /** Every disarm request, exactly as the module built it. */
  readonly disarmed: CleanupDisarmRequest[];

  /** Every session whose instrumentation state was released. */
  readonly released: string[];

  readonly faults: FaultSwitch;

  /**
   * What the next disarm of a session reports as undelivered. A session with no
   * entry answers `pending: []` — every armed producer received its dormant
   * configuration, as the real service reports when the producers are connected.
   */
  readonly pendingFor: Map<string, PendingScript>;

  /**
   * Every listener subscribed to dormancy confirmations. Subscribing is kept out
   * of the shared call log on purpose: it happens once, when a runner is built,
   * and is not a call a pass makes.
   */
  readonly listeners: Set<(sessionId: string) => void>;

  /** Fires a dormancy confirmation for a session, as the service does after a replay. */
  confirmDormancy(sessionId: string): void;
}

function createRecordingDisabler(calls: CallEntry[]): RecordingDisabler {
  const installing = new Set<string>();
  const disarmed: CleanupDisarmRequest[] = [];
  const released: string[] = [];
  const faults: FaultSwitch = { fault: 'none' };
  const pendingFor = new Map<string, PendingScript>();
  const listeners = new Set<(sessionId: string) => void>();

  return {
    installing,
    disarmed,
    released,
    faults,
    pendingFor,
    listeners,
    confirmDormancy(sessionId) {
      for (const listener of [...listeners]) {
        listener(sessionId);
      }
    },
    disarmCapture(request: CleanupDisarmRequest): Result<CleanupDisarmOutcome, DebuggenError> {
      calls.push({ actor: 'instrumentation', method: 'disarmCapture', args: [request] });
      disarmed.push(request);

      if (faults.fault === 'throw') {
        throw new Error('The synthetic socket is gone.');
      }

      if (faults.fault === 'err') {
        return err(
          new DebuggenError('TRANSPORT_DISCONNECTED', 'No synthetic client is connected.'),
        );
      }

      const pending = pendingFor.get(request.sessionId) ?? [];

      return pending === 'unreported'
        ? ok({ sessionId: request.sessionId })
        : ok({ sessionId: request.sessionId, pending: [...pending] });
    },
    onDormancyConfirmed(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    stopSession(sessionId) {
      calls.push({ actor: 'instrumentation', method: 'stopSession', args: [sessionId] });
      released.push(sessionId);
    },
    isInstalling(sessionId) {
      calls.push({ actor: 'instrumentation', method: 'isInstalling', args: [sessionId] });
      return installing.has(sessionId);
    },
  };
}

/** The progress-emitter double: records every stage row. */
interface RecordingProgress extends Pick<SessionProgress, 'stageStarted' | 'stageCompleted'> {
  readonly rows: {
    readonly sessionId: string;
    readonly stage: ProgressStage;
    readonly kind: string;
  }[];
  readonly faults: FaultSwitch;
}

function createRecordingProgress(calls: CallEntry[]): RecordingProgress {
  const rows: { sessionId: string; stage: ProgressStage; kind: string }[] = [];
  const faults: FaultSwitch = { fault: 'none' };

  function emit(
    kind: 'started' | 'completed',
    sessionId: string,
    stage: ProgressStage,
  ): Result<SessionProgressPayload, DebuggenError> {
    const method = kind === 'started' ? 'stageStarted' : 'stageCompleted';
    calls.push({ actor: 'progress', method, args: [sessionId, stage] });
    rows.push({ sessionId, stage, kind });

    if (faults.fault === 'throw') {
      throw new Error('The synthetic progress emitter failed.');
    }

    if (faults.fault === 'err') {
      return err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'The synthetic row was refused.'));
    }

    return parseSessionProgressPayload({
      sessionId,
      stage,
      status: kind === 'started' ? 'running' : 'done',
      message: kind === 'started' ? 'Removing instrumentation' : 'Instrumentation removed',
    });
  }

  return {
    rows,
    faults,
    stageStarted(sessionId, stage) {
      return emit('started', sessionId, stage);
    },
    stageCompleted(sessionId, stage) {
      return emit('completed', sessionId, stage);
    },
  };
}

/**
 * A complete `BackupStore` that delegates to a real one and logs every call —
 * digests and recorded paths only, never content — so a delete issued by the
 * module under test cannot go unnoticed.
 */
function recordingBackupStore(inner: BackupStore, calls: CallEntry[]): BackupStore {
  const note = (method: string, args: readonly unknown[]): void => {
    calls.push({ actor: 'backups', method, args });
  };

  return {
    sessionId: inner.sessionId,
    sessionDirectory: inner.sessionDirectory,
    locate(originalHash) {
      note('locate', [originalHash]);
      return inner.locate(originalHash);
    },
    locateRecorded(recordedPath, originalHash) {
      note('locateRecorded', [recordedPath, originalHash]);
      return inner.locateRecorded(recordedPath, originalHash);
    },
    put(originalHash, content) {
      note('put', [originalHash]);
      return inner.put(originalHash, content);
    },
    read(originalHash) {
      note('read', [originalHash]);
      return inner.read(originalHash);
    },
    readRecorded(recordedPath, originalHash) {
      note('readRecorded', [recordedPath, originalHash]);
      return inner.readRecorded(recordedPath, originalHash);
    },
    has(originalHash) {
      note('has', [originalHash]);
      return inner.has(originalHash);
    },
    verify(originalHash) {
      note('verify', [originalHash]);
      return inner.verify(originalHash);
    },
    remove(originalHash, options) {
      note('remove', [originalHash]);
      return inner.remove(originalHash, options);
    },
    removeRecorded(recordedPath, originalHash, options) {
      note('removeRecorded', [recordedPath, originalHash]);
      return inner.removeRecorded(recordedPath, originalHash, options);
    },
    removeSessionDirectory() {
      note('removeSessionDirectory', []);
      return inner.removeSessionDirectory();
    },
  };
}

// ---------------------------------------------------------------------------
// The harness: one sandbox, one call log, every double, a scripted engine
// ---------------------------------------------------------------------------

/** What the scripted engine does with one open record. */
type Verdict = 'restore' | 'close' | 'conflict' | 'fail' | 'skip';

/**
 * How the scripted engine behaves as a whole: `script` follows the per-record
 * verdicts; `unanswered` reports the journal-would-not-answer outcome (one
 * failure attributed to no record); `throw` rejects.
 */
type EngineMode = 'script' | 'unanswered' | 'throw';

/** How the scripted context factory answers. */
type ContextMode = 'ok' | 'err' | 'throw' | 'foreign-store';

/** The per-test knobs a case turns before driving the module. */
interface HarnessKnobs {
  contextMode: ContextMode;
  engineMode: EngineMode;

  /** Overrides the scripted engine's own verdict, for the never-improve cases. */
  engineStatus: CleanupOutcome['status'] | undefined;

  /** Called by the scripted engine after it settles each record. */
  afterRecord: ((record: ModificationRecord) => void) | undefined;
}

interface Harness {
  /** The sandbox root; nothing the suite writes lives outside it. */
  readonly root: string;

  /** The `$DEBUGGEN_HOME` stand-in, `0700`. */
  readonly home: string;

  /** The developer's project stand-in, absolute. */
  readonly project: string;

  readonly calls: CallEntry[];
  readonly logs: LogRecord[];
  readonly logger: Logger;
  readonly modifications: MemoryModifications;
  readonly sessions: MemorySessions;
  readonly sink: RecordingSink;
  readonly watcher: RecordingWatcher;
  readonly instrumentation: RecordingDisabler;
  readonly progress: RecordingProgress;
  readonly buildContext: InstrumentationContextFactory;

  /** Every request the context factory received, in order. */
  readonly contextRequests: CleanupContextRequest[];

  /** Every outcome the scripted engine returned, in order. */
  readonly engineResults: {
    readonly cleanup: CleanupOutcome[];
    readonly reconcile: ReconcileOutcome[];
  };

  /** The scripted verdict of each seeded record, by id. */
  readonly verdicts: Map<string, Verdict>;

  /** The conflict report the engine returns for each `conflict` verdict, by record id. */
  readonly conflicts: Map<string, ModificationConflict>;

  /** Sessions whose start-up reconciliation the engine rejects. */
  readonly throwFor: Set<string>;

  readonly knobs: HarnessKnobs;

  /** Mints the next deterministic modification id. */
  mintId(): string;
}

/** Every sandbox this file created, removed after each case. */
const sandboxes: string[] = [];

/** Every runner this file created, disposed after each case so no listener outlives it. */
const runners: { dispose(): void }[] = [];

afterEach(() => {
  for (const runner of runners.splice(0)) {
    runner.dispose();
  }

  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }

  // Back to the refusing default, so no scripted harness survives its case.
  vi.mocked(cleanupSession).mockReset();
  vi.mocked(reconcileModifications).mockReset();
});

function createHarness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dg-cleanup-suite-')));
  sandboxes.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(project);

  const calls: CallEntry[] = [];
  const logs: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });
  const modifications = createMemoryModifications(calls);
  const sessions = createMemorySessions(calls);
  const knobs: HarnessKnobs = {
    contextMode: 'ok',
    engineMode: 'script',
    engineStatus: undefined,
    afterRecord: undefined,
  };
  let minted = 0;
  const contextRequests: CleanupContextRequest[] = [];

  const buildContext: InstrumentationContextFactory = (request) => {
    calls.push({ actor: 'context', method: 'build', args: [request] });
    contextRequests.push(request);

    if (knobs.contextMode === 'throw') {
      throw new Error('The synthetic context factory failed.');
    }

    if (knobs.contextMode === 'err') {
      return err(
        new DebuggenError('FS_UNSAFE_PATH', 'The synthetic state directory was refused.', {
          details: { reason: 'synthetic-refusal' },
        }),
      );
    }

    const storeSessionId =
      knobs.contextMode === 'foreign-store' ? 'ses_lanternforeign' : request.sessionId;

    return ok({
      projectRoot: request.projectRoot,
      backups: recordingBackupStore(
        createBackupStore({ debuggenHome: home, sessionId: storeSessionId }),
        calls,
      ),
      journal: modifications,
      logger,
      now,
      signal: request.signal,
    });
  };

  const harness: Harness = {
    root,
    home,
    project,
    calls,
    logs,
    logger,
    modifications,
    sessions,
    sink: createRecordingSink(calls, sessions),
    watcher: createRecordingWatcher(calls),
    instrumentation: createRecordingDisabler(calls),
    progress: createRecordingProgress(calls),
    buildContext,
    contextRequests,
    engineResults: { cleanup: [], reconcile: [] },
    verdicts: new Map(),
    conflicts: new Map(),
    throwFor: new Set(),
    knobs,
    mintId() {
      minted += 1;
      return `mod_${String(minted).padStart(16, '0')}`;
    },
  };

  installEngine(harness);
  return harness;
}

/** The dependencies `createSessionCleanup` is given, every port a recording double. */
function cleanupDeps(h: Harness, overrides: Partial<SessionCleanupDeps> = {}): SessionCleanupDeps {
  return {
    modifications: h.modifications,
    sessions: h.sessions,
    config: { debuggenHome: h.home },
    buildContext: h.buildContext,
    watcher: h.watcher,
    instrumentation: h.instrumentation,
    progress: h.progress,
    logger: h.logger,
    now,
    ...overrides,
  };
}

/** The dependencies `reconcileModificationsOnStartup` is given. */
function startupDeps(
  h: Harness,
  overrides: Partial<StartupReconciliationDeps> = {},
): StartupReconciliationDeps {
  return {
    modifications: h.modifications,
    sessions: h.sessions,
    config: { debuggenHome: h.home },
    buildContext: h.buildContext,
    watcher: h.watcher,
    logger: h.logger,
    now,
    ...overrides,
  };
}

/** A runner over the harness, disposed after the case. */
function makeRunner(h: Harness, overrides: Partial<SessionCleanupDeps> = {}): SessionCleanup {
  const runner = createSessionCleanup(cleanupDeps(h, overrides));
  runners.push(runner);
  return runner;
}

// ---------------------------------------------------------------------------
// Fixtures, through the real builders and schemas
// ---------------------------------------------------------------------------

/** What a seeded record's project file holds when the module comes to verify it. */
type FileState = 'original' | 'instrumented' | 'edited' | 'absent';

interface SeedInput {
  readonly sessionId: string;
  readonly file: string;
  readonly status?: ModificationStatus;
  readonly fileState?: FileState;

  /** Whether the original is filed in the session's backup store. Defaults to `true`. */
  readonly backup?: boolean;

  /** What the scripted engine does with it. Defaults to `restore`. */
  readonly verdict?: Verdict;
}

interface Seeded {
  readonly record: ModificationRecord;

  /** The absolute path of the project file. */
  readonly path: string;

  readonly originalBytes: string;
  readonly instrumentedBytes: string;
  readonly editedBytes: string;
}

/** A session record, validated by the protocol's own parser. */
function addSession(
  h: Harness,
  id: string,
  status: SessionStatus,
  cleanup: SessionRecord['cleanup'] = { status: 'pending', conflicts: [] },
): SessionRecord {
  const record = unwrap(
    parseSessionRecord({
      id,
      projectRoot: h.project,
      projectName: 'lantern-works',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: FIXED_NOW - 3_600_000,
      updatedAt: SEEDED_AT,
      status,
      question: 'Why does the meridian needle settle so slowly?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup,
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );

  h.sessions.rows.set(id, record);
  return record;
}

/** Marks a capture of the session open, validated by the protocol's capture schema. */
function openCapture(h: Harness, sessionId: string, captureId: string, planVersion = 1): void {
  h.sessions.captures.set(sessionId, {
    sessionId,
    capture: captureRecordSchema.parse({ id: captureId, planVersion, startedAt: SEEDED_AT }),
  });
}

/** The conflict report the engine would compose for a hand-edited file. */
function conflictFor(record: ModificationRecord, editedBytes: string): ModificationConflict {
  return unwrap(
    parseModificationConflict({
      recordId: record.id,
      sessionId: record.sessionId,
      file: record.file,
      reason: 'content-changed',
      expectedHash: record.instrumentedHash,
      actualHash: sha256Hex(editedBytes),
      backupPath: record.backupPath,
      detectedAt: FIXED_NOW,
      message: `${record.file} was edited while instrumented. Debug Generator will not overwrite it.`,
      diffs: { instrumentedToCurrent: `@@ -1 +1 @@ ${DIFF_MARKER}` },
    }),
  );
}

/**
 * Journals one modification through `createModificationRecord`, files its
 * original in the session's real backup store, and writes the project file in
 * the state the case needs the module to find.
 */
async function seedRecord(h: Harness, input: SeedInput): Promise<Seeded> {
  const label = `${input.sessionId}:${input.file}`;
  const originalBytes = `export const face = '${label}'; // ${CONTENT_MARKER} original\n`;
  const instrumentedBytes = `export const face = '${label}'; // ${CONTENT_MARKER} instrumented\n`;
  const editedBytes = `export const face = '${label}'; // ${CONTENT_MARKER} edited by hand\n`;
  const originalHash = sha256Hex(originalBytes);
  const store = createBackupStore({ debuggenHome: h.home, sessionId: input.sessionId });
  const backupPath = unwrap(store.locate(originalHash));

  if (input.backup ?? true) {
    unwrap(await store.put(originalHash, Buffer.from(originalBytes, 'utf8')));
  }

  const path = join(h.project, input.file);
  const fileState = input.fileState ?? 'original';

  if (fileState !== 'absent') {
    mkdirSync(dirname(path), { recursive: true });
    const bytes: Record<Exclude<FileState, 'absent'>, string> = {
      original: originalBytes,
      instrumented: instrumentedBytes,
      edited: editedBytes,
    };
    writeFileSync(path, bytes[fileState]);
  }

  const record = unwrap(
    createModificationRecord(
      {
        sessionId: input.sessionId,
        planVersion: 1,
        file: input.file,
        originalHash,
        backupPath,
        instrumentedHash: sha256Hex(instrumentedBytes),
        diff: `--- a/${input.file}\n+++ b/${input.file}\n@@ -1 +1 @@ ${DIFF_MARKER}\n`,
        status: input.status ?? 'applied',
      },
      { newId: () => h.mintId(), now: () => SEEDED_AT },
    ),
  );
  const verdict = input.verdict ?? 'restore';

  h.modifications.seed(record);
  h.verdicts.set(record.id, verdict);

  if (verdict === 'conflict') {
    h.conflicts.set(record.id, conflictFor(record, editedBytes));
  }

  return { record, path, originalBytes, instrumentedBytes, editedBytes };
}

/** The journal's current copy of a record. */
function journaled(h: Harness, id: string): ModificationRecord | undefined {
  return h.modifications.records.find((record) => record.id === id);
}

// ---------------------------------------------------------------------------
// The scripted engine
// ---------------------------------------------------------------------------

/** What the scripted engine did with one record. */
type Settled =
  | { readonly kind: 'finished'; readonly record: ModificationRecord; readonly closed: boolean }
  | {
      readonly kind: 'conflict';
      readonly record: ModificationRecord;
      readonly conflict: ModificationConflict;
    }
  | {
      readonly kind: 'failed';
      readonly record: ModificationRecord;
      readonly failure: CleanupFailure;
    }
  | { readonly kind: 'skipped'; readonly record: ModificationRecord };

/**
 * The context's clock, which is where the real engine reads `completedAt`. A
 * context that reached the engine without one is a wiring fault this suite
 * wants to see, not a value to paper over.
 */
function engineClock(context: CleanupContext): number {
  const clock = context.now;

  if (clock === undefined) {
    throw new Error('The cleanup context reached the engine without a clock.');
  }

  return clock();
}

/** The engine's own precedence: any conflict, then anything outstanding, then clean. */
function passStatus(conflicts: number, outstanding: number): CleanupOutcome['status'] {
  if (conflicts > 0) {
    return 'conflict';
  }

  return outstanding > 0 ? 'partial' : 'clean';
}

/** Applies one record's scripted verdict through the context's journal, as the real engine does. */
async function settleRecord(
  h: Harness,
  context: CleanupContext,
  record: ModificationRecord,
): Promise<Settled> {
  const verdict = h.verdicts.get(record.id) ?? 'restore';

  switch (verdict) {
    case 'restore':
    case 'close': {
      const moved = unwrap(await context.journal.updateStatus(record.id, 'reverted'));
      return { kind: 'finished', record: moved, closed: verdict === 'close' };
    }
    case 'conflict': {
      const conflict = h.conflicts.get(record.id);

      if (conflict === undefined) {
        throw new Error(`No conflict fixture was seeded for ${record.id}.`);
      }

      const moved = unwrap(await context.journal.updateStatus(record.id, 'conflict'));
      return { kind: 'conflict', record: moved, conflict };
    }
    case 'fail':
      return {
        kind: 'failed',
        record,
        failure: {
          recordId: record.id,
          sessionId: record.sessionId,
          file: record.file,
          error: new DebuggenError('STORE_ERROR', 'The synthetic journal refused the transition.'),
        },
      };
    case 'skip':
      return { kind: 'skipped', record };
  }
}

/** The scripted `cleanupSession`: one session's open records, honouring the signal between records. */
async function scriptedCleanupSession(
  h: Harness,
  sessionId: string,
  context: CleanupContext,
): Promise<CleanupOutcome> {
  h.calls.push({ actor: 'engine', method: 'cleanupSession', args: [sessionId] });

  if (h.knobs.engineMode === 'throw') {
    throw new Error('The synthetic engine crashed.');
  }

  if (h.knobs.engineMode === 'unanswered') {
    return {
      sessionId,
      status: 'partial',
      restored: [],
      conflicts: [],
      completedAt: engineClock(context),
      skipped: [],
      failures: [
        {
          recordId: '',
          sessionId,
          file: '',
          error: new DebuggenError('STORE_ERROR', 'The synthetic journal did not answer.'),
        },
      ],
      forks: [],
    };
  }

  const restored: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];
  const work = h.modifications.openRecords().filter((record) => record.sessionId === sessionId);

  for (const [index, record] of work.entries()) {
    if (context.signal?.aborted === true) {
      skipped.push(...work.slice(index));
      break;
    }

    const settled = await settleRecord(h, context, record);

    if (settled.kind === 'finished') {
      restored.push(settled.record);
    } else if (settled.kind === 'conflict') {
      conflicts.push(settled.conflict);
      skipped.push(settled.record);
    } else if (settled.kind === 'failed') {
      failures.push(settled.failure);
      skipped.push(settled.record);
    } else {
      skipped.push(settled.record);
    }

    h.knobs.afterRecord?.(record);
  }

  const outcome: CleanupOutcome = {
    sessionId,
    status: h.knobs.engineStatus ?? passStatus(conflicts.length, skipped.length + failures.length),
    restored,
    conflicts,
    completedAt: engineClock(context),
    skipped,
    failures,
    forks: [],
  };

  h.engineResults.cleanup.push(outcome);
  return outcome;
}

/** The scripted `reconcileModifications`: the open records of the sessions it is narrowed to. */
async function scriptedReconcile(
  h: Harness,
  context: CleanupContext,
  options: ReconcileOptions | undefined,
): Promise<ReconcileOutcome> {
  h.calls.push({ actor: 'engine', method: 'reconcileModifications', args: [options] });
  const sessionIds = options?.sessionIds;

  if (sessionIds?.some((sessionId) => h.throwFor.has(sessionId)) === true) {
    throw new Error('The synthetic engine crashed.');
  }

  const restored: ModificationRecord[] = [];
  const closed: ModificationRecord[] = [];
  const retained: ModificationRecord[] = [];
  const conflicts: ModificationConflict[] = [];
  const skipped: ModificationRecord[] = [];
  const failures: CleanupFailure[] = [];
  const work = h.modifications
    .openRecords()
    .filter((record) => sessionIds === undefined || sessionIds.includes(record.sessionId));

  for (const record of work) {
    const settled = await settleRecord(h, context, record);

    if (settled.kind === 'finished') {
      (settled.closed ? closed : restored).push(settled.record);
    } else if (settled.kind === 'conflict') {
      conflicts.push(settled.conflict);
      retained.push(settled.record);
    } else if (settled.kind === 'failed') {
      failures.push(settled.failure);
      skipped.push(settled.record);
    } else {
      skipped.push(settled.record);
    }

    h.knobs.afterRecord?.(record);
  }

  const outcome: ReconcileOutcome = {
    status:
      h.knobs.engineStatus ??
      passStatus(conflicts.length, retained.length + skipped.length + failures.length),
    examined: work.length,
    restored,
    closed,
    retained,
    conflicts,
    skipped,
    failures,
    forks: [],
    completedAt: engineClock(context),
  };

  h.engineResults.reconcile.push(outcome);
  return outcome;
}

/** Points both mocked engine entry points at this harness's scripts. */
function installEngine(h: Harness): void {
  vi.mocked(cleanupSession).mockImplementation((sessionId, context) =>
    scriptedCleanupSession(h, sessionId, context),
  );
  vi.mocked(reconcileModifications).mockImplementation((context, options) =>
    scriptedReconcile(h, context, options),
  );
}

// ---------------------------------------------------------------------------
// Static inspection of the module under test
// ---------------------------------------------------------------------------

/** `./cleanup.ts` as it is on disk, next to this file. */
const CLEANUP_SOURCE = readFileSync(
  fileURLToPath(new URL('./cleanup.ts', import.meta.url)),
  'utf8',
);

/**
 * The module's code with its comments removed, so a sentence in its
 * documentation cannot satisfy or fail a code assertion. Block comments first,
 * then line comments that are not part of a string (the module holds no URL
 * literal, so `//` inside a string does not arise).
 */
const CLEANUP_CODE = CLEANUP_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*$/gm, '');

/** Every single-, double- or back-quoted string literal in the module's code. */
const CLEANUP_STRINGS: readonly string[] = [
  ...CLEANUP_CODE.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g),
].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

/** One import declaration of the module. */
interface ImportDeclaration {
  readonly from: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}

/** Every import of the module: `import [type] { names } from 'specifier'` and side-effect imports. */
const CLEANUP_IMPORTS: readonly ImportDeclaration[] = [
  ...[...CLEANUP_CODE.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)].map(
    (match): ImportDeclaration => ({
      from: match[3] ?? '',
      typeOnly: match[1] !== undefined,
      names: (match[2] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    }),
  ),
  ...[...CLEANUP_CODE.matchAll(/import\s+(?:(?:\*\s+as\s+\w+|\w+)\s+from\s+)?'([^']+)'/g)].map(
    (match): ImportDeclaration => ({ from: match[1] ?? '', typeOnly: false, names: [] }),
  ),
];

/** The value (not type-only) names the module imports from one specifier. */
function valuesImportedFrom(specifier: string): string[] {
  return CLEANUP_IMPORTS.filter((entry) => entry.from === specifier && !entry.typeOnly).flatMap(
    (entry) => entry.names,
  );
}

/** Every specifier the module imports from. */
const CLEANUP_SPECIFIERS: readonly string[] = [
  ...new Set(CLEANUP_IMPORTS.map((entry) => entry.from)),
];

/** A copy of a session record without its `cleanup` sub-object, for "nothing else changed". */
function withoutCleanup(record: SessionRecord | undefined): Partial<SessionRecord> | undefined {
  if (record === undefined) {
    return undefined;
  }

  const copy: Partial<SessionRecord> = { ...record };
  delete copy.cleanup;
  return copy;
}

/** The ids `updateStatus` moved to `status`, in order. */
function movedTo(h: Harness, status: ModificationStatus): unknown[] {
  return callsOf(h, 'modifications', 'updateStatus')
    .filter((call) => call.args[1] === status)
    .map((call) => call.args[0]);
}

/**
 * Seeds one open record in each owning state the start-up pass must not filter
 * on — a session that `failed`, one still `capturing`, one `generated`, and one
 * that ended with a cleanup that stopped part-way — plus a record whose session
 * row is gone. Seeded out of sorted order, so any ordering the report shows is
 * the module's own.
 */
async function seedEveryOwningState(
  h: Harness,
): Promise<{ readonly owned: ReadonlyMap<string, Seeded>; readonly orphan: Seeded }> {
  addSession(h, SESSION.midCleanup, 'ended', {
    status: 'partial',
    completedAt: SEEDED_AT,
    conflicts: [],
  });
  addSession(h, SESSION.failed, 'failed');
  addSession(h, SESSION.generated, 'generated');
  addSession(h, SESSION.capturing, 'capturing');

  const owned = new Map<string, Seeded>();
  const plan: readonly (readonly [string, string, ModificationStatus])[] = [
    [SESSION.midCleanup, FILE.gauge, 'failed'],
    [SESSION.failed, FILE.dial, 'applied'],
    [SESSION.generated, FILE.bezel, 'pending'],
    [SESSION.capturing, FILE.needle, 'applied'],
  ];

  for (const [sessionId, file, status] of plan) {
    owned.set(sessionId, await seedRecord(h, { sessionId, file, status }));
  }

  const orphan = await seedRecord(h, {
    sessionId: SESSION.missing,
    file: FILE.drift,
    fileState: 'instrumented',
  });

  return { owned, orphan };
}

/** The two start-up entry points, which must behave identically. */
const RECONCILE_ENTRY_POINTS: readonly {
  readonly name: string;
  readonly reconcile: (
    h: Harness,
    overrides?: Partial<SessionCleanupDeps>,
  ) => Promise<Result<StartupReconciliationReport, DebuggenError>>;
}[] = [
  {
    name: 'reconcileModificationsOnStartup',
    reconcile: (h, overrides = {}) => reconcileModificationsOnStartup(startupDeps(h, overrides)),
  },
  {
    name: 'SessionCleanup.reconcileAll',
    reconcile: (h, overrides = {}) => makeRunner(h, overrides).reconcileAll(),
  },
];

// ---------------------------------------------------------------------------
// Invariant 4 — the start-up reconciliation set is never scoped by session status
// ---------------------------------------------------------------------------

describe('invariant 4 — the reconciliation set is never scoped by session status', () => {
  describe.each(RECONCILE_ENTRY_POINTS)('$name', ({ reconcile }) => {
    it('builds its set from listAllOpen() alone and hands every owning status to the engine', async () => {
      const h = createHarness();
      const { owned } = await seedEveryOwningState(h);
      const statusBefore = new Map(
        [...h.sessions.rows.values()].map((session) => [session.id, session.status]),
      );

      const report = unwrap(await reconcile(h));

      // One unfiltered read of the whole journal, before anything else is read.
      const journalCalls = callsOf(h, 'modifications');
      expect(journalCalls[0]?.method).toBe('listAllOpen');
      expect(callsOf(h, 'modifications', 'listAllOpen')).toEqual([
        { actor: 'modifications', method: 'listAllOpen', args: [] },
      ]);

      // No status- or session-scoped listing is used to build the set.
      const reads = new Set(journalCalls.map((call) => call.method));
      expect([...reads].sort()).toEqual(['listAllOpen', 'updateStatus']);

      // Every owning session reaches the engine, one at a time, in sorted order.
      const reached = vi
        .mocked(reconcileModifications)
        .mock.calls.flatMap(([, options]) => options?.sessionIds ?? []);
      expect(reached).toEqual(
        [SESSION.capturing, SESSION.failed, SESSION.generated, SESSION.midCleanup].sort(),
      );
      expect(new Set(reached.map((id) => statusBefore.get(id)))).toEqual(
        new Set<SessionStatus>(['failed', 'capturing', 'generated', 'ended']),
      );

      // Nothing any journal or engine call carried names a session status.
      const carried = stringLeaves([
        ...callsOf(h, 'modifications').map((call) => call.args),
        ...callsOf(h, 'engine').map((call) => call.args),
      ]);
      expect(
        carried.filter((value) => (SESSION_STATUSES as readonly string[]).includes(value)),
      ).toEqual([]);

      // Every owned record was put back, whatever its session's state.
      for (const seeded of owned.values()) {
        expect(journaled(h, seeded.record.id)?.status).toBe('reverted');
        expect(report.bySession[seeded.record.sessionId]?.restored).toBe(1);
      }

      expect(report.scanned).toBe(5);
      expect(report.restored).toBe(4);
    });

    it('leaves a record whose session row is gone exactly as it is, counted unresolved', async () => {
      const h = createHarness();
      const { orphan } = await seedEveryOwningState(h);

      const report = unwrap(await reconcile(h, { outcomeSink: h.sink }));

      expect(report.bySession[SESSION.missing]).toEqual({
        sessionId: SESSION.missing,
        status: 'partial',
        scanned: 1,
        restored: 0,
        closed: 0,
        conflicts: 0,
        skipped: 0,
        failed: 0,
        unresolved: 1,
      });
      expect(report.unresolved).toBe(1);
      expect(report.status).toBe('partial');

      // No project root was guessed: no context, no engine pass, no journal write.
      expect(h.contextRequests.map((request) => request.sessionId)).not.toContain(SESSION.missing);
      expect(
        vi
          .mocked(reconcileModifications)
          .mock.calls.flatMap(([, options]) => options?.sessionIds ?? []),
      ).not.toContain(SESSION.missing);
      expect(callsOf(h, 'modifications', 'updateStatus').map((call) => call.args[0])).not.toContain(
        orphan.record.id,
      );
      expect(journaled(h, orphan.record.id)).toEqual(orphan.record);

      // The backup and the patched file are byte-for-byte what they were.
      expect(readFileSync(orphan.record.backupPath, 'utf8')).toBe(orphan.originalBytes);
      expect(readFileSync(orphan.path, 'utf8')).toBe(orphan.instrumentedBytes);

      // Nothing is reported for a session nobody can show it to.
      expect(h.sink.delivered.map((delivery) => delivery.sessionId)).not.toContain(SESSION.missing);
      expect(h.sessions.updates).toEqual([]);
    });

    it('arms no runtime hook and disarms none: no producer is connected before the service serves', async () => {
      const h = createHarness();
      await seedEveryOwningState(h);

      unwrap(await reconcile(h));

      expect(callsOf(h, 'instrumentation')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// The watcher is released, and the hooks disarmed, before the first restore
// ---------------------------------------------------------------------------

describe('the watcher and the hooks are released before the first restore', () => {
  it('stops the watcher, disarms and releases the session strictly before the engine runs', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(outcome.status).toBe('clean');

    // The watcher's one mutation is `applied → conflict` whenever a watched
    // file's digest stops matching `instrumentedHash` — and a restore write is
    // exactly such a change. Were it still watching when the engine wrote the
    // originals back, every file this pass restored would be flipped to a
    // phantom `conflict`. So it must be stopped strictly before the engine, and
    // the runtime hooks disarmed before any file changes under a live page.
    const engineAt = firstIndex(h, 'engine.cleanupSession');
    expect(engineAt).toBeGreaterThan(-1);
    expect(order(h).slice(0, engineAt + 1)).toEqual([
      'instrumentation.isInstalling',
      'sessions.get',
      'sessions.getActiveCapture',
      'watcher.stopSession',
      'instrumentation.disarmCapture',
      'instrumentation.stopSession',
      'context.build',
      'progress.stageStarted',
      'engine.cleanupSession',
    ]);
    expect(firstIndex(h, 'watcher.stopSession')).toBeLessThan(
      firstIndex(h, 'modifications.updateStatus'),
    );
    expect(h.watcher.stopped).toEqual([SESSION.generated]);
    expect(h.progress.rows).toEqual([
      { sessionId: SESSION.generated, stage: 'cleanup', kind: 'started' },
      { sessionId: SESSION.generated, stage: 'cleanup', kind: 'completed' },
    ]);
    expect(firstIndex(h, 'progress.stageCompleted')).toBeGreaterThan(engineAt);
  });

  it('stops the watcher for each session before that session is reconciled at start-up', async () => {
    const h = createHarness();
    await seedEveryOwningState(h);

    unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    const log = h.calls;
    const engineCalls = vi.mocked(reconcileModifications).mock.calls;
    expect(engineCalls).toHaveLength(4);

    for (const [, options] of engineCalls) {
      const [sessionId] = options?.sessionIds ?? [];
      const engineAt = log.findIndex(
        (call) =>
          call.actor === 'engine' && stringLeaves(call.args).includes(sessionId ?? '<none>'),
      );
      const stoppedAt = log.findIndex(
        (call) => call.actor === 'watcher' && call.args[0] === sessionId,
      );

      expect(stoppedAt).toBeGreaterThan(-1);
      expect(stoppedAt).toBeLessThan(engineAt);
    }
  });

  it('still restores when the watcher cannot be stopped, and says so', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.watcher.faults.fault = 'throw';

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(outcome.status).toBe('clean');
    expect(firstIndex(h, 'watcher.stopSession')).toBeLessThan(
      firstIndex(h, 'engine.cleanupSession'),
    );
    expect(
      h.logs.some(
        (record) =>
          record.level === 'warn' &&
          record.message.includes('conflict watcher could not be stopped'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — runtime hooks are disabled by delegation
// ---------------------------------------------------------------------------

describe('invariant 3 — runtime hooks are disabled by delegation', () => {
  it('disarms and releases each session exactly once, and the disarm names no capture', async () => {
    const h = createHarness();
    addSession(h, SESSION.capturing, 'capturing');
    addSession(h, SESSION.generated, 'generated');
    openCapture(h, SESSION.capturing, 'cap_lanternopen01');
    await seedRecord(h, { sessionId: SESSION.capturing, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    const runner = makeRunner(h);

    unwrap(await runner.run(SESSION.capturing));
    unwrap(await runner.run(SESSION.generated));

    expect(h.instrumentation.disarmed).toEqual([
      { sessionId: SESSION.capturing, projectRoot: h.project },
      { sessionId: SESSION.generated, projectRoot: h.project },
    ]);

    for (const request of h.instrumentation.disarmed) {
      expect(Object.keys(request).sort()).toEqual(['projectRoot', 'sessionId']);
      expect('captureId' in request).toBe(false);
    }

    expect(h.instrumentation.released).toEqual([SESSION.capturing, SESSION.generated]);

    // The open capture was read — it names the log context — and went no further.
    expect(callsOf(h, 'sessions', 'getActiveCapture')).toHaveLength(2);
    expect(h.logs.some((record) => record.fields['captureId'] === 'cap_lanternopen01')).toBe(true);
    expect(stringLeaves(h.instrumentation.disarmed)).not.toContain('cap_lanternopen01');
  });

  it('builds no agent or preload configuration and addresses no message of its own', () => {
    // The dormant page-agent configuration and the capture-less preload
    // configuration are built and sent by `../instrumentation/service.ts`; a
    // second copy here would drift from the one the agents actually obey.
    for (const type of ['agent.config', 'server-agent.config', 'agent.ready']) {
      expect(CLEANUP_STRINGS.filter((literal) => literal.includes(type))).toEqual([]);
    }

    const agentLiteral = AGENT_HOOK_KEYS.map(
      (key) => new RegExp(`\\b${key}\\s*:\\s*(?:true|false)\\b`),
    );
    const preloadLiteral = SERVER_AGENT_SIGNAL_KEYS.map((key) =>
      key === 'functions'
        ? new RegExp(`\\b${key}\\s*:\\s*\\[`)
        : new RegExp(`\\b${key}\\s*:\\s*(?:true|false)\\b`),
    );

    // The payload members of the two configuration frames, written as object
    // properties (`{ hooks: … }`, `, signals: …`) — a parameter named `signals`
    // is not one.
    for (const pattern of [
      ...agentLiteral,
      ...preloadLiteral,
      /(?:^|[{,])\s*hooks\s*:/m,
      /(?:^|[{,])\s*signals\s*:/m,
      /(?:^|[{,])\s*captureId\s*:/m,
    ]) {
      expect(pattern.test(CLEANUP_CODE), `cleanup.ts restates ${pattern.source}`).toBe(false);
    }

    const instrumentationValues = valuesImportedFrom('@debuggen/instrumentation');
    for (const restated of [
      'DORMANT_AGENT_HOOK_CONFIG',
      'DISABLED_SERVER_AGENT_SIGNALS',
      'deriveAgentHookConfig',
      'deriveServerAgentSignals',
      'AGENT_HOOK_KEYS',
      'SERVER_AGENT_SIGNAL_KEYS',
    ]) {
      expect(instrumentationValues).not.toContain(restated);
    }

    // From protocol the module takes one vocabulary and nothing that builds a frame.
    expect(valuesImportedFrom('@debuggen/protocol')).toEqual(['CLEANUP_STATUSES']);
    expect(/\bcreateEnvelope\b|\bMESSAGE_TYPES\b|\bbroadcast\w*\(/.test(CLEANUP_CODE)).toBe(false);
  });

  it('never stops, kills or relaunches a dev server', async () => {
    expect(
      CLEANUP_SPECIFIERS.filter((specifier) => /dev-server|child_process/.test(specifier)),
    ).toEqual([]);
    expect(/\.kill\(|\bspawn\(|\bexecFile\(|\bfork\(|\blaunch\w*\(/.test(CLEANUP_CODE)).toBe(false);

    // At runtime the only instrumentation-side calls a pass makes are the port's own.
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');

    expect(isOk(await makeRunner(h).run(SESSION.generated))).toBe(true);
    expect([...new Set(callsOf(h, 'instrumentation').map((call) => call.method))].sort()).toEqual([
      'disarmCapture',
      'isInstalling',
      'stopSession',
    ]);
  });

  it.each(['err', 'throw'] as const)(
    'keeps restoring when the disarm answers %s, but reports partial: a failed disarm is no disarm',
    async (fault) => {
      const h = createHarness();
      addSession(h, SESSION.generated, 'generated');
      const seeded = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
      h.instrumentation.faults.fault = fault;
      const runner = makeRunner(h, { outcomeSink: h.sink });

      const outcome = unwrap(await runner.run(SESSION.generated));

      // The files are put back regardless — a live hook is never a reason to
      // leave a patch in place — but whether the hooks are dormant is unknown.
      expect(outcome.status).toBe('partial');
      expect(journaled(h, seeded.record.id)?.status).toBe('reverted');
      expect(readFileSync(seeded.path, 'utf8')).toBe(seeded.originalBytes);
      expect(h.instrumentation.released).toEqual([SESSION.generated]);

      const warning = h.logs.find((record) =>
        record.message.includes('runtime hooks could not be disarmed'),
      );
      expect(warning?.fields['code']).toBe('TRANSPORT_DISCONNECTED');

      // An unknown outcome is never upgraded: no confirmation can vouch for it.
      h.instrumentation.confirmDormancy(SESSION.generated);
      await drained();
      expect(h.sink.delivered).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Runtime-hook dormancy — only a delivery receipt confirms a disarm
// ---------------------------------------------------------------------------

/**
 * Lets every promise the runner started from a listener settle: `setImmediate`
 * runs after the microtask queue has drained.
 */
function drained(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The sink deliveries whose verdict is `clean`: the upgrades, never a pass's own return. */
function upgrades(h: Harness): SessionCleanupOutcome[] {
  return h.sink.delivered
    .filter((delivery) => delivery.outcome.status === 'clean')
    .map((delivery) => delivery.outcome);
}

describe('runtime-hook dormancy — a disarm nobody received is not a clean end', () => {
  it('reports partial with every file restored when producers did not receive the dormant configuration', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const seeded = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['server-agent', 'page-agent']);

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(outcome).toEqual({ status: 'partial', conflicts: [], completedAt: FIXED_NOW });
    expect(journaled(h, seeded.record.id)?.status).toBe('reverted');
    expect(readFileSync(seeded.path, 'utf8')).toBe(seeded.originalBytes);

    // The shortfall is named by producer kind, deduplicated and sorted.
    const warning = h.logs.find((record) =>
      record.message.includes('did not receive the dormant configuration'),
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.fields['pendingProducers']).toEqual(['page-agent', 'server-agent']);
    expect(warning?.fields['count']).toBe(2);

    const finished = h.logs.find((record) => record.message === 'session cleanup finished');
    expect(finished?.fields).toMatchObject({
      cleanup: 'partial',
      files: 'clean',
      hooksDormant: false,
    });
  });

  it('reports partial for a disarm outcome that does not say who received it, and never upgrades it', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const seeded = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, 'unreported');
    const runner = makeRunner(h, { outcomeSink: h.sink });

    const outcome = unwrap(await runner.run(SESSION.generated));

    expect(outcome.status).toBe('partial');
    expect(journaled(h, seeded.record.id)?.status).toBe('reverted');
    expect(
      h.logs.some((record) =>
        record.message.includes('did not report which producers received the dormant'),
      ),
    ).toBe(true);

    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(h.sink.delivered).toEqual([]);
  });

  it('answers clean when the receipt names no undelivered producer, or no instrumentation is wired', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    addSession(h, SESSION.failed, 'failed');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.failed, file: FILE.needle });

    expect(unwrap(await makeRunner(h).run(SESSION.generated)).status).toBe('clean');
    expect(
      unwrap(await makeRunner(h, { instrumentation: undefined }).run(SESSION.failed)).status,
    ).toBe('clean');
  });

  it('upgrades the verdict to clean through the sink exactly once when the service confirms dormancy', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    const outcome = unwrap(await runner.run(SESSION.generated));

    // Invariant 6: the pass returns its verdict and delivers nothing itself.
    expect(outcome.status).toBe('partial');
    expect(h.sink.delivered).toEqual([]);

    // `SessionManager.end` records what `run` returned.
    unwrap(await h.sink.recordCleanupOutcome(SESSION.generated, outcome));
    expect(h.sessions.rows.get(SESSION.generated)?.cleanup.status).toBe('partial');

    // A later replay delivers the dormant configuration; the service says so.
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();

    expect(h.sink.delivered.map((delivery) => delivery.sessionId)).toEqual([
      SESSION.generated,
      SESSION.generated,
    ]);
    expect(upgrades(h)).toEqual([{ status: 'clean', conflicts: [], completedAt: FIXED_NOW }]);
    expect(h.sessions.rows.get(SESSION.generated)?.cleanup).toEqual({
      status: 'clean',
      completedAt: FIXED_NOW,
      conflicts: [],
    });

    // The status is the manager's; this module wrote nothing through `update`.
    expect(h.sessions.updates).toEqual([]);
    expect(h.sessions.rows.get(SESSION.generated)?.status).toBe(stored.status);

    // Once: a second confirmation finds nothing remembered.
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(upgrades(h)).toHaveLength(1);
  });

  it('without a sink, upgrades only the cleanup sub-object and never the status', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['server-agent']);
    const runner = makeRunner(h);

    const outcome = unwrap(await runner.run(SESSION.generated));
    h.sessions.rows.set(SESSION.generated, { ...stored, cleanup: storedCleanup(outcome) });

    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();

    expect(h.sessions.updates).toHaveLength(1);
    const [written] = h.sessions.updates;
    expect(written?.cleanup).toEqual({ status: 'clean', completedAt: FIXED_NOW, conflicts: [] });
    expect(written?.status).toBe(stored.status);
    expect(withoutCleanup(written)).toEqual(withoutCleanup(stored));
  });

  it.each([
    ['a conflict', 'conflict', 'conflict'],
    ['a record it could not finish', 'fail', 'partial'],
  ] as const)('never upgrades a pass whose files left %s', async (_label, verdict, expected) => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: verdict === 'conflict' ? 'edited' : 'original',
      verdict,
    });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    const outcome = unwrap(await runner.run(SESSION.generated));
    expect(outcome.status).toBe(expected);
    unwrap(await h.sink.recordCleanupOutcome(SESSION.generated, outcome));

    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();

    expect(h.sink.delivered).toHaveLength(1);
    expect(upgrades(h)).toEqual([]);
  });

  it('leaves a later, worse verdict on the session as it is', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    unwrap(await runner.run(SESSION.generated));
    h.sessions.rows.set(SESSION.generated, {
      ...stored,
      cleanup: { status: 'conflict', completedAt: FIXED_NOW, conflicts: [] },
    });

    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();

    expect(h.sink.delivered).toEqual([]);
    expect(h.sessions.rows.get(SESSION.generated)?.cleanup.status).toBe('conflict');
  });

  it('lets a later pass supersede the remembered one and ignores a confirmation while it runs', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    expect(unwrap(await runner.run(SESSION.generated)).status).toBe('partial');

    // The next pass waits for a reconciliation, so it is in flight when the
    // confirmation for the first one arrives; its own receipt decides.
    h.instrumentation.pendingFor.delete(SESSION.generated);
    const reconciling = runner.reconcileAll();
    const again = runner.run(SESSION.generated);
    h.instrumentation.confirmDormancy(SESSION.generated);

    const [, second] = await Promise.all([reconciling, again]);
    await drained();

    expect(unwrap(second).status).toBe('clean');
    expect(h.sink.delivered).toEqual([]);

    // Nothing is remembered any more.
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(h.sink.delivered).toEqual([]);
  });

  it('counts a confirmation that arrives while the pass is still restoring after its disarm', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    // The page agent reconnects between two restores, and the replay delivers
    // the dormant configuration the disarm could not.
    let confirmed = false;
    h.knobs.afterRecord = () => {
      if (!confirmed) {
        confirmed = true;
        h.instrumentation.confirmDormancy(SESSION.generated);
      }
    };

    const outcome = unwrap(await runner.run(SESSION.generated));

    expect(firstIndex(h, 'instrumentation.disarmCapture')).toBeLessThan(
      firstIndex(h, 'engine.cleanupSession'),
    );
    expect(outcome.status).toBe('clean');
    expect(
      h.logs.find((record) => record.message === 'session cleanup finished')?.fields,
    ).toMatchObject({ cleanup: 'clean', hooksDormant: true });

    // Settled by the pass itself: nothing is remembered, nothing is delivered.
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(h.sink.delivered).toEqual([]);
  });

  it('upgrades nothing after dispose, and releases its subscription', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.pendingFor.set(SESSION.generated, ['page-agent']);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    expect(h.instrumentation.listeners.size).toBe(1);
    expect(unwrap(await runner.run(SESSION.generated)).status).toBe('partial');

    runner.dispose();
    expect(h.instrumentation.listeners.size).toBe(0);

    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(h.sink.delivered).toEqual([]);
  });

  it('still cleans up when the confirmation subscription throws, and says so', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const instrumentation: InstrumentationDisabler = {
      disarmCapture: (request) => h.instrumentation.disarmCapture(request),
      stopSession: (sessionId) => h.instrumentation.stopSession(sessionId),
      onDormancyConfirmed: () => {
        throw new Error('The synthetic subscription failed.');
      },
    };

    const outcome = unwrap(await makeRunner(h, { instrumentation }).run(SESSION.generated));

    expect(outcome.status).toBe('clean');
    expect(
      h.logs.some(
        (record) =>
          record.level === 'warn' &&
          record.message.includes('dormancy confirmations could not be subscribed to'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Outcome delivery — one writer, one broadcaster
// ---------------------------------------------------------------------------

describe('outcome delivery — one writer, one broadcaster', () => {
  it('returns the outcome once for SessionManager.end to record, and delivers nothing itself', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });

    const result = await makeRunner(h, { outcomeSink: h.sink }).run(SESSION.generated);
    const outcome = unwrap(result);

    // Exactly the three fields the manager records and broadcasts.
    expect(Object.keys(outcome).sort()).toEqual(['completedAt', 'conflicts', 'status']);
    expect(CLEANUP_STATUSES).toContain(outcome.status);
    expect(outcome.status).toBe('conflict');
    expect(outcome.completedAt).toBe(FIXED_NOW);

    // `run` is called by `SessionManager.end`, which records the value `run`
    // returns through `recordCleanupOutcome` and emits the single
    // cleanup-completed message. That returned value IS the one delivery: a
    // runner that also called the sink would put two identical reports in
    // front of the developer.
    expect(h.sink.delivered).toEqual([]);
    expect(callsOf(h, 'sink')).toEqual([]);
    expect(h.sessions.updates).toEqual([]);
    expect(h.sessions.rows.get(SESSION.generated)).toEqual(stored);
  });

  it('hands each reconciled session to the sink exactly once, stamped by the injected clock', async () => {
    const h = createHarness();
    const before = [
      addSession(h, SESSION.generated, 'generated'),
      addSession(h, SESSION.failed, 'failed'),
      addSession(h, SESSION.capturing, 'capturing'),
    ];
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const conflicted = await seedRecord(h, {
      sessionId: SESSION.failed,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });
    await seedRecord(h, { sessionId: SESSION.capturing, file: FILE.bezel, verdict: 'fail' });

    const report = unwrap(
      await reconcileModificationsOnStartup(startupDeps(h, { outcomeSink: h.sink })),
    );

    expect(h.sink.delivered.map((delivery) => delivery.sessionId)).toEqual([
      SESSION.capturing,
      SESSION.failed,
      SESSION.generated,
    ]);
    expect(h.sink.delivered.map((delivery) => delivery.outcome)).toEqual([
      { status: 'partial', conflicts: [], completedAt: FIXED_NOW },
      {
        status: 'conflict',
        conflicts: [h.conflicts.get(conflicted.record.id)],
        completedAt: FIXED_NOW,
      },
      { status: 'clean', conflicts: [], completedAt: FIXED_NOW },
    ]);

    for (const { outcome } of h.sink.delivered) {
      expect(Object.keys(outcome).sort()).toEqual(['completedAt', 'conflicts', 'status']);
      expect(CLEANUP_STATUSES).toContain(outcome.status);
    }

    // The manager writes the session; this module wrote nothing through `update`.
    expect(h.sessions.updates).toEqual([]);

    for (const original of before) {
      expect(h.sessions.rows.get(original.id)?.status).toBe(original.status);
    }

    expect(report.completedAt).toBe(FIXED_NOW);
  });

  it('without a sink, writes only the cleanup sub-object and never the status', async () => {
    const h = createHarness();
    const before = [
      addSession(h, SESSION.generated, 'generated'),
      addSession(h, SESSION.failed, 'failed'),
    ];
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const conflicted = await seedRecord(h, {
      sessionId: SESSION.failed,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });

    unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    expect(h.sessions.updates.map((record) => record.id)).toEqual([
      SESSION.failed,
      SESSION.generated,
    ]);

    for (const original of before) {
      const written = h.sessions.updates.find((record) => record.id === original.id);

      expect(written?.status).toBe(original.status);
      expect(withoutCleanup(written)).toEqual(withoutCleanup(original));
    }

    expect(h.sessions.updates.map((record) => record.cleanup)).toEqual([
      {
        status: 'conflict',
        completedAt: FIXED_NOW,
        conflicts: [h.conflicts.get(conflicted.record.id)],
      },
      { status: 'clean', completedAt: FIXED_NOW, conflicts: [] },
    ]);
  });

  it('publishes no cleanup-completed message of its own', () => {
    expect(CLEANUP_STRINGS.filter((literal) => literal.includes('cleanup.completed'))).toEqual([]);
    expect(
      CLEANUP_IMPORTS.some((entry) =>
        entry.names.some((name) => /^(?:createEnvelope|cleanupCompleted\w*)$/.test(name)),
      ),
    ).toBe(false);
  });

  it('binds its trigger on every record of a pass', async () => {
    expect(CLEANUP_TRIGGERS).toEqual(['session-end', 'deactivate', 'service-start']);

    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const runner = makeRunner(h);

    unwrap(await runner.run(SESSION.generated, { trigger: 'deactivate' }));
    const ended = h.logs.splice(0);
    expect(ended.length).toBeGreaterThan(0);
    expect(ended.every((record) => record.fields['trigger'] === 'deactivate')).toBe(true);

    unwrap(await runner.reconcileAll());
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.every((record) => record.fields['trigger'] === 'service-start')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — a developer-edited file is never overwritten
// ---------------------------------------------------------------------------

describe('invariant 1 — a developer-edited file is never overwritten', () => {
  it('carries the conflict through unchanged, reverts only what was restored and relaxes nothing', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const restored = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const edited = await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(outcome.status).toBe('conflict');

    // The engine's own report, by identity: not re-worded, not re-shaped.
    const reported = h.conflicts.get(edited.record.id);
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toBe(reported);
    expect(outcome.conflicts.map((conflict) => isOk(parseModificationConflict(conflict)))).toEqual([
      true,
    ]);

    // Only the restored record is reverted; the edited file is as it was left.
    expect(movedTo(h, 'reverted')).toEqual([restored.record.id]);
    expect(movedTo(h, 'reverted')).not.toContain(edited.record.id);
    expect(readFileSync(edited.path, 'utf8')).toBe(edited.editedBytes);
    expect(readFileSync(edited.record.backupPath, 'utf8')).toBe(edited.originalBytes);

    // The engine is called with the session and its context — no third argument
    // through which a scope, a conflict wording or a backup reading could relax it.
    const calls = vi.mocked(cleanupSession).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.[0]).toBe(SESSION.generated);
  });

  it('asks the start-up engine for one session at a time and for nothing more', async () => {
    const h = createHarness();
    await seedEveryOwningState(h);

    unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    const calls = vi.mocked(reconcileModifications).mock.calls;
    expect(calls).toHaveLength(4);

    for (const [context, options] of calls) {
      expect(Object.keys(options ?? {})).toEqual(['sessionIds']);
      expect(options?.sessionIds).toHaveLength(1);
      expect(context.journal).toBe(h.modifications);
      expect(context.projectRoot).toBe(h.project);
      expect(context.backups.sessionId).toBe(options?.sessionIds?.[0]);
    }
  });

  it('re-reports a retained conflict at every start without writing over the edit', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed');
    const edited = await seedRecord(h, {
      sessionId: SESSION.failed,
      file: FILE.needle,
      status: 'conflict',
      fileState: 'edited',
      verdict: 'conflict',
    });

    for (let pass = 0; pass < 2; pass += 1) {
      const report = unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

      expect(report.bySession[SESSION.failed]?.status).toBe('conflict');
      expect(report.conflicts).toBe(1);
      expect(readFileSync(edited.path, 'utf8')).toBe(edited.editedBytes);
    }

    expect(movedTo(h, 'reverted')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — verified deletion, retained conflict backups
// ---------------------------------------------------------------------------

describe('invariant 2 — verified deletion, retained conflict backups', () => {
  it('deletes no backup itself, keeps the conflict backup and runs no retention sweep', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const restored = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const edited = await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });
    const runner = makeRunner(h);

    unwrap(await runner.run(SESSION.generated));
    unwrap(await runner.reconcileAll());

    // Deletion after verification is the engine's; this module removes nothing.
    const destructive = ['put', 'remove', 'removeRecorded', 'removeSessionDirectory'].flatMap(
      (method) => callsOf(h, 'backups', method),
    );
    expect(destructive).toEqual([]);

    // What it does read is the conflict's backup — to prove it is still there.
    expect(callsOf(h, 'backups', 'readRecorded').map((call) => call.args[0])).toContain(
      edited.record.backupPath,
    );
    expect(readFileSync(edited.record.backupPath, 'utf8')).toBe(edited.originalBytes);
    expect(existsSync(restored.record.backupPath)).toBe(true);

    // No orphan sweep: the calls that belong to `store/retention.ts` are never made.
    for (const method of ['listBackupPaths', 'deleteBySession', 'countBySession']) {
      expect(callsOf(h, 'modifications', method)).toEqual([]);
    }

    expect(CLEANUP_SPECIFIERS.filter((specifier) => specifier.includes('retention'))).toEqual([]);
    expect(CLEANUP_SPECIFIERS).not.toContain('node:fs');
    expect(
      /\.remove\(|\.removeRecorded\(|removeSessionDirectory|\bunlink|\brmSync\b|\brm\(|writeFile/.test(
        CLEANUP_CODE,
      ),
    ).toBe(false);
  });

  it('downgrades a clean pass to partial when a "restored" file does not hash to its original', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const untrue = await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.dial,
      fileState: 'instrumented',
    });

    // Precondition, by the real hash: the bytes on disk are not the original.
    expect(await sha256OfFile(untrue.path)).not.toBe(untrue.record.originalHash);
    expect(await sha256OfFile(untrue.path)).toBe(untrue.record.instrumentedHash);

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(h.engineResults.cleanup.map((result) => result.status)).toEqual(['clean']);
    expect(outcome.status).toBe('partial');

    const report = h.logs.find(
      (record) => record.level === 'error' && record.message.includes('end-state verification'),
    );
    expect(report?.fields['issues']).toEqual([
      {
        check: 'restored-content',
        recordId: untrue.record.id,
        file: FILE.dial,
        reason: 'hash-mismatch',
      },
    ]);
  });

  it('downgrades the start-up verdict the same way', async () => {
    const h = createHarness();
    addSession(h, SESSION.capturing, 'capturing');
    await seedRecord(h, {
      sessionId: SESSION.capturing,
      file: FILE.dial,
      fileState: 'instrumented',
    });

    const report = unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    expect(h.engineResults.reconcile.map((result) => result.status)).toEqual(['clean']);
    expect(report.bySession[SESSION.capturing]).toMatchObject({
      status: 'partial',
      restored: 1,
      failed: 1,
    });
    expect(report.status).toBe('partial');
  });

  it('never upgrades a conflict, whatever the verification finds', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.dial,
      fileState: 'instrumented',
    });
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });

    const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

    expect(outcome.status).toBe('conflict');
  });

  it.each([
    ['conflict', 'conflict'],
    ['partial', 'partial'],
  ] as const)(
    'never improves on an engine that answered %s, even when every check holds',
    async (engineStatus, expected) => {
      const h = createHarness();
      addSession(h, SESSION.generated, 'generated');
      await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
      h.knobs.engineStatus = engineStatus;

      const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

      expect(outcome.status).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// aggregateCleanupStatus
// ---------------------------------------------------------------------------

describe('aggregateCleanupStatus', () => {
  const counts = (partial: Partial<CleanupCounts>): CleanupCounts => ({
    restored: 0,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    ...partial,
  });

  it.each([
    ['an empty set', 'clean', counts({})],
    ['every record restored', 'clean', counts({ restored: 12 })],
    ['one conflict', 'conflict', counts({ conflicts: 1 })],
    [
      'a conflict beside skips and failures',
      'conflict',
      counts({ restored: 3, conflicts: 1, skipped: 2, failed: 4 }),
    ],
    ['a failure without a conflict', 'partial', counts({ restored: 3, failed: 1 })],
    ['a skip without a conflict', 'partial', counts({ skipped: 1 })],
  ] as const)('%s → %s', (_label, expected, input) => {
    expect(aggregateCleanupStatus(input)).toBe(expected);
  });

  it('never answers pending, and always answers a protocol status', () => {
    const values = [0, 1, 2, 7];
    const seen = new Set<CleanupStatus>();

    for (const restored of values) {
      for (const conflicts of values) {
        for (const skipped of values) {
          for (const failed of values) {
            const status = aggregateCleanupStatus({ restored, conflicts, skipped, failed });

            expect(CLEANUP_STATUSES).toContain(status);
            expect(status).not.toBe('pending');
            seen.add(status);
          }
        }
      }
    }

    expect([...seen].sort()).toEqual(['clean', 'conflict', 'partial']);
  });

  it('reads a malformed count as present: it can worsen a verdict, never report one clean', () => {
    for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(aggregateCleanupStatus(counts({ failed: malformed }))).toBe('partial');
      expect(aggregateCleanupStatus(counts({ skipped: malformed }))).toBe('partial');
      expect(aggregateCleanupStatus(counts({ conflicts: malformed }))).toBe('conflict');
    }
  });

  it('is pure: the same answer every time, and the input untouched', () => {
    const input = Object.freeze(counts({ restored: 2, skipped: 1 }));

    expect(aggregateCleanupStatus(input)).toBe('partial');
    expect(aggregateCleanupStatus(input)).toBe('partial');
    expect(input).toEqual({ restored: 2, conflicts: 0, skipped: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Serialisation and idempotence
// ---------------------------------------------------------------------------

describe('serialisation and idempotence', () => {
  it('serialises two concurrent ends of one session into a single restore pass', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    const runner = makeRunner(h);

    // An explicit end racing the editor's deactivation of the same session.
    const first = runner.run(SESSION.generated);
    const second = runner.run(SESSION.generated, { trigger: 'deactivate' });

    expect(second).toBe(first);

    const [a, b] = await Promise.all([first, second]);

    expect(b).toEqual(a);
    expect(unwrap(a).status).toBe('clean');
    expect(callsOf(h, 'engine', 'cleanupSession')).toHaveLength(1);
    expect(h.watcher.stopped).toEqual([SESSION.generated]);
    expect(h.instrumentation.disarmed).toHaveLength(1);
    expect(movedTo(h, 'reverted')).toHaveLength(2);
  });

  it('finds nothing open on a second end after a clean pass, writes nothing and answers clean', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const dial = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const runner = makeRunner(h);

    expect(unwrap(await runner.run(SESSION.generated)).status).toBe('clean');
    const firstPass = h.calls.length;

    const again = unwrap(await runner.run(SESSION.generated));

    expect(again).toEqual({ status: 'clean', conflicts: [], completedAt: FIXED_NOW });

    const secondPass = h.calls.slice(firstPass);
    expect(secondPass.filter((call) => call.method === 'updateStatus')).toEqual([]);
    expect(secondPass.filter((call) => call.actor === 'backups')).toEqual([]);
    expect(h.sessions.updates).toEqual([]);
    expect(h.engineResults.cleanup[1]?.restored).toEqual([]);
    expect(readFileSync(dial.path, 'utf8')).toBe(dial.originalBytes);
  });

  it('waits for a start-up reconciliation in flight before ending a session', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const runner = makeRunner(h);

    const reconciling = runner.reconcileAll();
    const ending = runner.run(SESSION.generated);

    expect(runner.reconcileAll()).toBe(reconciling);

    const [report, ended] = await Promise.all([reconciling, ending]);

    expect(unwrap(report).restored).toBe(1);
    expect(unwrap(ended).status).toBe('clean');
    expect(firstIndex(h, 'engine.reconcileModifications')).toBeLessThan(
      firstIndex(h, 'engine.cleanupSession'),
    );
    // The end found the record already put back, so it wrote nothing more.
    expect(movedTo(h, 'reverted')).toHaveLength(1);
  });

  it('is silent on a second start over a reconciled store', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed');
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, {
      sessionId: SESSION.failed,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });
    const deps = startupDeps(h, { outcomeSink: h.sink });

    const first = unwrap(await reconcileModificationsOnStartup(deps));
    expect(h.sink.delivered).toHaveLength(2);

    const second = unwrap(await reconcileModificationsOnStartup(deps));

    // The retained conflict is re-examined and re-reported in the report, but
    // the session already carries that verdict, so nothing is written again.
    expect(second.bySession[SESSION.failed]?.status).toBe('conflict');
    expect(second.bySession[SESSION.generated]).toBeUndefined();
    expect(h.sink.delivered).toHaveLength(2);
    expect(h.sessions.updates).toEqual([]);
    expect(first.bySession[SESSION.failed]).toEqual(second.bySession[SESSION.failed]);
  });
});

// ---------------------------------------------------------------------------
// Failure containment and typed results
// ---------------------------------------------------------------------------

/** Whether a value is one of the shared error codes. */
function isKnownCode(code: string): boolean {
  return (DEBUGGEN_ERROR_CODES as readonly string[]).includes(code);
}

describe('failure containment and typed results', () => {
  it('accumulates a per-record failure and still restores the records around it', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const before = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const failing = await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      verdict: 'fail',
    });
    const after = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.bezel });

    const result = await makeRunner(h).run(SESSION.generated);

    // A partial pass is an outcome, not an error.
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).status).toBe('partial');
    expect(movedTo(h, 'reverted')).toEqual([before.record.id, after.record.id]);
    expect(journaled(h, failing.record.id)?.status).toBe('applied');

    const warning = h.logs.find((record) =>
      record.message.includes('could not finish some records'),
    );
    expect(warning?.fields['failures']).toEqual([
      { recordId: failing.record.id, file: FILE.needle, code: 'STORE_ERROR' },
    ]);
    expect(warning?.fields['count']).toBe(1);
  });

  it('answers ok for a conflict pass: the developer acts on it, the service does not retry it', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });

    const result = await makeRunner(h).run(SESSION.generated);

    expect(isOk(result)).toBe(true);
    expect(unwrap(result).status).toBe('conflict');
  });

  it('keeps reconciling the other sessions when one session’s engine pass throws', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed');
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.failed, file: FILE.dial });
    const survivor = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    h.throwFor.add(SESSION.failed);

    const report = unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    expect(report.bySession[SESSION.failed]).toMatchObject({ status: 'partial', failed: 1 });
    expect(report.bySession[SESSION.generated]).toMatchObject({ status: 'clean', restored: 1 });
    expect(journaled(h, survivor.record.id)?.status).toBe('reverted');
    expect(report.errors).toEqual([
      {
        sessionId: SESSION.failed,
        code: 'CLEANUP_PARTIAL',
        message: 'The synthetic engine crashed.',
      },
    ]);
    expect(report.status).toBe('partial');
  });

  it('records an unreadable session row as failed and moves on', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed');
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.failed, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    h.sessions.unreadable.add(SESSION.failed);

    const report = unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    expect(report.bySession[SESSION.failed]).toMatchObject({ status: 'partial', failed: 1 });
    expect(report.errors.map((entry) => [entry.sessionId, entry.code])).toEqual([
      [SESSION.failed, 'STORE_ERROR'],
    ]);
    expect(report.bySession[SESSION.generated]?.status).toBe('clean');
    expect(h.contextRequests.map((request) => request.sessionId)).toEqual([SESSION.generated]);
  });

  it.each([
    ['answers err', 'err', 'FS_UNSAFE_PATH', 'synthetic-refusal'],
    ['throws', 'throw', 'INTERNAL', undefined],
    [
      'hands back another session’s backup store',
      'foreign-store',
      'INTERNAL',
      'backup-store-session-mismatch',
    ],
  ] as const)(
    'answers err with a shared code when the context factory %s, and restores nothing',
    async (_label, contextMode, code, reason) => {
      const h = createHarness();
      addSession(h, SESSION.generated, 'generated');
      const seeded = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
      h.knobs.contextMode = contextMode;

      const result = await makeRunner(h).run(SESSION.generated);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(DebuggenError);
        expect(result.error.code).toBe(code);
        expect(isKnownCode(result.error.code)).toBe(true);
        expect(result.error.details?.['reason']).toBe(reason);
      }

      expect(callsOf(h, 'engine')).toEqual([]);
      expect(h.progress.rows).toEqual([]);
      expect(journaled(h, seeded.record.id)?.status).toBe('applied');
    },
  );

  it('answers err, never a throw, when the default context factory refuses the state directory', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');

    const result = await makeRunner(h, {
      buildContext: undefined,
      config: { debuggenHome: 'relative/state' },
    }).run(SESSION.generated);

    expect(isErr(result)).toBe(true);

    if (isErr(result)) {
      expect(result.error.code).toBe('FS_UNSAFE_PATH');
      expect(isKnownCode(result.error.code)).toBe(true);
    }

    expect(callsOf(h, 'engine')).toEqual([]);
  });

  it.each([
    ['the journal would not answer', 'unanswered', 'STORE_ERROR'],
    ['the engine rejects', 'throw', 'CLEANUP_PARTIAL'],
  ] as const)(
    'answers err when %s, leaving the session to be ended again',
    async (_label, engineMode, code) => {
      const h = createHarness();
      addSession(h, SESSION.generated, 'generated');
      await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
      h.knobs.engineMode = engineMode;

      const result = await makeRunner(h).run(SESSION.generated);

      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe(code);
        expect(isKnownCode(result.error.code)).toBe(true);
      }

      expect(h.sessions.updates).toEqual([]);
    },
  );

  it('answers err for a session that does not exist, without building a context or restoring', async () => {
    const h = createHarness();
    await seedRecord(h, {
      sessionId: SESSION.missing,
      file: FILE.drift,
      fileState: 'instrumented',
    });

    const result = await makeRunner(h).run(SESSION.missing);

    expect(isErr(result) ? result.error.code : undefined).toBe('SESSION_NOT_FOUND');
    expect(h.contextRequests).toEqual([]);
    expect(callsOf(h, 'engine')).toEqual([]);
  });

  it('refuses to race an install still writing files, touching nothing', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.instrumentation.installing.add(SESSION.generated);

    const result = await makeRunner(h).run(SESSION.generated);

    expect(isErr(result) ? result.error.code : undefined).toBe('SESSION_INVALID_STATE');
    expect(order(h)).toEqual(['instrumentation.isInstalling']);
  });

  it('answers err when the journal cannot list its open records at start-up, reading nothing else', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    h.modifications.faults.listAllOpen = true;

    const result = await reconcileModificationsOnStartup(startupDeps(h));

    expect(isErr(result) ? result.error.code : undefined).toBe('STORE_ERROR');
    expect(order(h)).toEqual(['modifications.listAllOpen']);
  });

  it.each(['err', 'throw'] as const)(
    'finishes the pass when the progress emitter answers %s',
    async (fault) => {
      const h = createHarness();
      addSession(h, SESSION.generated, 'generated');
      await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
      h.progress.faults.fault = fault;

      const outcome = unwrap(await makeRunner(h).run(SESSION.generated));

      expect(outcome.status).toBe('clean');
      expect(h.progress.rows.map((row) => row.kind)).toEqual(['started', 'completed']);
      expect(
        h.logs.filter((record) => record.message.includes('progress row could not be sent')),
      ).toHaveLength(2);
    },
  );
});

// ---------------------------------------------------------------------------
// The default context factory
// ---------------------------------------------------------------------------

describe('createCleanupContextFactory', () => {
  it('builds the session’s own backup store over the injected journal and clock, creating nothing', async () => {
    const h = createHarness();
    const factory = createCleanupContextFactory({
      modifications: h.modifications,
      config: { debuggenHome: h.home },
      logger: h.logger,
      now,
    });

    const context = unwrap(await factory({ sessionId: SESSION.generated, projectRoot: h.project }));

    expect(context.journal).toBe(h.modifications);
    expect(context.projectRoot).toBe(h.project);
    expect(context.now?.()).toBe(FIXED_NOW);
    expect(context.backups.sessionId).toBe(SESSION.generated);
    expect(context.backups.sessionDirectory).toBe(join(h.home, 'backups', SESSION.generated));
    expect(readdirSync(h.home)).toEqual([]);
  });

  it.each([
    ['a blank session id', { sessionId: ' ', projectRoot: '/srv/lantern' }],
    ['a blank project root', { sessionId: SESSION.generated, projectRoot: '' }],
  ])('answers err SESSION_NOT_FOUND for %s', async (_label, request) => {
    const h = createHarness();
    const factory = createCleanupContextFactory({
      modifications: h.modifications,
      config: { debuggenHome: h.home },
    });

    const result = await factory(request);

    expect(isErr(result) ? result.error.code : undefined).toBe('SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('starts no session when the start-up signal is already aborted, and says so', async () => {
    const h = createHarness();
    await seedEveryOwningState(h);
    const controller = new AbortController();
    controller.abort();

    const report = unwrap(
      await reconcileModificationsOnStartup(startupDeps(h), { signal: controller.signal }),
    );

    expect(report.aborted).toBe(true);
    expect(report.status).toBe('partial');
    expect(report.restored).toBe(0);
    expect(report.skipped).toBe(report.scanned);

    for (const summary of Object.values(report.bySession)) {
      expect(summary.skipped).toBe(summary.scanned);
    }

    expect(callsOf(h, 'engine')).toEqual([]);
    expect(callsOf(h, 'sessions', 'get')).toEqual([]);
    expect(h.contextRequests).toEqual([]);
    expect(movedTo(h, 'reverted')).toEqual([]);
  });

  it('finishes the session in hand, starts no other and reports what was done', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed');
    addSession(h, SESSION.generated, 'generated');
    const done = await seedRecord(h, { sessionId: SESSION.failed, file: FILE.dial });
    const left = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    const controller = new AbortController();
    h.knobs.afterRecord = () => {
      controller.abort();
    };

    const report = unwrap(
      await reconcileModificationsOnStartup(startupDeps(h, { signal: controller.signal })),
    );

    expect(report.aborted).toBe(true);
    expect(report.bySession[SESSION.failed]).toMatchObject({ status: 'clean', restored: 1 });
    expect(report.bySession[SESSION.generated]).toMatchObject({
      status: 'partial',
      scanned: 1,
      skipped: 1,
      restored: 0,
    });
    expect(report.restored).toBe(1);
    expect(report.skipped).toBe(1);
    expect(journaled(h, done.record.id)?.status).toBe('reverted');
    expect(journaled(h, left.record.id)?.status).toBe('applied');
    expect(callsOf(h, 'engine')).toHaveLength(1);
  });

  it('stops a session pass between records on shutdown and says how far it got', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    const done = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const left = await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });
    const controller = new AbortController();
    h.knobs.afterRecord = () => {
      controller.abort();
    };

    const result = await makeRunner(h, { signal: controller.signal }).run(SESSION.generated);

    // The session stays un-ended, so ending it again — or the next start — resumes.
    expect(isErr(result)).toBe(true);

    if (isErr(result)) {
      expect(result.error.code).toBe('CLEANUP_PARTIAL');
      expect(result.error.details?.['reason']).toBe('cleanup-stopped');
    }

    expect(journaled(h, done.record.id)?.status).toBe('reverted');
    expect(journaled(h, left.record.id)?.status).toBe('applied');

    const stopped = h.logs.find((record) => record.message.includes('stopped part-way'));
    expect(stopped?.fields['restored']).toBe(1);
    expect(stopped?.fields['remaining']).toBe(1);
  });

  it('refuses new work once disposed, touching nothing', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    const runner = makeRunner(h);

    runner.dispose();
    runner.dispose();

    const ended = await runner.run(SESSION.generated);
    const reconciled = await runner.reconcileAll();

    expect(isErr(ended) ? ended.error.code : undefined).toBe('CLEANUP_PARTIAL');
    expect(isErr(reconciled) ? reconciled.error.code : undefined).toBe('CLEANUP_PARTIAL');
    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('privacy — log records carry ids, relative paths, statuses and codes only', () => {
  it('never logs a diff, file bytes, an absolute path or a token-shaped value', async () => {
    const h = createHarness();
    addSession(h, SESSION.generated, 'generated');
    addSession(h, SESSION.failed, 'failed');
    openCapture(h, SESSION.generated, 'cap_lanternopen01');
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.needle,
      fileState: 'edited',
      verdict: 'conflict',
    });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.bezel, verdict: 'fail' });
    await seedRecord(h, {
      sessionId: SESSION.generated,
      file: FILE.gauge,
      fileState: 'instrumented',
    });
    await seedRecord(h, { sessionId: SESSION.failed, file: FILE.drift, verdict: 'fail' });
    await seedRecord(h, {
      sessionId: SESSION.missing,
      file: 'lib/orbit/tide-chart.ts',
      fileState: 'instrumented',
    });
    h.watcher.faults.fault = 'throw';
    h.instrumentation.faults.fault = 'err';
    const runner = makeRunner(h);

    const ended = unwrap(await runner.run(SESSION.generated));
    const report = unwrap(await runner.reconcileAll());

    h.knobs.contextMode = 'foreign-store';
    addSession(h, SESSION.capturing, 'capturing');
    const refused = await runner.run(SESSION.capturing);
    const missing = await runner.run(SESSION.midCleanup);

    // Every branch above logged something, and the outcome still carries the
    // conflict's diff — for the developer, not for the log.
    expect(h.logs.length).toBeGreaterThan(10);
    expect(JSON.stringify(ended.conflicts)).toContain(DIFF_MARKER);

    const logged = h.logs.flatMap((record) =>
      stringLeaves([record.message, record.fields, record.name]),
    );
    const payloads = [
      ...report.errors,
      ...[refused, missing].flatMap((result) => (isErr(result) ? [result.error.toPayload()] : [])),
    ];
    expect(payloads.length).toBeGreaterThan(1);
    const returned = stringLeaves(payloads);

    for (const text of [...logged, ...returned]) {
      expect(text).not.toContain(DIFF_MARKER);
      expect(text).not.toContain(CONTENT_MARKER);
      expect(text).not.toContain(h.root);
      expect(text).not.toMatch(/(?:^|[\s'"(=:])\/[A-Za-z0-9._-]/);
      expect(text).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
    }
  });
});

// ---------------------------------------------------------------------------
// The start-up report
// ---------------------------------------------------------------------------

/** A fixed journal: out-of-order sessions, a restore, a conflict, a failure and an orphan. */
async function seedReportScenario(h: Harness): Promise<void> {
  addSession(h, SESSION.generated, 'generated');
  addSession(h, SESSION.capturing, 'capturing');
  addSession(h, SESSION.failed, 'failed');
  await seedRecord(h, { sessionId: SESSION.generated, file: FILE.dial });
  await seedRecord(h, {
    sessionId: SESSION.failed,
    file: FILE.needle,
    fileState: 'edited',
    verdict: 'conflict',
  });
  await seedRecord(h, { sessionId: SESSION.capturing, file: FILE.bezel, verdict: 'fail' });
  await seedRecord(h, { sessionId: SESSION.missing, file: FILE.drift, fileState: 'instrumented' });
}

describe('StartupReconciliationReport', () => {
  it('is plain JSON, keyed by session in sorted order whatever order the journal lists them', async () => {
    const h = createHarness();
    await seedReportScenario(h);

    const report = unwrap(await reconcileModificationsOnStartup(startupDeps(h)));

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(Object.keys(report.bySession)).toEqual(
      [SESSION.capturing, SESSION.failed, SESSION.generated, SESSION.missing].sort(),
    );

    for (const entry of report.errors) {
      expect(
        Object.keys(entry).every((key) =>
          ['sessionId', 'recordId', 'code', 'message'].includes(key),
        ),
      ).toBe(true);
      expect(isKnownCode(entry.code)).toBe(true);
    }

    expect(report).toMatchObject({
      status: 'conflict',
      scanned: 4,
      restored: 1,
      conflicts: 1,
      failed: 1,
      unresolved: 1,
      aborted: false,
      completedAt: FIXED_NOW,
    });
  });

  it('is identical for an identical journal', async () => {
    const reports: StartupReconciliationReport[] = [];

    for (let run = 0; run < 2; run += 1) {
      const h = createHarness();
      await seedReportScenario(h);
      reports.push(unwrap(await reconcileModificationsOnStartup(startupDeps(h))));
    }

    expect(JSON.stringify(reports[1])).toBe(JSON.stringify(reports[0]));
  });
});

// ---------------------------------------------------------------------------
// settleInterruptedSessions — the sessions a restart interrupted
// ---------------------------------------------------------------------------

/** Invented ids for the settlement cases, listed in sorted order. */
const INTERRUPTED = Object.freeze({
  alpha: 'ses_quarryalpha',
  bravo: 'ses_quarrybravo',
  charlie: 'ses_quarrycharlie',
  delta: 'ses_quarrydelta',
  echo: 'ses_quarryecho',
});

/** The open capture window the settlement cases resume or fail. */
const OPEN_CAPTURE_ID = 'cap_quarryopen01';

/** The statuses the settlement must list, and only those. */
const INTERRUPTIBLE: readonly SessionStatus[] = ['instrumenting', 'ready', 'capturing'];

/** A runtime-only plan version: its one action is a runtime hook, so no file is patched. */
function runtimePlan(sessionId: string, planVersion: number): InstrumentationPlan {
  return {
    version: 1,
    planVersion,
    sessionId,
    objective: 'Find where the time between a dial press and the needle settling is spent.',
    hypotheses: ['The needle waits on a request the dial issues.'],
    capture: ['interaction timing', 'fetch calls'],
    instrumentationTargets: [
      {
        id: `act_${String(planVersion).padStart(16, '0')}`,
        file: FILE.dial,
        symbol: 'DialFace',
        type: 'fetch-tracking',
        adapter: 'synthetic-request-adapter',
        mode: 'runtime',
        rationale: 'The requests the dial issues are observed by a runtime hook.',
      },
    ],
  };
}

/** A session the previous process left in `status`, re-validated with its plans and stamp. */
function interrupted(
  h: Harness,
  id: string,
  status: SessionStatus,
  options: { readonly plans?: readonly InstrumentationPlan[]; readonly updatedAt?: number } = {},
): SessionRecord {
  const base = addSession(h, id, status);
  const record = unwrap(
    parseSessionRecord({
      ...base,
      plans: [...(options.plans ?? [])],
      updatedAt: options.updatedAt ?? SEEDED_AT,
    }),
  );

  h.sessions.rows.set(id, record);
  return record;
}

/** The session store settlement reads: the harness's rows and captures, plus a paged `list`. */
interface ListingSessions extends Pick<SessionsRepo, 'list' | 'get' | 'getActiveCapture'> {
  /** The most items one page holds, whatever `limit` asks for: a store may serve less. */
  pageCap: number;

  /** Offsets whose page answers `err`, as a store that stops answering does. */
  readonly failingOffsets: Set<number>;

  /** Sessions whose open capture cannot be read. */
  readonly unreadableCaptures: Set<string>;
}

function createListingSessions(h: Harness): ListingSessions {
  const failingOffsets = new Set<number>();
  const unreadableCaptures = new Set<string>();
  const listing: ListingSessions = {
    pageCap: Number.POSITIVE_INFINITY,
    failingOffsets,
    unreadableCaptures,
    list(options: ListSessionsOptions = {}) {
      h.calls.push({ actor: 'sessions', method: 'list', args: [options] });
      const offset = options.offset ?? 0;

      if (failingOffsets.has(offset)) {
        return err(new DebuggenError('STORE_ERROR', 'The synthetic session list did not answer.'));
      }

      const statuses = options.statuses;
      // The store's order: most recently updated first.
      const matching = [...h.sessions.rows.values()]
        .filter((record) => statuses === undefined || statuses.includes(record.status))
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
      const limit = Math.min(options.limit ?? 50, listing.pageCap);
      const items: SessionListItem[] = matching.slice(offset, offset + limit).map((record) => ({
        id: record.id,
        projectRoot: record.projectRoot,
        projectName: record.projectName,
        status: record.status,
        question: record.question,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));

      return ok({ items, total: matching.length });
    },
    get(id) {
      return h.sessions.get(id);
    },
    getActiveCapture(sessionId) {
      if (unreadableCaptures.has(sessionId)) {
        h.calls.push({ actor: 'sessions', method: 'getActiveCapture', args: [sessionId] });
        return err(new DebuggenError('STORE_ERROR', 'The synthetic capture row does not parse.'));
      }

      return h.sessions.getActiveCapture(sessionId);
    },
  };

  return listing;
}

/** The session-manager double: `fail` recorded, applied to the rows, and scriptable to refuse. */
interface RecordingManager extends SessionFailer {
  readonly failures: { readonly sessionId: string; readonly failure: SessionFailure }[];
  readonly faults: Map<string, Exclude<Fault, 'none'>>;

  /** Called after each successful `fail`, for the cancellation cases. */
  afterFail: ((sessionId: string) => void) | undefined;
}

function createRecordingManager(h: Harness): RecordingManager {
  const failures: { sessionId: string; failure: SessionFailure }[] = [];
  const faults = new Map<string, Exclude<Fault, 'none'>>();
  const manager: RecordingManager = {
    failures,
    faults,
    afterFail: undefined,
    fail(sessionId, failure) {
      h.calls.push({ actor: 'manager', method: 'fail', args: [sessionId, failure] });
      const fault = faults.get(sessionId);

      if (fault === 'throw') {
        throw new Error('The synthetic session manager crashed.');
      }

      if (fault === 'err') {
        return err(
          new DebuggenError('SESSION_INVALID_STATE', 'The synthetic session refused the move.'),
        );
      }

      failures.push({ sessionId, failure });
      const row = h.sessions.rows.get(sessionId);

      // Failing a session takes it out of the filtered listing, exactly as the
      // real manager does — which is why the module must read every page first.
      if (row !== undefined) {
        h.sessions.rows.set(sessionId, { ...row, status: 'failed' });
      }

      manager.afterFail?.(sessionId);
      return ok(row);
    },
  };

  return manager;
}

/** The instrumentation-service double for releasing a capture a restart ended. */
interface RecordingReleaser extends CaptureReleaser {
  readonly releases: CaptureReleaseRequest[];
  readonly faults: Map<string, Exclude<Fault, 'none'>>;
}

function createRecordingReleaser(h: Harness): RecordingReleaser {
  const releases: CaptureReleaseRequest[] = [];
  const faults = new Map<string, Exclude<Fault, 'none'>>();

  return {
    releases,
    faults,
    releaseInterruptedCapture(input) {
      h.calls.push({
        actor: 'instrumentation',
        method: 'releaseInterruptedCapture',
        args: [input],
      });
      releases.push(input);
      const fault = faults.get(input.sessionId);

      if (fault === 'throw') {
        throw new Error('The synthetic instrumentation service crashed.');
      }

      // No producer is connected before the service serves: both are owed.
      return fault === 'err'
        ? err(new DebuggenError('TRANSPORT_DISCONNECTED', 'The synthetic release was refused.'))
        : ok({ sessionId: input.sessionId, pending: ['page-agent', 'server-agent'] });
    },
  };
}

interface SettleHarness {
  readonly h: Harness;
  readonly sessions: ListingSessions;
  readonly manager: RecordingManager;
  readonly releaser: RecordingReleaser;
  deps(overrides?: Partial<InterruptedSessionDeps>): InterruptedSessionDeps;
}

function createSettleHarness(): SettleHarness {
  const h = createHarness();
  const sessions = createListingSessions(h);
  const manager = createRecordingManager(h);
  const releaser = createRecordingReleaser(h);

  return {
    h,
    sessions,
    manager,
    releaser,
    deps: (overrides = {}) => ({
      sessions,
      manager,
      instrumentation: releaser,
      logger: h.logger,
      now,
      ...overrides,
    }),
  };
}

/** A start-up report whose `bySession` holds exactly the given sessions and verdicts. */
function reconciliationOf(
  verdicts: Readonly<Record<string, CleanupStatus>> = {},
): StartupReconciliationReport {
  const bySession: Record<string, SessionReconciliationSummary> = {};

  for (const sessionId of Object.keys(verdicts).sort()) {
    const verdict = verdicts[sessionId] ?? 'partial';

    bySession[sessionId] = {
      sessionId,
      status: verdict,
      scanned: 1,
      restored: verdict === 'clean' ? 1 : 0,
      closed: 0,
      conflicts: verdict === 'conflict' ? 1 : 0,
      skipped: 0,
      failed: verdict === 'partial' ? 1 : 0,
      unresolved: 0,
    };
  }

  const summaries = Object.values(bySession);
  const status: CleanupStatus = summaries.some((summary) => summary.status === 'conflict')
    ? 'conflict'
    : summaries.some((summary) => summary.status !== 'clean')
      ? 'partial'
      : 'clean';

  return {
    status,
    scanned: summaries.length,
    closed: 0,
    restored: summaries.filter((summary) => summary.status === 'clean').length,
    conflicts: summaries.filter((summary) => summary.status === 'conflict').length,
    unresolved: 0,
    failed: summaries.filter((summary) => summary.status === 'partial').length,
    skipped: 0,
    aborted: false,
    bySession,
    errors: [],
    completedAt: FIXED_NOW,
  };
}

/** The `statuses` and `offset` of every `list` call, in order. */
function listCalls(h: Harness): ListSessionsOptions[] {
  return callsOf(h, 'sessions', 'list').map((call) => call.args[0] as ListSessionsOptions);
}

describe('settleInterruptedSessions — a restart never leaves a session capturing what it removed', () => {
  it('fails every instrumenting session at instrument: an install cannot survive a restart', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    interrupted(s.h, INTERRUPTED.bravo, 'instrumenting');

    const report = unwrap(
      await settleInterruptedSessions(s.deps(), reconciliationOf({ [INTERRUPTED.bravo]: 'clean' })),
    );

    expect(report.failed).toEqual([
      { sessionId: INTERRUPTED.alpha, status: 'instrumenting', reason: 'install-interrupted' },
      { sessionId: INTERRUPTED.bravo, status: 'instrumenting', reason: 'install-interrupted' },
    ]);
    expect(
      s.manager.failures.map(({ sessionId, failure }) => [sessionId, failure.stage, failure.code]),
    ).toEqual([
      [INTERRUPTED.alpha, 'instrument', 'INSTRUMENTATION_UNAVAILABLE'],
      [INTERRUPTED.bravo, 'instrument', 'INSTRUMENTATION_UNAVAILABLE'],
    ]);
    expect(s.releaser.releases).toEqual([]);
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.status).toBe('failed');
  });

  it('fails a ready or capturing session whose journal records the start-up reconciliation held', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'ready', { plans: [runtimePlan(INTERRUPTED.alpha, 1)] });
    interrupted(s.h, INTERRUPTED.bravo, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.bravo, 1)],
    });
    interrupted(s.h, INTERRUPTED.charlie, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.charlie, 1)],
    });
    openCapture(s.h, INTERRUPTED.bravo, OPEN_CAPTURE_ID);
    openCapture(s.h, INTERRUPTED.charlie, 'cap_quarryopen02');
    await seedRecord(s.h, { sessionId: INTERRUPTED.alpha, file: FILE.dial });
    await seedRecord(s.h, { sessionId: INTERRUPTED.bravo, file: FILE.needle });
    await seedRecord(s.h, {
      sessionId: INTERRUPTED.charlie,
      file: FILE.bezel,
      fileState: 'edited',
      verdict: 'conflict',
    });

    // The real first half of the start: it restores two sessions' files and
    // leaves the third's edited file in conflict.
    const reconciled = unwrap(await reconcileModificationsOnStartup(startupDeps(s.h)));
    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciled));

    expect(report.failed).toEqual([
      { sessionId: INTERRUPTED.alpha, status: 'ready', reason: 'instrumentation-removed' },
      { sessionId: INTERRUPTED.bravo, status: 'capturing', reason: 'instrumentation-removed' },
      {
        sessionId: INTERRUPTED.charlie,
        status: 'capturing',
        reason: 'instrumentation-unsettled',
      },
    ]);
    expect(s.manager.failures.map(({ failure }) => failure.stage)).toEqual([
      'instrument',
      'instrument',
      'instrument',
    ]);

    // Each capture window is released, whatever became of its files.
    expect(s.releaser.releases.map(({ sessionId, captureId }) => [sessionId, captureId])).toEqual([
      [INTERRUPTED.bravo, OPEN_CAPTURE_ID],
      [INTERRUPTED.charlie, 'cap_quarryopen02'],
    ]);

    // The unsettled one points the developer at the cleanup report.
    const [removed, , unsettled] = s.manager.failures.map(({ failure }) => failure);
    expect(removed?.message).toBe(
      'The Debug Generator service restarted and removed the instrumentation this session had added to your files, so it can no longer capture.',
    );
    expect(unsettled?.hint).toContain('cleanup report');
    expect(unsettled?.hint).not.toBe(removed?.hint);
  });

  /** The failure every runtime-only capture a restart interrupted is moved to. */
  const CAPTURE_INTERRUPTED = {
    stage: 'capture',
    code: 'INSTRUMENTATION_UNAVAILABLE',
    message:
      'The Debug Generator service restarted during this session’s capture, so the capture was closed.',
    hint: 'Ask your question again in a new session, or end this one.',
  };

  it('fails a runtime-only capture rather than continuing it, releasing its window with the plan it was opened with', async () => {
    const s = createSettleHarness();
    const first = runtimePlan(INTERRUPTED.alpha, 1);
    const second = runtimePlan(INTERRUPTED.alpha, 2);
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', { plans: [first, second] });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 2);

    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

    // No producer has taken this capture's configuration from the new
    // process, so it is never advertised as capturing.
    expect(report.failed).toEqual([
      { sessionId: INTERRUPTED.alpha, status: 'capturing', reason: 'capture-interrupted' },
    ]);
    expect(s.manager.failures.map(({ failure }) => failure)).toEqual([CAPTURE_INTERRUPTED]);
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.status).toBe('failed');
    expect(s.releaser.releases).toEqual([
      {
        sessionId: INTERRUPTED.alpha,
        captureId: OPEN_CAPTURE_ID,
        projectRoot: s.h.project,
        plan: second,
      },
    ]);
  });

  const INTERRUPTED_CAPTURES: readonly {
    readonly label: string;
    readonly releases: number;
    readonly arrange: (s: SettleHarness) => Partial<InterruptedSessionDeps>;
  }[] = [
    {
      label: 'no instrumentation service is wired',
      releases: 0,
      arrange: () => ({ instrumentation: undefined }),
    },
    {
      label: 'the session holds no open capture window',
      releases: 0,
      arrange: (s) => {
        s.h.sessions.captures.delete(INTERRUPTED.alpha);
        return {};
      },
    },
    {
      label: 'its open capture cannot be read',
      releases: 0,
      arrange: (s) => {
        s.sessions.unreadableCaptures.add(INTERRUPTED.alpha);
        return {};
      },
    },
    {
      label: 'the session record cannot be read',
      releases: 0,
      arrange: (s) => {
        s.h.sessions.unreadable.add(INTERRUPTED.alpha);
        return {};
      },
    },
    {
      label: 'the capture names a plan version the session does not hold',
      releases: 1,
      arrange: (s) => {
        openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);
        return {};
      },
    },
    {
      label: 'the instrumentation service refuses the release',
      releases: 1,
      arrange: (s) => {
        s.releaser.faults.set(INTERRUPTED.alpha, 'err');
        return {};
      },
    },
    {
      label: 'the instrumentation service throws',
      releases: 1,
      arrange: (s) => {
        s.releaser.faults.set(INTERRUPTED.alpha, 'throw');
        return {};
      },
    },
  ];

  it.each(INTERRUPTED_CAPTURES)(
    'fails a runtime-only capture at capture when $label',
    async ({ releases, arrange }) => {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.alpha, 1)],
      });
      openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID);
      const overrides = arrange(s);

      const report = unwrap(await settleInterruptedSessions(s.deps(overrides), reconciliationOf()));

      expect(report.failed).toEqual([
        { sessionId: INTERRUPTED.alpha, status: 'capturing', reason: 'capture-interrupted' },
      ]);
      expect(report.errors).toEqual([]);
      expect(s.releaser.releases).toHaveLength(releases);
      expect(s.manager.failures.map(({ failure }) => failure)).toEqual([CAPTURE_INTERRUPTED]);
    },
  );

  it('leaves a ready session with nothing in the journal, and every other status, as they are', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'ready', { plans: [runtimePlan(INTERRUPTED.alpha, 1)] });
    interrupted(s.h, INTERRUPTED.bravo, 'generated');
    interrupted(s.h, INTERRUPTED.charlie, 'analyzing');
    interrupted(s.h, INTERRUPTED.delta, 'created');
    interrupted(s.h, INTERRUPTED.echo, 'failed');
    const before = new Map(s.h.sessions.rows);

    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

    expect(report).toMatchObject({ examined: 1, failed: [], errors: [] });
    expect(callsOf(s.h, 'manager')).toEqual([]);
    expect(callsOf(s.h, 'instrumentation')).toEqual([]);
    expect(s.h.sessions.rows).toEqual(before);
    expect(s.h.sessions.updates).toEqual([]);
    expect(listCalls(s.h).map((options) => options.statuses)).toEqual([INTERRUPTIBLE]);
  });

  it('reads every page before it fails anything, then decides in sorted id order', async () => {
    const s = createSettleHarness();
    const ids = [
      INTERRUPTED.alpha,
      INTERRUPTED.bravo,
      INTERRUPTED.charlie,
      INTERRUPTED.delta,
      INTERRUPTED.echo,
    ];

    // Stamped so the store lists them newest first — the reverse of id order.
    for (const [index, id] of ids.entries()) {
      interrupted(s.h, id, 'instrumenting', { updatedAt: SEEDED_AT + index });
    }

    // A store serving two rows a page, whatever the module asks for.
    s.sessions.pageCap = 2;

    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

    const options = listCalls(s.h);
    expect(options.map((call) => call.offset)).toEqual([0, 2, 4]);

    for (const call of options) {
      expect(call.statuses).toEqual(INTERRUPTIBLE);
      expect(call.limit).toBeGreaterThan(0);
      expect(call.limit).toBeLessThanOrEqual(MAX_SESSION_LIST_LIMIT);
    }

    // Failing a session removes it from the filtered listing; acting between
    // pages would have shifted the later pages and skipped sessions.
    expect(order(s.h).lastIndexOf('sessions.list')).toBeLessThan(firstIndex(s.h, 'manager.fail'));
    expect(report.examined).toBe(5);
    expect(s.manager.failures.map(({ sessionId }) => sessionId)).toEqual(ids);
    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual(ids);
  });

  it('contains a session the manager will not fail, and settles every other one', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    interrupted(s.h, INTERRUPTED.bravo, 'instrumenting');
    interrupted(s.h, INTERRUPTED.charlie, 'instrumenting');
    s.manager.faults.set(INTERRUPTED.alpha, 'err');
    s.manager.faults.set(INTERRUPTED.bravo, 'throw');

    const result = await settleInterruptedSessions(s.deps(), reconciliationOf());

    expect(isOk(result)).toBe(true);
    const report = unwrap(result);
    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.charlie]);
    expect(report.errors).toEqual([
      {
        sessionId: INTERRUPTED.alpha,
        code: 'SESSION_INVALID_STATE',
        message: 'The synthetic session refused the move.',
      },
      {
        sessionId: INTERRUPTED.bravo,
        code: 'INTERNAL',
        message: 'The synthetic session manager crashed.',
      },
    ]);
    expect(
      s.h.logs.filter((record) => record.message.includes('could not be failed')),
    ).toHaveLength(2);
  });

  it.each([0, 2])(
    'answers err when the page at offset %i cannot be listed, and decides nothing',
    async (offset) => {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
      interrupted(s.h, INTERRUPTED.bravo, 'instrumenting');
      interrupted(s.h, INTERRUPTED.charlie, 'instrumenting');
      s.sessions.pageCap = 2;
      s.sessions.failingOffsets.add(offset);

      const result = await settleInterruptedSessions(s.deps(), reconciliationOf());

      expect(isErr(result) ? result.error.code : undefined).toBe('STORE_ERROR');
      expect(callsOf(s.h, 'manager')).toEqual([]);
      expect(callsOf(s.h, 'instrumentation')).toEqual([]);
    },
  );

  it('lists nothing when the signal is already aborted, and says so', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    const controller = new AbortController();
    controller.abort();

    const report = unwrap(
      await settleInterruptedSessions(s.deps(), reconciliationOf(), {
        signal: controller.signal,
      }),
    );

    expect(report).toMatchObject({ examined: 0, failed: [], aborted: true });
    expect(s.h.calls).toEqual([]);
  });

  it('finishes the session in hand when aborted, starts no other and reports what was done', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    interrupted(s.h, INTERRUPTED.bravo, 'instrumenting');
    interrupted(s.h, INTERRUPTED.charlie, 'instrumenting');
    const controller = new AbortController();
    s.manager.afterFail = () => {
      controller.abort();
    };

    const report = unwrap(
      await settleInterruptedSessions(s.deps(), reconciliationOf(), {
        signal: controller.signal,
      }),
    );

    expect(report).toMatchObject({ examined: 3, aborted: true });
    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
    expect(callsOf(s.h, 'manager')).toHaveLength(1);
  });

  it('says what the restart did in complete sentences that name no path and never the question', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    interrupted(s.h, INTERRUPTED.bravo, 'ready');
    interrupted(s.h, INTERRUPTED.charlie, 'ready');
    interrupted(s.h, INTERRUPTED.delta, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.delta, 1)],
    });

    unwrap(
      await settleInterruptedSessions(
        s.deps(),
        reconciliationOf({ [INTERRUPTED.bravo]: 'clean', [INTERRUPTED.charlie]: 'conflict' }),
      ),
    );

    const failures = s.manager.failures.map(({ failure }) => failure);
    expect(failures).toHaveLength(4);
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(4);

    const question = s.h.sessions.rows.get(INTERRUPTED.alpha)?.question ?? '<none>';

    for (const failure of failures) {
      expect(failure.code).toBe('INSTRUMENTATION_UNAVAILABLE');
      expect(isKnownCode(failure.code)).toBe(true);

      for (const sentence of [failure.message, failure.hint ?? '']) {
        expect(sentence).toMatch(/^[A-Z].*\.$/);
        expect(sentence).not.toContain(question);
        expect(sentence).not.toContain(s.h.root);
        expect(sentence).not.toMatch(/(?:^|[\s'"(=:])\/[A-Za-z0-9._-]/);
      }
    }
  });

  it('is deterministic JSON stamped by the injected clock, and logs one summary of counts', async () => {
    const reports: InterruptedSessionsReport[] = [];

    for (let pass = 0; pass < 2; pass += 1) {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.echo, 'instrumenting', { updatedAt: SEEDED_AT + 3 });
      interrupted(s.h, INTERRUPTED.delta, 'ready', { updatedAt: SEEDED_AT + 2 });
      interrupted(s.h, INTERRUPTED.bravo, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.bravo, 1)],
        updatedAt: SEEDED_AT + 1,
      });
      interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.alpha, 1)],
      });
      openCapture(s.h, INTERRUPTED.bravo, OPEN_CAPTURE_ID);

      const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));
      reports.push(report);

      const summary = s.h.logs.find((record) => record.message === 'interrupted sessions settled');
      expect(summary?.level).toBe('info');
      expect(summary?.fields).toMatchObject({
        trigger: 'service-start',
        examined: 4,
        failed: 3,
        released: 1,
        kept: 1,
        errors: 0,
        aborted: false,
      });

      // No log record carries an absolute path, though the release request does.
      for (const text of s.h.logs.flatMap((record) =>
        stringLeaves([record.message, record.fields]),
      )) {
        expect(text).not.toContain(s.h.root);
      }
    }

    const [first] = reports;
    expect(first).toEqual({
      examined: 4,
      failed: [
        { sessionId: INTERRUPTED.alpha, status: 'capturing', reason: 'capture-interrupted' },
        { sessionId: INTERRUPTED.bravo, status: 'capturing', reason: 'capture-interrupted' },
        { sessionId: INTERRUPTED.echo, status: 'instrumenting', reason: 'install-interrupted' },
      ],
      errors: [],
      aborted: false,
      completedAt: FIXED_NOW,
    });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(reports[1])).toBe(JSON.stringify(first));
  });
});

describe('settleInterruptedSessions — a failed capture’s producers are owed their dormant configuration', () => {
  it('releases the window a failed capturing session held, read before the failure closed it', async () => {
    const s = createSettleHarness();
    const plan = runtimePlan(INTERRUPTED.alpha, 1);
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', { plans: [plan] });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID);
    await seedRecord(s.h, { sessionId: INTERRUPTED.alpha, file: FILE.dial });

    const reconciled = unwrap(await reconcileModificationsOnStartup(startupDeps(s.h)));
    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciled));

    expect(report.failed).toEqual([
      { sessionId: INTERRUPTED.alpha, status: 'capturing', reason: 'instrumentation-removed' },
    ]);
    expect(s.releaser.releases).toEqual([
      {
        sessionId: INTERRUPTED.alpha,
        captureId: OPEN_CAPTURE_ID,
        projectRoot: s.h.project,
        plan,
      },
    ]);
    // The session is failed first: only a session that cannot continue is released.
    expect(firstIndex(s.h, 'manager.fail')).toBeLessThan(
      firstIndex(s.h, 'instrumentation.releaseInterruptedCapture'),
    );
    const summary = s.h.logs.find((record) => record.message === 'interrupted sessions settled');
    expect(summary?.fields).toMatchObject({ failed: 1, released: 1 });
  });

  it('releases a capture without a plan when its plan version is missing', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.alpha, 1)],
    });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);

    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

    expect(report.failed).toEqual([
      { sessionId: INTERRUPTED.alpha, status: 'capturing', reason: 'capture-interrupted' },
    ]);
    expect(s.releaser.releases).toEqual([
      { sessionId: INTERRUPTED.alpha, captureId: OPEN_CAPTURE_ID, projectRoot: s.h.project },
    ]);
  });

  it('releases nothing for a failed session that held no capture window', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'instrumenting');
    interrupted(s.h, INTERRUPTED.bravo, 'ready', { plans: [runtimePlan(INTERRUPTED.bravo, 1)] });
    interrupted(s.h, INTERRUPTED.charlie, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.charlie, 1)],
    });

    const report = unwrap(
      await settleInterruptedSessions(s.deps(), reconciliationOf({ [INTERRUPTED.bravo]: 'clean' })),
    );

    expect(report.failed.map(({ sessionId, reason }) => [sessionId, reason])).toEqual([
      [INTERRUPTED.alpha, 'install-interrupted'],
      [INTERRUPTED.bravo, 'instrumentation-removed'],
      [INTERRUPTED.charlie, 'capture-interrupted'],
    ]);
    expect(s.releaser.releases).toEqual([]);
  });

  it('releases nothing for a session the manager would not fail, and reports it unsettled', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.alpha, 1)],
    });
    interrupted(s.h, INTERRUPTED.bravo, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.bravo, 1)],
    });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID);
    openCapture(s.h, INTERRUPTED.bravo, 'cap_quarryopen02');
    s.manager.faults.set(INTERRUPTED.bravo, 'err');

    const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
    expect(report.errors.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.bravo]);
    expect(s.releaser.releases.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
  });

  it.each(['err', 'throw'] as const)(
    'contains a release that answers %s: the session stays failed and no error is reported',
    async (fault) => {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.alpha, 1)],
      });
      openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);
      s.releaser.faults.set(INTERRUPTED.alpha, fault);

      const report = unwrap(await settleInterruptedSessions(s.deps(), reconciliationOf()));

      expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
      expect(report.errors).toEqual([]);
      expect(s.releaser.releases).toHaveLength(1);
      expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.status).toBe('failed');
      expect(
        s.h.logs.filter((record) => record.message.includes('could not be released')),
      ).toHaveLength(1);
      const summary = s.h.logs.find((record) => record.message === 'interrupted sessions settled');
      expect(summary?.fields).toMatchObject({ failed: 1, released: 0 });
    },
  );
});

// ---------------------------------------------------------------------------
// A released capture's session never claims a clean cleanup early
// ---------------------------------------------------------------------------

/** A start-up verdict that says every file of the session was restored. */
const STARTUP_CLEAN: SessionRecord['cleanup'] = {
  status: 'clean',
  completedAt: SEEDED_AT,
  conflicts: [],
};

/** A start-up verdict for a session left `capturing`: files clean, hooks not known dormant. */
const STARTUP_PARTIAL: SessionRecord['cleanup'] = {
  status: 'partial',
  completedAt: SEEDED_AT,
  conflicts: [],
};

/** Both producers, as a release before any connection reports them. */
const BOTH_OWED = ['page-agent', 'server-agent'] as const;

describe('the start-up reconciliation of a capturing session', () => {
  it('records a session left capturing no better than partial, and any other by its files alone', async () => {
    const h = createHarness();
    addSession(h, SESSION.capturing, 'capturing');
    addSession(h, SESSION.generated, 'generated');
    await seedRecord(h, { sessionId: SESSION.capturing, file: FILE.dial });
    await seedRecord(h, { sessionId: SESSION.generated, file: FILE.needle });

    const report = unwrap(
      await reconcileModificationsOnStartup(startupDeps(h, { outcomeSink: h.sink })),
    );

    // The summaries keep the files' own verdict ...
    expect(report.bySession[SESSION.capturing]?.status).toBe('clean');
    expect(report.bySession[SESSION.generated]?.status).toBe('clean');
    // ... and the capturing session is recorded partial in that same write.
    expect(
      h.sink.delivered.map(({ sessionId, outcome }) => [sessionId, outcome.status]).sort(),
    ).toEqual(
      [
        [SESSION.capturing, 'partial'],
        [SESSION.generated, 'clean'],
      ].sort(),
    );
    expect(h.sessions.rows.get(SESSION.capturing)?.status).toBe('capturing');
  });
});

describe('holdUntilDormant — a session whose producers may hold a capture is not clean', () => {
  it('remembers the partial the reconciliation recorded and upgrades it once the service confirms dormancy', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.failed, 'failed', STARTUP_PARTIAL);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    const held = await runner.holdUntilDormant(SESSION.failed, {
      pending: [...BOTH_OWED],
      files: 'clean',
    });

    // Nothing to write: the verdict is partial already.
    expect(isOk(held)).toBe(true);
    expect(h.sink.delivered).toEqual([]);
    const warning = h.logs.find((record) => record.message.includes('may still hold it'));
    expect(warning?.level).toBe('warn');
    expect(warning?.fields).toMatchObject({
      pendingProducers: [...BOTH_OWED],
      producersKnown: true,
      trigger: 'service-start',
    });

    // Both producers reconnect and take their dormant configuration.
    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();

    expect(upgrades(h)).toEqual([{ status: 'clean', conflicts: [], completedAt: FIXED_NOW }]);
    expect(h.sessions.rows.get(SESSION.failed)?.cleanup.status).toBe('clean');

    // Once, through the manager's sink only, and the status is never touched.
    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();
    expect(upgrades(h)).toHaveLength(1);
    expect(h.sessions.updates).toEqual([]);
    expect(h.sessions.rows.get(SESSION.failed)?.status).toBe(stored.status);
  });

  it('records a clean verdict it finds as partial before remembering it', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    unwrap(
      await runner.holdUntilDormant(SESSION.failed, { pending: ['page-agent'], files: 'clean' }),
    );

    expect(h.sink.delivered).toEqual([
      {
        sessionId: SESSION.failed,
        outcome: { status: 'partial', conflicts: [], completedAt: FIXED_NOW },
      },
    ]);

    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();
    expect(h.sink.delivered.map(({ outcome }) => outcome.status)).toEqual(['partial', 'clean']);
  });

  it('upgrades at once when the release reached every producer', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_PARTIAL);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    unwrap(await runner.holdUntilDormant(SESSION.failed, { pending: [], files: 'clean' }));
    await drained();

    expect(upgrades(h)).toEqual([{ status: 'clean', conflicts: [], completedAt: FIXED_NOW }]);
  });

  it('holds partial for good when the release did not say who received the dormant configuration', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    unwrap(await runner.holdUntilDormant(SESSION.failed, { pending: undefined, files: 'clean' }));

    expect(h.sink.delivered.map(({ outcome }) => outcome.status)).toEqual(['partial']);
    expect(
      h.logs.find((record) => record.message.includes('may still hold it'))?.fields,
    ).toMatchObject({ pendingProducers: [], producersKnown: false });

    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();
    expect(upgrades(h)).toEqual([]);
    expect(h.sessions.rows.get(SESSION.failed)?.cleanup.status).toBe('partial');
  });

  const holdsNothing: readonly (readonly [
    string,
    SessionRecord['cleanup'],
    ReleasedCaptureVerdict,
  ])[] = [
    [
      'every producer took its dormant configuration and the verdict is clean',
      STARTUP_CLEAN,
      { pending: [], files: 'clean' },
    ],
    [
      'no pass has run and no record was reconciled',
      { status: 'pending', conflicts: [] },
      { pending: ['page-agent'], files: undefined },
    ],
    [
      'the files themselves were left partial',
      STARTUP_PARTIAL,
      { pending: ['page-agent'], files: 'partial' },
    ],
    [
      'the verdict is a conflict',
      { status: 'conflict', completedAt: SEEDED_AT, conflicts: [] },
      { pending: undefined, files: 'conflict' },
    ],
  ];

  it.each(holdsNothing)('holds nothing when %s', async (_label, cleanup, release) => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', cleanup);
    const runner = makeRunner(h, { outcomeSink: h.sink });

    unwrap(await runner.holdUntilDormant(SESSION.failed, release));
    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();

    expect(h.sink.delivered).toEqual([]);
    expect(h.sessions.updates).toEqual([]);
    expect(h.sessions.rows.get(SESSION.failed)?.cleanup).toEqual(cleanup);
  });

  it('upgrades at once when the confirmation arrives while the partial is being recorded', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    let confirmed = false;
    const sink: CleanupOutcomeSink = {
      recordCleanupOutcome(sessionId, outcome) {
        const recorded = h.sink.recordCleanupOutcome(sessionId, outcome);

        // The producer reconnects between the store write and the hold's next step.
        if (!confirmed) {
          confirmed = true;
          h.instrumentation.confirmDormancy(sessionId);
        }

        return recorded;
      },
    };
    const runner = makeRunner(h, { outcomeSink: sink });

    unwrap(
      await runner.holdUntilDormant(SESSION.failed, { pending: ['page-agent'], files: 'clean' }),
    );
    await drained();

    expect(h.sink.delivered.map(({ outcome }) => outcome.status)).toEqual(['partial', 'clean']);
    expect(h.sessions.rows.get(SESSION.failed)?.cleanup.status).toBe('clean');

    // Settled by the hold itself: nothing is remembered.
    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();
    expect(h.sink.delivered).toHaveLength(2);
  });

  it('without a sink, writes only the cleanup sub-object and never the status', async () => {
    const h = createHarness();
    const stored = addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    const runner = makeRunner(h);

    unwrap(
      await runner.holdUntilDormant(SESSION.failed, { pending: ['server-agent'], files: 'clean' }),
    );

    expect(h.sessions.updates).toHaveLength(1);
    const [written] = h.sessions.updates;
    expect(written?.cleanup).toEqual({ status: 'partial', completedAt: FIXED_NOW, conflicts: [] });
    expect(withoutCleanup(written)).toEqual(withoutCleanup(stored));
  });

  it('holds nothing after dispose, nor while a pass for the session is in flight', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    addSession(h, SESSION.generated, 'generated', STARTUP_CLEAN);
    const runner = makeRunner(h, { outcomeSink: h.sink });
    const release: ReleasedCaptureVerdict = { pending: ['page-agent'], files: 'clean' };

    // A pass waiting for a reconciliation is in flight: it decides its own verdict.
    const reconciling = runner.reconcileAll();
    const running = runner.run(SESSION.generated);
    unwrap(await runner.holdUntilDormant(SESSION.generated, release));
    await Promise.all([reconciling, running]);

    runner.dispose();
    unwrap(await runner.holdUntilDormant(SESSION.failed, release));

    expect(h.sink.delivered).toEqual([]);
    expect(h.sessions.rows.get(SESSION.failed)?.cleanup).toEqual(STARTUP_CLEAN);
  });

  it('answers err when the session cannot be read or a clean verdict cannot be corrected', async () => {
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_CLEAN);
    addSession(h, SESSION.generated, 'generated', STARTUP_CLEAN);
    h.sessions.unreadable.add(SESSION.failed);
    const refusing: CleanupOutcomeSink = {
      recordCleanupOutcome: () =>
        err(new DebuggenError('STORE_ERROR', 'The synthetic session row is locked.')),
    };
    const runner = makeRunner(h, { outcomeSink: refusing });
    const release: ReleasedCaptureVerdict = { pending: ['page-agent'], files: 'clean' };

    const unreadable = await runner.holdUntilDormant(SESSION.failed, release);
    const refused = await runner.holdUntilDormant(SESSION.generated, release);

    expect(isErr(unreadable) ? unreadable.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(refused) ? refused.error.code : undefined).toBe('STORE_ERROR');
    expect(
      h.logs.some(
        (record) =>
          record.level === 'error' &&
          record.message.includes('its cleanup verdict could not be held'),
      ),
    ).toBe(true);

    // Nothing was remembered, so a confirmation writes nothing.
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    expect(h.sessions.rows.get(SESSION.generated)?.cleanup).toEqual(STARTUP_CLEAN);
  });
});

describe('a confirmed dormancy upgrade that cannot be recorded is retried', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sink that refuses each session's first `refusals` deliveries, then records like the manager. */
  function flakySink(h: Harness, refusals: number): CleanupOutcomeSink {
    const refused = new Map<string, number>();

    return {
      recordCleanupOutcome(sessionId, outcome) {
        const count = refused.get(sessionId) ?? 0;

        if (count < refusals) {
          refused.set(sessionId, count + 1);
          return err(new DebuggenError('STORE_ERROR', 'The synthetic session row is locked.'));
        }

        return h.sink.recordCleanupOutcome(sessionId, outcome);
      },
    };
  }

  it('records the upgrade once the store answers again, with a backoff between attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_PARTIAL);
    const runner = makeRunner(h, { outcomeSink: flakySink(h, 2) });
    unwrap(
      await runner.holdUntilDormant(SESSION.failed, { pending: ['page-agent'], files: 'clean' }),
    );

    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();
    expect(upgrades(h)).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(upgrades(h)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(upgrades(h)).toEqual([{ status: 'clean', conflicts: [], completedAt: FIXED_NOW }]);
    expect(
      h.logs.filter((record) => record.message.includes('the upgrade is retried')),
    ).toHaveLength(2);
    runner.dispose();
  });

  it('gives up after the last attempt, leaving the conservative partial and saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_PARTIAL);
    const runner = makeRunner(h, { outcomeSink: flakySink(h, Number.MAX_SAFE_INTEGER) });
    unwrap(
      await runner.holdUntilDormant(SESSION.failed, { pending: ['page-agent'], files: 'clean' }),
    );

    h.instrumentation.confirmDormancy(SESSION.failed);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.sessions.rows.get(SESSION.failed)?.cleanup.status).toBe('partial');
    expect(
      h.logs.some(
        (record) => record.level === 'error' && record.message.includes('after every retry'),
      ),
    ).toBe(true);
    runner.dispose();
  });

  it('cancels a scheduled retry when a later pass decides the verdict, and on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = createHarness();
    addSession(h, SESSION.failed, 'failed', STARTUP_PARTIAL);
    addSession(h, SESSION.generated, 'generated', STARTUP_PARTIAL);
    const sink = flakySink(h, 1);
    const runner = makeRunner(h, { outcomeSink: sink });
    const release: ReleasedCaptureVerdict = { pending: ['page-agent'], files: 'clean' };
    unwrap(await runner.holdUntilDormant(SESSION.failed, release));

    h.instrumentation.confirmDormancy(SESSION.failed);
    await drained();

    // The session is ended again: its own pass decides, and the retry is dropped.
    unwrap(await runner.run(SESSION.failed));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(upgrades(h)).toEqual([]);

    // A retry still scheduled when the runner stops never fires.
    unwrap(await runner.holdUntilDormant(SESSION.generated, release));
    h.instrumentation.confirmDormancy(SESSION.generated);
    await drained();
    runner.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(upgrades(h)).toEqual([]);
  });
});

/** A verdict-hold double: records what each released capture reported. */
interface RecordingVerdictHold extends CleanupVerdictHold {
  readonly held: { readonly sessionId: string; readonly release: ReleasedCaptureVerdict }[];
}

function createRecordingVerdictHold(
  fault: 'none' | 'err' | 'throw' | 'reject' = 'none',
): RecordingVerdictHold {
  const held: { sessionId: string; release: ReleasedCaptureVerdict }[] = [];

  return {
    held,
    holdUntilDormant(sessionId, release) {
      held.push({ sessionId, release });

      if (fault === 'throw') {
        throw new Error('The synthetic cleanup runner crashed.');
      }

      if (fault === 'reject') {
        return Promise.reject(new Error('The synthetic cleanup runner rejected.'));
      }

      return Promise.resolve(
        fault === 'err'
          ? err(new DebuggenError('STORE_ERROR', 'The synthetic session row is locked.'))
          : ok(undefined),
      );
    },
  };
}

describe('settleInterruptedSessions — a released capture’s cleanup verdict is held until dormancy', () => {
  it('keeps the verdict the reconciliation recorded partial until the producers are confirmed dormant', async () => {
    const s = createSettleHarness();
    const plan = runtimePlan(INTERRUPTED.alpha, 1);
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', { plans: [plan] });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID);
    await seedRecord(s.h, { sessionId: INTERRUPTED.alpha, file: FILE.dial });
    const runner = makeRunner(s.h, { outcomeSink: s.h.sink });

    // Files restored, hooks not known dormant: recorded partial by the first half.
    const reconciled = unwrap(await reconcileModificationsOnStartup(startupDeps(s.h)));
    expect(reconciled.bySession[INTERRUPTED.alpha]?.status).toBe('clean');
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.cleanup.status).toBe('partial');

    const report = unwrap(
      await settleInterruptedSessions(s.deps({ verdicts: runner }), reconciled),
    );

    // Failed, released, and — with both producers still owed — still partial.
    expect(report.errors).toEqual([]);
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.status).toBe('failed');
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.cleanup.status).toBe('partial');
    expect(s.h.sink.delivered).toEqual([]);

    s.h.instrumentation.confirmDormancy(INTERRUPTED.alpha);
    await drained();
    expect(s.h.sessions.rows.get(INTERRUPTED.alpha)?.cleanup.status).toBe('clean');
  });

  it('tells the runner what each release reported, and nothing for a session it did not release', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.alpha, 1)],
    });
    interrupted(s.h, INTERRUPTED.bravo, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.bravo, 1)],
    });
    interrupted(s.h, INTERRUPTED.charlie, 'instrumenting');
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);
    openCapture(s.h, INTERRUPTED.bravo, 'cap_quarryopen02');
    const verdicts = createRecordingVerdictHold();

    const report = unwrap(
      await settleInterruptedSessions(
        s.deps({ verdicts }),
        reconciliationOf({ [INTERRUPTED.bravo]: 'clean' }),
      ),
    );

    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([
      INTERRUPTED.alpha,
      INTERRUPTED.bravo,
      INTERRUPTED.charlie,
    ]);
    expect(verdicts.held).toEqual([
      { sessionId: INTERRUPTED.alpha, release: { pending: [...BOTH_OWED], files: undefined } },
      { sessionId: INTERRUPTED.bravo, release: { pending: [...BOTH_OWED], files: 'clean' } },
    ]);
  });

  it.each(['err', 'throw'] as const)(
    'tells the runner nothing is known when the release answers %s',
    async (fault) => {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.alpha, 1)],
      });
      openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);
      s.releaser.faults.set(INTERRUPTED.alpha, fault);
      const verdicts = createRecordingVerdictHold();

      unwrap(await settleInterruptedSessions(s.deps({ verdicts }), reconciliationOf()));

      expect(verdicts.held).toEqual([
        { sessionId: INTERRUPTED.alpha, release: { pending: undefined, files: undefined } },
      ]);
    },
  );

  it('holds nothing when no instrumentation service is wired to release the capture', async () => {
    const s = createSettleHarness();
    interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
      plans: [runtimePlan(INTERRUPTED.alpha, 1)],
    });
    openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);
    const verdicts = createRecordingVerdictHold();

    const report = unwrap(
      await settleInterruptedSessions(
        s.deps({ instrumentation: undefined, verdicts }),
        reconciliationOf(),
      ),
    );

    expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
    expect(verdicts.held).toEqual([]);
  });

  it.each(['err', 'throw', 'reject'] as const)(
    'reports a session whose verdict the runner could not hold (%s) as unsettled, so the start is refused',
    async (fault) => {
      const s = createSettleHarness();
      interrupted(s.h, INTERRUPTED.alpha, 'capturing', {
        plans: [runtimePlan(INTERRUPTED.alpha, 1)],
      });
      interrupted(s.h, INTERRUPTED.bravo, 'instrumenting');
      openCapture(s.h, INTERRUPTED.alpha, OPEN_CAPTURE_ID, 3);

      const report = unwrap(
        await settleInterruptedSessions(
          s.deps({ verdicts: createRecordingVerdictHold(fault) }),
          reconciliationOf(),
        ),
      );

      // The pass still settles every other session.
      expect(report.failed.map(({ sessionId }) => sessionId)).toEqual([
        INTERRUPTED.alpha,
        INTERRUPTED.bravo,
      ]);
      expect(report.errors.map(({ sessionId }) => sessionId)).toEqual([INTERRUPTED.alpha]);
      expect(
        s.h.logs.some(
          (record) =>
            record.level === 'error' && record.message.includes('could not be held at partial'),
        ),
      ).toBe(true);
    },
  );
});
