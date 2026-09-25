/**
 * Colocated unit suite for `./followup.ts`, the follow-up stage of the
 * reasoning pipeline (AAP §0.4.2, the Follow-up row; §0.5.1; §0.5.3).
 *
 * The named minimum this suite pins:
 *
 * 1. **The decision contract.** `isFollowUpDecision` accepts a valid decision
 *    in both addition forms and rejects every malformed variant, each variant
 *    differing from a valid base in exactly one checked condition, so every
 *    rejection is attributable to that condition. `followUpDecisionSchema` is
 *    the same guard behind protocol's `opaqueSchema`.
 * 2. **The additive-only rule, enforced in code.** `diffAdditionalActions`
 *    refuses a re-emission, a removal, a replacement, a re-scope and a
 *    duplicate, each with its own reason code, computes identity with the
 *    imported `actionIdentityKey`, and is pure.
 * 3. **Plan n + 1 is previous plus delta.** The next plan version restates the
 *    installed actions first — and `normalizePlan`, given the previous actions,
 *    hands each one its installed id — followed by the accepted additions.
 * 4. **Both paths, end to end against fakes.** The existing-evidence path
 *    regenerates the analysis and the panel as new versions and touches no
 *    instrumentation; the new-capture path gates, installs only through the
 *    instrumentation service, records the version only after the install, and
 *    reports the modification chain when a second plan version instruments a
 *    file the first one already did.
 *
 * Around them it pins the stage's failure paths (the builder's refusal never
 * reaches the provider, one gate and no second repair loop, a failed install
 * never advances the plan ladder), its progress rows and the privacy of its
 * log records and errors.
 *
 * Everything is in-process and hand-written: a scripted `ModelProvider`, a stub
 * context builder, fake adapters in a real `createAdapterRegistry`, fake
 * repositories, a fake instrumentation service, fake analysis and panel ports,
 * a recording progress emitter and a capturing logger. The real
 * `normalizePlan`, `checkPlanFeasibility` and `actionIdentityKey` run, wrapped
 * in spies so their calls are observable. No store, no prompt file, no network
 * and no filesystem write: the only filesystem access is the read-only static
 * scan of `./followup.ts` at the end. Fixtures use invented, generic
 * vocabulary only. End-to-end behaviour against the real store — plan and
 * panel versions and two plan versions on one file — belongs to
 * `test/integration/followup.test.ts`, and the repair loop's internals to
 * `packages/model-provider/src/structured.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  ACTION_ID_PATTERN,
  CAPTURE_SIGNALS,
  FEASIBILITY_REJECTION_CODES,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  actionIdentityKey,
  buildReadiness,
  checkPlanFeasibility,
  createAdapterRegistry,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  instrumentationPlanSchema,
  normalizePlan,
  problemUnderstandingSchema,
  type AdapterClaimTable,
  type AdapterRegistry,
  type ClaimingAdapter,
  type FeasibilityRejectionCode,
  type InstrumentationAction,
  type InstrumentationContext,
  type InstrumentationMode,
  type InstrumentationPlan,
  type ModificationRecord,
  type ProblemUnderstanding,
} from '@debuggen/instrumentation';
import type * as InstrumentationModule from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  modelUnavailableMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelTextResponse,
  type StructuredAttempt,
  type ToolCallsResponse,
} from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import {
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  type AnalysisResult,
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
import type { CaptureSummary } from '@debuggen/telemetry';

import type { AnalysisFollowUpContext } from '../../analysis/summarize.js';
import type { FactVerificationReport } from '../../analysis/facts.js';
import type { ReadinessVerdict } from '../../instrumentation/readiness.js';
import type {
  BuildContextInput,
  InstallRequest,
  InstrumentationOutcome,
} from '../../instrumentation/service.js';
import type { PanelGenerationResult, PanelRegenerationRequest } from '../../panels/generate.js';
import type { FollowUpOutcome, RecordPlanInput, RecordedPlan } from '../../sessions/manager.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import {
  STAGE_PLACEHOLDERS,
  type FollowUpRequestInput,
  type PipelineCodeHandles,
  type PipelineStageContext,
  type StageRequestBuild,
} from '../context-builder.js';
import type { AnalyzeStageInput, AnalyzeStageResult } from './analyze.js';
import {
  FOLLOW_UP_DECISION_SCHEMA_NAME,
  FOLLOW_UP_DELTA_REJECTION_REASONS,
  FOLLOW_UP_PATHS,
  FOLLOW_UP_STAGE,
  MAX_FOLLOW_UP_ADDITIONAL_ACTIONS,
  buildFollowUpPlanInput,
  createFollowUpStage,
  diffAdditionalActions,
  followUpDecisionSchema,
  followUpPathFor,
  isFollowUpAdditionalAction,
  isFollowUpDecision,
  type FollowUpActionDelta,
  type FollowUpAdditionalAction,
  type FollowUpDecision,
  type FollowUpDeltaRejectionReason,
  type FollowUpPath,
  type FollowUpStageDeps,
  type FollowUpStageInput,
  type FollowUpStageResult,
} from './followup.js';

// The real normaliser, feasibility gate and identity helper run unchanged;
// wrapping them in spies is what makes their calls observable (the precedent
// of `./plan.test.ts`).
vi.mock('@debuggen/instrumentation', async (importOriginal) => {
  const actual = await importOriginal<typeof InstrumentationModule>();
  return {
    ...actual,
    normalizePlan: vi.fn(actual.normalizePlan),
    checkPlanFeasibility: vi.fn(actual.checkPlanFeasibility),
    actionIdentityKey: vi.fn(actual.actionIdentityKey),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Imported vocabulary — never restated where an import can supply it
// ---------------------------------------------------------------------------

/** A member of protocol's progress-stage vocabulary, looked up so a rename there fails here. */
function progressStage(member: ProgressStage): ProgressStage {
  const found = PROGRESS_STAGES.find((stage) => stage === member);
  if (found === undefined) {
    throw new Error(`Expected ${member} to be a progress stage.`);
  }
  return found;
}

const FOLLOWUP = progressStage('followup');
const PLAN = progressStage('plan');
const INSTRUMENT = progressStage('instrument');
const ANALYZE = progressStage('analyze');
const GENERATE_PANEL = progressStage('generate-panel');

/** The three progress statuses, in protocol's order. */
const [RUNNING, DONE, FAILED] = PROGRESS_STATUSES;

/** The runtime install mode, which touches no file. */
const RUNTIME: InstrumentationMode = INSTRUMENTATION_MODES[0];

/** The patch install mode, which edits a file. */
const PATCH: InstrumentationMode = INSTRUMENTATION_MODES[1];

/** A member of the additive-only rejection vocabulary, looked up rather than restated. */
function deltaReason(member: FollowUpDeltaRejectionReason): FollowUpDeltaRejectionReason {
  const found = FOLLOW_UP_DELTA_REJECTION_REASONS.find((reason) => reason === member);
  if (found === undefined) {
    throw new Error(`Expected ${member} to be a delta rejection reason.`);
  }
  return found;
}

const RE_EMISSION = deltaReason('re-emission');
const REMOVAL = deltaReason('removal');
const REPLACEMENT = deltaReason('replacement');
const RE_SCOPE = deltaReason('re-scope');
const DUPLICATE = deltaReason('duplicate');

/** A member of the feasibility rejection vocabulary, looked up rather than restated. */
function rejectionCode(member: FeasibilityRejectionCode): FeasibilityRejectionCode {
  const found = FEASIBILITY_REJECTION_CODES.find((code) => code === member);
  if (found === undefined) {
    throw new Error(`Expected ${member} to be a feasibility rejection code.`);
  }
  return found;
}

/** The refusal of a patch-mode action when no TypeScript program is loaded. */
const AST_UNAVAILABLE = rejectionCode('ast-unavailable');

/** The schema argument a provider's `generateStructured` receives. */
type StructuredSchema = Parameters<ModelProvider['generateStructured']>[0];

/** The progress surface the stage is given. */
type ProgressApi = FollowUpStageDeps['progress'];

/** The request-builder surface the stage is given. */
type FollowUpBuilderApi = FollowUpStageDeps['contextBuilder'];

// ---------------------------------------------------------------------------
// Fixture constants — invented, generic vocabulary
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-followup-suite';
const PROJECT_ROOT = '/workspace/ledger-tool';
const PROJECT_NAME = 'ledger-tool';
const DEV_SERVER_URL = 'http://127.0.0.1:4173/';
const DEBUGGEN_HOME = '/tmp/followup-suite-home-never-touched';
const FIXED_EPOCH_MS = 1_767_225_600_000;
const CAPTURE_ID = 'capture-followup-suite';

/** What the stub builder puts in the prompt; never inspected by the stage. */
const PROMPT_MARKER = 'stub-rendered-followup-prompt';

/** The version the stub builder falls back to when neither the caller nor the session names one. */
const BUILDER_DEFAULT_VERSION = 'v007';

/** A token planted in the follow-up question; no log record or error may carry it. */
const SENTINEL = 'quillmarmotsentinel';

const PAGE_PROBE = 'page-probe';
const WIRE_PROBE = 'wire-probe';
const SOURCE_PROBE = 'source-probe';

/** An indexed file and its declared symbol, instrumented by plan version 1. */
const INDEXED_FILE = 'src/ledger/totals.ts';
const INDEXED_SYMBOL = 'refreshTotals';

/** A second indexed file and symbol no installed action touches. */
const OTHER_FILE = 'src/ledger/export.ts';
const OTHER_SYMBOL = 'exportRows';

/** The follow-up question, with {@link SENTINEL} planted in it. */
const FOLLOW_UP_QUESTION = `Why did the totals query run twice ${SENTINEL}?`;

/** The session's recorded prompt versions: superseded ones, deliberately not the manifest's current. */
const RECORDED_PROMPT_VERSIONS = Object.freeze({
  followup: 'v003',
  analyze: 'v004',
  'generate-panel': 'v005',
});

/** A schema-valid problem understanding. */
const UNDERSTANDING: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [CAPTURE_SIGNALS[0]],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: ['ledger totals'],
});

/** An action id of the product's shape. */
function actionId(index: number): string {
  return `act_${String(index).padStart(16, '0')}`;
}

/** Plan version 1's targetless runtime action. */
const INSTALLED_INTERACTION: InstrumentationAction = {
  id: actionId(1),
  file: TARGETLESS_FILE,
  symbol: TARGETLESS_SYMBOL,
  type: 'interaction-tracking',
  adapter: PAGE_PROBE,
  mode: RUNTIME,
  rationale: 'Time the interaction the developer reported.',
};

/** Plan version 1's patch-mode action on {@link INDEXED_FILE}. */
const INSTALLED_TIMING: InstrumentationAction = {
  id: actionId(2),
  file: INDEXED_FILE,
  symbol: INDEXED_SYMBOL,
  type: 'function-timing',
  adapter: SOURCE_PROBE,
  mode: PATCH,
  rationale: 'Time the totals refresh.',
};

/** The installed plan version 1, validated against the internal schema. */
const PLAN_V1: InstrumentationPlan = instrumentationPlanSchema.parse({
  version: 1,
  planVersion: 1,
  sessionId: SESSION_ID,
  objective: 'Determine why the ledger totals refresh slowly.',
  hypotheses: [],
  capture: ['interaction timing', 'function timing'],
  instrumentationTargets: [INSTALLED_INTERACTION, INSTALLED_TIMING],
});

/** A capture summary stand-in; the stage only carries it through. */
const CAPTURE_SUMMARY = { captureId: CAPTURE_ID } as unknown as CaptureSummary;

/** The latest analysis: version 1 of the session's ladder. */
const ANALYSIS_V1: AnalysisResult = {
  id: 'analysis-v1-suite',
  sessionId: SESSION_ID,
  captureId: CAPTURE_ID,
  analysisVersion: 1,
  createdAt: FIXED_EPOCH_MS,
  metrics: [],
  observed: [],
  likelyCauses: [],
};

/** The latest panel: version 1 of the session's panels. */
const PANEL_V1: PanelSpec = {
  version: 1,
  id: 'panel-v1-suite',
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: 'Ledger totals',
  summary: { observed: [], likelyCauses: [] },
  layout: [],
};

/** Plan version 1's modification record on {@link INDEXED_FILE}: the chain head. */
const RECORD_V1: ModificationRecord = {
  id: 'mod_000000000000000a',
  sessionId: SESSION_ID,
  planVersion: 1,
  file: INDEXED_FILE,
  originalHash: 'a'.repeat(64),
  backupPath: `${DEBUGGEN_HOME}/backups/${SESSION_ID}/${'a'.repeat(64)}`,
  instrumentedHash: 'b'.repeat(64),
  appliedAt: FIXED_EPOCH_MS,
  status: 'applied',
  diff: '--- a\n+++ b\n',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected an error result.');
  }
  return result.error;
}

/** The `details.reason` of an error. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.['reason'];
}

/** The `details.stage` of an error. */
function stageOf(error: DebuggenError): unknown {
  return error.details?.['stage'];
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

/** A vitest mock's first call order, or a test failure when it was never called. */
function firstOrder(mock: { readonly mock: { readonly invocationCallOrder: number[] } }): number {
  const [first] = mock.mock.invocationCallOrder;
  if (first === undefined) {
    throw new Error('Expected the mock to have been called.');
  }
  return first;
}

/** A path-narrowed stage result, or a test failure. */
function expectPath<P extends FollowUpStageResult['path']>(
  result: FollowUpStageResult,
  path: P,
): Extract<FollowUpStageResult, { path: P }> {
  if (result.path !== path) {
    throw new Error(`Expected the ${path} path, got ${result.path}.`);
  }
  return result as Extract<FollowUpStageResult, { path: P }>;
}

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

/** Deep-freezes a JSON-shaped value so a mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Doubles: code handles, instrumentation context and a real registry of fakes
// ---------------------------------------------------------------------------

/** The files the invented index holds, with the one symbol each declares. */
const INDEX: ReadonlyMap<string, string> = new Map([
  [INDEXED_FILE, INDEXED_SYMBOL],
  [OTHER_FILE, OTHER_SYMBOL],
]);

/**
 * Code-analysis handles over a tiny invented index. Only the reads the
 * feasibility gate makes are implemented; no TypeScript program is loaded, so
 * a patch-mode action is refused as `ast-unavailable` by the real gate. The
 * type assertions stand in for `@debuggen/code-analysis` types this suite
 * deliberately does not construct.
 */
function fakeCode(): PipelineCodeHandles {
  const graph = {
    nodesByFile: (file: string): readonly unknown[] => (INDEX.has(file) ? [{ file }] : []),
    files: [],
  };
  const queries = {
    hasSymbol: (file: string, symbol: string): boolean => INDEX.get(file) === symbol,
    findByName: (): readonly unknown[] => [],
  };
  return {
    graph: graph as unknown as PipelineCodeHandles['graph'],
    queries: queries as unknown as PipelineCodeHandles['queries'],
    routeMap: {} as unknown as PipelineCodeHandles['routeMap'],
    projectSummary: {} as unknown as PipelineCodeHandles['projectSummary'],
  };
}

/** A stand-in that records every read and holds nothing: the stage must never reach it. */
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

/** A usable {@link InstrumentationContext} over the handles a `buildContext` call was given. */
function instrumentationContext(
  input: BuildContextInput,
  logger: Logger,
  writeReads: string[],
): InstrumentationContext {
  return {
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    planVersion: input.plan.planVersion,
    debuggenHome: DEBUGGEN_HOME,
    logger,
    graph: input.code.graph,
    queries: input.code.queries,
    routeMap: input.code.routeMap,
    projectSummary: input.code.summary,
    journal: tripwire<InstrumentationContext['journal']>('journal', writeReads),
    backups: tripwire<InstrumentationContext['backups']>('backups', writeReads),
    readiness: input.readiness ?? {},
    now: () => FIXED_EPOCH_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

/** An adapter that claims the given types and refuses to install or remove anything. */
function fakeAdapter(id: string, claims: AdapterClaimTable): ClaimingAdapter {
  return {
    id,
    claims,
    canHandle: () => true,
    createPlan: () => Promise.reject(new Error('the follow-up stage must not ask for proposals')),
    install: () => Promise.reject(new Error('the follow-up stage must not install via an adapter')),
    remove: () => Promise.reject(new Error('the follow-up stage must not remove via an adapter')),
    readiness: () =>
      Promise.resolve(buildReadiness({ adapter: id, signals: [], now: () => FIXED_EPOCH_MS })),
  };
}

/**
 * Three invented adapters in a real registry, resolving plan version 1's
 * installed actions to exactly the adapter and mode they were installed with:
 * - `page-probe` — runtime; interaction and performance tracking.
 * - `wire-probe` — runtime; request and state tracking.
 * - `source-probe` — patch; function timing and server spans.
 */
function fakeRegistry(): AdapterRegistry {
  return createAdapterRegistry({
    adapters: [
      fakeAdapter(PAGE_PROBE, { 'interaction-tracking': RUNTIME, 'perf-tracking': RUNTIME }),
      fakeAdapter(WIRE_PROBE, { 'fetch-tracking': RUNTIME, 'state-tracking': RUNTIME }),
      fakeAdapter(SOURCE_PROBE, { 'function-timing': PATCH, 'server-span': PATCH }),
    ],
  });
}

/**
 * A registry in which function timing is claimed by another adapter than the
 * one plan version 1 installed it with: normalisation would move an installed
 * action to a new adapter, which the stage must refuse as a product defect.
 */
function driftedRegistry(): AdapterRegistry {
  return createAdapterRegistry({
    adapters: [
      fakeAdapter(PAGE_PROBE, { 'interaction-tracking': RUNTIME, 'perf-tracking': RUNTIME }),
      fakeAdapter(WIRE_PROBE, { 'fetch-tracking': RUNTIME, 'function-timing': PATCH }),
      fakeAdapter(SOURCE_PROBE, { 'server-span': PATCH }),
    ],
  });
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

/**
 * A {@link ModelProvider} that makes exactly one attempt per call, answering
 * each `generateStructured` call with the next queued outcome. It never
 * validates, repairs or retries: those belong to the upstream loop.
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
    return Promise.resolve(err(new DebuggenError('INTERNAL', 'Not part of the follow-up stage.')));
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
    return Promise.resolve(err(new DebuggenError('INTERNAL', 'Not part of the follow-up stage.')));
  }
}

// ---------------------------------------------------------------------------
// Double: the stub context builder
// ---------------------------------------------------------------------------

/**
 * A follow-up request builder that records its input and answers with a
 * request whose prompt is {@link PROMPT_MARKER}. It follows the real builder's
 * version rule — an explicit version, else the session's, else a default —
 * or answers with the given refusal.
 */
class StubFollowUpBuilder implements FollowUpBuilderApi {
  readonly calls: FollowUpRequestInput[] = [];
  readonly #refusal: DebuggenError | undefined;

  constructor(refusal?: DebuggenError) {
    this.#refusal = refusal;
  }

  buildFollowUpRequest(input: FollowUpRequestInput): Result<StageRequestBuild, DebuggenError> {
    this.calls.push(input);
    if (this.#refusal !== undefined) {
      return err(this.#refusal);
    }
    const { context } = input;
    const promptVersion =
      input.promptVersion ?? context.promptVersions[FOLLOW_UP_STAGE] ?? BUILDER_DEFAULT_VERSION;
    const signal = input.signal ?? context.signal;
    const request: ModelRequest = {
      prompt: PROMPT_MARKER,
      input: { section: FOLLOW_UP_STAGE },
      metadata: { stage: FOLLOW_UP_STAGE, promptVersion, sessionId: context.sessionId },
      ...(signal !== undefined ? { signal } : {}),
    };
    return ok({
      request,
      stage: FOLLOW_UP_STAGE,
      promptVersion,
      truncated: [],
      bytes: PROMPT_MARKER.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Double: the recording progress emitter
// ---------------------------------------------------------------------------

/** One recorded progress call. */
interface ProgressCall {
  readonly method: 'stageStarted' | 'stageCompleted' | 'stageFailed';
  readonly stage: ProgressStage;
  readonly failure?: SessionFailure;
}

/** Whether every progress method succeeds, answers `Err`, or throws. */
type ProgressBehaviour = 'ok' | 'err' | 'throw';

/**
 * A progress emitter that records every call. It also carries the members of
 * `SessionProgress` the stage is **not** given — the instrument group's
 * `reportInstrumentation` and `readyToCapture`, the finding rows — so a run
 * that reached for one is recorded in {@link RecordingProgress.foreign}: those
 * rows belong to the instrumentation service and the readiness gate.
 */
class RecordingProgress
  implements
    ProgressApi,
    Pick<SessionProgress, 'reportInstrumentation' | 'readyToCapture' | 'finding'>
{
  readonly calls: ProgressCall[] = [];
  readonly foreign: string[] = [];
  readonly #behaviour: ProgressBehaviour;

  constructor(behaviour: ProgressBehaviour = 'ok') {
    this.#behaviour = behaviour;
  }

  /** `method:stage` of every call, in order. */
  get trail(): readonly string[] {
    return this.calls.map((call) => `${call.method}:${call.stage}`);
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

  reportInstrumentation(): Result<readonly SessionProgressPayload[], DebuggenError> {
    this.foreign.push('reportInstrumentation');
    return ok([]);
  }

  readyToCapture(sessionId: string): Result<SessionProgressPayload, DebuggenError> {
    this.foreign.push('readyToCapture');
    return this.#answer(sessionId, INSTRUMENT, DONE);
  }

  finding(sessionId: string, stage: ProgressStage): Result<SessionProgressPayload, DebuggenError> {
    this.foreign.push('finding');
    return this.#answer(sessionId, stage, DONE);
  }

  #answer(
    sessionId: string,
    stage: ProgressStage,
    status: SessionProgressPayload['status'],
  ): Result<SessionProgressPayload, DebuggenError> {
    if (this.#behaviour === 'throw') {
      throw new Error(`The progress double was told to throw ${SENTINEL}.`);
    }
    if (this.#behaviour === 'err') {
      return err(new DebuggenError('STORE_ERROR', 'The progress double was told to fail.'));
    }
    return ok({ sessionId, stage, status, message: 'row recorded by the progress double' });
  }
}

// ---------------------------------------------------------------------------
// Doubles: the stored session, the stage context and the collaborators
// ---------------------------------------------------------------------------

/** A stored session record in the status a follow-up runs under. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: PROJECT_NAME,
    devServerUrl: DEV_SERVER_URL,
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'generated',
    question: 'Why do the ledger totals refresh slowly?',
    followUps: [],
    understanding: UNDERSTANDING,
    relevantFiles: [],
    plans: [PLAN_V1],
    modifications: [],
    captures: [],
    panelIds: [PANEL_V1.id],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: { ...RECORDED_PROMPT_VERSIONS },
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** A minimal valid {@link PipelineStageContext} over a stored session. */
function stageContext(
  session: SessionRecord = sessionRecord(),
  signal?: AbortSignal,
): PipelineStageContext {
  return {
    sessionId: session.id,
    session,
    projectRoot: session.projectRoot,
    question: session.question,
    code: fakeCode(),
    promptVersions: session.promptVersions,
    logger: capturedLogger().logger,
    now: () => FIXED_EPOCH_MS,
    ...(signal !== undefined ? { signal } : {}),
  };
}

/** A complete, valid fact-verification report; the stage only carries it through. */
const VERIFICATION: FactVerificationReport = {
  checkedEventIds: [],
  unresolvedEventIds: [],
  checkedTraceIds: [],
  unresolvedTraceIds: [],
  checkedSpanIds: [],
  unresolvedSpanIds: [],
  spanCheck: 'performed',
  checkedLocations: 0,
  issues: [],
  valid: true,
};

/** The analysis the fake analysis port stores as the next version. */
function nextAnalysis(input: AnalyzeStageInput): AnalysisResult {
  return {
    id: 'analysis-v2-suite',
    sessionId: SESSION_ID,
    captureId: input.captureId,
    analysisVersion: 2,
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    createdAt: FIXED_EPOCH_MS + 1,
    metrics: [],
    observed: [],
    likelyCauses: [],
  };
}

/** The panel the fake panel port stores as the next version. */
function nextPanel(request: PanelRegenerationRequest): PanelSpec {
  return {
    version: 1,
    id: 'panel-v2-suite',
    sessionId: request.sessionId,
    panelVersion: 2,
    supersedes: PANEL_V1.id,
    title: 'Ledger totals, follow-up',
    summary: { observed: [], likelyCauses: [] },
    layout: [],
  };
}

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

/** The outcome a successful install of `request.plan` reports, with the given applied records. */
function outcomeFor(
  request: InstallRequest,
  applied: readonly ModificationRecord[] = [],
): InstrumentationOutcome {
  const actions = request.plan.instrumentationTargets;
  return {
    sessionId: request.sessionId,
    planVersion: request.plan.planVersion,
    activePlanVersion: request.plan.planVersion,
    applied: [...applied],
    runtimeHooks: [],
    unavailable: [],
    agentHooks: deriveAgentHookConfig(actions),
    serverSignals: deriveServerAgentSignals(actions),
    readiness: satisfiedVerdict(),
    degradations: [],
  };
}

/** What a test may vary about the stage's collaborators. */
interface HarnessOptions {
  readonly outcomes?: readonly ScriptedOutcome[];
  readonly session?: SessionRecord;
  readonly refusal?: DebuggenError;
  readonly progress?: ProgressBehaviour;
  readonly registry?: AdapterRegistry;
  readonly maxRepairs?: number;
  /** The installed plan version the ladder holds; plan version 1 unless given. */
  readonly installedPlan?: InstrumentationPlan;
  readonly nextPlanVersion?: number;
  readonly latestPlanVersion?: number | undefined;
  readonly latestAnalysis?: AnalysisResult | undefined;
  readonly latestPanel?: PanelSpec | undefined;
  readonly followUpContext?: AnalysisFollowUpContext;
  readonly chainHeads?: ReadonlyMap<string, ModificationRecord>;
  readonly installAnswer?: (
    request: InstallRequest,
  ) => Result<InstrumentationOutcome, DebuggenError>;
  readonly analysisAnswer?: (input: AnalyzeStageInput) => Result<AnalyzeStageResult, DebuggenError>;
  readonly recordOutcomeFails?: boolean;
}

/** The stage over fakes, and every spy a test asserts on. */
interface Harness {
  readonly stage: ReturnType<typeof createFollowUpStage>;
  readonly context: PipelineStageContext;
  readonly log: CapturedLogger;
  readonly provider: ScriptedProvider;
  readonly builder: StubFollowUpBuilder;
  readonly progress: RecordingProgress;
  readonly ladder: AnalysisResult[];
  readonly writeReads: string[];
  readonly buildContext: Mock<FollowUpStageDeps['instrumentation']['buildContext']>;
  readonly install: Mock<FollowUpStageDeps['instrumentation']['install']>;
  readonly analysisRun: Mock<FollowUpStageDeps['analysisRegeneration']['run']>;
  readonly regenerate: Mock<FollowUpStageDeps['panelRegeneration']['regenerate']>;
  readonly latestPlanVersion: Mock<FollowUpStageDeps['sessions']['latestPlanVersion']>;
  readonly getPlan: Mock<FollowUpStageDeps['sessions']['getPlan']>;
  readonly nextPlanVersion: Mock<FollowUpStageDeps['sessions']['nextPlanVersion']>;
  readonly latestRecordForFile: Mock<FollowUpStageDeps['modifications']['latestRecordForFile']>;
  readonly appendFollowUp: Mock<FollowUpStageDeps['sessionManager']['appendFollowUp']>;
  readonly recordFollowUpOutcome: Mock<
    FollowUpStageDeps['sessionManager']['recordFollowUpOutcome']
  >;
  readonly recordPlan: Mock<FollowUpStageDeps['sessionManager']['recordPlan']>;
  readonly history: Mock<FollowUpStageDeps['facts']['history']>;
  /** Every member name read on the modifications repository; only the chain-head lookup may appear. */
  readonly modificationReads: string[];
  /** Every member name read on the session manager; no status-writing member may appear. */
  readonly sessionManagerReads: string[];
  /** Every member name read on the instrumentation service; only the context build and the install may appear. */
  readonly instrumentationReads: string[];
}

/** The same object behind a proxy that records the name of every member read. */
function accessRecorded<T extends object>(target: T, accessed: string[]): T {
  return new Proxy(target, {
    get: (object, key, receiver) => {
      accessed.push(String(key));
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

/** Mints distinct action ids the installed plan never uses. */
function actionIdMinter(): () => string {
  let next = 100;
  return () => {
    next += 1;
    return actionId(next);
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const log = capturedLogger();
  const session = options.session ?? sessionRecord();
  const context = stageContext(session);
  const provider = new ScriptedProvider(options.outcomes ?? []);
  const builder = new StubFollowUpBuilder(options.refusal);
  const progress = new RecordingProgress(options.progress ?? 'ok');
  const writeReads: string[] = [];
  const modificationReads: string[] = [];
  const sessionManagerReads: string[] = [];
  const instrumentationReads: string[] = [];
  const ladder: AnalysisResult[] = [options.latestAnalysis ?? ANALYSIS_V1];
  const latestAnalysis = 'latestAnalysis' in options ? options.latestAnalysis : ANALYSIS_V1;
  const latestPanel = 'latestPanel' in options ? options.latestPanel : PANEL_V1;
  const installedPlan = options.installedPlan ?? PLAN_V1;
  const latestVersion =
    'latestPlanVersion' in options ? options.latestPlanVersion : installedPlan.planVersion;

  const buildContext = vi.fn<FollowUpStageDeps['instrumentation']['buildContext']>((input) =>
    ok(instrumentationContext(input, log.logger, writeReads)),
  );
  const install = vi.fn<FollowUpStageDeps['instrumentation']['install']>((request) =>
    Promise.resolve(
      options.installAnswer === undefined
        ? ok(outcomeFor(request))
        : options.installAnswer(request),
    ),
  );
  const analysisRun = vi.fn<FollowUpStageDeps['analysisRegeneration']['run']>((_ctx, input) => {
    if (options.analysisAnswer !== undefined) {
      return Promise.resolve(options.analysisAnswer(input));
    }
    const analysis = nextAnalysis(input);
    ladder.push(analysis);
    const result: AnalyzeStageResult = {
      analysis,
      analysisVersion: analysis.analysisVersion,
      promptVersion: input.promptVersion ?? BUILDER_DEFAULT_VERSION,
      repairs: 0,
      attempts: 1,
      providerId: 'scripted-test-provider',
      model: 'scripted-model',
      verification: VERIFICATION,
      summary: CAPTURE_SUMMARY,
      truncated: [],
    };
    return Promise.resolve(ok(result));
  });
  const regenerate = vi.fn<FollowUpStageDeps['panelRegeneration']['regenerate']>((request) => {
    const result: PanelGenerationResult = {
      panel: nextPanel(request),
      fallback: false,
      promptVersion: request.promptVersion ?? BUILDER_DEFAULT_VERSION,
      attempts: 1,
      repairs: 0,
      broadcast: true,
    };
    return Promise.resolve(ok(result));
  });
  const latestPlanVersion = vi.fn<FollowUpStageDeps['sessions']['latestPlanVersion']>(() =>
    ok(latestVersion),
  );
  const getPlan = vi.fn<FollowUpStageDeps['sessions']['getPlan']>((_sid, version) =>
    ok(version === installedPlan.planVersion ? installedPlan : undefined),
  );
  const nextPlanVersion = vi.fn<FollowUpStageDeps['sessions']['nextPlanVersion']>(() =>
    ok(options.nextPlanVersion ?? installedPlan.planVersion + 1),
  );
  const latestRecordForFile = vi.fn<FollowUpStageDeps['modifications']['latestRecordForFile']>(
    (_sid, file) => Promise.resolve(ok(options.chainHeads?.get(file))),
  );
  const appendFollowUp = vi.fn<FollowUpStageDeps['sessionManager']['appendFollowUp']>(() =>
    Promise.resolve(ok(session)),
  );
  const recordFollowUpOutcome = vi.fn<FollowUpStageDeps['sessionManager']['recordFollowUpOutcome']>(
    () =>
      Promise.resolve(
        options.recordOutcomeFails === true
          ? err(new DebuggenError('STORE_ERROR', 'The outcome could not be stored.'))
          : ok(session),
      ),
  );
  const recordPlan = vi.fn<FollowUpStageDeps['sessionManager']['recordPlan']>(
    (sessionId: string, plan: RecordPlanInput): Promise<Result<RecordedPlan, DebuggenError>> => {
      const stored: InstrumentationPlan = {
        ...plan,
        sessionId,
        planVersion: plan.planVersion ?? installedPlan.planVersion + 1,
      };
      return Promise.resolve(
        ok({ session: sessionRecord({ plans: [installedPlan, stored] }), plan: stored }),
      );
    },
  );
  const history = vi.fn<FollowUpStageDeps['facts']['history']>(() => ok([...ladder]));

  const deps: FollowUpStageDeps = {
    contextBuilder: builder,
    provider,
    summarizer: {
      buildFollowUpContext: () =>
        Promise.resolve(
          ok(
            options.followUpContext ?? {
              previousAnalysisId: ANALYSIS_V1.id,
              previousObserved: 0,
              previousLikelyCauses: 0,
              previousPanelId: PANEL_V1.id,
            },
          ),
        ),
      loadCaptureSummary: () => Promise.resolve(ok(CAPTURE_SUMMARY)),
    },
    facts: { history },
    analysisRegeneration: { run: analysisRun },
    panelRegeneration: { regenerate },
    instrumentation: accessRecorded({ buildContext, install }, instrumentationReads),
    registry: options.registry ?? fakeRegistry(),
    sessions: { latestPlanVersion, getPlan, nextPlanVersion },
    panels: {
      getLatestAnalysis: () => ok(latestAnalysis),
      getLatestPanel: () => ok(latestPanel),
    },
    modifications: accessRecorded({ latestRecordForFile }, modificationReads),
    sessionManager: accessRecorded(
      { appendFollowUp, recordFollowUpOutcome, recordPlan },
      sessionManagerReads,
    ),
    progress,
    logger: log.logger,
    newActionId: actionIdMinter(),
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
  };

  return {
    stage: createFollowUpStage(deps),
    context,
    log,
    provider,
    builder,
    progress,
    ladder,
    writeReads,
    buildContext,
    install,
    analysisRun,
    regenerate,
    latestPlanVersion,
    getPlan,
    nextPlanVersion,
    latestRecordForFile,
    appendFollowUp,
    recordFollowUpOutcome,
    recordPlan,
    history,
    modificationReads,
    sessionManagerReads,
    instrumentationReads,
  };
}

/** The follow-up input most tests run with. */
function followUpInput(overrides: Partial<FollowUpStageInput> = {}): FollowUpStageInput {
  return { followUpQuestion: FOLLOW_UP_QUESTION, ...overrides };
}

/** The single install request a run sent, or a test failure. */
function installRequestOf(h: Harness): InstallRequest {
  const [call] = h.install.mock.calls;
  if (call === undefined) {
    throw new Error('Expected exactly one install call.');
  }
  return call[0];
}

/** Everything a run surfaced through its logs and the given error, as one string. */
function everythingSurfaced(h: Harness, error?: DebuggenError): string {
  const records = h.log.records.map(serializeRecord).join('\n');
  return error === undefined ? records : `${records}\n${serializeError(error)}`;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** An authoring target: an addition of request tracking, targetless. */
const ADD_FETCH = Object.freeze({
  file: TARGETLESS_FILE,
  symbol: TARGETLESS_SYMBOL,
  type: 'fetch-tracking',
  rationale: 'See whether the totals request is repeated.',
}) satisfies FollowUpAdditionalAction;

/** An authoring target: a server span on the file plan version 1 already times. */
const ADD_SPAN_ON_TIMED_FILE = Object.freeze({
  file: INDEXED_FILE,
  symbol: INDEXED_SYMBOL,
  type: 'server-span',
  rationale: 'Place the totals refresh inside its request.',
}) satisfies FollowUpAdditionalAction;

/** A decision that the stored capture answers the follow-up. */
const EXISTING_EVIDENCE_DECISION: FollowUpDecision = {
  needsNewCapture: false,
  additionalActions: [],
};

/** A decision that needs one runtime addition and a new capture. */
const FETCH_DECISION: FollowUpDecision = {
  needsNewCapture: true,
  additionalActions: [ADD_FETCH],
};

/** An authoring target: an addition of performance-entry tracking, targetless. */
const ADD_PERF = Object.freeze({
  file: TARGETLESS_FILE,
  symbol: TARGETLESS_SYMBOL,
  type: 'perf-tracking',
  rationale: 'See whether long tasks overlap the refresh.',
}) satisfies FollowUpAdditionalAction;

/** Plan version 2's request tracking, installed by an earlier follow-up. */
const INSTALLED_FETCH: InstrumentationAction = {
  id: actionId(3),
  file: TARGETLESS_FILE,
  symbol: TARGETLESS_SYMBOL,
  type: 'fetch-tracking',
  adapter: WIRE_PROBE,
  mode: RUNTIME,
  rationale: 'See whether the totals request is repeated.',
};

/** An installed plan version 2: version 1 plus the request tracking an earlier follow-up added. */
const PLAN_V2: InstrumentationPlan = instrumentationPlanSchema.parse({
  ...PLAN_V1,
  planVersion: 2,
  instrumentationTargets: [...PLAN_V1.instrumentationTargets, INSTALLED_FETCH],
});

// ---------------------------------------------------------------------------
// 1. The decision contract
// ---------------------------------------------------------------------------

/** A valid resolved addition: a fresh id, a new file, the adapter and mode the registry would give it. */
const RESOLVED_ADDITION: InstrumentationAction = {
  id: actionId(50),
  file: OTHER_FILE,
  symbol: OTHER_SYMBOL,
  type: 'function-timing',
  adapter: SOURCE_PROBE,
  mode: PATCH,
  rationale: 'Time the export as well.',
};

/** Returns a copy of `base` with one property replaced (or removed, for `undefined`). */
function withField(base: object, key: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  if (value === undefined) {
    delete copy[key];
  } else {
    copy[key] = value;
  }
  return copy;
}

/** A three-slot list whose middle slot is a hole rather than a value. */
function listWithHole(value: unknown): unknown[] {
  const list: unknown[] = [];
  list[0] = value;
  list[2] = value;
  return list;
}

/** A decision whose only addition is `addition`. */
function decisionWith(addition: unknown): Record<string, unknown> {
  return { needsNewCapture: true, additionalActions: [addition] };
}

/**
 * A length far beyond every string bound the upstream action schemas enforce.
 * The bounds themselves are module-private to `@debuggen/instrumentation`, so
 * the suite exceeds them by a wide margin instead of restating them.
 */
const EXCESSIVE_LENGTH = 10_000;

/** `unit` repeated {@link EXCESSIVE_LENGTH} times. */
function excessive(unit: string): string {
  return unit.repeat(EXCESSIVE_LENGTH);
}

/** A project-relative path spelled with Windows separators. */
function windowsSpelling(path: string): string {
  return path.replaceAll('/', '\\');
}

/**
 * A value no member of `vocabulary` equals: every member joined, which is
 * longer than any one of them. Derived from the imported vocabulary so the
 * suite never restates it.
 */
function outsideOf(vocabulary: readonly string[]): string {
  const value = vocabulary.join('+');
  if (vocabulary.includes(value)) {
    throw new Error('Expected a value outside the vocabulary.');
  }
  return value;
}

describe('isFollowUpDecision and followUpDecisionSchema', () => {
  it('accepts a decision with no additions, with authoring targets and with resolved actions', () => {
    const valid: readonly unknown[] = [
      EXISTING_EVIDENCE_DECISION,
      { needsNewCapture: true, additionalActions: [] },
      FETCH_DECISION,
      decisionWith({ file: INDEXED_FILE, symbol: INDEXED_SYMBOL, type: 'server-span' }),
      decisionWith({ ...ADD_SPAN_ON_TIMED_FILE, file: `./${INDEXED_FILE}` }),
      decisionWith(RESOLVED_ADDITION),
      { needsNewCapture: false, additionalActions: [ADD_FETCH, RESOLVED_ADDITION] },
      {
        needsNewCapture: true,
        additionalActions: Array.from(
          { length: MAX_FOLLOW_UP_ADDITIONAL_ACTIONS },
          () => ADD_FETCH,
        ),
      },
    ];
    for (const value of valid) {
      expect(isFollowUpDecision(value)).toBe(true);
      expect(followUpDecisionSchema.safeParse(value).success).toBe(true);
    }
  });

  it('accepts every action type and both install modes the imported vocabularies define', () => {
    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      expect(isFollowUpAdditionalAction({ file: OTHER_FILE, symbol: OTHER_SYMBOL, type })).toBe(
        true,
      );
    }
    for (const mode of INSTRUMENTATION_MODES) {
      expect(isFollowUpAdditionalAction({ ...RESOLVED_ADDITION, mode })).toBe(true);
    }
  });

  // Each variant differs from a valid decision in exactly one checked condition.
  const decisionVariants: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['undefined', undefined],
    ['an array', [EXISTING_EVIDENCE_DECISION]],
    ['a string', JSON.stringify(EXISTING_EVIDENCE_DECISION)],
    ['a number', 1],
    ['a null-prototype object', Object.assign(Object.create(null) as object, FETCH_DECISION)],
    [
      'a class instance',
      new (class Decision {
        readonly needsNewCapture = true;
        readonly additionalActions = [];
      })(),
    ],
    ['a missing needsNewCapture', withField(FETCH_DECISION, 'needsNewCapture', undefined)],
    ['a truthy string needsNewCapture', withField(FETCH_DECISION, 'needsNewCapture', 'true')],
    ['a numeric needsNewCapture', withField(FETCH_DECISION, 'needsNewCapture', 1)],
    ['an object needsNewCapture', withField(FETCH_DECISION, 'needsNewCapture', {})],
    ['a null needsNewCapture', withField(FETCH_DECISION, 'needsNewCapture', null)],
    ['a missing additionalActions', withField(FETCH_DECISION, 'additionalActions', undefined)],
    [
      'an object additionalActions',
      withField(FETCH_DECISION, 'additionalActions', { 0: ADD_FETCH }),
    ],
    [
      'too many additions',
      withField(
        FETCH_DECISION,
        'additionalActions',
        Array.from({ length: MAX_FOLLOW_UP_ADDITIONAL_ACTIONS + 1 }, () => ADD_FETCH),
      ),
    ],
    [
      'a hole in additionalActions',
      withField(FETCH_DECISION, 'additionalActions', listWithHole(ADD_FETCH)),
    ],
    ['a string additionalActions', withField(FETCH_DECISION, 'additionalActions', 'none')],
    ['an unknown top-level key', { ...FETCH_DECISION, removeActions: [actionId(1)] }],
    [
      'a getter for needsNewCapture',
      Object.defineProperty({ additionalActions: [] }, 'needsNewCapture', {
        enumerable: true,
        get: () => true,
      }),
    ],
    ['a symbol key', { ...FETCH_DECISION, [Symbol('extra')]: true }],
  ];

  it.each(decisionVariants)('rejects a decision that is %s', (_label, value) => {
    expect(isFollowUpDecision(value)).toBe(false);
    expect(followUpDecisionSchema.safeParse(value).success).toBe(false);
  });

  // Each variant differs from a valid authoring target in exactly one checked condition.
  const targetVariants: readonly (readonly [string, unknown])[] = [
    ['has an unknown key', { ...ADD_SPAN_ON_TIMED_FILE, remove: true }],
    ['has an absolute file', withField(ADD_SPAN_ON_TIMED_FILE, 'file', `/${INDEXED_FILE}`)],
    ['has a traversing file', withField(ADD_SPAN_ON_TIMED_FILE, 'file', `../${INDEXED_FILE}`)],
    ['has a non-string file', withField(ADD_SPAN_ON_TIMED_FILE, 'file', 7)],
    ['has no file', withField(ADD_SPAN_ON_TIMED_FILE, 'file', undefined)],
    ['has a blank symbol', withField(ADD_SPAN_ON_TIMED_FILE, 'symbol', '   ')],
    ['has no symbol', withField(ADD_SPAN_ON_TIMED_FILE, 'symbol', undefined)],
    ['has an unknown type', withField(ADD_SPAN_ON_TIMED_FILE, 'type', 'heap-snapshot')],
    ['has no type', withField(ADD_SPAN_ON_TIMED_FILE, 'type', undefined)],
    ['has a blank rationale', withField(ADD_SPAN_ON_TIMED_FILE, 'rationale', ' ')],
    ['has a non-string rationale', withField(ADD_SPAN_ON_TIMED_FILE, 'rationale', 3)],
    [
      'has a traversing file spelled with backslashes',
      withField(ADD_SPAN_ON_TIMED_FILE, 'file', `..\\${windowsSpelling(INDEXED_FILE)}`),
    ],
    [
      'has a drive-letter file',
      withField(ADD_SPAN_ON_TIMED_FILE, 'file', `C:\\${windowsSpelling(INDEXED_FILE)}`),
    ],
    ['has an empty file', withField(ADD_SPAN_ON_TIMED_FILE, 'file', '')],
    ['has an empty symbol', withField(ADD_SPAN_ON_TIMED_FILE, 'symbol', '')],
    ['has an empty rationale', withField(ADD_SPAN_ON_TIMED_FILE, 'rationale', '')],
    [
      'has an over-long file',
      withField(ADD_SPAN_ON_TIMED_FILE, 'file', `src/${excessive('f')}.ts`),
    ],
    ['has an over-long symbol', withField(ADD_SPAN_ON_TIMED_FILE, 'symbol', excessive('s'))],
    ['has an over-long rationale', withField(ADD_SPAN_ON_TIMED_FILE, 'rationale', excessive('r'))],
    ['is a string', `${INDEXED_FILE}#${INDEXED_SYMBOL}`],
    ['is null', null],
    ['is an array', [INDEXED_FILE, INDEXED_SYMBOL, 'server-span']],
    ['is a number', 7],
  ];

  it.each(targetVariants)('rejects an authoring target that %s', (_label, addition) => {
    expect(isFollowUpAdditionalAction(addition)).toBe(false);
    expect(isFollowUpDecision(decisionWith(addition))).toBe(false);
  });

  // Each variant differs from a valid resolved action in exactly one checked condition.
  const resolvedVariants: readonly (readonly [string, unknown])[] = [
    ['has an unknown mode', withField(RESOLVED_ADDITION, 'mode', 'hotpatch')],
    ['has no adapter', withField(RESOLVED_ADDITION, 'adapter', undefined)],
    ['has a blank adapter', withField(RESOLVED_ADDITION, 'adapter', ' ')],
    ['has no mode', withField(RESOLVED_ADDITION, 'mode', undefined)],
    ['has a blank id', withField(RESOLVED_ADDITION, 'id', '')],
    ['has an id outside the product shape', withField(RESOLVED_ADDITION, 'id', 'not-an-action-id')],
    ['has no rationale', withField(RESOLVED_ADDITION, 'rationale', undefined)],
    ['has a file outside its normal form', withField(RESOLVED_ADDITION, 'file', `./${OTHER_FILE}`)],
    ['has an unknown type', withField(RESOLVED_ADDITION, 'type', 'heap-snapshot')],
    ['has an unknown key', { ...RESOLVED_ADDITION, priority: 1 }],
    ['has no id', withField(RESOLVED_ADDITION, 'id', undefined)],
    ['has no file', withField(RESOLVED_ADDITION, 'file', undefined)],
    ['has no symbol', withField(RESOLVED_ADDITION, 'symbol', undefined)],
    ['has no type', withField(RESOLVED_ADDITION, 'type', undefined)],
    ['has an absolute file', withField(RESOLVED_ADDITION, 'file', `/${OTHER_FILE}`)],
    ['has a traversing file', withField(RESOLVED_ADDITION, 'file', `../${OTHER_FILE}`)],
    [
      'has a file spelled with backslashes',
      withField(RESOLVED_ADDITION, 'file', windowsSpelling(OTHER_FILE)),
    ],
    ['has a blank symbol', withField(RESOLVED_ADDITION, 'symbol', ' ')],
    ['has a blank rationale', withField(RESOLVED_ADDITION, 'rationale', ' ')],
    ['has an over-long symbol', withField(RESOLVED_ADDITION, 'symbol', excessive('s'))],
    ['has an over-long adapter', withField(RESOLVED_ADDITION, 'adapter', excessive('a'))],
    ['has an over-long rationale', withField(RESOLVED_ADDITION, 'rationale', excessive('r'))],
    ['has an over-long id', withField(RESOLVED_ADDITION, 'id', `act_${excessive('0')}`)],
    ['is a null-prototype object', Object.assign(Object.create(null) as object, RESOLVED_ADDITION)],
  ];

  it.each(resolvedVariants)('rejects a resolved action that %s', (_label, addition) => {
    expect(isFollowUpAdditionalAction(addition)).toBe(false);
    expect(isFollowUpDecision(decisionWith(addition))).toBe(false);
  });

  it('never runs a getter on an addition and never throws on a hostile value', () => {
    const getter = vi.fn(() => INDEXED_FILE);
    const accessor = Object.defineProperty(
      { symbol: INDEXED_SYMBOL, type: 'server-span' },
      'file',
      { enumerable: true, get: getter },
    );
    expect(isFollowUpDecision(decisionWith(accessor))).toBe(false);
    expect(getter).not.toHaveBeenCalled();

    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile');
        },
        getPrototypeOf: () => Object.prototype,
      },
    );
    expect(() => isFollowUpDecision(hostile)).not.toThrow();
    expect(isFollowUpDecision(hostile)).toBe(false);
    expect(isFollowUpDecision(decisionWith(hostile))).toBe(false);
  });

  it('refuses an action type or install mode outside the imported vocabularies', () => {
    const unknownType = outsideOf(INSTRUMENTATION_ACTION_TYPES);
    const unknownMode = outsideOf(INSTRUMENTATION_MODES);
    // The literal variants of the tables above are outside the vocabularies too, so each of
    // those rejections is attributable to the vocabulary rule rather than to a typo.
    const typeValues: readonly string[] = INSTRUMENTATION_ACTION_TYPES;
    const modeValues: readonly string[] = INSTRUMENTATION_MODES;
    expect(typeValues.includes('heap-snapshot')).toBe(false);
    expect(modeValues.includes('hotpatch')).toBe(false);

    const [firstType] = INSTRUMENTATION_ACTION_TYPES;
    const [firstMode] = INSTRUMENTATION_MODES;
    const refusedTypes = [unknownType, firstType.toUpperCase(), ` ${firstType}`, ''];
    for (const type of refusedTypes) {
      expect(isFollowUpAdditionalAction({ file: OTHER_FILE, symbol: OTHER_SYMBOL, type })).toBe(
        false,
      );
      expect(isFollowUpAdditionalAction({ ...RESOLVED_ADDITION, type })).toBe(false);
      expect(isFollowUpDecision(decisionWith({ ...RESOLVED_ADDITION, type }))).toBe(false);
    }
    for (const mode of [unknownMode, firstMode.toUpperCase(), '']) {
      expect(isFollowUpAdditionalAction({ ...RESOLVED_ADDITION, mode })).toBe(false);
      expect(isFollowUpDecision(decisionWith({ ...RESOLVED_ADDITION, mode }))).toBe(false);
    }
  });

  it('accepts a Windows-spelled authoring path, which the authoring schema tolerates as cosmetic, but never in a resolved action', () => {
    const spelled = { ...ADD_SPAN_ON_TIMED_FILE, file: windowsSpelling(INDEXED_FILE) };
    expect(isFollowUpAdditionalAction(spelled)).toBe(true);
    expect(isFollowUpDecision(decisionWith(spelled))).toBe(true);
    // A resolved action must already be in its normal form: it is matched on identity as is.
    expect(
      isFollowUpAdditionalAction({ ...RESOLVED_ADDITION, file: windowsSpelling(OTHER_FILE) }),
    ).toBe(false);
  });

  it('is total: false, never a throw, for cyclic, accessor-laden, deeply nested and very long values', () => {
    const cyclicDecision: Record<string, unknown> = { needsNewCapture: true };
    cyclicDecision['additionalActions'] = [cyclicDecision];

    const cyclicTarget: Record<string, unknown> = {
      file: OTHER_FILE,
      symbol: OTHER_SYMBOL,
      type: 'function-timing',
    };
    cyclicTarget['rationale'] = cyclicTarget;

    const selfListing: unknown[] = [];
    selfListing.push(selfListing);

    const throwingTopLevel = Object.defineProperty({ needsNewCapture: true }, 'additionalActions', {
      enumerable: true,
      get: () => {
        throw new Error('getter must not run');
      },
    });
    const throwingIndex = Object.defineProperty([] as unknown[], 0, {
      enumerable: true,
      get: () => {
        throw new Error('getter must not run');
      },
    });
    const throwingDescriptor = new Proxy(
      { needsNewCapture: true, additionalActions: [] },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('hostile descriptor');
        },
      },
    );

    let deepObject: unknown = ADD_FETCH;
    let deepList: unknown = [ADD_FETCH];
    for (let depth = 0; depth < EXCESSIVE_LENGTH; depth += 1) {
      deepObject = { nested: deepObject };
      deepList = [deepList];
    }

    const hostile: readonly unknown[] = [
      cyclicDecision,
      decisionWith(cyclicTarget),
      { needsNewCapture: false, additionalActions: selfListing },
      throwingTopLevel,
      { needsNewCapture: true, additionalActions: throwingIndex },
      throwingDescriptor,
      decisionWith(deepObject),
      { needsNewCapture: true, additionalActions: deepList },
      { needsNewCapture: excessive('t'), additionalActions: [] },
      { [excessive('k')]: true, needsNewCapture: true, additionalActions: [] },
      decisionWith({ ...ADD_FETCH, rationale: excessive('r ') }),
      decisionWith({
        file: `${excessive('d/')}x.ts`,
        symbol: OTHER_SYMBOL,
        type: 'function-timing',
      }),
    ];
    for (const value of hostile) {
      expect(() => isFollowUpDecision(value)).not.toThrow();
      expect(isFollowUpDecision(value)).toBe(false);
      expect(() => followUpDecisionSchema.safeParse(value)).not.toThrow();
      expect(followUpDecisionSchema.safeParse(value).success).toBe(false);
    }
  });

  it('wires the schema to the guard: the two agree on every value, and a parse returns the value itself', () => {
    const corpus: readonly unknown[] = [
      EXISTING_EVIDENCE_DECISION,
      FETCH_DECISION,
      decisionWith(RESOLVED_ADDITION),
      decisionWith({ ...ADD_SPAN_ON_TIMED_FILE, file: windowsSpelling(INDEXED_FILE) }),
      ...decisionVariants.map(([, value]) => value),
      ...targetVariants.map(([, addition]) => decisionWith(addition)),
      ...resolvedVariants.map(([, addition]) => decisionWith(addition)),
    ];
    let accepted = 0;
    for (const value of corpus) {
      const guarded = isFollowUpDecision(value);
      const parsed = followUpDecisionSchema.safeParse(value);
      expect(parsed.success).toBe(guarded);
      if (parsed.success) {
        accepted += 1;
        expect(parsed.data).toBe(value);
      }
    }
    // Both verdicts occur, so the agreement is not vacuous.
    expect(accepted).toBe(4);
    expect(corpus.length - accepted).toBeGreaterThan(accepted);
  });

  it('names the artifact in its rejection, and the stage labels its repair turn with the schema name', () => {
    const parsed = followUpDecisionSchema.safeParse({ needsNewCapture: 'yes' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('FollowUpDecision');
    expect(FOLLOW_UP_DECISION_SCHEMA_NAME.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The additive-only rule
// ---------------------------------------------------------------------------

describe('diffAdditionalActions', () => {
  const installed: readonly InstrumentationAction[] = PLAN_V1.instrumentationTargets;

  /** The single rejection of a one-proposal diff, or a test failure. */
  function onlyRejection(proposal: FollowUpAdditionalAction): FollowUpActionDelta['rejected'][0] {
    const delta = diffAdditionalActions(installed, [proposal]);
    expect(delta.accepted).toStrictEqual([]);
    const [rejection] = delta.rejected;
    if (rejection === undefined || delta.rejected.length !== 1) {
      throw new Error('Expected exactly one rejection.');
    }
    return rejection;
  }

  it('accepts a new identity as an authoring target, with its file in normal form', () => {
    const delta = diffAdditionalActions(installed, [
      { file: `./${OTHER_FILE}`, symbol: OTHER_SYMBOL, type: 'function-timing' },
      ADD_FETCH,
    ]);
    expect(delta.rejected).toStrictEqual([]);
    expect(delta.accepted).toStrictEqual([
      { file: OTHER_FILE, symbol: OTHER_SYMBOL, type: 'function-timing' },
      {
        file: ADD_FETCH.file,
        symbol: ADD_FETCH.symbol,
        type: ADD_FETCH.type,
        rationale: ADD_FETCH.rationale,
      },
    ]);
  });

  it('accepts a new action type on an already instrumented file and symbol: it alters nothing installed', () => {
    const delta = diffAdditionalActions(installed, [ADD_SPAN_ON_TIMED_FILE]);
    expect(delta.rejected).toStrictEqual([]);
    expect(delta.accepted).toHaveLength(1);
  });

  it('accepts a resolved action with a fresh id and a new identity, dropping its id, adapter and mode', () => {
    const delta = diffAdditionalActions(installed, [RESOLVED_ADDITION]);
    expect(delta.rejected).toStrictEqual([]);
    expect(delta.accepted).toStrictEqual([
      {
        file: RESOLVED_ADDITION.file,
        symbol: RESOLVED_ADDITION.symbol,
        type: RESOLVED_ADDITION.type,
        rationale: RESOLVED_ADDITION.rationale,
      },
    ]);
  });

  it('refuses a re-emission of an installed identity, however it is spelled', () => {
    const spellings: readonly FollowUpAdditionalAction[] = [
      { file: INDEXED_FILE, symbol: INDEXED_SYMBOL, type: 'function-timing' },
      {
        file: `./${INDEXED_FILE}`,
        symbol: INDEXED_SYMBOL,
        type: 'function-timing',
        rationale: 'Reworded, but the same target.',
      },
      { ...INSTALLED_TIMING, rationale: 'Resolved and identical but for the rationale.' },
      { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
      { file: windowsSpelling(INDEXED_FILE), symbol: INDEXED_SYMBOL, type: 'function-timing' },
    ];
    for (const proposal of spellings) {
      const rejection = onlyRejection(proposal);
      expect(rejection.reason).toBe(RE_EMISSION);
      expect(rejection.index).toBe(0);
      expect(rejection.actionType).toBe(proposal.type);
      expect([INSTALLED_TIMING.id, INSTALLED_INTERACTION.id]).toContain(
        rejection.installedActionId,
      );
    }
  });

  it('refuses a removal: an installed id moved to another file or symbol', () => {
    const rejection = onlyRejection({
      ...INSTALLED_TIMING,
      file: OTHER_FILE,
      symbol: OTHER_SYMBOL,
    });
    expect(rejection.reason).toBe(REMOVAL);
    expect(rejection.installedActionId).toBe(INSTALLED_TIMING.id);
  });

  it('refuses a replacement: an installed identity under another id, or another adapter', () => {
    const otherId = onlyRejection({ ...INSTALLED_TIMING, id: actionId(77) });
    expect(otherId.reason).toBe(REPLACEMENT);
    expect(otherId.installedActionId).toBe(INSTALLED_TIMING.id);

    const otherAdapter = onlyRejection({ ...INSTALLED_TIMING, adapter: WIRE_PROBE });
    expect(otherAdapter.reason).toBe(REPLACEMENT);
    expect(otherAdapter.installedActionId).toBe(INSTALLED_TIMING.id);
  });

  it('refuses a re-scope: an installed id given another type, or an installed identity another mode', () => {
    const otherType = onlyRejection({ ...INSTALLED_TIMING, type: 'server-span' });
    expect(otherType.reason).toBe(RE_SCOPE);
    expect(otherType.installedActionId).toBe(INSTALLED_TIMING.id);

    const otherMode = onlyRejection({ ...INSTALLED_TIMING, mode: RUNTIME });
    expect(otherMode.reason).toBe(RE_SCOPE);
    expect(otherMode.installedActionId).toBe(INSTALLED_TIMING.id);
  });

  it('refuses a duplicate of an addition already accepted in the same decision', () => {
    const delta = diffAdditionalActions(installed, [
      ADD_SPAN_ON_TIMED_FILE,
      { ...ADD_SPAN_ON_TIMED_FILE, file: `./${INDEXED_FILE}`, rationale: 'Again.' },
    ]);
    expect(delta.accepted).toHaveLength(1);
    expect(delta.rejected).toStrictEqual([
      { index: 1, reason: DUPLICATE, actionType: ADD_SPAN_ON_TIMED_FILE.type },
    ]);
  });

  it('gives every refusal its own reason code, covering the whole vocabulary, in proposal order', () => {
    const delta = diffAdditionalActions(installed, [
      { file: INDEXED_FILE, symbol: INDEXED_SYMBOL, type: 'function-timing' },
      { ...INSTALLED_TIMING, file: OTHER_FILE, symbol: OTHER_SYMBOL },
      { ...INSTALLED_TIMING, id: actionId(77) },
      { ...INSTALLED_TIMING, type: 'server-span' },
      ADD_FETCH,
      ADD_FETCH,
    ]);
    expect(delta.accepted).toHaveLength(1);
    expect(delta.rejected.map((rejection) => [rejection.index, rejection.reason])).toStrictEqual([
      [0, RE_EMISSION],
      [1, REMOVAL],
      [2, REPLACEMENT],
      [3, RE_SCOPE],
      [5, DUPLICATE],
    ]);
    expect(new Set(delta.rejected.map((rejection) => rejection.reason))).toStrictEqual(
      new Set(FOLLOW_UP_DELTA_REJECTION_REASONS),
    );
  });

  it('computes identity with the imported actionIdentityKey', () => {
    vi.mocked(actionIdentityKey).mockClear();
    diffAdditionalActions(installed, [ADD_SPAN_ON_TIMED_FILE]);
    const keyed = vi.mocked(actionIdentityKey).mock.calls.map(([action]) => action);
    expect(keyed).toContainEqual(expect.objectContaining({ id: INSTALLED_TIMING.id }));
    expect(keyed).toContainEqual({
      file: ADD_SPAN_ON_TIMED_FILE.file,
      symbol: ADD_SPAN_ON_TIMED_FILE.symbol,
      type: ADD_SPAN_ON_TIMED_FILE.type,
    });
  });

  it('follows actionIdentityKey equality: each reason matches its relation to the collided installed action', () => {
    const installedKeys = new Set(installed.map((action) => actionIdentityKey(action)));
    const byId = new Map(installed.map((action) => [action.id, action]));
    const proposals: readonly InstrumentationAction[] = [
      { ...INSTALLED_TIMING, rationale: 'Restated.' },
      { ...INSTALLED_TIMING, id: actionId(78) },
      { ...INSTALLED_TIMING, adapter: WIRE_PROBE },
      { ...INSTALLED_TIMING, mode: RUNTIME },
      { ...INSTALLED_TIMING, file: OTHER_FILE, symbol: OTHER_SYMBOL },
      { ...INSTALLED_TIMING, type: 'server-span' },
      { ...RESOLVED_ADDITION },
    ];

    const verdicts = proposals.map((proposal) => {
      const delta = diffAdditionalActions(installed, [proposal]);
      const [rejection] = delta.rejected;
      const collided =
        rejection?.installedActionId === undefined
          ? undefined
          : byId.get(rejection.installedActionId);
      return {
        reason: rejection?.reason,
        accepted: delta.accepted.length,
        sameKey:
          collided === undefined
            ? undefined
            : actionIdentityKey(collided) === actionIdentityKey(proposal),
        sameId: collided?.id === proposal.id,
      };
    });

    expect(verdicts).toStrictEqual([
      { reason: RE_EMISSION, accepted: 0, sameKey: true, sameId: true },
      { reason: REPLACEMENT, accepted: 0, sameKey: true, sameId: false },
      { reason: REPLACEMENT, accepted: 0, sameKey: true, sameId: true },
      { reason: RE_SCOPE, accepted: 0, sameKey: true, sameId: true },
      { reason: REMOVAL, accepted: 0, sameKey: false, sameId: true },
      { reason: RE_SCOPE, accepted: 0, sameKey: false, sameId: true },
      { reason: undefined, accepted: 1, sameKey: undefined, sameId: false },
    ]);
    // The accepted addition is exactly the proposal whose key no installed action has.
    expect(installedKeys.has(actionIdentityKey(RESOLVED_ADDITION))).toBe(false);
  });

  it('is pure: frozen inputs are untouched, the verdict is frozen and repeatable', () => {
    const previous = deepFreeze(structuredClone([...installed]));
    const proposals = deepFreeze<FollowUpAdditionalAction[]>([
      ADD_FETCH,
      { file: INDEXED_FILE, symbol: INDEXED_SYMBOL, type: 'function-timing' },
    ]);
    const first = diffAdditionalActions(previous, proposals);
    const second = diffAdditionalActions(previous, proposals);
    expect(second).toStrictEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.accepted)).toBe(true);
    expect(Object.isFrozen(first.rejected)).toBe(true);
    expect(previous).toStrictEqual(installed);
  });

  it('accepts nothing from an empty proposal list', () => {
    expect(diffAdditionalActions(installed, [])).toStrictEqual({ accepted: [], rejected: [] });
  });
});

describe('followUpPathFor', () => {
  const none: FollowUpActionDelta = { accepted: [], rejected: [] };
  const some: FollowUpActionDelta = { accepted: [ADD_FETCH], rejected: [] };
  const refusedOnly: FollowUpActionDelta = {
    accepted: [],
    rejected: [{ index: 0, reason: RE_EMISSION, actionType: 'function-timing' }],
  };

  it('is total over its inputs and returns a member of the closed path vocabulary', () => {
    const [EXISTING, NEW_CAPTURE] = FOLLOW_UP_PATHS;
    expect(followUpPathFor(false, none)).toBe(EXISTING);
    expect(followUpPathFor(false, refusedOnly)).toBe(EXISTING);
    expect(followUpPathFor(true, none)).toBe(NEW_CAPTURE);
    expect(followUpPathFor(false, some)).toBe(NEW_CAPTURE);
    expect(followUpPathFor(true, some)).toBe(NEW_CAPTURE);
    expect(FOLLOW_UP_PATHS).toStrictEqual(['existing-evidence', 'new-capture']);
  });
});

// ---------------------------------------------------------------------------
// 3. Plan n + 1 is the previous plan plus the delta
// ---------------------------------------------------------------------------

describe('buildFollowUpPlanInput', () => {
  it('restates every installed action first, then the delta, keeping the objective, capture and hypotheses', () => {
    const delta = diffAdditionalActions(PLAN_V1.instrumentationTargets, [
      ADD_FETCH,
      ADD_SPAN_ON_TIMED_FILE,
    ]).accepted;
    const input = buildFollowUpPlanInput(PLAN_V1, delta);

    expect(input.objective).toBe(PLAN_V1.objective);
    expect(input.capture).toStrictEqual(PLAN_V1.capture);
    expect(input.hypotheses).toStrictEqual(PLAN_V1.hypotheses);
    expect(input.instrumentationTargets).toStrictEqual([
      ...PLAN_V1.instrumentationTargets.map(({ file, symbol, type, rationale }) => ({
        file,
        symbol,
        type,
        rationale,
      })),
      ...delta,
    ]);
  });

  it('normalises, with the previous actions, to a valid plan whose installed actions keep their ids', () => {
    const delta = diffAdditionalActions(PLAN_V1.instrumentationTargets, [
      ADD_FETCH,
      ADD_SPAN_ON_TIMED_FILE,
    ]).accepted;
    const registry = fakeRegistry();
    const normalized = expectOk(
      normalizePlan(buildFollowUpPlanInput(PLAN_V1, delta), {
        sessionId: SESSION_ID,
        planVersion: 2,
        resolver: { resolveActionType: (type) => registry.resolveActionType(type) },
        previousActions: PLAN_V1.instrumentationTargets,
        newActionId: actionIdMinter(),
      }),
    );
    const plan = instrumentationPlanSchema.parse(normalized);
    const targets = plan.instrumentationTargets;

    expect(plan.planVersion).toBe(2);
    expect(targets).toHaveLength(PLAN_V1.instrumentationTargets.length + delta.length);
    expect(targets.slice(0, PLAN_V1.instrumentationTargets.length)).toStrictEqual(
      PLAN_V1.instrumentationTargets,
    );
    const additions = targets.slice(PLAN_V1.instrumentationTargets.length);
    const installedIds = new Set(PLAN_V1.instrumentationTargets.map((action) => action.id));
    for (const addition of additions) {
      expect(addition.id).toMatch(ACTION_ID_PATTERN);
      expect(installedIds.has(addition.id)).toBe(false);
    }
    expect(additions.map((action) => actionIdentityKey(action))).toStrictEqual(
      delta.map((target) => actionIdentityKey(target)),
    );
    // The same file and symbol as an installed action, under its own id: a second link in its chain.
    expect(additions[1]?.file).toBe(INSTALLED_TIMING.file);
    expect(additions[1]?.id).not.toBe(INSTALLED_TIMING.id);
  });

  it('with no delta, restates the previous plan exactly', () => {
    const input = buildFollowUpPlanInput(PLAN_V1, []);
    expect(input.instrumentationTargets).toHaveLength(PLAN_V1.instrumentationTargets.length);
  });
});

// ---------------------------------------------------------------------------
// 4a. The existing-evidence path
// ---------------------------------------------------------------------------

describe('createFollowUpStage — the existing-evidence path', () => {
  it('regenerates the analysis and the panel from the stored capture as new, superseding versions', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    const chosen: string[] = [];
    const result = expectOk(
      await h.stage.run(
        h.context,
        followUpInput({
          onPathChosen: (path) => {
            chosen.push(path);
            return Promise.resolve(ok(undefined));
          },
        }),
      ),
    );
    const value = expectPath(result, 'existing-evidence');

    expect(chosen).toStrictEqual(['existing-evidence']);
    expect(value.captureId).toBe(CAPTURE_ID);
    expect(value.analysisVersion).toBe(2);
    expect(value.analysis.supersedes).toBe(ANALYSIS_V1.id);
    expect(value.supersededAnalysisId).toBe(ANALYSIS_V1.id);
    expect(value.panelVersion).toBe(2);
    expect(value.panel.supersedes).toBe(PANEL_V1.id);
    expect(value.supersededPanelId).toBe(PANEL_V1.id);
    expect(value.fallbackPanel).toBe(false);
    expect(value.outcomeRecorded).toBe(true);
    expect(value.decision.needsNewCapture).toBe(false);
    expect(value.decision.acceptedActions).toStrictEqual([]);

    // Versioned, not mutated: the previous analysis is still on the ladder beside the new one.
    expect(h.ladder.map((entry) => entry.id)).toStrictEqual([ANALYSIS_V1.id, value.analysis.id]);

    // The analysis half: the stored capture, the session's understanding and recorded version.
    expect(h.analysisRun).toHaveBeenCalledTimes(1);
    const [analysisContext, analysisInput] = h.analysisRun.mock.calls[0] ?? [];
    expect(analysisInput).toStrictEqual({
      captureId: CAPTURE_ID,
      understanding: UNDERSTANDING,
      promptVersion: RECORDED_PROMPT_VERSIONS.analyze,
      regenerate: true,
      supersedes: ANALYSIS_V1.id,
    });
    expect(analysisContext?.followUpQuestion).toBe(FOLLOW_UP_QUESTION);
    expect(analysisContext?.captureId).toBe(CAPTURE_ID);

    // The panel half: the new analysis, both questions and the recorded version.
    expect(h.regenerate).toHaveBeenCalledTimes(1);
    const [panelRequest] = h.regenerate.mock.calls[0] ?? [];
    expect(panelRequest).toMatchObject({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      question: h.context.question,
      followUpQuestion: FOLLOW_UP_QUESTION,
      analysis: value.analysis,
      summary: CAPTURE_SUMMARY,
      promptVersion: RECORDED_PROMPT_VERSIONS['generate-panel'],
    });
    expect(value.analysisPromptVersion).toBe(RECORDED_PROMPT_VERSIONS.analyze);
    expect(value.panelPromptVersion).toBe(RECORDED_PROMPT_VERSIONS['generate-panel']);
    expect(firstOrder(h.analysisRun)).toBeLessThan(firstOrder(h.regenerate));

    // Nothing touches instrumentation, the plan ladder or the modification journal.
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.recordPlan).not.toHaveBeenCalled();
    expect(h.nextPlanVersion).not.toHaveBeenCalled();
    expect(h.latestRecordForFile).not.toHaveBeenCalled();
    expect(vi.mocked(normalizePlan)).not.toHaveBeenCalled();
    expect(vi.mocked(checkPlanFeasibility)).not.toHaveBeenCalled();

    // The follow-up is recorded when asked, and its outcome links afterwards.
    expect(h.appendFollowUp).toHaveBeenCalledWith(SESSION_ID, FOLLOW_UP_QUESTION);
    expect(firstOrder(h.appendFollowUp)).toBeLessThan(firstOrder(h.provider.structured));
    const outcomeLinks: FollowUpOutcome = {
      needsNewCapture: false,
      captureId: CAPTURE_ID,
      analysisId: value.analysis.id,
      panelId: value.panel.id,
    };
    expect(h.recordFollowUpOutcome).toHaveBeenCalledWith(SESSION_ID, outcomeLinks);

    // Its own groups only; the analyze rows are the analysis port's.
    expect(h.progress.trail).toStrictEqual([
      `stageStarted:${FOLLOWUP}`,
      `stageCompleted:${FOLLOWUP}`,
      `stageStarted:${GENERATE_PANEL}`,
      `stageCompleted:${GENERATE_PANEL}`,
    ]);
    expect(h.progress.foreign).toStrictEqual([]);
    expect(h.provider.structured).toHaveBeenCalledTimes(1);
  });

  it('touches no file and mutates no stored artifact: the stored rows are read frozen and only new versions appear', async () => {
    // Deep-frozen copies: an in-place write by the stage would throw in strict mode and fail the run.
    const storedPlan = deepFreeze(structuredClone(PLAN_V1));
    const storedAnalysis = deepFreeze(structuredClone(ANALYSIS_V1));
    const storedPanel = deepFreeze(structuredClone(PANEL_V1));
    const storedSession = deepFreeze(structuredClone(sessionRecord()));
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      installedPlan: storedPlan,
      latestAnalysis: storedAnalysis,
      latestPanel: storedPanel,
      session: storedSession,
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'existing-evidence',
    );

    expect(storedPlan).toStrictEqual(PLAN_V1);
    expect(storedAnalysis).toStrictEqual(ANALYSIS_V1);
    expect(storedPanel).toStrictEqual(PANEL_V1);
    expect(storedSession).toStrictEqual(sessionRecord());

    // A new analysis row beside the untouched previous one, and a new panel with its own id.
    expect(h.ladder).toHaveLength(2);
    expect(h.ladder[0]).toBe(storedAnalysis);
    expect(value.analysis.id).not.toBe(storedAnalysis.id);
    expect(value.analysis.analysisVersion).toBe(storedAnalysis.analysisVersion + 1);
    expect(value.panel.id).not.toBe(storedPanel.id);
    expect(value.panel.panelVersion).toBe(storedPanel.panelVersion + 1);

    // No journal, backup or modification-repository access and no instrumentation call at all.
    expect(h.modificationReads).toStrictEqual([]);
    expect(h.writeReads).toStrictEqual([]);
    expect(h.instrumentationReads).toStrictEqual([]);
    expect(new Set(h.sessionManagerReads)).toStrictEqual(
      new Set(['appendFollowUp', 'recordFollowUpOutcome']),
    );
  });

  it('asks the builder for the seven placeholders of the follow-up prompt, with the session’s recorded version', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    expectOk(await h.stage.run(h.context, followUpInput()));

    expect(h.builder.calls).toHaveLength(1);
    const [call] = h.builder.calls;
    expect(call?.followUpQuestion).toBe(FOLLOW_UP_QUESTION);
    expect(call?.understanding).toStrictEqual(UNDERSTANDING);
    expect(call?.plan).toBe(PLAN_V1);
    expect(call?.captureSummary).toBe(CAPTURE_SUMMARY);
    expect(call?.analysis).toBe(ANALYSIS_V1);
    expect(call?.panel).toBe(PANEL_V1);
    expect(call?.promptVersion).toBe(RECORDED_PROMPT_VERSIONS.followup);
    expect(call?.context.followUpQuestion).toBe(FOLLOW_UP_QUESTION);

    // Six data values plus the schema the builder renders itself: the prompt's declared set.
    expect(FOLLOW_UP_STAGE).toBe(FOLLOWUP);
    expect([...STAGE_PLACEHOLDERS[FOLLOW_UP_STAGE]].sort()).toStrictEqual(
      [
        'followUpQuestion',
        'understanding',
        'plan',
        'captureSummary',
        'analysis',
        'panel',
        'outputSchema',
      ].sort(),
    );
    const [request] = h.provider.structured.mock.calls[0] ?? [];
    expect(request?.metadata?.promptVersion).toBe(RECORDED_PROMPT_VERSIONS.followup);
  });

  it('carries the run’s cancellation signal to the request builder and the install', async () => {
    const controller = new AbortController();
    const h = harness({ outcomes: [answer(FETCH_DECISION)] });
    const context = stageContext(sessionRecord(), controller.signal);
    expectOk(await h.stage.run(context, followUpInput()));
    expect(h.builder.calls[0]?.signal).toBe(controller.signal);
    expect(h.provider.structured.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(installRequestOf(h).signal).toBe(controller.signal);
  });

  it('lets an explicit prompt version override the recorded one', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    const value = expectOk(await h.stage.run(h.context, followUpInput({ promptVersion: 'v009' })));
    expect(h.builder.calls[0]?.promptVersion).toBe('v009');
    expect(value.decision.promptVersion).toBe('v009');
  });

  it('stays on the existing evidence when every proposed addition was refused', async () => {
    const h = harness({
      outcomes: [
        answer({
          needsNewCapture: false,
          additionalActions: [
            { file: INDEXED_FILE, symbol: INDEXED_SYMBOL, type: 'function-timing' },
          ],
        }),
      ],
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'existing-evidence',
    );
    expect(value.decision.rejectedActions).toStrictEqual([
      {
        index: 0,
        reason: RE_EMISSION,
        actionType: 'function-timing',
        installedActionId: INSTALLED_TIMING.id,
      },
    ]);
    expect(h.install).not.toHaveBeenCalled();
    expect(recordsWith(h.log.records, 'Follow-up decided.')[0]?.fields).toMatchObject({
      path: 'existing-evidence',
      proposed: 1,
      accepted: 0,
    });
  });

  it('refuses a regenerated analysis that does not supersede the previous version', async () => {
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      analysisAnswer: (input) =>
        ok({
          analysis: { ...nextAnalysis(input), supersedes: 'analysis-elsewhere' },
          analysisVersion: 2,
          promptVersion: 'v001',
          repairs: 0,
          attempts: 1,
          providerId: 'scripted-test-provider',
          model: 'scripted-model',
          verification: VERIFICATION,
          summary: CAPTURE_SUMMARY,
          truncated: [],
        }),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('STORE_ERROR');
    expect(reasonOf(error)).toBe('analysis-ladder-inconsistent');
    expect(stageOf(error)).toBe(ANALYZE);
    expect(h.regenerate).not.toHaveBeenCalled();
    expect(h.recordFollowUpOutcome).not.toHaveBeenCalled();
  });

  it('refuses a regenerated analysis the ladder does not hold as its newest version', async () => {
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      analysisAnswer: (input) =>
        ok({
          analysis: nextAnalysis(input),
          analysisVersion: 2,
          promptVersion: 'v001',
          repairs: 0,
          attempts: 1,
          providerId: 'scripted-test-provider',
          model: 'scripted-model',
          verification: VERIFICATION,
          summary: CAPTURE_SUMMARY,
          truncated: [],
        }),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(reasonOf(error)).toBe('analysis-ladder-inconsistent');
    expect(h.history).toHaveBeenCalledWith(SESSION_ID);
    expect(h.regenerate).not.toHaveBeenCalled();
  });

  it('passes an analysis failure through, filed under the analyze stage and without a row of its own', async () => {
    const failure = new DebuggenError('MODEL_OUTPUT_INVALID', 'The analysis was rejected.');
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      analysisAnswer: () => err(failure),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(stageOf(error)).toBe(ANALYZE);
    expect(h.progress.trail).toStrictEqual([
      `stageStarted:${FOLLOWUP}`,
      `stageCompleted:${FOLLOWUP}`,
    ]);
  });

  it('fails the panel group when the panel regeneration fails', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    h.regenerate.mockResolvedValueOnce(err(new DebuggenError('INTERNAL', 'The panel failed.')));
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(stageOf(error)).toBe(GENERATE_PANEL);
    expect(h.progress.trail.at(-1)).toBe(`stageFailed:${GENERATE_PANEL}`);
    expect(h.recordFollowUpOutcome).not.toHaveBeenCalled();
  });

  it('needs the session’s understanding to re-analyse', async () => {
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      session: sessionRecord({ understanding: undefined }),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(reasonOf(error)).toBe('no-understanding');
    expect(h.analysisRun).not.toHaveBeenCalled();
    expect(h.progress.trail.at(-1)).toBe(`stageFailed:${FOLLOWUP}`);
  });

  it('reports, without failing, an outcome that could not be recorded', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)], recordOutcomeFails: true });
    const value = expectOk(await h.stage.run(h.context, followUpInput()));
    expect(value.outcomeRecorded).toBe(false);
    expect(
      recordsWith(
        h.log.records,
        'The follow-up outcome links could not be recorded; the stored artifacts stand.',
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4b. The new-capture path
// ---------------------------------------------------------------------------

describe('createFollowUpStage — the new-capture path', () => {
  it('installs plan version n + 1 — the previous plan plus the delta — and records it only after the install', async () => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)] });
    const seams: string[] = [];
    const result = expectOk(
      await h.stage.run(
        h.context,
        followUpInput({
          onPathChosen: (path) => {
            seams.push(`path:${path}`);
            return Promise.resolve(ok(undefined));
          },
          beforeInstall: (plan) => {
            seams.push(`install:${String(plan.planVersion)}`);
            return Promise.resolve(ok(undefined));
          },
        }),
      ),
    );
    const value = expectPath(result, 'new-capture');

    // The version comes from the store, and the plan is the previous one plus the delta.
    expect(h.nextPlanVersion).toHaveBeenCalledWith(SESSION_ID);
    expect(value.planVersion).toBe(2);
    expect(value.previousPlanVersion).toBe(1);
    const targets = value.plan.instrumentationTargets;
    expect(targets.slice(0, PLAN_V1.instrumentationTargets.length)).toStrictEqual(
      PLAN_V1.instrumentationTargets,
    );
    expect(value.delta).toStrictEqual(targets.slice(PLAN_V1.instrumentationTargets.length));
    expect(value.delta).toHaveLength(1);
    const [addition] = value.delta;
    expect(addition?.id).toMatch(ACTION_ID_PATTERN);
    expect(addition?.adapter).toBe(WIRE_PROBE);
    expect(addition?.mode).toBe(RUNTIME);
    expect(addition === undefined ? undefined : actionIdentityKey(addition)).toBe(
      actionIdentityKey(ADD_FETCH),
    );
    expect(value.plan.objective).toBe(PLAN_V1.objective);
    expect(instrumentationPlanSchema.safeParse(value.plan).success).toBe(true);

    // The deterministic gate, with the previous actions; then one install with the delta descriptor.
    const normalizeCall = vi.mocked(normalizePlan).mock.calls[0];
    expect(normalizeCall?.[1].previousActions).toBe(PLAN_V1.instrumentationTargets);
    expect(normalizeCall?.[1].planVersion).toBe(2);
    expect(vi.mocked(checkPlanFeasibility)).toHaveBeenCalledTimes(1);
    expect(firstOrder(vi.mocked(normalizePlan))).toBeLessThan(
      firstOrder(vi.mocked(checkPlanFeasibility)),
    );
    expect(h.install).toHaveBeenCalledTimes(1);
    const request = installRequestOf(h);
    expect(request.plan).toStrictEqual(value.plan);
    expect(request.previousPlanVersion).toBe(1);
    expect(request.previousActions).toBe(PLAN_V1.instrumentationTargets);
    expect(request.projectRoot).toBe(PROJECT_ROOT);
    expect(request.devServerUrl).toBe(DEV_SERVER_URL);

    // Recorded after the install, then the outcome links.
    expect(h.recordPlan).toHaveBeenCalledTimes(1);
    expect(h.recordPlan.mock.calls[0]?.[1]).toStrictEqual(value.plan);
    expect(firstOrder(h.install)).toBeLessThan(firstOrder(h.recordPlan));
    const outcomeLinks: FollowUpOutcome = { needsNewCapture: true, planVersion: 2 };
    expect(h.recordFollowUpOutcome).toHaveBeenCalledWith(SESSION_ID, outcomeLinks);

    // The orchestrator's seams run after the gate and before the install.
    expect(seams).toStrictEqual(['path:new-capture', 'install:2']);

    // Nothing is re-analysed and no panel is generated: the next capture does that.
    expect(h.analysisRun).not.toHaveBeenCalled();
    expect(h.regenerate).not.toHaveBeenCalled();

    // Its own groups only; the instrument rows and "Ready to capture" are the service's.
    expect(h.progress.trail).toStrictEqual([
      `stageStarted:${FOLLOWUP}`,
      `stageCompleted:${FOLLOWUP}`,
      `stageStarted:${PLAN}`,
      `stageCompleted:${PLAN}`,
    ]);
    expect(h.progress.foreign).toStrictEqual([]);
    expect(h.writeReads).toStrictEqual([]);
    expect(value.chainedFiles).toBe(0);
  });

  it('numbers plan n + 1 from the store: an installed version 2 becomes version 3, every installed id kept', async () => {
    const h = harness({
      outcomes: [answer({ needsNewCapture: true, additionalActions: [ADD_PERF] })],
      installedPlan: PLAN_V2,
      nextPlanVersion: 3,
      session: sessionRecord({ plans: [PLAN_V1, PLAN_V2] }),
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );

    // The installed version and the next number are both the store's answers.
    expect(h.latestPlanVersion).toHaveBeenCalledWith(SESSION_ID);
    expect(h.getPlan).toHaveBeenCalledWith(SESSION_ID, PLAN_V2.planVersion);
    expect(h.nextPlanVersion).toHaveBeenCalledTimes(1);
    expect(value.previousPlanVersion).toBe(2);
    expect(value.planVersion).toBe(3);
    expect(value.plan.planVersion).toBe(3);
    expect(vi.mocked(normalizePlan).mock.calls[0]?.[1].planVersion).toBe(3);
    expect(h.buildContext.mock.calls[0]?.[0].plan.planVersion).toBe(3);
    const request = installRequestOf(h);
    expect(request.plan.planVersion).toBe(3);
    expect(request.previousPlanVersion).toBe(2);
    expect(request.previousActions).toBe(PLAN_V2.instrumentationTargets);
    expect(h.recordPlan.mock.calls[0]?.[1].planVersion).toBe(3);

    // Previous plus delta: nothing dropped, nothing reordered, every installed id kept.
    const targets = value.plan.instrumentationTargets;
    expect(targets).toHaveLength(PLAN_V2.instrumentationTargets.length + 1);
    expect(targets.slice(0, PLAN_V2.instrumentationTargets.length)).toStrictEqual(
      PLAN_V2.instrumentationTargets,
    );
    expect(targets.map((action) => action.id).slice(0, 3)).toStrictEqual([
      INSTALLED_INTERACTION.id,
      INSTALLED_TIMING.id,
      INSTALLED_FETCH.id,
    ]);
    expect(value.delta.map((action) => actionIdentityKey(action))).toStrictEqual([
      actionIdentityKey(ADD_PERF),
    ]);
    expect(value.delta[0]?.adapter).toBe(PAGE_PROBE);
  });

  it('hands the installer a delta descriptor naming only the accepted additions', async () => {
    const h = harness({
      outcomes: [
        answer({
          needsNewCapture: true,
          additionalActions: [ADD_FETCH, { ...INSTALLED_TIMING, id: actionId(77) }, ADD_PERF],
        }),
      ],
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    const request = installRequestOf(h);
    const previous = request.previousActions ?? [];
    const previousIds = new Set(previous.map((action) => action.id));
    const previousKeys = new Set(previous.map((action) => actionIdentityKey(action)));

    // The descriptor: the previous version, its actions, and a plan whose other actions are the delta.
    expect(request.previousPlanVersion).toBe(PLAN_V1.planVersion);
    expect(previous).toStrictEqual(PLAN_V1.instrumentationTargets);
    expect(request.skipFeasibility).toBeUndefined();
    const described = request.plan.instrumentationTargets.filter(
      (action) => !previousIds.has(action.id),
    );
    expect(described.map((action) => action.id)).toStrictEqual(
      value.delta.map((action) => action.id),
    );
    expect(described.map((action) => actionIdentityKey(action))).toStrictEqual(
      value.decision.acceptedActions.map((target) => actionIdentityKey(target)),
    );
    expect(described).toHaveLength(2);

    // No installed action is named in it, by id or by identity; the refused replacement is absent.
    const describedIds = described.map((action) => action.id);
    for (const installed of PLAN_V1.instrumentationTargets) {
      expect(describedIds).not.toContain(installed.id);
    }
    for (const action of described) {
      expect(previousKeys.has(actionIdentityKey(action))).toBe(false);
    }
    expect(describedIds).not.toContain(actionId(77));
    expect(value.decision.rejectedActions.map((rejection) => rejection.reason)).toStrictEqual([
      REPLACEMENT,
    ]);
    expect(new Set(h.instrumentationReads)).toStrictEqual(new Set(['buildContext', 'install']));
  });

  it('takes the new-capture path for a new capture with no additions, installing the unchanged plan as n + 1', async () => {
    const h = harness({ outcomes: [answer({ needsNewCapture: true, additionalActions: [] })] });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    expect(value.delta).toStrictEqual([]);
    expect(value.plan.instrumentationTargets).toStrictEqual(PLAN_V1.instrumentationTargets);
    expect(value.planVersion).toBe(2);
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it('takes the new-capture path for an accepted addition even when the model said no capture is needed', async () => {
    const h = harness({
      outcomes: [answer({ needsNewCapture: false, additionalActions: [ADD_FETCH] })],
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    expect(value.decision.needsNewCapture).toBe(false);
    expect(value.delta).toHaveLength(1);
    expect(h.analysisRun).not.toHaveBeenCalled();
  });

  it('never re-installs a refused proposal: only accepted additions reach plan n + 1', async () => {
    const h = harness({
      outcomes: [
        answer({
          needsNewCapture: true,
          additionalActions: [
            { ...INSTALLED_TIMING, id: actionId(77) },
            { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
            ADD_FETCH,
          ],
        }),
      ],
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    expect(value.decision.rejectedActions.map((rejection) => rejection.reason)).toStrictEqual([
      REPLACEMENT,
      RE_EMISSION,
    ]);
    expect(value.plan.instrumentationTargets).toHaveLength(
      PLAN_V1.instrumentationTargets.length + 1,
    );
    expect(value.delta.map((action) => action.type)).toStrictEqual([ADD_FETCH.type]);
  });

  it('instruments a file plan version 1 already instruments as a second link of its modification chain', async () => {
    // Two plan versions on one file. The AST shape check needs a loaded TypeScript program this
    // suite does not construct, so this one run takes the real report and admits the patch-mode
    // refusal it produces; the integration suite runs the real check against an indexed project.
    vi.mocked(checkPlanFeasibility).mockImplementationOnce((plan) => ({
      feasible: [...plan.instrumentationTargets],
      rejected: [],
    }));
    const recordV2: ModificationRecord = {
      ...RECORD_V1,
      id: 'mod_000000000000000b',
      planVersion: 2,
      originalHash: RECORD_V1.instrumentedHash,
      instrumentedHash: 'c'.repeat(64),
      backupPath: `${DEBUGGEN_HOME}/backups/${SESSION_ID}/${RECORD_V1.instrumentedHash}`,
      previousRecordId: RECORD_V1.id,
    };
    const h = harness({
      outcomes: [answer({ needsNewCapture: true, additionalActions: [ADD_SPAN_ON_TIMED_FILE] })],
      chainHeads: new Map([[INDEXED_FILE, RECORD_V1]]),
      installAnswer: (request) => ok(outcomeFor(request, [recordV2])),
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );

    // A distinct action on the same file and symbol, under its own id and the patch adapter.
    const [addition] = value.delta;
    expect(addition?.file).toBe(INSTALLED_TIMING.file);
    expect(addition?.symbol).toBe(INSTALLED_TIMING.symbol);
    expect(addition?.type).toBe('server-span');
    expect(addition?.mode).toBe(PATCH);
    expect(addition?.adapter).toBe(SOURCE_PROBE);
    expect(addition?.id).not.toBe(INSTALLED_TIMING.id);
    expect(value.plan.instrumentationTargets[1]).toStrictEqual(INSTALLED_TIMING);

    // The chain head was looked up, read-only; the file counts as chained.
    expect(h.latestRecordForFile).toHaveBeenCalledWith(SESSION_ID, INDEXED_FILE);
    expect(value.chainedFiles).toBe(1);
    expect(new Set(h.modificationReads)).toStrictEqual(new Set(['latestRecordForFile']));

    // The installer — not the stage — applied the link, carried through unchanged.
    const request = installRequestOf(h);
    expect(request.previousActions).toContainEqual(INSTALLED_TIMING);
    const [applied] = value.installation.applied;
    expect(applied?.previousRecordId).toBe(RECORD_V1.id);
    expect(applied?.originalHash).toBe(RECORD_V1.instrumentedHash);
    expect(applied?.file).toBe(RECORD_V1.file);
    expect(h.recordPlan).toHaveBeenCalledTimes(1);

    // The stage wrote no record itself: one install call, no journal or backup access.
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.writeReads).toStrictEqual([]);
    expect(value.installation.applied).toStrictEqual([recordV2]);
  });

  it('does not count a reverted chain head as a live chain', async () => {
    vi.mocked(checkPlanFeasibility).mockImplementationOnce((plan) => ({
      feasible: [...plan.instrumentationTargets],
      rejected: [],
    }));
    const h = harness({
      outcomes: [answer({ needsNewCapture: true, additionalActions: [ADD_SPAN_ON_TIMED_FILE] })],
      chainHeads: new Map([[INDEXED_FILE, { ...RECORD_V1, status: 'reverted' }]]),
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    expect(value.chainedFiles).toBe(0);
  });

  it('refuses a delta none of whose additions can be installed, before any install', async () => {
    // The real gate: a patch-mode addition with no loaded TypeScript program is refused.
    const h = harness({
      outcomes: [answer({ needsNewCapture: true, additionalActions: [ADD_SPAN_ON_TIMED_FILE] })],
      chainHeads: new Map([[INDEXED_FILE, RECORD_V1]]),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(reasonOf(error)).toBe('delta-infeasible');
    expect(error.details?.['codes']).toStrictEqual([AST_UNAVAILABLE]);
    expect(stageOf(error)).toBe(PLAN);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.recordPlan).not.toHaveBeenCalled();
    expect(h.progress.trail.at(-1)).toBe(`stageFailed:${PLAN}`);
  });

  it('installs a partially infeasible delta as validated, and counts no chain for a refused patch', async () => {
    const h = harness({
      outcomes: [
        answer({ needsNewCapture: true, additionalActions: [ADD_SPAN_ON_TIMED_FILE, ADD_FETCH] }),
      ],
      chainHeads: new Map([[INDEXED_FILE, RECORD_V1]]),
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'new-capture',
    );
    expect(value.delta).toHaveLength(2);
    const refusedIds = value.feasibility.rejected.map((refusal) => refusal.action.id);
    expect(refusedIds).toContain(value.delta[0]?.id);
    expect(refusedIds).not.toContain(value.delta[1]?.id);
    expect(value.chainedFiles).toBe(0);
    expect(h.latestRecordForFile).not.toHaveBeenCalled();
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it('leaves the session at its previous plan version when the delta install fails', async () => {
    const failure = new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', 'Could not install.');
    const h = harness({ outcomes: [answer(FETCH_DECISION)], installAnswer: () => err(failure) });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(stageOf(error)).toBe(INSTRUMENT);
    expect(h.recordPlan).not.toHaveBeenCalled();
    expect(h.recordFollowUpOutcome).not.toHaveBeenCalled();
    // No rollback of its own: the installer reverse-restores what it applied. One install call,
    // no journal or backup access, and no other instrumentation member reached for.
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.writeReads).toStrictEqual([]);
    expect(h.modificationReads).toStrictEqual([]);
    expect(new Set(h.instrumentationReads)).toStrictEqual(new Set(['buildContext', 'install']));
    expect(h.sessionManagerReads).not.toContain('recordPlan');
    expect(h.nextPlanVersion).toHaveBeenCalledTimes(1);
    // The install's failure row is the instrumentation service's own.
    expect(h.progress.trail).toStrictEqual([
      `stageStarted:${FOLLOWUP}`,
      `stageCompleted:${FOLLOWUP}`,
      `stageStarted:${PLAN}`,
      `stageCompleted:${PLAN}`,
    ]);
  });

  it('does not record a plan version the install did not leave active', async () => {
    const h = harness({
      outcomes: [answer(FETCH_DECISION)],
      installAnswer: (request) => ok({ ...outcomeFor(request), activePlanVersion: 1 }),
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(reasonOf(error)).toBe('active-version-mismatch');
    expect(h.recordPlan).not.toHaveBeenCalled();
  });

  it('refuses to plan when the plan ladder moved under it', async () => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)], nextPlanVersion: 3 });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(reasonOf(error)).toBe('plan-ladder-moved');
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(vi.mocked(normalizePlan)).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
  });

  it('rejects a normalisation failure as a product defect, without a re-prompt', async () => {
    vi.mocked(normalizePlan).mockReturnValueOnce(
      err(new DebuggenError('PLAN_INVALID', 'The normaliser refused the plan.')),
    );
    const h = harness({ outcomes: [answer(FETCH_DECISION), answer(FETCH_DECISION)] });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('PLAN_INVALID');
    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    expect(h.install).not.toHaveBeenCalled();
    const defects = h.log.records.filter(
      (record) => record.level === 'error' && record.fields?.['step'] === 'normalize',
    );
    expect(defects).toHaveLength(1);
  });

  it('rejects a next version that would move an installed action to another adapter', async () => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)], registry: driftedRegistry() });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('PLAN_INVALID');
    expect(reasonOf(error)).toBe('installed-action-altered');
    expect(error.details?.['index']).toBe(1);
    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.recordPlan).not.toHaveBeenCalled();
  });

  it('fails the plan group when recording the installed version fails', async () => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)] });
    h.recordPlan.mockResolvedValueOnce(err(new DebuggenError('STORE_ERROR', 'Not stored.')));
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('STORE_ERROR');
    expect(stageOf(error)).toBe(PLAN);
    expect(h.recordFollowUpOutcome).not.toHaveBeenCalled();
  });

  it('stops before the install when an orchestrator seam fails', async () => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)] });
    const error = expectErr(
      await h.stage.run(
        h.context,
        followUpInput({
          beforeInstall: () =>
            Promise.resolve(err(new DebuggenError('SESSION_INVALID_STATE', 'Illegal transition.'))),
        }),
      ),
    );
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(h.install).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4c. The path choice: total and exclusive, observed through a whole run
// ---------------------------------------------------------------------------

describe('createFollowUpStage — the path choice is total and exclusive', () => {
  /** An addition the additive-only rule refuses: a re-emission of an installed identity. */
  const REFUSED: FollowUpAdditionalAction = {
    file: INDEXED_FILE,
    symbol: INDEXED_SYMBOL,
    type: 'function-timing',
  };
  const [EXISTING, NEW_CAPTURE] = FOLLOW_UP_PATHS;

  interface TruthRow {
    readonly label: string;
    readonly needsNewCapture: boolean;
    readonly additionalActions: readonly FollowUpAdditionalAction[];
    readonly expected: FollowUpPath;
  }

  const rows: readonly TruthRow[] = [
    {
      label: 'no capture, empty delta',
      needsNewCapture: false,
      additionalActions: [],
      expected: EXISTING,
    },
    {
      label: 'no capture, only refused proposals',
      needsNewCapture: false,
      additionalActions: [REFUSED],
      expected: EXISTING,
    },
    {
      label: 'no capture, a non-empty accepted delta',
      needsNewCapture: false,
      additionalActions: [ADD_FETCH],
      expected: NEW_CAPTURE,
    },
    {
      label: 'a capture, empty delta',
      needsNewCapture: true,
      additionalActions: [],
      expected: NEW_CAPTURE,
    },
    {
      label: 'a capture, only refused proposals',
      needsNewCapture: true,
      additionalActions: [REFUSED],
      expected: NEW_CAPTURE,
    },
    {
      label: 'a capture, a non-empty accepted delta',
      needsNewCapture: true,
      additionalActions: [ADD_FETCH],
      expected: NEW_CAPTURE,
    },
  ];

  it.each(rows)('$label → exactly the $expected path', async (row) => {
    const h = harness({
      outcomes: [
        answer({ needsNewCapture: row.needsNewCapture, additionalActions: row.additionalActions }),
      ],
    });
    const chosen: FollowUpPath[] = [];
    const value = expectOk(
      await h.stage.run(
        h.context,
        followUpInput({
          onPathChosen: (path) => {
            chosen.push(path);
            return Promise.resolve(ok(undefined));
          },
        }),
      ),
    );

    expect(value.path).toBe(row.expected);
    expect(chosen).toStrictEqual([row.expected]);
    expect(
      followUpPathFor(row.needsNewCapture, {
        accepted: value.decision.acceptedActions,
        rejected: value.decision.rejectedActions,
      }),
    ).toBe(row.expected);

    // What each path touches, and that the other path's collaborators were never reached.
    const regenerated = h.analysisRun.mock.calls.length + h.regenerate.mock.calls.length;
    const installed = h.install.mock.calls.length + h.recordPlan.mock.calls.length;
    if (row.expected === EXISTING) {
      expect([regenerated, installed]).toStrictEqual([2, 0]);
      expect(h.buildContext).not.toHaveBeenCalled();
      expect(h.nextPlanVersion).not.toHaveBeenCalled();
    } else {
      expect([regenerated, installed]).toStrictEqual([0, 2]);
      expect(h.install).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate, preconditions and failure handling
// ---------------------------------------------------------------------------

describe('createFollowUpStage — the gate and its failures', () => {
  it('never calls the provider when the builder refuses the request', async () => {
    // The outbound guard's refusal, as the real builder reports it.
    const refusal = new DebuggenError('INTERNAL', 'The payload may not leave the machine.');
    const h = harness({ outcomes: [answer(FETCH_DECISION)], refusal });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe(refusal.code);
    expect(error.message).toBe(refusal.message);
    expect(stageOf(error)).toBe(FOLLOWUP);
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.progress.trail).toStrictEqual([`stageStarted:${FOLLOWUP}`, `stageFailed:${FOLLOWUP}`]);
    expect(h.progress.calls.at(-1)?.failure?.code).toBe(refusal.code);
  });

  it('repairs an invalid decision within the one gate and then proceeds', async () => {
    const h = harness({
      outcomes: [answer({ needsNewCapture: 'yes' }), answer(EXISTING_EVIDENCE_DECISION)],
    });
    const value = expectOk(await h.stage.run(h.context, followUpInput()));
    expect(value.path).toBe('existing-evidence');
    expect(value.decision.repairs).toBe(1);
    expect(value.decision.attempts).toBe(2);
    expect(h.provider.structured).toHaveBeenCalledTimes(2);
  });

  it('rejects a decision that never validates after the default repair budget, with no fallback', async () => {
    const invalid = answer({ needsNewCapture: true, additionalActions: 'all of them' });
    const h = harness({ outcomes: [invalid, invalid, invalid, invalid, invalid] });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.details?.['schemaName']).toBe(FOLLOW_UP_DECISION_SCHEMA_NAME);
    expect(h.provider.structured).toHaveBeenCalledTimes(DEFAULT_MAX_REPAIRS + 1);
    expect(h.analysisRun).not.toHaveBeenCalled();
    expect(h.regenerate).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.progress.trail.at(-1)).toBe(`stageFailed:${FOLLOWUP}`);
  });

  it('honours a configured repair budget and refuses one outside the loop’s range before any work', async () => {
    const invalid = answer({ needsNewCapture: 1, additionalActions: [] });
    const zero = harness({ outcomes: [invalid, invalid], maxRepairs: 0 });
    expectErr(await zero.stage.run(zero.context, followUpInput()));
    expect(zero.provider.structured).toHaveBeenCalledTimes(1);

    for (const maxRepairs of [-1, DEFAULT_MAX_REPAIRS + 1, 0.5]) {
      const h = harness({ outcomes: [answer(FETCH_DECISION)], maxRepairs });
      const error = expectErr(await h.stage.run(h.context, followUpInput()));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(reasonOf(error)).toBe('repair-budget');
      expect(h.provider.structured).not.toHaveBeenCalled();
      expect(h.latestPlanVersion).not.toHaveBeenCalled();
      expect(h.progress.calls).toStrictEqual([]);
    }
  });

  it('fails with the provider’s own sentence when the model provider is unavailable', async () => {
    const outage = new DebuggenError('MODEL_UNAVAILABLE', 'transport refused', {
      details: { transport: 'scripted' },
    });
    const h = harness({ outcomes: [{ kind: 'error', error: outage }] });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.message).toBe(modelUnavailableMessage('MODEL_UNAVAILABLE'));
    expect(h.provider.structured).toHaveBeenCalledTimes(1);
    expect(h.progress.trail.at(-1)).toBe(`stageFailed:${FOLLOWUP}`);
  });

  it('requires a follow-up question, before any row or read', async () => {
    for (const question of ['', '   ']) {
      const h = harness({ outcomes: [answer(FETCH_DECISION)] });
      const error = expectErr(
        await h.stage.run(h.context, followUpInput({ followUpQuestion: question })),
      );
      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(reasonOf(error)).toBe('missing-follow-up-question');
      expect(h.latestPlanVersion).not.toHaveBeenCalled();
      expect(h.appendFollowUp).not.toHaveBeenCalled();
      expect(h.provider.structured).not.toHaveBeenCalled();
      expect(h.progress.calls).toStrictEqual([]);
    }
  });

  it('does nothing for an already cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ outcomes: [answer(FETCH_DECISION)] });
    const context = stageContext(sessionRecord(), controller.signal);
    const error = expectErr(await h.stage.run(context, followUpInput()));
    expect(reasonOf(error)).toBe('aborted');
    expect(h.latestPlanVersion).not.toHaveBeenCalled();
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.analysisRun).not.toHaveBeenCalled();
    expect(h.regenerate).not.toHaveBeenCalled();
    expect(h.appendFollowUp).not.toHaveBeenCalled();
    expect(h.progress.calls).toStrictEqual([]);
  });

  it.each([
    ['no-plan', { latestPlanVersion: undefined }],
    ['no-analysis', { latestAnalysis: undefined }],
    ['no-panel', { latestPanel: undefined }],
  ] as const)('refuses a session with %s, before asking the model', async (reason, options) => {
    const h = harness({ outcomes: [answer(FETCH_DECISION)], ...options });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(reasonOf(error)).toBe(reason);
    expect(h.appendFollowUp).not.toHaveBeenCalled();
    expect(h.provider.structured).not.toHaveBeenCalled();
    expect(h.progress.trail).toStrictEqual([`stageStarted:${FOLLOWUP}`, `stageFailed:${FOLLOWUP}`]);
  });

  it('refuses when the store disagrees about the latest analysis or panel', async () => {
    const h = harness({
      outcomes: [answer(FETCH_DECISION)],
      followUpContext: {
        previousAnalysisId: 'analysis-elsewhere',
        previousObserved: 0,
        previousLikelyCauses: 0,
        previousPanelId: PANEL_V1.id,
      },
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('STORE_ERROR');
    expect(reasonOf(error)).toBe('history-inconsistent');
    expect(h.provider.structured).not.toHaveBeenCalled();
  });

  it('turns a collaborator that throws into a typed failure of the running stage', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    h.analysisRun.mockImplementationOnce(() => {
      throw new Error(`analysis exploded ${SENTINEL}`);
    });
    const result = await h.stage.run(h.context, followUpInput());
    const error = expectErr(result);
    expect(error.code).toBe('INTERNAL');
    expect(stageOf(error)).toBe(ANALYZE);
  });

  it.each(['err', 'throw'] as const)(
    'completes although every progress row %s, logging each at warn without payload values',
    async (behaviour) => {
      const h = harness({ outcomes: [answer(FETCH_DECISION)], progress: behaviour });
      const value = expectOk(await h.stage.run(h.context, followUpInput()));
      expect(value.path).toBe('new-capture');
      const warnings = recordsWith(
        h.log.records,
        'A progress row of the follow-up stage could not be emitted; the stage continues.',
      );
      expect(warnings).toHaveLength(4);
      for (const warning of warnings) {
        expect(warning.level).toBe('warn');
        // The logger's own bindings, then the three enumerated fields — no payload value.
        expect(Object.keys(warning.fields ?? {}).sort()).toStrictEqual(
          ['code', 'row', 'sessionId', 'stage', 'subsystem'].sort(),
        );
        expect(warning.fields?.['sessionId']).toBe(SESSION_ID);
        expect(PROGRESS_STAGES).toContain(warning.fields?.['stage']);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Session status belongs to the manager and the orchestrator
// ---------------------------------------------------------------------------

describe('createFollowUpStage — session status', () => {
  /** The session manager's members that write or move a session's status. */
  const STATUS_WRITERS: readonly string[] = [
    'transitionTo',
    'patch',
    'fail',
    'retry',
    'startCapture',
    'stopCapture',
    'end',
    'create',
  ];

  it.each([
    ['existing-evidence', EXISTING_EVIDENCE_DECISION, ['appendFollowUp', 'recordFollowUpOutcome']],
    ['new-capture', FETCH_DECISION, ['appendFollowUp', 'recordPlan', 'recordFollowUpOutcome']],
  ] as const)(
    'writes no status on the %s path: it records the question, the outcome and plan versions only',
    async (_path, decision, expected) => {
      const h = harness({ outcomes: [answer(decision)] });
      const value = expectOk(await h.stage.run(h.context, followUpInput()));
      expect(new Set(h.sessionManagerReads)).toStrictEqual(new Set(expected));
      for (const writer of STATUS_WRITERS) {
        expect(h.sessionManagerReads).not.toContain(writer);
      }
      // The record the stage hands back is the store's, in the status the orchestrator left it.
      expect(value.session.status).toBe(h.context.session.status);
    },
  );

  it('writes no status on a failure either: the orchestrator files it', async () => {
    const h = harness({
      outcomes: [answer(FETCH_DECISION)],
      installAnswer: () =>
        err(new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', 'Not installed.')),
    });
    expectErr(await h.stage.run(h.context, followUpInput()));
    expect(h.sessionManagerReads).toStrictEqual(['appendFollowUp']);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('createFollowUpStage — privacy', () => {
  it('logs no part of the follow-up question on either path', async () => {
    for (const decision of [EXISTING_EVIDENCE_DECISION, FETCH_DECISION]) {
      const h = harness({ outcomes: [answer(decision)] });
      expectOk(await h.stage.run(h.context, followUpInput()));
      expect(h.log.records.length).toBeGreaterThan(0);
      expect(everythingSurfaced(h)).not.toContain(SENTINEL);
      expect(everythingSurfaced(h)).not.toContain(PROMPT_MARKER);
    }
  });

  it('echoes no model output into a rejection or a log record', async () => {
    const leaky = answer({
      needsNewCapture: true,
      additionalActions: [{ file: `/${SENTINEL}.ts`, symbol: SENTINEL, type: 'function-timing' }],
    });
    const h = harness({ outcomes: [leaky, leaky, leaky] });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(everythingSurfaced(h, error)).not.toContain(SENTINEL);
  });

  it('logs no statement of the stored or the regenerated analysis', async () => {
    const statement = `The totals request repeated within one interaction ${SENTINEL}.`;
    const withFact: AnalysisResult = {
      ...ANALYSIS_V1,
      observed: [{ statement, evidence: [{ eventId: 'evt-suite-0001' }] }],
    };
    const h = harness({
      outcomes: [answer(EXISTING_EVIDENCE_DECISION)],
      latestAnalysis: withFact,
      analysisAnswer: (input) => {
        const regenerated: AnalysisResult = {
          ...nextAnalysis(input),
          observed: [{ statement, evidence: [{ eventId: 'evt-suite-0002' }] }],
        };
        h.ladder.push(regenerated);
        return ok({
          analysis: regenerated,
          analysisVersion: regenerated.analysisVersion,
          promptVersion: RECORDED_PROMPT_VERSIONS.analyze,
          repairs: 0,
          attempts: 1,
          providerId: 'scripted-test-provider',
          model: 'scripted-model',
          verification: VERIFICATION,
          summary: CAPTURE_SUMMARY,
          truncated: [],
        });
      },
    });
    const value = expectPath(
      expectOk(await h.stage.run(h.context, followUpInput())),
      'existing-evidence',
    );
    // The statement travels through the stage to the panel port verbatim, and nowhere else.
    expect(h.regenerate.mock.calls[0]?.[0].analysis.observed[0]?.statement).toBe(statement);
    expect(value.analysis.observed[0]?.statement).toBe(statement);
    expect(h.log.records.length).toBeGreaterThan(0);
    expect(everythingSurfaced(h)).not.toContain(SENTINEL);
  });

  it('logs no diff, hash, backup path, file, symbol, rationale, URL, root or token on the chained install', async () => {
    vi.mocked(checkPlanFeasibility).mockImplementationOnce((plan) => ({
      feasible: [...plan.instrumentationTargets],
      rejected: [],
    }));
    // Token-shaped, assembled at runtime so no secret-shaped literal is committed.
    const token = ['Bearer', ['tok', 'suite', 'x'.repeat(24)].join('_')].join(' ');
    const recordV2: ModificationRecord = {
      ...RECORD_V1,
      id: 'mod_000000000000000b',
      planVersion: 2,
      originalHash: RECORD_V1.instrumentedHash,
      instrumentedHash: 'c'.repeat(64),
      backupPath: `${DEBUGGEN_HOME}/backups/${SESSION_ID}/${RECORD_V1.instrumentedHash}`,
      previousRecordId: RECORD_V1.id,
      diff: '--- totals\n+++ totals\n@@ -1 +1 @@\n-const refreshTotals\n+const refreshTotals\n',
    };
    const h = harness({
      outcomes: [answer({ needsNewCapture: true, additionalActions: [ADD_SPAN_ON_TIMED_FILE] })],
      chainHeads: new Map([[INDEXED_FILE, RECORD_V1]]),
      installAnswer: (request) => ok(outcomeFor(request, [recordV2])),
    });
    const value = expectPath(
      expectOk(
        await h.stage.run(
          h.context,
          followUpInput({ followUpQuestion: `${FOLLOW_UP_QUESTION} ${token}` }),
        ),
      ),
      'new-capture',
    );
    expect(value.chainedFiles).toBe(1);

    const surfaced = everythingSurfaced(h);
    const forbidden: readonly string[] = [
      SENTINEL,
      token,
      RECORD_V1.diff,
      recordV2.diff,
      RECORD_V1.originalHash,
      RECORD_V1.instrumentedHash,
      recordV2.instrumentedHash,
      RECORD_V1.backupPath,
      recordV2.backupPath,
      INDEXED_FILE,
      INDEXED_SYMBOL,
      ADD_SPAN_ON_TIMED_FILE.rationale,
      INSTALLED_TIMING.rationale,
      PLAN_V1.objective,
      DEV_SERVER_URL,
      PROJECT_ROOT,
      PROMPT_MARKER,
    ];
    for (const fragment of forbidden) {
      // Compared in its JSON-escaped spelling, which is how a record carrying it would read.
      expect(surfaced).not.toContain(JSON.stringify(fragment).slice(1, -1));
    }
  });

  it('logs no message a collaborator threw', async () => {
    const h = harness({ outcomes: [answer(EXISTING_EVIDENCE_DECISION)] });
    h.analysisRun.mockImplementationOnce(() => {
      throw new Error(`analysis exploded ${SENTINEL}`);
    });
    const error = expectErr(await h.stage.run(h.context, followUpInput()));
    const surfaced = h.log.records.map(serializeRecord).join('\n');
    expect(surfaced).not.toContain(SENTINEL);
    expect(error.details?.['stage']).toBe(ANALYZE);
  });
});

// ---------------------------------------------------------------------------
// The module's own boundaries, read from its source
// ---------------------------------------------------------------------------

describe('followup.ts source boundaries', () => {
  const source = readFileSync(fileURLToPath(new URL('./followup.ts', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/^\s*(import|export)\b[^;]*?from\s+'([^']+)'/gmu)].map(
    (match) => ({ statement: match[0], specifier: match[2] ?? '' }),
  );

  it('imports no validation library, no Node built-in and never the orchestrator', () => {
    expect(specifiers.length).toBeGreaterThan(0);
    for (const { specifier } of specifiers) {
      expect(specifier).not.toBe('zod');
      expect(specifier.startsWith('node:')).toBe(false);
      expect(specifier).not.toMatch(/orchestrator/u);
      expect(specifier).not.toBe('@debuggen/panel-renderer');
    }
  });

  it('reaches the panel subsystem through a type-only import', () => {
    const panelImports = specifiers.filter(({ specifier }) =>
      specifier.endsWith('panels/generate.js'),
    );
    expect(panelImports.length).toBeGreaterThan(0);
    for (const { statement } of panelImports) {
      expect(statement).toMatch(/^\s*import type\b/u);
    }
  });

  it('spells every relative specifier with .js', () => {
    for (const { specifier } of specifiers.filter(({ specifier: s }) => s.startsWith('.'))) {
      expect(specifier.endsWith('.js')).toBe(true);
    }
  });

  it('never branches on the follow-up question: it is only ever passed on as a value', () => {
    // Code only: block comments and whole-line comments removed, so prose about the rule is not
    // mistaken for a use of the value.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    const reads = [
      ...code.matchAll(
        /\b(?:input|context|stageContext)\.(?:followUpQuestion|question)\b(?<after>\s*\S)/gu,
      ),
    ];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      // Followed by an argument or property separator: never a receiver, an operand or a pattern.
      expect([',', ')']).toContain(read.groups?.['after']?.trim());
    }
    // Never compared, never searched, never switched on, never bound to a local of its own.
    expect(code).not.toMatch(/(?:===|!==|==|!=)\s*(?:\w+\.)?(?:followUpQuestion|question)\b/u);
    expect(code).not.toMatch(/\b(?:followUpQuestion|question)\s*(?:===|!==|==|!=)/u);
    expect(code).not.toMatch(/\b(?:followUpQuestion|question)\s*\??\.\s*[A-Za-z]/u);
    expect(code).not.toMatch(
      /\.(?:includes|match|matchAll|test|exec|search|startsWith|endsWith|indexOf)\(\s*(?:\w+\.)?(?:followUpQuestion|question)\b/u,
    );
    expect(code).not.toMatch(/\bswitch\s*\(\s*(?:\w+\.)?(?:followUpQuestion|question)\b/u);
    expect(code).not.toMatch(/(?<![.'\w])followUpQuestion(?!\s*\??:|')/u);
  });

  it('writes no analysis or panel row itself and names no application route', () => {
    expect(source).not.toMatch(/\binsert(Panel|Analysis)\b/u);
    // Assembled at runtime so this suite itself carries no reference to the demo application.
    expect(source).not.toContain(['apps', 'demo-app'].join('/'));
    expect(source).not.toMatch(/['"`]\/api\//u);
  });
});
