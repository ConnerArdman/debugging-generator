/**
 * Tests for the relaunch hint `./service.ts` shows when the dev server runs
 * without the Debug Generator preload (AAP §0.5.5: "Could not enable ‹signal›:
 * ‹reason›. Continuing with: ‹enabled›." — or, if nothing could be enabled,
 * `instrumentation.failed` — and, if the dev server was not started with the
 * preload, the hint carries the exact relaunch command).
 *
 * What is on trial:
 *
 * - **The detection renders the launcher's preload.** Without an injected
 *   preload path, an install resolves the telemetry preload with the
 *   launcher's `resolvePreloadPath` and hands it to the dev-server detection,
 *   so the relaunch command imports that absolute `file:` URL; an injected
 *   path is forwarded as it is, and a miss or a throw keeps the
 *   `$DEBUGGEN_PRELOAD_URL` reference without failing the install.
 * - **Every surface of a successful install shows the same exact command.**
 *   With the preload missing, each preload gap — server spans, route handlers,
 *   database queries, function timing, and `fetch` when the page arms its own
 *   share — carries the detection's relaunch hint on `instrumentation.ready`,
 *   on its degradation row, on its checklist ✗ row and in the outcome, in
 *   place of the adapter's generic text; a page gap keeps its own hint, and a
 *   connected preload changes nothing.
 * - **A failed install says the preload is missing whichever signal the
 *   installer named.** When nothing could be enabled and any reported gap
 *   depends on the preload, `instrumentation.failed` and the failed row carry
 *   the relaunch hint whole, and "Could not enable Server spans: …" (with the
 *   other preload rows) is reported once, before the failed row.
 *
 * The service runs over recording doubles and the **real** progress emitter,
 * so the asserted rows are exactly what both user interfaces would render. The
 * installer is scripted, the readiness gate and the dev-server detection are
 * the real ones — the detection over an injected probe answer and manifest —
 * and the launcher's preload resolution is the one mocked collaborator, so the
 * preload path is known. No network, no child process, and no filesystem work
 * beyond one empty `mkdtemp` state directory per test.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  buildReadiness,
  createAdapterRegistry,
  normalizePlan,
  type AdapterClaimEntry,
  type AdapterRegistry,
  type AgentHookConfig,
  type AggregateInstallResult,
  type ClaimingAdapter,
  type InstrumentationActionType,
  type InstrumentationPlan,
  type ModificationRecord,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  isMessageOfType,
  type AgentReadyPayload,
  type BoundTab,
  type InstrumentationFailedPayload,
  type InstrumentationReadyPayload,
  type ProtocolMessage,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  ok,
  unwrap,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import {
  RELAUNCH_PLACEHOLDERS,
  detectDevServer,
  type DevServerDetectDeps,
  type DevServerDetection,
} from '../dev-server/detect.js';
import { resolvePreloadPath } from '../dev-server/launcher.js';
import type { SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  STAGE_FAILURE_LOG_MESSAGE,
  authorProductText,
  createSessionProgress,
  isProductAuthoredText,
  publicFailureCopy,
} from '../sessions/progress.js';
import type { AppendProgressInput } from '../store/sessions-repo.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import type { ServerAgentReadinessSource } from './readiness.js';
import {
  createInstrumentationService,
  withDetectedRelaunchHints,
  type CodeAnalysisHandles,
  type InstallPlanFn,
  type InstrumentationDriver,
  type InstrumentationServiceDeps,
} from './service.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// The launcher's preload resolution, mocked so the resolved path is known. The
// rest of the launcher module stays real.
// ---------------------------------------------------------------------------

vi.mock('../dev-server/launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev-server/launcher.js')>();

  return { ...actual, resolvePreloadPath: vi.fn(actual.resolvePreloadPath) };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_relaunchsuite01';
const PROJECT_ROOT = '/work/sample-project';
const TAB_ID = 17;
const NOW = 1_800_000_000_000;
const SERVICE_PORT = 20_272;
const DEV_SERVER_URL = 'http://127.0.0.1:20273/';
const BOUND_TAB: BoundTab = { tabId: TAB_ID, url: `${DEV_SERVER_URL}catalog` };

/** The preload the mocked launcher resolution answers: absolute, invented. */
const PRELOAD_PATH = '/opt/debuggen-suite/telemetry/node/register.mjs';

/** The ingest endpoint the detection renders from the service's address. */
const INGEST_URL = `http://127.0.0.1:${String(SERVICE_PORT)}/telemetry/ingest`;

/** The adapters' own relaunch text: a package specifier the project cannot resolve, no credential. */
const ADAPTER_HINT = `Run "Debug Generator: Launch dev server", which starts this project's dev server with the preload and the ingest credentials already set. To do it by hand: cd ${PROJECT_ROOT} && NODE_OPTIONS="--import @debuggen/telemetry/node/register" pnpm dev.`;

/** The unrunnable import every adapter hint above carries. */
const UNRUNNABLE_IMPORT = '--import @debuggen/telemetry/node/register';

/** The reason a server adapter gives for a missing preload. */
const NO_PRELOAD_REASON =
  'no Debug Generator preload is attached to the dev server for this project, so the framework produces no spans to collect';

/** A page signal's gap, which no preload closes, with its own next step. */
const PAGE_GAP: UnavailableSignal = {
  signal: 'errors',
  reason: 'the page error listener was withheld',
  hint: 'Reload the sample page once, then plan the instrumentation again',
};

/** The installer's gaps on a plain dev server with a bound tab, in its report order. */
function tabBoundGaps(): UnavailableSignal[] {
  return [
    {
      signal: 'prisma',
      reason: `the dev server for ${PROJECT_ROOT} is not running with the Debug Generator Node preload, so Prisma query spans cannot be produced`,
      hint: `Relaunch the dev server with the preload attached: cd ${PROJECT_ROOT} && NODE_OPTIONS="--import @debuggen/telemetry/node/register" pnpm run dev`,
    },
    { signal: 'http', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'routeHandlers', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'fetch', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    {
      signal: 'functions',
      reason:
        'no Debug Generator preload is attached to the dev server for this project, so nothing would receive a function span and no file was modified',
      hint: ADAPTER_HINT,
    },
    { ...PAGE_GAP },
  ];
}

/** The page's share of a gap-free page: every hook the capture arms. */
const PAGE_HOOKS: AgentHookConfig = {
  interactions: true,
  react: true,
  state: false,
  fetch: true,
  perf: false,
  errors: false,
  componentTree: true,
};

/** A successful install on a plain dev server: page hooks armed, every server signal a gap. */
function tabBoundResult(plan: InstrumentationPlan): AggregateInstallResult {
  return {
    applied: [],
    runtimeHooks: [
      CAPTURE_SIGNAL_LABELS.interactions,
      CAPTURE_SIGNAL_LABELS.react,
      CAPTURE_SIGNAL_LABELS.fetch,
    ],
    unavailable: tabBoundGaps(),
    agentHooks: { ...PAGE_HOOKS },
    serverSignals: { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] },
    perAdapter: [],
    planVersion: plan.planVersion,
  };
}

/** The page adapter's hint when no tab is bound: an adapter's words, never proven. */
const NO_TAB_HINT = 'Open DevTools on the sample page with the Debug Generator panel, then retry';

/**
 * The installer's "nothing could be enabled" failure with no tab bound, shaped
 * as `nothingEnabledError` builds it: the first gap with a hint is the page's,
 * so the blocked signal is `react`, and every gap is listed in the details.
 */
function noTabFailure(listed: readonly UnavailableSignal[]): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_UNAVAILABLE',
    'No instrumentation could be enabled for this plan: no runtime hook was armed and no file was modified. Could not enable react: no tab is bound.',
    {
      hint: NO_TAB_HINT,
      details: {
        sessionId: SESSION_ID,
        planVersion: 1,
        blockedSignal: 'react',
        unavailable: listed.map((gap) => ({ ...gap })),
        unavailableCount: listed.length,
      },
    },
  );
}

/** Every gap of a plain dev server with no tab bound. */
function noTabGaps(): UnavailableSignal[] {
  return [
    { signal: 'react', reason: 'no tab is bound to this session', hint: NO_TAB_HINT },
    { signal: 'interactions', reason: 'no tab is bound to this session', hint: NO_TAB_HINT },
    ...tabBoundGaps().filter((gap) => gap.signal !== PAGE_GAP.signal),
  ];
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

function recordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (extra) => recordingLogger(entries, { ...bindings, ...extra }),
  };
}

/** One thing the user interfaces were sent, in send order: a frame, or a stored progress row. */
type Sent =
  | { readonly kind: 'frame'; readonly message: ProtocolMessage }
  | { readonly kind: 'row'; readonly row: AppendProgressInput };

/** A journal that holds nothing; no install here writes through it. */
function emptyJournal(): ModificationsRepo {
  const refused = (): Promise<Result<never>> =>
    Promise.resolve(err(new DebuggenError('STORE_ERROR', 'This suite’s journal takes no write.')));
  const none = (): Promise<Result<ModificationRecord[]>> => Promise.resolve(ok([]));

  return {
    append: refused,
    updateStatus: refused,
    deleteBySession: refused,
    listBySession: none,
    listOpen: none,
    listAllOpen: none,
    listByFile: none,
    listChain: none,
    listConflicts: none,
    listPageBySession: () => Promise.resolve(ok({ records: [], total: 0 })),
    get: () => Promise.resolve(ok(undefined)),
    latestRecordForFile: () => Promise.resolve(ok(undefined)),
    listBackupPaths: () => Promise.resolve(ok([])),
    countBySession: () => Promise.resolve(ok(0)),
  };
}

function idleWatcher(): InstrumentationWatcher {
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

function healthyAgentReady(): AgentReadyPayload {
  return {
    tabId: TAB_ID,
    documentId: 'doc_relaunchsuite1',
    producerId: 'prd_relaunchsuite1',
    url: BOUND_TAB.url,
    installedBeforeReact: true,
    reactDetected: true,
  };
}

/** No preload ever connects for the project: a plain `next dev`. */
const ABSENT_PRELOAD: ServerAgentReadinessSource = { hasServerAgentForProject: () => false };

/** The project's preload is connected and online. */
const CONNECTED_PRELOAD: ServerAgentReadinessSource = {
  hasServerAgentForProject: (projectRoot) => projectRoot === PROJECT_ROOT,
  serverAgentForProject: (projectRoot) =>
    ok({ online: true, lastSeenAt: NOW, connectedAt: NOW, projectRoot }),
};

/**
 * The detection's own ports: the dev server answers with the Next.js
 * signature, and the manifest declares a `next dev` script run with pnpm.
 */
const DETECTION_PORTS: Omit<DevServerDetectDeps, 'config' | 'logger' | 'serverAgents' | 'now'> = {
  fetchImpl: () =>
    Promise.resolve({
      status: 200,
      headers: { get: (name: string) => (name === 'x-powered-by' ? 'Next.js' : null) },
    }),
  readManifest: () =>
    JSON.stringify({
      name: 'sample-project',
      scripts: { dev: 'next dev' },
      dependencies: { next: '16.0.0' },
    }),
  resolvePackageManager: () => 'pnpm',
};

function fakeAdapter(id: string, claims: readonly AdapterClaimEntry[]): ClaimingAdapter {
  return {
    id,
    claims,
    canHandle: () => true,
    createPlan: () => Promise.resolve([]),
    install: () =>
      Promise.resolve({ adapterId: id, applied: [], runtimeHooks: [], unavailable: [] }),
    remove: () =>
      Promise.resolve({ adapterId: id, restored: [], conflicts: [], runtimeHooksDisabled: [] }),
    readiness: () => Promise.resolve(buildReadiness({ adapter: id, signals: [], now: () => NOW })),
  };
}

function fakeRegistry(): AdapterRegistry {
  return createAdapterRegistry({
    adapters: [
      fakeAdapter('sample-page-relaunch', [
        { type: 'interaction-tracking', mode: 'runtime' },
        { type: 'react-render-tracking', mode: 'runtime' },
        { type: 'fetch-tracking', mode: 'runtime' },
      ]),
      fakeAdapter('sample-server-relaunch', [
        { type: 'function-timing', mode: 'patch' },
        { type: 'server-span', mode: 'patch' },
        { type: 'db-query-tracking', mode: 'runtime' },
      ]),
    ],
  });
}

const TARGETS: readonly {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}[] = [
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'react-render-tracking' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'fetch-tracking' },
  { file: 'src/server/sample-ledger.ts', symbol: 'settleSampleLedger', type: 'function-timing' },
  { file: 'src/routes/sample/handler.ts', symbol: 'POST', type: 'server-span' },
  { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'db-query-tracking' },
];

/** Placeholder code-analysis handles: the scripted installer and the fakes never read them. */
const CODE_HANDLES: CodeAnalysisHandles = {
  graph: { tag: 'graph' } as unknown as CodeAnalysisHandles['graph'],
  queries: { tag: 'queries' } as unknown as CodeAnalysisHandles['queries'],
  routeMap: { tag: 'routeMap' } as unknown as CodeAnalysisHandles['routeMap'],
  summary: { tag: 'summary' } as unknown as CodeAnalysisHandles['summary'],
};

let actionCounter = 0;

function buildPlan(registry: AdapterRegistry): InstrumentationPlan {
  return unwrap(
    normalizePlan(
      {
        objective: 'Find where the time goes when the sample ledger saves',
        capture: ['click timing', 'renders', 'requests', 'server spans', 'database queries'],
        instrumentationTargets: TARGETS.map((target) => ({ ...target })),
      },
      {
        sessionId: SESSION_ID,
        planVersion: 1,
        resolver: registry,
        newActionId: () => {
          actionCounter += 1;
          return `act_${String(actionCounter).padStart(16, '0')}`;
        },
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: InstrumentationDriver;
  readonly plan: InstrumentationPlan;
  readonly sent: Sent[];
  readonly log: LogEntry[];
  /** Every detection readiness ran, with the collaborators it was handed. */
  readonly detections: {
    readonly detection: DevServerDetection;
    readonly deps: DevServerDetectDeps;
  }[];
}

interface HarnessOptions {
  readonly script: (plan: InstrumentationPlan) => Result<AggregateInstallResult>;
  readonly serverAgents?: ServerAgentReadinessSource;
  readonly detectDeps?: InstrumentationServiceDeps['detectDeps'];
}

const homes: string[] = [];

function createHarness(options: HarnessOptions): Harness {
  const home = mkdtempSync(join(tmpdir(), 'debuggen-relaunch-hint-'));
  homes.push(home);

  const sent: Sent[] = [];
  const log: LogEntry[] = [];
  const logger = recordingLogger(log);
  const detections: Harness['detections'] = [];
  const registry = fakeRegistry();
  const plan = buildPlan(registry);
  const broadcaster: SessionBroadcaster = {
    broadcast: (_sessionId, message) => {
      sent.push({ kind: 'frame', message });
    },
    broadcastToKinds: (_sessionId, _kinds, message) => {
      sent.push({ kind: 'frame', message });
    },
  };
  const progress = createSessionProgress({
    sessions: {
      appendProgress: (row) => {
        sent.push({ kind: 'row', row });
        return ok(undefined);
      },
    },
    // The frames of the rows are the stored rows' twins; only the rows are kept.
    broadcaster: { broadcastToKinds: () => undefined },
    logger,
    now: () => NOW,
    newRef: () => 'ref_relaunchsuite1',
  });
  const config: ServiceConfig = {
    host: '127.0.0.1',
    port: SERVICE_PORT,
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
  const installer: InstallPlanFn = (installing) => Promise.resolve(options.script(installing));

  const service = createInstrumentationService({
    config,
    logger,
    modifications: emptyJournal(),
    progress,
    broadcaster,
    agentChannel: { sendToBoundTab: () => ok(1) },
    serverAgentChannel: { sendToServerAgent: () => ok(1) },
    watcher: idleWatcher(),
    agents: {
      latestAgentReady: ({ tabId }) => (tabId === TAB_ID ? healthyAgentReady() : undefined),
      waitForAgentReady: () => Promise.resolve(undefined),
      latestAgentReadyAt: () => NOW,
    },
    serverAgents: options.serverAgents ?? ABSENT_PRELOAD,
    adapters: registry,
    installer,
    detectDevServer: async (input, detectDeps) => {
      const detection = await detectDevServer(input, detectDeps);
      detections.push({ detection, deps: detectDeps ?? {} });
      return detection;
    },
    detectDeps: options.detectDeps ?? DETECTION_PORTS,
    reloadWaitMs: 0,
    now: () => NOW,
  });

  return { service, plan, sent, log, detections };
}

function install(
  h: Harness,
  overrides: {
    readonly boundTab?: BoundTab | undefined;
    readonly reportStageFailure?: boolean;
  } = {},
): ReturnType<InstrumentationDriver['install']> {
  return h.service.install({
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    plan: h.plan,
    code: CODE_HANDLES,
    boundTab: 'boundTab' in overrides ? overrides.boundTab : BOUND_TAB,
    devServerUrl: DEV_SERVER_URL,
    allowReloadPrompt: false,
    ...(overrides.reportStageFailure === undefined
      ? {}
      : { reportStageFailure: overrides.reportStageFailure }),
  });
}

/** The one detection the install ran. */
function onlyDetection(h: Harness): Harness['detections'][number] {
  expect(h.detections).toHaveLength(1);
  return h.detections[0]!;
}

/** The progress rows the install stored, in order. */
function rowsOf(h: Harness): AppendProgressInput[] {
  return h.sent.flatMap((entry) => (entry.kind === 'row' ? [entry.row] : []));
}

/** The frames the install sent, in order. */
function framesOf(h: Harness): ProtocolMessage[] {
  return h.sent.flatMap((entry) => (entry.kind === 'frame' ? [entry.message] : []));
}

/** The payload of the one `instrumentation.ready` frame the install sent. */
function onlyReady(h: Harness): InstrumentationReadyPayload {
  const frames = framesOf(h).filter((message) => isMessageOfType(message, 'instrumentation.ready'));
  expect(frames).toHaveLength(1);
  const frame = frames[0];

  if (frame === undefined || !isMessageOfType(frame, 'instrumentation.ready')) {
    throw new Error('expected one instrumentation.ready frame');
  }

  return frame.payload;
}

/** The payload of the one `instrumentation.failed` frame the install sent. */
function onlyFailed(h: Harness): InstrumentationFailedPayload {
  const frames = framesOf(h).filter((message) =>
    isMessageOfType(message, 'instrumentation.failed'),
  );
  expect(frames).toHaveLength(1);
  const frame = frames[0];

  if (frame === undefined || !isMessageOfType(frame, 'instrumentation.failed')) {
    throw new Error('expected one instrumentation.failed frame');
  }

  return frame.payload;
}

beforeEach(() => {
  actionCounter = 0;
  vi.mocked(resolvePreloadPath).mockReset();
  vi.mocked(resolvePreloadPath).mockImplementation(() => ok(PRELOAD_PATH));
});

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The preload the detection renders
// ---------------------------------------------------------------------------

describe('the preload path handed to the dev-server detection', () => {
  it('resolves the launcher’s preload when none is injected, so the command imports its file URL', async () => {
    const h = createHarness({ script: (plan) => ok(tabBoundResult(plan)) });

    await install(h);

    const { detection, deps } = onlyDetection(h);
    expect(vi.mocked(resolvePreloadPath)).toHaveBeenCalledTimes(1);
    expect(deps.preloadPath).toBe(PRELOAD_PATH);
    // The injected ports travel with it, unchanged.
    expect(deps.fetchImpl).toBe(DETECTION_PORTS.fetchImpl);
    expect(detection.preloadAttached).toBe(false);
    expect(detection.relaunchCommand).toBe(
      `cd ${PROJECT_ROOT} && NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import ${pathToFileURL(PRELOAD_PATH).href}" DEBUGGEN_INGEST_URL=${INGEST_URL} DEBUGGEN_PROJECT_ROOT=${PROJECT_ROOT} DEBUGGEN_TOKEN="$DEBUGGEN_TOKEN" pnpm run dev`,
    );
    expect(detection.relaunchHint).toContain(detection.relaunchCommand);
    expect(detection.relaunchHint).not.toContain(RELAUNCH_PLACEHOLDERS.preloadUrl);
    expect(isProductAuthoredText(detection.relaunchHint)).toBe(true);
  });

  it('forwards an injected preload path as it is, without resolving another', async () => {
    const injected = '/srv/debuggen-injected/register.mjs';
    const h = createHarness({
      script: (plan) => ok(tabBoundResult(plan)),
      detectDeps: { ...DETECTION_PORTS, preloadPath: injected },
    });

    await install(h);

    expect(vi.mocked(resolvePreloadPath)).not.toHaveBeenCalled();
    const { detection, deps } = onlyDetection(h);
    expect(deps.preloadPath).toBe(injected);
    expect(detection.relaunchCommand).toContain(`--import ${pathToFileURL(injected).href}"`);
  });

  it('keeps the preload reference when no preload is found or resolution throws, and still installs', async () => {
    const answers: readonly (() => ReturnType<typeof resolvePreloadPath>)[] = [
      () =>
        err(
          new DebuggenError('INSTRUMENTATION_UNAVAILABLE', 'The telemetry preload was not found.', {
            details: { reason: 'preload-not-found' },
          }),
        ),
      () => {
        throw new Error('the resolver is unavailable');
      },
    ];

    for (const answer of answers) {
      vi.mocked(resolvePreloadPath).mockImplementation(answer);
      const h = createHarness({ script: (plan) => ok(tabBoundResult(plan)) });

      const outcome = await install(h);

      expect(isErr(outcome)).toBe(false);
      const { detection, deps } = onlyDetection(h);
      expect(deps.preloadPath).toBeUndefined();
      expect(detection.relaunchCommand).toContain(`--import ${RELAUNCH_PLACEHOLDERS.preloadUrl}"`);
      expect(
        h.log.some(
          (entry) =>
            entry.level === 'debug' &&
            entry.message.endsWith('the relaunch command keeps its preload reference'),
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// A successful install on a plain dev server (INT-F05)
// ---------------------------------------------------------------------------

describe('a successful install without the preload', () => {
  it('shows the detection’s exact relaunch command for every preload gap, on every surface', async () => {
    const h = createHarness({ script: (plan) => ok(tabBoundResult(plan)) });

    const outcome = unwrap(await install(h));

    const { detection } = onlyDetection(h);
    const relaunch = detection.relaunchHint;
    const preloadGaps = ['prisma', 'http', 'routeHandlers', 'fetch', 'functions'];

    // instrumentation.ready: each preload gap keeps its signal and reason and
    // carries the relaunch hint; the page gap keeps its own hint.
    const ready = onlyReady(h);
    expect(ready.unavailable).toStrictEqual(
      tabBoundGaps().map((gap) =>
        preloadGaps.includes(gap.signal) ? { ...gap, hint: relaunch } : gap,
      ),
    );
    expect(outcome.unavailable).toStrictEqual(ready.unavailable);

    // Each degradation is one terminal ✗ row — no `running` twin — and it
    // carries the same command.
    const rows = rowsOf(h);
    for (const signal of ['http', 'prisma', 'functions', 'fetch'] as const) {
      const label = CAPTURE_SIGNAL_LABELS[signal];
      const spinning = rows.filter(
        (row) => row.status === 'running' && row.message.startsWith(`Could not enable ${label}: `),
      );
      const failed = rows.filter(
        (row) => row.status === 'failed' && row.message.startsWith(`Could not enable ${label}: `),
      );

      expect(spinning, `${label} running degradation row`).toEqual([]);
      expect(failed.length, `${label} ✗ row`).toBeGreaterThan(0);
      for (const row of failed) {
        expect(row.detail, row.message).toBe(relaunch);
      }
    }

    const pageRows = rows.filter((row) =>
      row.message.startsWith(`Could not enable ${CAPTURE_SIGNAL_LABELS.errors}: `),
    );
    expect(pageRows.length).toBeGreaterThan(0);
    for (const row of pageRows) {
      expect(row.detail).toBe(PAGE_GAP.hint);
    }

    // The adapters' unrunnable import reaches no surface at all.
    expect(JSON.stringify(h.sent)).not.toContain(UNRUNNABLE_IMPORT);
    expect(JSON.stringify(outcome)).not.toContain(UNRUNNABLE_IMPORT);
  });

  it('leaves every hint as the installer reported it while the preload is connected', async () => {
    const h = createHarness({
      script: (plan) => ok(tabBoundResult(plan)),
      serverAgents: CONNECTED_PRELOAD,
    });

    const outcome = unwrap(await install(h));

    // A connected preload needs no detection, so there is no relaunch hint to use.
    expect(h.detections).toHaveLength(0);
    expect(onlyReady(h).unavailable).toStrictEqual(tabBoundGaps());
    expect(outcome.unavailable).toStrictEqual(tabBoundGaps());
  });
});

// ---------------------------------------------------------------------------
// Nothing could be enabled on a plain dev server (OBS-F09)
// ---------------------------------------------------------------------------

describe('a failed install without the preload', () => {
  it('carries the relaunch hint and reports the Server spans row first, whichever signal was blocked', async () => {
    const error = noTabFailure(noTabGaps());
    const h = createHarness({ script: () => err(error) });

    const outcome = await install(h, { boundTab: undefined });

    const { detection } = onlyDetection(h);
    const relaunch = detection.relaunchHint;
    expect(detection.preloadAttached).toBe(false);
    expect(isProductAuthoredText(relaunch)).toBe(true);

    // The frame and the returned error name the exact command, not the page's hint.
    const failed = onlyFailed(h);
    expect(failed.error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(failed.error.hint).toBe(relaunch);
    expect(isErr(outcome) && outcome.error.hint).toBe(relaunch);

    // The ✗ rows of the preload gaps, once each, then the failed row — whose
    // detail holds the whole relaunch hint before its code and reference.
    const rows = rowsOf(h);
    const copy = publicFailureCopy('instrument', 'INSTRUMENTATION_UNAVAILABLE');
    const failedRow = rows.findIndex((row) => row.message === copy.message);
    const gapRows = rows.filter(
      (row) => row.status === 'failed' && row.message.startsWith('Could not enable '),
    );
    expect(gapRows.map((row) => row.message)).toEqual([
      `Could not enable ${CAPTURE_SIGNAL_LABELS.http}: no dev-server preload is attached for this project. Continuing with: no confirmed signal.`,
      `Could not enable ${CAPTURE_SIGNAL_LABELS.prisma}: no dev-server preload is attached for this project. Continuing with: no confirmed signal.`,
      `Could not enable ${CAPTURE_SIGNAL_LABELS.functions}: no dev-server preload is attached for this project. Continuing with: no confirmed signal.`,
    ]);
    for (const row of gapRows) {
      expect(row.detail).toBe(relaunch);
      expect(rows.indexOf(row)).toBeLessThan(failedRow);
    }
    expect(rows[failedRow]?.status).toBe('failed');
    expect(rows[failedRow]?.detail).toBe(
      `${relaunch} (error code: INSTRUMENTATION_UNAVAILABLE, ref: ref_relaunchsuite1)`,
    );

    // The rows precede the frame, which precedes nothing else of the stage.
    const serverSpansRow = h.sent.findIndex(
      (entry) => entry.kind === 'row' && entry.row.message.includes(CAPTURE_SIGNAL_LABELS.http),
    );
    const failedFrame = h.sent.findIndex(
      (entry) => entry.kind === 'frame' && entry.message.type === 'instrumentation.failed',
    );
    expect(serverSpansRow).toBeGreaterThan(-1);
    expect(serverSpansRow).toBeLessThan(failedFrame);

    // The progress emitter showed the failure's own hint, and the service log
    // names the preload gaps it reported.
    const filed = h.log.filter((entry) => entry.message === STAGE_FAILURE_LOG_MESSAGE);
    expect(filed.map((entry) => entry.fields['hintSource'])).toEqual(['failure']);
    const warned = h.log.filter((entry) => entry.message === 'The instrumentation install failed');
    expect(warned.map((entry) => entry.fields['preloadGapSignals'])).toEqual([
      ['http', 'routeHandlers', 'prisma', 'functions'],
    ]);
    expect(JSON.stringify(h.sent)).not.toContain(UNRUNNABLE_IMPORT);
    expect(JSON.stringify(h.sent)).not.toContain(NO_TAB_HINT);
  });

  it('leaves the failed row to its caller but still reports the preload rows, and the caller’s row keeps the whole hint', async () => {
    const h = createHarness({ script: () => err(noTabFailure(noTabGaps())) });

    const outcome = await install(h, { boundTab: undefined, reportStageFailure: false });

    const relaunch = onlyDetection(h).detection.relaunchHint;
    const rows = rowsOf(h);
    expect(rows.filter((row) => row.status === 'failed').map((row) => row.detail)).toEqual([
      relaunch,
      relaunch,
      relaunch,
    ]);

    // What the session manager files from the returned error, as the pipeline does.
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      const probe: AppendProgressInput[] = [];
      createSessionProgress({
        sessions: {
          appendProgress: (row) => {
            probe.push(row);
            return ok(undefined);
          },
        },
        broadcaster: { broadcastToKinds: () => undefined },
        newRef: () => 'ref_relaunchsuite2',
      }).stageFailed(SESSION_ID, {
        stage: 'instrument',
        code: outcome.error.code,
        message: outcome.error.message,
        ...(outcome.error.hint === undefined ? {} : { hint: outcome.error.hint }),
      });
      expect(probe.map((row) => row.detail)).toEqual([
        `${relaunch} (error code: INSTRUMENTATION_UNAVAILABLE, ref: ref_relaunchsuite2)`,
      ]);
    }
  });

  it('names the relaunch command when only a listed gap depends on the preload', async () => {
    // The blocked signal is the page's, and the one preload gap is listed only.
    const h = createHarness({
      script: () =>
        err(
          noTabFailure([
            { signal: 'react', reason: 'no tab is bound to this session', hint: NO_TAB_HINT },
            { signal: 'pg', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
          ]),
        ),
    });

    await install(h, { boundTab: undefined });

    const relaunch = onlyDetection(h).detection.relaunchHint;
    expect(onlyFailed(h).error.hint).toBe(relaunch);
    expect(
      rowsOf(h)
        .filter((row) => row.message.startsWith('Could not enable '))
        .map((row) => [row.message, row.detail]),
    ).toEqual([
      [
        `Could not enable ${CAPTURE_SIGNAL_LABELS.pg}: no dev-server preload is attached for this project. Continuing with: no confirmed signal.`,
        relaunch,
      ],
    ]);
  });

  it('keeps the code’s copy and reports no preload row when no gap depends on the preload', async () => {
    const malformed = new DebuggenError(
      'INSTRUMENTATION_UNAVAILABLE',
      'No instrumentation could be enabled for this plan.',
      {
        hint: NO_TAB_HINT,
        // A foreign installer's details: no preload gap in any readable shape.
        details: {
          blockedSignal: 'react',
          unavailable: [null, 'http', { reason: 'no signal' }, { signal: ['prisma'] }],
        },
      },
    );
    const h = createHarness({ script: () => err(malformed) });

    await install(h, { boundTab: undefined });

    const copy = publicFailureCopy('instrument', 'INSTRUMENTATION_UNAVAILABLE');
    expect(onlyFailed(h).error.hint).toBe(copy.hint);
    expect(rowsOf(h).filter((row) => row.message.startsWith('Could not enable '))).toEqual([]);
  });

  it('leaves a failure of another code as it is', async () => {
    const h = createHarness({
      script: () =>
        err(
          new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', 'The sample adapter failed.', {
            details: { blockedSignal: 'http' },
          }),
        ),
    });

    await install(h, { boundTab: undefined });

    const copy = publicFailureCopy('instrument', 'INSTRUMENTATION_INSTALL_FAILED');
    expect(onlyFailed(h).error.hint).toBe(copy.hint);
    expect(rowsOf(h).filter((row) => row.message.startsWith('Could not enable '))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The substitution rule itself
// ---------------------------------------------------------------------------

describe('withDetectedRelaunchHints', () => {
  const relaunch = authorProductText(
    `Start it by hand: cd ${PROJECT_ROOT} && NODE_OPTIONS="--import ${pathToFileURL(PRELOAD_PATH).href}" pnpm run dev`,
  );
  const missing = { preloadAttached: false, relaunchHint: relaunch } as const;
  const gaps: readonly UnavailableSignal[] = [
    { signal: 'http', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'routeHandlers', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'prisma', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'pg', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'functions', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    { signal: 'fetch', reason: NO_PRELOAD_REASON, hint: ADAPTER_HINT },
    PAGE_GAP,
    { signal: 'sample-third-party', reason: 'not supported here', hint: 'Use the sample tool' },
  ];

  it('gives each preload-only gap the relaunch hint, keeping signal and reason', () => {
    const rewritten = withDetectedRelaunchHints(gaps, missing, DORMANT_AGENT_HOOK_CONFIG);

    expect(rewritten.map((gap) => [gap.signal, gap.reason, gap.hint])).toEqual(
      gaps.map((gap) => [
        gap.signal,
        gap.reason,
        ['http', 'routeHandlers', 'prisma', 'pg', 'functions'].includes(gap.signal)
          ? relaunch
          : gap.hint,
      ]),
    );
    expect(Object.isFrozen(rewritten)).toBe(true);
  });

  it('claims a shared signal for the preload only when the page arms its own share', () => {
    const fetchHint = (hooks: AgentHookConfig): string | undefined =>
      withDetectedRelaunchHints(gaps, missing, hooks).find((gap) => gap.signal === 'fetch')?.hint;

    expect(fetchHint(DORMANT_AGENT_HOOK_CONFIG)).toBe(ADAPTER_HINT);
    expect(fetchHint({ ...DORMANT_AGENT_HOOK_CONFIG, interactions: true, fetch: true })).toBe(
      relaunch,
    );
  });

  it('returns the list itself for an attached preload, no detection, or an unproven hint', () => {
    const unproven = { preloadAttached: false, relaunchHint: `${relaunch} (not registered)` };

    for (const devServer of [
      { preloadAttached: true, relaunchHint: relaunch },
      undefined,
      unproven,
    ]) {
      expect(withDetectedRelaunchHints(gaps, devServer, PAGE_HOOKS)).toBe(gaps);
    }
  });

  it('returns the list itself when every preload gap already carries the relaunch hint', () => {
    const settled = withDetectedRelaunchHints(gaps, missing, PAGE_HOOKS);

    expect(withDetectedRelaunchHints(settled, missing, PAGE_HOOKS)).toBe(settled);
  });
});
