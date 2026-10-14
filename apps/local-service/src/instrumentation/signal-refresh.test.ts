/**
 * Tests for the signal report of `./service.ts`: how the instrumentation
 * driver keeps the `instrumentation.ready` report, the instrument-stage rows
 * and the bind replay true to the bound page (AAP §0.5.5, §0.7.1).
 *
 * What is on trial, and why it matters:
 *
 * - **An install is judged on the page the verdict saw.** The install's
 *   context is built from the page-agent report on file when it starts; a
 *   panel usually binds a moment before its agent reports. When the readiness
 *   verdict judged a page the runtime adapters did not, their share of the
 *   report is asked again, one corrected `instrumentation.ready` is sent, and
 *   the checklist shows ✓ — never "Could not enable …: no page agent has
 *   reported" — for what the capture will collect.
 * - **An empty follow-up delta never re-announces stale gaps.** Re-announcing
 *   the previous version's report brings it up to date with the facts the
 *   follow-up collected first.
 * - **A signal waiting for the page is not a failure.** While no tab is bound,
 *   or the bound tab's page has not reported, its signals stay listed as
 *   unavailable, each checklist label is shown once as waiting — "◌ ‹label›",
 *   with what it waits for — beside the readiness gate's reload request, and
 *   no ✗ or degradation row is sent; when the page reports later, the
 *   corrected report follows and a ✓ row with the waiting row's own message
 *   replaces it in place — without a "Ready to capture", which the
 *   orchestrator owns. A page that answers with a gap settles its waiting row
 *   as ✗.
 * - **A bind is replayed the latest report.** `replaySignalReport` sends the
 *   latest `instrumentation.ready` (and the latest `instrumentation.failed`)
 *   to exactly the kinds asked for, and re-judges a report the page may now
 *   clear.
 * - **A patch-mode adapter is never asked again.** Only adapters whose every
 *   action installs in `runtime` mode are refreshed; asking one again writes no
 *   file.
 *
 * Every collaborator is an injected recording double except the ones on
 * trial: the real `installPlan`, the real `evaluateReadiness` and the real
 * feasibility gate run every install. The adapters are fakes with invented ids
 * whose answer depends only on the page facts they are handed, exactly the
 * dependency the built-in runtime adapters have.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_HOOK_KEYS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  buildReadiness,
  createAdapterRegistry,
  deriveAgentHookConfig,
  normalizePlan,
  type AdapterClaimEntry,
  type AdapterRegistry,
  type AgentHookConfig,
  type AgentHookKey,
  type ClaimingAdapter,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationPlan,
  type ModificationRecord,
  type ObservedReadinessInputs,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  isMessageOfType,
  type AgentReadyPayload,
  type BoundTab,
  type ClientKind,
  type InstrumentationFailedPayload,
  type InstrumentationReadyPayload,
  type ProtocolMessage,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import { isErr, isOk, ok, unwrap, type LogFields, type Logger } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import type { SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  buildInstrumentationRows,
  type InstalledSignals,
  type ProgressRow,
  type SessionProgress,
} from '../sessions/progress.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import {
  RELOAD_REQUEST_MESSAGE,
  type BrowserAgentRegistry,
  type ServerAgentReadinessSource,
  type WaitForAgentReadyOptions,
} from './readiness.js';
import {
  createInstrumentationService,
  type CodeAnalysisHandles,
  type InstallRequest,
  type InstrumentationDriver,
  type InstrumentationServiceDeps,
} from './service.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Fixtures: identities, clock, addresses
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_signalrefresh001';
const PROJECT_ROOT = '/work/refresh-sample';
const TAB_ID = 23;
const NOW = 1_800_000_000_000;
const APP_ORIGIN = 'http://127.0.0.1:20391';
const BOUND_TAB: BoundTab = { tabId: TAB_ID, url: `${APP_ORIGIN}/orders` };
const UI_KINDS: readonly ClientKind[] = ['vscode', 'devtools'];

const clock = (): number => NOW;

/** The fake adapters' invented ids, in no built-in list. */
const PAGE_ADAPTER_ID = 'sample-refresh-page';
const SERVER_ADAPTER_ID = 'sample-refresh-server';

/** The page adapter's own words for "no page agent yet", as a runtime adapter reports it. */
const NO_AGENT_REASON = 'no page agent has reported for the bound tab in this sample';
const NO_AGENT_HINT = 'Open the sample page in a tab and its Debug Generator panel, then try again';

/** The first element of an array, failing the test rather than returning `undefined`. */
function first<T>(values: readonly T[]): T {
  const value = values[0];

  if (value === undefined) {
    throw new Error('expected at least one element');
  }

  return value;
}

/** The last element of an array, failing the test rather than returning `undefined`. */
function last<T>(values: readonly T[]): T {
  const value = values.at(-1);

  if (value === undefined) {
    throw new Error('expected at least one element');
  }

  return value;
}

/** A healthy relayed `agent.ready` for the bound tab. */
function agentReady(overrides: Partial<AgentReadyPayload> = {}): AgentReadyPayload {
  return {
    tabId: TAB_ID,
    documentId: 'doc_signalrefresh01',
    producerId: 'prd_signalrefresh01',
    url: `${APP_ORIGIN}/orders`,
    installedBeforeReact: true,
    reactDetected: true,
    ...overrides,
  };
}

/** Waits for `predicate`, polling on real timers, for at most `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error('the condition was not met in time');
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

// ---------------------------------------------------------------------------
// The page-agent ledger — answers `waitForAgentReady` the way the service's
// own ledger does: at once with a report that answers, else when one arrives,
// its timeout passes or the wait is aborted.
// ---------------------------------------------------------------------------

interface PendingWait {
  readonly tabId: number;
  readonly options: WaitForAgentReadyOptions;
  readonly resolve: (report: AgentReadyPayload | undefined) => void;
}

interface FakeLedger {
  readonly registry: BrowserAgentRegistry;
  /** Every wait asked of the ledger, in order. */
  readonly waits: WaitForAgentReadyOptions[];
  /** Resolves once the ledger holds `count` waits in total that have not yet been answered. */
  nextWait(): Promise<void>;
  /** Relays a report, as the WebSocket router does, answering every wait it satisfies. */
  report(payload: AgentReadyPayload): void;
}

function createLedger(): FakeLedger {
  let latest: AgentReadyPayload | undefined;
  const waits: WaitForAgentReadyOptions[] = [];
  const pending: PendingWait[] = [];
  let onWait: (() => void) | undefined;

  const answers = (
    report: AgentReadyPayload | undefined,
    tabId: number,
    options: WaitForAgentReadyOptions,
  ): report is AgentReadyPayload =>
    report !== undefined &&
    report.tabId === tabId &&
    (options.afterDocumentId === undefined || report.documentId !== options.afterDocumentId);

  const registry: BrowserAgentRegistry = {
    latestAgentReady: ({ tabId }) => (latest?.tabId === tabId ? latest : undefined),
    latestAgentReadyAt: () => NOW,
    waitForAgentReady({ tabId }, options) {
      waits.push(options);

      if (answers(latest, tabId, options)) {
        return Promise.resolve(latest);
      }

      return new Promise<AgentReadyPayload | undefined>((resolve) => {
        const settle = (report: AgentReadyPayload | undefined): void => {
          const index = pending.indexOf(entry);

          if (index !== -1) {
            pending.splice(index, 1);
          }

          clearTimeout(timer);
          resolve(report);
        };
        const timer = setTimeout(() => {
          settle(undefined);
        }, options.timeoutMs ?? 0);
        const entry: PendingWait = { tabId, options, resolve: settle };

        pending.push(entry);
        options.signal?.addEventListener(
          'abort',
          () => {
            entry.resolve(undefined);
          },
          { once: true },
        );
        onWait?.();
      });
    },
  };

  return {
    registry,
    waits,
    nextWait: () =>
      new Promise<void>((resolve) => {
        onWait = () => {
          onWait = undefined;
          resolve();
        };
      }),
    report(payload) {
      latest = payload;

      for (const entry of [...pending]) {
        if (answers(payload, entry.tabId, entry.options)) {
          entry.resolve(payload);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fake adapters — the page adapter's answer depends only on the page facts it
// is handed, as the built-in runtime adapters' does.
// ---------------------------------------------------------------------------

interface FakeAdapter extends ClaimingAdapter {
  /** The page facts of every install call, in order. */
  readonly installs: ObservedReadinessInputs[];
}

/** The page signals a set of actions arms: the hooks `deriveAgentHookConfig` turns on. */
function pageSignalsOf(actions: readonly InstrumentationAction[]): AgentHookKey[] {
  const hooks = deriveAgentHookConfig(actions);
  return AGENT_HOOK_KEYS.filter((key) => hooks[key]);
}

/** Why the page adapter refuses its signals with `refuseWithAgent`, although a page agent reported. */
const REFUSED_WITH_AGENT_REASON = 'the sample page blocks the hook it would need';

/**
 * The page adapter. With `throwAfterFirst`, every install call after the first
 * rejects — an adapter that breaks when a refresh asks it again. With
 * `refuseWithAgent`, it refuses its signals even once a page agent reported —
 * an obstacle on the page itself rather than a page that has not reported.
 */
function pageAdapter(
  options: { readonly throwAfterFirst?: boolean; readonly refuseWithAgent?: boolean } = {},
): FakeAdapter {
  const installs: ObservedReadinessInputs[] = [];
  const claims: readonly AdapterClaimEntry[] = [
    { type: 'interaction-tracking', mode: 'runtime' },
    { type: 'react-render-tracking', mode: 'runtime' },
    { type: 'fetch-tracking', mode: 'runtime' },
  ];

  return {
    id: PAGE_ADAPTER_ID,
    claims,
    installs,
    canHandle: () => true,
    createPlan: () => Promise.resolve([]),
    install: (actions, context) => {
      installs.push(context.readiness);
      const signals = pageSignalsOf(actions);

      if (options.throwAfterFirst === true && installs.length > 1) {
        return Promise.reject(new Error('the sample page probe broke'));
      }

      if (context.readiness.browserAgent === undefined || options.refuseWithAgent === true) {
        const reason =
          context.readiness.browserAgent === undefined
            ? NO_AGENT_REASON
            : REFUSED_WITH_AGENT_REASON;

        return Promise.resolve({
          adapterId: PAGE_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable: signals.map((signal) => ({ signal, reason, hint: NO_AGENT_HINT })),
        });
      }

      const agentHooks: Partial<AgentHookConfig> = Object.fromEntries(
        signals.map((signal) => [signal, true]),
      );

      return Promise.resolve({
        adapterId: PAGE_ADAPTER_ID,
        applied: [],
        runtimeHooks: [...new Set(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]))],
        unavailable: [],
        agentHooks,
      });
    },
    remove: () =>
      Promise.resolve({
        adapterId: PAGE_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: [],
      }),
    readiness: () =>
      Promise.resolve(buildReadiness({ adapter: PAGE_ADAPTER_ID, signals: [], now: clock })),
  };
}

/**
 * A server-tier adapter claiming a runtime database hook and a patch-mode
 * function timer. It arms its hook whatever the page does, and writes nothing.
 */
function serverAdapter(): FakeAdapter {
  const installs: ObservedReadinessInputs[] = [];

  return {
    id: SERVER_ADAPTER_ID,
    claims: [
      { type: 'db-query-tracking', mode: 'runtime' },
      { type: 'function-timing', mode: 'patch' },
    ],
    installs,
    canHandle: () => true,
    createPlan: () => Promise.resolve([]),
    install: (_actions, context) => {
      installs.push(context.readiness);
      return Promise.resolve({
        adapterId: SERVER_ADAPTER_ID,
        applied: [],
        runtimeHooks: [CAPTURE_SIGNAL_LABELS.pg],
        unavailable: [],
      });
    },
    remove: () =>
      Promise.resolve({
        adapterId: SERVER_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: [],
      }),
    readiness: () =>
      Promise.resolve(buildReadiness({ adapter: SERVER_ADAPTER_ID, signals: [], now: clock })),
  };
}

// ---------------------------------------------------------------------------
// Plans — normalised through the upstream `normalizePlan`.
// ---------------------------------------------------------------------------

interface TargetInput {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}

const PAGE_TARGETS: readonly TargetInput[] = [
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'react-render-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'fetch-tracking' },
];

const DATABASE_TARGET: TargetInput = {
  file: TARGETLESS_FILE,
  symbol: TARGETLESS_SYMBOL,
  type: 'db-query-tracking',
};

const PATCH_TARGET: TargetInput = {
  file: 'src/server/refresh-ledger.ts',
  symbol: 'settleRefreshLedger',
  type: 'function-timing',
};

let actionCounter = 0;

function nextActionId(): string {
  actionCounter += 1;
  return `act_${String(actionCounter).padStart(16, '0')}`;
}

function buildPlan(
  registry: AdapterRegistry,
  targets: readonly TargetInput[],
  options: {
    readonly planVersion?: number;
    readonly previousActions?: readonly InstrumentationAction[];
  } = {},
): InstrumentationPlan {
  return unwrap(
    normalizePlan(
      {
        objective: 'Find where the time goes when the sample order list refreshes',
        capture: ['click timing', 'renders', 'requests', 'database queries'],
        hypotheses: ['the refresh waits on a slow query'],
        instrumentationTargets: targets.map((target) => ({ ...target })),
      },
      {
        sessionId: SESSION_ID,
        planVersion: options.planVersion ?? 1,
        resolver: registry,
        previousActions: options.previousActions,
        newActionId: nextActionId,
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Recording doubles
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly kinds: readonly ClientKind[] | 'all';
  readonly message: ProtocolMessage;
}

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };

  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };

  return logger;
}

interface RecordingProgress extends SessionProgress {
  /** Every method called, in order. */
  readonly calls: (keyof SessionProgress)[];
  /** The rows handed to `emit`. */
  readonly emitted: ProgressRow[];
  /** The reports handed to `reportInstrumentation`. */
  readonly installed: InstalledSignals[];
}

function recordingProgress(): RecordingProgress {
  const calls: (keyof SessionProgress)[] = [];
  const emitted: ProgressRow[] = [];
  const installed: InstalledSignals[] = [];
  const payload = (sessionId: string, row: ProgressRow): SessionProgressPayload => ({
    sessionId,
    ...row,
  });

  return {
    calls,
    emitted,
    installed,
    emit(sessionId, row) {
      calls.push('emit');
      emitted.push(row);
      return ok(payload(sessionId, row));
    },
    stageStarted(sessionId, stage, message) {
      calls.push('stageStarted');
      return ok(payload(sessionId, { stage, status: 'running', message: message ?? stage }));
    },
    stageCompleted(sessionId, stage, message) {
      calls.push('stageCompleted');
      return ok(payload(sessionId, { stage, status: 'done', message: message ?? stage }));
    },
    stageFailed(sessionId, failure) {
      calls.push('stageFailed');
      return ok(
        payload(sessionId, { stage: failure.stage, status: 'failed', message: failure.message }),
      );
    },
    finding(sessionId, stage, message) {
      calls.push('finding');
      return ok(payload(sessionId, { stage, status: 'done', message }));
    },
    reportInvestigation() {
      calls.push('reportInvestigation');
      return ok([]);
    },
    reportInstrumentation(_sessionId, report) {
      calls.push('reportInstrumentation');
      installed.push(report);
      return ok([]);
    },
    readyToCapture(sessionId) {
      calls.push('readyToCapture');
      return ok(payload(sessionId, { stage: 'instrument', status: 'done', message: 'ready' }));
    },
  };
}

function memoryJournal(): ModificationsRepo {
  const records: ModificationRecord[] = [];
  const bySession = (sessionId: string): ModificationRecord[] =>
    records.filter((record) => record.sessionId === sessionId);

  return {
    append: (record) => {
      records.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus: (id) => {
      const record = records.find((candidate) => candidate.id === id);
      return Promise.resolve(record === undefined ? ok(first(records)) : ok(record));
    },
    listBySession: (sessionId) => Promise.resolve(ok(bySession(sessionId))),
    listPageBySession: (sessionId, window) => {
      const all = bySession(sessionId);
      return Promise.resolve(
        ok({ records: all.slice(window.offset, window.offset + window.limit), total: all.length }),
      );
    },
    listOpen: () => Promise.resolve(ok([])),
    listAllOpen: () => Promise.resolve(ok([])),
    get: (id) => Promise.resolve(ok(records.find((record) => record.id === id))),
    listByFile: () => Promise.resolve(ok([])),
    latestRecordForFile: () => Promise.resolve(ok(undefined)),
    listChain: () => Promise.resolve(ok([])),
    listConflicts: () => Promise.resolve(ok([])),
    listBackupPaths: () => Promise.resolve(ok([])),
    countBySession: (sessionId) => Promise.resolve(ok(bySession(sessionId).length)),
    deleteBySession: () => Promise.resolve(ok(0)),
  };
}

function quietWatcher(): InstrumentationWatcher {
  return {
    watchSession: () => Promise.resolve(ok([])),
    refresh: () => Promise.resolve(ok([])),
    suspend: () => undefined,
    resume: () => undefined,
    stopSession: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    watchedFiles: () => [],
    watchIssues: () => [],
  };
}

function connectedPreload(): ServerAgentReadinessSource {
  return {
    hasServerAgentForProject: (projectRoot) => projectRoot === PROJECT_ROOT,
    serverAgentForProject: (projectRoot) =>
      ok({ online: true, lastSeenAt: NOW, connectedAt: NOW, projectRoot }),
  };
}

/**
 * Code-analysis handles of an empty index. The feasibility gate requires the
 * query and graph surfaces to exist; every action it judges here is targetless
 * (or the gate is skipped), so it never looks anything up in them, and no fake
 * adapter reads them.
 */
function codeHandles(): CodeAnalysisHandles {
  return {
    graph: { nodesByFile: () => [] } as unknown as CodeAnalysisHandles['graph'],
    queries: {
      hasSymbol: () => false,
      findByName: () => [],
    } as unknown as CodeAnalysisHandles['queries'],
    routeMap: { tag: 'routeMap' } as unknown as CodeAnalysisHandles['routeMap'],
    summary: { tag: 'summary' } as unknown as CodeAnalysisHandles['summary'],
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: InstrumentationDriver;
  readonly registry: AdapterRegistry;
  readonly page: FakeAdapter;
  readonly server: FakeAdapter;
  readonly ledger: FakeLedger;
  readonly progress: RecordingProgress;
  readonly frames: SentFrame[];
  readonly log: LogEntry[];
}

const homes: string[] = [];
const services: InstrumentationDriver[] = [];

function createHarness(
  options: { readonly throwingPageRefresh?: boolean; readonly refusingPage?: boolean } = {},
): Harness {
  const home = mkdtempSync(join(tmpdir(), 'debuggen-signal-refresh-'));
  homes.push(home);

  const page = pageAdapter({
    throwAfterFirst: options.throwingPageRefresh === true,
    refuseWithAgent: options.refusingPage === true,
  });
  const server = serverAdapter();
  const registry = createAdapterRegistry({ adapters: [page, server] });
  const ledger = createLedger();
  const progress = recordingProgress();
  const frames: SentFrame[] = [];
  const log: LogEntry[] = [];
  const broadcaster: SessionBroadcaster = {
    broadcast: (_sessionId, message) => {
      frames.push({ kinds: 'all', message });
    },
    broadcastToKinds: (_sessionId, kinds, message) => {
      frames.push({ kinds: [...kinds], message });
    },
  };
  const config: ServiceConfig = {
    host: '127.0.0.1',
    port: 20_390,
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
  const deps: InstrumentationServiceDeps = {
    config,
    logger: recordingLogger(log),
    modifications: memoryJournal(),
    progress,
    broadcaster,
    agentChannel: { sendToBoundTab: () => ok({ delivered: 1 }) },
    serverAgentChannel: { sendToServerAgent: () => ok(1) },
    watcher: quietWatcher(),
    agents: ledger.registry,
    serverAgents: connectedPreload(),
    adapters: registry,
    reloadWaitMs: 0,
    now: clock,
  };
  const service = createInstrumentationService(deps);
  services.push(service);

  return { service, registry, page, server, ledger, progress, frames, log };
}

function installRequest(plan: InstrumentationPlan, overrides: Partial<InstallRequest> = {}) {
  return {
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    plan,
    code: codeHandles(),
    boundTab: BOUND_TAB,
    ...overrides,
  } satisfies InstallRequest;
}

/** The `instrumentation.ready` frames among `frames`, with the kinds each went to. */
function readyFrames(
  frames: readonly SentFrame[],
): { readonly kinds: SentFrame['kinds']; readonly payload: InstrumentationReadyPayload }[] {
  return frames.flatMap((frame) =>
    isMessageOfType(frame.message, 'instrumentation.ready')
      ? [{ kinds: frame.kinds, payload: frame.message.payload }]
      : [],
  );
}

/** The `instrumentation.failed` frames among `frames`, with the kinds each went to. */
function failedFrames(
  frames: readonly SentFrame[],
): { readonly kinds: SentFrame['kinds']; readonly payload: InstrumentationFailedPayload }[] {
  return frames.flatMap((frame) =>
    isMessageOfType(frame.message, 'instrumentation.failed')
      ? [{ kinds: frame.kinds, payload: frame.message.payload }]
      : [],
  );
}

/** The labels of the page signals the page targets arm, in progress-row order. */
function pageLabels(plan: InstrumentationPlan): string[] {
  const actions = plan.instrumentationTargets.filter(
    (action) => action.adapter === PAGE_ADAPTER_ID,
  );
  return [...new Set(pageSignalsOf(actions).map((signal) => CAPTURE_SIGNAL_LABELS[signal]))];
}

/** Every row a list of installed-signal reports produces, in order. */
function rowsOf(reports: readonly InstalledSignals[]): ProgressRow[] {
  return reports.flatMap((report) => [...buildInstrumentationRows(report)]);
}

/** Whether a row presents a page signal as not enabled, as a ✗ row or a degradation row. */
function failsAPageSignal(row: ProgressRow, labels: readonly string[]): boolean {
  return labels.some((label) => row.message.startsWith(`Could not enable ${label}:`));
}

/** The rows among `rows` that show a page label as waiting: `running`, the label itself as message. */
function waitingRowsIn(rows: readonly ProgressRow[], labels: readonly string[]): ProgressRow[] {
  return rows.filter(
    (row) => row.stage === 'instrument' && row.status === 'running' && labels.includes(row.message),
  );
}

/** Whether a gap is the page adapter's "no page agent yet". */
function isNoAgentGap(gap: UnavailableSignal): boolean {
  return gap.reason === NO_AGENT_REASON;
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.dispose();
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }

  actionCounter = 0;
});

// ---------------------------------------------------------------------------
// (a) The install is judged on the page the verdict saw
// ---------------------------------------------------------------------------

describe('an install whose page agent reports while readiness settles', () => {
  it('re-asks the runtime adapters, sends one corrected ready report, and checks every page signal', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);

    // The panel is bound, but its page agent has not reported yet.
    const waiting = h.ledger.nextWait();
    const pending = h.service.install(installRequest(plan));
    await waiting;
    h.ledger.report(agentReady());
    const outcome = unwrap(await pending);

    // Two ready frames: the installer's own report, then the corrected one.
    const ready = readyFrames(h.frames);
    expect(ready).toHaveLength(2);
    expect(first(ready).payload.unavailable.filter(isNoAgentGap).length).toBeGreaterThan(0);
    expect(last(ready).kinds).toEqual(UI_KINDS);
    expect(last(ready).payload.unavailable).toEqual([]);
    expect(last(ready).payload.runtimeHooks).toEqual(expect.arrayContaining(labels));

    // The page adapter was asked again with the page the verdict judged.
    expect(h.page.installs).toHaveLength(2);
    expect(first(h.page.installs).browserAgent).toBeUndefined();
    expect(last(h.page.installs).browserAgent?.documentId).toBe('doc_signalrefresh01');

    // No row says a page signal could not be enabled; each has its ✓.
    expect(h.progress.emitted.filter((row) => failsAPageSignal(row, labels))).toEqual([]);
    const rows = rowsOf(h.progress.installed);
    expect(rows.filter((row) => row.status === 'failed')).toEqual([]);
    expect(rows.filter((row) => row.status === 'done').map((row) => row.message)).toEqual(
      expect.arrayContaining([...labels, CAPTURE_SIGNAL_LABELS.pg]),
    );
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toHaveLength(1);

    // The outcome the pipeline reads says the same.
    expect(outcome.readiness.satisfied).toBe(true);
    expect(outcome.unavailable).toEqual([]);
    expect(outcome.degradations).toEqual([]);
    for (const key of pageSignalsOf(plan.instrumentationTargets)) {
      expect(outcome.agentHooks[key], `${key} is armed`).toBe(true);
    }
  });

  it('sends exactly one ready report and asks each adapter once when the page had reported before', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    h.ledger.report(agentReady());

    const outcome = unwrap(await h.service.install(installRequest(plan)));

    expect(readyFrames(h.frames)).toHaveLength(1);
    expect(first(readyFrames(h.frames)).payload.unavailable).toEqual([]);
    expect(h.page.installs).toHaveLength(1);
    expect(h.server.installs).toHaveLength(1);
    expect(outcome.readiness.satisfied).toBe(true);
    expect(h.progress.calls).toEqual(['stageStarted', 'reportInstrumentation', 'readyToCapture']);
  });
});

// ---------------------------------------------------------------------------
// (b) An empty follow-up delta never re-announces stale gaps
// ---------------------------------------------------------------------------

describe('a follow-up that adds no action', () => {
  it('re-announces the report brought up to date with the page, never the stale browser gaps', async () => {
    const h = createHarness();
    const previous = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(previous);

    // Version 1 was installed before any tab was bound: its page share is "no agent".
    const installed = unwrap(
      await h.service.install(installRequest(previous, { boundTab: undefined })),
    );
    expect(installed.unavailable.filter(isNoAgentGap).length).toBeGreaterThan(0);

    // The panel binds and its page agent reports; then the follow-up plans nothing new.
    h.ledger.report(agentReady());
    const next = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET], {
      planVersion: 2,
      previousActions: previous.instrumentationTargets,
    });
    const framesBefore = h.frames.length;
    const emittedBefore = h.progress.emitted.length;
    const installedBefore = h.progress.installed.length;

    const outcome = unwrap(
      await h.service.install(installRequest(next, { previousPlanVersion: 1 })),
    );

    const announced = readyFrames(h.frames.slice(framesBefore));
    expect(announced).toHaveLength(1);
    expect(first(announced).payload.unavailable.filter(isNoAgentGap)).toEqual([]);
    expect(first(announced).payload.runtimeHooks).toEqual(expect.arrayContaining(labels));
    expect(outcome.unavailable.filter(isNoAgentGap)).toEqual([]);

    const newRows = [
      ...h.progress.emitted.slice(emittedBefore),
      ...rowsOf(h.progress.installed.slice(installedBefore)),
    ];
    expect(newRows.filter((row) => failsAPageSignal(row, labels))).toEqual([]);
    expect(newRows.filter((row) => row.status === 'done').map((row) => row.message)).toEqual(
      expect.arrayContaining(labels),
    );
    expect(outcome.readiness.satisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A signal waiting for the page is not a failure, and is corrected later
// ---------------------------------------------------------------------------

describe('a bound page that has not reported by the verdict', () => {
  it('asks for the reload alone, shows no page signal as failed, and corrects the report when the page reports', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);

    const outcome = unwrap(await h.service.install(installRequest(plan)));

    // The page gate held the page signals back: listed unavailable, not failed.
    expect(outcome.readiness.satisfied).toBe(false);
    expect(outcome.readiness.awaitingPageSignals).toEqual(
      expect.arrayContaining(pageSignalsOf(plan.instrumentationTargets)),
    );
    expect(readyFrames(h.frames)).toHaveLength(1);
    expect(first(readyFrames(h.frames)).payload.unavailable.filter(isNoAgentGap).length).toBe(
      pageSignalsOf(plan.instrumentationTargets).length,
    );
    // The gate's reload request, then each page label once as waiting for it.
    expect(h.progress.emitted.map((row) => row.status)).toEqual(
      Array.from({ length: labels.length + 1 }, () => 'running'),
    );
    expect(h.progress.emitted.filter((row) => failsAPageSignal(row, labels))).toEqual([]);
    expect(first(h.progress.emitted).message).toBe(RELOAD_REQUEST_MESSAGE);
    const waitingRows = waitingRowsIn(h.progress.emitted, labels);
    expect(waitingRows.map((row) => row.message).sort()).toEqual([...labels].sort());
    for (const row of waitingRows) {
      expect(row.detail).toBe(
        `Waiting: no page agent has reported from the bound tab's current page. ${RELOAD_REQUEST_MESSAGE}`,
      );
    }
    const installRows = rowsOf(h.progress.installed);
    const checked = installRows.filter((row) => row.status === 'done').map((row) => row.message);
    expect(installRows.filter((row) => row.status === 'failed')).toEqual([]);
    expect(checked).toContain(CAPTURE_SIGNAL_LABELS.pg);
    for (const label of labels) {
      expect(checked, `${label} is waiting, not enabled`).not.toContain(label);
    }
    expect(outcome.degradations).toEqual([]);
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toEqual([]);

    // The page reports later: the waiting refresh corrects the report.
    const reportsBefore = h.progress.installed.length;
    h.ledger.report(agentReady());
    await until(() => readyFrames(h.frames).length === 2);
    await until(() => h.progress.installed.length > reportsBefore);

    const corrected = last(readyFrames(h.frames));
    expect(corrected.kinds).toEqual(UI_KINDS);
    expect(corrected.payload.unavailable).toEqual([]);
    expect(corrected.payload.runtimeHooks).toEqual(expect.arrayContaining(labels));
    const laterRows = rowsOf(h.progress.installed.slice(reportsBefore));
    expect(laterRows.filter((row) => row.status === 'failed')).toEqual([]);
    // Each ✓ row carries its waiting row's message, so it replaces it in place.
    expect(laterRows.map((row) => row.message).sort()).toEqual([...labels].sort());
    // Moving the session to ready — and its row — is the orchestrator's.
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toEqual([]);
  });

  it('shows the page signals of an install with no tab bound as waiting for the tab, never as failed', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);
    const pageSignals = pageSignalsOf(plan.instrumentationTargets);

    const outcome = unwrap(await h.service.install(installRequest(plan, { boundTab: undefined })));

    // Held back on the page gate: listed unavailable, the session not ready.
    expect(outcome.readiness.satisfied).toBe(false);
    expect(outcome.readiness.awaitingPageSignals).toEqual(expect.arrayContaining(pageSignals));
    expect(outcome.readiness.remediations.map((remediation) => remediation.kind)).toContain(
      'bind-tab',
    );
    expect(first(readyFrames(h.frames)).payload.unavailable.filter(isNoAgentGap).length).toBe(
      pageSignals.length,
    );

    // Never a degradation, a ✗ row or a reload request about them…
    expect(h.progress.emitted.filter((row) => failsAPageSignal(row, labels))).toEqual([]);
    expect(h.progress.emitted.map((row) => row.message)).not.toContain(RELOAD_REQUEST_MESSAGE);
    const installRows = rowsOf(h.progress.installed);
    expect(installRows.filter((row) => row.status === 'failed')).toEqual([]);
    expect(installRows.map((row) => row.message)).toContain(CAPTURE_SIGNAL_LABELS.pg);
    expect(outcome.degradations).toEqual([]);

    // …but each page label once as waiting, saying no tab is bound and how to bind one.
    const waitingRows = waitingRowsIn(h.progress.emitted, labels);
    expect(waitingRows.map((row) => row.message).sort()).toEqual([...labels].sort());
    for (const row of waitingRows) {
      expect(row.detail).toBe(
        'Waiting: no Chrome tab is bound to this session. Open the application in Chrome and open the "Debug Generator" panel in its DevTools.',
      );
    }
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toEqual([]);
  });

  it('settles a waiting row as ✗ when the page reports but its signal still cannot be enabled', async () => {
    const h = createHarness({ refusingPage: true });
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);

    unwrap(await h.service.install(installRequest(plan)));
    expect(waitingRowsIn(h.progress.emitted, labels)).toHaveLength(labels.length);
    const emittedBefore = h.progress.emitted.length;
    const reportsBefore = h.progress.installed.length;

    h.ledger.report(agentReady());
    await until(
      () =>
        h.progress.emitted.length >= emittedBefore + labels.length &&
        h.progress.installed.length > reportsBefore,
    );

    const later = h.progress.emitted.slice(emittedBefore);
    const laterReports = rowsOf(h.progress.installed.slice(reportsBefore));
    // The failure in AAP §0.5.5 words, once per signal, as the checklist's one
    // terminal ✗ row — never a `running` degradation row beside it…
    const failures = laterReports.filter((row) => failsAPageSignal(row, labels));
    expect(failures).toHaveLength(pageSignalsOf(plan.instrumentationTargets).length);
    expect(failures.every((row) => row.status === 'failed')).toBe(true);
    expect(later.filter((row) => failsAPageSignal(row, labels))).toEqual([]);
    // …and each waiting row settled as ✗ in place, with the page's reason.
    const settled = later.filter((row) => row.status === 'failed' && labels.includes(row.message));
    expect(settled.map((row) => row.message).sort()).toEqual([...labels].sort());
    for (const row of settled) {
      expect(row.detail).toBe(`The sample page blocks the hook it would need. ${NO_AGENT_HINT}`);
    }
    // Nothing presented as enabled: no ✓ row for a settled label.
    for (const label of labels) {
      expect(laterReports.some((row) => row.message === label)).toBe(false);
    }
    expect(waitingRowsIn(later, labels)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) + (d) The bind replay
// ---------------------------------------------------------------------------

describe('replaySignalReport', () => {
  it('replays nothing for a session this process never installed', () => {
    const h = createHarness();

    expect(
      unwrap(h.service.replaySignalReport({ sessionId: SESSION_ID, kinds: ['devtools'] })),
    ).toBe('nothing-to-replay');
    expect(h.frames).toEqual([]);
  });

  it('refuses a malformed request', () => {
    const h = createHarness();

    for (const request of [
      { sessionId: ' ', kinds: ['devtools'] as const },
      { sessionId: SESSION_ID, kinds: [] },
      { sessionId: SESSION_ID, kinds: ['devtools', 'browser'] as unknown as ClientKind[] },
      { sessionId: SESSION_ID, kinds: ['devtools'] as const, boundTab: { tabId: -1, url: '' } },
    ]) {
      const replayed = h.service.replaySignalReport(request);
      expect(isErr(replayed) && replayed.error.code).toBe('INTERNAL');
    }

    expect(h.frames).toEqual([]);
  });

  it('sends the latest ready report to the kinds asked for, and only to them', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    h.ledger.report(agentReady());
    await h.service.install(installRequest(plan));
    const installedFrame = last(readyFrames(h.frames));
    const framesBefore = h.frames.length;
    const callsBefore = h.progress.calls.length;

    const replayed = h.service.replaySignalReport({
      sessionId: SESSION_ID,
      boundTab: BOUND_TAB,
      kinds: ['devtools'],
    });

    expect(unwrap(replayed)).toBe('replayed');
    const sent = h.frames.slice(framesBefore);
    expect(sent).toHaveLength(1);
    expect(first(sent).kinds).toEqual(['devtools']);
    expect(first(readyFrames(sent)).payload).toStrictEqual(installedFrame.payload);
    // A replay is not progress: no row, and nothing to refresh for a clean report.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(h.progress.calls.length).toBe(callsBefore);
    expect(h.frames.length).toBe(framesBefore + 1);
  });

  it('replays the latest failure after an install that could enable nothing', async () => {
    const h = createHarness();
    // Only page actions, and no page agent: nothing at all can be enabled.
    const plan = buildPlan(h.registry, PAGE_TARGETS);

    const failedInstall = await h.service.install(installRequest(plan, { boundTab: undefined }));
    expect(isErr(failedInstall)).toBe(true);
    const announced = last(failedFrames(h.frames));
    const framesBefore = h.frames.length;

    const replayed = h.service.replaySignalReport({ sessionId: SESSION_ID, kinds: ['devtools'] });

    expect(unwrap(replayed)).toBe('replayed');
    const sent = h.frames.slice(framesBefore);
    expect(sent.map((frame) => frame.message.type)).toEqual(['instrumentation.failed']);
    expect(first(sent).kinds).toEqual(['devtools']);
    expect(first(failedFrames(sent)).payload).toStrictEqual(announced.payload);

    // A later successful install supersedes the failure.
    h.ledger.report(agentReady());
    unwrap(await h.service.install(installRequest(plan)));
    const afterSuccess = h.frames.length;
    unwrap(h.service.replaySignalReport({ sessionId: SESSION_ID, kinds: ['devtools'] }));
    expect(h.frames.slice(afterSuccess).map((frame) => frame.message.type)).toEqual([
      'instrumentation.ready',
    ]);
  });

  it('forgets the report once the session is stopped', async () => {
    const h = createHarness();
    h.ledger.report(agentReady());
    await h.service.install(
      installRequest(buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET])),
    );

    await h.service.stopSession(SESSION_ID);

    expect(
      unwrap(h.service.replaySignalReport({ sessionId: SESSION_ID, kinds: ['devtools'] })),
    ).toBe('nothing-to-replay');
  });

  it('corrects a report installed with no tab once the bind names one and its page reports', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);
    unwrap(await h.service.install(installRequest(plan, { boundTab: undefined })));
    const stale = last(readyFrames(h.frames));
    expect(stale.payload.unavailable.filter(isNoAgentGap).length).toBeGreaterThan(0);
    const framesBefore = h.frames.length;
    const reportsBefore = h.progress.installed.length;

    const waiting = h.ledger.nextWait();
    const replayed = h.service.replaySignalReport({
      sessionId: SESSION_ID,
      boundTab: BOUND_TAB,
      kinds: ['devtools'],
    });

    // The bind is answered at once with the report as held.
    expect(unwrap(replayed)).toBe('replayed');
    const replay = readyFrames(h.frames.slice(framesBefore));
    expect(replay).toHaveLength(1);
    expect(first(replay).kinds).toEqual(['devtools']);
    expect(first(replay).payload).toStrictEqual(stale.payload);

    // The page agent reports while the background refresh waits for it.
    await waiting;
    h.ledger.report(agentReady());
    await until(() => readyFrames(h.frames.slice(framesBefore)).length === 2);
    await until(() => h.progress.installed.length > reportsBefore);

    const corrected = last(readyFrames(h.frames));
    expect(corrected.kinds).toEqual(UI_KINDS);
    expect(corrected.payload.unavailable.filter(isNoAgentGap)).toEqual([]);
    expect(corrected.payload.runtimeHooks).toEqual(expect.arrayContaining(labels));
    const laterRows = rowsOf(h.progress.installed.slice(reportsBefore));
    expect(laterRows.filter((row) => row.status === 'failed')).toEqual([]);
    expect(laterRows.map((row) => row.message).sort()).toEqual([...labels].sort());
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toEqual([]);

    // A second replay now carries the corrected report.
    const afterCorrection = h.frames.length;
    unwrap(h.service.replaySignalReport({ sessionId: SESSION_ID, kinds: ['devtools'] }));
    expect(first(readyFrames(h.frames.slice(afterCorrection))).payload).toStrictEqual(
      corrected.payload,
    );

    // No page-supplied identifier or address reached a log record.
    const logged = JSON.stringify(h.log);
    expect(logged).not.toContain('doc_signalrefresh01');
    expect(logged).not.toContain(APP_ORIGIN);
  });

  it('re-judges the report of an install that was running when the bind named the tab', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);
    const labels = pageLabels(plan);

    // The install starts without a tab; the bind lands while it runs, before
    // it holds a report of its own.
    const installing = h.service.install(installRequest(plan, { boundTab: undefined }));
    expect(
      unwrap(
        h.service.replaySignalReport({
          sessionId: SESSION_ID,
          boundTab: BOUND_TAB,
          kinds: ['devtools'],
        }),
      ),
    ).toBe('nothing-to-replay');
    const waiting = h.ledger.nextWait();
    unwrap(await installing);

    // The install's own report was judged without the tab …
    const stale = last(readyFrames(h.frames));
    expect(stale.payload.unavailable.filter(isNoAgentGap).length).toBeGreaterThan(0);
    const framesBefore = h.frames.length;
    const reportsBefore = h.progress.installed.length;

    // … so once it is over, the report is re-judged against the bound tab,
    // and corrected when that tab's page agent reports.
    await waiting;
    expect(first(h.ledger.waits).afterDocumentId).toBeUndefined();
    h.ledger.report(agentReady());
    await until(() => readyFrames(h.frames.slice(framesBefore)).length === 1);
    await until(() => h.progress.installed.length > reportsBefore);

    const corrected = last(readyFrames(h.frames));
    expect(corrected.kinds).toEqual(UI_KINDS);
    expect(corrected.payload.unavailable.filter(isNoAgentGap)).toEqual([]);
    const laterRows = rowsOf(h.progress.installed.slice(reportsBefore));
    expect(laterRows.filter((row) => row.status === 'failed')).toEqual([]);
    expect(laterRows.map((row) => row.message).sort()).toEqual([...labels].sort());
    expect(h.progress.calls.filter((call) => call === 'readyToCapture')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) A patch-mode adapter is never asked again
// ---------------------------------------------------------------------------

describe('the adapters a refresh asks again', () => {
  it('never re-runs an adapter with a patch-mode action, and keeps its share of the report', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET, PATCH_TARGET]);
    expect(
      plan.instrumentationTargets.some(
        (action) => action.adapter === SERVER_ADAPTER_ID && action.mode === 'patch',
      ),
    ).toBe(true);

    const waiting = h.ledger.nextWait();
    const pending = h.service.install(installRequest(plan, { skipFeasibility: true }));
    await waiting;
    h.ledger.report(agentReady());
    unwrap(await pending);

    expect(h.page.installs).toHaveLength(2);
    expect(last(h.page.installs).browserAgent?.documentId).toBe('doc_signalrefresh01');
    // The installer asks the mixed adapter once per mode group, both times with
    // the install's own page facts: the refresh never asked it again.
    expect(h.server.installs).toHaveLength(2);
    for (const facts of h.server.installs) {
      expect(facts.browserAgent).toBeUndefined();
    }
    const corrected = last(readyFrames(h.frames));
    expect(readyFrames(h.frames)).toHaveLength(2);
    expect(corrected.payload.runtimeHooks).toContain(CAPTURE_SIGNAL_LABELS.pg);
    expect(corrected.payload.unavailable).toEqual([]);
  });

  it('re-runs an adapter whose every action is runtime-mode', async () => {
    const h = createHarness();
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);

    const waiting = h.ledger.nextWait();
    const pending = h.service.install(installRequest(plan));
    await waiting;
    h.ledger.report(agentReady());
    unwrap(await pending);

    expect(h.server.installs).toHaveLength(2);
    // The refresh hands the runtime adapters the same context, with the new page facts.
    const contexts: readonly ObservedReadinessInputs[] = h.server.installs;
    expect(last(contexts).browserAgent?.documentId).toBe('doc_signalrefresh01');
  });

  it('keeps a share whose adapter throws when asked again', async () => {
    const h = createHarness({ throwingPageRefresh: true });
    const plan = buildPlan(h.registry, [...PAGE_TARGETS, DATABASE_TARGET]);

    const waiting = h.ledger.nextWait();
    const pending = h.service.install(installRequest(plan));
    await waiting;
    h.ledger.report(agentReady());
    const outcome = await pending;

    expect(isOk(outcome)).toBe(true);
    expect(h.page.installs).toHaveLength(2);
    // The report is unchanged, so no corrected frame is sent.
    expect(readyFrames(h.frames)).toHaveLength(1);
    expect(
      h.log.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message.startsWith('A runtime adapter could not be asked'),
      ),
    ).toBe(true);
  });
});
