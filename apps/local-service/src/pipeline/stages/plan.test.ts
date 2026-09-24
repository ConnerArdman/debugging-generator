/**
 * Colocated unit suite for `./plan.ts`, Stage 3 of the reasoning pipeline
 * (instrumentation planning, AAP §0.4.2).
 *
 * Two assertions are this suite's named minimum:
 *
 * 1. **The gate's order (AAP §0.5.3).** A model's plan passes authoring
 *    validation, then deterministic normalisation, then internal validation,
 *    then feasibility — in that order and no other — and a normaliser or
 *    internal-validation failure is a product defect that is rejected
 *    **without** a re-prompt: the provider is called exactly once.
 * 2. **The fallback is registry-derived and runtime-only.** A rejected plan
 *    falls back to a plan assembled from the registered adapters' own
 *    `createPlan` proposals for this project, and no patch-mode action ever
 *    reaches it.
 *
 * Around them the suite pins what the stage itself owns: the adapter catalog
 * it derives from the live registry (byte-stable, with a newly registered
 * adapter appearing automatically), the four placeholder inputs it hands the
 * context builder (and the question it never reads), the plan version it takes
 * from the store, the record-then-install hand-off, the follow-up delta, the
 * progress rows it does and does not emit, and the privacy of its log records.
 *
 * Everything is in-process and hand-written: a scripted `ModelProvider`, a
 * stub context builder, fake adapters in a real `createAdapterRegistry`, a fake
 * instrumentation service, a recording progress emitter and a capturing logger.
 * The real `normalizePlan` and `checkPlanFeasibility` run, wrapped in spies so
 * their call order is observable. No store, no prompt file, no network and no
 * filesystem. Fixtures use invented, generic vocabulary only. End-to-end
 * behaviour against an indexed fixture project belongs to
 * `test/integration/pipeline-deterministic.test.ts`, and the repair loop's
 * internals to `packages/model-provider/src/structured.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  ACTION_ID_PATTERN,
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  INSTRUMENTATION_ACTION_TYPES,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  SERVER_AGENT_SIGNAL_KEYS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  actionIdentityKey,
  buildReadiness,
  checkPlanFeasibility,
  createAdapterRegistry,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  instrumentationPlanInputSchema,
  instrumentationPlanSchema,
  normalizePlan,
  problemUnderstandingSchema,
  type AdapterClaimTable,
  type AdapterRegistry,
  type CaptureSignal,
  type ClaimingAdapter,
  type FeasibilityReport,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationContext,
  type InstrumentationMode,
  type InstrumentationPlan,
  type InstrumentationPlanInput,
  type ProblemUnderstanding,
  type ReadinessSignal,
} from '@debuggen/instrumentation';
import type * as InstrumentationModule from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  PROMPT_STAGES,
  assertOutboundSafe,
  type ModelProvider,
  type ModelRequest,
  type ModelTextResponse,
  type StructuredAttempt,
  type ToolCallsResponse,
} from '@debuggen/model-provider';
import {
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  type ProgressStage,
  type SessionProgressPayload,
  type SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  createConsoleLogger,
  err,
  ok,
  type LogRecord,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type { ReadinessVerdict } from '../../instrumentation/readiness.js';
import {
  buildDegradationNotice,
  type BuildContextInput,
  type InstallRequest,
  type InstrumentationOutcome,
} from '../../instrumentation/service.js';
import type { RecordPlanInput, RecordedPlan } from '../../sessions/manager.js';
import { CAPTURE_SIGNAL_LABELS, type ProgressRow } from '../../sessions/progress.js';
import type {
  PipelineCodeHandles,
  PipelineStageContext,
  PlanRequestInput,
  StageRequestBuild,
} from '../context-builder.js';
import type { CodeInvestigation } from './investigate.js';
import {
  buildAdapterCatalog,
  buildRuntimeOnlyFallbackPlan,
  contextBoundResolver,
  createPlanStage,
  gateInstrumentationPlan,
  type PlanStageDeps,
  type PlanStageInput,
  type PlanStageResult,
} from './plan.js';

// The real normaliser and feasibility gate run unchanged; wrapping them in
// spies is what makes the gate's call order observable (the precedent of
// `../../main.test.ts`, which wraps one protocol export the same way).
vi.mock('@debuggen/instrumentation', async (importOriginal) => {
  const actual = await importOriginal<typeof InstrumentationModule>();
  return {
    ...actual,
    normalizePlan: vi.fn(actual.normalizePlan),
    checkPlanFeasibility: vi.fn(actual.checkPlanFeasibility),
  };
});

// ---------------------------------------------------------------------------
// Imported vocabulary — never restated where an import can supply it
// ---------------------------------------------------------------------------

/** This stage in protocol's progress vocabulary (pipeline order: understand, investigate, plan). */
const PLAN = PROGRESS_STAGES[2];

/** The stage the installation this stage hands off to reports under. */
const INSTRUMENT = PROGRESS_STAGES[3];

/** The three progress statuses, in protocol's order. */
const [RUNNING, DONE, FAILED] = PROGRESS_STATUSES;

/** The runtime install mode, which touches no file. */
const RUNTIME: InstrumentationMode = 'runtime';

/** The patch install mode, which edits a file. */
const PATCH: InstrumentationMode = 'patch';

/** The schema argument a provider's `generateStructured` receives. */
type StructuredSchema = Parameters<ModelProvider['generateStructured']>[0];

/** The progress surface the stage is given. */
type ProgressApi = PlanStageDeps['progress'];

/** The session failure a `failed` progress row is built from. */
type SessionFailure = Parameters<ProgressApi['stageFailed']>[1];

// ---------------------------------------------------------------------------
// Generic, invented fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-plan-suite';
const PROJECT_ROOT = '/workspace/ledger-tool';
const PROJECT_NAME = 'ledger-tool';
const DEV_SERVER_URL = 'http://127.0.0.1:4173/';
const DEBUGGEN_HOME = '/tmp/plan-suite-home-never-touched';
const FIXED_EPOCH_MS = 1_767_225_600_000;

/** The prompt version the stub builder loads when nothing names another one. */
const BUILDER_DEFAULT_VERSION = 'v007';

/** A marker only the stub builder's rendered prompt contains, so a leak of the prompt is findable. */
const PROMPT_MARKER = 'stub-rendered-plan-prompt';

/** A distinctive word planted in model output; it must never reach a log record of a healthy run. */
const SENTINEL = 'quillmarmotsentinel';

/** The adapter ids of the fake registry — invented, and meaningful only to this suite. */
const PAGE_PROBE = 'page-probe';
const WIRE_PROBE = 'wire-probe';
const SOURCE_PROBE = 'source-probe';
const IDLE_PROBE = 'idle-probe';
const LATE_PROBE = 'late-probe';

/** A file and symbol the fake code graph indexes. */
const INDEXED_FILE = 'src/ledger/totals.ts';
const INDEXED_SYMBOL = 'refreshTotals';

/** A file the fake code graph does not index. */
const UNINDEXED_FILE = 'src/ledger/report.ts';
const UNINDEXED_SYMBOL = 'renderReport';

/** A schema-valid Stage 1 artifact, built from the imported vocabularies. */
const UNDERSTANDING: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0]],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: ['ledger totals'],
});

/** A schema-valid Stage 2 artifact. */
const INVESTIGATION: CodeInvestigation = { relevantFiles: [], flows: [] };

/**
 * The model's plan in the authoring shape: two targetless runtime signals the
 * fake registry claims, with {@link SENTINEL} planted in the objective.
 */
const MODEL_PLAN: InstrumentationPlanInput = {
  objective: `Find where the ledger totals refresh spends its time ${SENTINEL}.`,
  capture: ['interaction timing', 'network requests'],
  instrumentationTargets: [
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
    {
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'fetch-tracking',
      rationale: 'Time the totals request.',
    },
  ],
  hypotheses: ['The totals request is slower than its render.'],
};

/** An authoring-valid plan whose only type no applicable adapter claims: the normaliser refuses it. */
const UNCLAIMED_PLAN: InstrumentationPlanInput = {
  objective: `Track the state transitions of the ledger totals ${SENTINEL}.`,
  capture: ['state transitions'],
  instrumentationTargets: [
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'state-tracking' },
  ],
};

/** An authoring-valid plan whose only action names a file the code index does not hold. */
const INFEASIBLE_PLAN: InstrumentationPlanInput = {
  objective: 'Time the report renderer.',
  capture: ['function timing'],
  instrumentationTargets: [
    { file: UNINDEXED_FILE, symbol: UNINDEXED_SYMBOL, type: 'function-timing' },
  ],
};

/** A model answer the authoring schema rejects: a missing objective and an unknown action type. */
const INVALID_PLAN = {
  capture: ['everything'],
  instrumentationTargets: [{ file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'x-ray' }],
};

// ---------------------------------------------------------------------------
// Small, pure helpers
// ---------------------------------------------------------------------------

/** The success value of a result, or a test failure naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, received ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of a result, or a test failure. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected an Err, received ok.');
  }
  return result.error;
}

/** A log record as one searchable string: its message and every field. */
function serializeRecord(record: LogRecord): string {
  return JSON.stringify({ message: record.message, fields: record.fields });
}

/** Everything an error can carry to a user interface, a log or the store, as one string. */
function serializeError(error: DebuggenError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    details: error.details ?? null,
  });
}

/** The `details.reason` of an error, when it is a string. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.['reason'];
}

/** A vitest mock's call orders, or a test failure when it was never called. */
function callOrders(mock: { readonly mock: { readonly invocationCallOrder: number[] } }): number[] {
  const orders = mock.mock.invocationCallOrder;
  if (orders.length === 0) {
    throw new Error('Expected the mock to have been called.');
  }
  return orders;
}

/** The first call order of a mock. */
function firstOrder(mock: { readonly mock: { readonly invocationCallOrder: number[] } }): number {
  return Math.min(...callOrders(mock));
}

/** The last call order of a mock. */
function lastOrder(mock: { readonly mock: { readonly invocationCallOrder: number[] } }): number {
  return Math.max(...callOrders(mock));
}

/**
 * The product's display labels of the signals a set of actions enables, in
 * signal order — derived exactly as `./plan.ts` derives them, through the
 * product's own hook and server-signal derivations.
 */
function enabledLabelsOf(actions: readonly InstrumentationAction[]): readonly string[] {
  const hooks = deriveAgentHookConfig(actions);
  const server = deriveServerAgentSignals(actions);
  const enabled = new Set<CaptureSignal>();
  for (const key of AGENT_HOOK_KEYS) {
    if (hooks[key]) {
      enabled.add(key);
    }
  }
  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value = server[key];
    if (value === true || (Array.isArray(value) && value.length > 0)) {
      enabled.add(key);
    }
  }
  const signals = CAPTURE_SIGNALS.filter((signal) => enabled.has(signal));
  return [...new Set(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]))];
}

// ---------------------------------------------------------------------------
// Doubles: logger, code handles, instrumentation context
// ---------------------------------------------------------------------------

/** A logger whose records are collected in memory instead of printed. */
interface CapturedLogger {
  readonly logger: Logger;
  readonly records: LogRecord[];
}

function capturedLogger(): CapturedLogger {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

/** The records of one message, in order. */
function recordsWith(records: readonly LogRecord[], message: string): LogRecord[] {
  return records.filter((record) => record.message === message);
}

/**
 * Code-analysis handles over a tiny invented index: {@link INDEXED_FILE}
 * declares {@link INDEXED_SYMBOL}, and nothing else is indexed. Only the three
 * reads the feasibility gate makes are implemented; the stage itself reads
 * none of them. The type assertions stand in for `@debuggen/code-analysis`
 * types this suite deliberately does not construct.
 */
function fakeCode(): PipelineCodeHandles {
  const graph = {
    nodesByFile: (file: string): readonly unknown[] => (file === INDEXED_FILE ? [{ file }] : []),
    files: [],
  };
  const queries = {
    hasSymbol: (file: string, symbol: string): boolean =>
      file === INDEXED_FILE && symbol === INDEXED_SYMBOL,
    findByName: (): readonly unknown[] => [],
  };
  return {
    graph: graph as unknown as PipelineCodeHandles['graph'],
    queries: queries as unknown as PipelineCodeHandles['queries'],
    routeMap: {} as unknown as PipelineCodeHandles['routeMap'],
    projectSummary: {} as unknown as PipelineCodeHandles['projectSummary'],
  };
}

/**
 * A stand-in that records every read and holds nothing — the journal and the
 * backup store. Planning never writes to the project, so any read is a
 * boundary violation the tests report.
 */
function tripwire<T>(name: string, reads: string[]): T {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        reads.push(`${name}.${String(key)}`);
        return undefined;
      },
    },
  ) as unknown as T;
}

/** What a test may vary about an instrumentation context. */
interface InstrumentationContextOptions {
  readonly planVersion?: number | undefined;
  readonly logger?: Logger | undefined;
  readonly code?: PipelineCodeHandles | undefined;
  readonly readiness?: InstrumentationContext['readiness'] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly writeReads?: string[] | undefined;
}

/** A minimal, usable {@link InstrumentationContext} over {@link fakeCode}. */
function instrumentationContext(
  options: InstrumentationContextOptions = {},
): InstrumentationContext {
  const code = options.code ?? fakeCode();
  const writeReads = options.writeReads ?? [];
  return {
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    planVersion: options.planVersion ?? 1,
    debuggenHome: DEBUGGEN_HOME,
    logger: options.logger ?? capturedLogger().logger,
    graph: code.graph,
    queries: code.queries,
    routeMap: code.routeMap,
    projectSummary: code.projectSummary,
    journal: tripwire<InstrumentationContext['journal']>('journal', writeReads),
    backups: tripwire<InstrumentationContext['backups']>('backups', writeReads),
    readiness: options.readiness ?? {},
    now: () => FIXED_EPOCH_MS,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Doubles: fake adapters in a real registry
// ---------------------------------------------------------------------------

/** A proposal an adapter's `createPlan` returns, with an id of the product's shape. */
function proposal(
  adapter: string,
  index: number,
  type: InstrumentationActionType,
  mode: InstrumentationMode,
  target?: { readonly file: string; readonly symbol: string },
): InstrumentationAction {
  return {
    id: `act_${String(index).padStart(16, '0')}`,
    file: target?.file ?? TARGETLESS_FILE,
    symbol: target?.symbol ?? TARGETLESS_SYMBOL,
    type,
    adapter,
    mode,
    rationale: `${adapter} proposes ${type} for this project.`,
  };
}

/** What a fake adapter is made of. */
interface FakeAdapterSpec {
  readonly id: string;
  readonly claims: AdapterClaimTable;
  readonly proposals?: readonly InstrumentationAction[] | undefined;
  readonly signals?: readonly ReadinessSignal[] | undefined;
  /** Whether the adapter applies to the project; defaults to always. */
  readonly applies?: (() => boolean) | undefined;
  /** Runs inside `createPlan`, before it answers. */
  readonly onCreatePlan?: (() => void) | undefined;
  readonly createPlanThrows?: boolean | undefined;
  readonly readinessThrows?: boolean | undefined;
}

/** A fake adapter and the spies on its members. */
interface FakeAdapter {
  readonly adapter: ClaimingAdapter;
  readonly createPlan: Mock<ClaimingAdapter['createPlan']>;
  readonly install: Mock<ClaimingAdapter['install']>;
  readonly remove: Mock<ClaimingAdapter['remove']>;
  readonly readiness: Mock<ClaimingAdapter['readiness']>;
}

/**
 * An adapter that declares `claims`, proposes the given actions, reports the
 * given readiness rows and refuses to install or remove anything: the plan
 * stage hands installation to the instrumentation service, never to an
 * adapter.
 */
function fakeAdapter(spec: FakeAdapterSpec): FakeAdapter {
  const createPlan = vi.fn<ClaimingAdapter['createPlan']>(() => {
    spec.onCreatePlan?.();
    if (spec.createPlanThrows === true) {
      return Promise.reject(new Error('the adapter could not propose anything'));
    }
    return Promise.resolve([...(spec.proposals ?? [])]);
  });
  const install = vi.fn<ClaimingAdapter['install']>(() =>
    Promise.reject(new Error('the plan stage must not install through an adapter')),
  );
  const remove = vi.fn<ClaimingAdapter['remove']>(() =>
    Promise.reject(new Error('the plan stage must not remove through an adapter')),
  );
  const readiness = vi.fn<ClaimingAdapter['readiness']>(() => {
    if (spec.readinessThrows === true) {
      return Promise.reject(new Error('the readiness probe failed'));
    }
    return Promise.resolve(
      buildReadiness({
        adapter: spec.id,
        signals: [...(spec.signals ?? [])],
        now: () => FIXED_EPOCH_MS,
      }),
    );
  });
  const adapter: ClaimingAdapter = {
    id: spec.id,
    claims: spec.claims,
    canHandle: () => spec.applies?.() ?? true,
    createPlan,
    install,
    remove,
    readiness,
  };
  return { adapter, createPlan, install, remove, readiness };
}

/** The adapters most tests register, and the registry built over them. */
interface FakeRegistry {
  readonly registry: AdapterRegistry;
  readonly page: FakeAdapter;
  readonly wire: FakeAdapter;
  readonly source: FakeAdapter;
  readonly idle: FakeAdapter;
}

/**
 * Four invented adapters:
 *
 * - `page-probe` — runtime; claims interaction and performance tracking and
 *   proposes both, plus one **patch-mode** proposal the fallback must drop.
 * - `wire-probe` — runtime; claims request tracking and proposes it.
 * - `source-probe` — patch; claims function timing and server spans and
 *   proposes a server span (file-changing, so never in a fallback).
 * - `idle-probe` — runtime; claims state tracking, but does not apply to this
 *   project, so it is never asked for a proposal.
 */
function fakeRegistry(order: 'forward' | 'reverse' = 'forward'): FakeRegistry {
  const page = fakeAdapter({
    id: PAGE_PROBE,
    claims: { 'interaction-tracking': RUNTIME, 'perf-tracking': RUNTIME },
    proposals: [
      proposal(PAGE_PROBE, 1, 'interaction-tracking', RUNTIME),
      proposal(PAGE_PROBE, 2, 'function-timing', PATCH, {
        file: INDEXED_FILE,
        symbol: INDEXED_SYMBOL,
      }),
      proposal(PAGE_PROBE, 3, 'perf-tracking', RUNTIME),
    ],
    signals: [
      { signal: 'perf', status: 'degraded', reason: 'long-task entries are not reported here' },
      {
        signal: 'interactions',
        status: 'available',
        hint: 'Relaunch with /private/relaunch/command when this changes.',
      },
    ],
  });
  const wire = fakeAdapter({
    id: WIRE_PROBE,
    claims: { 'fetch-tracking': RUNTIME },
    proposals: [proposal(WIRE_PROBE, 4, 'fetch-tracking', RUNTIME)],
    signals: [
      {
        signal: 'fetch',
        status: 'unavailable',
        reason: 'no inspected page is bound',
        hint: 'Open the panel on /private/tab/path.',
      },
    ],
  });
  const source = fakeAdapter({
    id: SOURCE_PROBE,
    claims: { 'function-timing': PATCH, 'server-span': PATCH },
    proposals: [
      proposal(SOURCE_PROBE, 5, 'server-span', PATCH, {
        file: INDEXED_FILE,
        symbol: INDEXED_SYMBOL,
      }),
    ],
    signals: [{ signal: 'functions', status: 'available' }],
  });
  const idle = fakeAdapter({
    id: IDLE_PROBE,
    claims: { 'state-tracking': RUNTIME },
    proposals: [proposal(IDLE_PROBE, 6, 'state-tracking', RUNTIME)],
    signals: [{ signal: 'state', status: 'available' }],
    applies: () => false,
  });
  const adapters = [page, wire, source, idle].map((fake) => fake.adapter);
  const registry = createAdapterRegistry({
    adapters: order === 'forward' ? adapters : [...adapters].reverse(),
  });
  return { registry, page, wire, source, idle };
}

// ---------------------------------------------------------------------------
// Double: the scripted model provider
// ---------------------------------------------------------------------------

/** One scripted outcome of one `generateStructured` call. */
type ScriptedOutcome =
  | { readonly kind: 'attempt'; readonly raw: unknown }
  | { readonly kind: 'error'; readonly error: DebuggenError };

/** An attempt whose decoded output is `raw`. */
function answer(raw: unknown): ScriptedOutcome {
  return { kind: 'attempt', raw };
}

/** The provider-unavailable failure a transport would report. */
function unavailableError(): DebuggenError {
  return new DebuggenError('MODEL_UNAVAILABLE', 'Model provider unavailable (test-transport).', {
    hint: 'Check the provider configuration, then retry the stage.',
    details: { transport: 'scripted' },
  });
}

/**
 * A {@link ModelProvider} that makes exactly one attempt per call, answering
 * each `generateStructured` call with the next queued outcome. It never
 * validates, repairs or retries: those belong to the upstream loop whose call
 * counts the tests observe. `structured` is a spy called once per attempt, so
 * the attempt's position in the global call order is observable.
 */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted-test-provider';
  readonly structured = vi.fn<(request: ModelRequest) => void>();
  readonly other: string[] = [];
  readonly #queue: ScriptedOutcome[];

  constructor(outcomes: readonly ScriptedOutcome[] = []) {
    this.#queue = [...outcomes];
  }

  generateText(): Promise<Result<ModelTextResponse, DebuggenError>> {
    this.other.push('generateText');
    return Promise.resolve(err(new DebuggenError('INTERNAL', 'Not part of the plan stage.')));
  }

  generateStructured<T>(
    _schema: StructuredSchema,
    request: ModelRequest,
  ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
    this.structured(request);
    const next = this.#queue.shift();
    if (next === undefined) {
      return Promise.resolve(
        err(new DebuggenError('INTERNAL', 'The scripted provider has no outcome queued.')),
      );
    }
    if (next.kind === 'error') {
      return Promise.resolve(err(next.error));
    }
    const attempt: StructuredAttempt<T> = {
      raw: next.raw,
      model: 'scripted-model',
      providerId: this.id,
    };
    return Promise.resolve(ok(attempt));
  }

  callTools(): Promise<Result<ToolCallsResponse, DebuggenError>> {
    this.other.push('callTools');
    return Promise.resolve(err(new DebuggenError('INTERNAL', 'Not part of the plan stage.')));
  }
}

// ---------------------------------------------------------------------------
// Double: the stub context builder
// ---------------------------------------------------------------------------

/** How the stub answers `buildPlanRequest`: a request, or the given refusal. */
type BuildMode = { readonly kind: 'ok' } | { readonly kind: 'fail'; readonly error: DebuggenError };

/**
 * A plan-request builder that records its input and answers with a request
 * whose prompt is {@link PROMPT_MARKER}. It follows the real builder's
 * version rule — an explicit version, else the session's, else the manifest's
 * current one — and carries the context's signal onto the request.
 */
class StubPlanBuilder implements Pick<PlanStageDeps['contextBuilder'], 'buildPlanRequest'> {
  readonly calls: PlanRequestInput[] = [];
  readonly #mode: BuildMode;

  constructor(mode: BuildMode = { kind: 'ok' }) {
    this.#mode = mode;
  }

  buildPlanRequest(input: PlanRequestInput): Result<StageRequestBuild, DebuggenError> {
    this.calls.push(input);
    if (this.#mode.kind === 'fail') {
      return err(this.#mode.error);
    }
    const { context } = input;
    const promptVersion =
      input.promptVersion ?? context.promptVersions[PLAN] ?? BUILDER_DEFAULT_VERSION;
    const signal = input.signal ?? context.signal;
    const request: ModelRequest = {
      prompt: PROMPT_MARKER,
      input: { section: 'plan' },
      metadata: { stage: PLAN, promptVersion, sessionId: context.sessionId },
      ...(signal !== undefined ? { signal } : {}),
    };
    return ok({ request, stage: PLAN, promptVersion, truncated: [], bytes: PROMPT_MARKER.length });
  }
}

// ---------------------------------------------------------------------------
// Double: the recording progress emitter
// ---------------------------------------------------------------------------

/** One recorded progress call. */
interface ProgressCall {
  readonly method: 'emit' | 'stageStarted' | 'stageCompleted' | 'stageFailed';
  readonly stage: ProgressStage;
  readonly row?: ProgressRow;
  readonly failure?: SessionFailure;
}

/** Whether every progress method succeeds, answers `Err`, or throws. */
type ProgressBehaviour = 'ok' | 'err' | 'throw';

/** A progress emitter that records every call and answers per its behaviour. */
class RecordingProgress implements ProgressApi {
  readonly calls: ProgressCall[] = [];
  readonly #behaviour: ProgressBehaviour;

  constructor(behaviour: ProgressBehaviour = 'ok') {
    this.#behaviour = behaviour;
  }

  /** `method:stage` of every call, in order. */
  get trail(): readonly string[] {
    return this.calls.map((call) => `${call.method}:${call.stage}`);
  }

  emit(sessionId: string, row: ProgressRow): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'emit', stage: row.stage, row });
    return this.#answer(sessionId, row.stage, row.status);
  }

  stageStarted(
    sessionId: string,
    stage: ProgressStage,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'stageStarted', stage });
    return this.#answer(sessionId, stage, RUNNING);
  }

  stageCompleted(
    sessionId: string,
    stage: ProgressStage,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'stageCompleted', stage });
    return this.#answer(sessionId, stage, DONE);
  }

  stageFailed(
    sessionId: string,
    failure: SessionFailure,
  ): Result<SessionProgressPayload, DebuggenError> {
    this.calls.push({ method: 'stageFailed', stage: failure.stage, failure });
    return this.#answer(sessionId, failure.stage, FAILED);
  }

  #answer(
    sessionId: string,
    stage: ProgressStage,
    status: SessionProgressPayload['status'],
  ): Result<SessionProgressPayload, DebuggenError> {
    if (this.#behaviour === 'throw') {
      throw new Error('The progress double was told to throw.');
    }
    if (this.#behaviour === 'err') {
      return err(new DebuggenError('STORE_ERROR', 'The progress double was told to fail.'));
    }
    return ok({ sessionId, stage, status, message: 'row recorded by the progress double' });
  }
}

// ---------------------------------------------------------------------------
// Doubles: the instrumentation service, the store and the session manager
// ---------------------------------------------------------------------------

/** A satisfied readiness verdict; the stage only carries it through. */
function satisfiedVerdict(): ReadinessVerdict {
  return {
    satisfied: true,
    perAdapter: [],
    blocking: [],
    degraded: [],
    remediations: [],
    plannedSignals: [],
    deliverableSignals: [],
    evaluatedAt: FIXED_EPOCH_MS,
    observed: {},
    reloadRequested: false,
  };
}

/** The outcome a successful install of `request.plan` reports. */
function outcomeFor(request: InstallRequest): InstrumentationOutcome {
  const actions = request.plan.instrumentationTargets;
  return {
    sessionId: request.sessionId,
    planVersion: request.plan.planVersion,
    activePlanVersion: request.plan.planVersion,
    applied: [],
    runtimeHooks: [],
    unavailable: [],
    agentHooks: deriveAgentHookConfig(actions),
    serverSignals: deriveServerAgentSignals(actions),
    readiness: satisfiedVerdict(),
    degradations: [],
  };
}

/** The fake instrumentation service and what it saw. */
interface FakeInstrumentation {
  readonly service: PlanStageDeps['instrumentation'];
  readonly buildContext: Mock<PlanStageDeps['instrumentation']['buildContext']>;
  readonly install: Mock<PlanStageDeps['instrumentation']['install']>;
  /** Every read of the journal or backup store of a context it built; must stay empty. */
  readonly writeReads: string[];
}

/**
 * An instrumentation service whose `buildContext` returns a real-shaped
 * context over the code handles it is given, and whose `install` answers with
 * the configured outcome.
 */
function fakeInstrumentation(
  logger: Logger,
  installAnswer?: (request: InstallRequest) => Result<InstrumentationOutcome, DebuggenError>,
): FakeInstrumentation {
  const writeReads: string[] = [];
  const buildContext = vi.fn<PlanStageDeps['instrumentation']['buildContext']>(
    (input: BuildContextInput) =>
      ok(
        instrumentationContext({
          planVersion: input.plan.planVersion,
          logger,
          code: {
            graph: input.code.graph,
            queries: input.code.queries,
            routeMap: input.code.routeMap,
            projectSummary: input.code.summary,
          },
          readiness: input.readiness,
          signal: input.signal,
          writeReads,
        }),
      ),
  );
  const install = vi.fn<PlanStageDeps['instrumentation']['install']>((request) =>
    Promise.resolve(installAnswer === undefined ? ok(outcomeFor(request)) : installAnswer(request)),
  );
  return { service: { buildContext, install }, buildContext, install, writeReads };
}

/** A stored session record in the status the plan stage runs under. */
function sessionRecord(plans: readonly InstrumentationPlan[] = []): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: PROJECT_NAME,
    devServerUrl: DEV_SERVER_URL,
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'planning',
    question: `Why do the ledger totals refresh slowly ${SENTINEL}?`,
    followUps: [],
    relevantFiles: [],
    plans: [...plans],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  };
}

/** A session manager whose `recordPlan` stamps the plan the way the real one does. */
function fakeSessionManager(): {
  readonly manager: PlanStageDeps['sessionManager'];
  readonly recordPlan: Mock<PlanStageDeps['sessionManager']['recordPlan']>;
} {
  const recordPlan = vi.fn<PlanStageDeps['sessionManager']['recordPlan']>(
    (sessionId: string, plan: RecordPlanInput): Promise<Result<RecordedPlan, DebuggenError>> => {
      const stored: InstrumentationPlan = {
        ...plan,
        sessionId,
        planVersion: plan.planVersion ?? 1,
      };
      return Promise.resolve(ok({ session: sessionRecord([stored]), plan: stored }));
    },
  );
  return { manager: { recordPlan }, recordPlan };
}

// ---------------------------------------------------------------------------
// Fixture builders: the stage context and the harness
// ---------------------------------------------------------------------------

/** A stage context and the probes planted in it. */
interface ContextFixture {
  readonly context: PipelineStageContext;
  readonly contextLog: CapturedLogger;
  /** Every read of the developer's question; the stage must leave it empty. */
  readonly questionReads: string[];
}

/**
 * A minimal valid {@link PipelineStageContext}. The question is behind a
 * getter that records every read: nothing in the plan stage may consult it
 * (AAP §0.5.4).
 */
function stageContext(signal?: AbortSignal): ContextFixture {
  const session = sessionRecord();
  const contextLog = capturedLogger();
  const questionReads: string[] = [];
  const context: PipelineStageContext = {
    sessionId: session.id,
    session,
    projectRoot: session.projectRoot,
    get question(): string {
      questionReads.push('question');
      return session.question;
    },
    code: fakeCode(),
    promptVersions: session.promptVersions,
    logger: contextLog.logger,
    now: () => FIXED_EPOCH_MS,
    ...(signal !== undefined ? { signal } : {}),
  };
  return { context, contextLog, questionReads };
}

/** What a test may vary about the stage's collaborators. */
interface HarnessOptions {
  readonly outcomes?: readonly ScriptedOutcome[] | undefined;
  readonly build?: BuildMode | undefined;
  readonly progress?: ProgressBehaviour | undefined;
  readonly maxRepairs?: number | undefined;
  readonly nextPlanVersion?: number | undefined;
  readonly registry?: FakeRegistry | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly installAnswer?:
    ((request: InstallRequest) => Result<InstrumentationOutcome, DebuggenError>) | undefined;
}

/** A plan stage wired to recording doubles. */
interface Harness {
  readonly run: (
    input?: Partial<PlanStageInput>,
  ) => Promise<Result<PlanStageResult, DebuggenError>>;
  readonly provider: ScriptedProvider;
  readonly builder: StubPlanBuilder;
  readonly progress: RecordingProgress;
  readonly instrumentation: FakeInstrumentation;
  readonly recordPlan: Mock<PlanStageDeps['sessionManager']['recordPlan']>;
  readonly nextPlanVersion: Mock<PlanStageDeps['sessions']['nextPlanVersion']>;
  readonly fakes: FakeRegistry;
  readonly fixture: ContextFixture;
}

function harness(options: HarnessOptions = {}): Harness {
  const fixture = stageContext(options.signal);
  const provider = new ScriptedProvider(options.outcomes ?? [answer(MODEL_PLAN)]);
  const builder = new StubPlanBuilder(options.build);
  const progress = new RecordingProgress(options.progress);
  const fakes = options.registry ?? fakeRegistry();
  const instrumentation = fakeInstrumentation(fixture.contextLog.logger, options.installAnswer);
  const { manager, recordPlan } = fakeSessionManager();
  const nextPlanVersion = vi.fn<PlanStageDeps['sessions']['nextPlanVersion']>(() =>
    ok(options.nextPlanVersion ?? 3),
  );
  const stage = createPlanStage({
    contextBuilder: builder,
    provider,
    registry: fakes.registry,
    instrumentation: instrumentation.service,
    sessions: { nextPlanVersion },
    sessionManager: manager,
    progress,
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
  });
  return {
    run: (input = {}) =>
      stage.run(fixture.context, {
        understanding: UNDERSTANDING,
        investigation: INVESTIGATION,
        ...input,
      }),
    provider,
    builder,
    progress,
    instrumentation,
    recordPlan,
    nextPlanVersion,
    fakes,
    fixture,
  };
}

/** The plan the session manager was asked to record, or a test failure. */
function recordedPlanOf(h: Harness): RecordPlanInput {
  const call = h.recordPlan.mock.calls[0];
  if (call === undefined) {
    throw new Error('Expected a plan to have been recorded.');
  }
  return call[1];
}

/** The install request the instrumentation service received, or a test failure. */
function installRequestOf(h: Harness): InstallRequest {
  const call = h.instrumentation.install.mock.calls[0];
  if (call === undefined) {
    throw new Error('Expected an install request.');
  }
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Makes the next `normalizePlan` call signal the moment it has returned, so a
 * test can tell the stage's own internal validation apart from the parse the
 * normaliser runs inside itself.
 */
async function markNormalizerReturn(): Promise<Mock<() => void>> {
  const actual = await vi.importActual<typeof InstrumentationModule>('@debuggen/instrumentation');
  const returned = vi.fn<() => void>();
  vi.mocked(normalizePlan).mockImplementationOnce((input, context) => {
    const result = actual.normalizePlan(input, context);
    returned();
    return result;
  });
  return returned;
}

/** The first feasibility report the gate produced, or a test failure. */
function firstFeasibilityReport(): FeasibilityReport {
  const first = vi.mocked(checkPlanFeasibility).mock.results[0];
  if (first?.type !== 'return') {
    throw new Error('Expected the feasibility gate to have returned a report.');
  }
  return first.value;
}

/**
 * An outbound-guard refusal produced by the real `assertOutboundSafe`, from a
 * bearer credential assembled at run time so this tracked file holds no
 * contiguous credential-shaped literal.
 */
function outboundRefusal(): DebuggenError {
  const credential = ['Bea', 'rer '].join('') + 'Zq8Lm2Vx'.repeat(5);
  const guarded = assertOutboundSafe({
    prompt: credential,
    input: {},
    metadata: { stage: PLAN, promptVersion: BUILDER_DEFAULT_VERSION, sessionId: SESSION_ID },
  });
  return expectErr(guarded);
}

// ===========================================================================
// The adapter catalog — `{{adapterCatalog}}`
// ===========================================================================

describe('buildAdapterCatalog', () => {
  it('derives one entry per adapter and mode from the live registry, sorted, with no hints', async () => {
    const fakes = fakeRegistry();
    const context = instrumentationContext();

    const catalog = await buildAdapterCatalog(fakes.registry, context);

    // Sorted by adapter id; the adapter that does not apply to the project is absent.
    expect(catalog.map((entry) => entry.adapter)).toEqual([PAGE_PROBE, SOURCE_PROBE, WIRE_PROBE]);
    expect(catalog).toEqual([
      {
        adapter: PAGE_PROBE,
        mode: RUNTIME,
        changesFiles: false,
        actionTypes: ['interaction-tracking', 'perf-tracking'],
        signals: CAPTURE_SIGNALS.filter((signal) => signal === 'interactions' || signal === 'perf'),
        preconditions: [
          { signal: 'perf', status: 'degraded', reason: 'long-task entries are not reported here' },
        ],
      },
      {
        adapter: SOURCE_PROBE,
        mode: PATCH,
        changesFiles: true,
        actionTypes: ['function-timing', 'server-span'],
        signals: ['functions'],
        preconditions: [],
      },
      {
        adapter: WIRE_PROBE,
        mode: RUNTIME,
        changesFiles: false,
        actionTypes: ['fetch-tracking'],
        signals: ['fetch'],
        preconditions: [
          { signal: 'fetch', status: 'unavailable', reason: 'no inspected page is bound' },
        ],
      },
    ]);

    // Every entry states exactly what normalisation will be told for this project.
    for (const entry of catalog) {
      for (const type of entry.actionTypes) {
        expect(fakes.registry.resolveActionType(type, context)).toEqual({
          adapter: entry.adapter,
          mode: entry.mode,
        });
      }
      const ranks = entry.actionTypes.map((type) => INSTRUMENTATION_ACTION_TYPES.indexOf(type));
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    }

    // A type no applicable adapter claims appears nowhere, and its adapter was never asked.
    expect(catalog.flatMap((entry) => entry.actionTypes)).not.toContain('state-tracking');
    expect(fakes.idle.readiness).not.toHaveBeenCalled();

    // Hints can carry local paths; none reaches the model payload.
    expect(JSON.stringify(catalog)).not.toContain('/private/');
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('is byte-stable across calls and registration orders', async () => {
    const first = JSON.stringify(
      await buildAdapterCatalog(fakeRegistry().registry, instrumentationContext()),
    );
    const again = JSON.stringify(
      await buildAdapterCatalog(fakeRegistry().registry, instrumentationContext()),
    );
    const reversed = JSON.stringify(
      await buildAdapterCatalog(fakeRegistry('reverse').registry, instrumentationContext()),
    );

    expect(again).toBe(first);
    expect(reversed).toBe(first);
  });

  it('includes an adapter registered after the registry was built, with no change to the stage', async () => {
    const fakes = fakeRegistry();
    const late = fakeAdapter({
      id: LATE_PROBE,
      claims: { 'db-query-tracking': RUNTIME },
      signals: [{ signal: 'pg', status: 'available' }],
    });
    expectOk(fakes.registry.register(late.adapter));

    const catalog = await buildAdapterCatalog(fakes.registry, instrumentationContext());

    expect(catalog.map((entry) => entry.adapter)).toEqual([
      LATE_PROBE,
      PAGE_PROBE,
      SOURCE_PROBE,
      WIRE_PROBE,
    ]);
    expect(catalog[0]).toEqual({
      adapter: LATE_PROBE,
      mode: RUNTIME,
      changesFiles: false,
      actionTypes: ['db-query-tracking'],
      signals: ['pg'],
      preconditions: [],
    });
  });

  it('keeps an adapter whose readiness probe throws, with no signal rows, logging only its id', async () => {
    const broken = fakeAdapter({
      id: LATE_PROBE,
      claims: { 'db-query-tracking': RUNTIME },
      readinessThrows: true,
    });
    const log = capturedLogger();

    const catalog = await buildAdapterCatalog(
      createAdapterRegistry({ adapters: [broken.adapter] }),
      instrumentationContext({ logger: log.logger }),
    );

    expect(catalog).toEqual([
      {
        adapter: LATE_PROBE,
        mode: RUNTIME,
        changesFiles: false,
        actionTypes: ['db-query-tracking'],
        signals: [],
        preconditions: [],
      },
    ]);
    const warnings = log.records.filter((record) => record.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields['adapter']).toBe(LATE_PROBE);
    expect(serializeRecord(warnings[0]!)).not.toContain('readiness probe failed');
  });
});

// ===========================================================================
// Steps 2–4 of the gate
// ===========================================================================

describe('gateInstrumentationPlan', () => {
  it('normalises, then validates internally, then checks feasibility — in that order', async () => {
    const returned = await markNormalizerReturn();
    const internal = vi.spyOn(instrumentationPlanSchema, 'safeParse');
    const context = instrumentationContext({ planVersion: 2 });

    const outcome = gateInstrumentationPlan(MODEL_PLAN, {
      registry: fakeRegistry().registry,
      context,
    });

    if (outcome.kind !== 'accepted') {
      throw new Error(`Expected the plan to be accepted, received ${outcome.kind}.`);
    }
    const normalized = firstOrder(vi.mocked(normalizePlan));
    const normalizerReturned = firstOrder(returned);
    const feasibility = firstOrder(vi.mocked(checkPlanFeasibility));

    expect(normalized).toBeLessThan(normalizerReturned);
    // Exactly one internal validation between the normaliser returning and feasibility.
    const between = internal.mock.invocationCallOrder.filter(
      (order) => order > normalizerReturned && order < feasibility,
    );
    expect(between).toHaveLength(1);
    const betweenIndex = internal.mock.invocationCallOrder.indexOf(between[0]!);
    expect(internal.mock.calls[betweenIndex]?.[0]).toEqual(outcome.plan);
    // Feasibility judged the internally validated plan, against this context.
    expect(vi.mocked(checkPlanFeasibility)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkPlanFeasibility).mock.calls[0]?.[0]).toBe(outcome.plan);
    expect(vi.mocked(checkPlanFeasibility).mock.calls[0]?.[1]).toBe(context);
    expect(outcome.plan.planVersion).toBe(2);
    expect(outcome.plan.sessionId).toBe(SESSION_ID);
  });

  it('assigns adapter, mode and ids through the registry, keeping authored order and duplicates', () => {
    const duplicated: InstrumentationPlanInput = {
      ...MODEL_PLAN,
      instrumentationTargets: [
        ...MODEL_PLAN.instrumentationTargets,
        { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
      ],
    };

    const outcome = gateInstrumentationPlan(duplicated, {
      registry: fakeRegistry().registry,
      context: instrumentationContext(),
    });

    if (outcome.kind !== 'accepted') {
      throw new Error(`Expected the plan to be accepted, received ${outcome.kind}.`);
    }
    const actions = outcome.plan.instrumentationTargets;
    expect(actions.map((action) => [action.type, action.adapter, action.mode])).toEqual([
      ['interaction-tracking', PAGE_PROBE, RUNTIME],
      ['fetch-tracking', WIRE_PROBE, RUNTIME],
      ['interaction-tracking', PAGE_PROBE, RUNTIME],
    ]);
    for (const action of actions) {
      expect(action.id).toMatch(ACTION_ID_PATTERN);
    }
    // An absent rationale is filled from the objective; an authored one is kept.
    expect(actions[0]?.rationale).toBe(MODEL_PLAN.objective);
    expect(actions[1]?.rationale).toBe('Time the totals request.');
    // The duplicate survives normalisation and is refused by feasibility, as data.
    expect(outcome.feasibility.feasible).toHaveLength(2);
    expect(outcome.feasibility.rejected.map((refusal) => refusal.code)).toEqual([
      'duplicate-action',
    ]);
  });

  it('rejects a plan the normaliser refuses as a logged product defect, without checking feasibility', () => {
    const log = capturedLogger();

    const outcome = gateInstrumentationPlan(UNCLAIMED_PLAN, {
      registry: fakeRegistry().registry,
      context: instrumentationContext({ logger: log.logger }),
    });

    if (outcome.kind !== 'rejected') {
      throw new Error(`Expected the plan to be rejected, received ${outcome.kind}.`);
    }
    expect(outcome.reason).toBe('normalization-failed');
    expect(outcome.error.details?.['stage']).toBe(PLAN);
    expect(outcome.plan).toBeUndefined();
    expect(vi.mocked(checkPlanFeasibility)).not.toHaveBeenCalled();

    const defects = log.records.filter(
      (record) => record.level === 'error' && record.fields['step'] === 'normalize',
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]?.fields['input']).toEqual(UNCLAIMED_PLAN);
  });

  it('rejects a normaliser output that fails the internal schema, naming paths and codes only', () => {
    const log = capturedLogger();
    const defective: InstrumentationPlan = {
      version: 1,
      planVersion: 1,
      sessionId: SESSION_ID,
      objective: MODEL_PLAN.objective,
      hypotheses: [],
      capture: [],
      instrumentationTargets: [
        { ...proposal(PAGE_PROBE, 1, 'interaction-tracking', RUNTIME), id: 'not-an-opaque-id' },
      ],
    };
    vi.mocked(normalizePlan).mockReturnValueOnce(ok(defective));

    const outcome = gateInstrumentationPlan(MODEL_PLAN, {
      registry: fakeRegistry().registry,
      context: instrumentationContext({ logger: log.logger }),
    });

    if (outcome.kind !== 'rejected') {
      throw new Error(`Expected the plan to be rejected, received ${outcome.kind}.`);
    }
    expect(outcome.reason).toBe('internal-validation-failed');
    expect(outcome.error.code).toBe('PLAN_INVALID');
    expect(reasonOf(outcome.error)).toBe('internal-validation');
    const issues = outcome.error.details?.['issues'];
    expect(Array.isArray(issues)).toBe(true);
    expect(JSON.stringify(issues)).toContain('instrumentationTargets.0.id');
    expect(serializeError(outcome.error)).not.toContain('not-an-opaque-id');
    expect(serializeError(outcome.error)).not.toContain(SENTINEL);
    expect(vi.mocked(checkPlanFeasibility)).not.toHaveBeenCalled();
    expect(
      log.records.filter(
        (record) => record.level === 'error' && record.fields['step'] === 'internal-validation',
      ),
    ).toHaveLength(1);
  });

  it('rejects a plan with no feasible action as infeasible, attaching the plan and its report', () => {
    const outcome = gateInstrumentationPlan(INFEASIBLE_PLAN, {
      registry: fakeRegistry().registry,
      context: instrumentationContext(),
    });

    if (outcome.kind !== 'rejected') {
      throw new Error(`Expected the plan to be rejected, received ${outcome.kind}.`);
    }
    expect(outcome.reason).toBe('infeasible');
    expect(outcome.error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(outcome.error.details?.['codes']).toEqual(['file-not-indexed']);
    expect(outcome.plan?.instrumentationTargets).toHaveLength(1);
    expect(outcome.feasibility?.feasible).toEqual([]);
    expect(outcome.feasibility?.rejected.map((refusal) => refusal.code)).toEqual([
      'file-not-indexed',
    ]);
    expect(outcome.error.hint).toBe(outcome.feasibility?.rejected[0]?.hint);
  });

  it('accepts a partially feasible plan and leaves the infeasible action in place', () => {
    const partial: InstrumentationPlanInput = {
      ...MODEL_PLAN,
      instrumentationTargets: [
        ...MODEL_PLAN.instrumentationTargets,
        ...INFEASIBLE_PLAN.instrumentationTargets,
      ],
    };

    const outcome = gateInstrumentationPlan(partial, {
      registry: fakeRegistry().registry,
      context: instrumentationContext(),
    });

    if (outcome.kind !== 'accepted') {
      throw new Error(`Expected the plan to be accepted, received ${outcome.kind}.`);
    }
    expect(outcome.plan.instrumentationTargets).toHaveLength(3);
    expect(outcome.feasibility.feasible).toHaveLength(2);
    expect(outcome.feasibility.rejected.map((refusal) => refusal.code)).toEqual([
      'file-not-indexed',
    ]);
  });

  it('reports a context the feasibility gate cannot use as a failure, not a rejection', () => {
    const code = fakeCode();
    const unusable = instrumentationContext({
      code: { ...code, queries: {} as unknown as PipelineCodeHandles['queries'] },
    });

    const outcome = gateInstrumentationPlan(MODEL_PLAN, {
      registry: fakeRegistry().registry,
      context: unusable,
    });

    if (outcome.kind !== 'failed') {
      throw new Error(`Expected the gate to fail, received ${outcome.kind}.`);
    }
    expect(outcome.error.code).toBe('INTERNAL');
    expect(outcome.error.details?.['stage']).toBe(PLAN);
  });

  it('reuses the previous version’s ids for every surviving action on a follow-up', () => {
    const registry = fakeRegistry().registry;
    const first = gateInstrumentationPlan(MODEL_PLAN, {
      registry,
      context: instrumentationContext({ planVersion: 1 }),
    });
    if (first.kind !== 'accepted') {
      throw new Error(`Expected the first plan to be accepted, received ${first.kind}.`);
    }
    const previous = first.plan.instrumentationTargets;
    const extended: InstrumentationPlanInput = {
      ...MODEL_PLAN,
      instrumentationTargets: [
        ...MODEL_PLAN.instrumentationTargets,
        { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'perf-tracking' },
      ],
    };

    const second = gateInstrumentationPlan(extended, {
      registry,
      context: instrumentationContext({ planVersion: 2 }),
      previousActions: previous,
    });

    if (second.kind !== 'accepted') {
      throw new Error(`Expected the follow-up plan to be accepted, received ${second.kind}.`);
    }
    const actions = second.plan.instrumentationTargets;
    expect(actions.slice(0, 2).map((action) => action.id)).toEqual(
      previous.map((action) => action.id),
    );
    expect(actions.slice(0, 2).map((action) => actionIdentityKey(action))).toEqual(
      previous.map((action) => actionIdentityKey(action)),
    );
    expect(actions[2]?.id).toMatch(ACTION_ID_PATTERN);
    expect(previous.map((action) => action.id)).not.toContain(actions[2]?.id);
  });
});

// ===========================================================================
// The context-bound resolver
// ===========================================================================

describe('contextBoundResolver', () => {
  it('answers only for adapters that apply to the project, and never throws', () => {
    const fakes = fakeRegistry();
    const resolver = contextBoundResolver(fakes.registry, instrumentationContext());

    expect(resolver.resolveActionType('fetch-tracking')).toEqual({
      adapter: WIRE_PROBE,
      mode: RUNTIME,
    });
    // Claimed, but only by an adapter that does not apply here.
    expect(resolver.resolveActionType('state-tracking')).toBeUndefined();

    const throwing: AdapterRegistry = {
      ...fakes.registry,
      resolveActionType: () => {
        throw new Error('a substitute registry that throws');
      },
    };
    expect(
      contextBoundResolver(throwing, instrumentationContext()).resolveActionType('fetch-tracking'),
    ).toBeUndefined();
  });
});

// ===========================================================================
// The one sanctioned fallback — a runtime-only default plan
// ===========================================================================

describe('buildRuntimeOnlyFallbackPlan', () => {
  it('is assembled from the applicable adapters’ own proposals and holds no patch-mode action', async () => {
    const fakes = fakeRegistry();
    const context = instrumentationContext();

    const built = expectOk(
      await buildRuntimeOnlyFallbackPlan(fakes.registry, context, UNDERSTANDING),
    );

    // Every applicable adapter was asked, with this context and the validated understanding.
    for (const fake of [fakes.page, fakes.wire, fakes.source]) {
      expect(fake.createPlan).toHaveBeenCalledTimes(1);
      expect(fake.createPlan).toHaveBeenCalledWith(context, UNDERSTANDING);
    }
    expect(fakes.idle.createPlan).not.toHaveBeenCalled();

    // Exactly the runtime proposals, in registration order, each with its adapter's rationale.
    const runtimeProposals = [fakes.page, fakes.wire, fakes.source]
      .flatMap((fake) => fake.createPlan.mock.results)
      .flatMap((result) => (result.type === 'return' ? [result.value] : []));
    const proposed = (await Promise.all(runtimeProposals))
      .flat()
      .filter((action) => action.mode === RUNTIME);
    expect(built.input.instrumentationTargets).toEqual(
      proposed.map((action) => ({
        file: action.file,
        symbol: action.symbol,
        type: action.type,
        rationale: action.rationale,
      })),
    );

    // Runtime-only is the whole point: nothing in the fallback can touch a file.
    const actions = built.plan.instrumentationTargets;
    expect(actions.map((action) => [action.type, action.adapter, action.mode])).toEqual([
      ['interaction-tracking', PAGE_PROBE, RUNTIME],
      ['perf-tracking', PAGE_PROBE, RUNTIME],
      ['fetch-tracking', WIRE_PROBE, RUNTIME],
    ]);
    expect(actions.some((action) => action.mode === PATCH)).toBe(false);

    // The prose is the product's own signal labels and the understanding's category.
    expect(built.input.capture).toEqual(enabledLabelsOf(actions));
    for (const label of built.input.capture) {
      expect(built.plan.objective).toContain(label);
    }
    expect(built.plan.objective).toContain(UNDERSTANDING.category);
    expect(built.plan.hypotheses).toEqual([]);

    // Held to exactly the gate a model's plan passes.
    expect(vi.mocked(normalizePlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkPlanFeasibility)).toHaveBeenCalledTimes(1);
    expect(instrumentationPlanSchema.safeParse(built.plan).success).toBe(true);
    expect(built.feasibility.feasible).toHaveLength(3);
    expect(built.feasibility.rejected).toEqual([]);
  });

  it('follows the registry: different adapters yield a different fallback', async () => {
    const wireOnly = fakeRegistry();
    const registry = createAdapterRegistry({ adapters: [wireOnly.wire.adapter] });

    const full = expectOk(
      await buildRuntimeOnlyFallbackPlan(
        fakeRegistry().registry,
        instrumentationContext(),
        UNDERSTANDING,
      ),
    );
    const narrow = expectOk(
      await buildRuntimeOnlyFallbackPlan(registry, instrumentationContext(), UNDERSTANDING),
    );

    expect(narrow.plan.instrumentationTargets.map((action) => action.type)).toEqual([
      'fetch-tracking',
    ]);
    expect(narrow.plan.objective).not.toBe(full.plan.objective);
    expect(narrow.input.capture).toEqual(enabledLabelsOf(narrow.plan.instrumentationTargets));
  });

  it('refuses when every proposal would change a file', async () => {
    const fakes = fakeRegistry();
    const registry = createAdapterRegistry({ adapters: [fakes.source.adapter] });

    const error = expectErr(
      await buildRuntimeOnlyFallbackPlan(registry, instrumentationContext(), UNDERSTANDING),
    );

    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(reasonOf(error)).toBe('fallback-empty');
    expect(error.details?.['patchMode']).toBe(1);
    expect(vi.mocked(normalizePlan)).not.toHaveBeenCalled();
  });

  it('skips an adapter whose proposal throws and uses the others', async () => {
    const fakes = fakeRegistry();
    const thrower = fakeAdapter({
      id: LATE_PROBE,
      claims: { 'perf-tracking': RUNTIME },
      createPlanThrows: true,
    });
    const log = capturedLogger();

    const built = expectOk(
      await buildRuntimeOnlyFallbackPlan(
        createAdapterRegistry({ adapters: [thrower.adapter, fakes.wire.adapter] }),
        instrumentationContext({ logger: log.logger }),
        UNDERSTANDING,
      ),
    );

    expect(built.plan.instrumentationTargets.map((action) => action.type)).toEqual([
      'fetch-tracking',
    ]);
    const skipped = log.records.filter(
      (record) => record.level === 'warn' && record.fields['adapter'] === LATE_PROBE,
    );
    expect(skipped).toHaveLength(1);
    expect(serializeRecord(skipped[0]!)).not.toContain('could not propose anything');
  });

  it('refuses rather than emits when normalisation resolves an action to a file-changing mode', async () => {
    // A registry whose answer for one type changes between the fallback's
    // runtime filter and normalisation: the in-code runtime-only assertion is
    // the last line of defence, and it must refuse the whole plan.
    const drift = { flipped: false };
    const runtimeFirst = fakeAdapter({
      id: 'drift-runtime',
      claims: { 'perf-tracking': RUNTIME },
      proposals: [
        proposal('drift-runtime', 7, 'perf-tracking', RUNTIME, {
          file: INDEXED_FILE,
          symbol: INDEXED_SYMBOL,
        }),
      ],
      applies: () => !drift.flipped,
    });
    const patchSecond = fakeAdapter({ id: 'drift-patch', claims: { 'perf-tracking': PATCH } });
    const flipper = fakeAdapter({
      id: PAGE_PROBE,
      claims: { 'interaction-tracking': RUNTIME },
      proposals: [proposal(PAGE_PROBE, 8, 'interaction-tracking', RUNTIME)],
      onCreatePlan: () => {
        drift.flipped = true;
      },
    });
    const log = capturedLogger();

    const error = expectErr(
      await buildRuntimeOnlyFallbackPlan(
        createAdapterRegistry({
          adapters: [runtimeFirst.adapter, patchSecond.adapter, flipper.adapter],
        }),
        instrumentationContext({ logger: log.logger }),
        UNDERSTANDING,
      ),
    );

    expect(error.code).toBe('INTERNAL');
    expect(reasonOf(error)).toBe('fallback-patch-mode');
    expect(
      log.records.filter(
        (record) => record.level === 'error' && record.fields['step'] === 'fallback-mode',
      ),
    ).toHaveLength(1);
  });

  it('stops when the run is cancelled between adapters', async () => {
    const controller = new AbortController();
    const fakes = fakeRegistry();
    controller.abort();

    const error = expectErr(
      await buildRuntimeOnlyFallbackPlan(
        fakes.registry,
        instrumentationContext({ signal: controller.signal }),
        UNDERSTANDING,
      ),
    );

    expect(reasonOf(error)).toBe('aborted');
    expect(fakes.page.createPlan).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The stage
// ===========================================================================

describe('createPlanStage', () => {
  it('reports under the plan stage of both vocabularies', () => {
    expect(PLAN).toBe('plan');
    expect(PROMPT_STAGES).toContain(PLAN);
    expect(INSTRUMENT).toBe('instrument');
  });

  it('runs authoring validation, normalisation, internal validation and feasibility in order, then records and installs', async () => {
    const returned = await markNormalizerReturn();
    const authoring = vi.spyOn(instrumentationPlanInputSchema, 'safeParse');
    const internal = vi.spyOn(instrumentationPlanSchema, 'safeParse');
    const h = harness();

    const value = expectOk(await h.run());

    // One model call: the answer was valid first time.
    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    const provided = firstOrder(h.provider.structured);
    const normalized = firstOrder(vi.mocked(normalizePlan));
    const normalizerReturned = firstOrder(returned);
    const feasibility = firstOrder(vi.mocked(checkPlanFeasibility));

    // 1. Authoring validation of the model's answer, before normalisation.
    const authored = authoring.mock.invocationCallOrder.filter((order) => order > provided);
    expect(authored.length).toBeGreaterThan(0);
    expect(Math.min(...authored)).toBeLessThan(normalized);
    // 2. Normalisation. 3. Exactly one internal validation after it returned.
    expect(
      internal.mock.invocationCallOrder.filter(
        (order) => order > normalizerReturned && order < feasibility,
      ),
    ).toHaveLength(1);
    // 4. Feasibility, then persistence, then installation.
    expect(vi.mocked(checkPlanFeasibility)).toHaveBeenCalledTimes(1);
    expect(feasibility).toBeLessThan(firstOrder(h.recordPlan));
    expect(firstOrder(h.recordPlan)).toBeLessThan(firstOrder(h.instrumentation.install));

    expect(value.fallback).toBe(false);
    expect(value.fallbackCause).toBeUndefined();
    expect(value.repairs).toBe(0);
    expect(value.promptVersion).toBe(BUILDER_DEFAULT_VERSION);
    expect(value.feasibility.feasible).toHaveLength(2);
    expect(value.plan.instrumentationTargets.map((action) => action.type)).toEqual([
      'interaction-tracking',
      'fetch-tracking',
    ]);
    expect(value.plan.objective).toBe(MODEL_PLAN.objective);
  });

  it('records the gated plan and installs exactly what was recorded, once', async () => {
    const h = harness();

    const value = expectOk(await h.run());

    expect(h.recordPlan).toHaveBeenCalledTimes(1);
    expect(h.recordPlan.mock.calls[0]?.[0]).toBe(SESSION_ID);
    expect(recordedPlanOf(h)).toEqual(value.plan);
    expect(h.instrumentation.install).toHaveBeenCalledTimes(1);
    const request = installRequestOf(h);
    expect(request.plan).toBe(value.plan);
    expect(request.sessionId).toBe(SESSION_ID);
    expect(request.projectRoot).toBe(PROJECT_ROOT);
    expect(request.devServerUrl).toBe(DEV_SERVER_URL);
    expect(request.previousActions).toBeUndefined();
    expect(request.previousPlanVersion).toBeUndefined();
    expect(value.installation).toEqual(outcomeFor(request));
    expect(value.session.plans).toEqual([value.plan]);
  });

  it('takes the plan version from the store rather than assuming the first', async () => {
    const h = harness({ nextPlanVersion: 5 });

    const value = expectOk(await h.run());

    expect(h.nextPlanVersion).toHaveBeenCalledWith(SESSION_ID);
    expect(value.planVersion).toBe(5);
    expect(value.plan.planVersion).toBe(5);
    expect(recordedPlanOf(h).planVersion).toBe(5);
    expect(h.instrumentation.buildContext.mock.calls[0]?.[0].plan).toEqual({ planVersion: 5 });
  });

  it('hands the builder the prompt’s placeholder inputs, from the live registry, and never reads the question', async () => {
    const readiness: InstrumentationContext['readiness'] = {
      serverAgent: { connected: false, projectRoot: PROJECT_ROOT },
    };
    const h = harness();

    expectOk(await h.run({ readiness }));

    expect(h.builder.calls).toHaveLength(1);
    const call = h.builder.calls[0]!;
    expect(call.context).toBe(h.fixture.context);
    expect(call.understanding).toBe(UNDERSTANDING);
    expect(call.investigation).toBe(INVESTIGATION);
    expect(call.adapterCatalog).toEqual(
      await buildAdapterCatalog(h.fakes.registry, instrumentationContext({ planVersion: 3 })),
    );
    // `{{outputSchema}}` is rendered by the builder itself, and the stage has no question to give.
    expect(Object.keys(call)).not.toContain('question');
    expect(Object.keys(call)).not.toContain('outputSchema');
    expect(h.fixture.questionReads).toEqual([]);

    // The planning context carries the observed readiness facts.
    const contextInput = h.instrumentation.buildContext.mock.calls[0]?.[0];
    expect(contextInput?.readiness).toBe(readiness);
    expect(contextInput?.sessionId).toBe(SESSION_ID);
    expect(contextInput?.projectRoot).toBe(PROJECT_ROOT);
  });

  it('rejects a normaliser failure without re-prompting and falls back to the runtime-only plan', async () => {
    // A second, valid answer is queued: consuming it would be a re-prompt.
    const h = harness({ outcomes: [answer(UNCLAIMED_PLAN), answer(MODEL_PLAN)] });

    const value = expectOk(await h.run());

    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    expect(h.provider.other).toEqual([]);
    expect(value.fallback).toBe(true);
    expect(value.fallbackCause?.reason).toBe('normalization-failed');
    expect(value.repairs).toBe(0);

    // The product-defect record, at error, carries the parsed input.
    const defects = h.fixture.contextLog.records.filter(
      (record) => record.level === 'error' && record.fields['step'] === 'normalize',
    );
    expect(defects).toHaveLength(1);

    // Normalised twice — the model's plan, then the fallback — and feasibility ran only for the fallback.
    expect(vi.mocked(normalizePlan)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(checkPlanFeasibility)).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(checkPlanFeasibility))).toBeGreaterThan(
      lastOrder(vi.mocked(normalizePlan)),
    );

    // The recorded and installed plan is the registry-derived, runtime-only fallback.
    expect(value.plan.instrumentationTargets.map((action) => action.adapter)).toEqual([
      PAGE_PROBE,
      PAGE_PROBE,
      WIRE_PROBE,
    ]);
    expect(value.plan.instrumentationTargets.every((action) => action.mode === RUNTIME)).toBe(true);
    expect(recordedPlanOf(h)).toEqual(value.plan);
    expect(installRequestOf(h).plan).toBe(value.plan);

    // One fallback row, in the normaliser's own words, inside the plan group.
    const rows = h.progress.calls.flatMap((call) => (call.row !== undefined ? [call.row] : []));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stage).toBe(PLAN);
    expect(rows[0]?.status).toBe(RUNNING);
    expect(rows[0]?.message).toBe(value.fallbackCause?.message);
    expect(h.progress.trail).toEqual([
      `stageStarted:${PLAN}`,
      `emit:${PLAN}`,
      `stageCompleted:${PLAN}`,
    ]);
  });

  it('repairs a schema-invalid answer within the budget and uses the repaired plan', async () => {
    const h = harness({ outcomes: [answer(INVALID_PLAN), answer(MODEL_PLAN)] });

    const value = expectOk(await h.run());

    expect(h.provider.structured).toHaveBeenCalledTimes(2);
    expect(value.repairs).toBe(1);
    expect(value.fallback).toBe(false);
    expect(firstOrder(vi.mocked(normalizePlan))).toBeGreaterThan(lastOrder(h.provider.structured));
  });

  it('falls back once every permitted repair is exhausted, with no further model call', async () => {
    const invalid = Array.from({ length: DEFAULT_MAX_REPAIRS + 1 }, () => answer(INVALID_PLAN));
    const h = harness({ outcomes: [...invalid, answer(MODEL_PLAN)] });

    const value = expectOk(await h.run());

    expect(h.provider.structured).toHaveBeenCalledTimes(DEFAULT_MAX_REPAIRS + 1);
    expect(value.fallback).toBe(true);
    expect(value.fallbackCause?.reason).toBe('model-output-invalid');
    expect(value.fallbackCause?.code).toBe('MODEL_OUTPUT_INVALID');
    expect(value.repairs).toBe(DEFAULT_MAX_REPAIRS);
    // Only the fallback was normalised, after the last attempt.
    expect(vi.mocked(normalizePlan)).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(normalizePlan))).toBeGreaterThan(lastOrder(h.provider.structured));
    expect(value.plan.instrumentationTargets.every((action) => action.mode === RUNTIME)).toBe(true);
  });

  it('honours a smaller repair budget', async () => {
    const h = harness({ maxRepairs: 0, outcomes: [answer(INVALID_PLAN), answer(MODEL_PLAN)] });

    const value = expectOk(await h.run());

    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    expect(value.fallback).toBe(true);
    expect(value.fallbackCause?.reason).toBe('model-output-invalid');
  });

  it('falls back when nothing is feasible, reporting each refusal through buildDegradationNotice', async () => {
    const h = harness({ outcomes: [answer(INFEASIBLE_PLAN)] });

    const value = expectOk(await h.run());

    expect(value.fallback).toBe(true);
    expect(value.fallbackCause?.reason).toBe('infeasible');
    expect(value.fallbackCause?.code).toBe('INSTRUMENTATION_UNAVAILABLE');

    const report = firstFeasibilityReport();
    expect(report.feasible).toEqual([]);
    const labels = enabledLabelsOf(value.feasibility.feasible);
    const rows = h.progress.calls.flatMap((call) => (call.row !== undefined ? [call.row] : []));
    expect(rows.map((row) => row.message)).toEqual(
      report.rejected.map(
        (refusal) =>
          buildDegradationNotice(
            [{ signal: refusal.action.type, reason: refusal.reason, hint: refusal.hint }],
            labels,
          )[0],
      ),
    );
    expect(rows.map((row) => row.detail)).toEqual(report.rejected.map((refusal) => refusal.hint));
    expect(rows.every((row) => row.stage === PLAN && row.status === RUNNING)).toBe(true);
  });

  it('fails on a provider outage with the provider’s own sentence, and never falls back', async () => {
    const outage = unavailableError();
    const h = harness({ outcomes: [{ kind: 'error', error: outage }] });

    const error = expectErr(await h.run());

    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.message).toBe(outage.message);
    expect(error.details?.['stage']).toBe(PLAN);
    expect(vi.mocked(normalizePlan)).not.toHaveBeenCalled();
    for (const fake of [h.fakes.page, h.fakes.wire, h.fakes.source]) {
      expect(fake.createPlan).not.toHaveBeenCalled();
    }
    expect(h.recordPlan).not.toHaveBeenCalled();
    expect(h.instrumentation.install).not.toHaveBeenCalled();
    expect(h.progress.trail).toEqual([`stageStarted:${PLAN}`, `stageFailed:${PLAN}`]);
    const failed = h.progress.calls.find((call) => call.method === 'stageFailed');
    expect(failed?.failure?.message).toBe(outage.message);
    expect(failed?.failure?.code).toBe('MODEL_UNAVAILABLE');
  });

  it('stops before the provider when the context builder refuses the request', async () => {
    const refusal = outboundRefusal();
    const h = harness({ build: { kind: 'fail', error: refusal } });

    const error = expectErr(await h.run());

    expect(error.code).toBe(refusal.code);
    expect(error.message).toBe(refusal.message);
    expect(error.details?.['stage']).toBe(PLAN);
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.recordPlan).not.toHaveBeenCalled();
    expect(h.instrumentation.install).not.toHaveBeenCalled();
    expect(h.progress.trail).toEqual([`stageStarted:${PLAN}`, `stageFailed:${PLAN}`]);
  });

  it('passes the previous actions through on a follow-up, so their ids survive and only the delta installs', async () => {
    const first = harness({ nextPlanVersion: 1 });
    const previous = expectOk(await first.run()).plan.instrumentationTargets;
    const extended: InstrumentationPlanInput = {
      ...MODEL_PLAN,
      instrumentationTargets: [
        ...MODEL_PLAN.instrumentationTargets,
        { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'perf-tracking' },
      ],
    };
    const h = harness({ nextPlanVersion: 2, outcomes: [answer(extended)] });

    const value = expectOk(await h.run({ previousActions: previous }));

    const actions = value.plan.instrumentationTargets;
    expect(value.planVersion).toBe(2);
    expect(actions.slice(0, 2).map((action) => action.id)).toEqual(
      previous.map((action) => action.id),
    );
    expect(actions[2]?.id).toMatch(ACTION_ID_PATTERN);
    expect(previous.map((action) => action.id)).not.toContain(actions[2]?.id);
    const request = installRequestOf(h);
    expect(request.previousPlanVersion).toBe(1);
    expect(request.previousActions).toBe(previous);
  });

  it('refuses a follow-up on a session with no earlier plan version', async () => {
    const h = harness({ nextPlanVersion: 1 });
    const previous = [proposal(PAGE_PROBE, 9, 'interaction-tracking', RUNTIME)];

    const error = expectErr(await h.run({ previousActions: previous }));

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(reasonOf(error)).toBe('no-previous-plan');
    expect(h.instrumentation.buildContext).not.toHaveBeenCalled();
    expect(h.provider.structured).not.toHaveBeenCalled();
  });

  it('reports an install failure under the instrument stage without repeating the service’s failed row', async () => {
    const failure = new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      'Could not enable the planned signals.',
      { hint: 'Relaunch the development server, then plan again.' },
    );
    const h = harness({ installAnswer: () => err(failure) });

    const error = expectErr(await h.run());

    expect(error.code).toBe(failure.code);
    expect(error.message).toBe(failure.message);
    expect(error.hint).toBe(failure.hint);
    expect(error.details?.['stage']).toBe(INSTRUMENT);
    expect(h.recordPlan).toHaveBeenCalledTimes(1);
    expect(h.progress.trail).toEqual([`stageStarted:${PLAN}`, `stageCompleted:${PLAN}`]);
  });

  it('stops before installing when the orchestrator’s hand-off refuses', async () => {
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'The session cannot move on.');
    const beforeInstall = vi.fn<NonNullable<PlanStageInput['beforeInstall']>>(() =>
      Promise.resolve(err(refusal)),
    );
    const h = harness();

    const error = expectErr(await h.run({ beforeInstall }));

    expect(error.code).toBe(refusal.code);
    expect(error.details?.['stage']).toBe(INSTRUMENT);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(beforeInstall.mock.calls[0]?.[0].plan).toEqual(recordedPlanOf(h));
    expect(firstOrder(beforeInstall)).toBeGreaterThan(firstOrder(h.recordPlan));
    expect(h.instrumentation.install).not.toHaveBeenCalled();
    expect(h.progress.trail).toEqual([
      `stageStarted:${PLAN}`,
      `stageCompleted:${PLAN}`,
      `stageFailed:${INSTRUMENT}`,
    ]);
  });

  it('emits only the plan group’s header and closing row on a healthy run', async () => {
    const h = harness();

    expectOk(await h.run());

    expect(h.progress.trail).toEqual([`stageStarted:${PLAN}`, `stageCompleted:${PLAN}`]);
  });

  it.each(['err', 'throw'] as const)(
    'keeps going when a progress row cannot be emitted (%s)',
    async (behaviour) => {
      const h = harness({ progress: behaviour });

      const value = expectOk(await h.run());

      expect(value.fallback).toBe(false);
      expect(h.instrumentation.install).toHaveBeenCalledTimes(1);
      const warnings = h.fixture.contextLog.records.filter(
        (record) => record.level === 'warn' && record.fields['row'] !== undefined,
      );
      expect(warnings.map((record) => record.fields['row'])).toEqual(['started', 'completed']);
    },
  );

  it('refuses an out-of-range repair budget before any request or row', async () => {
    const h = harness({ maxRepairs: DEFAULT_MAX_REPAIRS + 1 });

    const error = expectErr(await h.run());

    expect(error.code).toBe('CONFIG_INVALID');
    expect(h.builder.calls).toEqual([]);
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.progress.calls).toEqual([]);
  });

  it('does nothing when the run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });

    const error = expectErr(await h.run());

    expect(reasonOf(error)).toBe('aborted');
    expect(h.builder.calls).toEqual([]);
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.progress.calls).toEqual([]);
  });

  it('writes nothing to the project and keeps model output out of its log records', async () => {
    const h = harness();

    const value = expectOk(await h.run());

    // The planted word travelled into the recorded plan …
    expect(value.plan.objective).toContain(SENTINEL);
    // … but no record of a healthy run carries it, the prompt, or the question.
    const logged = h.fixture.contextLog.records.map(serializeRecord).join('\n');
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain(PROMPT_MARKER);
    expect(
      recordsWith(
        h.fixture.contextLog.records,
        'Plan stage recorded a validated instrumentation plan.',
      ),
    ).toHaveLength(1);

    // Installation went through the instrumentation service only.
    expect(h.instrumentation.writeReads).toEqual([]);
    for (const fake of [h.fakes.page, h.fakes.wire, h.fakes.source, h.fakes.idle]) {
      expect(fake.install).not.toHaveBeenCalled();
      expect(fake.remove).not.toHaveBeenCalled();
    }
  });
});
