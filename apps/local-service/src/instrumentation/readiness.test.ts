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
 * - **Adapters are found by claim, not by id**, and asked in registry order;
 *   the planned signals come from the upstream derivations, never from a
 *   mapping restated here.
 * - **It writes nothing.** The context every evaluation receives carries a
 *   journal and a backup store that throw on any touch, and every touch is
 *   recorded and failed after each test.
 *
 * Every collaborator is an injected fake: no network, no filesystem, no child
 * process, no real dev server, and no real wait beyond a few milliseconds —
 * the bounded reload wait is driven by fake timers. The vocabulary is invented
 * and generic — no path, component or route of any real application appears
 * here — and the one token-shaped value is assembled at run time from harmless
 * parts.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { CodeGraph, CodeQueries, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import {
  ADAPTER_IDS,
  CAPTURE_SIGNALS,
  buildReadiness,
  createAdapterRegistry,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  type AdapterClaimEntry,
  type BackupStore,
  type CaptureSignal,
  type ClaimingAdapter,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationContext,
  type InstrumentationPlan,
  type ModificationJournal,
  type ObservedBrowserAgent,
  type ObservedReadinessInputs,
  type ObservedServerAgent,
  type Readiness,
  type ReadinessSignal,
} from '@debuggen/instrumentation';
import {
  agentReadyPayloadSchema,
  type AgentReadyPayload,
  type BoundTab,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  isErr,
  isOk,
  noopLogger,
  ok,
  err,
  type Result,
} from '@debuggen/shared';

import {
  buildRelaunchHint,
  formatRelaunchCommand,
  type DevServerDetection,
  type FetchLike,
  type detectDevServer,
} from '../dev-server/detect.js';
import type { LaunchedDevServer } from '../dev-server/launcher.js';
import {
  CAPTURE_SIGNAL_LABELS,
  READY_TO_CAPTURE_MESSAGE,
  type SessionProgress,
} from '../sessions/progress.js';
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
  type CollectObservedReadinessRequest,
  type EvaluateReadinessDeps,
  type EvaluateReadinessRequest,
  type ReadinessRemediation,
  type ReadinessRemediationKind,
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

/**
 * How the scripted port's `waitForAgentReady` answers.
 *
 * - a report — resolves with it at once, and it becomes the tab's latest;
 * - `'never'` — never settles: a port that ignores its own timeout;
 * - `'deferred'` — settles when the test calls {@link FakeAgents.settleWait};
 * - `'timeout'` — resolves `undefined` once its own `timeoutMs` elapses, on
 *   whatever timers the test runs (fake ones, in every case that uses it).
 *
 * Omitted, the wait resolves `undefined` at once.
 */
type WaitScript = AgentReadyPayload | 'never' | 'deferred' | 'timeout';

interface FakeAgentsInput {
  /** The tab's latest report. Shorthand for a one-entry {@link latestSequence}. */
  readonly latest?: AgentReadyPayload;
  /**
   * What `latestAgentReady` answers, one entry per call; the last entry keeps
   * answering. `undefined` entries are "no report for the current document".
   */
  readonly latestSequence?: readonly (AgentReadyPayload | undefined)[];
  readonly next?: WaitScript;
  readonly receivedAt?: number;
  readonly throwOnLatest?: boolean;
  readonly rejectWait?: boolean;
}

interface FakeAgents {
  readonly registry: BrowserAgentRegistry;
  readonly waitCalls: { readonly tabId: number; readonly options: WaitForAgentReadyOptions }[];
  /** The tab id of every `latestAgentReady` call, in order. */
  readonly latestCalls: number[];
  /** Resolves when `waitForAgentReady` is first called. */
  readonly waitStarted: Promise<void>;
  /** Settles every `'deferred'` wait with `report`, which becomes the latest. */
  settleWait(report: AgentReadyPayload | undefined): void;
  /** Replaces the tab's latest report, as the relaying layer does on each document load. */
  replace(report: AgentReadyPayload | undefined): void;
}

/**
 * A scripted `BrowserAgentRegistry`: queue-controlled latest reports and a
 * test-controlled wait. Like the real client registry it is keyed by tab, so a
 * report for another tab is never answered for this one.
 */
function fakeAgents(input: FakeAgentsInput = {}): FakeAgents {
  const queue: (AgentReadyPayload | undefined)[] =
    input.latestSequence !== undefined
      ? [...input.latestSequence]
      : input.latest !== undefined
        ? [input.latest]
        : [];
  const waitCalls: FakeAgents['waitCalls'] = [];
  const latestCalls: number[] = [];
  const pending: ((report: AgentReadyPayload | undefined) => void)[] = [];
  let markWaitStarted: () => void = () => undefined;
  const waitStarted = new Promise<void>((resolve) => {
    markWaitStarted = resolve;
  });

  const replace = (report: AgentReadyPayload | undefined): void => {
    queue.splice(0, queue.length, report);
  };

  const registry: BrowserAgentRegistry = {
    latestAgentReady(tabId) {
      latestCalls.push(tabId);

      if (input.throwOnLatest === true) {
        throw new Error('registry unavailable');
      }

      const head = queue.length > 1 ? queue.shift() : queue[0];
      return head?.tabId === tabId ? head : undefined;
    },
    waitForAgentReady(tabId, options) {
      waitCalls.push({ tabId, options });
      markWaitStarted();

      if (input.rejectWait === true) {
        return Promise.reject(new Error('wait failed'));
      }

      const script = input.next;

      if (script === 'never') {
        return new Promise<AgentReadyPayload | undefined>(() => {
          // A port that ignores its own timeout: never settles.
        });
      }

      if (script === 'deferred') {
        return new Promise<AgentReadyPayload | undefined>((resolve) => {
          pending.push(resolve);
        });
      }

      if (script === 'timeout') {
        return new Promise<AgentReadyPayload | undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, options.timeoutMs ?? 0);
        });
      }

      if (script !== undefined) {
        replace(script);
      }

      return Promise.resolve(script);
    },
    ...(input.receivedAt === undefined
      ? {}
      : { latestAgentReadyAt: (): number | undefined => input.receivedAt }),
  };

  return {
    registry,
    waitCalls,
    latestCalls,
    waitStarted,
    settleWait(report) {
      if (report !== undefined) {
        replace(report);
      }

      for (const resolve of pending.splice(0)) {
        resolve(report);
      }
    },
    replace,
  };
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

/**
 * Distinctive sentinels for the detection's relaunch command and hint: no code
 * path could compose either, so string equality with them proves a value was
 * carried from the injected detection rather than assembled.
 */
const SENTINEL_RELAUNCH_COMMAND = 'sentinel-relaunch-command-3b7e';
const SENTINEL_RELAUNCH_HINT = 'sentinel-relaunch-hint-3b7e';

function detection(overrides: Partial<DevServerDetection> = {}): DevServerDetection {
  return {
    projectRoot: PROJECT_ROOT,
    devServerUrl: `${APP_ORIGIN}/`,
    running: true,
    preloadAttached: false,
    preloadReason: 'no-server-agent-connection',
    packageManager: 'pnpm',
    packageManagerSource: 'project-summary',
    relaunchCommand: SENTINEL_RELAUNCH_COMMAND,
    relaunchHint: SENTINEL_RELAUNCH_HINT,
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
// Fixtures: the ports readiness must never touch
// ---------------------------------------------------------------------------

/**
 * Every touch of a forbidden port made anywhere in this file, in order. The
 * `afterEach` below fails the test that made one, so a touch swallowed by a
 * `catch` inside the module under test is still caught.
 */
const suitePortTouches: string[] = [];

/** A journal and a backup store whose every member throws and records. */
interface ForbiddenPorts {
  readonly journal: ModificationJournal;
  readonly backups: BackupStore;
}

/**
 * Builds the journal and backup store an `InstrumentationContext` requires,
 * each member of which records the touch in `sink` and throws: readiness
 * writes nothing (AAP §0.5.1 names the patcher and cleanup as the only
 * writers), so reaching either is a defect this double makes loud.
 */
function forbiddenPorts(sink: string[] = suitePortTouches): ForbiddenPorts {
  const refuse = (member: string): never => {
    sink.push(member);
    throw new Error(`readiness must never reach ${member}`);
  };

  return {
    journal: {
      append: () => refuse('journal.append'),
      updateStatus: () => refuse('journal.updateStatus'),
      listBySession: () => refuse('journal.listBySession'),
      listOpen: () => refuse('journal.listOpen'),
    },
    backups: {
      get sessionId(): string {
        return refuse('backups.sessionId');
      },
      get sessionDirectory(): string {
        return refuse('backups.sessionDirectory');
      },
      locate: () => refuse('backups.locate'),
      locateRecorded: () => refuse('backups.locateRecorded'),
      put: () => refuse('backups.put'),
      read: () => refuse('backups.read'),
      readRecorded: () => refuse('backups.readRecorded'),
      has: () => refuse('backups.has'),
      verify: () => refuse('backups.verify'),
      remove: () => refuse('backups.remove'),
      removeRecorded: () => refuse('backups.removeRecorded'),
      removeSessionDirectory: () => refuse('backups.removeSessionDirectory'),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  const touched = suitePortTouches.splice(0);
  expect(touched, 'readiness reached a port it must never touch').toEqual([]);
});

// ---------------------------------------------------------------------------
// Fixtures: context, progress and the evaluation call
// ---------------------------------------------------------------------------

/**
 * A minimal valid context. The code-analysis members are opaque to readiness
 * and stay empty; the journal and backup store are {@link forbiddenPorts}.
 */
function context(
  readiness: ObservedReadinessInputs = {},
  overrides: Partial<InstrumentationContext> = {},
): InstrumentationContext {
  const ports = forbiddenPorts();

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
    journal: ports.journal,
    backups: ports.backups,
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

/** The verdict's remediation of one kind, narrowed to that kind. */
function remediationOf<K extends ReadinessRemediationKind>(
  verdict: ReadinessVerdict,
  kind: K,
): Extract<ReadinessRemediation, { readonly kind: K }> | undefined {
  return verdict.remediations.find(
    (entry): entry is Extract<ReadinessRemediation, { readonly kind: K }> => entry.kind === kind,
  );
}

/**
 * "Nothing was written anywhere": no forbidden port was touched, and no
 * progress row reported a failure — the reload request is a `running` row and
 * readiness never fails a session.
 */
function expectNothingWritten(emit?: Mock<SessionProgress['emit']>): void {
  expect(suitePortTouches).toEqual([]);

  for (const [, row] of emit?.mock.calls ?? []) {
    expect(row.status).not.toBe('failed');
  }
}

/** Settles a call, capturing a synchronous or asynchronous throw as data. */
async function settle<T>(
  call: () => Promise<T>,
): Promise<
  { readonly threw: false; readonly value: T } | { readonly threw: true; readonly thrown: unknown }
> {
  try {
    return { threw: false, value: await call() };
  } catch (thrown) {
    return { threw: true, thrown };
  }
}

/** Fake `setTimeout`/`clearTimeout` only, so real `performance.now()` still measures the run. */
function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

describe('the suite’s doubles', () => {
  it('builds agent.ready fixtures that are valid wire payloads', () => {
    expect(agentReadyPayloadSchema.safeParse(agentReady()).success).toBe(true);
  });

  it('refuses and records every touch of a forbidden port', () => {
    const sink: string[] = [];
    const ports = forbiddenPorts(sink);

    expect(() => ports.journal.listOpen()).toThrow(/never reach journal\.listOpen/u);
    expect(() => ports.backups.sessionId).toThrow(/never reach backups\.sessionId/u);
    expect(() => ports.backups.put('digest', new Uint8Array())).toThrow(/backups\.put/u);
    expect(sink).toEqual(['journal.listOpen', 'backups.sessionId', 'backups.put']);
    expect(suitePortTouches).toEqual([]);
  });

  it('scripts the page-agent registry: queued reports per tab and a deferred wait', async () => {
    const agents = fakeAgents({ latestSequence: [undefined, agentReady()], next: 'deferred' });

    expect(agents.registry.latestAgentReady(TAB_ID)).toBeUndefined();
    expect(agents.registry.latestAgentReady(TAB_ID)?.documentId).toBe('doc_first');
    expect(agents.registry.latestAgentReady(TAB_ID + 1)).toBeUndefined();

    const waiting = agents.registry.waitForAgentReady(TAB_ID, { timeoutMs: 5 });
    await agents.waitStarted;
    agents.settleWait(agentReady({ documentId: 'doc_second' }));

    expect((await waiting)?.documentId).toBe('doc_second');
    expect(agents.registry.latestAgentReady(TAB_ID)?.documentId).toBe('doc_second');
    expect(agents.latestCalls).toEqual([TAB_ID, TAB_ID, TAB_ID + 1, TAB_ID]);
  });
});

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

describe('collectObservedReadiness — the evidence’s observed member', () => {
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

// ---------------------------------------------------------------------------
// collectObservedReadiness — the upstream observed inputs, field for field
// ---------------------------------------------------------------------------

/**
 * Every field the upstream observed-readiness types declare. The type-level
 * check below fails to compile when `packages/instrumentation/src/adapter.ts`
 * grows a field these lists do not name, so "populates every field" cannot
 * silently fall behind the declaration it is about.
 */
const OBSERVED_INPUT_KEYS = [
  'browserAgent',
  'serverAgent',
] as const satisfies readonly (keyof ObservedReadinessInputs)[];
const OBSERVED_BROWSER_AGENT_KEYS = [
  'producerId',
  'documentId',
  'url',
  'installedBeforeReact',
  'reactDetected',
  'observedAt',
] as const satisfies readonly (keyof ObservedBrowserAgent)[];
const OBSERVED_SERVER_AGENT_KEYS = [
  'connected',
  'projectRoot',
  'lastHeartbeatAt',
] as const satisfies readonly (keyof ObservedServerAgent)[];

type UnlistedKeys<T, Listed extends readonly PropertyKey[]> = Exclude<keyof T, Listed[number]>;

const EVERY_OBSERVED_FIELD_LISTED: [
  UnlistedKeys<ObservedReadinessInputs, typeof OBSERVED_INPUT_KEYS>,
  UnlistedKeys<ObservedBrowserAgent, typeof OBSERVED_BROWSER_AGENT_KEYS>,
  UnlistedKeys<ObservedServerAgent, typeof OBSERVED_SERVER_AGENT_KEYS>,
] extends [never, never, never]
  ? true
  : false = true;

/** Collection with every fact available: a fresh report for the bound tab and a live preload. */
function fullyObservedDeps(agents: FakeAgents): CollectObservedReadinessDeps {
  return collectDeps({
    agents: agents.registry,
    serverAgents: serverAgents(true, ok({ online: true, lastSeenAt: NOW - 1_000 })),
  });
}

const FULL_REQUEST: CollectObservedReadinessRequest = {
  sessionId: SESSION_ID,
  projectRoot: PROJECT_ROOT,
  boundTab: BOUND_TAB,
};

describe('collectObservedReadiness — observed inputs', () => {
  it('populates every field ObservedReadinessInputs declares, as plain JSON data', async () => {
    const agents = fakeAgents({
      latest: agentReady({ url: `${APP_ORIGIN}/widgets` }),
      receivedAt: NOW - 5_000,
    });
    const result = await collectObservedReadiness(fullyObservedDeps(agents), FULL_REQUEST);

    if (isErr(result)) throw result.error;
    const observed: ObservedReadinessInputs = result.value;

    expect(EVERY_OBSERVED_FIELD_LISTED).toBe(true);
    expect(Object.keys(observed).sort()).toEqual([...OBSERVED_INPUT_KEYS].sort());
    expect(Object.keys(observed.browserAgent ?? {}).sort()).toEqual(
      [...OBSERVED_BROWSER_AGENT_KEYS].sort(),
    );
    expect(Object.keys(observed.serverAgent ?? {}).sort()).toEqual(
      [...OBSERVED_SERVER_AGENT_KEYS].sort(),
    );
    expect(observed.serverAgent).toEqual({
      connected: true,
      projectRoot: PROJECT_ROOT,
      lastHeartbeatAt: NOW - 1_000,
    });
    expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);
  });

  it('carries the bound tab’s browser facts through unchanged', async () => {
    const report = agentReady({
      documentId: 'doc_fresh',
      producerId: 'prd_fresh',
      url: `${APP_ORIGIN}/widgets/detail`,
      installedBeforeReact: false,
      reactDetected: false,
    });
    expect(agentReadyPayloadSchema.safeParse(report).success).toBe(true);

    const result = await collectObservedReadiness(
      fullyObservedDeps(fakeAgents({ latest: report })),
      FULL_REQUEST,
    );

    if (isErr(result)) throw result.error;
    expect(result.value.browserAgent).toEqual({
      producerId: report.producerId,
      documentId: report.documentId,
      url: report.url,
      installedBeforeReact: report.installedBeforeReact,
      reactDetected: report.reactDetected,
      observedAt: NOW,
    });
  });

  it('records a missing binding as absence, fabricating no page-agent report', async () => {
    const agents = fakeAgents({ latest: agentReady() });
    const result = await collectObservedReadiness(fullyObservedDeps(agents), {
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
    });

    if (isErr(result)) throw result.error;
    expect('browserAgent' in result.value).toBe(false);
    expect(JSON.stringify(result.value)).not.toContain('browserAgent');
    // The registry held a report, and it was not read: nothing was borrowed from it.
    expect(agents.latestCalls).toEqual([]);
  });

  it('reflects a connected preload and skips dev-server detection', async () => {
    const detect = fakeDetect();
    const result = await collectObservedReadiness(
      collectDeps({ detect, serverAgents: serverAgents(true) }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect(result.value.serverAgent).toEqual({ connected: true, projectRoot: PROJECT_ROOT });
    expect(detect).not.toHaveBeenCalled();
  });

  it('takes detection from the injected port for the project root, with no real probe', async () => {
    const detect = fakeDetect();
    const probes: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      probes.push(input);
      return Promise.reject(new Error('this suite has no network'));
    };
    const presence = serverAgents(false);
    const result = await collectObservedReadiness(
      collectDeps({ detect, serverAgents: presence, detectDeps: { fetchImpl } }),
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT },
    );

    if (isErr(result)) throw result.error;
    expect('serverAgent' in result.value).toBe(false);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).toEqual({
      projectRoot: PROJECT_ROOT,
      devServerUrl: undefined,
    });
    expect(detect.mock.calls[0]?.[1]?.serverAgents).toBe(presence);
    expect(detect.mock.calls[0]?.[1]?.fetchImpl).toBe(fetchImpl);
    expect(probes).toEqual([]);
  });

  it.each([
    ['rejects', fakeDetect(new Error('probe refused'))],
    [
      'throws synchronously',
      vi.fn<DetectFn>(() => {
        throw new Error('probe exploded');
      }),
    ],
  ])(
    'records a detection that %s as unknown and not attached, still Ok',
    async (_label, detect) => {
      const deps = collectDeps({ detect, serverAgents: serverAgents(false) });
      const request = { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT };

      const observed = await settle(() => collectObservedReadiness(deps, request));
      const evidence = await collectReadinessEvidence(deps, request);

      expect(observed.threw).toBe(false);
      if (observed.threw || isErr(observed.value) || isErr(evidence)) {
        throw new Error('detection failure must be data');
      }
      expect(isOk(observed.value)).toBe(true);
      expect(observed.value.value.serverAgent?.connected).not.toBe(true);
      expect(evidence.value.devServer).toBeUndefined();
      expect(evidence.value.notes.join(' ')).toMatch(/not attached/u);
    },
  );

  it.each([
    ['an empty project root', { sessionId: SESSION_ID, projectRoot: '' }],
    ['a blank project root', { sessionId: SESSION_ID, projectRoot: '   ' }],
    ['a relative project root', { sessionId: SESSION_ID, projectRoot: 'work/sample-project' }],
    ['an empty session id', { sessionId: '', projectRoot: PROJECT_ROOT }],
    [
      'a missing session id',
      { projectRoot: PROJECT_ROOT } as unknown as CollectObservedReadinessRequest,
    ],
  ])('returns Err with a known code, never a throw, for %s', async (_label, request) => {
    const detect = fakeDetect();
    const agents = fakeAgents({ latest: agentReady() });
    const outcome = await settle(() =>
      collectObservedReadiness(collectDeps({ detect, agents: agents.registry }), request),
    );

    expect(outcome.threw).toBe(false);
    if (outcome.threw) throw new Error('collection threw');
    expect(isErr(outcome.value)).toBe(true);
    if (!isErr(outcome.value)) throw new Error('expected Err');
    expect(DEBUGGEN_ERROR_CODES).toContain(outcome.value.error.code);
    expect(detect).not.toHaveBeenCalled();
    expect(agents.latestCalls).toEqual([]);
  });

  it('is deterministic, caches nothing between calls and leaves no timer behind', async () => {
    useFakeTimeouts();
    const agents = fakeAgents({ latest: agentReady() });
    let connected = true;
    const presence: ServerAgentReadinessSource = {
      hasServerAgentForProject: () => connected,
    };
    const deps = collectDeps({ agents: agents.registry, serverAgents: presence });

    const first = await collectObservedReadiness(deps, FULL_REQUEST);
    const second = await collectObservedReadiness(deps, FULL_REQUEST);

    expect(second).toEqual(first);
    expect(vi.getTimerCount()).toBe(0);

    // The relaying layer replaces the report on a new document load and the
    // preload goes away: the next call must see both changes, not a memo.
    agents.replace(agentReady({ documentId: 'doc_second', producerId: 'prd_second' }));
    connected = false;
    const third = await collectObservedReadiness(deps, FULL_REQUEST);

    if (isErr(first) || isErr(third)) throw new Error('unexpected Err');
    expect(first.value.browserAgent?.documentId).toBe('doc_first');
    expect(third.value.browserAgent?.documentId).toBe('doc_second');
    expect(third.value.browserAgent?.producerId).toBe('prd_second');
    expect(third.value.serverAgent).toBeUndefined();
    expect(agents.latestCalls).toEqual([TAB_ID, TAB_ID, TAB_ID]);
    expect(vi.getTimerCount()).toBe(0);
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

  it('stays bounded when the port never answers, and releases its backstop timer', async () => {
    useFakeTimeouts();
    const reloadWaitMs = 40;
    const agents = fakeAgents({ next: 'never' });
    let settled = false;
    const pending = evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, reloadWaitMs },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    ).then((verdict) => {
      settled = true;
      return verdict;
    });

    await agents.waitStarted;
    // The port's own deadline passes and it still says nothing.
    await vi.advanceTimersByTimeAsync(reloadWaitMs);
    expect(settled).toBe(false);
    // The backstop is a bounded grace beyond that deadline, well under a second.
    await vi.advanceTimersByTimeAsync(1_000);
    const verdict = await pending;

    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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

// ---------------------------------------------------------------------------
// evaluateReadiness — blocking conditions (the buildBlockingConditions behaviour)
// ---------------------------------------------------------------------------

describe('evaluateReadiness — blocking conditions (the buildBlockingConditions behaviour)', () => {
  it('blocks browser signals without a bound tab and names bind-tab', async () => {
    const { progress, emit } = fakeProgress();
    const agents = fakeAgents({ latest: agentReady() });
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress },
      { plan: plan([action('interaction-tracking', PAGE_ADAPTER_ID)]) },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations).toEqual([{ kind: 'bind-tab' }]);
    expect(signalsOf(verdict.blocking)).toEqual(verdict.plannedSignals);
    expect(verdict.deliverableSignals).toEqual([]);
    expect(agents.latestCalls).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expectNothingWritten(emit);
  });

  it('blocks when no agent.ready was relayed for the current document and names reload-page', async () => {
    const { progress, emit } = fakeProgress();
    const agents = fakeAgents();
    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress, reloadWaitMs: 0 },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations).toEqual([{ kind: 'reload-page', tabId: TAB_ID }]);
    expect(signalsOf(verdict.blocking)).toEqual(verdict.plannedSignals);
    expect(verdict.blocking.every((gap) => gap.hint === RELOAD_REQUEST_MESSAGE)).toBe(true);
    expect('browserAgent' in verdict.observed).toBe(false);
    expect(verdict.reloadRequested).toBe(true);
    // A zero wait asks without waiting.
    expect(agents.waitCalls).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expectNothingWritten(emit);
  });

  it('treats a report from a previous document at another origin as absent', async () => {
    const adapter = pageAdapter();
    const previous = agentReady({
      documentId: 'doc_previous',
      producerId: 'prd_previous',
      url: 'http://127.0.0.1:4999/elsewhere',
    });
    const verdict = await evaluate(
      {
        adapters: registryOf(adapter),
        agents: fakeAgents({ latest: previous }).registry,
        reloadWaitMs: 0,
      },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.remediations).toEqual([{ kind: 'reload-page', tabId: TAB_ID }]);
    expect(verdict.observed.browserAgent).toBeUndefined();
    expect(adapter.calls[0]?.readiness.browserAgent).toBeUndefined();
    expect(JSON.stringify(verdict)).not.toContain('doc_previous');
    expectNothingWritten();
  });

  it('does not accept a replay of the stale document as the reloaded one', async () => {
    const adapter = pageAdapter();
    const agents = fakeAgents({
      latest: agentReady({ installedBeforeReact: false }),
      next: 'deferred',
    });
    const pending = evaluate(
      { adapters: registryOf(adapter), agents: agents.registry, reloadWaitMs: 1_000 },
      { plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    await agents.waitStarted;
    // The same document again, now claiming the hook was early: not a reload.
    agents.settleWait(agentReady({ installedBeforeReact: true }));
    const verdict = await pending;

    expect(verdict.satisfied).toBe(false);
    expect(verdict.observed.browserAgent?.documentId).toBe('doc_first');
    expect(verdict.observed.browserAgent?.installedBeforeReact).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    expect(remediationOf(verdict, 'reload-page')).toEqual({
      kind: 'reload-page',
      tabId: TAB_ID,
      documentId: 'doc_first',
    });
    expectNothingWritten();
  });

  it('reads the current document afresh on every evaluation, never a replaced one', async () => {
    const agents = fakeAgents({
      latest: agentReady({ documentId: 'doc_old', installedBeforeReact: false }),
    });
    const run = (): Promise<ReadinessVerdict> =>
      evaluate(
        { adapters: registryOf(pageAdapter()), agents: agents.registry },
        {
          plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
          boundTab: BOUND_TAB,
          allowReloadPrompt: false,
        },
      );

    const before = await run();
    agents.replace(
      agentReady({ documentId: 'doc_new', producerId: 'prd_new', installedBeforeReact: true }),
    );
    const after = await run();

    expect(before.satisfied).toBe(false);
    expect(remediationOf(before, 'reload-page')?.documentId).toBe('doc_old');
    expect(after.satisfied).toBe(true);
    expect(after.remediations).toEqual([]);
    expect(after.observed.browserAgent?.documentId).toBe('doc_new');
    expect(JSON.stringify(after)).not.toContain('doc_old');
  });

  it('blocks React signals on a late hook, then passes after exactly one re-evaluation on the reloaded document', async () => {
    const { progress, emit, readyToCapture } = fakeProgress();
    const adapter = pageAdapter();
    const agents = fakeAgents({
      latest: agentReady({ installedBeforeReact: false }),
      next: 'deferred',
    });
    const pending = evaluateReadiness(
      {
        adapters: registryOf(adapter),
        agents: agents.registry,
        progress,
        now: clock,
        reloadWaitMs: 1_000,
      },
      {
        context: context(),
        plan: plan([action('state-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
      },
    );

    await agents.waitStarted;
    // The first pass has concluded "reload-page" and asked for it.
    expect(adapter.calls).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(agents.waitCalls[0]?.options.afterDocumentId).toBe('doc_first');

    agents.settleWait(
      agentReady({
        documentId: 'doc_second',
        producerId: 'prd_second',
        installedBeforeReact: true,
      }),
    );
    const result = await pending;

    if (isErr(result)) throw result.error;
    const verdict = result.value;
    expect(verdict.satisfied).toBe(true);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.readiness.browserAgent?.documentId).toBe('doc_second');
    expect(agents.waitCalls).toHaveLength(1);
    expect(verdict.observed.browserAgent?.documentId).toBe('doc_second');
    expect(verdict.blocking).toEqual([]);
    expect(verdict.remediations).toEqual([]);
    expect(verdict.reloadRequested).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(readyToCapture).toHaveBeenCalledTimes(1);
    expectNothingWritten(emit);
  });

  it('leaves the remediation listed when the wait times out: bounded, Ok, and no session failure', async () => {
    useFakeTimeouts();
    const reloadWaitMs = 40;
    const { progress, emit, readyToCapture } = fakeProgress();
    const agents = fakeAgents({
      latest: agentReady({ installedBeforeReact: false }),
      next: 'timeout',
    });
    const startedAt = performance.now();
    let settled = false;
    const pending = evaluateReadiness(
      { adapters: registryOf(pageAdapter()), agents: agents.registry, progress, reloadWaitMs },
      {
        context: context(),
        plan: plan([action('react-render-tracking', PAGE_ADAPTER_ID)]),
        boundTab: BOUND_TAB,
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    await agents.waitStarted;
    expect(agents.waitCalls[0]?.options.timeoutMs).toBe(reloadWaitMs);
    await vi.advanceTimersByTimeAsync(reloadWaitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(isOk(result)).toBe(true);
    if (isErr(result)) throw result.error;
    expect(result.value.satisfied).toBe(false);
    expect(remediationOf(result.value, 'reload-page')?.documentId).toBe('doc_first');
    expect(result.value.reloadRequested).toBe(true);
    expect(readyToCapture).not.toHaveBeenCalled();
    expectNothingWritten(emit);
  });

  it('is not satisfied when no planned signal is deliverable, and every gap then blocks', async () => {
    const { progress, readyToCapture } = fakeProgress();
    const nowhere = pageAdapter((signal): ReadinessSignal => ({
      signal,
      status: 'unavailable',
      reason: 'page-signals: this signal cannot be armed on this page',
      hint: 'page-signals: open another page of the application',
    }));
    const verdict = await evaluate(
      {
        adapters: registryOf(nowhere),
        agents: fakeAgents({ latest: agentReady() }).registry,
        progress,
      },
      { plan: plan([action('fetch-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.plannedSignals.length).toBeGreaterThan(0);
    expect(verdict.deliverableSignals).toEqual([]);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.degraded).toEqual([]);
    expect(signalsOf(verdict.blocking)).toEqual(verdict.plannedSignals);
    // No session-level gate failed, so there is nothing for the developer to do
    // but choose other signals — and nothing is invented.
    expect(verdict.remediations).toEqual([]);
    expect(readyToCapture).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

// ---------------------------------------------------------------------------
// RELOAD_REQUEST_MESSAGE — the one-click reload request
// ---------------------------------------------------------------------------

describe('RELOAD_REQUEST_MESSAGE — the one-click reload request', () => {
  const latePlan = (): InstrumentationPlan => plan([action('state-tracking', PAGE_ADAPTER_ID)]);

  it('is one line of developer-facing prose owned by no other module', () => {
    expect(RELOAD_REQUEST_MESSAGE.trim().length).toBeGreaterThan(0);
    expect(RELOAD_REQUEST_MESSAGE).not.toMatch(/[\n\r]/u);
    expect(RELOAD_REQUEST_MESSAGE).not.toBe(READY_TO_CAPTURE_MESSAGE);
    expect(Object.values(CAPTURE_SIGNAL_LABELS)).not.toContain(RELOAD_REQUEST_MESSAGE);
  });

  it('is emitted with the remediation’s reason as its detail, at most once per document', async () => {
    const { progress, emit } = fakeProgress();
    const ledger = new Set<string>();
    const run = (report: AgentReadyPayload): Promise<ReadinessVerdict> =>
      evaluate(
        {
          adapters: registryOf(pageAdapter()),
          agents: fakeAgents({ latest: report }).registry,
          progress,
          reloadPrompts: ledger,
          reloadWaitMs: 0,
        },
        { plan: latePlan(), boundTab: BOUND_TAB },
      );
    const late = agentReady({ installedBeforeReact: false });

    const verdicts = [await run(late), await run(late), await run(late)];

    expect(emit).toHaveBeenCalledTimes(1);
    const [sessionId, row] = emit.mock.calls[0] ?? [];
    expect(sessionId).toBe(SESSION_ID);
    expect(row).toEqual({
      stage: 'instrument',
      status: 'running',
      message: RELOAD_REQUEST_MESSAGE,
      detail: expect.any(String) as unknown,
    });
    const reloadGap = verdicts[0]?.blocking.find((gap) => gap.hint === RELOAD_REQUEST_MESSAGE);
    expect(reloadGap).toBeDefined();
    expect(row?.detail).toBe(reloadGap?.reason);
    expect(verdicts.map((verdict) => verdict.reloadRequested)).toEqual([true, false, false]);
    for (const verdict of verdicts) {
      expect(verdict.satisfied).toBe(false);
      expect(remediationOf(verdict, 'reload-page')).toEqual({
        kind: 'reload-page',
        tabId: TAB_ID,
        documentId: 'doc_first',
      });
    }

    // A different document is a different question, and is asked once more.
    await run(agentReady({ documentId: 'doc_second', installedBeforeReact: false }));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(ledger.size).toBe(2);
    expectNothingWritten(emit);
  });

  it('is suppressed entirely by allowReloadPrompt: false, while the remediation is still reported', async () => {
    const { progress, emit } = fakeProgress();
    const ledger = new Set<string>();
    const agents = fakeAgents({
      latest: agentReady({ installedBeforeReact: false }),
      next: 'deferred',
    });
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: agents.registry,
        progress,
        reloadPrompts: ledger,
      },
      { plan: latePlan(), boundTab: BOUND_TAB, allowReloadPrompt: false },
    );

    expect(emit).not.toHaveBeenCalled();
    expect(agents.waitCalls).toEqual([]);
    expect(ledger.size).toBe(0);
    expect(verdict.reloadRequested).toBe(false);
    expect(verdict.satisfied).toBe(false);
    expect(remediationOf(verdict, 'reload-page')?.tabId).toBe(TAB_ID);
    expectNothingWritten(emit);
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
    expect(verdict.blocking).toEqual([]);
    expect(signalsOf(verdict.degraded)).toEqual(['react', 'componentTree']);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'react', 'componentTree']);
    // A page without React is not fixed by a reload, so none is asked for.
    expect(verdict.remediations).toEqual([]);
    expect(verdict.reloadRequested).toBe(false);
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
// evaluateReadiness — degradation-only conditions (AAP §0.5.5)
// ---------------------------------------------------------------------------

/** The heartbeat window of {@link preloadProbe}: its own judgement, as a real preload adapter's is. */
const PROBE_HEARTBEAT_WINDOW_MS = 30_000;
const PRELOAD_PROBE_ID = 'preload-probe';
const PROBE_SILENT_REASON = 'preload-probe: the preload has gone quiet past its heartbeat window';

/**
 * A preload-bound fake that judges heartbeat staleness itself, from the
 * observed `lastHeartbeatAt` and the context's clock — the division of labour
 * `./readiness.ts` documents: it hands the heartbeat over, the adapter judges.
 */
function preloadProbe(): ReturnType<typeof fakeAdapter> {
  return fakeAdapter(PRELOAD_PROBE_ID, [{ type: 'server-span', mode: 'patch' }], (probed) => {
    const agent = probed.readiness.serverAgent;
    const at = probed.now?.() ?? NOW;
    const heardAt = agent?.lastHeartbeatAt;
    const silent =
      agent?.connected === true &&
      heardAt !== undefined &&
      at - heardAt > PROBE_HEARTBEAT_WINDOW_MS;

    return buildReadiness({
      adapter: PRELOAD_PROBE_ID,
      signals: (['http', 'routeHandlers', 'functions'] as const).map((signal): ReadinessSignal =>
        silent
          ? {
              signal,
              status: 'degraded',
              reason: PROBE_SILENT_REASON,
              hint: 'preload-probe: check that the dev server is still running',
            }
          : agent?.connected === true
            ? { signal, status: 'available' }
            : {
                signal,
                status: 'unavailable',
                reason: 'preload-probe: no preload is connected',
                hint: 'preload-probe: relaunch the dev server',
              },
      ),
      now: clock,
    });
  });
}

describe('evaluateReadiness — degradation-only conditions', () => {
  /** A browser signal the page can deliver, plus server signals that need the preload. */
  const mixedPlan = (): InstrumentationPlan =>
    plan([
      action('react-render-tracking', PAGE_ADAPTER_ID),
      action('server-span', PRELOAD_PROBE_ID),
    ]);

  /** Collects the observed facts for a preload in the given state, through the real collection. */
  async function observedPreload(
    connected: boolean,
    lastSeenAt?: number,
  ): Promise<ObservedReadinessInputs> {
    const snapshot: ServerAgentSnapshot = {
      online: connected,
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    };
    const result = await collectObservedReadiness(
      collectDeps({
        agents: fakeAgents({ latest: agentReady() }).registry,
        serverAgents: serverAgents(connected, connected ? ok(snapshot) : undefined),
      }),
      FULL_REQUEST,
    );

    if (isErr(result)) throw result.error;
    return result.value;
  }

  it('degrades server signals without a server-agent, with the detection’s relaunch hint verbatim', async () => {
    const agents = fakeAgents({ latest: agentReady() });
    const devServer = detection();
    const detect = fakeDetect(devServer);
    const evidence = await collectReadinessEvidence(
      collectDeps({ detect, agents: agents.registry, serverAgents: serverAgents(false) }),
      { ...FULL_REQUEST, plan: mixedPlan(), devServerUrl: `${APP_ORIGIN}/` },
    );

    if (isErr(evidence)) throw evidence.error;
    expect(evidence.value.devServer).toBe(devServer);

    const verdict = await evaluate(
      { adapters: registryOf(pageAdapter(), preloadProbe()), agents: agents.registry },
      {
        context: context(evidence.value.observed),
        plan: mixedPlan(),
        boundTab: BOUND_TAB,
        ...(evidence.value.devServer === undefined ? {} : { devServer: evidence.value.devServer }),
      },
    );

    const relaunch = remediationOf(verdict, 'relaunch-dev-server');
    expect(relaunch?.hint).toBe(SENTINEL_RELAUNCH_HINT);
    expect(relaunch?.command).toBe(SENTINEL_RELAUNCH_COMMAND);
    expect(relaunch?.projectRoot).toBe(PROJECT_ROOT);
    expect(signalsOf(verdict.degraded)).toEqual(['http', 'routeHandlers', 'functions']);
    for (const gap of verdict.degraded) {
      expect(gap.hint).toBe(SENTINEL_RELAUNCH_HINT);
    }
    expect(verdict.blocking).toEqual([]);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.deliverableSignals).toEqual(['interactions', 'react', 'componentTree']);
    expectNothingWritten();
  });

  it('degrades on a stale heartbeat judged against the injected clock, in wording distinct from “not connected”', async () => {
    const lastSeenAt = NOW - 1_000;
    const connectedFacts = await observedPreload(true, lastSeenAt);
    expect(connectedFacts.serverAgent?.lastHeartbeatAt).toBe(lastSeenAt);

    const judgeAt = (at: number): Promise<ReadinessVerdict> =>
      evaluate(
        {
          adapters: registryOf(pageAdapter(), preloadProbe()),
          agents: fakeAgents({ latest: agentReady() }).registry,
          now: () => at,
        },
        {
          context: context(connectedFacts, { now: () => at }),
          plan: mixedPlan(),
          boundTab: BOUND_TAB,
        },
      );

    const fresh = await judgeAt(NOW);
    const stale = await judgeAt(NOW + 2 * PROBE_HEARTBEAT_WINDOW_MS);

    expect(fresh.satisfied).toBe(true);
    expect(fresh.degraded).toEqual([]);

    expect(stale.satisfied).toBe(true);
    expect(stale.blocking).toEqual([]);
    expect(signalsOf(stale.degraded)).toEqual(['http', 'routeHandlers', 'functions']);
    expect(stale.degraded.every((gap) => gap.reason === PROBE_SILENT_REASON)).toBe(true);
    expect(remediationOf(stale, 'relaunch-dev-server')).toBeUndefined();
    expect(stale.evaluatedAt).toBe(NOW + 2 * PROBE_HEARTBEAT_WINDOW_MS);

    const disconnected = await evaluate(
      {
        adapters: registryOf(pageAdapter(), preloadProbe()),
        agents: fakeAgents({ latest: agentReady() }).registry,
      },
      { context: context(await observedPreload(false)), plan: mixedPlan(), boundTab: BOUND_TAB },
    );

    expect(disconnected.satisfied).toBe(true);
    expect(signalsOf(disconnected.degraded)).toEqual(['http', 'routeHandlers', 'functions']);
    expect(remediationOf(disconnected, 'relaunch-dev-server')).toBeDefined();
    const staleReasons = new Set(stale.degraded.map((gap) => gap.reason));
    for (const gap of disconnected.degraded) {
      expect(staleReasons.has(gap.reason)).toBe(false);
    }
  });

  it('degrades React signals, without blocking, on a page where no React was detected', async () => {
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter()),
        agents: fakeAgents({ latest: agentReady({ reactDetected: false }) }).registry,
      },
      { plan: plan([action('state-tracking', PAGE_ADAPTER_ID)]), boundTab: BOUND_TAB },
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(signalsOf(verdict.degraded)).toEqual(
      verdict.plannedSignals.filter((signal) => signal !== 'interactions'),
    );
    expect(verdict.deliverableSignals).toEqual(verdict.plannedSignals);
  });

  it('captures an adapter whose readiness() rejects as a degraded gap with a reason, and resolves Ok', async () => {
    const flaky = fakeAdapter('flaky-probe', [{ type: 'perf-tracking', mode: 'runtime' }], () =>
      Promise.reject(new Error('')),
    );
    const outcome = await settle(() =>
      evaluateReadiness(
        {
          adapters: registryOf(pageAdapter(), flaky),
          agents: fakeAgents({ latest: agentReady() }).registry,
          now: clock,
        },
        {
          context: context(),
          plan: plan([
            action('fetch-tracking', PAGE_ADAPTER_ID),
            action('perf-tracking', 'flaky-probe'),
          ]),
          boundTab: BOUND_TAB,
        },
      ),
    );

    expect(outcome.threw).toBe(false);
    if (outcome.threw) throw new Error('evaluation rethrew');
    expect(isOk(outcome.value)).toBe(true);
    if (isErr(outcome.value)) throw outcome.value.error;
    const verdict = outcome.value.value;

    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.degraded.length).toBeGreaterThan(0);
    for (const gap of verdict.degraded) {
      expect(gap.reason.trim().length).toBeGreaterThan(0);
      expect(gap.hint.trim().length).toBeGreaterThan(0);
    }
    expect(verdict.perAdapter.map((report) => report.adapterId)).toEqual([
      PAGE_ADAPTER_ID,
      'flaky-probe',
    ]);
    const flakyReport = verdict.perAdapter[1]?.readiness;
    expect(flakyReport?.signals.every((row) => row.status === 'degraded')).toBe(true);
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

// ---------------------------------------------------------------------------
// evaluateReadiness — structural guarantees
// ---------------------------------------------------------------------------

/** An adapter that reports no rows: present only to be asked. */
function quietAdapter(
  id: string,
  claims: readonly AdapterClaimEntry[],
  canHandle = true,
): ReturnType<typeof fakeAdapter> {
  return fakeAdapter(
    id,
    claims,
    () => buildReadiness({ adapter: id, signals: [], now: clock }),
    canHandle,
  );
}

/**
 * The planned signals the upstream derivations produce for `actions` — the
 * expectation is computed from `deriveAgentHookConfig` and
 * `deriveServerAgentSignals`, never written out, so an action-type mapping
 * hand-rolled in `./readiness.ts` would disagree with it.
 */
function derivedSignals(actions: readonly InstrumentationAction[]): CaptureSignal[] {
  const enabled = new Set<string>();

  for (const [signal, on] of Object.entries(deriveAgentHookConfig(actions))) {
    if (on) {
      enabled.add(signal);
    }
  }

  for (const [signal, value] of Object.entries(deriveServerAgentSignals(actions))) {
    if (Array.isArray(value) ? value.length > 0 : value) {
      enabled.add(signal);
    }
  }

  return CAPTURE_SIGNALS.filter((signal) => enabled.has(signal));
}

/** Every string a verdict puts in front of a developer. */
function verdictStrings(verdict: ReadinessVerdict): string[] {
  const url = verdict.observed.browserAgent?.url;

  return [
    ...verdict.blocking.flatMap((gap) => [gap.reason, gap.hint]),
    ...verdict.degraded.flatMap((gap) => [gap.reason, gap.hint]),
    ...verdict.remediations.flatMap((entry) =>
      entry.kind === 'relaunch-dev-server' ? [entry.command, entry.hint] : [],
    ),
    ...(url === undefined ? [] : [url]),
  ];
}

describe('evaluateReadiness — structural guarantees', () => {
  it('asks every claimant of a planned action type exactly once, deduplicated, in registry order', async () => {
    const beta = quietAdapter('signal-beta', [{ type: 'server-span', mode: 'patch' }]);
    const delta = quietAdapter('signal-delta', [{ type: 'db-query-tracking', mode: 'runtime' }]);
    const gamma = quietAdapter('signal-gamma', [{ type: 'fetch-tracking', mode: 'runtime' }]);
    const alpha = quietAdapter('signal-alpha', [
      { type: 'fetch-tracking', mode: 'runtime' },
      { type: 'perf-tracking', mode: 'runtime' },
    ]);
    const epsilon = quietAdapter(
      'signal-epsilon',
      [{ type: 'interaction-tracking', mode: 'runtime' }],
      false,
    );
    const fakes = [beta, delta, gamma, alpha, epsilon];
    const builtIns: readonly string[] = ADAPTER_IDS;
    expect(fakes.some((fake) => builtIns.includes(fake.id))).toBe(false);

    const registry = registryOf(...fakes);
    // Plan order deliberately differs from registry order, and two actions
    // name the same adapter.
    const actions = [
      action('fetch-tracking', 'signal-gamma'),
      action('perf-tracking', 'signal-alpha'),
      action('fetch-tracking', 'signal-alpha'),
      action('server-span', 'signal-beta'),
    ];
    const run = (): Promise<ReadinessVerdict> =>
      evaluate(
        { adapters: registry, agents: fakeAgents({ latest: agentReady() }).registry },
        {
          context: context({ serverAgent: { connected: true, projectRoot: PROJECT_ROOT } }),
          plan: plan(actions),
          boundTab: BOUND_TAB,
        },
      );

    const first = await run();

    expect(first.perAdapter.map((report) => report.adapterId)).toEqual([
      'signal-beta',
      'signal-gamma',
      'signal-alpha',
    ]);
    expect([beta, gamma, alpha].map((fake) => fake.calls.length)).toEqual([1, 1, 1]);
    expect(delta.calls).toEqual([]);
    expect(epsilon.calls).toEqual([]);

    const second = await run();

    expect(second.perAdapter.map((report) => report.adapterId)).toEqual(
      first.perAdapter.map((report) => report.adapterId),
    );
    expect([beta, gamma, alpha].map((fake) => fake.calls.length)).toEqual([2, 2, 2]);
  });

  it('derives plannedSignals through deriveAgentHookConfig and deriveServerAgentSignals', async () => {
    const actions = [
      action('state-tracking', PAGE_ADAPTER_ID),
      action('fetch-tracking', PAGE_ADAPTER_ID),
      action('db-query-tracking', 'db-probe'),
      action('function-timing', SERVER_ADAPTER_ID),
    ];
    const expected = derivedSignals(actions);
    const verdict = await evaluate(
      {
        adapters: registryOf(
          pageAdapter(),
          serverAdapter(),
          quietAdapter('db-probe', [{ type: 'db-query-tracking', mode: 'runtime' }]),
        ),
        agents: fakeAgents({ latest: agentReady() }).registry,
      },
      {
        context: context({ serverAgent: { connected: true, projectRoot: PROJECT_ROOT } }),
        plan: plan(actions),
        boundTab: BOUND_TAB,
      },
    );

    expect(verdict.plannedSignals).toEqual(expected);
    // The derivations' own policy shows through — the forced interaction
    // listener, the React prerequisite of state tracking and the server spine
    // — none of which a one-type-one-signal mapping would produce.
    for (const signal of ['interactions', 'react', 'http', 'routeHandlers'] as const) {
      expect(expected).toContain(signal);
    }
    expect(verdict.deliverableSignals.every((signal) => expected.includes(signal))).toBe(true);
  });

  it('returns plain JSON data stamped with the injected clock', async () => {
    const at = NOW + 4_242;
    const flaky = fakeAdapter('flaky-probe', [{ type: 'perf-tracking', mode: 'runtime' }], () =>
      Promise.reject(
        new DebuggenError('INSTRUMENTATION_UNAVAILABLE', 'flaky-probe: the probe failed', {
          hint: 'flaky-probe: evaluate again',
        }),
      ),
    );
    const verdict = await evaluate(
      {
        adapters: registryOf(pageAdapter(), serverAdapter(), flaky),
        agents: fakeAgents({ latest: agentReady({ installedBeforeReact: false }) }).registry,
        now: () => at,
        reloadWaitMs: 0,
      },
      {
        plan: plan([
          action('react-render-tracking', PAGE_ADAPTER_ID),
          action('perf-tracking', 'flaky-probe'),
          action('server-span', SERVER_ADAPTER_ID),
        ]),
        boundTab: BOUND_TAB,
        devServer: detection(),
      },
    );

    expect(verdict.blocking.length).toBeGreaterThan(0);
    expect(verdict.degraded.length).toBeGreaterThan(0);
    expect(verdict.remediations.map((entry) => entry.kind)).toEqual([
      'reload-page',
      'relaunch-dev-server',
    ]);
    expect(JSON.parse(JSON.stringify(verdict))).toStrictEqual(verdict);
    expect(verdict.evaluatedAt).toBe(at);
  });

  it('emits no token, no URL query value and no restated signal label', async () => {
    const token = ['s', 'k', '-', 'probe', '-', 'q'.repeat(24)].join('');
    const queryValue = 'query-marker-9d2e';
    const fragment = 'fragment-marker-9d2e';
    const pageUrl = `${APP_ORIGIN}/widgets?grant=${token}&view=${queryValue}#${fragment}`;
    const tokenShapes: readonly RegExp[] = [
      new RegExp(`${['s', 'k'].join('')}-[A-Za-z0-9_-]{16,}`, 'u'),
      new RegExp(`${['gh', 'p'].join('')}_[A-Za-z0-9]{20,}`, 'u'),
      /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
    ];
    // The shapes are not vacuous: they recognise the planted value.
    expect(tokenShapes.some((shape) => shape.test(token))).toBe(true);

    const { progress, emit } = fakeProgress();
    const flaky = fakeAdapter('flaky-probe', [{ type: 'perf-tracking', mode: 'runtime' }], () =>
      Promise.reject(new Error('flaky-probe: the probe failed')),
    );
    const mixed = (): InstrumentationPlan =>
      plan([
        action('state-tracking', PAGE_ADAPTER_ID),
        action('perf-tracking', 'flaky-probe'),
        action('server-span', SERVER_ADAPTER_ID),
      ]);
    const scenario = (report: AgentReadyPayload | undefined, boundTab?: BoundTab) =>
      evaluate(
        {
          adapters: registryOf(pageAdapter(), serverAdapter(), flaky),
          agents: fakeAgents(report === undefined ? {} : { latest: report }).registry,
          progress,
          reloadWaitMs: 0,
        },
        { plan: mixed(), ...(boundTab === undefined ? {} : { boundTab }) },
      );

    const verdicts = [
      await scenario(agentReady({ url: pageUrl, installedBeforeReact: false }), BOUND_TAB),
      await scenario(agentReady({ url: pageUrl, reactDetected: false }), BOUND_TAB),
      await scenario(agentReady({ url: pageUrl }), BOUND_TAB),
      await scenario(undefined, BOUND_TAB),
      await scenario(agentReady({ url: pageUrl })),
    ];
    const emitted = emit.mock.calls.flatMap(([, row]) =>
      row.detail === undefined ? [row.message] : [row.message, row.detail],
    );
    const strings = [...verdicts.flatMap(verdictStrings), ...emitted];
    const labels = new Set<string>([
      ...Object.values(CAPTURE_SIGNAL_LABELS),
      READY_TO_CAPTURE_MESSAGE,
    ]);

    expect(emitted).toContain(RELOAD_REQUEST_MESSAGE);
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(queryValue);
      expect(text).not.toContain(fragment);
      expect(labels.has(text), `"${text}" restates a label ../sessions/progress.ts owns`).toBe(
        false,
      );
      for (const shape of tokenShapes) {
        expect(shape.test(text), `"${text}" carries a token-shaped string`).toBe(false);
      }
    }
    for (const verdict of verdicts) {
      const serialised = JSON.stringify(verdict);
      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain(queryValue);
      expect(serialised).not.toContain(fragment);
    }
    expect(verdicts[2]?.observed.browserAgent?.url).toBe(`${APP_ORIGIN}/widgets`);
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

  // The static import-boundary guard, mirroring the sibling adapter suites:
  // comments are stripped first, because this module's prose discusses the
  // very modules it must not import.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');

  it('leaves code behind after the comments are stripped', () => {
    expect(stripped).toContain('export async function evaluateReadiness');
    expect(stripped).toContain('export async function collectObservedReadiness');
    expect(stripped).not.toContain('/**');
  });

  it('imports only its permitted layers, each relative import naming a .js file', () => {
    expect(importSpecifiersOf(stripped).length).toBeGreaterThan(0);
    expect(boundaryViolations(stripped)).toEqual([]);
  });

  it('finds the guard able to recognise every kind of violation', () => {
    const planted = [
      "import { installPlan } from './service.js';",
      "import { watchInstrumented } from './watcher.js';",
      "import { detectDevServer } from '../dev-server/detect';",
      "import { PanelHost } from '@debuggen/panel-renderer';",
      "import express from 'express';",
      "const loaded = await import('../sessions/progress');",
      'const home = process.env.DEBUGGEN_HOME;',
      'console.log(home);',
      "const target = 'apps/demo-app/src/page.tsx';",
    ];

    for (const line of planted) {
      expect(boundaryViolations(line).length, `the guard must fire on: ${line}`).toBeGreaterThan(0);
    }
    expect(boundaryViolations("import { ok } from '@debuggen/shared';")).toEqual([]);
    expect(boundaryViolations("import { readFileSync } from 'node:fs';")).toEqual([]);
  });

  it('writes no signal label and no "Ready to capture" wording of its own', () => {
    const literals = new Set<string>();

    for (const match of stripped.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gu)) {
      if (match[2] !== undefined) {
        literals.add(match[2]);
      }
    }

    expect(literals.size).toBeGreaterThan(0);
    for (const owned of [...Object.values(CAPTURE_SIGNAL_LABELS), READY_TO_CAPTURE_MESSAGE]) {
      expect(literals.has(owned), `"${owned}" belongs to ../sessions/progress.ts`).toBe(false);
    }
  });
});

/** The workspace packages `./readiness.ts` may import, besides `node:*` builtins. */
const PERMITTED_PACKAGES: ReadonlySet<string> = new Set([
  '@debuggen/protocol',
  '@debuggen/telemetry',
  '@debuggen/instrumentation',
  '@debuggen/code-analysis',
  '@debuggen/shared',
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

/** Every way a comment-free source breaks the readiness module's boundary. */
function boundaryViolations(code: string): string[] {
  const violations: string[] = [];

  for (const specifier of importSpecifiersOf(code)) {
    if (/^(?:\.\/|\.\.\/instrumentation\/)(?:service|watcher)(?:\.js)?$/u.test(specifier)) {
      violations.push(`imports its consumer or its sibling: ${specifier}`);
    }

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

  if (/apps\/demo-app/u.test(code)) {
    violations.push('names a demo-application path');
  }

  return violations;
}
