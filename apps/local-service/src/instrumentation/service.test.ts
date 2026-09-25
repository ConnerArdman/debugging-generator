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
 * - **A follow-up installs only its delta** (AAP §0.4.2): the additive ids are
 *   the upstream `actionIdentityKey` difference, an empty delta installs
 *   nothing, and a failed delta leaves the previous plan version active with no
 *   rollback performed here — the installer owns reverse-restore.
 * - **The adapter context is complete and honest**: the journal is the injected
 *   one by identity, the backup store is rooted under the state directory, the
 *   project root is normalised absolute POSIX, and every field the upstream
 *   `InstrumentationContext` declares is present — checked against the
 *   declaration's own source text, so a forgotten field fails.
 * - **The watcher bracket, per-session serialisation and the lifecycle** hold:
 *   suspend → installer → refresh/watch → resume on success and on failure,
 *   overlapping installs for one session are refused, `stopSession` restores
 *   nothing and `dispose` is idempotent.
 * - **The module knows no adapter and writes no file.** A registry of fakes
 *   with invented ids drives every install here, and a scan of the module's
 *   own code refuses adapter factories, adapter-id literals, write APIs and
 *   imports outside its layers.
 *
 * Every collaborator is an injected recording double, and the installer is a
 * scripted `InstallPlanFn`: no network, no child process, no real installer and
 * no filesystem work beyond one empty `mkdtemp` state directory per test,
 * which is asserted to stay empty. The vocabulary — paths, symbols, adapter ids
 * — is invented and generic, and the digest-shaped values are assembled at run
 * time from repeated characters.
 *
 * @module
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

import type { ServiceConfig } from '../config.js';
import type { CaptureOwner, SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  INSTRUMENTATION_ROW_ORDER,
  type InstalledSignals,
  type ProgressRow,
  type SessionProgress,
} from '../sessions/progress.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import {
  collectObservedReadiness,
  type BrowserAgentRegistry,
  type ServerAgentReadinessSource,
} from './readiness.js';
import {
  DEFAULT_INSTALL_FAILURE_HINT,
  buildDegradationNotice,
  createInstrumentationService,
  type CaptureOwnerLookup,
  type CodeAnalysisHandles,
  type InstallPlanFn,
  type InstallRequest,
  type InstrumentationService,
  type InstrumentationServiceDeps,
  type ServerAgentConfigChannel,
} from './service.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Fixtures: identities, clock, addresses
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_servicesuite0001';
const OTHER_SESSION_ID = 'ses_servicesuite0002';
const CAPTURE_ID = 'cap_servicesuite0001';
const PROJECT_ROOT = '/work/sample-project';
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
}

function createRecordingProgress(): RecordingProgress {
  const calls: ProgressCall[] = [];
  const emitted: ProgressRow[] = [];
  const failures: StageFailure[] = [];
  const installedReports: InstalledSignals[] = [];
  const throwing = new Set<ProgressMethod>();

  const note = (method: ProgressMethod, sessionId: string, args: readonly unknown[]): void => {
    calls.push({ method, sessionId, args });

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
  readonly frames: ServerFrame[];
}

function createRecordingServerChannel(): RecordingServerChannel {
  const frames: ServerFrame[] = [];

  return {
    frames,
    sendToServerAgent(projectRoot, message) {
      frames.push({ projectRoot, message });
      return ok(1);
    },
  };
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
  readonly service: InstrumentationService;
  readonly deps: InstrumentationServiceDeps;
  readonly home: string;
  readonly code: Required<CodeAnalysisHandles>;
  readonly registry: AdapterRegistry;
  readonly adapters: readonly FakeAdapter[];
  readonly installer: ScriptedInstaller;
  readonly journal: MemoryJournal;
  readonly progress: RecordingProgress;
  readonly broadcaster: RecordingBroadcaster;
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
  const serverChannel = createRecordingServerChannel();
  const watcher = createRecordingWatcher(sequence);
  const agents = createAgents();
  const serverAgents = createServerAgents();

  const deps: InstrumentationServiceDeps = {
    config: serviceConfig(home),
    logger: createRecordingLogger(log),
    modifications: journal,
    progress,
    broadcaster,
    serverAgentChannel: serverChannel,
    watcher,
    agents,
    serverAgents,
    captures: options.captures,
    adapters: registry,
    installer: installer.fn,
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

/** Every frame the harness sent, to the session fan-out and to the preload. */
function allMessages(h: Harness): ProtocolMessage[] {
  return [
    ...h.broadcaster.frames.map((frame) => frame.message),
    ...h.serverChannel.frames.map((frame) => frame.message),
  ];
}

function progressCalls(h: Harness, method: ProgressMethod): ProgressCall[] {
  return h.progress.calls.filter((call) => call.method === method);
}

beforeEach(() => {
  actionCounter = 0;
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

  it('reports what was armed to the progress checklist from the installer configuration', async () => {
    const h = createHarness();
    const plan = buildPlan();
    const expected = sentinelResult(h.home, plan);

    await h.service.install(installRequest(h, plan));

    expect(h.progress.installed).toStrictEqual([
      {
        hooks: expected.agentHooks,
        serverSignals: expected.serverSignals,
        runtimeHooks: expected.runtimeHooks,
        unavailable: expected.unavailable,
      },
    ]);
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
      expect(armed.value.agentHooks).toStrictEqual(expected.agentHooks);
      expect(armed.value.serverSignals).toStrictEqual(expected.serverSignals);
    }

    const agentFrames = h.broadcaster.frames.filter(
      (frame) => frame.message.type === 'agent.config',
    );
    expect(agentFrames).toHaveLength(1);
    expect(first(agentFrames).kinds).toEqual(['agent']);
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
      expect(disarmed.value.serverAgent).toBe('delivered');
      expect(disarmed.value.captureId).toBe(CAPTURE_ID);
    }

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
    expect(h.serverChannel.frames).toHaveLength(0);
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
    }
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
    const error = nothingEnabledError(
      'Start the sample dev server with the preload, then plan again',
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

    const payload = first(failedFrames).payload;
    expect(payload).toStrictEqual({
      sessionId: SESSION_ID,
      error: { code: wire.code, message: wire.message, hint: wire.hint },
    });
    expect(payload.error.hint).toBe(error.hint);
    expect(instrumentationFailedPayloadSchema.safeParse(payload).success).toBe(true);

    expect(framesOf(allMessages(h), 'instrumentation.ready')).toHaveLength(0);
    expect(h.progress.emitted).toEqual([]);
    expect(progressCalls(h, 'reportInstrumentation')).toHaveLength(0);
    expect(progressCalls(h, 'readyToCapture')).toHaveLength(0);

    const stage: ProgressStage = 'instrument';
    expect(h.progress.failures).toStrictEqual([
      { stage, code: wire.code, message: wire.message, hint: wire.hint },
    ]);
    expect(h.service.arming(SESSION_ID)).toBeUndefined();
  });

  it('supplies the default hint when the installer error carries none', async () => {
    const h = createHarness({ script: () => Promise.resolve(err(nothingEnabledError())) });

    await h.service.install(installRequest(h, buildPlan()));

    const payload = first(framesOf(allMessages(h), 'instrumentation.failed')).payload;
    expect(payload.error.hint).toBe(DEFAULT_INSTALL_FAILURE_HINT);
    expect(first(h.progress.failures).hint).toBe(DEFAULT_INSTALL_FAILURE_HINT);
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

    await h.service.dispose();
    await h.service.dispose();

    expect(h.watcher.calls.filter((call) => call.method === 'stopAll')).toHaveLength(1);
    expect(h.service.arming(SESSION_ID)).toBeUndefined();
    expect(h.service.isInstalling(SESSION_ID)).toBe(false);

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
