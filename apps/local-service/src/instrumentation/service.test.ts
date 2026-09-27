/**
 * Tests for `./service.ts`: the instrumentation driver that turns a validated
 * plan into installed instrumentation, armed producers and the protocol
 * messages both user interfaces render.
 *
 * What is on trial, and why it matters:
 *
 * - **The installer's result reaches the wire unreshaped** (AAP §0.4.2).
 *   `instrumentation.ready` carries `applied`, `runtimeHooks` and `unavailable`
 *   exactly as the installer returned them; `agent.config` and
 *   `server-agent.config` carry its hook configuration and signal set; a
 *   disarm sends the imported dormant and disabled constants with the preload's
 *   `captureId` omitted, which is what disables — rather than idles — the
 *   dev-server instrumentations (AAP §0.5.1). Every frame is built by
 *   `createEnvelope`, parses as a protocol message and names a type the
 *   protocol declares.
 * - **Degradation is honest and failure is narrow** (AAP §0.5.5). Each
 *   unavailable signal is one "Could not enable ‹signal›: ‹reason›. Continuing
 *   with: ‹enabled list›." row whose label comes from the progress module's
 *   label map; the session is failed only when the installer says nothing at
 *   all could be enabled, and a collaborator that throws never escapes.
 * - **The checklist shows only what readiness confirmed** (AAP §0.5.5, prompt
 *   §11 Step 8): readiness is evaluated before any checklist row, a ✓ needs an
 *   armed signal with a producer that will deliver it — a missing preload
 *   turns every server row into a ✗ that says why — and "Ready to capture" is
 *   sent once, last, and only for a satisfied verdict.
 * - **A follow-up installs only its delta** (AAP §0.4.2): the additive ids are
 *   the upstream `actionIdentityKey` difference, an empty delta installs
 *   nothing, and a failed delta leaves the previous plan version active with no
 *   rollback performed here — the installer owns reverse-restore.
 * - **The adapter context is complete and honest**: the journal is the injected
 *   one by identity, the backup store is rooted under the state directory, the
 *   project root is normalised absolute POSIX, and every field the upstream
 *   `InstrumentationContext` declares is present — checked against the
 *   declaration's own source text, so a forgotten field fails.
 * - **Producer configuration is judged by its delivery receipt.** `agent.config`
 *   goes to the bound tab's connection and `server-agent.config` to the
 *   project's preloads, never through the session fan-out; an arm whose page
 *   frame no connection took is refused before the preload hears anything, an
 *   unreachable preload degrades the capture once per capture, and a disarm no
 *   connection took stays pending — across `stopSession` — until a
 *   reconnecting producer, a rebinding tab or a later configuration settles it.
 *   A capture a restart ended is released: its producers are owed their
 *   dormant configuration until they reconnect, and nothing is re-armed.
 * - **The watcher bracket, per-session serialisation and the lifecycle** hold:
 *   suspend → installer → refresh/watch → resume on success and on failure,
 *   overlapping installs for one session are refused, `stopSession` restores
 *   nothing and `dispose` is idempotent.
 * - **The module knows no adapter and writes no file.** A registry of fakes
 *   with invented ids drives every install here, and a scan of the module's
 *   own code refuses adapter factories, adapter-id literals, write APIs and
 *   imports outside its layers.
 *
 * Every collaborator is an injected recording double, the installer is a
 * scripted `InstallPlanFn`, and the readiness gate is the real
 * `evaluateReadiness`, wrapped only to observe its calls and to script the two
 * answers it cannot be driven to here: no network, no child process, no real
 * installer and no filesystem work beyond one empty `mkdtemp` state directory
 * per test, which is asserted to stay empty. The vocabulary — paths, symbols, adapter ids
 * — is invented and generic, and the digest-shaped values are assembled at run
 * time from repeated characters.
 *
 * @module
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADAPTER_IDS,
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  SERVER_AGENT_SIGNAL_KEYS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  actionIdentityKey,
  buildReadiness,
  createAdapterRegistry,
  createModificationRecord,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  normalizePlan,
  parseInstrumentationPlan,
  parseReadiness,
  type AdapterClaimEntry,
  type AdapterRegistry,
  type AgentHookConfig,
  type AggregateInstallResult,
  type CaptureSignal,
  type ClaimingAdapter,
  type InstallPlanOptions,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationContext,
  type InstrumentationPlan,
  type ModificationRecord,
  type ModificationStatus,
  type ModificationStatusPatch,
  type ObservedReadinessInputs,
  type Readiness,
  type ReadinessSignal,
  type ServerAgentSignals,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  MESSAGE_TYPES,
  agentConfigPayloadSchema,
  instrumentationFailedPayloadSchema,
  instrumentationPlanPayloadSchema,
  instrumentationReadyPayloadSchema,
  isMessageOfType,
  parseMessage,
  serverAgentConfigPayloadSchema,
  type AgentReadyPayload,
  type BoundTab,
  type ClientKind,
  type MessageType,
  type ProgressStage,
  type ProtocolMessage,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  isErr,
  isOk,
  ok,
  unwrap,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import {
  STATE_HOME_OVERLAP_HINT,
  STATE_HOME_OVERLAP_MESSAGE,
  STATE_HOME_OVERLAP_REASON,
  type ServiceConfig,
} from '../config.js';
import { detectDevServer, type DevServerDetection } from '../dev-server/detect.js';
import { LOG_ERROR_FIELD_KEY } from '../logging.js';
import type { CaptureOwner, SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  INSTRUMENTATION_ROW_ORDER,
  authorProductText,
  buildInstrumentationRows,
  isProductAuthoredText,
  publicFailureCopy,
  type InstalledSignals,
  type ProgressRow,
  type SessionProgress,
} from '../sessions/progress.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import {
  collectObservedReadiness,
  evaluateReadiness,
  type BrowserAgentRegistry,
  type ReadinessVerdict,
  type ServerAgentReadinessSource,
} from './readiness.js';
import {
  buildDegradationNotice,
  createInstrumentationService,
  type AgentConfigChannel,
  type CaptureOwnerLookup,
  type CodeAnalysisHandles,
  type InstallPlanFn,
  type InstallRequest,
  type InstrumentationDriver,
  type InstrumentationServiceDeps,
  type ServerAgentConfigChannel,
} from './service.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// The readiness gate, observed — `evaluateReadiness` stays the real function
// (every install here is judged by it), wrapped so a suite can read when and
// with what it was called, and can script one answer it cannot otherwise
// provoke: an `Err`, or a rejection.
// ---------------------------------------------------------------------------

vi.mock('./readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./readiness.js')>();

  return { ...actual, evaluateReadiness: vi.fn(actual.evaluateReadiness) };
});

// ---------------------------------------------------------------------------
// Fixtures: identities, clock, addresses
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_servicesuite0001';
const OTHER_SESSION_ID = 'ses_servicesuite0002';
const CAPTURE_ID = 'cap_servicesuite0001';
const PROJECT_ROOT = '/work/sample-project';
/** Where {@link PROJECT_ROOT} was admitted to resolve: the directory behind a link on its path. */
const CANONICAL_PROJECT_ROOT = '/volumes/work/sample-project';
const TAB_ID = 11;
const NOW = 1_800_000_000_000;
const APP_ORIGIN = 'http://127.0.0.1:20271';
const BOUND_TAB: BoundTab = { tabId: TAB_ID, url: `${APP_ORIGIN}/panels` };

/** The one clock every double and the service read. Asserted by identity. */
const clock = (): number => NOW;

/** The two adapter ids of the fake registry: invented, and in no built-in list. */
const PAGE_ADAPTER_ID = 'sample-page-probe';
const SERVER_ADAPTER_ID = 'sample-server-probe';
const EXTRA_ADAPTER_ID = 'sample-seventh-probe';

/** The three UI-facing message types this module announces. */
const UI_KINDS: readonly ClientKind[] = ['vscode', 'devtools'];

/** The relaunch-command-shaped hint a server-tier gap carries, verbatim. */
const RELAUNCH_HINT =
  'Restart the dev server with: SAMPLE_PRELOAD=1 pnpm --dir /work/sample-project run dev-sentinel';

/** A digest-shaped value assembled at run time: 64 repetitions of one hex digit. */
function digest(character: string): string {
  return character.repeat(64);
}

/** The first element of an array, failing the test rather than returning `undefined`. */
function first<T>(values: readonly T[]): T {
  const value = values[0];

  if (value === undefined) {
    throw new Error('expected at least one element');
  }

  return value;
}

/** A promise with its settle functions exposed, for holding an install open. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return {
    promise,
    resolve(value) {
      settle?.(value);
    },
  };
}

// ---------------------------------------------------------------------------
// Recording logger — bindings are kept per logger object, so a suite can read
// what a child was bound with without a cast.
// ---------------------------------------------------------------------------

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
  readonly bindings: LogFields;
}

const LOGGER_BINDINGS = new WeakMap<Logger, LogFields>();

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields, bindings });
    };

  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (extra) => createRecordingLogger(entries, { ...bindings, ...extra }),
  };

  LOGGER_BINDINGS.set(logger, bindings);
  return logger;
}

// ---------------------------------------------------------------------------
// In-memory modification journal — every call is logged, and the four
// mutating methods separately, so "this module wrote nothing" is an exact
// assertion rather than an inference.
// ---------------------------------------------------------------------------

interface MemoryJournal extends ModificationsRepo {
  readonly records: ModificationRecord[];
  readonly reads: string[];
  readonly writes: string[];
}

function createMemoryJournal(seed: readonly ModificationRecord[] = []): MemoryJournal {
  const records: ModificationRecord[] = [...seed];
  const reads: string[] = [];
  const writes: string[] = [];
  const bySession = (sessionId: string): ModificationRecord[] =>
    records.filter((record) => record.sessionId === sessionId);
  const unknownRecord = (): Result<never> =>
    err(new DebuggenError('STORE_ERROR', 'No modification record has that id.'));

  return {
    records,
    reads,
    writes,
    append(record) {
      writes.push('append');
      records.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus(id: string, status: ModificationStatus, patch?: ModificationStatusPatch) {
      writes.push('updateStatus');
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
      reads.push('listBySession');
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
      reads.push('listPageBySession');
      const all = bySession(sessionId);
      return Promise.resolve(
        ok({ records: all.slice(window.offset, window.offset + window.limit), total: all.length }),
      );
    },
    listOpen(sessionId) {
      reads.push('listOpen');
      return Promise.resolve(
        ok(
          records.filter(
            (record) =>
              record.status !== 'reverted' &&
              (sessionId === undefined || record.sessionId === sessionId),
          ),
        ),
      );
    },
    listAllOpen() {
      reads.push('listAllOpen');
      return Promise.resolve(ok(records.filter((record) => record.status !== 'reverted')));
    },
    get(id) {
      reads.push('get');
      return Promise.resolve(ok(records.find((record) => record.id === id)));
    },
    listByFile(sessionId, file) {
      reads.push('listByFile');
      return Promise.resolve(ok(bySession(sessionId).filter((record) => record.file === file)));
    },
    latestRecordForFile(sessionId, file) {
      reads.push('latestRecordForFile');
      return Promise.resolve(
        ok(
          bySession(sessionId)
            .filter((record) => record.file === file)
            .at(-1),
        ),
      );
    },
    listChain(recordId) {
      reads.push('listChain');
      const record = records.find((candidate) => candidate.id === recordId);
      return Promise.resolve(record === undefined ? unknownRecord() : ok([record]));
    },
    listConflicts(sessionId) {
      reads.push('listConflicts');
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
    listBackupPaths() {
      reads.push('listBackupPaths');
      return Promise.resolve(ok([...new Set(records.map((record) => record.backupPath))].sort()));
    },
    countBySession(sessionId) {
      reads.push('countBySession');
      return Promise.resolve(ok(bySession(sessionId).length));
    },
    deleteBySession(sessionId) {
      writes.push('deleteBySession');
      const before = records.length;
      const kept = records.filter((record) => record.sessionId !== sessionId);
      records.splice(0, records.length, ...kept);
      return Promise.resolve(ok(before - kept.length));
    },
  };
}

// ---------------------------------------------------------------------------
// Recording progress — every method call, in order, with its arguments.
// ---------------------------------------------------------------------------

type ProgressMethod = keyof SessionProgress;

interface ProgressCall {
  readonly method: ProgressMethod;
  readonly sessionId: string;
  readonly args: readonly unknown[];
}

/** What `stageFailed` is handed, read off the port so no second declaration exists. */
type StageFailure = Parameters<SessionProgress['stageFailed']>[1];

interface RecordingProgress extends SessionProgress {
  readonly calls: ProgressCall[];
  /** The rows handed to `emit`, typed. */
  readonly emitted: ProgressRow[];
  /** The failures handed to `stageFailed`, typed. */
  readonly failures: StageFailure[];
  /** The installed-signal reports handed to `reportInstrumentation`, typed. */
  readonly installed: InstalledSignals[];
  /** Methods that throw instead of answering, to prove a throw never escapes. */
  readonly throwing: Set<ProgressMethod>;
  /** Called with each method as it is invoked, to observe what had happened by then. */
  readonly listeners: ((method: ProgressMethod) => void)[];
}

function createRecordingProgress(): RecordingProgress {
  const calls: ProgressCall[] = [];
  const emitted: ProgressRow[] = [];
  const failures: StageFailure[] = [];
  const installedReports: InstalledSignals[] = [];
  const throwing = new Set<ProgressMethod>();
  const listeners: ((method: ProgressMethod) => void)[] = [];

  const note = (method: ProgressMethod, sessionId: string, args: readonly unknown[]): void => {
    calls.push({ method, sessionId, args });

    for (const listener of listeners) {
      listener(method);
    }

    if (throwing.has(method)) {
      throw new Error(`progress.${method} is unavailable`);
    }
  };

  const payload = (sessionId: string, row: ProgressRow): SessionProgressPayload => ({
    sessionId,
    ...row,
  });

  return {
    calls,
    emitted,
    failures,
    installed: installedReports,
    throwing,
    listeners,
    emit(sessionId, row) {
      emitted.push(row);
      note('emit', sessionId, [row]);
      return ok(payload(sessionId, row));
    },
    stageStarted(sessionId, stage, message) {
      note('stageStarted', sessionId, [stage, message]);
      return ok(payload(sessionId, { stage, status: 'running', message: message ?? stage }));
    },
    stageCompleted(sessionId, stage, message) {
      note('stageCompleted', sessionId, [stage, message]);
      return ok(payload(sessionId, { stage, status: 'done', message: message ?? stage }));
    },
    stageFailed(sessionId, failure) {
      failures.push(failure);
      note('stageFailed', sessionId, [failure]);
      return ok(
        payload(sessionId, { stage: failure.stage, status: 'failed', message: failure.message }),
      );
    },
    finding(sessionId, stage, message, detail) {
      note('finding', sessionId, [stage, message, detail]);
      return ok(payload(sessionId, { stage, status: 'done', message }));
    },
    reportInvestigation(sessionId, findings) {
      note('reportInvestigation', sessionId, [findings]);
      return ok([]);
    },
    reportInstrumentation(sessionId, installed) {
      installedReports.push(installed);
      note('reportInstrumentation', sessionId, [installed]);
      return ok([]);
    },
    readyToCapture(sessionId) {
      note('readyToCapture', sessionId, []);
      return ok(payload(sessionId, { stage: 'instrument', status: 'done', message: 'ready' }));
    },
  };
}

// ---------------------------------------------------------------------------
// Recording broadcaster and preload channel — every frame, as sent.
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly sessionId: string;
  readonly kinds: readonly ClientKind[] | 'all';
  readonly message: ProtocolMessage;
}

interface RecordingBroadcaster extends SessionBroadcaster {
  readonly frames: SentFrame[];
  /** When set, every send throws after being recorded. */
  failing: boolean;
}

function createRecordingBroadcaster(): RecordingBroadcaster {
  const frames: SentFrame[] = [];

  const broadcaster: RecordingBroadcaster = {
    frames,
    failing: false,
    broadcast(sessionId, message) {
      frames.push({ sessionId, kinds: 'all', message });

      if (broadcaster.failing) {
        throw new Error('the client registry is unavailable');
      }
    },
    broadcastToKinds(sessionId, kinds, message) {
      frames.push({ sessionId, kinds: [...kinds], message });

      if (broadcaster.failing) {
        throw new Error('the client registry is unavailable');
      }
    },
  };

  return broadcaster;
}

interface ServerFrame {
  readonly projectRoot: string;
  readonly message: ProtocolMessage;
}

interface RecordingServerChannel extends ServerAgentConfigChannel {
  /** Every frame the preload connections took, in send order. */
  readonly frames: ServerFrame[];
  /** Every frame offered while {@link refusing}, which no connection took. */
  readonly refused: ServerFrame[];
  /** When set, every send answers `SERVER_AGENT_NOT_READY`, as the registry does with no preload. */
  refusing: boolean;
}

function createRecordingServerChannel(): RecordingServerChannel {
  const frames: ServerFrame[] = [];
  const refused: ServerFrame[] = [];

  const channel: RecordingServerChannel = {
    frames,
    refused,
    refusing: false,
    sendToServerAgent(projectRoot, message) {
      if (channel.refusing) {
        refused.push({ projectRoot, message });
        return err(
          new DebuggenError(
            'SERVER_AGENT_NOT_READY',
            'No dev-server agent is connected for this project.',
          ),
        );
      }

      frames.push({ projectRoot, message });
      return ok(1);
    },
  };

  return channel;
}

interface AgentFrame {
  readonly sessionId: string;
  readonly message: ProtocolMessage;
}

/** The two answers the registry gives when no online bound-tab connection takes a frame. */
type AgentRefusal = 'TAB_NOT_BOUND' | 'TRANSPORT_DISCONNECTED';

interface RecordingAgentChannel extends AgentConfigChannel {
  /** Every frame a bound-tab connection took, in send order. */
  readonly frames: AgentFrame[];
  /** Every frame offered while {@link refusing}, which no connection took. */
  readonly refused: AgentFrame[];
  /** When set, every send answers with this code instead of delivering. */
  refusing: AgentRefusal | undefined;
}

function createRecordingAgentChannel(): RecordingAgentChannel {
  const frames: AgentFrame[] = [];
  const refused: AgentFrame[] = [];

  const channel: RecordingAgentChannel = {
    frames,
    refused,
    refusing: undefined,
    sendToBoundTab(sessionId, message) {
      if (channel.refusing !== undefined) {
        refused.push({ sessionId, message });
        return err(
          new DebuggenError(channel.refusing, 'No bound-tab connection took the frame.', {
            details: { recipient: 'bound-tab' },
          }),
        );
      }

      frames.push({ sessionId, message });
      return ok({ delivered: 1, dropped: 0, recipients: ['cli_servicesuite01'] });
    },
  };

  return channel;
}

/** The frames of one message type, narrowed so their payloads are typed. */
function framesOf<K extends MessageType>(
  messages: readonly ProtocolMessage[],
  type: K,
): Extract<ProtocolMessage, { type: K }>[] {
  return messages.filter((message): message is Extract<ProtocolMessage, { type: K }> =>
    isMessageOfType(message, type),
  );
}

// ---------------------------------------------------------------------------
// Recording watcher — the call order is written into a sequence shared with
// the scripted installer, so the self-write bracket is one array.
// ---------------------------------------------------------------------------

interface RecordingWatcher extends InstrumentationWatcher {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
  /** When set, `suspend` throws after being recorded. */
  failSuspend: boolean;
}

function createRecordingWatcher(sequence: string[]): RecordingWatcher {
  const calls: RecordingWatcher['calls'] = [];

  const note = (method: string, args: readonly unknown[]): void => {
    calls.push({ method, args });
    sequence.push(method);
  };

  const watcher: RecordingWatcher = {
    calls,
    failSuspend: false,
    watchSession(input) {
      note('watchSession', [input]);
      return Promise.resolve(ok([]));
    },
    refresh(sessionId) {
      note('refresh', [sessionId]);
      return Promise.resolve(ok([]));
    },
    suspend(sessionId) {
      note('suspend', [sessionId]);

      if (watcher.failSuspend) {
        throw new Error('the watcher cannot pause');
      }
    },
    resume(sessionId) {
      note('resume', [sessionId]);
    },
    stopSession(sessionId) {
      note('stopSession', [sessionId]);
      return Promise.resolve();
    },
    stopAll() {
      note('stopAll', []);
      return Promise.resolve();
    },
    dispose() {
      note('dispose', []);
      return Promise.resolve();
    },
    watchedFiles: () => [],
    watchIssues: () => [],
  };

  return watcher;
}

/** The watcher and installer entries of the sequence, in call order. */
function bracketOf(sequence: readonly string[]): string[] {
  return sequence.filter((entry) =>
    ['suspend', 'installer', 'watchSession', 'refresh', 'resume'].includes(entry),
  );
}

// ---------------------------------------------------------------------------
// Readiness doubles — a healthy bound page and a connected preload, so the
// readiness gate never probes a dev server and never waits for a reload.
// ---------------------------------------------------------------------------

function healthyAgentReady(): AgentReadyPayload {
  return {
    tabId: TAB_ID,
    documentId: 'doc_servicesuite01',
    producerId: 'prd_servicesuite01',
    url: `${APP_ORIGIN}/panels`,
    installedBeforeReact: true,
    reactDetected: true,
  };
}

function createAgents(): BrowserAgentRegistry {
  return {
    latestAgentReady: (tabId) => (tabId === TAB_ID ? healthyAgentReady() : undefined),
    waitForAgentReady: () => Promise.resolve(undefined),
    latestAgentReadyAt: () => NOW,
  };
}

function createServerAgents(): ServerAgentReadinessSource {
  return {
    hasServerAgentForProject: (projectRoot) => projectRoot === PROJECT_ROOT,
    serverAgentForProject: (projectRoot) =>
      ok({ online: true, lastSeenAt: NOW, connectedAt: NOW, projectRoot }),
  };
}

/** A project whose dev server runs without the preload: no server agent ever connects. */
function createAbsentServerAgents(): ServerAgentReadinessSource {
  return { hasServerAgentForProject: () => false };
}

/** The paste-ready relaunch line the detection double reports. */
const RELAUNCH_COMMAND = 'SAMPLE_PRELOAD=1 pnpm --dir /work/sample-project run dev-sentinel';

/**
 * The dev-server detection of a server that answers without the preload, so
 * the readiness gate never probes a network or reads a manifest.
 */
function detectWithoutPreload(input: {
  readonly projectRoot: string;
}): Promise<DevServerDetection> {
  return Promise.resolve({
    projectRoot: input.projectRoot,
    running: true,
    preloadAttached: false,
    preloadReason: 'no-server-agent-connection',
    packageManager: 'pnpm',
    packageManagerSource: 'project-summary',
    relaunchCommand: RELAUNCH_COMMAND,
    relaunchHint: RELAUNCH_HINT,
    canLaunch: false,
    notes: [],
  });
}

// ---------------------------------------------------------------------------
// Fake adapters with invented ids — the only adapters any install here sees.
// ---------------------------------------------------------------------------

interface FakeAdapter extends ClaimingAdapter {
  readonly installCalls: number[];
  readonly readinessCalls: InstrumentationContext[];
}

function fakeAdapter(id: string, claims: readonly AdapterClaimEntry[]): FakeAdapter {
  const installCalls: number[] = [];
  const readinessCalls: InstrumentationContext[] = [];

  return {
    id,
    claims,
    installCalls,
    readinessCalls,
    canHandle: () => true,
    createPlan: () => Promise.resolve([]),
    install: (actions) => {
      installCalls.push(actions.length);
      return Promise.resolve({ adapterId: id, applied: [], runtimeHooks: [], unavailable: [] });
    },
    remove: () =>
      Promise.resolve({ adapterId: id, restored: [], conflicts: [], runtimeHooksDisabled: [] }),
    readiness: (context) => {
      readinessCalls.push(context);
      return Promise.resolve(buildReadiness({ adapter: id, signals: [], now: clock }));
    },
  };
}

function pageAdapter(): FakeAdapter {
  return fakeAdapter(PAGE_ADAPTER_ID, [
    { type: 'interaction-tracking', mode: 'runtime' },
    { type: 'react-render-tracking', mode: 'runtime' },
    { type: 'state-tracking', mode: 'runtime' },
    { type: 'fetch-tracking', mode: 'runtime' },
  ]);
}

function serverAdapter(): FakeAdapter {
  return fakeAdapter(SERVER_ADAPTER_ID, [
    { type: 'function-timing', mode: 'patch' },
    { type: 'server-span', mode: 'patch' },
    { type: 'db-query-tracking', mode: 'runtime' },
  ]);
}

/** A registry holding only fakes, built through the upstream constructor. */
function fakeRegistry(extra: readonly FakeAdapter[] = []): {
  readonly registry: AdapterRegistry;
  readonly adapters: readonly FakeAdapter[];
} {
  const adapters = [pageAdapter(), serverAdapter(), ...extra];
  return { registry: createAdapterRegistry({ adapters }), adapters };
}

// ---------------------------------------------------------------------------
// Plans — normalised through the upstream `normalizePlan`, never hand-built.
// ---------------------------------------------------------------------------

interface TargetInput {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}

/** Mixed browser and server actions, targetless where the type allows it. */
const BASE_TARGETS: readonly TargetInput[] = [
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'react-render-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'fetch-tracking' },
  { file: 'src/server/alpha-ledger.ts', symbol: 'settleAlphaLedger', type: 'function-timing' },
  { file: 'src/routes/alpha/handler.ts', symbol: 'POST', type: 'server-span' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'db-query-tracking' },
];

/**
 * A follow-up's additions. Two of them share `file` and `symbol` with a base
 * action and differ only in `type`, so a delta computed by file and symbol
 * alone — rather than by `actionIdentityKey` — would drop them.
 */
const DELTA_TARGETS: readonly TargetInput[] = [
  { file: 'src/server/alpha-ledger.ts', symbol: 'settleAlphaLedger', type: 'server-span' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'state-tracking' },
  { file: 'src/server/beta-queue.ts', symbol: 'drainBetaQueue', type: 'function-timing' },
];

let actionCounter = 0;

/** Mints distinct ids matching the upstream action-id pattern. */
function nextActionId(): string {
  actionCounter += 1;
  return `act_${String(actionCounter).padStart(16, '0')}`;
}

interface PlanOptions {
  readonly sessionId?: string;
  readonly planVersion?: number;
  readonly targets?: readonly TargetInput[];
  readonly previousActions?: readonly InstrumentationAction[];
  readonly registry?: AdapterRegistry;
}

function buildPlan(options: PlanOptions = {}): InstrumentationPlan {
  const normalized = normalizePlan(
    {
      objective: 'Find where the time goes when the sample panel saves',
      capture: ['click timing', 'renders', 'requests', 'server spans', 'database queries'],
      hypotheses: ['the save waits on a slow query'],
      instrumentationTargets: (options.targets ?? BASE_TARGETS).map((target) => ({ ...target })),
    },
    {
      sessionId: options.sessionId ?? SESSION_ID,
      planVersion: options.planVersion ?? 1,
      resolver: options.registry ?? fakeRegistry().registry,
      previousActions: options.previousActions,
      newActionId: nextActionId,
    },
  );

  return unwrap(normalized);
}

/** The v1 → v2 follow-up pair: v2 is v1 plus {@link DELTA_TARGETS}. */
function followUpPlans(): {
  readonly previous: InstrumentationPlan;
  readonly next: InstrumentationPlan;
} {
  const previous = buildPlan();
  const next = buildPlan({
    planVersion: 2,
    targets: [...BASE_TARGETS, ...DELTA_TARGETS],
    previousActions: previous.instrumentationTargets,
  });

  return { previous, next };
}

// ---------------------------------------------------------------------------
// The scripted installer result — distinctive, deliberately unsorted values in
// every field, so any reshaping, filtering or sorting downstream is visible.
// ---------------------------------------------------------------------------

function sentinelRecord(
  home: string,
  sessionId: string,
  file: string,
  hashes: readonly [string, string],
  serial: number,
): ModificationRecord {
  const [original, instrumented] = hashes;

  return unwrap(
    createModificationRecord(
      {
        sessionId,
        planVersion: 1,
        file,
        originalHash: digest(original),
        backupPath: `${home}/backups/${sessionId}/${digest(original)}`,
        instrumentedHash: digest(instrumented),
        diff: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after\n`,
        status: 'applied',
      },
      { newId: () => `mod_${String(serial).padStart(16, '0')}`, now: clock },
    ),
  );
}

/** The two degradation entries of the sentinel result, both known capture signals. */
const SENTINEL_UNAVAILABLE: readonly UnavailableSignal[] = [
  {
    signal: 'pg',
    reason: 'sentinel reason: the driver hook refused to attach',
    hint: RELAUNCH_HINT,
  },
  {
    signal: 'errors',
    reason: 'sentinel reason: the page error listener was withheld',
    hint: 'Reload the sample page once, then plan the instrumentation again',
  },
];

/** A recognisable true/false pattern across the seven hook keys. */
const SENTINEL_AGENT_HOOKS: AgentHookConfig = {
  interactions: true,
  react: true,
  state: false,
  fetch: true,
  perf: false,
  errors: false,
  componentTree: true,
};

/** A recognisable signal set with an unsorted `functions` list. */
const SENTINEL_SERVER_SIGNALS: ServerAgentSignals = {
  http: true,
  routeHandlers: true,
  fetch: false,
  prisma: false,
  pg: false,
  functions: ['zetaSentinelStep', 'alphaSentinelStep'],
};

function sentinelResult(home: string, plan: InstrumentationPlan): AggregateInstallResult {
  return {
    applied: [
      sentinelRecord(home, plan.sessionId, 'src/server/zeta-ledger.ts', ['c', 'd'], 9),
      sentinelRecord(home, plan.sessionId, 'src/server/alpha-ledger.ts', ['a', 'b'], 2),
    ],
    runtimeHooks: [
      'sentinel hook zeta',
      CAPTURE_SIGNAL_LABELS.interactions,
      'sentinel hook alpha',
      CAPTURE_SIGNAL_LABELS.react,
    ],
    unavailable: SENTINEL_UNAVAILABLE.map((entry) => ({ ...entry })),
    agentHooks: { ...SENTINEL_AGENT_HOOKS },
    serverSignals: {
      ...SENTINEL_SERVER_SIGNALS,
      functions: [...SENTINEL_SERVER_SIGNALS.functions],
    },
    perAdapter: [],
    planVersion: plan.planVersion,
  };
}

/** A result with nothing reported unavailable, for the paths that need a clean install. */
function cleanResult(home: string, plan: InstrumentationPlan): AggregateInstallResult {
  return { ...sentinelResult(home, plan), unavailable: [] };
}

/** The "nothing at all could be enabled" answer of the installer. */
function nothingEnabledError(hint?: string): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_INSTALL_FAILED',
    'No planned signal could be enabled for this sample project.',
    hint === undefined ? {} : { hint },
  );
}

// ---------------------------------------------------------------------------
// The scripted installer — records what it was handed and answers per script.
// ---------------------------------------------------------------------------

interface InstallerCall {
  readonly plan: InstrumentationPlan;
  readonly context: InstrumentationContext;
  readonly options: InstallPlanOptions;
}

type InstallScript = (call: InstallerCall) => Promise<Result<AggregateInstallResult>>;

interface ScriptedInstaller {
  readonly fn: InstallPlanFn;
  readonly calls: InstallerCall[];
  script: InstallScript;
}

function createScriptedInstaller(sequence: string[], script: InstallScript): ScriptedInstaller {
  const calls: InstallerCall[] = [];

  const installer: ScriptedInstaller = {
    calls,
    script,
    fn: (plan, context, options) => {
      const call: InstallerCall = { plan, context, options };
      calls.push(call);
      sequence.push('installer');
      return installer.script(call);
    },
  };

  return installer;
}

// ---------------------------------------------------------------------------
// The harness — one service over one set of recording doubles.
// ---------------------------------------------------------------------------

function serviceConfig(home: string): ServiceConfig {
  return {
    host: '127.0.0.1',
    port: 20_270,
    logLevel: 'silent',
    retentionDays: 30,
    provider: 'deterministic',
    debuggenHome: home,
    databasePath: `${home}/sessions.sqlite`,
    backupsDir: `${home}/backups`,
    indexCacheDir: `${home}/index`,
    authFilePath: `${home}/auth.json`,
    promptsDir: `${home}/prompts`,
  };
}

/** Placeholder code-analysis handles; the fakes never read them, identity is asserted. */
function codeHandles(): Required<CodeAnalysisHandles> {
  return {
    graph: { tag: 'graph' } as unknown as CodeAnalysisHandles['graph'],
    queries: { tag: 'queries' } as unknown as CodeAnalysisHandles['queries'],
    routeMap: { tag: 'routeMap' } as unknown as CodeAnalysisHandles['routeMap'],
    summary: { tag: 'summary' } as unknown as CodeAnalysisHandles['summary'],
    project: { tag: 'project' } as unknown as NonNullable<CodeAnalysisHandles['project']>,
  };
}

interface Harness {
  readonly service: InstrumentationDriver;
  readonly deps: InstrumentationServiceDeps;
  readonly home: string;
  readonly code: Required<CodeAnalysisHandles>;
  readonly registry: AdapterRegistry;
  readonly adapters: readonly FakeAdapter[];
  readonly installer: ScriptedInstaller;
  readonly journal: MemoryJournal;
  readonly progress: RecordingProgress;
  readonly broadcaster: RecordingBroadcaster;
  readonly agentChannel: RecordingAgentChannel;
  readonly serverChannel: RecordingServerChannel;
  readonly watcher: RecordingWatcher;
  readonly agents: BrowserAgentRegistry;
  readonly serverAgents: ServerAgentReadinessSource;
  readonly log: LogEntry[];
  readonly sequence: string[];
}

interface HarnessOptions {
  readonly script?: InstallScript;
  readonly extraAdapters?: readonly FakeAdapter[];
  readonly captures?: CaptureOwnerLookup;
  readonly journal?: MemoryJournal;
  /** The preload presence the readiness gate reads; defaults to a connected preload. */
  readonly serverAgents?: ServerAgentReadinessSource;
  /** The dev-server detection readiness runs when no preload is connected. */
  readonly detectDevServer?: InstrumentationServiceDeps['detectDevServer'];
}

/** Every state directory created by a harness in the current test. */
const homes: string[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'debuggen-instrumentation-service-'));
  homes.push(home);

  const sequence: string[] = [];
  const log: LogEntry[] = [];
  const { registry, adapters } = fakeRegistry(options.extraAdapters);
  const installer = createScriptedInstaller(
    sequence,
    options.script ?? ((call) => Promise.resolve(ok(sentinelResult(home, call.plan)))),
  );
  const journal = options.journal ?? createMemoryJournal();
  const progress = createRecordingProgress();
  const broadcaster = createRecordingBroadcaster();
  const agentChannel = createRecordingAgentChannel();
  const serverChannel = createRecordingServerChannel();
  const watcher = createRecordingWatcher(sequence);
  const agents = createAgents();
  const serverAgents = options.serverAgents ?? createServerAgents();

  const deps: InstrumentationServiceDeps = {
    config: serviceConfig(home),
    logger: createRecordingLogger(log),
    modifications: journal,
    progress,
    broadcaster,
    agentChannel,
    serverAgentChannel: serverChannel,
    watcher,
    agents,
    serverAgents,
    captures: options.captures,
    adapters: registry,
    installer: installer.fn,
    detectDevServer: options.detectDevServer,
    reloadWaitMs: 0,
    now: clock,
  };

  return {
    service: createInstrumentationService(deps),
    deps,
    home,
    code: codeHandles(),
    registry,
    adapters,
    installer,
    journal,
    progress,
    broadcaster,
    agentChannel,
    serverChannel,
    watcher,
    agents,
    serverAgents,
    log,
    sequence,
  };
}

/** An install request for the harness's project and bound tab. */
function installRequest(
  h: Harness,
  plan: InstrumentationPlan,
  overrides: Partial<InstallRequest> = {},
): InstallRequest {
  return {
    sessionId: plan.sessionId,
    projectRoot: PROJECT_ROOT,
    plan,
    code: h.code,
    boundTab: BOUND_TAB,
    allowReloadPrompt: false,
    ...overrides,
  };
}

/**
 * Every frame the harness sent — to the session fan-out, to the bound tab and
 * to the preload — whether or not a connection took it.
 */
function allMessages(h: Harness): ProtocolMessage[] {
  return [
    ...h.broadcaster.frames.map((frame) => frame.message),
    ...h.agentChannel.frames.map((frame) => frame.message),
    ...h.agentChannel.refused.map((frame) => frame.message),
    ...h.serverChannel.frames.map((frame) => frame.message),
    ...h.serverChannel.refused.map((frame) => frame.message),
  ];
}

function progressCalls(h: Harness, method: ProgressMethod): ProgressCall[] {
  return h.progress.calls.filter((call) => call.method === method);
}

beforeEach(() => {
  actionCounter = 0;
  vi.mocked(evaluateReadiness).mockClear();
});

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Expectations computed from the imported vocabularies, never from literals
// ---------------------------------------------------------------------------

/** The product label of a known capture signal, from the progress module's map. */
function labelOf(signal: string): string {
  const known = CAPTURE_SIGNALS.find((candidate) => candidate === signal);

  if (known === undefined) {
    throw new Error(`expected a known capture signal, got ${signal}`);
  }

  return CAPTURE_SIGNAL_LABELS[known];
}

/**
 * The labels a capture proceeds with for a result whose runtime hooks name
 * only signals the configurations already enable: every enabled signal's label
 * minus the withdrawn ones, in the progress view's display order.
 */
function expectedEnabledLabels(result: AggregateInstallResult): string[] {
  const withdrawn = new Set(result.unavailable.map((entry) => entry.signal));
  const enabled = new Set<CaptureSignal>();

  for (const key of AGENT_HOOK_KEYS) {
    if (result.agentHooks[key]) {
      enabled.add(key);
    }
  }

  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value = result.serverSignals[key];

    if (value === true || (Array.isArray(value) && value.length > 0)) {
      enabled.add(key);
    }
  }

  const labels = new Set(
    CAPTURE_SIGNALS.filter((signal) => enabled.has(signal) && !withdrawn.has(signal)).map(
      (signal) => CAPTURE_SIGNAL_LABELS[signal],
    ),
  );

  return INSTRUMENTATION_ROW_ORDER.filter((label) => labels.has(label));
}

/** The AAP §0.5.5 sentence for one entry, composed from the imported labels. */
function expectedSentence(entry: UnavailableSignal, enabled: readonly string[]): string {
  return `Could not enable ${labelOf(entry.signal)}: ${entry.reason}. Continuing with: ${enabled.join(', ')}.`;
}

/**
 * The signals an installer result arms: every hook flag, every preload flag or
 * non-empty `functions` list, and every signal a runtime hook names exactly by
 * its name or its label.
 */
function armedSignalsOf(
  result: Pick<AggregateInstallResult, 'agentHooks' | 'serverSignals' | 'runtimeHooks'>,
): Set<CaptureSignal> {
  const armed = new Set<CaptureSignal>();

  for (const key of AGENT_HOOK_KEYS) {
    if (result.agentHooks[key]) {
      armed.add(key);
    }
  }

  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value = result.serverSignals[key];

    if (value === true || (Array.isArray(value) && value.length > 0)) {
      armed.add(key);
    }
  }

  for (const signal of CAPTURE_SIGNALS) {
    if (
      result.runtimeHooks.includes(signal) ||
      result.runtimeHooks.includes(CAPTURE_SIGNAL_LABELS[signal])
    ) {
      armed.add(signal);
    }
  }

  return armed;
}

/** The messages of the checklist rows the progress module draws with one status. */
function rowMessages(installed: InstalledSignals, status: ProgressRow['status']): string[] {
  return buildInstrumentationRows(installed)
    .filter((row) => row.status === status)
    .map((row) => row.message);
}

/** The number of readiness evaluations the service has started so far. */
function evaluationCount(): number {
  return vi.mocked(evaluateReadiness).mock.calls.length;
}

// ---------------------------------------------------------------------------
// Message mapping fidelity — the suite's headline
// ---------------------------------------------------------------------------

describe('message mapping', () => {
  it('broadcasts instrumentation.ready with the installer fields exactly as returned', async () => {
    const h = createHarness();
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);

    const outcome = await h.service.install(installRequest(h, plan));

    expect(isOk(outcome)).toBe(true);

    const readyFrames = h.broadcaster.frames.filter(
      (frame) => frame.message.type === 'instrumentation.ready',
    );
    expect(readyFrames).toHaveLength(1);
    expect(first(readyFrames).sessionId).toBe(SESSION_ID);
    expect(first(readyFrames).kinds).toEqual(UI_KINDS);

    const payload = first(framesOf(allMessages(h), 'instrumentation.ready')).payload;

    expect(payload).toStrictEqual({
      sessionId: SESSION_ID,
      applied: expected.applied,
      runtimeHooks: expected.runtimeHooks,
      unavailable: expected.unavailable,
    });
    expect(Object.keys(payload)).toEqual(['sessionId', 'applied', 'runtimeHooks', 'unavailable']);
    expect(instrumentationReadyPayloadSchema.safeParse(payload).success).toBe(true);

    // The fixture is deliberately out of order, so a sort downstream would show.
    const appliedIds = expected.applied.map((record) => record.id);
    expect([...appliedIds].sort()).not.toEqual(appliedIds);
    expect([...expected.runtimeHooks].sort()).not.toEqual(expected.runtimeHooks);
    expect(payload.applied.map((record) => record.id)).toEqual(appliedIds);
    expect(payload.runtimeHooks).toEqual(expected.runtimeHooks);
    expect(payload.unavailable.map((entry) => entry.signal)).toEqual(
      expected.unavailable.map((entry) => entry.signal),
    );

    if (isOk(outcome)) {
      expect(outcome.value.applied).toStrictEqual(expected.applied);
      expect(outcome.value.runtimeHooks).toStrictEqual(expected.runtimeHooks);
      expect(outcome.value.unavailable).toStrictEqual(expected.unavailable);
      expect(outcome.value.agentHooks).toStrictEqual(expected.agentHooks);
      expect(outcome.value.serverSignals).toStrictEqual(expected.serverSignals);
      expect(outcome.value.planVersion).toBe(1);
      expect(outcome.value.activePlanVersion).toBe(1);
      expect(outcome.value.readiness.satisfied).toBe(true);
    }
  });

  it('reports what was armed and readiness confirmed to the progress checklist', async () => {
    const h = createHarness();
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);

    const verdict = unwrap(await h.service.install(installRequest(h, plan))).readiness;

    // The healthy harness: every planned signal has a producer and no gap.
    expect(verdict.deliverableSignals).toEqual(verdict.plannedSignals);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.degraded).toEqual([]);

    const armed = armedSignalsOf(expected);
    const withdrawn = new Set(expected.unavailable.map((entry) => entry.signal));
    const confirmed = CAPTURE_SIGNALS.filter(
      (signal) =>
        verdict.deliverableSignals.includes(signal) && armed.has(signal) && !withdrawn.has(signal),
    );
    const rows = verdict.plannedSignals.map((signal): ReadinessSignal => {
      if (confirmed.includes(signal)) {
        return { signal, status: 'available' };
      }

      const gap = expected.unavailable.find((entry) => entry.signal === signal);
      return gap === undefined
        ? { signal, status: 'unavailable' }
        : { signal, status: 'unavailable', reason: gap.reason, hint: gap.hint };
    });
    const readiness: Readiness = { ready: false, signals: rows, checkedAt: NOW };

    // A planned signal nothing armed, and an armed one the installer withdrew,
    // are both planned and neither is confirmed.
    expect(verdict.plannedSignals).toEqual(expect.arrayContaining(['prisma', 'pg']));
    expect(confirmed).not.toContain('prisma');
    expect(confirmed).not.toContain('pg');
    expect(confirmed.length).toBeGreaterThan(0);

    expect(h.progress.installed).toStrictEqual([
      { signals: confirmed, unavailable: expected.unavailable, readiness },
    ]);
    expect(isOk(parseReadiness(first(h.progress.installed).readiness))).toBe(true);
    expect(progressCalls(h, 'stageStarted').map((call) => call.args[0])).toEqual(['instrument']);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(1);
  });

  it('announces the normalised plan exactly once, before the ready report', async () => {
    const h = createHarness();
    const plan = buildPlan();

    await h.service.install(installRequest(h, plan));

    const planFrames = framesOf(allMessages(h), 'instrumentation.plan');
    expect(planFrames).toHaveLength(1);

    const payload = first(planFrames).payload;
    expect(payload).toStrictEqual({ sessionId: SESSION_ID, plan });
    expect(instrumentationPlanPayloadSchema.safeParse(payload).success).toBe(true);
    expect(isOk(parseInstrumentationPlan(payload.plan))).toBe(true);

    // Normalised, not authored: every action carries its adapter, mode and rationale.
    for (const action of payload.plan.instrumentationTargets) {
      expect([PAGE_ADAPTER_ID, SERVER_ADAPTER_ID]).toContain(action.adapter);
      expect(['runtime', 'patch']).toContain(action.mode);
      expect(action.rationale.length).toBeGreaterThan(0);
    }
    expect(payload.plan.version).toBe(1);

    const types = h.broadcaster.frames.map((frame) => frame.message.type);
    expect(types.indexOf('instrumentation.plan')).toBeLessThan(
      types.indexOf('instrumentation.ready'),
    );
    expect(
      first(h.broadcaster.frames.filter((f) => f.message.type === 'instrumentation.plan')).kinds,
    ).toEqual(UI_KINDS);
  });

  it('does not announce the plan when the caller already has', async () => {
    const h = createHarness();

    await h.service.install(installRequest(h, buildPlan(), { announcePlan: false }));

    expect(framesOf(allMessages(h), 'instrumentation.plan')).toHaveLength(0);
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(1);
  });

  it('arms the page hooks of runtime actions an adapter left unarmed at install time', async () => {
    // The browser adapters report nothing enabled while no page agent has
    // reported, so the installer's page-agent configuration is dormant.
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          ok({
            ...cleanResult(call.context.debuggenHome, call.plan),
            agentHooks: { ...DORMANT_AGENT_HOOK_CONFIG },
          }),
        ),
    });
    await h.service.install(installRequest(h, buildPlan()));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed)).toBe(true);
    const payload = first(framesOf(allMessages(h), 'agent.config')).payload;
    // BASE_TARGETS' three targetless runtime actions: interactions, renders, requests.
    expect(payload.hooks).toMatchObject({
      interactions: true,
      react: true,
      componentTree: true,
      fetch: true,
    });
    expect(agentConfigPayloadSchema.safeParse(payload).success).toBe(true);
    if (isOk(armed)) {
      expect(armed.value.agentHooks).toStrictEqual(payload.hooks);
    }
  });

  it('arms agent.config and server-agent.config with the installer configuration', async () => {
    const h = createHarness();
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);
    await h.service.install(installRequest(h, plan));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed)).toBe(true);
    if (isOk(armed)) {
      expect(armed.value.serverAgent).toBe('delivered');
      expect(armed.value.pageAgent).toBe('delivered');
      expect(armed.value.unavailable).toEqual([]);
      expect(armed.value.agentHooks).toStrictEqual(expected.agentHooks);
      expect(armed.value.serverSignals).toStrictEqual(expected.serverSignals);
    }

    // agent.config goes to the bound tab's connection, whose receipt is the
    // acknowledgement; the session fan-out never carries a producer frame.
    expect(
      h.broadcaster.frames.filter((frame) => frame.message.type === 'agent.config'),
    ).toHaveLength(0);
    const agentFrames = h.agentChannel.frames.filter(
      (frame) => frame.message.type === 'agent.config',
    );
    expect(agentFrames).toHaveLength(1);
    expect(first(agentFrames).sessionId).toBe(SESSION_ID);

    const agentPayload = first(framesOf(allMessages(h), 'agent.config')).payload;
    expect(agentPayload).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      hooks: expected.agentHooks,
    });
    expect(agentConfigPayloadSchema.safeParse(agentPayload).success).toBe(true);

    expect(h.serverChannel.frames).toHaveLength(1);
    expect(first(h.serverChannel.frames).projectRoot).toBe(PROJECT_ROOT);

    const serverPayload = first(framesOf(allMessages(h), 'server-agent.config')).payload;
    expect(serverPayload).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      signals: expected.serverSignals,
    });
    expect(serverPayload.signals.functions).toEqual(SENTINEL_SERVER_SIGNALS.functions);
    expect(serverAgentConfigPayloadSchema.safeParse(serverPayload).success).toBe(true);
    expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBe(CAPTURE_ID);
  });

  it('disarms with the imported dormant and disabled constants, the preload frame carrying no capture', async () => {
    const h = createHarness();
    await h.service.install(installRequest(h, buildPlan()));
    h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });

    expect(isOk(disarmed)).toBe(true);
    if (isOk(disarmed)) {
      expect(disarmed.value.agentDisarmed).toBe(true);
      expect(disarmed.value.pageAgent).toBe('delivered');
      expect(disarmed.value.serverAgent).toBe('delivered');
      expect(disarmed.value.captureId).toBe(CAPTURE_ID);
      expect(disarmed.value.pending).toEqual([]);
    }
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);

    const agentPayloads = framesOf(allMessages(h), 'agent.config').map((frame) => frame.payload);
    expect(agentPayloads).toHaveLength(2);
    const dormant = agentPayloads[1];
    expect(dormant).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      hooks: DORMANT_AGENT_HOOK_CONFIG,
    });
    expect(agentConfigPayloadSchema.safeParse(dormant).success).toBe(true);

    const serverMessages = framesOf(
      h.serverChannel.frames.map((frame) => frame.message),
      'server-agent.config',
    );
    expect(serverMessages).toHaveLength(2);

    const disable = serverMessages[1];
    expect(disable?.payload).toStrictEqual({ signals: DISABLED_SERVER_AGENT_SIGNALS });
    expect(disable !== undefined && 'captureId' in disable.payload).toBe(false);
    expect(disable !== undefined && 'sessionId' in disable.payload).toBe(false);
    expect(disable !== undefined && 'sessionId' in disable).toBe(false);
    expect(serverAgentConfigPayloadSchema.safeParse(disable?.payload).success).toBe(true);
    expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBeUndefined();
  });

  it('leaves the preload disabled for a plan that collects nothing server-side', async () => {
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          ok({
            ...cleanResult(call.context.debuggenHome, call.plan),
            serverSignals: { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] },
          }),
        ),
    });
    await h.service.install(installRequest(h, buildPlan()));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed) && armed.value.serverAgent).toBe('not-needed');
    expect(isOk(armed) && armed.value.pageAgent).toBe('delivered');
    expect(h.serverChannel.frames).toHaveLength(0);
    expect(framesOf(allMessages(h), 'agent.config')).toHaveLength(1);
  });

  it('never switches off a preload another session is capturing through', async () => {
    const owner: CaptureOwner = { sessionId: OTHER_SESSION_ID, captureId: 'cap_servicesuite0002' };
    const h = createHarness({ captures: { captureOwnerForProject: () => owner } });
    await h.service.install(installRequest(h, buildPlan()));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isErr(armed) && armed.error.code).toBe('CAPTURE_ALREADY_ACTIVE');
    expect(isOk(disarmed) && disarmed.value.serverAgent).toBe('skipped-other-owner');
    // The refused arm sent the page nothing; the other owner's preload is never owed a disarm.
    expect(isOk(disarmed) && disarmed.value.pending).toEqual([]);
    expect(h.serverChannel.frames).toHaveLength(0);
    expect(h.serverChannel.refused).toHaveLength(0);
  });

  it('recomputes the arming state after a restart with the upstream derivations', () => {
    const h = createHarness();
    const plan = buildPlan();

    const armed = h.service.armCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
      plan,
    });

    expect(isOk(armed)).toBe(true);
    expect(first(framesOf(allMessages(h), 'agent.config')).payload.hooks).toStrictEqual(
      deriveAgentHookConfig(plan.instrumentationTargets),
    );
    expect(first(framesOf(allMessages(h), 'server-agent.config')).payload.signals).toStrictEqual(
      deriveServerAgentSignals(plan.instrumentationTargets),
    );
    expect(h.installer.calls).toHaveLength(0);
  });

  it('builds every frame through createEnvelope, with a type the protocol declares', async () => {
    const h = createHarness();
    await h.service.install(installRequest(h, buildPlan()));
    h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    h.service.disarmCapture({ sessionId: SESSION_ID });

    const failing = createHarness({ script: () => Promise.resolve(err(nothingEnabledError())) });
    await failing.service.install(installRequest(failing, buildPlan()));

    const messages = [...allMessages(h), ...allMessages(failing)];
    const declared: readonly string[] = MESSAGE_TYPES;

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(declared, `"${message.type}" must be a declared message type`).toContain(message.type);
      expect(isOk(parseMessage(message)), `${message.type} must parse as a frame`).toBe(true);
      expect(message.ts).toBe(NOW);
      expect(message.id.length).toBeGreaterThan(0);

      if (message.sessionId !== undefined) {
        expect(message.sessionId).toBe(SESSION_ID);
      }
    }

    expect(new Set(messages.map((message) => message.type))).toEqual(
      new Set([
        'instrumentation.plan',
        'instrumentation.ready',
        'instrumentation.failed',
        'agent.config',
        'server-agent.config',
      ]),
    );

    for (const frame of [...h.broadcaster.frames, ...failing.broadcaster.frames]) {
      expect(frame.sessionId).toBe(SESSION_ID);
      expect(frame.kinds).not.toBe('all');
      expect(frame.message.type).not.toBe('agent.config');
    }

    // Both producer frames went to their single recipients: the bound tab
    // (arm, then disarm) and the project's preload.
    expect(h.agentChannel.frames.map((frame) => frame.message.type)).toEqual([
      'agent.config',
      'agent.config',
    ]);
    for (const frame of h.agentChannel.frames) {
      expect(frame.sessionId).toBe(SESSION_ID);
    }
    expect(h.serverChannel.frames.map((frame) => frame.projectRoot)).toEqual([
      PROJECT_ROOT,
      PROJECT_ROOT,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Degradation and failure (AAP §0.5.5)
// ---------------------------------------------------------------------------

describe('degradation', () => {
  it('emits one notice per unavailable signal and still reports the install ready', async () => {
    const h = createHarness();
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);
    const enabled = expectedEnabledLabels(expected);
    const sentences = expected.unavailable.map((entry) => expectedSentence(entry, enabled));

    const outcome = await h.service.install(installRequest(h, plan));

    expect(expected.unavailable).toHaveLength(2);
    expect(enabled.length).toBeGreaterThan(0);
    expect(h.progress.emitted).toStrictEqual(
      expected.unavailable.map((entry, index) => ({
        stage: 'instrument',
        status: 'running',
        message: sentences[index],
        detail: entry.hint,
      })),
    );

    for (const [index, entry] of expected.unavailable.entries()) {
      const sentence = sentences[index] ?? '';
      expect(sentence.startsWith(`Could not enable ${labelOf(entry.signal)}: `)).toBe(true);
      expect(sentence).toContain(entry.reason);
      expect(sentence).not.toContain(entry.hint);
    }

    expect(isOk(outcome) && outcome.value.degradations).toStrictEqual(sentences);
    expect(progressCalls(h, 'stageFailed')).toHaveLength(0);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(0);
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(1);
  });

  it('carries a server-tier relaunch hint verbatim as the row detail and in the ready report', async () => {
    const h = createHarness();

    await h.service.install(installRequest(h, buildPlan()));

    const serverGap = h.progress.emitted.find((row) => row.message.includes(labelOf('pg')));
    expect(serverGap?.detail).toBe(RELAUNCH_HINT);
    expect(
      first(framesOf(allMessages(h), 'instrumentation.ready')).payload.unavailable[0]?.hint,
    ).toBe(RELAUNCH_HINT);
  });

  it('emits no notice when every planned signal was enabled', async () => {
    const h = createHarness({
      script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
    });

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isOk(outcome) && outcome.value.degradations).toEqual([]);
    expect(h.progress.emitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The checklist is drawn from what readiness confirmed (AAP §0.5.5, prompt §11
// Step 8): readiness first, ✓ only for an armed signal with a producer that
// will deliver it, "Ready to capture" last and only when satisfied.
// ---------------------------------------------------------------------------

describe('progress checklist', () => {
  it('evaluates readiness before any checklist row, and closes the group with one Ready to capture', async () => {
    const h = createHarness();
    const probes = (): number =>
      h.adapters.reduce((sum, adapter) => sum + adapter.readinessCalls.length, 0);
    const seen: {
      readonly method: ProgressMethod;
      readonly evaluations: number;
      readonly probes: number;
    }[] = [];
    h.progress.listeners.push((method) => {
      seen.push({ method, evaluations: evaluationCount(), probes: probes() });
    });

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isOk(outcome) && outcome.value.readiness.satisfied).toBe(true);
    // The header, the two degradation rows, the checklist, then the closing row, once.
    const order: readonly ProgressMethod[] = [
      'stageStarted',
      'emit',
      'emit',
      'reportInstrumentation',
      'readyToCapture',
    ];
    expect(h.progress.calls.map((call) => call.method)).toEqual(order);
    expect(seen.map((entry) => entry.method)).toEqual(order);

    // Nothing had been evaluated when the stage opened; every later row was
    // sent after the gate had asked the adapters and answered.
    expect(first(seen)).toStrictEqual({ method: 'stageStarted', evaluations: 0, probes: 0 });
    for (const entry of seen.slice(1)) {
      expect(entry.evaluations, `${entry.method} must follow the readiness verdict`).toBe(1);
      expect(entry.probes, `${entry.method} must follow the adapter probes`).toBeGreaterThan(0);
    }

    // The gate is told not to announce readiness itself, so the row cannot come early.
    const calls = vi.mocked(evaluateReadiness).mock.calls;
    expect(calls).toHaveLength(1);
    expect(first(calls)[1].announceReady).toBe(false);
  });

  it('checks no server row when no preload is connected, and reports each server signal as not enabled', async () => {
    const h = createHarness({
      serverAgents: createAbsentServerAgents(),
      detectDevServer: detectWithoutPreload,
      script: (call) => {
        const clean = cleanResult(call.context.debuggenHome, call.plan);

        return Promise.resolve(
          ok({
            ...clean,
            // Every server signal the plan names is armed, and the runtime
            // hooks name two server labels, so only readiness can withhold them.
            serverSignals: deriveServerAgentSignals(call.plan.instrumentationTargets),
            runtimeHooks: [
              ...clean.runtimeHooks,
              CAPTURE_SIGNAL_LABELS.http,
              CAPTURE_SIGNAL_LABELS.prisma,
            ],
          }),
        );
      },
    });

    const outcome = unwrap(await h.service.install(installRequest(h, buildPlan())));
    const verdict = outcome.readiness;
    const serverSignals = ['http', 'routeHandlers', 'prisma', 'pg', 'functions'] as const;
    const pageSignals = ['interactions', 'react', 'fetch', 'componentTree'] as const;

    // The missing preload degrades the capture — it does not block it — and
    // no server signal has a producer.
    expect(verdict.satisfied).toBe(true);
    for (const signal of serverSignals) {
      expect(verdict.plannedSignals).toContain(signal);
      expect(verdict.deliverableSignals).not.toContain(signal);
    }

    const report = first(h.progress.installed);
    expect(Object.keys(report).sort()).toEqual(['readiness', 'signals', 'unavailable']);
    expect(report.signals).toEqual(pageSignals);
    expect(isOk(parseReadiness(report.readiness))).toBe(true);

    const done = rowMessages(report, 'done');
    const failed = buildInstrumentationRows(report).filter((row) => row.status === 'failed');

    for (const signal of serverSignals) {
      expect(done).not.toContain(labelOf(signal));
      expect(
        failed.some((row) => row.message.startsWith(`Could not enable ${labelOf(signal)}: `)),
        `${labelOf(signal)} must be reported as not enabled`,
      ).toBe(true);
    }

    for (const signal of pageSignals) {
      expect(done).toContain(labelOf(signal));
    }

    // Each ✗ row carries the gate's reason and its relaunch hint as the detail.
    expect(verdict.degraded.length).toBeGreaterThan(0);
    for (const gap of verdict.degraded) {
      const row = failed.find((candidate) =>
        candidate.message.startsWith(`Could not enable ${labelOf(gap.signal)}: `),
      );
      expect(row?.message).toContain(gap.reason.replace(/[\s.]+$/u, ''));
      expect(row?.detail).toBe(gap.hint);
    }

    // Drawn from the requested configuration alone, without the readiness
    // verdict, the checklist would check every server signal although no
    // preload is connected to produce one — the false success the
    // verdict-based report prevents.
    const requested = rowMessages(
      {
        hooks: outcome.agentHooks,
        serverSignals: outcome.serverSignals,
        runtimeHooks: outcome.runtimeHooks,
        unavailable: outcome.unavailable,
      },
      'done',
    );
    expect(requested).toEqual(expect.arrayContaining(serverSignals.map(labelOf)));

    const methods = h.progress.calls.map((call) => call.method);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(1);
    expect(methods.indexOf('reportInstrumentation')).toBeLessThan(
      methods.indexOf('readyToCapture'),
    );
  });

  it('withholds Ready to capture when the verdict is not satisfied, and checks no page row', async () => {
    const h = createHarness({
      script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
    });

    const outcome = await h.service.install(
      installRequest(h, buildPlan(), { boundTab: undefined }),
    );
    const verdict = unwrap(outcome).readiness;

    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations.map((remediation) => remediation.kind)).toContain('bind-tab');
    // The request signal is gated in the page yet still counts as deliverable
    // through the connected preload, whose configuration does not arm it: it
    // must not be checked either.
    expect(verdict.deliverableSignals).toContain('fetch');
    expect(verdict.blocking.map((gap) => gap.signal)).toContain('fetch');
    expect(progressCalls(h, 'reportInstrumentation')).toHaveLength(1);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(0);

    const report = first(h.progress.installed);
    const done = rowMessages(report, 'done');
    const failed = rowMessages(report, 'failed');

    for (const signal of ['interactions', 'react', 'fetch', 'componentTree'] as const) {
      expect(done).not.toContain(labelOf(signal));
      expect(
        failed.some((message) => message.startsWith(`Could not enable ${labelOf(signal)}`)),
      ).toBe(true);
    }

    // The server signals the connected preload delivers stay checked.
    expect(done).toEqual(expect.arrayContaining([labelOf('http'), labelOf('functions')]));
  });

  it.each([
    {
      name: 'answers Err',
      script: (): void => {
        vi.mocked(evaluateReadiness).mockResolvedValueOnce(
          err(
            new DebuggenError('INTERNAL', 'Readiness could not be evaluated in the sample suite.'),
          ),
        );
      },
    },
    {
      name: 'rejects',
      script: (): void => {
        vi.mocked(evaluateReadiness).mockRejectedValueOnce(
          new Error('the sample readiness gate broke'),
        );
      },
    },
  ])(
    'reports only the installer gaps, as ✗ rows, when the readiness gate $name',
    async ({ script }) => {
      const h = createHarness();
      const plan = buildPlan();
      const expected = sentinelResult(h.home, plan);
      script();

      const outcome = await h.service.install(installRequest(h, plan));

      expect(isErr(outcome)).toBe(true);
      expect(isErr(outcome) && outcome.error.code).toBe('INTERNAL');
      expect(isErr(outcome) && outcome.error.details?.['planVersion']).toBe(1);

      expect(h.progress.installed).toStrictEqual([{ unavailable: expected.unavailable }]);
      const report = first(h.progress.installed);
      expect(rowMessages(report, 'done')).toEqual([]);
      expect(rowMessages(report, 'failed')).toHaveLength(expected.unavailable.length);

      // The degradation rows name no signal as one the capture continues with.
      expect(h.progress.emitted.map((row) => row.message)).toStrictEqual(
        buildDegradationNotice(expected.unavailable, []),
      );
      expect(progressCalls(h, 'readyToCapture')).toHaveLength(0);
      expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(1);
    },
  );

  it('checks a page signal the capture arms from the plan even when the installer left its hook dormant', async () => {
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          ok({
            ...cleanResult(call.context.debuggenHome, call.plan),
            agentHooks: { ...DORMANT_AGENT_HOOK_CONFIG },
            runtimeHooks: [],
          }),
        ),
    });
    await h.service.install(installRequest(h, buildPlan()));

    const report = first(h.progress.installed);
    const armed = unwrap(
      h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID }),
    ).agentHooks;
    const pageSignals = (report.signals ?? []).filter((signal) =>
      AGENT_HOOK_KEYS.some((key) => key === signal),
    );

    // BASE_TARGETS' targetless runtime actions: interactions, renders, requests.
    expect(pageSignals).toEqual(['interactions', 'react', 'fetch', 'componentTree']);
    for (const key of AGENT_HOOK_KEYS) {
      expect(armed[key], `the ✓ for ${key} must match agent.config`).toBe(
        pageSignals.some((signal) => signal === key),
      );
    }
  });

  it('builds every aggregate row within the readiness schema, whatever text the verdict carries', async () => {
    const h = createHarness();
    const noisy: ReadinessVerdict = {
      satisfied: true,
      perAdapter: [],
      blocking: [],
      degraded: [
        {
          signal: 'http',
          reason: `the preload\nrefused\u0085twice ${'r'.repeat(900)}`,
          hint: `relaunch\twith\u0000 the preload ${'h'.repeat(1500)}`,
        },
        { signal: 'react', reason: ' \n\t ', hint: '\u0090' },
      ],
      remediations: [],
      plannedSignals: ['interactions', 'react', 'http'],
      deliverableSignals: ['interactions', 'react'],
      evaluatedAt: NOW,
      observed: {},
      reloadRequested: false,
    };
    vi.mocked(evaluateReadiness).mockResolvedValueOnce(ok(noisy));

    await h.service.install(installRequest(h, buildPlan()));

    const readiness = first(h.progress.installed).readiness;
    expect(isOk(parseReadiness(readiness))).toBe(true);
    expect(readiness !== undefined && 'adapter' in readiness).toBe(false);

    const bySignal = new Map(readiness?.signals.map((row) => [row.signal, row] as const));
    expect(bySignal.get('interactions')).toStrictEqual({
      signal: 'interactions',
      status: 'available',
    });
    // A confirmed signal the verdict holds a gap for stays checked, as degraded;
    // texts with nothing printable left are omitted rather than sent blank.
    expect(bySignal.get('react')).toStrictEqual({ signal: 'react', status: 'degraded' });

    const http = bySignal.get('http');
    expect(http?.status).toBe('unavailable');
    expect(http?.reason?.length).toBe(READINESS_REASON_MAX_LENGTH);
    expect(http?.reason?.startsWith('the preload refused twice r')).toBe(true);
    expect(http?.reason?.endsWith('…')).toBe(true);
    expect(http?.hint?.length).toBe(READINESS_HINT_MAX_LENGTH);
    expect(http?.hint?.startsWith('relaunch with the preload h')).toBe(true);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(1);
  });
});

describe('buildDegradationNotice', () => {
  const enabled = [CAPTURE_SIGNAL_LABELS.http, CAPTURE_SIGNAL_LABELS.fetch];
  const pgGap: UnavailableSignal = {
    signal: 'pg',
    reason: 'the driver hook refused to attach',
    hint: RELAUNCH_HINT,
  };
  const errorsGap: UnavailableSignal = {
    signal: 'errors',
    reason: 'the page error listener was withheld',
    hint: 'Reload the sample page once',
  };
  const customGap: UnavailableSignal = {
    signal: 'sample-custom-signal',
    reason: 'the sample probe is offline',
    hint: 'Start the sample probe',
  };
  const continuing = `Continuing with: ${enabled.join(', ')}.`;

  const cases: readonly {
    readonly name: string;
    readonly unavailable: readonly UnavailableSignal[];
    readonly expected: readonly string[];
  }[] = [
    { name: 'an empty list yields no sentence', unavailable: [], expected: [] },
    {
      name: 'one entry yields one sentence with the product label',
      unavailable: [pgGap],
      expected: [`Could not enable ${labelOf('pg')}: ${pgGap.reason}. ${continuing}`],
    },
    {
      name: 'several entries keep input order, and an adapter-defined signal names itself',
      unavailable: [errorsGap, pgGap, customGap],
      expected: [
        `Could not enable ${labelOf('errors')}: ${errorsGap.reason}. ${continuing}`,
        `Could not enable ${labelOf('pg')}: ${pgGap.reason}. ${continuing}`,
        `Could not enable ${customGap.signal}: ${customGap.reason}. ${continuing}`,
      ],
    },
  ];

  it.each(cases)('$name', ({ unavailable, expected }) => {
    const input = Object.freeze(unavailable.map((entry) => Object.freeze({ ...entry })));
    const hints = input.map((entry) => entry.hint);

    const sentences = buildDegradationNotice(input, Object.freeze([...enabled]));

    expect(sentences).toStrictEqual(expected);
    expect(Object.isFrozen(sentences)).toBe(true);
    expect(buildDegradationNotice(input, enabled)).toStrictEqual(sentences);
    // The hint travels beside the sentence, verbatim, and never inside it.
    expect(input.map((entry) => entry.hint)).toEqual(hints);
    for (const sentence of sentences) {
      for (const hint of hints) {
        expect(sentence).not.toContain(hint);
      }
    }
  });

  it('closes a reason that ends in punctuation exactly once', () => {
    const [sentence] = buildDegradationNotice(
      [{ ...pgGap, reason: 'the driver hook refused to attach.' }],
      enabled,
    );

    expect(sentence).toBe(`Could not enable ${labelOf('pg')}: ${pgGap.reason}. ${continuing}`);
  });

  it('collapses byte-identical sentences onto the first', () => {
    expect(
      buildDegradationNotice([pgGap, { ...pgGap, hint: 'another hint' }], enabled),
    ).toHaveLength(1);
  });
});

describe('failure', () => {
  it('reports instrumentation.failed, never ready, when nothing at all could be enabled', async () => {
    // A recovery step a product builder registered is proven, and kept verbatim.
    const error = nothingEnabledError(
      authorProductText('Start the sample dev server with the preload, then plan again'),
    );
    const wire = error.toPayload();
    const h = createHarness({ script: () => Promise.resolve(err(error)) });

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe(error.code);
      expect(outcome.error.details?.['planVersion']).toBe(1);
    }

    const failedFrames = framesOf(allMessages(h), 'instrumentation.failed');
    expect(failedFrames).toHaveLength(1);

    const stage: ProgressStage = 'instrument';
    const payload = first(failedFrames).payload;
    const ref = payload.error.ref ?? '';
    const message = `${publicFailureCopy(stage, wire.code).message} (ref: ${ref})`;
    expect(ref).toMatch(/^msg_/u);
    expect(payload).toStrictEqual({
      sessionId: SESSION_ID,
      error: { code: wire.code, message, hint: wire.hint, ref },
    });
    expect(payload.error.hint).toBe(error.hint);
    expect(instrumentationFailedPayloadSchema.safeParse(payload).success).toBe(true);

    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(0);
    expect(h.progress.emitted).toEqual([]);
    expect(progressCalls(h, 'reportInstrumentation')).toHaveLength(0);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(0);

    expect(h.progress.failures).toStrictEqual([
      { stage, code: wire.code, message, hint: wire.hint },
    ]);
    expect(h.service.arming(SESSION_ID)).toBeUndefined();

    // The error itself is logged locally, under the reference the frame shows:
    // once at `warn`, and once more at `debug` for the redacted diagnostic.
    const records = h.log.filter((entry) => entry.message === 'The instrumentation install failed');
    expect(records).toHaveLength(1);
    expect(first(records).level).toBe('warn');
    expect(first(records).fields).toMatchObject({
      code: wire.code,
      ref,
      [LOG_ERROR_FIELD_KEY]: error,
    });
    const carrying = h.log.filter((entry) => entry.fields?.[LOG_ERROR_FIELD_KEY] === error);
    expect(carrying.map((entry) => entry.level)).toEqual(['warn', 'debug']);
    expect(carrying[1]?.fields).toStrictEqual({
      code: wire.code,
      ref,
      [LOG_ERROR_FIELD_KEY]: error,
    });
  });

  it('supplies the code’s default hint when the installer error carries none', async () => {
    const h = createHarness({ script: () => Promise.resolve(err(nothingEnabledError())) });

    await h.service.install(installRequest(h, buildPlan()));

    const { hint } = publicFailureCopy('instrument', 'INSTRUMENTATION_INSTALL_FAILED');
    const payload = first(framesOf(allMessages(h), 'instrumentation.failed')).payload;
    expect(payload.error.hint).toBe(hint);
    expect(first(h.progress.failures).hint).toBe(hint);
  });

  it('never lets an installer error’s own text reach instrumentation.failed or the failed row', async () => {
    const sentinel = "/home/dev/private-project/db.ts?grant=sentinel-7e3a WHERE email = 'a@b.c'";
    const scripts: readonly InstallScript[] = [
      () =>
        Promise.resolve(
          err(
            new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', `adapter said: ${sentinel}`, {
              hint: `Relaunch the dev server from ${sentinel}, then plan again.`,
            }),
          ),
        ),
      // The installer's "nothing could be enabled" failure carries the blocked
      // gap's hint, which is an adapter's words, not the product's.
      () =>
        Promise.resolve(
          err(
            new DebuggenError('INSTRUMENTATION_UNAVAILABLE', `Could not enable pg: ${sentinel}.`, {
              hint: `Run SELECT * FROM grants WHERE token = '${sentinel}' then retry`,
              details: { blockedSignal: 'pg' },
            }),
          ),
        ),
      () => Promise.reject(new Error(`driver failure at ${sentinel}`)),
    ];

    for (const script of scripts) {
      const h = createHarness({ script });

      await h.service.install(installRequest(h, buildPlan()));

      const payload = first(framesOf(allMessages(h), 'instrumentation.failed')).payload;
      const failure = first(h.progress.failures);
      const copy = publicFailureCopy('instrument', payload.error.code);
      expect(payload.error.message).toBe(`${copy.message} (ref: ${payload.error.ref ?? ''})`);
      expect(JSON.stringify(payload)).not.toContain('sentinel-7e3a');
      expect(JSON.stringify(failure)).not.toContain('sentinel-7e3a');
      expect(failure.message).toBe(payload.error.message);
      // No hint here is proven product text, so the code's copy stands in, on
      // the frame and on the failed row alike.
      expect(payload.error.hint).toBe(copy.hint);
      expect(failure.hint).toBe(copy.hint);
      expect(isProductAuthoredText(failure.hint)).toBe(true);
    }
  });

  it('prefers the relaunch hint its own detection composed over an adapter’s, when the preload is missing', async () => {
    const sentinel = 'sentinel-5d2b';
    const detections: DevServerDetection[] = [];
    const h = createHarness({
      script: () =>
        Promise.resolve(
          err(
            new DebuggenError(
              'INSTRUMENTATION_UNAVAILABLE',
              'No instrumentation could be enabled for this plan.',
              {
                hint: `Restart with: SAMPLE_TOKEN=${sentinel} pnpm --dir /home/dev/${sentinel} dev`,
                details: { blockedSignal: 'http' },
              },
            ),
          ),
        ),
    });
    // The same collaborators, but no preload connected for the project, so
    // readiness runs the real detection and keeps what it composed.
    const service = createInstrumentationService({
      ...h.deps,
      serverAgents: { hasServerAgentForProject: () => false },
      detectDevServer: async (input, detectDeps) => {
        const detection = await detectDevServer(input, detectDeps);
        detections.push(detection);
        return detection;
      },
    });

    const outcome = await service.install(installRequest(h, buildPlan()));

    const detection = first(detections);
    expect(detection.preloadAttached).toBe(false);
    expect(isProductAuthoredText(detection.relaunchHint)).toBe(true);

    const payload = first(framesOf(allMessages(h), 'instrumentation.failed')).payload;
    const failure = first(h.progress.failures);
    expect(payload.error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(payload.error.hint).toBe(detection.relaunchHint);
    expect(payload.error.hint).toContain(detection.relaunchCommand);
    expect(failure.hint).toBe(detection.relaunchHint);
    expect(isProductAuthoredText(failure.hint)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(sentinel);
    expect(JSON.stringify(failure)).not.toContain(sentinel);

    // The caller is told the same recovery; the installer's own words stay the
    // cause, for the local diagnostic only.
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.hint).toBe(detection.relaunchHint);
    }
  });

  it('keeps the code’s copy when no detection of its own proves a relaunch command', async () => {
    const sentinel = 'sentinel-8e61';
    const h = createHarness({
      script: () =>
        Promise.resolve(
          err(
            new DebuggenError(
              'INSTRUMENTATION_UNAVAILABLE',
              'No instrumentation could be enabled.',
              {
                hint: `Restart with: SAMPLE_TOKEN=${sentinel} pnpm dev`,
                details: { blockedSignal: 'http' },
              },
            ),
          ),
        ),
    });
    // A detection this process did not compose — its hint is not registered.
    const service = createInstrumentationService({
      ...h.deps,
      serverAgents: { hasServerAgentForProject: () => false },
      detectDevServer: async (input, detectDeps) => ({
        ...(await detectDevServer(input, detectDeps)),
        relaunchHint: `Restart with: ${sentinel}`,
      }),
    });

    await service.install(installRequest(h, buildPlan()));

    const payload = first(framesOf(allMessages(h), 'instrumentation.failed')).payload;
    const copy = publicFailureCopy('instrument', 'INSTRUMENTATION_UNAVAILABLE');
    expect(payload.error.hint).toBe(copy.hint);
    expect(first(h.progress.failures).hint).toBe(copy.hint);
    expect(JSON.stringify(payload)).not.toContain(sentinel);
  });

  it('leaves the failed row to a caller that reports the stage failure itself', async () => {
    const h = createHarness({ script: () => Promise.resolve(err(nothingEnabledError())) });

    await h.service.install(installRequest(h, buildPlan(), { reportStageFailure: false }));

    expect(h.progress.failures).toEqual([]);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
  });

  it('contains a throwing broadcaster: install resolves to a typed Err and the throw is logged', async () => {
    const h = createHarness();
    h.broadcaster.failing = true;

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error).toBeInstanceOf(DebuggenError);
      expect(DEBUGGEN_ERROR_CODES).toContain(outcome.error.code);
    }
    expect(
      h.log.some(
        (entry) => entry.level === 'error' && entry.fields?.['collaborator'] === 'broadcaster',
      ),
    ).toBe(true);
    expect(h.service.isInstalling(SESSION_ID)).toBe(false);
  });

  it('names a throwing collaborator by its closed exception class, never by the name or message it carries', async () => {
    const sentinel = '/home/dev/private-project/.env?grant=sentinel-4c1e';
    const hostile = new Error(`SELECT secret FROM vault WHERE path = '${sentinel}'`);
    hostile.name = `TypeError: ${sentinel}`;
    const h = createHarness();
    h.broadcaster.broadcastToKinds = () => {
      throw hostile;
    };

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.details?.['failures']).toContainEqual({
      collaborator: 'broadcaster',
      step: 'instrumentation.plan',
      errorClass: 'Error',
    });
    expect(JSON.stringify(outcome.error.details)).not.toContain(sentinel);

    const records = h.log.filter((entry) => entry.fields?.['collaborator'] === 'broadcaster');
    expect(records.length).toBeGreaterThan(0);
    for (const entry of records) {
      const { [LOG_ERROR_FIELD_KEY]: caught, ...closed } = entry.fields ?? {};
      // The value itself goes only under the error key, for the serializer.
      expect(caught).toBe(hostile);
      expect(closed['errorClass']).toBe('Error');
      expect(JSON.stringify(closed)).not.toContain(sentinel);
    }
  });

  it('contains a throwing progress emitter: install resolves to a typed Err and the throw is logged', async () => {
    const h = createHarness();
    for (const method of [
      'emit',
      'stageStarted',
      'stageFailed',
      'reportInstrumentation',
      'readyToCapture',
    ] as const) {
      h.progress.throwing.add(method);
    }

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(DEBUGGEN_ERROR_CODES).toContain(outcome.error.code);
    }
    expect(
      h.log.some(
        (entry) => entry.level === 'error' && entry.fields?.['collaborator'] === 'progress',
      ),
    ).toBe(true);
  });

  it('contains an installer that rejects: install resolves to a typed Err and reports the failure', async () => {
    const h = createHarness({
      script: () => Promise.reject(new Error('the sample installer broke')),
    });

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome) && outcome.error.code).toBe('INTERNAL');
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Follow-up delta semantics (AAP §0.4.2)
// ---------------------------------------------------------------------------

/** The ids of `next`'s actions whose identity `previous` does not carry. */
function additiveIds(previous: InstrumentationPlan, next: InstrumentationPlan): string[] {
  const installed = new Set(
    previous.instrumentationTargets.map((action) => actionIdentityKey(action)),
  );

  return next.instrumentationTargets
    .filter((action) => !installed.has(actionIdentityKey(action)))
    .map((action) => action.id);
}

describe('follow-up delta', () => {
  it('hands the installer only the additive action ids, by actionIdentityKey', async () => {
    const { previous, next } = followUpPlans();
    const h = createHarness();
    const expectedIds = additiveIds(previous, next);

    const outcome = await h.service.install(
      installRequest(h, next, {
        previousPlanVersion: 1,
        previousActions: previous.instrumentationTargets,
      }),
    );

    expect(isOk(outcome)).toBe(true);
    expect(isOk(outcome) && outcome.value.activePlanVersion).toBe(2);

    // The fixture: surviving actions keep their ids, and every delta target is new.
    expect(
      next.instrumentationTargets.slice(0, previous.instrumentationTargets.length).map((a) => a.id),
    ).toEqual(previous.instrumentationTargets.map((action) => action.id));
    expect(expectedIds).toHaveLength(DELTA_TARGETS.length);

    const call = first(h.installer.calls);
    expect(call.plan).toBe(next);
    expect(call.context.planVersion).toBe(2);
    expect(call.options.delta).toStrictEqual({ previousPlanVersion: 1, actionIds: expectedIds });

    const installedIds = new Set(previous.instrumentationTargets.map((action) => action.id));
    expect(call.options.delta?.actionIds.some((id) => installedIds.has(id))).toBe(false);

    // A delta judged by file and symbol alone would lose two of the additions.
    const byFileAndSymbol = new Set(
      previous.instrumentationTargets.map((action) => `${action.file}\u0000${action.symbol}`),
    );
    const naive = next.instrumentationTargets
      .filter((action) => !byFileAndSymbol.has(`${action.file}\u0000${action.symbol}`))
      .map((action) => action.id);
    expect(naive).not.toEqual(expectedIds);
  });

  it('computes the delta against the actions this service installed when none are passed', async () => {
    const { previous, next } = followUpPlans();
    const h = createHarness();
    await h.service.install(installRequest(h, previous));

    const outcome = await h.service.install(installRequest(h, next, { previousPlanVersion: 1 }));

    expect(isOk(outcome)).toBe(true);
    expect(h.installer.calls[1]?.options.delta).toStrictEqual({
      previousPlanVersion: 1,
      actionIds: additiveIds(previous, next),
    });
    expect(h.service.arming(SESSION_ID)?.activePlanVersion).toBe(2);
  });

  it('treats an empty delta as a cheap success that installs nothing', async () => {
    const previous = buildPlan();
    const next = buildPlan({ planVersion: 2, previousActions: previous.instrumentationTargets });
    const h = createHarness();
    const standing = sentinelRecord(
      h.home,
      SESSION_ID,
      'src/server/alpha-ledger.ts',
      ['a', 'b'],
      3,
    );
    const reverted: ModificationRecord = {
      ...sentinelRecord(h.home, SESSION_ID, 'src/server/zeta-ledger.ts', ['c', 'd'], 4),
      status: 'reverted',
    };
    h.journal.records.push(standing, reverted);

    expect(additiveIds(previous, next)).toEqual([]);

    const outcome = await h.service.install(
      installRequest(h, next, {
        previousPlanVersion: 1,
        previousActions: previous.instrumentationTargets,
      }),
    );

    expect(isOk(outcome)).toBe(true);
    expect(isOk(outcome) && outcome.value.activePlanVersion).toBe(2);
    expect(h.installer.calls).toHaveLength(0);
    expect(h.journal.writes).toEqual([]);
    for (const adapter of h.adapters) {
      expect(adapter.installCalls).toEqual([]);
    }
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'watchSession', 'resume']);
    expect(first(framesOf(allMessages(h), 'instrumentation.ready')).payload.applied).toStrictEqual([
      standing,
    ]);
  });

  it('leaves the previous plan version active when a delta fails, rolling nothing back itself', async () => {
    const { previous, next } = followUpPlans();
    const deltaError = new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      'The follow-up instrumentation could not be installed.',
      { hint: 'Review the sample file the follow-up names, then ask again.' },
    );
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          call.plan.planVersion === 1
            ? ok(cleanResult(call.context.debuggenHome, call.plan))
            : err(deltaError),
        ),
    });
    await h.service.install(installRequest(h, previous));

    const outcome = await h.service.install(
      installRequest(h, next, {
        previousPlanVersion: 1,
        previousActions: previous.instrumentationTargets,
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe(deltaError.code);
      expect(outcome.error.details?.['activePlanVersion']).toBe(1);
      expect(outcome.error.details?.['planVersion']).toBe(2);
      expect(outcome.error.hint).toBe(deltaError.hint);
    }
    expect(h.service.arming(SESSION_ID)?.activePlanVersion).toBe(1);
    expect(h.journal.writes).toEqual([]);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
  });

  it('refuses a previous plan version that is not the one immediately before', async () => {
    const { previous, next } = followUpPlans();
    const h = createHarness();

    const outcome = await h.service.install(
      installRequest(h, next, {
        previousPlanVersion: 3,
        previousActions: previous.instrumentationTargets,
      }),
    );

    expect(isErr(outcome)).toBe(true);
    expect(isErr(outcome) && DEBUGGEN_ERROR_CODES.includes(outcome.error.code)).toBe(true);
    expect(h.installer.calls).toHaveLength(0);
    expect(h.watcher.calls).toEqual([]);
  });

  it('defaults skipFeasibility to false and forwards an explicit value', async () => {
    const h = createHarness();

    await h.service.install(installRequest(h, buildPlan()));
    await h.service.install(installRequest(h, buildPlan(), { skipFeasibility: true }));

    expect(h.installer.calls.map((call) => call.options.skipFeasibility)).toEqual([false, true]);
    expect(h.installer.calls.map((call) => call.options.delta)).toEqual([undefined, undefined]);
    for (const call of h.installer.calls) {
      expect(call.options.adapters).toBe(h.registry);
    }
  });
});

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

/** Removes block and line comments, keeping `://` inside string literals intact. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/** The member names `InstrumentationContext` declares, read off its own source text. */
function declaredContextKeys(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../packages/instrumentation/src/adapter.ts', import.meta.url)),
    'utf8',
  );
  const start = source.indexOf('export interface InstrumentationContext {');
  const end = source.indexOf('\n}', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const body = stripComments(source.slice(start, end));
  return [...body.matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/gmu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('buildContext', () => {
  const observed: ObservedReadinessInputs = {
    serverAgent: { connected: true, projectRoot: PROJECT_ROOT, lastHeartbeatAt: NOW },
  };

  it('populates every field the upstream InstrumentationContext declares', () => {
    const h = createHarness();
    const plan = buildPlan();
    const controller = new AbortController();

    const context = unwrap(
      h.service.buildContext({
        sessionId: SESSION_ID,
        projectRoot: PROJECT_ROOT,
        // Optional upstream, and stamped only when given: given here so that
        // every declared field is present.
        canonicalProjectRoot: CANONICAL_PROJECT_ROOT,
        plan,
        code: h.code,
        readiness: observed,
        signal: controller.signal,
      }),
    );

    const declared = declaredContextKeys();
    expect(declared.length).toBeGreaterThan(10);
    expect(declared).toContain('journal');
    expect(declared).toContain('backups');
    expect(Object.keys(context).sort()).toEqual([...declared].sort());

    const values: Record<string, unknown> = { ...context };
    for (const key of declared) {
      expect(values[key], `context.${key} must be populated`).not.toBeUndefined();
    }
  });

  it('hands adapters the injected collaborators themselves, not wrappers', () => {
    const h = createHarness();
    const plan = buildPlan();
    const controller = new AbortController();

    const context = unwrap(
      h.service.buildContext({
        sessionId: SESSION_ID,
        projectRoot: PROJECT_ROOT,
        plan,
        code: h.code,
        readiness: observed,
        signal: controller.signal,
      }),
    );

    expect(context.journal).toBe(h.journal);
    expect(context.journal).toBe(h.deps.modifications);
    expect(context.backups.sessionId).toBe(SESSION_ID);
    expect(context.backups.sessionDirectory).toBe(`${h.home}/backups/${SESSION_ID}`);
    expect(context.debuggenHome).toBe(h.home);
    expect(context.projectRoot).toBe(PROJECT_ROOT);
    expect(context.planVersion).toBe(plan.planVersion);
    expect(context.sessionId).toBe(SESSION_ID);
    expect(LOGGER_BINDINGS.get(context.logger)).toEqual({
      subsystem: 'instrumentation',
      sessionId: SESSION_ID,
    });
    expect(context.now).toBe(clock);
    expect(context.signal).toBe(controller.signal);
    expect(context.readiness).toBe(observed);
    expect(context.graph).toBe(h.code.graph);
    expect(context.queries).toBe(h.code.queries);
    expect(context.routeMap).toBe(h.code.routeMap);
    expect(context.projectSummary).toBe(h.code.summary);
    expect(context.loaded).toBe(h.code.project);
    expect(Object.isFrozen(context)).toBe(true);

    // Opening the backup store touches nothing on disk.
    expect(readdirSync(h.home)).toEqual([]);
  });

  it.each([
    '/work/sample-project/',
    '\\work\\sample-project\\',
    '/work/sample-project/nested/..',
    '/work//sample-project',
  ])('normalises the project root %j to absolute POSIX', (projectRoot) => {
    const h = createHarness();

    const context = unwrap(
      h.service.buildContext({
        sessionId: SESSION_ID,
        projectRoot,
        plan: buildPlan(),
        code: h.code,
        readiness: {},
      }),
    );

    expect(context.projectRoot).toBe(PROJECT_ROOT);
  });

  it.each(['', '   ', 'work/sample-project', './sample-project', '../sample-project'])(
    'refuses the project root %j without constructing a context or installing',
    async (projectRoot) => {
      const h = createHarness();
      const plan = buildPlan();

      const built = h.service.buildContext({
        sessionId: SESSION_ID,
        projectRoot,
        plan,
        code: h.code,
        readiness: {},
      });

      expect(isErr(built)).toBe(true);
      expect(isErr(built) && DEBUGGEN_ERROR_CODES.includes(built.error.code)).toBe(true);

      const installed = await h.service.install(installRequest(h, plan, { projectRoot }));

      expect(isErr(installed)).toBe(true);
      expect(h.installer.calls).toHaveLength(0);
      expect(h.watcher.calls).toEqual([]);
      expect(h.broadcaster.frames).toEqual([]);
      expect(readdirSync(h.home)).toEqual([]);
    },
  );

  it('refuses an empty session id', () => {
    const h = createHarness();

    const built = h.service.buildContext({
      sessionId: '',
      projectRoot: PROJECT_ROOT,
      plan: buildPlan(),
      code: h.code,
      readiness: {},
    });

    expect(isErr(built) && DEBUGGEN_ERROR_CODES.includes(built.error.code)).toBe(true);
  });

  it('gives the installer the readiness collectObservedReadiness observes from the same doubles', async () => {
    const h = createHarness();
    const plan = buildPlan();

    await h.service.install(installRequest(h, plan));

    const observedNow = unwrap(
      await collectObservedReadiness(
        {
          serverAgents: h.serverAgents,
          agents: h.agents,
          config: { host: h.deps.config.host, port: h.deps.config.port },
          now: clock,
        },
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: BOUND_TAB, plan },
      ),
    );
    const context = first(h.installer.calls).context;

    expect(observedNow.browserAgent?.installedBeforeReact).toBe(true);
    expect(observedNow.serverAgent?.connected).toBe(true);
    expect(context.readiness).toStrictEqual(observedNow);
    expect(context.journal).toBe(h.journal);
    expect(context.backups.sessionDirectory).toBe(`${h.home}/backups/${SESSION_ID}`);
    expect(context.planVersion).toBe(plan.planVersion);
  });
});

// ---------------------------------------------------------------------------
// Watcher coordination, concurrency and lifecycle
// ---------------------------------------------------------------------------

describe('watcher coordination', () => {
  it('brackets a first install with watchSession and a later one with refresh', async () => {
    const h = createHarness();

    await h.service.install(installRequest(h, buildPlan()));
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'installer', 'watchSession', 'resume']);

    h.sequence.length = 0;
    await h.service.install(installRequest(h, buildPlan()));
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'installer', 'refresh', 'resume']);

    const started = h.watcher.calls.filter((call) => call.method === 'watchSession');
    expect(started).toHaveLength(1);
    expect(first(started).args).toEqual([{ sessionId: SESSION_ID, projectRoot: PROJECT_ROOT }]);
    for (const call of h.watcher.calls.filter((entry) => entry.method !== 'watchSession')) {
      expect(call.args).toEqual([SESSION_ID]);
    }
  });

  it('keeps the same bracket when the install fails', async () => {
    let failing = false;
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          failing
            ? err(nothingEnabledError())
            : ok(cleanResult(call.context.debuggenHome, call.plan)),
        ),
    });

    failing = true;
    await h.service.install(installRequest(h, buildPlan()));
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'installer', 'watchSession', 'resume']);

    failing = false;
    await h.service.install(installRequest(h, buildPlan()));

    failing = true;
    h.sequence.length = 0;
    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'installer', 'refresh', 'resume']);
  });

  it('installs nothing when the watcher cannot be paused', async () => {
    const h = createHarness();
    h.watcher.failSuspend = true;

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome) && outcome.error.code).toBe('INTERNAL');
    expect(h.installer.calls).toHaveLength(0);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
    expect(bracketOf(h.sequence).at(-1)).toBe('resume');
  });
});

describe('concurrency', () => {
  it('refuses an overlapping install for the same session instead of queueing it', async () => {
    const gate = deferred<Result<AggregateInstallResult>>();
    const h = createHarness({ script: () => gate.promise });
    const plan = buildPlan();

    const running = h.service.install(installRequest(h, plan));
    await vi.waitFor(() => {
      expect(h.installer.calls).toHaveLength(1);
    });
    expect(h.service.isInstalling(SESSION_ID)).toBe(true);

    const overlapping = await h.service.install(installRequest(h, plan));

    expect(isErr(overlapping) && overlapping.error.code).toBe('SESSION_INVALID_STATE');
    expect(h.installer.calls).toHaveLength(1);
    expect(h.watcher.calls.filter((call) => call.method === 'suspend')).toHaveLength(1);

    gate.resolve(ok(sentinelResult(h.home, plan)));
    const completed = await running;

    expect(isOk(completed)).toBe(true);
    expect(h.service.isInstalling(SESSION_ID)).toBe(false);
  });

  it('runs installs for different sessions independently', async () => {
    const gates = new Map<string, Deferred<Result<AggregateInstallResult>>>([
      [SESSION_ID, deferred()],
      [OTHER_SESSION_ID, deferred()],
    ]);
    const h = createHarness({
      script: (call) =>
        gates.get(call.plan.sessionId)?.promise ?? Promise.resolve(err(nothingEnabledError())),
    });
    const plan = buildPlan();
    const otherPlan = buildPlan({ sessionId: OTHER_SESSION_ID });

    const one = h.service.install(installRequest(h, plan));
    const two = h.service.install(installRequest(h, otherPlan));
    await vi.waitFor(() => {
      expect(h.installer.calls).toHaveLength(2);
    });
    expect(h.service.isInstalling(SESSION_ID)).toBe(true);
    expect(h.service.isInstalling(OTHER_SESSION_ID)).toBe(true);

    gates.get(OTHER_SESSION_ID)?.resolve(ok(cleanResult(h.home, otherPlan)));
    gates.get(SESSION_ID)?.resolve(ok(cleanResult(h.home, plan)));
    const [first1, second] = await Promise.all([one, two]);

    expect(isOk(first1)).toBe(true);
    expect(isOk(second)).toBe(true);
    expect(h.service.arming(SESSION_ID)?.activePlanVersion).toBe(1);
    expect(h.service.arming(OTHER_SESSION_ID)?.activePlanVersion).toBe(1);
  });
});

describe('cancellation', () => {
  it('forwards the request signal into the installer context', async () => {
    const h = createHarness();
    const controller = new AbortController();

    await h.service.install(installRequest(h, buildPlan(), { signal: controller.signal }));

    expect(first(h.installer.calls).context.signal).toBe(controller.signal);
  });

  it('handles an already-aborted signal as data, never as a throw', async () => {
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          call.context.signal?.aborted === true
            ? err(new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', 'The install was cancelled.'))
            : ok(cleanResult(call.context.debuggenHome, call.plan)),
        ),
    });
    const controller = new AbortController();
    controller.abort();

    const pending = h.service.install(
      installRequest(h, buildPlan(), { signal: controller.signal }),
    );

    await expect(pending).resolves.toBeDefined();
    const outcome = await pending;

    expect(isErr(outcome)).toBe(true);
    expect(first(h.installer.calls).context.signal).toBe(controller.signal);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
    expect(h.service.isInstalling(SESSION_ID)).toBe(false);
  });
});

describe('lifecycle', () => {
  it('stopSession stops watching and forgets the arming state without restoring anything', async () => {
    const h = createHarness();
    await h.service.install(installRequest(h, buildPlan()));
    h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    const framesBefore = h.broadcaster.frames.length;
    const agentFramesBefore = h.agentChannel.frames.length;
    const serverFramesBefore = h.serverChannel.frames.length;
    const readsBefore = h.journal.reads.length;

    await h.service.stopSession(SESSION_ID);

    expect(h.watcher.calls.filter((call) => call.method === 'stopSession')).toEqual([
      { method: 'stopSession', args: [SESSION_ID] },
    ]);
    expect(h.service.arming(SESSION_ID)).toBeUndefined();
    expect(h.journal.writes).toEqual([]);
    expect(h.journal.reads).toHaveLength(readsBefore);
    expect(h.broadcaster.frames).toHaveLength(framesBefore);
    expect(h.agentChannel.frames).toHaveLength(agentFramesBefore);
    expect(h.serverChannel.frames).toHaveLength(serverFramesBefore);
    expect(readdirSync(h.home)).toEqual([]);

    // The watch was released, so the next install establishes it afresh.
    h.sequence.length = 0;
    await h.service.install(installRequest(h, buildPlan()));
    expect(bracketOf(h.sequence)).toContain('watchSession');
  });

  it('dispose is idempotent and leaves no state behind', async () => {
    const h = createHarness();
    await h.service.install(installRequest(h, buildPlan()));
    h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.service.disarmCapture({ sessionId: SESSION_ID });
    const confirmed: string[] = [];
    h.service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent']);

    await h.service.dispose();
    await h.service.dispose();

    expect(h.watcher.calls.filter((call) => call.method === 'stopAll')).toHaveLength(1);
    expect(h.service.arming(SESSION_ID)).toBeUndefined();
    expect(h.service.isInstalling(SESSION_ID)).toBe(false);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    // Nothing is replayed, and no listener is told anything, after shutdown.
    h.agentChannel.refusing = undefined;
    const replay = h.service.producerConnected({ kind: 'devtools', sessionIds: [SESSION_ID] });
    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'not-applicable' });
    expect(confirmed).toEqual([]);

    const afterDispose = await h.service.install(installRequest(h, buildPlan()));
    expect(isErr(afterDispose)).toBe(true);
    expect(h.installer.calls).toHaveLength(1);
    expect(h.journal.writes).toEqual([]);
  });

  it('keeps two services in one process from interfering', async () => {
    const one = createHarness();
    const two = createHarness();

    await one.service.install(installRequest(one, buildPlan()));

    expect(one.service.arming(SESSION_ID)).toBeDefined();
    expect(two.service.arming(SESSION_ID)).toBeUndefined();

    await one.service.dispose();
    const outcome = await two.service.install(installRequest(two, buildPlan()));

    expect(isOk(outcome)).toBe(true);
    expect(two.service.arming(SESSION_ID)?.activePlanVersion).toBe(1);
    expect(two.watcher.calls.filter((call) => call.method === 'stopAll')).toHaveLength(0);
    expect(two.broadcaster.frames.length).toBeGreaterThan(0);
    expect(one.installer.calls).toHaveLength(1);
    expect(two.installer.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Producer delivery: receipts, pending disarms and replay
// ---------------------------------------------------------------------------

/** A plan of patch and server actions only, so no page hook is implied by a runtime action. */
const SERVER_ONLY_TARGETS: readonly TargetInput[] = [
  { file: 'src/server/alpha-ledger.ts', symbol: 'settleAlphaLedger', type: 'function-timing' },
  { file: 'src/routes/alpha/handler.ts', symbol: 'POST', type: 'server-span' },
];

/** An installer script whose page configuration is dormant and whose preload set is `serverSignals`. */
function serverOnlyScript(serverSignals: ServerAgentSignals): InstallScript {
  return (call) =>
    Promise.resolve(
      ok({
        ...cleanResult(call.context.debuggenHome, call.plan),
        agentHooks: { ...DORMANT_AGENT_HOOK_CONFIG },
        serverSignals: { ...serverSignals, functions: [...serverSignals.functions] },
      }),
    );
}

/** The server signal keys a signal set enables, in the upstream key order. */
function enabledServerKeys(signals: ServerAgentSignals): string[] {
  return SERVER_AGENT_SIGNAL_KEYS.filter((key) => {
    const value = signals[key];
    return value === true || (Array.isArray(value) && value.length > 0);
  });
}

/** A harness whose install has succeeded without any install-time gap, and whose capture is armed. */
async function armedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const h = createHarness({
    script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
    ...options,
  });
  await h.service.install(installRequest(h, buildPlan()));
  expect(isOk(h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID }))).toBe(true);
  return h;
}

/** The single-capture owner lookup every replay suite shares. */
function ownerLookup(owner: CaptureOwner | undefined): CaptureOwnerLookup {
  return {
    captureOwnerForProject: (projectRoot) => (projectRoot === PROJECT_ROOT ? owner : undefined),
  };
}

describe('arming is judged by the delivery receipt', () => {
  it.each(['TAB_NOT_BOUND', 'TRANSPORT_DISCONNECTED'] as const)(
    'refuses the arm when the bound tab answers %s, telling the preload nothing and arming nothing',
    async (refusal) => {
      const h = createHarness();
      await h.service.install(installRequest(h, buildPlan()));
      h.agentChannel.refusing = refusal;

      const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

      expect(isErr(armed)).toBe(true);
      if (isErr(armed)) {
        expect(armed.error.code).toBe(refusal);
        expect(armed.error.details).toMatchObject({
          sessionId: SESSION_ID,
          captureId: CAPTURE_ID,
          reason: refusal,
        });
        expect(armed.error.hint).toContain('Debug Generator panel');
      }
      expect(h.agentChannel.refused).toHaveLength(1);
      expect(h.serverChannel.frames).toHaveLength(0);
      expect(h.serverChannel.refused).toHaveLength(0);
      expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBeUndefined();

      // Nothing was armed, so the rollback's disarm owes neither producer anything.
      const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
      expect(isOk(disarmed) && disarmed.value.pending).toEqual([]);
      expect(isOk(disarmed) && disarmed.value.agentDisarmed).toBe(false);
    },
  );

  it('proceeds with the page when the preload is unreachable, reporting each server gap once per capture', async () => {
    const h = createHarness({
      script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
    });
    await h.service.install(installRequest(h, buildPlan()));
    expect(h.progress.emitted).toEqual([]);
    h.serverChannel.refusing = true;

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed)).toBe(true);
    const keys = enabledServerKeys(SENTINEL_SERVER_SIGNALS);
    expect(keys.length).toBeGreaterThan(1);
    if (isOk(armed)) {
      expect(armed.value.pageAgent).toBe('delivered');
      expect(armed.value.serverAgent).toBe('unreachable');
      expect(armed.value.unavailable?.map((entry) => entry.signal)).toEqual(keys);
      for (const entry of armed.value.unavailable ?? []) {
        expect(entry.reason).toContain('preload is not connected');
        expect(entry.hint).toContain('Launch the dev server from Debug Generator');
      }
    }
    expect(h.agentChannel.frames).toHaveLength(1);
    expect(h.serverChannel.refused).toHaveLength(1);
    expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBe(CAPTURE_ID);

    // One row per distinct label (two keys share "Server spans"), each a
    // running degradation row whose continuing list omits what is missing.
    const labels = [...new Set(keys.map(labelOf))];
    const rows = h.progress.emitted;
    expect(rows.map((row) => row.message.split(':')[0])).toEqual(
      labels.map((label) => `Could not enable ${label}`),
    );
    for (const row of rows) {
      expect(row.stage).toBe('instrument');
      expect(row.status).toBe('running');
      expect(row.detail).toContain('Launch the dev server from Debug Generator');
      const continuing = row.message.split('Continuing with: ')[1] ?? '';
      expect(continuing).toContain(labelOf('interactions'));
      for (const label of labels) {
        expect(continuing).not.toContain(label);
      }
    }

    // A re-bind re-arms the same capture: no second set of rows.
    const rearmed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    expect(isOk(rearmed) && rearmed.value.unavailable?.length).toBe(keys.length);
    expect(h.progress.emitted).toHaveLength(rows.length);
    expect(progressCalls(h, 'stageFailed')).toHaveLength(0);
  });

  it('keeps a signal the page still collects in the continuing list when only its server share is missing', async () => {
    const h = createHarness({
      script: (call) =>
        Promise.resolve(
          ok({
            ...cleanResult(call.context.debuggenHome, call.plan),
            serverSignals: { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [], fetch: true },
          }),
        ),
    });
    await h.service.install(installRequest(h, buildPlan()));
    h.serverChannel.refusing = true;

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed) && armed.value.unavailable?.map((entry) => entry.signal)).toEqual(['fetch']);
    const row = first(h.progress.emitted);
    expect(row.message.startsWith(`Could not enable ${labelOf('fetch')}: `)).toBe(true);
    expect(row.message.split('Continuing with: ')[1]).toContain(labelOf('fetch'));
  });

  it('refuses the arm when only server signals are planned and no preload is connected', async () => {
    const h = createHarness({ script: serverOnlyScript(SENTINEL_SERVER_SIGNALS) });
    await h.service.install(installRequest(h, buildPlan({ targets: SERVER_ONLY_TARGETS })));
    h.serverChannel.refusing = true;

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isErr(armed) && armed.error.code).toBe('SERVER_AGENT_NOT_READY');
    expect(isErr(armed) && armed.error.details?.['reason']).toBe('SERVER_AGENT_NOT_READY');
    expect(h.agentChannel.frames).toHaveLength(0);
    expect(h.agentChannel.refused).toHaveLength(0);
    expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBeUndefined();
    expect(h.progress.emitted).toEqual([]);
  });

  it('arms a server-only plan through the preload alone, the page left untouched', async () => {
    const h = createHarness({ script: serverOnlyScript(SENTINEL_SERVER_SIGNALS) });
    await h.service.install(installRequest(h, buildPlan({ targets: SERVER_ONLY_TARGETS })));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(armed) && armed.value.pageAgent).toBe('not-needed');
    expect(isOk(armed) && armed.value.serverAgent).toBe('delivered');
    expect(h.agentChannel.frames).toHaveLength(0);
    expect(h.serverChannel.frames).toHaveLength(1);
  });

  it('refuses a capture whose plan enables nothing in either producer, sending nothing', async () => {
    const h = createHarness({
      script: serverOnlyScript({ ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] }),
    });
    await h.service.install(installRequest(h, buildPlan({ targets: SERVER_ONLY_TARGETS })));

    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isErr(armed) && armed.error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(framesOf(allMessages(h), 'agent.config')).toHaveLength(0);
    expect(framesOf(allMessages(h), 'server-agent.config')).toHaveLength(0);
    expect(h.service.arming(SESSION_ID)?.armedCaptureId).toBeUndefined();
  });
});

describe('disarming is truthful and remembers what it owes', () => {
  it('owes the page its dormant frame when no bound-tab connection took it', async () => {
    const h = await armedHarness();
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';

    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });

    expect(isOk(disarmed)).toBe(true);
    if (isOk(disarmed)) {
      expect(disarmed.value.agentDisarmed).toBe(false);
      expect(disarmed.value.pageAgent).toBe('unreachable');
      expect(disarmed.value.serverAgent).toBe('delivered');
      expect(disarmed.value.pending).toEqual(['page-agent']);
    }
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent']);
    const warning = h.log.find(
      (entry) => entry.level === 'warn' && entry.message.includes('replayed when they reconnect'),
    );
    expect(warning?.fields?.['pending']).toEqual(['page-agent']);
  });

  it('owes the preload its capture-less frame when an armed preload is unreachable', async () => {
    const h = await armedHarness();
    h.serverChannel.refusing = true;

    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });

    expect(isOk(disarmed) && disarmed.value.serverAgent).toBe('unreachable');
    expect(isOk(disarmed) && disarmed.value.agentDisarmed).toBe(true);
    expect(isOk(disarmed) && disarmed.value.pending).toEqual(['server-agent']);
  });

  it('lists both producers, page first, when neither took its disarm', async () => {
    const h = await armedHarness();
    h.agentChannel.refusing = 'TAB_NOT_BOUND';
    h.serverChannel.refusing = true;

    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });

    expect(isOk(disarmed) && disarmed.value.pending).toEqual(['page-agent', 'server-agent']);
  });

  it('owes nothing for a session it never armed, even when neither producer is reachable', async () => {
    const h = createHarness();
    await h.service.install(installRequest(h, buildPlan()));
    h.agentChannel.refusing = 'TAB_NOT_BOUND';
    h.serverChannel.refusing = true;

    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });

    expect(isOk(disarmed)).toBe(true);
    if (isOk(disarmed)) {
      expect(disarmed.value.pageAgent).toBe('unreachable');
      expect(disarmed.value.serverAgent).toBe('unreachable');
      expect(disarmed.value.pending).toEqual([]);
    }
    const unknown = h.service.disarmCapture({
      sessionId: OTHER_SESSION_ID,
      projectRoot: PROJECT_ROOT,
    });
    expect(isOk(unknown) && unknown.value.pageAgent).toBe('not-armed');
    expect(isOk(unknown) && unknown.value.pending).toEqual([]);
  });

  it('keeps what it owes across stopSession, which cleanup calls right after disarming', async () => {
    const h = await armedHarness();
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.serverChannel.refusing = true;
    h.service.disarmCapture({ sessionId: SESSION_ID });

    await h.service.stopSession(SESSION_ID);

    expect(h.service.arming(SESSION_ID)).toBeUndefined();
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent', 'server-agent']);

    // A later disarm without a project root still knows which project it serves.
    h.serverChannel.refusing = false;
    const again = h.service.disarmCapture({ sessionId: SESSION_ID });
    expect(isOk(again) && again.value.serverAgent).toBe('delivered');
    expect(isOk(again) && again.value.pending).toEqual(['page-agent']);
  });

  it('settles an owed page disarm when a later arm of the same session supersedes it', async () => {
    const h = await armedHarness();
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.service.disarmCapture({ sessionId: SESSION_ID });
    const confirmed: string[] = [];
    h.service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));
    h.agentChannel.refusing = undefined;

    const rearmed = h.service.armCapture({
      sessionId: SESSION_ID,
      captureId: 'cap_servicesuite0003',
    });

    expect(isOk(rearmed)).toBe(true);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(confirmed).toEqual([SESSION_ID]);
  });

  it('settles another session’s owed preload disarm once the preload follows a new capture', async () => {
    const h = await armedHarness();
    h.serverChannel.refusing = true;
    h.service.disarmCapture({ sessionId: SESSION_ID });
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['server-agent']);
    await h.service.install(installRequest(h, buildPlan({ sessionId: OTHER_SESSION_ID })));
    h.serverChannel.refusing = false;

    const armed = h.service.armCapture({
      sessionId: OTHER_SESSION_ID,
      captureId: 'cap_servicesuite0002',
    });

    expect(isOk(armed) && armed.value.serverAgent).toBe('delivered');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
  });
});

describe('producer replay', () => {
  it('disables a reconnecting preload when no capture is open, settling what the project owed once', async () => {
    const h = await armedHarness({ captures: ownerLookup(undefined) });
    h.serverChannel.refusing = true;
    h.service.disarmCapture({ sessionId: SESSION_ID });
    const confirmed: string[] = [];
    h.service.onDormancyConfirmed(() => {
      throw new Error('a listener that breaks');
    });
    h.service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));
    h.serverChannel.refusing = false;
    const serverFramesBefore = h.serverChannel.frames.length;

    const replay = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });

    expect(replay).toEqual({ rearmed: [], disarmed: [SESSION_ID], serverAgent: 'delivered' });
    const sent = h.serverChannel.frames.slice(serverFramesBefore);
    expect(sent.map((frame) => frame.message.payload)).toEqual([
      { signals: DISABLED_SERVER_AGENT_SIGNALS },
    ]);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(confirmed).toEqual([SESSION_ID]);
    expect(
      h.log.some(
        (entry) => entry.level === 'error' && entry.message === 'A dormancy listener threw',
      ),
    ).toBe(true);

    // A second reconnect disables it again but has nothing left to settle.
    const again = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });
    expect(again.disarmed).toEqual([]);
    expect(confirmed).toEqual([SESSION_ID]);
  });

  it('re-arms a reconnecting preload for the open capture it could not reach at arm time', async () => {
    const h = createHarness({
      captures: ownerLookup({ sessionId: SESSION_ID, captureId: CAPTURE_ID }),
    });
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);
    await h.service.install(installRequest(h, plan));
    h.serverChannel.refusing = true;
    expect(isOk(h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID }))).toBe(true);
    h.serverChannel.refusing = false;

    const replay = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });

    expect(replay).toEqual({ rearmed: [SESSION_ID], disarmed: [], serverAgent: 'delivered' });
    expect(first(h.serverChannel.frames).message.payload).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      signals: expected.serverSignals,
    });

    // The preload now holds the capture, so an unreachable disarm is owed.
    h.serverChannel.refusing = true;
    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });
    expect(isOk(disarmed) && disarmed.value.pending).toEqual(['server-agent']);
  });

  it('sends a preload nothing while a capture is open that this service holds no arming for', () => {
    const h = createHarness({
      captures: ownerLookup({ sessionId: OTHER_SESSION_ID, captureId: 'cap_servicesuite0002' }),
    });

    const replay = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'not-needed' });
    expect(h.serverChannel.frames).toHaveLength(0);
    expect(h.serverChannel.refused).toHaveLength(0);
    expect(h.log.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('re-arms a reconnecting DevTools connection’s open capture and delivers another session’s owed dormant frame', async () => {
    const h = createHarness({
      script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
    });
    await h.service.install(installRequest(h, buildPlan()));
    await h.service.install(installRequest(h, buildPlan({ sessionId: OTHER_SESSION_ID })));
    const otherCapture = 'cap_servicesuite0002';
    expect(
      isOk(h.service.armCapture({ sessionId: OTHER_SESSION_ID, captureId: otherCapture })),
    ).toBe(true);
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.service.disarmCapture({ sessionId: OTHER_SESSION_ID });
    expect(h.service.pendingDisarms(OTHER_SESSION_ID)).toEqual(['page-agent']);
    h.agentChannel.refusing = undefined;
    const armed = h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID });
    expect(isOk(armed)).toBe(true);
    const framesBefore = h.agentChannel.frames.length;

    const replay = h.service.producerConnected({
      kind: 'devtools',
      sessionIds: [SESSION_ID, OTHER_SESSION_ID, SESSION_ID],
    });

    expect(replay).toEqual({
      rearmed: [SESSION_ID],
      disarmed: [OTHER_SESSION_ID],
      serverAgent: 'not-applicable',
    });
    const sent = h.agentChannel.frames.slice(framesBefore).map((frame) => frame.message.payload);
    expect(sent).toStrictEqual([
      {
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        hooks: isOk(armed) ? armed.value.agentHooks : DORMANT_AGENT_HOOK_CONFIG,
      },
      { sessionId: OTHER_SESSION_ID, captureId: otherCapture, hooks: DORMANT_AGENT_HOOK_CONFIG },
    ]);
    expect(h.service.pendingDisarms(OTHER_SESSION_ID)).toEqual([]);
  });

  it('replays nothing to a connection kind that is not a producer', () => {
    const h = createHarness();

    expect(h.service.producerConnected({ kind: 'vscode', projectRoot: PROJECT_ROOT })).toEqual({
      rearmed: [],
      disarmed: [],
      serverAgent: 'not-applicable',
    });
    expect(allMessages(h)).toEqual([]);
  });

  it('sends nothing to a preload whose credential it issued and which it neither armed nor owes', () => {
    const h = createHarness({ captures: ownerLookup(undefined) });

    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'not-needed' });
    expect(allMessages(h)).toEqual([]);
  });

  it('disables a preload whose credential predates the service, which may hold an earlier arming', () => {
    const h = createHarness({ captures: ownerLookup(undefined) });

    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW - 1,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'delivered' });
    expect(h.serverChannel.frames.map((frame) => frame.message.payload)).toEqual([
      { signals: DISABLED_SERVER_AGENT_SIGNALS },
    ]);
  });

  it('disables a preload of its own credential that it still owes a disarm', async () => {
    const h = await armedHarness({ captures: ownerLookup(undefined) });
    h.serverChannel.refusing = true;
    h.service.disarmCapture({ sessionId: SESSION_ID });
    h.serverChannel.refusing = false;
    const serverFramesBefore = h.serverChannel.frames.length;

    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [SESSION_ID], serverAgent: 'delivered' });
    expect(
      h.serverChannel.frames.slice(serverFramesBefore).map((frame) => frame.message.payload),
    ).toEqual([{ signals: DISABLED_SERVER_AGENT_SIGNALS }]);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
  });
});

describe('reconcileBoundSession', () => {
  it('leaves an open capture to the binding route, sending nothing', () => {
    const h = createHarness();

    const outcome = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      activeCaptureId: CAPTURE_ID,
      lastCaptureId: CAPTURE_ID,
    });

    expect(isOk(outcome) && outcome.value).toBe('capture-active');
    expect(allMessages(h)).toEqual([]);
  });

  it('has nothing to disarm for a session that never captured', () => {
    const h = createHarness();

    const outcome = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
    });

    expect(isOk(outcome) && outcome.value).toBe('nothing-armed');
    expect(allMessages(h)).toEqual([]);
  });

  it('returns a page agent that outlived a restart to dormant, then knows it is dormant', () => {
    // A fresh service: the only knowledge is the store's last capture id.
    const h = createHarness();

    const initial = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
    });

    expect(isOk(initial) && initial.value).toBe('dormant-delivered');
    expect(h.agentChannel.frames.map((frame) => frame.message.payload)).toStrictEqual([
      { sessionId: SESSION_ID, captureId: CAPTURE_ID, hooks: DORMANT_AGENT_HOOK_CONFIG },
    ]);

    const second = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
    });

    expect(isOk(second) && second.value).toBe('already-dormant');
    expect(h.agentChannel.frames).toHaveLength(1);
  });

  it('sends a capture opened by an earlier process dormant, one it opened itself only when armed there', async () => {
    const inherited = createHarness();

    const earlier = inherited.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
      lastCaptureStartedAt: NOW - 1,
    });

    expect(isOk(earlier) && earlier.value).toBe('dormant-delivered');

    // Opened by this service and never armed in the page: nothing to disarm.
    const neverArmed = createHarness();
    const opened = neverArmed.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
      lastCaptureStartedAt: NOW,
    });

    expect(isOk(opened) && opened.value).toBe('nothing-armed');
    expect(allMessages(neverArmed)).toEqual([]);

    // Opened, armed and disarmed by this service: it knows the page is dormant.
    const disarmed = await armedHarness();
    disarmed.service.disarmCapture({ sessionId: SESSION_ID });
    const framesBefore = disarmed.agentChannel.frames.length;
    const known = disarmed.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
      lastCaptureStartedAt: NOW,
    });

    expect(isOk(known) && known.value).toBe('already-dormant');
    expect(disarmed.agentChannel.frames).toHaveLength(framesBefore);
  });

  it('sends the capture it still has armed in the page dormant when the tab rebinds after it closed', async () => {
    const h = await armedHarness();
    const framesBefore = h.agentChannel.frames.length;

    // The capture window closed without a disarm; the page still holds it.
    const outcome = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
      lastCaptureStartedAt: NOW,
    });

    expect(isOk(outcome) && outcome.value).toBe('dormant-delivered');
    expect(h.agentChannel.frames.slice(framesBefore).map((frame) => frame.message.payload)).toEqual(
      [{ sessionId: SESSION_ID, captureId: CAPTURE_ID, hooks: DORMANT_AGENT_HOOK_CONFIG }],
    );
  });

  it('keeps an owed disarm while the tab is unreachable and settles it once the dormant frame lands', async () => {
    const h = await armedHarness();
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.service.disarmCapture({ sessionId: SESSION_ID });
    const confirmed: string[] = [];
    h.service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));

    const unreachable = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: 'cap_servicesuite0009',
    });

    expect(isOk(unreachable) && unreachable.value).toBe('dormant-unreachable');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent']);

    h.agentChannel.refusing = undefined;
    const delivered = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: 'cap_servicesuite0009',
    });

    expect(isOk(delivered) && delivered.value).toBe('dormant-delivered');
    // The owed disarm names the capture that was armed, not the caller's guess.
    expect(h.agentChannel.frames.at(-1)?.message.payload).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      hooks: DORMANT_AGENT_HOOK_CONFIG,
    });
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(confirmed).toEqual([SESSION_ID]);
  });

  it('refuses an empty session id and a relative project root', () => {
    const h = createHarness();

    expect(
      isErr(h.service.reconcileBoundSession({ sessionId: ' ', projectRoot: PROJECT_ROOT })),
    ).toBe(true);
    expect(
      isErr(
        h.service.reconcileBoundSession({ sessionId: SESSION_ID, projectRoot: 'relative/root' }),
      ),
    ).toBe(true);
    expect(allMessages(h)).toEqual([]);
  });
});

describe('a project served by several preloads', () => {
  it('disables a preload that missed the capture-less configuration another preload of the project took', async () => {
    const h = await armedHarness({ captures: ownerLookup(undefined) });
    const disarmed = h.service.disarmCapture({ sessionId: SESSION_ID });
    expect(isOk(disarmed) && disarmed.value.pending).toEqual([]);
    const serverFramesBefore = h.serverChannel.frames.length;

    // A second preload of the project, holding a credential that existed when
    // the project was armed, was offline when the first one took the disarm.
    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'delivered' });
    expect(
      h.serverChannel.frames.slice(serverFramesBefore).map((frame) => frame.message.payload),
    ).toEqual([{ signals: DISABLED_SERVER_AGENT_SIGNALS }]);
  });

  it('sends nothing to a preload whose credential was issued after the project was last armed', async () => {
    const h = await armedHarness({ captures: ownerLookup(undefined) });
    h.service.disarmCapture({ sessionId: SESSION_ID });
    const serverFramesBefore = h.serverChannel.frames.length;

    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW + 1,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'not-needed' });
    expect(h.serverChannel.frames.slice(serverFramesBefore)).toEqual([]);
  });

  it('does not count an armed configuration no preload took as an arming', async () => {
    const h = createHarness({
      script: (call) => Promise.resolve(ok(cleanResult(call.context.debuggenHome, call.plan))),
      captures: ownerLookup(undefined),
    });
    await h.service.install(installRequest(h, buildPlan()));
    h.serverChannel.refusing = true;
    expect(isOk(h.service.armCapture({ sessionId: SESSION_ID, captureId: CAPTURE_ID }))).toBe(true);
    h.service.disarmCapture({ sessionId: SESSION_ID });
    h.serverChannel.refusing = false;
    const serverFramesBefore = h.serverChannel.frames.length;

    const replay = h.service.producerConnected({
      kind: 'server-agent',
      projectRoot: PROJECT_ROOT,
      credentialIssuedAt: NOW,
    });

    expect(replay).toEqual({ rearmed: [], disarmed: [], serverAgent: 'not-needed' });
    expect(h.serverChannel.frames.slice(serverFramesBefore)).toEqual([]);
  });
});

describe('releaseInterruptedCapture', () => {
  it('owes both producers of a capture a restart ended their dormant frame, settling each as it reconnects', () => {
    const h = createHarness();
    h.agentChannel.refusing = 'TAB_NOT_BOUND';
    h.serverChannel.refusing = true;
    const confirmed: string[] = [];
    h.service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));

    const released = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
      plan: buildPlan(),
    });

    expect(isOk(released) && released.value).toMatchObject({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      agentDisarmed: false,
      pageAgent: 'unreachable',
      serverAgent: 'unreachable',
      pending: ['page-agent', 'server-agent'],
    });
    // A released capture is not resumed: nothing is armed for it any more.
    expect(h.service.arming(SESSION_ID)).toBeUndefined();

    h.serverChannel.refusing = false;
    const replay = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });

    expect(replay).toEqual({ rearmed: [], disarmed: [SESSION_ID], serverAgent: 'delivered' });
    expect(h.serverChannel.frames.at(-1)?.message.payload).not.toHaveProperty('captureId');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent']);
    expect(confirmed).toEqual([]);

    h.agentChannel.refusing = undefined;
    const rebound = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
    });

    expect(isOk(rebound) && rebound.value).toBe('dormant-delivered');
    expect(h.agentChannel.frames.at(-1)?.message.payload).toStrictEqual({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      hooks: DORMANT_AGENT_HOOK_CONFIG,
    });
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(confirmed).toEqual([SESSION_ID]);
  });

  it('owes only the producers the capture’s plan armed', () => {
    const h = createHarness();
    h.agentChannel.refusing = 'TRANSPORT_DISCONNECTED';
    h.serverChannel.refusing = true;

    const released = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
      plan: buildPlan({
        targets: [
          { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
        ],
      }),
    });

    expect(isOk(released) && released.value.pending).toEqual(['page-agent']);
  });

  it('treats both producers as holding a capture whose plan is unknown', () => {
    const h = createHarness();
    h.agentChannel.refusing = 'TAB_NOT_BOUND';
    h.serverChannel.refusing = true;

    const released = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
    });

    expect(isOk(released) && released.value.pending).toEqual(['page-agent', 'server-agent']);
  });

  it('owes nothing when both producers take their dormant frame at once', () => {
    const h = createHarness();

    const released = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
      plan: buildPlan(),
    });

    expect(isOk(released) && released.value).toMatchObject({
      agentDisarmed: true,
      pageAgent: 'delivered',
      serverAgent: 'delivered',
      pending: [],
    });
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
  });

  it('refuses a blank capture id, a relative project root and another session’s plan, recording nothing', () => {
    const h = createHarness();
    h.agentChannel.refusing = 'TAB_NOT_BOUND';
    h.serverChannel.refusing = true;

    const blank = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: ' ',
      projectRoot: PROJECT_ROOT,
    });
    const relative = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: 'relative/root',
    });
    const foreign = h.service.releaseInterruptedCapture({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      projectRoot: PROJECT_ROOT,
      plan: buildPlan({ sessionId: OTHER_SESSION_ID }),
    });

    expect(isErr(blank)).toBe(true);
    expect(isErr(relative)).toBe(true);
    expect(isErr(foreign)).toBe(true);
    expect(allMessages(h)).toEqual([]);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The state root stays outside the project, re-checked at the patch sink
// (CWE-200): the routes check before a session exists, but the pipeline
// installs later, so every install checks again before it writes.
// ---------------------------------------------------------------------------

describe('the state root stays outside the project at the patch sink', () => {
  /** A fresh, symlink-free directory this test removes afterwards. */
  function scratchDirectory(): string {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-state-apart-')));
    homes.push(directory);
    return directory;
  }

  /** A second service over `h`'s doubles, with `overrides` applied to its deps. */
  function serviceOver(
    h: Harness,
    overrides: Partial<InstrumentationServiceDeps>,
  ): InstrumentationDriver {
    return createInstrumentationService({ ...h.deps, ...overrides });
  }

  /**
   * Asserts an install was refused by the separation check before anything
   * was written: `FS_UNSAFE_PATH` with the overlap reason and `relation`, no
   * installer call, no journal write, one `instrumentation.failed` frame that
   * carries the check's own constant hint, and no `instrumentation.ready`.
   */
  function expectRefusedBeforeWriting(
    h: Harness,
    outcome: Awaited<ReturnType<InstrumentationDriver['install']>>,
    relation: string,
  ): void {
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('FS_UNSAFE_PATH');
      expect(outcome.error.message).toBe(STATE_HOME_OVERLAP_MESSAGE);
      expect(outcome.error.details).toMatchObject({ reason: STATE_HOME_OVERLAP_REASON, relation });
    }
    expect(h.installer.calls).toHaveLength(0);
    expect(h.journal.writes).toEqual([]);
    const failed = framesOf(allMessages(h), 'instrumentation.failed');
    expect(failed).toHaveLength(1);
    expect(first(failed).payload.error.code).toBe('FS_UNSAFE_PATH');
    expect(first(failed).payload.error.hint).toBe(STATE_HOME_OVERLAP_HINT);
    const [failedFrame] = h.broadcaster.frames.filter(
      (frame) => frame.message.type === 'instrumentation.failed',
    );
    expect(failedFrame?.kinds).toEqual(UI_KINDS);
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toEqual([]);
    expect(progressCalls(h, 'stageFailed')).toHaveLength(1);
  }

  it('refuses a project root that is an ancestor of the state root, writing nothing into it', async () => {
    const h = createHarness();
    // The configured state root lies inside the harness directory, which is
    // the project; it does not exist yet, as on a first run.
    const service = serviceOver(h, { config: serviceConfig(join(h.home, 'state')) });

    const outcome = await service.install(installRequest(h, buildPlan(), { projectRoot: h.home }));

    expectRefusedBeforeWriting(h, outcome, 'home-inside-project');
    expect(readdirSync(h.home)).toEqual([]);
  });

  it('refuses a project root reached through a symbolic link to an ancestor of the state root', async () => {
    const h = createHarness();
    const service = serviceOver(h, { config: serviceConfig(join(h.home, 'state')) });
    const link = join(scratchDirectory(), 'project');
    symlinkSync(h.home, link);

    const outcome = await service.install(installRequest(h, buildPlan(), { projectRoot: link }));

    expectRefusedBeforeWriting(h, outcome, 'home-inside-project');
    expect(readdirSync(h.home)).toEqual([]);
  });

  it('checks every install, so a folder replaced by a link into the state root is refused the next time', async () => {
    const h = createHarness();
    const stateHome = join(h.home, 'state');
    const inside = join(stateHome, 'projects', 'shop');
    mkdirSync(inside, { recursive: true });
    const service = serviceOver(h, { config: serviceConfig(stateHome) });
    const shop = join(scratchDirectory(), 'shop');
    mkdirSync(shop);

    const first = await service.install(installRequest(h, buildPlan(), { projectRoot: shop }));

    expect(isOk(first)).toBe(true);
    expect(h.installer.calls).toHaveLength(1);

    rmSync(shop, { recursive: true });
    symlinkSync(inside, shop);
    const second = await service.install(
      installRequest(h, buildPlan({ sessionId: OTHER_SESSION_ID }), { projectRoot: shop }),
    );

    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.code).toBe('FS_UNSAFE_PATH');
      expect(second.error.details).toMatchObject({
        reason: STATE_HOME_OVERLAP_REASON,
        relation: 'project-inside-home',
      });
    }
    expect(h.installer.calls).toHaveLength(1);
  });

  it('compares with the canonical state root it is given rather than the configured one', async () => {
    const h = createHarness();
    const project = scratchDirectory();
    const service = serviceOver(h, { canonicalStateHome: join(project, '.debuggen') });

    const refused = await service.install(installRequest(h, buildPlan(), { projectRoot: project }));

    expectRefusedBeforeWriting(h, refused, 'home-inside-project');

    // A project apart from the given root installs as usual.
    const installed = await service.install(
      installRequest(h, buildPlan({ sessionId: OTHER_SESSION_ID })),
    );

    expect(isOk(installed)).toBe(true);
    expect(h.installer.calls).toHaveLength(1);
  });

  it('refuses every install when the canonical state root it is given is not absolute', async () => {
    const h = createHarness();
    const service = serviceOver(h, { canonicalStateHome: 'relative/state' });

    const outcome = await service.install(installRequest(h, buildPlan()));

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('INTERNAL');
      expect(outcome.error.details).toMatchObject({ field: 'canonicalStateHome' });
    }
    expect(h.installer.calls).toHaveLength(0);
    expect(framesOf(allMessages(h), 'instrumentation.failed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The project root's identity is re-proved at the patch sink (CWE-367): an
// install whose request carries a confirmation re-proves the root before its
// first act on it and again immediately before the installer, and installs
// inside the confirmed canonical root.
// ---------------------------------------------------------------------------

describe('the project root is re-proved at the patch sink', () => {
  /** The log message of a refused confirmation. */
  const UNCONFIRMED_LOG = 'The project root was not confirmed; no instrumentation was installed';

  /** The access boundary's refusal of a root that now resolves elsewhere: no path in it. */
  function movedRefusal(): DebuggenError {
    return new DebuggenError(
      'PATH_OUTSIDE_PROJECT',
      'The project root no longer resolves to the directory it was admitted as.',
      {
        hint: 'Start a new session from the folder in VS Code.',
        details: { reason: 'project-out-of-scope' },
      },
    );
  }

  /** A confirmation that answers `canonicalRoot` and marks each call in `sequence`. */
  function confirming(
    sequence: string[],
    canonicalRoot: string = CANONICAL_PROJECT_ROOT,
  ): NonNullable<InstallRequest['confirmProjectRoot']> {
    return () => {
      sequence.push('confirm');
      return ok({ canonicalRoot });
    };
  }

  /**
   * The harness's preload presence, marking in `sequence` every time the
   * readiness facts ask for it — the first read `collectReadinessEvidence`
   * makes of the project's producers.
   */
  function markingServerAgents(sequence: string[]): ServerAgentReadinessSource {
    const present = createServerAgents();
    return {
      hasServerAgentForProject: (projectRoot) => {
        sequence.push('readiness');
        return present.hasServerAgentForProject(projectRoot);
      },
    };
  }

  /** A second service over `h`'s doubles, with `overrides` applied to its deps. */
  function serviceOver(
    h: Harness,
    overrides: Partial<InstrumentationServiceDeps>,
  ): InstrumentationDriver {
    return createInstrumentationService({ ...h.deps, ...overrides });
  }

  /** The `warn` records of refused confirmations. */
  function unconfirmedRecords(h: Harness): LogEntry[] {
    return h.log.filter((entry) => entry.level === 'warn' && entry.message === UNCONFIRMED_LOG);
  }

  it('installs inside the confirmed canonical root, keeping the spelled root everywhere else', async () => {
    const h = createHarness();

    const outcome = await h.service.install(
      installRequest(h, buildPlan(), { confirmProjectRoot: confirming(h.sequence) }),
    );

    expect(isOk(outcome)).toBe(true);
    const { context } = first(h.installer.calls);
    expect(context.canonicalProjectRoot).toBe(CANONICAL_PROJECT_ROOT);
    expect(context.projectRoot).toBe(PROJECT_ROOT);
    expect(h.sequence.filter((entry) => entry === 'confirm')).toHaveLength(2);
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(1);
    expect(unconfirmedRecords(h)).toEqual([]);
  });

  it('judges the state-root separation on the confirmed canonical root, not the spelled one', async () => {
    const h = createHarness();
    // The spelled root lies apart from the state root; the directory it was
    // confirmed to resolve to is the state root's parent.
    const service = serviceOver(h, { config: serviceConfig(join(h.home, 'state')) });

    const outcome = await service.install(
      installRequest(h, buildPlan(), { confirmProjectRoot: confirming(h.sequence, h.home) }),
    );

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('FS_UNSAFE_PATH');
      expect(outcome.error.details).toMatchObject({
        reason: STATE_HOME_OVERLAP_REASON,
        relation: 'home-inside-project',
      });
    }
    expect(h.sequence.filter((entry) => entry === 'confirm')).toHaveLength(1);
    expect(h.installer.calls).toHaveLength(0);
    expect(h.journal.writes).toEqual([]);
    expect(readdirSync(h.home)).toEqual([]);
  });

  it('refuses the install when the root moved while the readiness facts were collected', async () => {
    const h = createHarness();
    const moved = movedRefusal();
    let calls = 0;
    const confirmProjectRoot = (): Result<{ readonly canonicalRoot: string }> => {
      calls += 1;
      return calls === 1 ? ok({ canonicalRoot: CANONICAL_PROJECT_ROOT }) : err(moved);
    };

    const outcome = await h.service.install(installRequest(h, buildPlan(), { confirmProjectRoot }));

    expect(calls).toBe(2);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(outcome.error.message).toBe(moved.message);
      expect(outcome.error.details).toMatchObject({ reason: 'project-out-of-scope' });
      expect(outcome.error.cause).toBe(moved);
    }
    expect(h.installer.calls).toHaveLength(0);
    expect(h.journal.writes).toEqual([]);
    const failed = framesOf(allMessages(h), 'instrumentation.failed');
    expect(failed).toHaveLength(1);
    expect(first(failed).payload.error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(framesOf(allMessages(h), 'instrumentation.ready')).toEqual([]);
    expect(progressCalls(h, 'stageFailed')).toHaveLength(1);
    // The watcher bracket still closes, and the refusal is logged by code and reason only.
    expect(bracketOf(h.sequence)).toEqual(['suspend', 'watchSession', 'resume']);
    expect(unconfirmedRecords(h).map((entry) => entry.fields)).toEqual([
      { stage: 'before-install', code: 'PATH_OUTSIDE_PROJECT', reason: 'project-out-of-scope' },
    ]);
  });

  it('refuses the install before collecting any readiness fact when the first confirmation refuses', async () => {
    const h = createHarness();
    const service = serviceOver(h, { serverAgents: markingServerAgents(h.sequence) });
    const moved = movedRefusal();
    let calls = 0;

    const outcome = await service.install(
      installRequest(h, buildPlan(), {
        confirmProjectRoot: () => {
          calls += 1;
          return err(moved);
        },
      }),
    );

    expect(calls).toBe(1);
    expect(isErr(outcome) && outcome.error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(h.sequence).not.toContain('readiness');
    expect(h.installer.calls).toHaveLength(0);
    expect(h.journal.writes).toEqual([]);
    expect(first(framesOf(allMessages(h), 'instrumentation.failed')).payload.error.code).toBe(
      'PATH_OUTSIDE_PROJECT',
    );
    expect(unconfirmedRecords(h).map((entry) => entry.fields)).toEqual([
      {
        stage: 'before-state-root-check',
        code: 'PATH_OUTSIDE_PROJECT',
        reason: 'project-out-of-scope',
      },
    ]);
  });

  it.each([
    {
      kind: 'throws',
      reason: 'project-root-confirmation-threw',
      confirm: (): Result<{ readonly canonicalRoot: string }> => {
        throw new Error('/private/leaked/sample-project could not be read');
      },
      logged: { errorClass: 'Error' },
    },
    {
      kind: 'answers a relative canonical root',
      reason: 'project-root-confirmation-invalid',
      confirm: (): Result<{ readonly canonicalRoot: string }> =>
        ok({ canonicalRoot: 'leaked/sample-project' }),
      logged: {},
    },
    {
      kind: 'answers an empty canonical root',
      reason: 'project-root-confirmation-invalid',
      confirm: (): Result<{ readonly canonicalRoot: string }> => ok({ canonicalRoot: '' }),
      logged: {},
    },
  ])(
    'fails closed as INTERNAL when the confirmation $kind, keeping nothing it carried',
    async ({ reason, confirm, logged }) => {
      const h = createHarness();

      const outcome = await h.service.install(
        installRequest(h, buildPlan(), { confirmProjectRoot: confirm }),
      );

      expect(isErr(outcome)).toBe(true);
      if (isErr(outcome)) {
        expect(outcome.error.code).toBe('INTERNAL');
        expect(outcome.error.details).toMatchObject({ reason });
        expect(outcome.error.message).not.toMatch(/leaked/u);
      }
      expect(h.installer.calls).toHaveLength(0);
      expect(h.journal.writes).toEqual([]);
      expect(first(framesOf(allMessages(h), 'instrumentation.failed')).payload.error.code).toBe(
        'INTERNAL',
      );
      expect(unconfirmedRecords(h).map((entry) => entry.fields)).toEqual([
        { stage: 'before-state-root-check', code: 'INTERNAL', reason, ...logged },
      ]);
      // Neither a frame nor a log record carries the path the confirmation held.
      expect(JSON.stringify(allMessages(h))).not.toMatch(/leaked/u);
      expect(JSON.stringify(h.log.map((entry) => entry.fields))).not.toMatch(/leaked/u);
    },
  );

  it('makes the second confirmation the last act before the installer, with no await in between', async () => {
    const h = createHarness();
    const service = serviceOver(h, { serverAgents: markingServerAgents(h.sequence) });
    let calls = 0;

    const outcome = await service.install(
      installRequest(h, buildPlan(), {
        confirmProjectRoot: () => {
          calls += 1;
          const call = String(calls);
          h.sequence.push(`confirm:${call}`);
          // A microtask queued by the proof runs at the next `await`: had the
          // service awaited anything between the proof and the installer, it
          // would be marked before the installer.
          queueMicrotask(() => h.sequence.push(`microtask:${call}`));
          return ok({ canonicalRoot: CANONICAL_PROJECT_ROOT });
        },
      }),
    );

    expect(isOk(outcome)).toBe(true);
    const upToInstaller = h.sequence.slice(0, h.sequence.indexOf('installer') + 1);
    expect(upToInstaller.filter((entry) => entry !== 'readiness')).toEqual([
      'suspend',
      'confirm:1',
      'microtask:1',
      'confirm:2',
      'installer',
    ]);
    // The readiness facts were collected between the two proofs.
    const readinessAt = upToInstaller.indexOf('readiness');
    expect(readinessAt).toBeGreaterThan(upToInstaller.indexOf('confirm:1'));
    expect(readinessAt).toBeLessThan(upToInstaller.indexOf('confirm:2'));
    expect(h.sequence.indexOf('microtask:2')).toBeGreaterThan(h.sequence.indexOf('installer'));
  });

  it('hands the installer no canonical root when the request carries no confirmation', async () => {
    const h = createHarness();

    const outcome = await h.service.install(installRequest(h, buildPlan()));

    expect(isOk(outcome)).toBe(true);
    const { context } = first(h.installer.calls);
    expect(Object.hasOwn(context, 'canonicalProjectRoot')).toBe(false);
    expect(context.projectRoot).toBe(PROJECT_ROOT);
  });

  it('builds a context with the canonical root normalised, and refuses a relative one', () => {
    const h = createHarness();
    const input = {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      plan: buildPlan(),
      code: h.code,
      readiness: {},
    };

    const normalised = unwrap(
      h.service.buildContext({
        ...input,
        canonicalProjectRoot: '\\volumes\\work\\nested\\..\\sample-project\\',
      }),
    );
    expect(normalised.canonicalProjectRoot).toBe(CANONICAL_PROJECT_ROOT);

    const refused = h.service.buildContext({
      ...input,
      canonicalProjectRoot: 'volumes/work/sample-project',
    });
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.code).toBe('INTERNAL');
      expect(refused.error.details).toMatchObject({ field: 'canonicalProjectRoot' });
    }
    expect(readdirSync(h.home)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adapter-agnosticism and module boundaries, read off the source
// ---------------------------------------------------------------------------

describe('adapter agnosticism', () => {
  it('installs through a registry of fakes with a seventh adapter, mapping the messages identically', async () => {
    const seventh = fakeAdapter(EXTRA_ADAPTER_ID, [{ type: 'perf-tracking', mode: 'runtime' }]);
    const h = createHarness({ extraAdapters: [seventh] });
    const plan = buildPlan({
      registry: h.registry,
      targets: [
        ...BASE_TARGETS,
        { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'perf-tracking' },
      ],
    });
    const expected = sentinelResult(h.home, plan);

    const outcome = await h.service.install(installRequest(h, plan));

    for (const id of [PAGE_ADAPTER_ID, SERVER_ADAPTER_ID, EXTRA_ADAPTER_ID]) {
      expect(ADAPTER_IDS).not.toContain(id);
    }
    expect(plan.instrumentationTargets.map((action) => action.adapter)).toContain(EXTRA_ADAPTER_ID);
    expect(isOk(outcome)).toBe(true);
    expect(first(h.installer.calls).options.adapters).toBe(h.registry);
    expect(first(framesOf(allMessages(h), 'instrumentation.ready')).payload).toStrictEqual({
      sessionId: SESSION_ID,
      applied: expected.applied,
      runtimeHooks: expected.runtimeHooks,
      unavailable: expected.unavailable,
    });
    // The readiness gate discovered the new adapter by claim, not by id.
    expect(seventh.readinessCalls.length).toBeGreaterThan(0);
  });
});

/** The workspace packages `./service.ts` may import, besides `node:*` builtins. */
const PERMITTED_PACKAGES: ReadonlySet<string> = new Set([
  '@debuggen/protocol',
  '@debuggen/telemetry',
  '@debuggen/instrumentation',
  '@debuggen/code-analysis',
  '@debuggen/shared',
  '@debuggen/shared/node',
]);

/** Every module specifier a comment-free source names, in any import form. */
function importSpecifiersOf(code: string): string[] {
  const specifiers: string[] = [];

  for (const pattern of [
    /\bfrom\s*(['"])([^'"]+)\1/gu,
    /\bimport\s*(['"])([^'"]+)\1/gu,
    /\bimport\s*\(\s*(['"])([^'"]+)\1/gu,
    /\brequire\s*\(\s*(['"])([^'"]+)\1/gu,
  ]) {
    for (const match of code.matchAll(pattern)) {
      if (match[2] !== undefined) {
        specifiers.push(match[2]);
      }
    }
  }

  return specifiers;
}

/** Every way a comment-free source breaks the service module's import boundary. */
function boundaryViolations(code: string): string[] {
  const violations: string[] = [];
  const demoAppPath = ['apps', 'demo-app'].join('/');

  for (const specifier of importSpecifiersOf(code)) {
    if (specifier.startsWith('.')) {
      if (!specifier.endsWith('.js')) {
        violations.push(`extensionless relative import: ${specifier}`);
      }
    } else if (!specifier.startsWith('node:') && !PERMITTED_PACKAGES.has(specifier)) {
      violations.push(`imports a package outside its layers: ${specifier}`);
    }
  }

  if (/\bprocess\s*\.\s*env\b/u.test(code)) {
    violations.push('reads the environment');
  }

  if (/\bconsole\s*\./u.test(code)) {
    violations.push('writes to the console');
  }

  if (code.includes(demoAppPath)) {
    violations.push('names a demo-application path');
  }

  return violations;
}

/** The filesystem write and removal calls the module must never make. */
const WRITE_API_PATTERN =
  /\b(?:writeFile\w*|atomicReplaceFile|rename\w*|rm|rmSync|unlink\w*|truncate\w*)\b/u;

/** Every way a comment-free source could know a particular adapter. */
function adapterKnowledge(code: string): string[] {
  const findings: string[] = [];
  const checks: readonly (readonly [RegExp, string])[] = [
    [/adapters\//u, 'imports an adapter module'],
    [
      /\bcreate(?:React|BrowserPerformance|Fetch|NextJs|Prisma|Postgres)Adapter\b/u,
      'names a built-in adapter factory',
    ],
    [/\bADAPTER_IDS\b/u, 'consults the built-in adapter id list'],
    [/\bswitch\s*\([^)]*\b(?:adapter|adapterId)\b/u, 'switches on an adapter id'],
    [/\b(?:adapter|adapterId)(?:\.id)?\s*[!=]==?\s*['"`]/u, 'compares an adapter id to a literal'],
    [
      /['"`][^'"`\n]*['"`]\s*[!=]==?\s*[\w$.]*\b(?:adapter|adapterId)\b/u,
      'compares a literal to an adapter id',
    ],
  ];

  for (const specifier of importSpecifiersOf(code)) {
    if (specifier.includes('adapters')) {
      findings.push(`imports an adapter module: ${specifier}`);
    }
  }

  for (const [pattern, finding] of checks) {
    if (pattern.test(code)) {
      findings.push(finding);
    }
  }

  const builtInIds: readonly string[] = ADAPTER_IDS;
  for (const match of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gu)) {
    if (match[2] !== undefined && builtInIds.includes(match[2])) {
      findings.push(`names the built-in adapter id "${match[2]}"`);
    }
  }

  return findings;
}

describe('module boundaries', () => {
  const source = readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
  const stripped = stripComments(source);

  it('leaves code behind after the comments are stripped', () => {
    expect(stripped).toContain('export function createInstrumentationService');
    expect(stripped).toContain('export function buildDegradationNotice');
    expect(stripped).not.toContain('/**');
  });

  it('never writes, renames, truncates or removes a file', () => {
    expect(stripped.match(WRITE_API_PATTERN)).toBeNull();

    for (const planted of [
      'await writeFile(target, text);',
      'writeFileSync(target, text);',
      'await atomicReplaceFile(target, text);',
      'renameSync(temporary, target);',
      'await rm(target, { force: true });',
      'unlinkSync(target);',
      'await truncate(target, 0);',
    ]) {
      expect(WRITE_API_PATTERN.test(planted), `the scan must fire on: ${planted}`).toBe(true);
    }
  });

  it('knows no particular adapter', () => {
    expect(adapterKnowledge(stripped)).toEqual([]);

    const builtIn = first(ADAPTER_IDS);
    for (const planted of [
      "import { createReactAdapter } from '@debuggen/instrumentation/adapters/react';",
      'const adapter = createPostgresAdapter();',
      'if (ADAPTER_IDS.includes(action.adapter)) { skip(); }',
      'switch (action.adapter) { default: break; }',
      "if (action.adapter === 'sample') { skip(); }",
      "if ('sample' === action.adapter) { skip(); }",
      `const favourite = '${builtIn}';`,
    ]) {
      expect(adapterKnowledge(planted).length, `the scan must fire on: ${planted}`).toBeGreaterThan(
        0,
      );
    }
    expect(adapterKnowledge('const adapters = deps.adapters ?? createAdapterRegistry();')).toEqual(
      [],
    );
  });

  it('imports only its permitted layers, each relative import naming a .js file', () => {
    expect(importSpecifiersOf(stripped).length).toBeGreaterThan(0);
    expect(boundaryViolations(stripped)).toEqual([]);

    for (const planted of [
      "import { readConfig } from '../config';",
      "import { PanelHost } from '@debuggen/panel-renderer';",
      "import express from 'express';",
      "const loaded = await import('./readiness');",
      'const home = process.env.DEBUGGEN_HOME;',
      'console.log(home);',
      `const target = '${['apps', 'demo-app', 'src', 'page.tsx'].join('/')}';`,
    ]) {
      expect(
        boundaryViolations(planted).length,
        `the guard must fire on: ${planted}`,
      ).toBeGreaterThan(0);
    }
    expect(boundaryViolations("import { ok } from '@debuggen/shared';")).toEqual([]);
    expect(boundaryViolations("import { hashFile } from '@debuggen/shared/node';")).toEqual([]);
    expect(boundaryViolations("import { readFileSync } from 'node:fs';")).toEqual([]);
  });

  it('has no default export and reads no wall clock directly', () => {
    expect(stripped).not.toMatch(/export default/u);
    expect(stripped).not.toMatch(/Date\.now\(/u);
  });
});
