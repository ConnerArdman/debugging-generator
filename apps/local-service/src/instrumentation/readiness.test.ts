/**
 * Tests for `./readiness.ts`: the observed-facts collection every adapter reads
 * and the readiness gate that decides whether a session may enter `ready`.
 *
 * What is on trial, and why it matters:
 *
 * - **Facts are observed, never invented.** An absent page agent or preload is
 *   recorded as absent — never as a report with false flags — and every
 *   collaborator failure degrades to a note instead of an exception
 *   (AAP §0.5.5).
 * - **`satisfied` is load-bearing.** It feeds the state machine's
 *   `instrumenting → ready` guard, so every blocking condition of AAP §0.7.1
 *   Group 2 — no binding, no page agent, a React hook installed after React,
 *   nothing deliverable — is asserted to block, and every degradation of
 *   AAP §0.5.5 — a missing preload, a page without React, an adapter-reported
 *   gap, a failing adapter probe — is asserted not to.
 * - **The relaunch command is the detection's, verbatim.** A remediation that
 *   restated or recomposed the command would drift from what the editor and the
 *   launcher show.
 * - **The reload request is asked once and waited on boundedly**, with exactly
 *   one re-evaluation; a port that never answers cannot hang the gate.
 * - **Adapters are found by claim, not by id**, and asked in registry order.
 *
 * Every collaborator is a fake: no network, no filesystem, no real dev server,
 * and no timer longer than a few milliseconds. The vocabulary is invented and
 * generic — no path, component or route of any real application appears here.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { CodeGraph, CodeQueries, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import {
  buildReadiness,
  createAdapterRegistry,
  type AdapterClaimEntry,
  type BackupStore,
  type CaptureSignal,
  type ClaimingAdapter,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationContext,
  type InstrumentationPlan,
  type ModificationJournal,
  type ObservedReadinessInputs,
  type Readiness,
  type ReadinessSignal,
} from '@debuggen/instrumentation';
import type { AgentReadyPayload, BoundTab, SessionProgressPayload } from '@debuggen/protocol';
import { DebuggenError, isErr, noopLogger, ok, err, type Result } from '@debuggen/shared';

import {
  buildRelaunchHint,
  formatRelaunchCommand,
  type DevServerDetection,
  type detectDevServer,
} from '../dev-server/detect.js';
import type { LaunchedDevServer } from '../dev-server/launcher.js';
import type { SessionProgress } from '../sessions/progress.js';
import {
  DEFAULT_RELOAD_WAIT_MS,
  MAX_RELOAD_WAIT_MS,
  RELOAD_REQUEST_MESSAGE,
  collectObservedReadiness,
  collectReadinessEvidence,
  evaluateReadiness,
  toObservedBrowserAgent,
  type BrowserAgentRegistry,
  type CollectObservedReadinessDeps,
  type EvaluateReadinessDeps,
  type EvaluateReadinessRequest,
  type ReadinessVerdict,
  type ServerAgentReadinessSource,
  type ServerAgentSnapshot,
  type WaitForAgentReadyOptions,
} from './readiness.js';

// ---------------------------------------------------------------------------
// Fixtures: identities and clocks
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_readinesssuite01';
const PROJECT_ROOT = '/work/sample-project';
const TAB_ID = 7;
const NOW = 1_800_000_000_000;
const APP_ORIGIN = 'http://127.0.0.1:4100';
const BOUND_TAB: BoundTab = { tabId: TAB_ID, url: `${APP_ORIGIN}/widgets` };
const SERVICE_CONFIG = { host: '127.0.0.1', port: 20_000 } as const;

const clock = (): number => NOW;

/** A relayed `agent.ready`, healthy unless the case says otherwise. */
function agentReady(overrides: Partial<AgentReadyPayload> = {}): AgentReadyPayload {
  return {
    tabId: TAB_ID,
    documentId: 'doc_first',
    producerId: 'prd_first',
    url: `${APP_ORIGIN}/widgets?page=2#top`,
    installedBeforeReact: true,
    reactDetected: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: the page-agent registry
// ---------------------------------------------------------------------------

interface FakeAgentsInput {
  readonly latest?: AgentReadyPayload;
  /** What the wait resolves with: a report, nothing, or `'never'` for a port that ignores its timeout. */
  readonly next?: AgentReadyPayload | 'never';
  readonly receivedAt?: number;
  readonly throwOnLatest?: boolean;
  readonly rejectWait?: boolean;
}

interface FakeAgents {
  readonly registry: BrowserAgentRegistry;
  readonly waitCalls: { readonly tabId: number; readonly options: WaitForAgentReadyOptions }[];
}

function fakeAgents(input: FakeAgentsInput = {}): FakeAgents {
  const reports = new Map<number, AgentReadyPayload>();

  if (input.latest !== undefined) {
    reports.set(input.latest.tabId, input.latest);
  }

  const waitCalls: FakeAgents['waitCalls'] = [];

  const registry: BrowserAgentRegistry = {
    latestAgentReady(tabId) {
      if (input.throwOnLatest === true) {
        throw new Error('registry unavailable');
      }

      return reports.get(tabId);
    },
    waitForAgentReady(tabId, options) {
      waitCalls.push({ tabId, options });

      if (input.rejectWait === true) {
        return Promise.reject(new Error('wait failed'));
      }

      if (input.next === 'never') {
        return new Promise<AgentReadyPayload | undefined>(() => {
          // A port that ignores its own timeout: never settles.
        });
      }

      if (input.next !== undefined) {
        reports.set(tabId, input.next);
      }

      return Promise.resolve(input.next);
    },
    ...(input.receivedAt === undefined
      ? {}
      : { latestAgentReadyAt: (): number | undefined => input.receivedAt }),
  };

  return { registry, waitCalls };
}

// ---------------------------------------------------------------------------
// Fixtures: the server-agent presence port
// ---------------------------------------------------------------------------

function serverAgents(
  connected: boolean,
  snapshot?: Result<ServerAgentSnapshot, DebuggenError>,
): ServerAgentReadinessSource {
  return {
    hasServerAgentForProject: (root: string): boolean => connected && root === PROJECT_ROOT,
    ...(snapshot === undefined
      ? {}
      : { serverAgentForProject: (): Result<ServerAgentSnapshot, DebuggenError> => snapshot }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures: dev-server detection
// ---------------------------------------------------------------------------

const RELAUNCH_COMMAND =
  'cd /work/sample-project && NODE_OPTIONS="--import file:///opt/preload.mjs" pnpm run dev';

function detection(overrides: Partial<DevServerDetection> = {}): DevServerDetection {
  return {
    projectRoot: PROJECT_ROOT,
    devServerUrl: `${APP_ORIGIN}/`,
    running: true,
    preloadAttached: false,
    preloadReason: 'no-server-agent-connection',
    packageManager: 'pnpm',
    packageManagerSource: 'project-summary',
    relaunchCommand: RELAUNCH_COMMAND,
    relaunchHint: `Stop it, then relaunch it with the preload: ${RELAUNCH_COMMAND}`,
    canLaunch: false,
    notes: [],
    ...overrides,
  };
}

type DetectFn = typeof detectDevServer;

function fakeDetect(result: DevServerDetection | Error = detection()): Mock<DetectFn> {
  return vi.fn<DetectFn>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
}

// ---------------------------------------------------------------------------
// Fixtures: plans and actions
// ---------------------------------------------------------------------------

let actionSequence = 0;

const PATCH_TYPES: readonly InstrumentationActionType[] = ['function-timing', 'server-span'];

function action(type: InstrumentationActionType, adapter: string): InstrumentationAction {
  actionSequence += 1;
  const patch = PATCH_TYPES.includes(type);

  return {
    id: `act_${String(actionSequence).padStart(16, '0')}`,
    file: patch ? 'src/server/handlers.ts' : '.',
    symbol: patch ? `handler${String(actionSequence)}` : '*',
    type,
    adapter,
    mode: patch ? 'patch' : 'runtime',
    rationale: 'Collect the evidence the question needs.',
  };
}

function plan(targets: readonly InstrumentationAction[], planVersion = 1): InstrumentationPlan {
  return {
    version: 1,
    planVersion,
    sessionId: SESSION_ID,
    objective: 'Explain where the time goes.',
    hypotheses: [],
    capture: [],
    instrumentationTargets: [...targets],
  };
}

// ---------------------------------------------------------------------------
// Fixtures: adapters and the registry
// ---------------------------------------------------------------------------

const PAGE_ADAPTER_ID = 'page-signals';
const SERVER_ADAPTER_ID = 'server-signals';

type ReadinessFn = (context: InstrumentationContext) => Promise<Readiness> | Readiness;

function fakeAdapter(
  id: string,
  claims: readonly AdapterClaimEntry[],
  readiness: ReadinessFn,
  canHandle = true,
): ClaimingAdapter & { readonly calls: InstrumentationContext[] } {
  const calls: InstrumentationContext[] = [];

  return {
    id,
    claims,
    calls,
    canHandle: () => canHandle,
    createPlan: () => Promise.resolve([]),
    install: () =>
      Promise.resolve({ adapterId: id, applied: [], runtimeHooks: [], unavailable: [] }),
    remove: () =>
      Promise.resolve({ adapterId: id, restored: [], conflicts: [], runtimeHooksDisabled: [] }),
    readiness: (context) => {
      calls.push(context);
      return Promise.resolve(readiness(context));
    },
  };
}

const PAGE_SIGNALS: readonly CaptureSignal[] = [
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
];

/** A page-tier adapter that reports every signal available whenever a page agent reported. */
function pageAdapter(
  override?: (signal: CaptureSignal) => ReadinessSignal | undefined,
): ReturnType<typeof fakeAdapter> {
  return fakeAdapter(
    PAGE_ADAPTER_ID,
    [
      { type: 'react-render-tracking', mode: 'runtime' },
      { type: 'state-tracking', mode: 'runtime' },
      { type: 'interaction-tracking', mode: 'runtime' },
      { type: 'fetch-tracking', mode: 'runtime' },
      { type: 'perf-tracking', mode: 'runtime' },
    ],
    (context) =>
      buildReadiness({
        adapter: PAGE_ADAPTER_ID,
        signals: PAGE_SIGNALS.map(
          (signal): ReadinessSignal =>
            override?.(signal) ??
            (context.readiness.browserAgent === undefined
              ? {
                  signal,
                  status: 'unavailable',
                  reason: 'adapter: no page agent',
                  hint: 'adapter: open it',
                }
              : { signal, status: 'available' }),
        ),
        now: clock,
      }),
  );
}

/** A server-tier adapter whose rows follow the observed preload connection. */
function serverAdapter(): ReturnType<typeof fakeAdapter> {
  return fakeAdapter(
    SERVER_ADAPTER_ID,
    [
      { type: 'server-span', mode: 'patch' },
      { type: 'function-timing', mode: 'patch' },
    ],
    (context) => {
      const attached = context.readiness.serverAgent?.connected === true;

      return buildReadiness({
        adapter: SERVER_ADAPTER_ID,
        signals: (['http', 'routeHandlers', 'fetch', 'functions'] as const).map(
          (signal): ReadinessSignal =>
            attached
              ? { signal, status: 'available' }
              : {
                  signal,
                  status: 'unavailable',
                  reason: 'adapter: no preload',
                  hint: 'adapter: relaunch',
                },
        ),
        now: clock,
      });
    },
  );
}

function registryOf(...adapters: ClaimingAdapter[]): ReturnType<typeof createAdapterRegistry> {
  return createAdapterRegistry({ adapters });
}

// ---------------------------------------------------------------------------
// Fixtures: context, progress and the evaluation call
// ---------------------------------------------------------------------------

function context(
  readiness: ObservedReadinessInputs = {},
  overrides: Partial<InstrumentationContext> = {},
): InstrumentationContext {
  return {
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    planVersion: 1,
    debuggenHome: '/work/state-home',
    logger: noopLogger,
    graph: {} as unknown as CodeGraph,
    queries: {} as unknown as CodeQueries,
    routeMap: {} as unknown as RouteMap,
    projectSummary: { packageManager: 'pnpm' } as unknown as ProjectSummary,
    journal: {} as unknown as ModificationJournal,
    backups: {} as unknown as BackupStore,
    readiness,
    now: clock,
    ...overrides,
  };
}

interface FakeProgress {
  readonly progress: Pick<SessionProgress, 'emit' | 'readyToCapture'>;
  readonly emit: Mock<SessionProgress['emit']>;
  readonly readyToCapture: Mock<SessionProgress['readyToCapture']>;
}

function fakeProgress(options: { readonly rejectEmit?: boolean } = {}): FakeProgress {
  const emit = vi.fn<SessionProgress['emit']>((sessionId, row) => {
    if (options.rejectEmit === true) {
      return err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'rejected row'));
    }

    const payload: SessionProgressPayload = {
      sessionId,
      stage: row.stage,
      status: row.status,
      message: row.message,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
    };

    return ok(payload);
  });
  const readyToCapture = vi.fn<SessionProgress['readyToCapture']>((sessionId) =>
    ok({ sessionId, stage: 'instrument', status: 'done', message: 'ready' }),
  );

  return { progress: { emit, readyToCapture }, emit, readyToCapture };
}

async function evaluate(
  deps: Partial<EvaluateReadinessDeps> & Pick<EvaluateReadinessDeps, 'adapters' | 'agents'>,
  request: Partial<EvaluateReadinessRequest> & Pick<EvaluateReadinessRequest, 'plan'>,
): Promise<ReadinessVerdict> {
  const result = await evaluateReadiness(
    { now: clock, reloadWaitMs: 20, ...deps },
    { context: context(), ...request },
  );

  if (isErr(result)) {
    throw new Error(`evaluation failed: ${result.error.message}`);
  }

  return result.value;
}

function signalsOf(gaps: readonly { readonly signal: string }[]): string[] {
  return gaps.map((gap) => gap.signal);
}

// ---------------------------------------------------------------------------
// collectReadinessEvidence / collectObservedReadiness
// ---------------------------------------------------------------------------

function collectDeps(
  overrides: Partial<CollectObservedReadinessDeps> = {},
): CollectObservedReadinessDeps {
  return {
    serverAgents: serverAgents(false),
    agents: fakeAgents().registry,
    config: SERVICE_CONFIG,
    detect: fakeDetect(),
    now: clock,
    ...overrides,
  };
}

describe('collectReadinessEvidence — input validation', () => {
  it.each([
    ['an empty session id', { sessionId: '', projectRoot: PROJECT_ROOT }],
    ['an empty project root', { sessionId: SESSION_ID, projectRoot: '  ' }],
    ['a relative project root', { sessionId: SESSION_ID, projectRoot: 'work/sample-project' }],
    [
      'a negative tab id',
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: { tabId: -1, url: 'x' } },
    ],
    [
      'a malformed plan',
      {
        sessionId: SESSION_ID,
        projectRoot: PROJECT_ROOT,
        plan: { instrumentationTargets: 'none' } as unknown as InstrumentationPlan,
      },
    ],
  ])('returns Err for %s', async (_label, request) => {
    const result = await collectReadinessEvidence(collectDeps(), request);

    expect(isErr(result)).toBe(true);
  });

  it('normalises the project root it reports and detects against', async () => {
    const detect = fakeDetect();
    const result = await collectReadinessEvidence(collectDeps({ detect }), {
      sessionId: SESSION_ID,
      projectRoot: `${PROJECT_ROOT}/./`,
    });

    expect(isErr(result)).toBe(false);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).toEqual({
      projectRoot: PROJECT_ROOT,
      devServerUrl: undefined,
    });
  });
});

describe('collectReadinessEvidence — page agent facts', () => {
  it('records the absence of a binding explicitly, never a default report', async () => {
    const result = await collectReadinessEvidence(collectDeps(), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
    });

    if (isErr(result)) throw result.error;
    expect(result.value.observed).toEqual({});
    expect(result.value.observed.browserAgent).toBeUndefined();
    expect(result.value.notes).toContain('No tab is bound to this session.');
  });

  it('converts the current document report, dropping the query and fragment', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({ agents: fakeAgents({ latest: agentReady() }).registry }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: BOUND_TAB },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.browserAgent).toEqual({
      producerId: 'prd_first',
      documentId: 'doc_first',
      url: `${APP_ORIGIN}/widgets`,
      installedBeforeReact: true,
      reactDetected: true,
      observedAt: NOW,
    });
  });

  it('stamps the report with the time it was received when the registry knows it', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({
        agents: fakeAgents({ latest: agentReady(), receivedAt: NOW - 5_000 }).registry,
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: BOUND_TAB },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.browserAgent?.observedAt).toBe(NOW - 5_000);
  });

  it.each([
    ['another origin', agentReady({ url: 'http://127.0.0.1:4999/elsewhere' })],
    ['another tab', agentReady({ tabId: TAB_ID + 1 })],
  ])('ignores a report for %s', async (_label, report) => {
    const registry: BrowserAgentRegistry = {
      latestAgentReady: () => report,
      waitForAgentReady: () => Promise.resolve(undefined),
    };
    const result = await collectReadinessEvidence(collectDeps({ agents: registry }), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      boundTab: BOUND_TAB,
    });

    if (isErr(result)) throw result.error;
    expect(result.value.observed.browserAgent).toBeUndefined();
    expect(result.value.notes.length).toBeGreaterThan(0);
  });

  it('treats a registry that throws as no report, with a note', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({ agents: fakeAgents({ throwOnLatest: true }).registry }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: BOUND_TAB },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.browserAgent).toBeUndefined();
    expect(result.value.notes.join(' ')).toMatch(/could not be read/);
  });
});

describe('collectReadinessEvidence — preload facts and detection', () => {
  it('reports a connected preload with its heartbeat and skips detection', async () => {
    const detect = fakeDetect();
    const result = await collectReadinessEvidence(
      collectDeps({
        detect,
        serverAgents: serverAgents(true, ok({ online: true, lastSeenAt: NOW - 1_000 })),
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.serverAgent).toEqual({
      connected: true,
      projectRoot: PROJECT_ROOT,
      lastHeartbeatAt: NOW - 1_000,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(result.value.devServer).toBeUndefined();
  });

  it('reports a known but offline preload as not connected', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({
        serverAgents: serverAgents(false, ok({ online: false, lastSeenAt: NOW - 9 })),
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.serverAgent).toEqual({
      connected: false,
      projectRoot: PROJECT_ROOT,
      lastHeartbeatAt: NOW - 9,
    });
  });

  it('leaves a preload that never connected absent', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({
        serverAgents: serverAgents(
          false,
          err(new DebuggenError('SERVER_AGENT_NOT_READY', 'none connected')),
        ),
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.serverAgent).toBeUndefined();
  });

  it('treats a presence port that throws as absent, with a note', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({
        serverAgents: {
          hasServerAgentForProject: () => {
            throw new Error('registry down');
          },
        },
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.observed.serverAgent).toBeUndefined();
    expect(result.value.notes.join(' ')).toMatch(/preload presence could not be read/);
  });

  it('keeps the detection, and passes it the service address and the presence port', async () => {
    const detect = fakeDetect();
    const agentsPort = serverAgents(false);
    const result = await collectReadinessEvidence(
      collectDeps({ detect, serverAgents: agentsPort }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, devServerUrl: `${APP_ORIGIN}/` },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.devServer).toEqual(detection());
    const deps = detect.mock.calls[0]?.[1];
    expect(deps?.config).toBe(SERVICE_CONFIG);
    expect(deps?.serverAgents).toBe(agentsPort);
    expect(detect.mock.calls[0]?.[0]).toEqual({
      projectRoot: PROJECT_ROOT,
      devServerUrl: `${APP_ORIGIN}/`,
    });
  });

  it('skips detection for a plan that needs no server signal', async () => {
    const detect = fakeDetect();
    await collectReadinessEvidence(collectDeps({ detect }), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
    });

    expect(detect).not.toHaveBeenCalled();
  });

  it('runs detection for a plan that needs server signals', async () => {
    const detect = fakeDetect();
    await collectReadinessEvidence(collectDeps({ detect }), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      plan: plan([action('db-query-tracking', 'db-one')]),
    });

    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('records a detection that throws as unknown, never as an error', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({ detect: fakeDetect(new Error('probe blew up')) }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.devServer).toBeUndefined();
    expect(result.value.notes.join(' ')).toMatch(/treated as not attached/);
  });

  it('does not detect once the request is aborted', async () => {
    const detect = fakeDetect();
    const controller = new AbortController();
    controller.abort();
    const result = await collectReadinessEvidence(collectDeps({ detect }), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      signal: controller.signal,
    });

    if (isErr(result)) throw result.error;
    expect(detect).not.toHaveBeenCalled();
    expect(result.value.notes.join(' ')).toMatch(/cancelled/);
  });
});

describe('collectReadinessEvidence — launched dev servers', () => {
  function launched(overrides: Partial<LaunchedDevServer>): LaunchedDevServer {
    return {
      projectRoot: PROJECT_ROOT,
      devServerUrl: `${APP_ORIGIN}/`,
      pid: 4242,
      sessionIds: [SESSION_ID],
      startedAt: NOW - 60_000,
      status: 'ready',
      command: 'pnpm run dev',
      ...overrides,
    };
  }

  it('probes the newest live launch for the project when the request names no URL', async () => {
    const detect = fakeDetect();
    const newest = launched({ devServerUrl: 'http://127.0.0.1:4200/', startedAt: NOW - 1_000 });
    const result = await collectReadinessEvidence(
      collectDeps({
        detect,
        devServers: {
          list: () => [
            launched({ status: 'exited', startedAt: NOW, devServerUrl: 'http://127.0.0.1:4300/' }),
            launched({}),
            newest,
            launched({ projectRoot: '/work/other-project', startedAt: NOW }),
          ],
        },
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.launchedDevServer).toBe(newest);
    expect(detect.mock.calls[0]?.[0].devServerUrl).toBe('http://127.0.0.1:4200/');
  });

  it('notes a launcher that cannot be listed and carries on', async () => {
    const result = await collectReadinessEvidence(
      collectDeps({
        devServers: {
          list: () => {
            throw new Error('launcher gone');
          },
        },
      }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.launchedDevServer).toBeUndefined();
    expect(result.value.notes.join(' ')).toMatch(/launched dev servers could not be read/);
  });
});

describe('collectObservedReadiness', () => {
  it('returns exactly the evidence’s observed inputs, deterministically', async () => {
    const deps = collectDeps({
      agents: fakeAgents({ latest: agentReady() }).registry,
      serverAgents: serverAgents(true, ok({ online: true, lastSeenAt: NOW - 3 })),
    });
    const request = { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, boundTab: BOUND_TAB };

    const first = await collectObservedReadiness(deps, request);
    const second = await collectObservedReadiness(deps, request);
    const evidence = await collectReadinessEvidence(deps, request);

    if (isErr(first) || isErr(second) || isErr(evidence)) throw new Error('unexpected Err');
    expect(first.value).toEqual(second.value);
    expect(first.value).toEqual(evidence.value.observed);
    expect(Object.keys(first.value).sort()).toEqual(['browserAgent', 'serverAgent']);
  });

  it('propagates an input error', async () => {
    const result = await collectObservedReadiness(collectDeps(), {
      sessionId: SESSION_ID,
      projectRoot: 'relative/root',
    });

    expect(isErr(result)).toBe(true);
  });
});

describe('toObservedBrowserAgent', () => {
  it('omits a URL that is not http(s) rather than passing it on', () => {
    const observed = toObservedBrowserAgent(agentReady({ url: 'file:///tmp/page.html' }), NOW);

    expect(observed).toEqual({
      producerId: 'prd_first',
      documentId: 'doc_first',
      installedBeforeReact: true,
      reactDetected: true,
      observedAt: NOW,
    });
    expect('url' in observed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateReadiness — input validation
// ---------------------------------------------------------------------------

describe('evaluateReadiness — input validation', () => {
  const deps = (): EvaluateReadinessDeps => ({
    adapters: registryOf(pageAdapter()),
    agents: fakeAgents().registry,
  });

  it('returns Err for a plan of another session', async () => {
    const result = await evaluateReadiness(deps(), {
      context: context(),
      plan: { ...plan([]), sessionId: 'ses_someoneelse0001' },
    });

    expect(isErr(result)).toBe(true);
  });

  it('returns Err for a plan of another plan version', async () => {
    const result = await evaluateReadiness(deps(), { context: context(), plan: plan([], 2) });

    expect(isErr(result)).toBe(true);
  });

  it('returns Err for a context with a relative project root', async () => {
    const result = await evaluateReadiness(deps(), {
      context: context({}, { projectRoot: 'relative/root' }),
      plan: plan([]),
    });

    expect(isErr(result)).toBe(true);
  });

  it('returns Err for a malformed binding', async () => {
    const result = await evaluateReadiness(deps(), {
      context: context(),
      plan: plan([]),
      boundTab: { tabId: 1.5, url: BOUND_TAB.url },
    });

    expect(isErr(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateReadiness — the page gate
// ---------------------------------------------------------------------------

describe('evaluateReadiness — satisfied', () => {
  it('is satisfied when every planned signal is deliverable, and announces it once', async () => {
    const { progress, readyToCapture, emit } = fakeProgress();
    const adapter = pageAdapter();
    const verdict = await evaluate(
      {
        adapters: registryOf(adapter),
        agents: fakeAgents({ latest: agentReady() }).registry,
        progress,
      },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.plannedSignals).toEqual(['interactions', 'react', 'componentTree']);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'react', 'componentTree']);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.degraded).toEqual([]);
    expect(verdict.remediations).toEqual([]);
    expect(verdict.evaluatedAt).toBe(NOW);
    expect(verdict.reloadRequested).toBe(false);
    expect(verdict.perAdapter.map((report) => report.adapterId)).toEqual([PAGE_ADAPTER_ID]);
    expect(readyToCapture).toHaveBeenCalledTimes(1);
    expect(readyToCapture).toHaveBeenCalledWith(SESSION_ID);
    expect(emit).not.toHaveBeenCalled();
  });

  it('hands the adapters the fresh page facts on a copy of the context', async () => {
    const adapter = pageAdapter();
    const original = context();
    await evaluate(
      { adapters: registryOf(adapter), agents: fakeAgents({ latest: agentReady() }).registry },
      {
        context: original,
        plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
      },
    );

    expect(adapter.calls[0]?.readiness.browserAgent?.documentId).toBe('doc_first');
    expect(adapter.calls[0]).not.toBe(original);
    expect(original.readiness).toEqual({});
  });

  it('is plain JSON data', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady() }).registry,
      },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(JSON.parse(JSON.stringify(verdict))).toEqual(verdict);
  });

  it('suppresses the ready row when asked to', async () => {
    const { progress, readyToCapture } = fakeProgress();
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady() }).registry,
        progress,
      },
      {
        plan: plan([action('perf-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
        announceReady: false,
      },
    );

    expect(verdict.satisfied).toBe(true);
    expect(readyToCapture).not.toHaveBeenCalled();
  });
});

describe('evaluateReadiness — blocking page conditions', () => {
  it('blocks without a bound tab and asks for one, without prompting a reload', async () => {
    const { progress, emit, readyToCapture } = fakeProgress();
    const agents = fakeAgents({ latest: agentReady() });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]) },
    );

    expect(verdict.satisfied).toBe(false);
    expect(signalsOf(verdict.blocking)).toEqual(['interactions', 'react', 'componentTree']);
    expect(verdict.blocking[0]?.reason).toBe('no Chrome tab is bound to this session');
    expect(verdict.remediations).toEqual([{ kind: 'bind-tab' }]);
    expect(verdict.observed.browserAgent).toBeUndefined();
    expect(agents.waitCalls).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(readyToCapture).not.toHaveBeenCalled();
  });

  it('asks for a reload when no page agent reported, and re-evaluates once on the new document', async () => {
    const { progress, emit, readyToCapture } = fakeProgress();
    const agents = fakeAgents({ next: agentReady({ documentId: 'doc_second' }) });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress, reloadWaitMs: 50 },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(SESSION_ID);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      stage: 'instrument',
      status: 'running',
      message: RELOAD_REQUEST_MESSAGE,
    });
    expect(agents.waitCalls).toHaveLength(1);
    expect(agents.waitCalls[0]?.tabId).toBe(TAB_ID);
    expect(agents.waitCalls[0]?.options.timeoutMs).toBe(50);
    expect(agents.waitCalls[0]?.options.afterDocumentId).toBeUndefined();
    expect(verdict.reloadRequested).toBe(true);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.observed.browserAgent?.documentId).toBe('doc_second');
    expect(verdict.remediations).toEqual([]);
    expect(readyToCapture).toHaveBeenCalledTimes(1);
  });

  it('blocks React signals when the hook arrived after React, naming the document to replace', async () => {
    const { progress, emit } = fakeProgress();
    const agents = fakeAgents({ latest: agentReady({ installedBeforeReact: false }) });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(false);
    expect(signalsOf(verdict.blocking)).toEqual(['react', 'componentTree']);
    expect(verdict.blocking[0]?.hint).toBe(RELOAD_REQUEST_MESSAGE);
    expect(verdict.deliverableSignals).toEqual(['interactions']);
    expect(verdict.remediations).toEqual([
      { kind: 'reload-page', tabId: TAB_ID, documentId: 'doc_first' },
    ]);
    expect(agents.waitCalls[0]?.options.afterDocumentId).toBe('doc_first');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(verdict.reloadRequested).toBe(true);
  });

  it('asks at most once per document across evaluations sharing a ledger', async () => {
    const { progress, emit } = fakeProgress();
    const ledger = new Set<string>();
    const run = (): Promise<ReadinessVerdict> =>
      evaluate(
        {
          adapters: registryOf(pageAdapter()),
          agents: fakeAgents({ latest: agentReady({ installedBeforeReact: false }) }).registry,
          progress,
          reloadPrompts: ledger,
        },
        { plan: plan([action('state-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
      );

    const first = await run();
    const second = await run();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(first.reloadRequested).toBe(true);
    expect(second.reloadRequested).toBe(false);
    expect(second.satisfied).toBe(false);
    expect(ledger.size).toBe(1);
  });

  it('asks again next time when the reload row could not be sent', async () => {
    const { progress, emit } = fakeProgress({ rejectEmit: true });
    const ledger = new Set<string>();
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady({ installedBeforeReact: false }) }).registry,
        progress,
        reloadPrompts: ledger,
      },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(verdict.reloadRequested).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it('skips the prompt and the wait entirely when the request forbids it', async () => {
    const { progress, emit } = fakeProgress();
    const agents = fakeAgents({ latest: agentReady({ installedBeforeReact: false }) });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress },
      {
        plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
        allowReloadPrompt: false,
      },
    );

    expect(emit).not.toHaveBeenCalled();
    expect(agents.waitCalls).toEqual([]);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations.map((remediation) => remediation.kind)).toEqual(['reload-page']);
  });

  it('does not wait once the request is aborted', async () => {
    const agents = fakeAgents({ latest: agentReady({ installedBeforeReact: false }) });
    const controller = new AbortController();
    controller.abort();
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry },
      {
        plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
        signal: controller.signal,
      },
    );

    expect(agents.waitCalls).toEqual([]);
    expect(verdict.satisfied).toBe(false);
  });

  it('stays bounded when the port never answers', async () => {
    const agents = fakeAgents({ next: 'never' });
    const started = Date.now();
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, reloadWaitMs: 5 },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations).toEqual([{ kind: 'reload-page', tabId: TAB_ID }]);
  });

  it('contains a wait that rejects', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ rejectWait: true }).registry,
      },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(false);
  });

  it('ignores a post-reload report for the same document', async () => {
    const agents = fakeAgents({
      latest: agentReady({ installedBeforeReact: false }),
      next: agentReady({ installedBeforeReact: true }),
    });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(false);
  });
});

describe('evaluateReadiness — page degradations', () => {
  it('does not block non-React browser signals on a late hook', async () => {
    const { progress, emit } = fakeProgress();
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady({ installedBeforeReact: false }) }).registry,
        progress,
      },
      {
        plan: plan([
          action('fetch-tracking', PAGE_ADAPTER_ID),
          action('interaction-tracking', PAGE_ADAPTER_ID),
        ]),
        boundTab: BOUND_TAB,
      },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'fetch']);
    expect(emit).not.toHaveBeenCalled();
  });

  it('degrades, but does not block, React signals on a page without React', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady({ reactDetected: false }) }).registry,
      },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(signalsOf(verdict.degraded)).toEqual(['react', 'componentTree']);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'react', 'componentTree']);
  });

  it('degrades a signal an adapter reports unavailable, in the adapter’s words', async () => {
    const adapter = pageAdapter((signal) =>
      signal === 'perf'
        ? {
            signal,
            status: 'unavailable',
            reason: 'this browser has no such entry type',
            hint: 'use a current Chrome',
          }
        : undefined,
    );
    const verdict = await evaluate(
      { adapters: registryOf(adapter), agents: fakeAgents({ latest: agentReady() }).registry },
      { plan: plan([action('perf-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.degraded).toEqual([
      {
        signal: 'perf',
        reason: 'this browser has no such entry type',
        hint: 'use a current Chrome',
      },
    ]);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'errors']);
  });
});

// ---------------------------------------------------------------------------
// evaluateReadiness — the dev-server preload
// ---------------------------------------------------------------------------

describe('evaluateReadiness — server signals', () => {
  const mixedPlan = (): InstrumentationPlan =>
    plan([
      action('react-render-tracking', PAGE_ADAPTER_ID),
      action('server-span', SERVER_ADAPTER_ID),
    ]);

  it('degrades server signals without a preload, with the detection’s command verbatim', async () => {
    const devServer = detection();
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter(), serverAdapter()),
        agents: fakeAgents({ latest: agentReady() }).registry,
      },
      { plan: mixedPlan(), boundTab: BOUND_TAB, devServer },
    );

    expect(verdict.satisfied).toBe(true);
    expect(signalsOf(verdict.degraded)).toEqual(['http', 'routeHandlers', 'functions']);
    for (const gap of verdict.degraded) {
      expect(gap.hint).toBe(devServer.relaunchHint);
    }
    expect(verdict.remediations).toEqual([
      {
        kind: 'relaunch-dev-server',
        projectRoot: PROJECT_ROOT,
        command: devServer.relaunchCommand,
        hint: devServer.relaunchHint,
      },
    ]);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'react', 'componentTree']);
    expect(verdict.perAdapter.map((report) => report.adapterId)).toEqual([
      PAGE_ADAPTER_ID,
      SERVER_ADAPTER_ID,
    ]);
  });

  it('blocks on a missing preload when the strict reading is requested', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter(), serverAdapter()),
        agents: fakeAgents({ latest: agentReady() }).registry,
      },
      { plan: mixedPlan(), boundTab: BOUND_TAB, devServer: detection(), requireServerAgent: true },
    );

    expect(verdict.satisfied).toBe(false);
    expect(signalsOf(verdict.blocking)).toEqual(['http', 'routeHandlers', 'functions']);
    expect(verdict.degraded).toEqual([]);
  });

  it('blocks a server-only plan that can deliver nothing, formatting the generic command upstream', async () => {
    const verdict = await evaluate(
      { adapters: registryOf(serverAdapter()), agents: fakeAgents().registry },
      { plan: plan([action('server-span', SERVER_ADAPTER_ID)]) },
    );

    const generic = { projectRoot: PROJECT_ROOT, packageManager: 'pnpm' } as const;

    expect(verdict.satisfied).toBe(false);
    expect(verdict.deliverableSignals).toEqual([]);
    expect(signalsOf(verdict.blocking)).toEqual(['http', 'routeHandlers', 'functions']);
    expect(verdict.remediations).toEqual([
      {
        kind: 'relaunch-dev-server',
        projectRoot: PROJECT_ROOT,
        command: formatRelaunchCommand(generic),
        hint: buildRelaunchHint(generic),
      },
    ]);
  });

  it('re-situates a detection that still believes the preload is attached', async () => {
    const devServer = detection({
      preloadAttached: true,
      preloadReason: 'server-agent-connected',
      relaunchHint: 'kept attached',
    });
    const verdict = await evaluate(
      { adapters: registryOf(serverAdapter()), agents: fakeAgents().registry },
      { plan: plan([action('server-span', SERVER_ADAPTER_ID)]), devServer },
    );

    const expectedHint = buildRelaunchHint({
      ...devServer,
      preloadAttached: false,
      preloadReason: 'no-server-agent-connection',
    });

    expect(verdict.remediations).toEqual([
      {
        kind: 'relaunch-dev-server',
        projectRoot: PROJECT_ROOT,
        command: devServer.relaunchCommand,
        hint: expectedHint,
      },
    ]);
    expect(verdict.blocking[0]?.hint).toBe(expectedHint);
  });

  it('delivers server signals from a connected preload for this project', async () => {
    const verdict = await evaluate(
      { adapters: registryOf(serverAdapter()), agents: fakeAgents().registry },
      {
        context: context({ serverAgent: { connected: true, projectRoot: `${PROJECT_ROOT}/` } }),
        plan: plan([action('server-span', SERVER_ADAPTER_ID)]),
      },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.deliverableSignals).toEqual(['http', 'routeHandlers', 'functions']);
    expect(verdict.remediations).toEqual([]);
  });

  it('does not count a preload connected for another project', async () => {
    const verdict = await evaluate(
      { adapters: registryOf(serverAdapter()), agents: fakeAgents().registry },
      {
        context: context({ serverAgent: { connected: true, projectRoot: '/work/other-project' } }),
        plan: plan([action('server-span', SERVER_ADAPTER_ID)]),
      },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations.map((remediation) => remediation.kind)).toEqual([
      'relaunch-dev-server',
    ]);
  });
});

// ---------------------------------------------------------------------------
// evaluateReadiness — adapters
// ---------------------------------------------------------------------------

describe('evaluateReadiness — adapter failures never propagate', () => {
  it('turns a rejected probe into degraded rows carrying the error’s reason and hint', async () => {
    const failing = fakeAdapter(
      PAGE_ADAPTER_ID,
      [{ type: 'fetch-tracking', mode: 'runtime' }],
      () =>
        Promise.reject(
          new DebuggenError('INSTRUMENTATION_UNAVAILABLE', 'probe exploded\nsecond line', {
            hint: 'try the other thing',
          }),
        ),
    );
    const verdict = await evaluate(
      { adapters: registryOf(failing), agents: fakeAgents({ latest: agentReady() }).registry },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.degraded).toEqual([
      { signal: 'interactions', reason: 'probe exploded second line', hint: 'try the other thing' },
      { signal: 'fetch', reason: 'probe exploded second line', hint: 'try the other thing' },
    ]);
    const report = verdict.perAdapter[0]?.readiness;
    expect(report?.adapter).toBe(PAGE_ADAPTER_ID);
    expect(report?.ready).toBe(true);
    expect(report?.signals.every((row) => row.status === 'degraded')).toBe(true);
  });

  it('contains a probe that throws synchronously, with a fallback hint', async () => {
    const failing = fakeAdapter(
      PAGE_ADAPTER_ID,
      [{ type: 'perf-tracking', mode: 'runtime' }],
      () => {
        throw new Error('sync failure');
      },
    );
    const verdict = await evaluate(
      { adapters: registryOf(failing), agents: fakeAgents({ latest: agentReady() }).registry },
      { plan: plan([action('perf-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.degraded[0]?.reason).toBe('sync failure');
    expect(verdict.degraded[0]?.hint.length).toBeGreaterThan(0);
  });

  it('degrades the signals of an adapter that answers an invalid report', async () => {
    const invalid = fakeAdapter(
      PAGE_ADAPTER_ID,
      [{ type: 'fetch-tracking', mode: 'runtime' }],
      () => ({ ready: 'yes' }) as unknown as Readiness,
    );
    const verdict = await evaluate(
      { adapters: registryOf(invalid), agents: fakeAgents({ latest: agentReady() }).registry },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(signalsOf(verdict.degraded)).toEqual(['interactions', 'fetch']);
    expect(verdict.degraded[0]?.reason).toMatch(/does not match the readiness schema/);
  });
});

describe('evaluateReadiness — adapter discovery', () => {
  function databaseAdapter(id: string, canHandle: boolean): ReturnType<typeof fakeAdapter> {
    return fakeAdapter(
      id,
      [{ type: 'db-query-tracking', mode: 'runtime' }],
      () => buildReadiness({ adapter: id, signals: [], now: clock }),
      canHandle,
    );
  }

  it('asks only the applicable claimants of the plan’s action types, in registry order', async () => {
    const first = databaseAdapter('db-one', true);
    const second = databaseAdapter('db-two', true);
    const declining = databaseAdapter('db-three', false);
    const unrelated = pageAdapter();
    const verdict = await evaluate(
      {
        adapters: registryOf(first, unrelated, second, declining),
        agents: fakeAgents().registry,
      },
      {
        context: context({ serverAgent: { connected: true, projectRoot: PROJECT_ROOT } }),
        plan: plan([action('db-query-tracking', 'db-two')]),
      },
    );

    expect(verdict.perAdapter.map((report) => report.adapterId)).toEqual(['db-one', 'db-two']);
    expect(unrelated.calls).toEqual([]);
    expect(declining.calls).toEqual([]);
    expect(verdict.plannedSignals).toEqual(['http', 'routeHandlers', 'prisma', 'pg']);
    expect(verdict.satisfied).toBe(true);
  });

  it('asks the adapter an action was normalised to even when it declines the project', async () => {
    const named = databaseAdapter('db-one', false);
    const verdict = await evaluate(
      { adapters: registryOf(named), agents: fakeAgents().registry },
      {
        context: context({ serverAgent: { connected: true, projectRoot: PROJECT_ROOT } }),
        plan: plan([action('db-query-tracking', 'db-one')]),
      },
    );

    expect(verdict.perAdapter.map((report) => report.adapterId)).toEqual(['db-one']);
    expect(named.calls).toHaveLength(1);
  });
});

describe('evaluateReadiness — edge cases', () => {
  it('is not satisfied by a plan that needs nothing', async () => {
    const { progress, readyToCapture } = fakeProgress();
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: fakeAgents().registry, progress },
      { plan: plan([]) },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.plannedSignals).toEqual([]);
    expect(readyToCapture).not.toHaveBeenCalled();
  });

  it('falls back to the wall clock when the injected clock misbehaves', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady() }).registry,
        now: () => Number.NaN,
      },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(Number.isFinite(verdict.evaluatedAt)).toBe(true);
    expect(verdict.evaluatedAt).toBeGreaterThan(0);
  });

  it('exposes bounded reload-wait constants', () => {
    expect(DEFAULT_RELOAD_WAIT_MS).toBeGreaterThan(0);
    expect(MAX_RELOAD_WAIT_MS).toBeGreaterThanOrEqual(DEFAULT_RELOAD_WAIT_MS);
    expect(RELOAD_REQUEST_MESSAGE).not.toMatch(/[\n\r]/);
  });
});

// ---------------------------------------------------------------------------
// Module boundaries, read off the source
// ---------------------------------------------------------------------------

describe('module boundaries', () => {
  const source = readFileSync(fileURLToPath(new URL('./readiness.ts', import.meta.url)), 'utf8');
  const importSpecifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

  it('imports neither its consumer nor its sibling watcher', () => {
    expect(importSpecifiers).not.toContain('./service.js');
    expect(importSpecifiers).not.toContain('./watcher.js');
  });

  it('imports no concrete adapter', () => {
    expect(importSpecifiers.some((specifier) => specifier?.includes('adapters/'))).toBe(false);
  });

  it('reads no environment, writes to no console and reads no wall clock directly', () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/Date\.now\(/);
  });

  it('has no default export', () => {
    expect(source).not.toMatch(/export default/);
  });
});
