/**
 * Colocated unit suite for `./orchestrator.ts`, the sequencer of the reasoning
 * pipeline (AAP §0.4.2 stage table and follow-up paths, §0.5.5 graceful
 * failure, §0.8.3 test plan, §0.7.1 Group 2).
 *
 * It pins the orchestrator's **sequencing and failure contract** at unit speed.
 * The end-to-end behaviour — real stages, a real store, a real project index
 * and the deterministic provider — belongs to the `session-lifecycle`,
 * `pipeline-deterministic`, `panel-fallback` and `followup` integration suites
 * under `apps/local-service/test/integration/`, and is not repeated here.
 *
 * ## How the suite is built
 *
 * Every collaborator in `PipelineOrchestratorDeps` is an in-file double and
 * every one of the seven stages is substituted through the orchestrator's own
 * `StageOverrides` port, so no stage module runs, no store is opened, no
 * project is indexed, no server is started and no provider is called:
 *
 * - the session manager **records** every call and applies it without any
 *   guard of its own, so a test observes what the orchestrator *asked for*
 *   (the state machine's own table is covered by `../sessions/state-machine.test.ts`);
 *   a test that needs a refusal scripts it explicitly. Its `confirmProjectRoot`
 *   answers the suite's root as its own canonical path unless a test scripts
 *   another identity, a refusal or a throw;
 * - the stage fakes model each stage's documented contract with the scripted
 *   collaborators (the plan stage records its plan through the manager, then
 *   calls the `beforeInstall` seam, then installs; the capture stage opens and
 *   closes the window through the manager), so what the orchestrator does with
 *   their artifacts is observable. The plan and follow-up fakes can instead be
 *   handed out by the orchestrator's own stage factories, which this file
 *   replaces with spies, so a case observes the installer the orchestrator
 *   wires into those stages;
 * - the model provider, the prompt loader's `load`/`loadVersion`, the context
 *   builder, the analysis collaborators and the repositories the orchestrator
 *   only hands on are **tripwires**: any call is recorded, and a provider call
 *   fails the suite;
 * - time is an injected constant and every wait is a deferred promise, never a
 *   timer, so the suite is order-independent and deterministic.
 *
 * Fixtures use invented, generic vocabulary only.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  instrumentationPlanSchema,
  modificationRecordSchema,
  problemUnderstandingSchema,
  type AdapterRegistry,
  type InstrumentationAction,
  type InstrumentationPlan,
  type ModificationRecord,
  type ProblemUnderstanding,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  PROMPT_STAGES,
  modelUnavailableMessage,
  type ModelProvider,
  type PromptLoader,
  type PromptStage,
} from '@debuggen/model-provider';
import { panelSpecSchema, type PanelSpec } from '@debuggen/panel-schema';
import {
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  PROGRESS_STAGES,
  analysisResultSchema,
  sessionRecordSchema,
  type AnalysisResult,
  type ProgressStage,
  type SessionProgressPayload,
  type SessionRecord,
  type SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  newId,
  ok,
  type DebuggenErrorCode,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { computeCaptureSummary, type CaptureSummary } from '@debuggen/telemetry';

import type { AnalysisFacts } from '../analysis/facts.js';
import type { AnalysisSummarizer } from '../analysis/summarize.js';
import {
  buildDegradationNotice,
  type InstallRequest,
  type InstrumentationOutcome,
  type InstrumentationService,
} from '../instrumentation/service.js';
import type { PanelGenerationResult, PanelGenerator } from '../panels/generate.js';
import type {
  RecordPlanInput,
  SessionManager,
  SessionPatch,
  StopCaptureOptions,
} from '../sessions/manager.js';
import type { ProgressRow, SessionProgress } from '../sessions/progress.js';
import {
  statusForStage,
  type SessionFailure,
  type SessionTransitionContext,
} from '../sessions/state-machine.js';
import type {
  ContextBuilder,
  PipelineCodeHandles,
  PipelineStageContext,
} from './context-builder.js';
import {
  PIPELINE_OPERATIONS,
  PIPELINE_STAGE_ORDER,
  createPipelineOrchestrator,
  type CodeIndexPort,
  type ObserveReadinessFn,
  type PipelineOrchestrator,
  type PipelineOrchestratorDeps,
  type StageOverrides,
} from './orchestrator.js';
// The one value imported from a stage module for its behaviour: the
// pure empty-capture rule, so a faked capture stage can report the verdict the
// real rule reaches. It is a pure function — no stage runs.
import { classifyCaptureEmptiness } from './stages/capture.js';
// The two installing stages' factories, imported only as the spies below: a
// case that names a stage in `builtStages` lets the orchestrator build it, and
// the spy hands back the same fake over the installer the orchestrator wired.
import { createFollowUpStage } from './stages/followup.js';
import { createPlanStage } from './stages/plan.js';

vi.mock('./stages/plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stages/plan.js')>();
  return { ...actual, createPlanStage: vi.fn(actual.createPlanStage) };
});

vi.mock('./stages/followup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stages/followup.js')>();
  return { ...actual, createFollowUpStage: vi.fn(actual.createFollowUpStage) };
});

/* -------------------------------------------------------------------------------------------------
 * Types derived from the orchestrator's own ports — never restated, never imported from a stage
 * ---------------------------------------------------------------------------------------------- */

/** The seven stages, every member required. */
type Stages = Required<StageOverrides>;

/** The `Ok` value of a stage call's `Result`. */
type OkValue<R> =
  Extract<Awaited<R>, { readonly ok: true }> extends { readonly value: infer V } ? V : never;

type UnderstandResult = OkValue<ReturnType<Stages['understand']['run']>>;
type InvestigateResult = OkValue<ReturnType<Stages['investigate']['run']>>;
type CodeInvestigation = InvestigateResult['investigation'];
type PlanInput = Parameters<Stages['plan']['run']>[1];
type PlanResult = OkValue<ReturnType<Stages['plan']['run']>>;
type RecordedPlan = Parameters<NonNullable<PlanInput['beforeInstall']>>[0];
type CaptureArmResult = OkValue<ReturnType<Stages['capture']['arm']>>;
type CaptureCompletion = OkValue<ReturnType<Stages['capture']['complete']>>;
type CaptureEmptiness = CaptureCompletion['emptiness'];
type EmptyCaptureEmptiness = Extract<CaptureEmptiness, { readonly empty: true }>;
type AnalyzeResult = OkValue<ReturnType<Stages['analyze']['run']>>;
type GeneratePanelResult = OkValue<ReturnType<Stages['generatePanel']['run']>>;
type FollowUpInput = Parameters<Stages['followUp']['run']>[1];
type FollowUpResult = OkValue<ReturnType<Stages['followUp']['run']>>;
type FollowUpPath = FollowUpResult['path'];
type FollowUpDecisionSummary = FollowUpResult['decision'];
type ReadinessVerdict = InstrumentationOutcome['readiness'];
type ServiceConfig = PipelineOrchestratorDeps['config'];
type SessionsRepo = PipelineOrchestratorDeps['sessionsRepo'];
type PanelsRepo = PipelineOrchestratorDeps['panelsRepo'];
type TelemetryRepo = PipelineOrchestratorDeps['telemetryRepo'];
type ModificationsPort = PipelineOrchestratorDeps['modifications'];
type CaptureRecord = SessionRecord['captures'][number];

/* -------------------------------------------------------------------------------------------------
 * Fixture constants — invented, generic vocabulary
 * ---------------------------------------------------------------------------------------------- */

const SESSION_ID = 'session-orchestrator-suite';
const PROJECT_ROOT = '/workspace/ledger-tool';
const FIXED_EPOCH_MS = 1_767_225_600_000;
const CAPTURE_ID = 'capture-orchestrator-suite';

/**
 * A fresh follow-up attempt id, minted as the route and the editor view mint
 * one: every follow-up these cases ask is a new question with its own id.
 */
function nextAttemptId(): string {
  return newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
}

/**
 * Tokens planted in every place a log record must never reach: the question,
 * the follow-up question, the model's outputs, captured attribute values and a
 * failing subsystem's own sentence. No log record may carry any of them.
 */
const SENTINELS = Object.freeze({
  question: 'quillmarmotquestiontoken',
  followUp: 'quillmarmotfollowuptoken',
  modelOutput: 'quillmarmotmodeloutputtoken',
  attribute: 'quillmarmotattributetoken',
  errorText: 'quillmarmoterrortexttoken',
});

/** The manifest's *current* version of every prompt stage. */
const MANIFEST: Readonly<Record<PromptStage, string>> = Object.freeze(
  Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, 'v009'])) as Record<PromptStage, string>,
);

/** The versions each fake stage reports: distinct from the manifest's, so their origin is visible. */
const REPORTED = Object.freeze({
  understand: 'v002',
  investigate: 'v003',
  plan: 'v004',
  analyze: 'v005',
  'generate-panel': 'v006',
  followup: 'v007',
} satisfies Record<PromptStage, string>);

/** The versions the existing-evidence follow-up reports for its regenerated analysis and panel. */
const REGENERATED = Object.freeze({ analyze: 'v010', 'generate-panel': 'v011' });

/**
 * AAP §0.5.5's "Capture yielded nothing" sentence. Typed as the capture
 * stage's own literal message type, so a drift in the stage's wording fails
 * compilation here rather than passing silently.
 */
const EMPTY_CAPTURE_MESSAGE: EmptyCaptureEmptiness['message'] =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/** The interaction signal — the one whose absence makes an interaction question's capture empty. */
const INTERACTION_SIGNAL = CAPTURE_SIGNALS[0];

const UNDERSTANDING: ProblemUnderstanding = problemUnderstandingSchema.parse({
  category: PROBLEM_CATEGORIES[0],
  signalsNeeded: [INTERACTION_SIGNAL],
  entities: [{ kind: PROBLEM_ENTITY_KINDS[0], name: 'LedgerTotals' }],
  searchHints: [`ledger totals ${SENTINELS.modelOutput}`],
});

const INVESTIGATION: CodeInvestigation = Object.freeze({
  relevantFiles: [
    {
      file: 'src/ledger/totals.ts',
      symbol: 'refreshTotals',
      reason: `Computes the totals ${SENTINELS.modelOutput}.`,
      score: 0.9,
    },
  ],
  flows: [`click → refreshTotals ${SENTINELS.modelOutput}`],
});

/** One normalised, targetless runtime action. */
function runtimeAction(
  ordinal: number,
  type: InstrumentationAction['type'],
  adapter: string,
): InstrumentationAction {
  return {
    id: `act_${String(ordinal).padStart(16, '0')}`,
    file: TARGETLESS_FILE,
    symbol: TARGETLESS_SYMBOL,
    type,
    adapter,
    mode: 'runtime',
    rationale: 'Time the interaction the developer reported.',
  };
}

/** Plan version 1's only action. */
const ACTION_V1 = runtimeAction(1, 'interaction-tracking', 'page-probe');

/** The additive action a new-capture follow-up contributes to plan version 2. */
const DELTA_ACTION = runtimeAction(2, 'fetch-tracking', 'request-probe');

/** A plan body as the plan and follow-up stages offer it to `recordPlan` (no session, no version). */
function planBody(actions: readonly InstrumentationAction[]): RecordPlanInput {
  return {
    version: 1,
    objective: 'Determine why the ledger totals refresh slowly.',
    hypotheses: [],
    capture: ['interaction timing'],
    instrumentationTargets: [...actions],
  };
}

/** A validated plan version. */
function planOf(
  planVersion: number,
  actions: readonly InstrumentationAction[],
): InstrumentationPlan {
  return instrumentationPlanSchema.parse({
    ...planBody(actions),
    sessionId: SESSION_ID,
    planVersion,
  });
}

const PLAN_V1 = planOf(1, [ACTION_V1]);

/** Plan version n + 1 of a new-capture follow-up: every version-1 action, unchanged, plus the delta. */
const PLAN_V2 = planOf(2, [ACTION_V1, DELTA_ACTION]);

/** A validated modification record; its diff carries an attribute sentinel. */
function modification(ordinal: number, planVersion: number): ModificationRecord {
  return modificationRecordSchema.parse({
    id: `mod_${String(ordinal).padStart(16, '0')}`,
    sessionId: SESSION_ID,
    planVersion,
    file: 'src/ledger/totals.ts',
    originalHash: String(ordinal).repeat(64).slice(0, 64),
    backupPath: `/workspace/.suite-backups/${SESSION_ID}/${String(ordinal)}`,
    instrumentedHash: 'f'.repeat(64),
    appliedAt: FIXED_EPOCH_MS,
    status: 'applied',
    diff: `+ // ${SENTINELS.attribute}`,
  });
}

/** The record plan version 1's install applies. */
const MOD_V1 = modification(1, 1);

/** The record the follow-up's delta install applies — and the only one it applies. */
const MOD_V2 = modification(2, 2);

/** The summary of a capture that recorded nothing — computed, not hand-written. */
const EMPTY_SUMMARY: CaptureSummary = computeCaptureSummary([], {
  captureId: CAPTURE_ID,
  sessionId: SESSION_ID,
});

/** The summary of a capture that holds evidence. The orchestrator only passes it through. */
const EVIDENCE_SUMMARY: CaptureSummary = Object.freeze({
  ...EMPTY_SUMMARY,
  eventCount: 12,
  traceCount: 1,
});

/** A capture that holds evidence. */
const WITH_EVIDENCE: CaptureEmptiness = Object.freeze({
  empty: false,
  eventCount: 12,
  interactionCount: 1,
  interactionRequired: true,
});

/** AAP §0.5.5, first condition: the window recorded no event at all. */
const NO_EVENTS: CaptureEmptiness = Object.freeze({
  empty: true,
  reason: 'no-events',
  message: EMPTY_CAPTURE_MESSAGE,
  eventCount: 0,
  interactionCount: 0,
  interactionRequired: true,
});

/** AAP §0.5.5, second condition: events arrived, but an interaction question recorded no interaction. */
const NO_INTERACTION: CaptureEmptiness = Object.freeze({
  empty: true,
  reason: 'no-interaction',
  message: EMPTY_CAPTURE_MESSAGE,
  eventCount: 12,
  interactionCount: 0,
  interactionRequired: true,
});

/** A validated analysis version; its observed statement is model output. */
function analysisOf(version: number): AnalysisResult {
  return analysisResultSchema.parse({
    id: `analysis-v${String(version)}-suite`,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    analysisVersion: version,
    ...(version > 1 ? { supersedes: `analysis-v${String(version - 1)}-suite` } : {}),
    createdAt: FIXED_EPOCH_MS + version,
    metrics: [],
    observed: [
      {
        statement: `The totals request took most of the interaction ${SENTINELS.modelOutput}.`,
        evidence: [{ eventId: 'evt-suite-0001' }],
      },
    ],
    likelyCauses: [],
  });
}

/** A validated panel version — plain, or the deterministic fallback (`meta.fallback === true`). */
function panelOf(version: number, fallback = false): PanelSpec {
  return panelSpecSchema.parse({
    version: 1,
    id: `panel-v${String(version)}-suite`,
    sessionId: SESSION_ID,
    panelVersion: version,
    ...(version > 1 ? { supersedes: `panel-v${String(version - 1)}-suite` } : {}),
    title: `Ledger totals ${SENTINELS.modelOutput}`,
    summary: { observed: [], likelyCauses: [] },
    layout: [
      {
        id: 'node-metrics',
        type: 'metricCards',
        query: { source: 'metrics' },
        metrics: ['total_duration'],
      },
    ],
    ...(fallback ? { meta: { fallback: true } } : {}),
  });
}

const PANEL_V1 = panelOf(1);
const FALLBACK_PANEL_V1 = panelOf(1, true);

/** A readiness verdict. Degraded signals do not make it unsatisfied. */
function verdict(
  satisfied: boolean,
  degraded: readonly UnavailableSignal[] = [],
): ReadinessVerdict {
  return {
    satisfied,
    perAdapter: [],
    blocking: [],
    degraded: [...degraded],
    remediations: [],
    plannedSignals: [],
    deliverableSignals: [],
    evaluatedAt: FIXED_EPOCH_MS,
    observed: {},
    reloadRequested: false,
  };
}

/** What the scripted install reports for a plan version. */
interface InstallScript {
  readonly satisfied?: boolean;
  readonly unavailable?: readonly UnavailableSignal[];
  readonly degradations?: readonly string[];
}

/** An install outcome: plan version 1 applies `MOD_V1`, a delta install applies only `MOD_V2`. */
function installationOf(
  plan: InstrumentationPlan,
  script: InstallScript = {},
): InstrumentationOutcome {
  const unavailable = script.unavailable ?? [];
  return {
    sessionId: SESSION_ID,
    planVersion: plan.planVersion,
    activePlanVersion: plan.planVersion,
    applied: [plan.planVersion === 1 ? MOD_V1 : MOD_V2],
    runtimeHooks: [],
    unavailable: [...unavailable],
    agentHooks: DORMANT_AGENT_HOOK_CONFIG,
    serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
    readiness: verdict(script.satisfied ?? true, unavailable),
    degradations: [...(script.degradations ?? [])],
  };
}

/** The stored session record the suite starts from, validated against protocol's schema. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return sessionRecordSchema.parse({
    id: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    projectName: 'ledger-tool',
    devServerUrl: 'http://127.0.0.1:4173/',
    boundTab: { tabId: 7, url: `http://127.0.0.1:4173/ledger?view=${SENTINELS.attribute}` },
    createdAt: FIXED_EPOCH_MS,
    updatedAt: FIXED_EPOCH_MS,
    status: 'created',
    question: `Why do the ledger totals refresh slowly ${SENTINELS.question}?`,
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
  });
}

/**
 * The code handles the index port answers with. No stage in this suite reads
 * them: their **identity** is what is asserted, so each handle is an opaque
 * object standing in for the ts-morph-backed original.
 */
function codeHandles(): PipelineCodeHandles {
  return Object.freeze({
    graph: Object.freeze({}) as unknown as PipelineCodeHandles['graph'],
    queries: Object.freeze({}) as unknown as PipelineCodeHandles['queries'],
    routeMap: Object.freeze({}) as unknown as PipelineCodeHandles['routeMap'],
    projectSummary: Object.freeze({}) as unknown as PipelineCodeHandles['projectSummary'],
  });
}

/**
 * The install request's handles, projected from the run's bundle exactly as
 * the plan and follow-up stages project them — so every handle an install
 * receives is the very object the index port loaded.
 */
function installHandles(code: PipelineCodeHandles): InstallRequest['code'] {
  const { graph, queries, routeMap, projectSummary, loaded } = code;
  return { graph, queries, routeMap, summary: projectSummary, project: loaded };
}

/** The follow-up decision the stage reports, on the prompt version it actually loaded. */
function decisionOf(needsNewCapture: boolean, promptVersion: string): FollowUpDecisionSummary {
  return {
    needsNewCapture,
    proposedActions: needsNewCapture ? 1 : 0,
    acceptedActions: [],
    rejectedActions: [],
    promptVersion,
    repairs: 0,
    attempts: 1,
    providerId: 'deterministic',
    model: 'rules',
  };
}

/** A feasibility report in which every action of the plan is feasible. */
function feasibilityOf(plan: InstrumentationPlan): PlanResult['feasibility'] {
  return { feasible: [...plan.instrumentationTargets], rejected: [] };
}

/** An evidence verification report with nothing unresolved. */
const VERIFIED: AnalyzeResult['verification'] = Object.freeze({
  checkedEventIds: ['evt-suite-0001'],
  unresolvedEventIds: [],
  checkedTraceIds: [],
  unresolvedTraceIds: [],
  checkedSpanIds: [],
  unresolvedSpanIds: [],
  spanCheck: 'unavailable',
  checkedLocations: 0,
  issues: [],
  valid: true,
});

/** A failing subsystem's own error, as a stage returns it. */
function subsystemError(
  code: DebuggenErrorCode,
  message: string,
  options: { readonly hint?: string; readonly stage?: ProgressStage } = {},
): DebuggenError {
  return new DebuggenError(code, message, {
    ...(options.hint !== undefined ? { hint: options.hint } : {}),
    ...(options.stage !== undefined ? { details: { stage: options.stage } } : {}),
  });
}

/** The model boundary's own AAP §0.5.5 sentence, as a model-backed stage returns it. */
function modelUnavailable(stage?: ProgressStage): DebuggenError {
  return subsystemError('MODEL_UNAVAILABLE', modelUnavailableMessage('MODEL_UNAVAILABLE'), {
    hint: 'The provider did not answer; retry the step.',
    ...(stage !== undefined ? { stage } : {}),
  });
}

/** The store's refusal to keep a session-record patch, as the manager returns it. */
function recordWriteRefused(): DebuggenError {
  return subsystemError('STORE_ERROR', 'The session record could not be written.');
}

/** The fields of every warn record the orchestrator logged about one mirrored record field. */
function mirrorWarnings(records: readonly LoggedRecord[], field: keyof SessionPatch): LogFields[] {
  return records
    .filter((record) => record.level === 'warn' && record.fields['field'] === field)
    .map((record) => record.fields);
}

/** Two signals an install could not enable, and the degradation sentences the service built for them. */
const UNAVAILABLE: readonly UnavailableSignal[] = Object.freeze([
  {
    signal: 'react',
    reason: 'The page loaded before the extension could observe it',
    hint: 'Reload the page.',
  },
  {
    signal: 'pg',
    reason: 'No dev-server preload is connected',
    hint: 'Relaunch the dev server from Debug Generator.',
  },
]);
const DEGRADATIONS: readonly string[] = buildDegradationNotice(UNAVAILABLE, [
  'Browser performance',
  'Network tracing',
]);

/* -------------------------------------------------------------------------------------------------
 * Doubles: model tripwire, logger, deferred gates
 * ---------------------------------------------------------------------------------------------- */

/** Every `ModelProvider` method the orchestrator called, across the whole suite. Must stay empty. */
const providerCalls: string[] = [];

/**
 * The model provider every orchestrator in this suite is given. The
 * orchestrator hands it to the stages it builds and never calls it itself; with
 * every stage substituted, any call at all is a violation. Each method records
 * the call (checked after every test) and throws, so the call cannot be
 * mistaken for an answer.
 */
function tripwireProvider(): ModelProvider {
  const refuse = (method: string) => (): never => {
    providerCalls.push(method);
    throw new Error(
      `The orchestrator called ModelProvider.${method}; it must never talk to a model.`,
    );
  };
  return {
    id: 'deterministic',
    generateText: refuse('generateText'),
    generateStructured: refuse('generateStructured'),
    callTools: refuse('callTools'),
  };
}

beforeEach(() => {
  providerCalls.length = 0;
});

afterEach(() => {
  expect(providerCalls, 'the orchestrator must never call the model provider').toEqual([]);
});

/** One captured log record: its level, message and merged bindings and fields. */
interface LoggedRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that captures every record, with its child bindings merged — no console, no clock. */
function recordingLogger(records: LoggedRecord[], bindings: LogFields = {}): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (more) => recordingLogger(records, { ...bindings, ...more }),
  };
}

/** A promise a test settles by hand — the suite's only way to wait, so no timer is ever involved. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      settle?.(value);
    },
  };
}

/** A stage implementation that parks until the operation's signal aborts, then reports the cancellation. */
function parkUntilAborted<T>(
  entered: Deferred<PipelineStageContext>,
  stage: ProgressStage,
): (context: PipelineStageContext) => Promise<Result<T, DebuggenError>> {
  return (context) =>
    new Promise((resolve) => {
      context.signal?.addEventListener(
        'abort',
        () => {
          resolve(
            err(
              new DebuggenError('INTERNAL', 'The step was cancelled before it finished.', {
                details: { stage, reason: 'aborted' },
              }),
            ),
          );
        },
        { once: true },
      );
      entered.resolve(context);
    });
}

/* -------------------------------------------------------------------------------------------------
 * Doubles: tripwires for the collaborators the orchestrator only hands on
 * ---------------------------------------------------------------------------------------------- */

/** One recorded call of a tripwire member. */
interface MemberCall {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** A collaborator double: the value to inject and every call made on it. */
interface Tripwire<T> {
  readonly value: T;
  readonly calls: MemberCall[];
}

/**
 * A collaborator double that records every member call. `members` implements
 * the members a test expects to be reached; any other member answers with a
 * typed `Err` (never a throw, so the orchestrator's own handling stays
 * observable) and is still recorded, which is what the assertions read.
 */
function tripwire<T>(
  name: string,
  members: Readonly<Record<string, (...args: never[]) => unknown>> = {},
): Tripwire<T> {
  const calls: MemberCall[] = [];
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      // Neither a symbol lookup nor a thenable probe is a call.
      if (typeof property !== 'string' || property === 'then') {
        return undefined;
      }
      const member = members[property];
      return (...args: never[]): unknown => {
        calls.push({ member: property, args });
        if (member !== undefined) {
          return member(...args);
        }
        return err(
          new DebuggenError(
            'INTERNAL',
            `The suite's ${name} double does not implement ${property}.`,
          ),
        );
      };
    },
  };
  return { value: new Proxy({}, handler) as T, calls };
}

/** The member names of a tripwire's calls, in call order. */
function membersCalled(wire: Tripwire<unknown>): string[] {
  return wire.calls.map((call) => call.member);
}

/* -------------------------------------------------------------------------------------------------
 * Doubles: progress and the session manager
 * ---------------------------------------------------------------------------------------------- */

/** Who sent a progress row: the orchestrator itself, the manager's failed-transition row, or the install. */
type RowOrigin = 'orchestrator' | 'manager' | 'install';

/** One recorded progress call — the arguments exactly as the caller passed them. */
interface ProgressCall {
  readonly method: keyof SessionProgress;
  readonly origin: RowOrigin;
  readonly stage: ProgressStage | undefined;
  readonly status: SessionProgressPayload['status'] | undefined;
  /** The caller's message; `undefined` when it passed none (the stage title is then the emitter's). */
  readonly message: string | undefined;
  readonly failure: SessionFailure | undefined;
}

/** Mutable state every double shares: the origin of the next progress row and the event timeline. */
interface SharedState {
  origin: RowOrigin;
  /**
   * One entry per stage call, transition, plan record, root confirmation,
   * install, load and progress row, in order.
   */
  readonly timeline: string[];
}

/** Runs `call` with progress rows attributed to `origin`. Progress calls are synchronous. */
function within<T>(state: SharedState, origin: RowOrigin, call: () => T): T {
  const previous = state.origin;
  state.origin = origin;
  try {
    return call();
  } finally {
    state.origin = previous;
  }
}

/** A `SessionProgress` that records every call, with its origin, and sends nothing. */
function recordingProgress(state: SharedState, calls: ProgressCall[]): SessionProgress {
  const push = (
    method: keyof SessionProgress,
    sessionId: string,
    fields: Partial<Omit<ProgressCall, 'method' | 'origin'>>,
  ): Result<SessionProgressPayload, DebuggenError> => {
    const stage = fields.stage ?? 'understand';
    const status = fields.status ?? 'done';
    calls.push({
      method,
      origin: state.origin,
      stage: fields.stage,
      status: fields.status,
      message: fields.message,
      failure: fields.failure,
    });
    state.timeline.push(`row:${method}:${fields.stage ?? '-'}`);
    return ok({ sessionId, stage, status, message: fields.message ?? stage });
  };

  return {
    emit: (sessionId, row: ProgressRow) =>
      push('emit', sessionId, { stage: row.stage, status: row.status, message: row.message }),
    stageStarted: (sessionId, stage, message) =>
      push('stageStarted', sessionId, { stage, status: 'running', message }),
    stageCompleted: (sessionId, stage, message) =>
      push('stageCompleted', sessionId, { stage, status: 'done', message }),
    stageFailed: (sessionId, failure) =>
      push('stageFailed', sessionId, {
        stage: failure.stage,
        status: 'failed',
        message: failure.message,
        failure,
      }),
    finding: (sessionId, stage, message) =>
      push('finding', sessionId, { stage, status: 'done', message }),
    reportInvestigation: (sessionId) => {
      push('reportInvestigation', sessionId, {});
      return ok([]);
    },
    reportInstrumentation: (sessionId) => {
      push('reportInstrumentation', sessionId, {});
      return ok([]);
    },
    readyToCapture: (sessionId) =>
      push('readyToCapture', sessionId, { stage: 'instrument', status: 'done' }),
  };
}

/** One status change the manager applied, with the context the orchestrator supplied. */
interface TransitionRecord {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  readonly context: SessionTransitionContext | undefined;
}

/**
 * What a test scripts on the manager: a refusal of a transition, of a record
 * patch (the store failing to keep a mirror), or of opening a capture window.
 */
interface ManagerScript {
  refuseTransition:
    | ((
        from: SessionStatus,
        to: SessionStatus,
        context: SessionTransitionContext | undefined,
      ) => DebuggenError | undefined)
    | undefined;
  /** Answers the error a patch is refused with — nothing is stored — or `undefined` to apply it. */
  refusePatch: ((patch: SessionPatch) => DebuggenError | undefined) | undefined;
  startCaptureError: DebuggenError | undefined;
  /**
   * The error a stop is refused with — the store refusing the closure and the
   * status commit together, so the window stays open and the status
   * `capturing` — or `undefined` to close the window.
   */
  stopCaptureError: DebuggenError | undefined;
  /**
   * Answers `confirmProjectRoot` for a session the manager holds: the root's
   * re-proven identity, a refusal, or a throw. Defaults to the suite's root
   * confirmed as its own canonical path (one frozen answer).
   */
  confirmProjectRoot: (sessionId: string) => RootConfirmation;
}

/** What `SessionManager.confirmProjectRoot` answers, read off the port. */
type RootConfirmation = ReturnType<SessionManager['confirmProjectRoot']>;

/** The default confirmation: the suite's root resolves to itself. */
const CONFIRMED_ROOT: RootConfirmation = ok(
  Object.freeze({ projectRoot: PROJECT_ROOT, canonicalRoot: PROJECT_ROOT }),
);

/** The recording session manager and everything it recorded. */
interface FakeManager {
  readonly wire: Tripwire<SessionManager>;
  /** Transitions applied (a scripted refusal is recorded in `wire.calls` but not here). */
  readonly transitions: TransitionRecord[];
  readonly patches: SessionPatch[];
  /** Every plan version recorded through `recordPlan`, in order. */
  readonly recordedPlans: InstrumentationPlan[];
  readonly followUpQuestions: string[];
  /** The attempt id of every `appendFollowUp` call, in order. */
  readonly followUpAttemptIds: string[];
  readonly script: ManagerScript;
  current(): SessionRecord;
}

/** The manager's answer for an id that names no session this suite holds. */
function notFound(sessionId: string): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', 'No debugging session with this id exists.', {
    details: { sessionId },
  });
}

/**
 * An in-memory session manager that **records every call and enforces
 * nothing**: no state-machine guard, no lifecycle ownership. What it does
 * model is the real manager's documented side effects, because the
 * orchestrator relies on them — a transition into `failed` writes the failing
 * stage's `failed` row, `recordPlan` stamps the next version of the ladder,
 * and the capture methods open and close the window. Every stored mutation is
 * re-validated against protocol's session schema, so an artifact the
 * orchestrator mirrors wrongly fails the test.
 *
 * `aliases` are further session ids the manager answers with the same stored
 * record: to the orchestrator, whose per-session bookkeeping is keyed by the
 * id it is asked about, they are further live sessions of the same project.
 */
function fakeManager(
  initial: SessionRecord,
  progress: SessionProgress,
  state: SharedState,
  aliases: ReadonlySet<string> = new Set(),
): FakeManager {
  let record = initial;
  /** Whether `sessionId` names the stored record, directly or through an alias. */
  const answers = (sessionId: string): boolean => sessionId === record.id || aliases.has(sessionId);
  const transitions: TransitionRecord[] = [];
  const patches: SessionPatch[] = [];
  const recordedPlans: InstrumentationPlan[] = [];
  const followUpQuestions: string[] = [];
  const followUpAttemptIds: string[] = [];
  const script: ManagerScript = {
    refuseTransition: undefined,
    refusePatch: undefined,
    startCaptureError: undefined,
    stopCaptureError: undefined,
    confirmProjectRoot: () => CONFIRMED_ROOT,
  };

  const store = (next: Partial<SessionRecord>): SessionRecord => {
    record = sessionRecordSchema.parse({ ...record, ...next, updatedAt: record.updatedAt + 1 });
    return record;
  };

  const members = {
    get: (sessionId: string): Result<SessionRecord | undefined, DebuggenError> =>
      ok(answers(sessionId) ? record : undefined),

    // Synchronous, as the real manager's is: the orchestrator must be able to
    // act in the turn the identity was proven in.
    confirmProjectRoot: (sessionId: string): RootConfirmation => {
      state.timeline.push('confirmProjectRoot');
      return answers(sessionId) ? script.confirmProjectRoot(sessionId) : err(notFound(sessionId));
    },

    transitionTo: (
      sessionId: string,
      to: SessionStatus,
      context?: SessionTransitionContext,
    ): Promise<Result<SessionRecord, DebuggenError>> => {
      state.timeline.push(`transition:${to}`);
      if (!answers(sessionId)) {
        return Promise.resolve(err(notFound(sessionId)));
      }
      const from = record.status;
      const refusal = script.refuseTransition?.(from, to, context);
      if (refusal !== undefined) {
        return Promise.resolve(err(refusal));
      }
      transitions.push({ from, to, context });
      const moved = store({ status: to });
      const failure = context?.failure;
      if (to === 'failed' && failure !== undefined) {
        within(state, 'manager', () => progress.stageFailed(sessionId, failure));
      }
      return Promise.resolve(ok(moved));
    },

    patch: (
      sessionId: string,
      patch: SessionPatch,
    ): Promise<Result<SessionRecord, DebuggenError>> => {
      if (!answers(sessionId)) {
        return Promise.resolve(err(notFound(sessionId)));
      }
      const refusal = script.refusePatch?.(patch);
      if (refusal !== undefined) {
        return Promise.resolve(err(refusal));
      }
      patches.push(patch);
      return Promise.resolve(ok(store(patch as Partial<SessionRecord>)));
    },

    recordPlan: (
      sessionId: string,
      input: RecordPlanInput,
    ): Promise<Result<RecordedPlan, DebuggenError>> => {
      if (!answers(sessionId)) {
        return Promise.resolve(err(notFound(sessionId)));
      }
      const plan = instrumentationPlanSchema.parse({
        ...input,
        sessionId,
        planVersion: record.plans.length + 1,
      });
      recordedPlans.push(plan);
      state.timeline.push(`recordPlan:${String(plan.planVersion)}`);
      return Promise.resolve(ok({ session: store({ plans: [...record.plans, plan] }), plan }));
    },

    appendFollowUp: (
      sessionId: string,
      question: string,
      attemptId: string,
    ): Promise<Result<SessionRecord, DebuggenError>> => {
      followUpQuestions.push(question);
      followUpAttemptIds.push(attemptId);
      return Promise.resolve(answers(sessionId) ? ok(record) : err(notFound(sessionId)));
    },

    recordFollowUpOutcome: (sessionId: string): Promise<Result<SessionRecord, DebuggenError>> =>
      Promise.resolve(answers(sessionId) ? ok(record) : err(notFound(sessionId))),

    startCapture: (
      sessionId: string,
    ): Promise<Result<{ readonly captureId: string }, DebuggenError>> => {
      state.timeline.push('startCapture');
      if (!answers(sessionId)) {
        return Promise.resolve(err(notFound(sessionId)));
      }
      if (script.startCaptureError !== undefined) {
        return Promise.resolve(err(script.startCaptureError));
      }
      const capture: CaptureRecord = {
        id: CAPTURE_ID,
        planVersion: record.plans.at(-1)?.planVersion ?? 1,
        startedAt: FIXED_EPOCH_MS,
      };
      store({ status: 'capturing', captures: [...record.captures, capture] });
      return Promise.resolve(ok({ captureId: CAPTURE_ID }));
    },

    stopCapture: (
      sessionId: string,
      options: StopCaptureOptions,
    ): Promise<Result<CaptureRecord, DebuggenError>> => {
      state.timeline.push(`stopCapture:${options.next}`);
      if (script.stopCaptureError !== undefined) {
        return Promise.resolve(err(script.stopCaptureError));
      }
      const open = record.captures.at(-1);
      if (!answers(sessionId) || open === undefined || open.stoppedAt !== undefined) {
        return Promise.resolve(
          err(new DebuggenError('SESSION_INVALID_STATE', 'No capture window is open.')),
        );
      }
      const stopped: CaptureRecord = { ...open, stoppedAt: FIXED_EPOCH_MS + 5 };
      store({ status: options.next, captures: [...record.captures.slice(0, -1), stopped] });
      return Promise.resolve(ok(stopped));
    },
  } satisfies Partial<Record<keyof SessionManager, (...args: never[]) => unknown>>;

  return {
    wire: tripwire<SessionManager>('session manager', members),
    transitions,
    patches,
    recordedPlans,
    followUpQuestions,
    followUpAttemptIds,
    script,
    current: () => record,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/** The eight stage methods, as the spies the overrides are built from. */
interface StageSpies {
  readonly understand: Mock<Stages['understand']['run']>;
  readonly investigate: Mock<Stages['investigate']['run']>;
  readonly plan: Mock<Stages['plan']['run']>;
  readonly arm: Mock<Stages['capture']['arm']>;
  readonly complete: Mock<Stages['capture']['complete']>;
  readonly analyze: Mock<Stages['analyze']['run']>;
  readonly generatePanel: Mock<Stages['generatePanel']['run']>;
  readonly followUp: Mock<Stages['followUp']['run']>;
}

/** The scripted instrumentation service; `evaluateReadiness` is present only when a test offers it. */
interface InstrumentationDouble {
  readonly arming: Mock<InstrumentationService['arming']>;
  readonly buildContext: Mock<InstrumentationService['buildContext']>;
  readonly install: Mock<InstrumentationService['install']>;
  readonly armCapture: Mock<InstrumentationService['armCapture']>;
  readonly disarmCapture: Mock<InstrumentationService['disarmCapture']>;
  readonly evaluateReadiness?: Mock<EvaluateReadinessFn>;
}

/** The capture-time readiness re-evaluation the instrumentation layer may offer. */
type EvaluateReadinessFn = NonNullable<
  PipelineOrchestratorDeps['instrumentation']['evaluateReadiness']
>;

/** What a test scripts beyond the manager: the install, the capture's outcome and the follow-up path. */
interface HarnessScript {
  install: InstallScript;
  emptiness: CaptureEmptiness;
  summary: CaptureSummary;
  followUpPath: FollowUpPath;
  /** The decision's own flag; `undefined` means "true exactly on the new-capture path". */
  needsNewCapture: boolean | undefined;
  fallbackPanel: boolean;
}

interface HarnessOptions {
  readonly session?: Partial<SessionRecord>;
  readonly script?: Partial<HarnessScript>;
  /** Offers `evaluateReadiness` on the instrumentation double. */
  readonly evaluateReadiness?: Mock<EvaluateReadinessFn>;
  /** Further session ids the manager answers with the suite's one record (see `fakeManager`). */
  readonly sessionAliases?: readonly string[];
  /**
   * The installing stages the orchestrator builds through its own factory
   * instead of taking the override. The factory is this file's spy (see the
   * `vi.mock` calls): it returns the same fake, which then installs through
   * the installer the orchestrator handed the factory — so a test observes the
   * wiring of that installer rather than the fake's own call.
   */
  readonly builtStages?: readonly InstallingStage[];
}

/** The stages that install through the orchestrator's installer. */
type InstallingStage = 'plan' | 'followUp';

/** The names of the tripwired collaborators the orchestrator only hands on (or reads narrowly). */
type TripwireName =
  | 'promptLoader'
  | 'contextBuilder'
  | 'sessionsRepo'
  | 'panelsRepo'
  | 'telemetryRepo'
  | 'modifications'
  | 'summarizer'
  | 'facts'
  | 'adapters';

interface Harness {
  readonly orchestrator: PipelineOrchestrator;
  readonly manager: FakeManager;
  readonly progressCalls: ProgressCall[];
  readonly records: LoggedRecord[];
  readonly timeline: string[];
  readonly stages: StageSpies;
  readonly instrumentation: InstrumentationDouble;
  readonly codeIndex: {
    readonly load: Mock<CodeIndexPort['load']>;
    readonly invalidate: Mock<NonNullable<CodeIndexPort['invalidate']>>;
  };
  readonly observeReadiness: Mock<ObserveReadinessFn>;
  readonly panelGenerator: {
    readonly generate: Mock<PanelGenerator['generate']>;
    readonly regenerate: Mock<PanelGenerator['regenerate']>;
  };
  readonly promptVersions: Mock<PromptLoader['versions']>;
  readonly tripwires: Readonly<Record<TripwireName, Tripwire<unknown>>>;
  readonly code: PipelineCodeHandles;
  readonly script: HarnessScript;
}

/**
 * Builds an orchestrator over in-file doubles only. Every stage is overridden;
 * each fake models its stage's documented contract with the scripted
 * collaborators and records itself on the shared timeline.
 */
function harness(options: HarnessOptions = {}): Harness {
  const records: LoggedRecord[] = [];
  const progressCalls: ProgressCall[] = [];
  const state: SharedState = { origin: 'orchestrator', timeline: [] };
  const { timeline } = state;
  const progress = recordingProgress(state, progressCalls);
  const manager = fakeManager(
    sessionRecord(options.session),
    progress,
    state,
    new Set(options.sessionAliases),
  );
  const sessions = manager.wire.value;
  const code = codeHandles();
  const script: HarnessScript = {
    install: {},
    emptiness: WITH_EVIDENCE,
    summary: EVIDENCE_SUMMARY,
    followUpPath: 'existing-evidence',
    needsNewCapture: undefined,
    fallbackPanel: false,
    ...options.script,
  };

  /* The instrumentation service — the only writer to the project — scripted. */
  const instrumentation: InstrumentationDouble = {
    arming: vi.fn<InstrumentationService['arming']>(() => undefined),
    buildContext: vi.fn<InstrumentationService['buildContext']>(() =>
      err(new DebuggenError('INTERNAL', 'Building an adapter context is the plan stage’s call.')),
    ),
    install: vi.fn<InstrumentationService['install']>((request: InstallRequest) => {
      timeline.push(`install:${String(request.plan.planVersion)}`);
      const outcome = installationOf(request.plan, script.install);
      // The readiness gate's own rows (AAP §0.5.5): one degradation sentence per
      // signal it could not enable, then "Ready to capture" when satisfied.
      within(state, 'install', () => {
        for (const sentence of outcome.degradations) {
          progress.finding(request.sessionId, 'instrument', sentence);
        }
        if (outcome.readiness.satisfied) {
          progress.readyToCapture(request.sessionId);
        }
      });
      return Promise.resolve(ok(outcome));
    }),
    armCapture: vi.fn<InstrumentationService['armCapture']>((request) => {
      timeline.push('armCapture');
      return ok({
        sessionId: request.sessionId,
        captureId: request.captureId,
        planVersion: 1,
        agentHooks: DORMANT_AGENT_HOOK_CONFIG,
        serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
        serverAgent: 'not-needed',
      });
    }),
    disarmCapture: vi.fn<InstrumentationService['disarmCapture']>((request) => {
      timeline.push('disarmCapture');
      return ok({
        sessionId: request.sessionId,
        captureId: request.captureId,
        agentDisarmed: true,
        serverAgent: 'not-needed',
      });
    }),
    ...(options.evaluateReadiness !== undefined
      ? { evaluateReadiness: options.evaluateReadiness }
      : {}),
  };
  const instrumentationDep: PipelineOrchestratorDeps['instrumentation'] = {
    ...instrumentation,
    restoreArming: () =>
      err(new DebuggenError('INTERNAL', 'Restoring arming is the service start-up’s call.')),
    isInstalling: () => false,
    stopSession: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
  /**
   * What the plan and follow-up fakes install through: the scripted service
   * itself, or — for a stage in `builtStages` — the installer the orchestrator
   * handed that stage's factory.
   */
  const installers: Record<InstallingStage, Pick<InstrumentationService, 'install'>> = {
    plan: instrumentationDep,
    followUp: instrumentationDep,
  };
  const builtStages = new Set(options.builtStages);

  const codeIndex = {
    load: vi.fn<CodeIndexPort['load']>(() => {
      timeline.push('load');
      return Promise.resolve(ok(code));
    }),
    invalidate: vi.fn<NonNullable<CodeIndexPort['invalidate']>>(),
  };
  const observeReadiness = vi.fn<ObserveReadinessFn>(() => Promise.resolve(ok({})));

  const regeneration: PanelGenerationResult = {
    panel: panelOf(2),
    fallback: false,
    promptVersion: REGENERATED['generate-panel'],
    attempts: 1,
    repairs: 0,
    broadcast: true,
  };
  const panelGenerator = {
    generate: vi.fn<PanelGenerator['generate']>(() =>
      Promise.resolve(err(new DebuggenError('INTERNAL', 'Generating a panel is Stage 6’s call.'))),
    ),
    regenerate: vi.fn<PanelGenerator['regenerate']>(() => Promise.resolve(ok(regeneration))),
  };

  const promptVersions = vi.fn<PromptLoader['versions']>(() => ok(MANIFEST));
  const tripwires = {
    promptLoader: tripwire<PromptLoader>('prompt loader', { versions: promptVersions }),
    contextBuilder: tripwire<ContextBuilder>('context builder'),
    sessionsRepo: tripwire<SessionsRepo>('sessions repository', {
      latestPlanVersion: (sessionId: string) =>
        ok(sessionId === SESSION_ID ? manager.current().plans.at(-1)?.planVersion : undefined),
      getPlan: (sessionId: string, planVersion: number) =>
        ok(
          sessionId === SESSION_ID
            ? manager.current().plans.find((plan) => plan.planVersion === planVersion)
            : undefined,
        ),
    }),
    panelsRepo: tripwire<PanelsRepo>('panels repository'),
    telemetryRepo: tripwire<TelemetryRepo>('telemetry repository'),
    modifications: tripwire<ModificationsPort>('modification journal'),
    summarizer: tripwire<AnalysisSummarizer>('analysis summarizer'),
    facts: tripwire<AnalysisFacts>('analysis facts'),
    adapters: tripwire<AdapterRegistry>('adapter registry'),
  };

  /** The outcome of a completed capture window, as the capture stage reports it. */
  const completion = (
    capture: CaptureRecord,
    stoppedNow: boolean,
    next: CaptureCompletion['next'],
  ): CaptureCompletion => ({
    captureId: capture.id,
    planVersion: capture.planVersion,
    summary: script.summary,
    summarySource: stoppedNow ? 'computed' : 'stored',
    emptiness: script.emptiness,
    next,
    capture,
    stoppedNow,
    armed: {
      agentHooks: DORMANT_AGENT_HOOK_CONFIG,
      serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
      source: 'service',
    },
  });

  const stages: StageSpies = {
    understand: vi.fn<Stages['understand']['run']>(() => {
      timeline.push('stage:understand');
      const result: UnderstandResult = {
        understanding: UNDERSTANDING,
        promptVersion: REPORTED.understand,
        repairs: 0,
      };
      return Promise.resolve(ok(result));
    }),

    investigate: vi.fn<Stages['investigate']['run']>(() => {
      timeline.push('stage:investigate');
      const result: InvestigateResult = {
        investigation: INVESTIGATION,
        promptVersion: REPORTED.investigate,
        repairs: 0,
        toolRuns: [],
      };
      return Promise.resolve(ok(result));
    }),

    // Records the validated plan, hands the recorded version to the
    // orchestrator's seam, then installs it with the run's code handles.
    plan: vi.fn<Stages['plan']['run']>(async (context, input: PlanInput) => {
      timeline.push('stage:plan');
      const recorded = await sessions.recordPlan(context.sessionId, planBody([ACTION_V1]));
      if (!recorded.ok) {
        return err(recorded.error);
      }
      const handed = await input.beforeInstall?.(recorded.value);
      if (handed !== undefined && !handed.ok) {
        return err(handed.error);
      }
      const installed = await installers.plan.install({
        sessionId: context.sessionId,
        projectRoot: context.projectRoot,
        plan: recorded.value.plan,
        code: installHandles(context.code),
        signal: context.signal,
      });
      if (!installed.ok) {
        return err(installed.error);
      }
      const result: PlanResult = {
        plan: recorded.value.plan,
        planVersion: recorded.value.plan.planVersion,
        promptVersion: REPORTED.plan,
        repairs: 0,
        feasibility: feasibilityOf(recorded.value.plan),
        fallback: false,
        session: recorded.value.session,
        installation: installed.value,
      };
      return ok(result);
    }),

    // Opens the window through the manager (a conflict passes through
    // unchanged), then arms both producers.
    arm: vi.fn<Stages['capture']['arm']>(async (context, input) => {
      timeline.push('stage:arm');
      const opened = await sessions.startCapture(context.sessionId);
      if (!opened.ok) {
        return err(opened.error);
      }
      const armed = instrumentationDep.armCapture({
        sessionId: context.sessionId,
        captureId: opened.value.captureId,
      });
      if (!armed.ok) {
        return err(armed.error);
      }
      const result: CaptureArmResult = {
        captureId: opened.value.captureId,
        planVersion: armed.value.planVersion,
        readiness: input?.readiness ?? verdict(true),
        readinessSource: 'supplied',
        agentHooks: armed.value.agentHooks,
        serverSignals: armed.value.serverSignals,
        serverAgent: armed.value.serverAgent,
        degradations: [],
      };
      return ok(result);
    }),

    // Disarms, then closes the window — to `analyzing` with evidence, to
    // `ready` when empty. A stopped capture named by id is read back instead.
    complete: vi.fn<Stages['capture']['complete']>(async (context, input) => {
      timeline.push('stage:complete');
      const resumeId = input?.captureId;
      if (resumeId !== undefined) {
        const stored = context.session.captures.find((capture) => capture.id === resumeId);
        if (stored === undefined) {
          return err(new DebuggenError('SESSION_INVALID_STATE', 'That capture is not stored.'));
        }
        return ok(completion(stored, false, script.emptiness.empty ? 'ready' : 'analyzing'));
      }
      instrumentationDep.disarmCapture({ sessionId: context.sessionId, captureId: CAPTURE_ID });
      const next = script.emptiness.empty ? 'ready' : 'analyzing';
      const stopped = await sessions.stopCapture(context.sessionId, {
        summary: script.summary,
        next,
      });
      if (!stopped.ok) {
        return err(stopped.error);
      }
      return ok(completion(stopped.value, true, next));
    }),

    analyze: vi.fn<Stages['analyze']['run']>(() => {
      timeline.push('stage:analyze');
      const result: AnalyzeResult = {
        analysis: analysisOf(1),
        analysisVersion: 1,
        promptVersion: REPORTED.analyze,
        repairs: 0,
        attempts: 1,
        providerId: 'deterministic',
        model: 'rules',
        verification: VERIFIED,
        summary: script.summary,
        truncated: [],
      };
      return Promise.resolve(ok(result));
    }),

    generatePanel: vi.fn<Stages['generatePanel']['run']>(() => {
      timeline.push('stage:generatePanel');
      const panel = script.fallbackPanel ? FALLBACK_PANEL_V1 : PANEL_V1;
      const result: GeneratePanelResult = {
        panelId: panel.id,
        panel,
        panelVersion: panel.panelVersion,
        promptVersion: REPORTED['generate-panel'],
        fallback: script.fallbackPanel,
        repairs: script.fallbackPanel ? 2 : 0,
        attempts: script.fallbackPanel ? 3 : 1,
      };
      return Promise.resolve(ok(result));
    }),

    // Records the question, decides on the prompt version the session
    // recorded, then takes the one path through the orchestrator's seams.
    followUp: vi.fn<Stages['followUp']['run']>(async (context, input: FollowUpInput) => {
      timeline.push('stage:followUp');
      const appended = await sessions.appendFollowUp(
        context.sessionId,
        input.followUpQuestion,
        input.attemptId,
      );
      if (!appended.ok) {
        return err(appended.error);
      }
      const promptVersion = context.promptVersions.followup ?? MANIFEST.followup;
      const path = script.followUpPath;
      const needsNewCapture = script.needsNewCapture ?? path === 'new-capture';
      const chosen = await input.onPathChosen?.(path);
      if (chosen !== undefined && !chosen.ok) {
        return err(chosen.error);
      }

      if (path === 'existing-evidence') {
        const analysis = analysisOf(2);
        const regenerated = await panelGenerator.regenerate({
          sessionId: context.sessionId,
          captureId: CAPTURE_ID,
          question: context.question,
          followUpQuestion: input.followUpQuestion,
          analysis,
          summary: script.summary,
          signal: context.signal,
        });
        if (!regenerated.ok) {
          return err(regenerated.error);
        }
        const result: FollowUpResult = {
          path,
          decision: decisionOf(needsNewCapture, promptVersion),
          session: context.session,
          outcomeRecorded: true,
          captureId: CAPTURE_ID,
          analysis,
          analysisVersion: analysis.analysisVersion,
          supersededAnalysisId: analysisOf(1).id,
          panel: regenerated.value.panel,
          panelVersion: regenerated.value.panel.panelVersion,
          supersededPanelId: PANEL_V1.id,
          fallbackPanel: regenerated.value.fallback,
          analysisPromptVersion: REGENERATED.analyze,
          panelPromptVersion: regenerated.value.promptVersion,
        };
        return ok(result);
      }

      const handed = await input.beforeInstall?.(PLAN_V2);
      if (handed !== undefined && !handed.ok) {
        return err(handed.error);
      }
      const installed = await installers.followUp.install({
        sessionId: context.sessionId,
        projectRoot: context.projectRoot,
        plan: PLAN_V2,
        code: installHandles(context.code),
        previousPlanVersion: PLAN_V1.planVersion,
        previousActions: PLAN_V1.instrumentationTargets,
        signal: context.signal,
      });
      if (!installed.ok) {
        return err(installed.error);
      }
      const recorded = await sessions.recordPlan(
        context.sessionId,
        planBody(PLAN_V2.instrumentationTargets),
      );
      if (!recorded.ok) {
        return err(recorded.error);
      }
      const result: FollowUpResult = {
        path,
        decision: decisionOf(needsNewCapture, promptVersion),
        session: recorded.value.session,
        outcomeRecorded: true,
        plan: recorded.value.plan,
        planVersion: recorded.value.plan.planVersion,
        previousPlanVersion: PLAN_V1.planVersion,
        delta: [DELTA_ACTION],
        feasibility: feasibilityOf(recorded.value.plan),
        chainedFiles: 1,
        installation: installed.value,
      };
      return ok(result);
    }),
  };

  const deps: PipelineOrchestratorDeps = {
    // Read only by the default code-index loader, which an injected `codeIndex` replaces.
    config: { indexCacheDir: '/workspace/.suite-index-never-opened' } as ServiceConfig,
    logger: recordingLogger(records),
    provider: tripwireProvider(),
    promptLoader: tripwires.promptLoader.value,
    contextBuilder: tripwires.contextBuilder.value,
    sessions,
    progress,
    sessionsRepo: tripwires.sessionsRepo.value,
    panelsRepo: tripwires.panelsRepo.value,
    telemetryRepo: tripwires.telemetryRepo.value,
    instrumentation: instrumentationDep,
    modifications: tripwires.modifications.value,
    summarizer: tripwires.summarizer.value,
    facts: tripwires.facts.value,
    panelGenerator,
    adapters: tripwires.adapters.value,
    observeReadiness,
    codeIndex,
    stages: {
      understand: { run: stages.understand },
      investigate: { run: stages.investigate },
      ...(builtStages.has('plan') ? {} : { plan: { run: stages.plan } }),
      capture: { arm: stages.arm, complete: stages.complete },
      analyze: { run: stages.analyze },
      generatePanel: { run: stages.generatePanel },
      ...(builtStages.has('followUp') ? {} : { followUp: { run: stages.followUp } }),
    },
    now: () => FIXED_EPOCH_MS,
  };

  // A built stage is still the fake; only its installer is the orchestrator's.
  if (builtStages.has('plan')) {
    vi.mocked(createPlanStage).mockImplementationOnce((planDeps) => {
      installers.plan = planDeps.instrumentation;
      return { run: stages.plan };
    });
  }
  if (builtStages.has('followUp')) {
    vi.mocked(createFollowUpStage).mockImplementationOnce((followUpDeps) => {
      installers.followUp = followUpDeps.instrumentation;
      return { run: stages.followUp };
    });
  }

  return {
    orchestrator: createPipelineOrchestrator(deps),
    manager,
    progressCalls,
    records,
    timeline,
    stages,
    instrumentation,
    codeIndex,
    observeReadiness,
    panelGenerator,
    promptVersions,
    tripwires,
    code,
    script,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/** The statuses the session moved to, in order. */
function statusesOf(h: Harness): SessionStatus[] {
  return h.manager.transitions.map((entry) => entry.to);
}

/** The failures the session was filed under, in order. */
function failuresOf(h: Harness): SessionFailure[] {
  return h.manager.transitions.flatMap((entry) =>
    entry.to === 'failed' && entry.context?.failure !== undefined ? [entry.context.failure] : [],
  );
}

/** Every `stageFailed` row sent, whoever sent it. */
function failedRows(h: Harness): ProgressCall[] {
  return h.progressCalls.filter((call) => call.method === 'stageFailed');
}

/** The progress calls the orchestrator itself made. */
function orchestratorRows(h: Harness): ProgressCall[] {
  return h.progressCalls.filter((call) => call.origin === 'orchestrator');
}

/** How many times the orchestrator asked the manager for a transition to `to`, refused or not. */
function transitionRequests(h: Harness, to: SessionStatus): number {
  return h.manager.wire.calls.filter(
    (call) => call.member === 'transitionTo' && call.args[1] === to,
  ).length;
}

/** Unwraps an `Ok`, failing the test with the error otherwise. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`Expected Ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Unwraps an `Err`, failing the test otherwise. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('Expected Err, got Ok.');
  }
  return result.error;
}

/** Asserts `expected` occurs in `timeline` in this order (other entries may interleave). */
function expectInOrder(timeline: readonly string[], expected: readonly string[]): void {
  let from = 0;
  for (const entry of expected) {
    const at = timeline.indexOf(entry, from);
    expect(
      at,
      `"${entry}" after position ${String(from)} in ${timeline.join(' → ')}`,
    ).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** Drives a session from `created` to `ready`. */
async function toReady(h: Harness): Promise<void> {
  expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
}

/** Drives a session from `created` through an armed capture window. */
async function toCapturing(h: Harness): Promise<void> {
  await toReady(h);
  expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
}

/** Drives a session from `created` to `generated`. */
async function toGenerated(h: Harness): Promise<void> {
  await toCapturing(h);
  expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
}

/* =================================================================================================
 * 1. The stage vocabulary is protocol's, never restated
 * ============================================================================================== */

describe('PIPELINE_STAGE_ORDER', () => {
  it('is derived from protocol’s PROGRESS_STAGES: every member is upstream, once, in upstream order', () => {
    const upstream: readonly string[] = PROGRESS_STAGES;

    for (const stage of PIPELINE_STAGE_ORDER) {
      expect(upstream).toContain(stage);
    }
    const positions = PIPELINE_STAGE_ORDER.map((stage) => upstream.indexOf(stage));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(new Set(PIPELINE_STAGE_ORDER).size).toBe(PIPELINE_STAGE_ORDER.length);
    expect(Object.isFrozen(PIPELINE_STAGE_ORDER)).toBe(true);
  });

  it('holds exactly the stages that own a session status, plus the follow-up stage', () => {
    const followUp: ProgressStage = 'followup';

    expect(PIPELINE_STAGE_ORDER).toEqual(
      PROGRESS_STAGES.filter((stage) => statusForStage(stage) !== undefined || stage === followUp),
    );
    const excluded = PROGRESS_STAGES.filter((stage) => !PIPELINE_STAGE_ORDER.includes(stage));
    expect(excluded.length).toBeGreaterThan(0);
    for (const stage of excluded) {
      expect(statusForStage(stage)).toBeUndefined();
    }
  });
});

/* =================================================================================================
 * 2. run — sequencing and bookkeeping
 * ============================================================================================== */

describe('run: sequencing', () => {
  it('runs understand → investigate → plan → install → readiness, moving the status before each', async () => {
    const h = harness();

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome).toMatchObject({
      sessionId: SESSION_ID,
      status: 'ready',
      ready: true,
      planVersion: 1,
      fallbackPlan: false,
      relevantFileCount: 1,
      appliedModifications: 1,
      degradations: [],
      promptVersionsRecorded: true,
    });
    expect(statusesOf(h)).toEqual([
      'understanding',
      'investigating',
      'planning',
      'instrumenting',
      'ready',
    ]);
    expectInOrder(h.timeline, [
      'transition:understanding',
      'load',
      'stage:understand',
      'transition:investigating',
      'stage:investigate',
      'transition:planning',
      'stage:plan',
      'recordPlan:1',
      'transition:instrumenting',
      'install:1',
      'transition:ready',
    ]);
    expect(h.stages.arm).not.toHaveBeenCalled();
    expect(h.stages.analyze).not.toHaveBeenCalled();
  });

  it('asks for instrumenting → ready only with the install’s satisfied readiness verdict', async () => {
    const h = harness();
    await toReady(h);

    const ready = h.manager.transitions.find((entry) => entry.to === 'ready');
    expect(ready?.from).toBe('instrumenting');
    expect(ready?.context).toEqual({ readinessSatisfied: true });
  });

  it('stays at instrumenting, without failing, while the readiness verdict is unsatisfied', async () => {
    const h = harness({ script: { install: { satisfied: false } } });

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.status).toBe('instrumenting');
    expect(outcome.ready).toBe(false);
    expect(transitionRequests(h, 'ready')).toBe(0);
    expect(transitionRequests(h, 'failed')).toBe(0);
    expect(failedRows(h)).toEqual([]);
  });

  it('loads the code handles once per run, refreshed, and hands the same bundle to every stage and to the install', async () => {
    const h = harness();
    await toReady(h);

    expect(h.codeIndex.load).toHaveBeenCalledTimes(1);
    expect(h.codeIndex.load.mock.calls[0]?.[0]).toBe(PROJECT_ROOT);
    expect(h.codeIndex.load.mock.calls[0]?.[1]).toMatchObject({ refresh: true });
    for (const spy of [h.stages.understand, h.stages.investigate, h.stages.plan]) {
      expect(spy.mock.calls[0]?.[0].code).toBe(h.code);
      expect(spy.mock.calls[0]?.[0].projectRoot).toBe(PROJECT_ROOT);
    }
    const installed = h.instrumentation.install.mock.calls[0]?.[0];
    expect(installed?.code.graph).toBe(h.code.graph);
    expect(installed?.code.queries).toBe(h.code.queries);
    expect(installed?.code.routeMap).toBe(h.code.routeMap);
    expect(installed?.code.summary).toBe(h.code.projectSummary);
  });

  it('hands Stage 2 the Stage 1 artifact and Stage 3 both upstream artifacts and the observed readiness', async () => {
    const h = harness();
    await toReady(h);

    expect(h.stages.understand.mock.calls[0]?.[1]).toEqual({});
    expect(h.stages.investigate.mock.calls[0]?.[1]).toEqual({ understanding: UNDERSTANDING });
    const planInput = h.stages.plan.mock.calls[0]?.[1];
    expect(planInput?.understanding).toEqual(UNDERSTANDING);
    expect(planInput?.investigation).toEqual(INVESTIGATION);
    expect(planInput?.readiness).toEqual({});
    expect(typeof planInput?.beforeInstall).toBe('function');
    expect(h.observeReadiness).toHaveBeenCalledTimes(1);
    expect(h.observeReadiness.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      devServerUrl: 'http://127.0.0.1:4173/',
    });
  });

  it('persists the understanding and the relevant files, and mirrors the applied modifications', async () => {
    const h = harness();
    await toReady(h);

    const record = h.manager.current();
    expect(record.understanding).toEqual(UNDERSTANDING);
    expect(record.relevantFiles).toEqual(INVESTIGATION.relevantFiles);
    expect(record.modifications.map((entry) => entry.id)).toEqual([MOD_V1.id]);
  });

  it('leaves the run’s group rows to its stages: the orchestrator itself sends none', async () => {
    const h = harness();
    await toReady(h);

    expect(orchestratorRows(h)).toEqual([]);
    expect(h.progressCalls.map((call) => `${call.origin}:${call.method}`)).toEqual([
      'install:readyToCapture',
    ]);
  });
});

describe('run: bookkeeping', () => {
  it('records the prompt versions the stages reported, and the manifest’s for the stages not yet run', async () => {
    const h = harness();

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.promptVersions).toEqual({
      understand: REPORTED.understand,
      investigate: REPORTED.investigate,
      plan: REPORTED.plan,
      analyze: MANIFEST.analyze,
      'generate-panel': MANIFEST['generate-panel'],
      followup: MANIFEST.followup,
    });
    expect(h.manager.current().promptVersions).toEqual(outcome.promptVersions);
    expect(h.promptVersions).toHaveBeenCalledTimes(1);
    expect(membersCalled(h.tripwires.promptLoader)).toEqual(['versions']);
  });

  it('keeps a version the session already recorded rather than resolving the manifest’s current one', async () => {
    const h = harness({ session: { promptVersions: { analyze: 'v001', followup: 'v001' } } });

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome.promptVersions.analyze).toBe('v001');
    expect(outcome.promptVersions.followup).toBe('v001');
  });

  it('leaves plan recording to the plan stage: a retry after a failure records no duplicate plan, row or mirror', async () => {
    const h = harness();
    h.stages.investigate.mockResolvedValueOnce(err(modelUnavailable()));

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(h.manager.recordedPlans.map((plan) => plan.planVersion)).toEqual([1]);
    expect(membersCalled(h.manager.wire).filter((member) => member === 'recordPlan')).toHaveLength(
      h.stages.plan.mock.calls.length,
    );
    expect(membersCalled(h.tripwires.sessionsRepo)).not.toContain('insertPlan');
    expect(failedRows(h)).toHaveLength(1);
    expect(h.manager.patches.filter((patch) => patch.relevantFiles !== undefined)).toHaveLength(1);
    expect(h.manager.current().modifications.map((entry) => entry.id)).toEqual([MOD_V1.id]);
    expect(h.instrumentation.install).toHaveBeenCalledTimes(1);
  });

  it('a retry after a failed install takes the next plan version: the ladder only grows', async () => {
    const h = harness();
    h.instrumentation.install.mockResolvedValueOnce(
      err(
        subsystemError('INSTRUMENTATION_INSTALL_FAILED', 'Nothing could be enabled.', {
          stage: 'instrument',
        }),
      ),
    );

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));
    expect(h.manager.current().status).toBe('failed');
    const retried = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(retried.planVersion).toBe(2);
    expect(h.manager.recordedPlans.map((plan) => plan.planVersion)).toEqual([1, 2]);
    expect(membersCalled(h.manager.wire).filter((member) => member === 'recordPlan')).toHaveLength(
      2,
    );
    expect(membersCalled(h.tripwires.sessionsRepo)).not.toContain('insertPlan');
    expect(failedRows(h)).toHaveLength(1);
    expect(h.manager.current().modifications.map((entry) => entry.id)).toEqual([MOD_V2.id]);
  });

  it('a resumed capture after a failed panel mirrors the analysis and the panel exactly once', async () => {
    const h = harness();
    await toCapturing(h);
    h.stages.generatePanel.mockResolvedValueOnce(err(modelUnavailable()));

    expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
    expect(h.manager.current().analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id]);
    expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    const record = h.manager.current();
    expect(h.stages.complete.mock.calls.at(-1)?.[1]).toEqual({ captureId: CAPTURE_ID });
    expect(record.analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id]);
    expect(record.panelIds).toEqual([PANEL_V1.id]);
    expect(statusesOf(h).filter((status) => status === 'generated')).toHaveLength(1);
    expect(failedRows(h)).toHaveLength(1);
    const captureClosings = orchestratorRows(h).filter(
      (call) => call.stage === 'capture' && call.method === 'stageCompleted',
    );
    expect(captureClosings).toHaveLength(1);
  });

  it('keeps the modifications mirror best-effort: the journal is authoritative, so a refused mirror is logged and the run still reaches ready', async () => {
    const h = harness();
    const refused = recordWriteRefused();
    h.manager.script.refusePatch = (patch) =>
      patch.modifications !== undefined ? refused : undefined;

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(outcome).toMatchObject({ status: 'ready', appliedModifications: 1 });
    expect(transitionRequests(h, 'failed')).toBe(0);
    expect(h.manager.current().modifications).toEqual([]);
    expect(mirrorWarnings(h.records, 'modifications')).toEqual([
      expect.objectContaining({ field: 'modifications', code: 'STORE_ERROR' }),
    ]);
  });

  it('refuses a session that is not startable, and one whose instrumentation is still installed, without moving it', async () => {
    const notStartable = harness({ session: { status: 'ready' } });
    const installed = harness({ session: { status: 'failed' } });
    installed.instrumentation.arming.mockReturnValue({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      activePlanVersion: 1,
      agentHooks: DORMANT_AGENT_HOOK_CONFIG,
      serverSignals: DISABLED_SERVER_AGENT_SIGNALS,
    });

    const first = expectErr(await notStartable.orchestrator.run({ sessionId: SESSION_ID }));
    const second = expectErr(await installed.orchestrator.run({ sessionId: SESSION_ID }));

    expect(first.code).toBe('SESSION_INVALID_STATE');
    expect(second.details?.['reason']).toBe('instrumentation-installed');
    for (const h of [notStartable, installed]) {
      expect(h.manager.wire.calls.filter((call) => call.member === 'transitionTo')).toEqual([]);
      expect(h.stages.understand).not.toHaveBeenCalled();
      expect(h.codeIndex.load).not.toHaveBeenCalled();
    }
  });

  it('retries from failed when nothing is installed, and answers SESSION_NOT_FOUND for an unknown session', async () => {
    const h = harness({ session: { status: 'failed' } });

    const retried = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));
    const unknown = expectErr(await h.orchestrator.run({ sessionId: 'session-unknown' }));

    expect(retried.status).toBe('ready');
    expect(statusesOf(h)[0]).toBe('understanding');
    expect(unknown.code).toBe('SESSION_NOT_FOUND');
  });
});

/* =================================================================================================
 * 3. The failure contract (AAP §0.5.5): a failure is never presented as a successful analysis
 * ============================================================================================== */

/** Anything whose calls can be counted: every `vi.fn` spy of the harness. */
interface CallCounted {
  readonly mock: { readonly calls: readonly unknown[] };
}

/** One stage of the failure matrix. */
interface FailureCase {
  /** The stage the failure must be filed under. */
  readonly stage: ProgressStage;
  /** The failing subsystem's own error. */
  readonly error: () => DebuggenError;
  /** Drives the session to the operation that will fail. */
  readonly arrange: (h: Harness) => Promise<void>;
  /** Scripts the failure and runs the failing operation. */
  readonly fail: (h: Harness, error: DebuggenError) => Promise<Result<unknown, DebuggenError>>;
  /** The collaborators that must not run once the stage has failed. */
  readonly later: (h: Harness) => readonly CallCounted[];
  /** The analyses the failing operation legitimately mirrors: an earlier stage's validated artifact. */
  readonly analysesAdded: readonly string[];
}

/** The sentence the install layer builds for a signal it could not enable, used as an install failure. */
const INSTALL_FAILURE_MESSAGE = DEGRADATIONS[0] ?? 'Could not enable React renders.';

const FAILURE_CASES: readonly FailureCase[] = [
  {
    stage: 'understand',
    error: () => modelUnavailable(),
    arrange: () => Promise.resolve(),
    fail: (h, error) => {
      h.stages.understand.mockResolvedValueOnce(err(error));
      return h.orchestrator.run({ sessionId: SESSION_ID });
    },
    later: (h) => [h.stages.investigate, h.stages.plan, h.instrumentation.install],
    analysesAdded: [],
  },
  {
    stage: 'investigate',
    error: () => modelUnavailable(),
    arrange: () => Promise.resolve(),
    fail: (h, error) => {
      h.stages.investigate.mockResolvedValueOnce(err(error));
      return h.orchestrator.run({ sessionId: SESSION_ID });
    },
    later: (h) => [h.stages.plan, h.instrumentation.install],
    analysesAdded: [],
  },
  {
    stage: 'plan',
    error: () => modelUnavailable('plan'),
    arrange: () => Promise.resolve(),
    fail: (h, error) => {
      h.stages.plan.mockResolvedValueOnce(err(error));
      return h.orchestrator.run({ sessionId: SESSION_ID });
    },
    later: (h) => [h.instrumentation.install, h.stages.arm],
    analysesAdded: [],
  },
  {
    stage: 'instrument',
    error: () =>
      subsystemError('INSTRUMENTATION_INSTALL_FAILED', INSTALL_FAILURE_MESSAGE, {
        hint: 'Relaunch the dev server from Debug Generator, then start the session again.',
        stage: 'instrument',
      }),
    arrange: () => Promise.resolve(),
    fail: (h, error) => {
      h.instrumentation.install.mockResolvedValueOnce(err(error));
      return h.orchestrator.run({ sessionId: SESSION_ID });
    },
    later: (h) => [h.stages.arm, h.stages.complete],
    analysesAdded: [],
  },
  {
    stage: 'capture',
    error: () =>
      subsystemError('STORE_ERROR', 'The capture could not be summarised from the store.', {
        hint: 'Capture again.',
      }),
    arrange: toCapturing,
    fail: (h, error) => {
      h.stages.complete.mockResolvedValueOnce(err(error));
      return h.orchestrator.completeCapture({ sessionId: SESSION_ID });
    },
    later: (h) => [h.stages.analyze, h.stages.generatePanel],
    analysesAdded: [],
  },
  {
    stage: 'analyze',
    error: () => modelUnavailable(),
    arrange: toCapturing,
    fail: (h, error) => {
      h.stages.analyze.mockResolvedValueOnce(err(error));
      return h.orchestrator.completeCapture({ sessionId: SESSION_ID });
    },
    later: (h) => [h.stages.generatePanel, h.panelGenerator.generate],
    analysesAdded: [],
  },
  {
    stage: 'generate-panel',
    error: () => modelUnavailable(),
    arrange: toCapturing,
    fail: (h, error) => {
      h.stages.generatePanel.mockResolvedValueOnce(err(error));
      return h.orchestrator.completeCapture({ sessionId: SESSION_ID });
    },
    later: (h) => [h.panelGenerator.generate, h.panelGenerator.regenerate],
    analysesAdded: [analysisOf(1).id],
  },
  {
    stage: 'followup',
    error: () => modelUnavailable('followup'),
    arrange: toGenerated,
    fail: (h, error) => {
      h.stages.followUp.mockResolvedValueOnce(err(error));
      return h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why did it run twice?',
      });
    },
    later: (h) => [h.panelGenerator.regenerate, h.stages.analyze, h.stages.generatePanel],
    analysesAdded: [],
  },
];

describe('failure contract', () => {
  it('covers every stage of the pipeline that can fail', () => {
    expect(FAILURE_CASES.map((entry) => entry.stage)).toEqual([...PIPELINE_STAGE_ORDER]);
  });

  it.each(FAILURE_CASES)(
    'files a $stage failure exactly once, unchanged, and never reaches generated',
    async (entry) => {
      const h = harness();
      await entry.arrange(h);
      const scripted = entry.error();
      const laterSpies = entry.later(h);
      const laterCounts = laterSpies.map((spy) => spy.mock.calls.length);
      const before = {
        transitions: h.manager.transitions.length,
        requests: h.manager.wire.calls.length,
        rows: h.progressCalls.length,
        panelIds: [...h.manager.current().panelIds],
        analyses: h.manager.current().analyses.map((analysis) => analysis.id),
      };

      const returned = await entry.fail(h, scripted);

      // The same Err: code preserved from the stage, message and hint not rewritten.
      const error = expectErr(returned);
      expect(error).toBe(scripted);
      const expectedFailure: SessionFailure = {
        stage: entry.stage,
        code: scripted.code,
        message: scripted.message,
        ...(scripted.hint !== undefined ? { hint: scripted.hint } : {}),
      };

      // Exactly one transition to failed, carrying the stage's SessionFailure.
      const requested = h.manager.wire.calls
        .slice(before.requests)
        .filter((call) => call.member === 'transitionTo');
      expect(requested.filter((call) => call.args[1] === 'failed')).toEqual([
        { member: 'transitionTo', args: [SESSION_ID, 'failed', { failure: expectedFailure }] },
      ]);
      expect(requested.map((call) => call.args[1])).not.toContain('generated');
      expect(h.manager.current().status).toBe('failed');

      // One failed row — the manager's, written with the transition.
      const rows = h.progressCalls
        .slice(before.rows)
        .filter((call) => call.method === 'stageFailed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        origin: 'manager',
        stage: entry.stage,
        failure: expectedFailure,
      });

      // Nothing downstream ran; no panel was produced; the orchestrator touched no artifact store.
      expect(laterSpies.map((spy) => spy.mock.calls.length)).toEqual(laterCounts);
      expect(h.manager.current().panelIds).toEqual(before.panelIds);
      expect(h.manager.current().analyses.map((analysis) => analysis.id)).toEqual([
        ...before.analyses,
        ...entry.analysesAdded,
      ]);
      expect(h.tripwires.panelsRepo.calls).toEqual([]);
      expect(h.tripwires.telemetryRepo.calls).toEqual([]);
    },
  );

  it('files the provider’s own AAP §0.5.5 sentence verbatim — the orchestrator authors no failure prose', async () => {
    const h = harness();
    const unavailable = modelUnavailable();
    h.stages.understand.mockResolvedValueOnce(err(unavailable));

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(failuresOf(h)).toEqual([
      {
        stage: 'understand',
        code: 'MODEL_UNAVAILABLE',
        message: modelUnavailableMessage('MODEL_UNAVAILABLE'),
        hint: unavailable.hint,
      },
    ]);
    expect(failedRows(h).map((row) => row.message)).toEqual([
      modelUnavailableMessage('MODEL_UNAVAILABLE'),
    ]);
  });

  it('files the install layer’s degradation sentence verbatim when nothing could be enabled', async () => {
    const h = harness();
    const failure = subsystemError('INSTRUMENTATION_INSTALL_FAILED', INSTALL_FAILURE_MESSAGE, {
      stage: 'instrument',
    });
    h.instrumentation.install.mockResolvedValueOnce(err(failure));

    expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(failuresOf(h)).toEqual([
      {
        stage: 'instrument',
        code: 'INSTRUMENTATION_INSTALL_FAILED',
        message: INSTALL_FAILURE_MESSAGE,
      },
    ]);
    expect(failedRows(h).map((row) => row.message)).toEqual([INSTALL_FAILURE_MESSAGE]);
    expect(INSTALL_FAILURE_MESSAGE).toMatch(/^Could not enable /);
  });

  it('files a stage that broke its never-throw contract as a failure of that stage', async () => {
    const h = harness();
    h.stages.investigate.mockRejectedValueOnce(new Error('collaborator exploded'));

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error.code).toBe('INTERNAL');
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['investigate']);
    expect(h.stages.plan).not.toHaveBeenCalled();
  });

  it('degrades rather than fails: unavailable signals still reach ready, one degradation row per signal', async () => {
    const h = harness({
      script: { install: { unavailable: UNAVAILABLE, degradations: DEGRADATIONS } },
    });

    const outcome = expectOk(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(DEGRADATIONS).toHaveLength(UNAVAILABLE.length);
    expect(outcome.status).toBe('ready');
    expect(outcome.degradations).toEqual(DEGRADATIONS);
    expect(outcome.readiness.degraded).toEqual(UNAVAILABLE);
    for (const sentence of DEGRADATIONS) {
      const rows = h.progressCalls.filter((call) => call.message === sentence);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe('install');
    }
    expect(transitionRequests(h, 'failed')).toBe(0);
    expect(orchestratorRows(h)).toEqual([]);
  });
});

describe('failure contract: generated needs both validated artifacts', () => {
  it('asks for analyzing → generated once, after both stages, with the analysis and the panel in hand', async () => {
    const h = harness();
    await toCapturing(h);

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(transitionRequests(h, 'generated')).toBe(1);
    const generated = h.manager.transitions.find((entry) => entry.to === 'generated');
    expect(generated?.from).toBe('analyzing');
    expect(generated?.context?.analysis).toEqual(analysisOf(1));
    expect(generated?.context?.panel).toEqual(PANEL_V1);
    expectInOrder(h.timeline, ['stage:analyze', 'stage:generatePanel', 'transition:generated']);
    expect(result).toMatchObject({
      captureId: CAPTURE_ID,
      emptyCapture: false,
      panelId: PANEL_V1.id,
      panelVersion: 1,
      fallback: false,
      promptVersionsRecorded: true,
    });
    expect(result.analysis).toEqual(analysisOf(1));
  });

  it('counts a fallback panel as validated: it reaches generated and the flag travels on', async () => {
    const h = harness({ script: { fallbackPanel: true } });

    await toCapturing(h);
    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(result.fallback).toBe(true);
    expect(h.manager.current().status).toBe('generated');
    const generated = h.manager.transitions.find((entry) => entry.to === 'generated');
    expect(generated?.context?.panel?.meta?.fallback).toBe(true);
    expect(generated?.context?.analysis).toEqual(analysisOf(1));
    expect(transitionRequests(h, 'failed')).toBe(0);
  });

  it('passes the capture, its understanding and its analysis to Stages 5 and 6, and mirrors both artifacts', async () => {
    const h = harness();
    await toGenerated(h);

    const [analyzeContext, analyzeInput] = h.stages.analyze.mock.calls[0] ?? [];
    expect(analyzeContext?.captureId).toBe(CAPTURE_ID);
    expect(analyzeInput).toEqual({ captureId: CAPTURE_ID, understanding: UNDERSTANDING });
    const [panelContext, panelInput] = h.stages.generatePanel.mock.calls[0] ?? [];
    expect(panelContext?.captureId).toBe(CAPTURE_ID);
    expect(panelInput).toEqual({
      captureId: CAPTURE_ID,
      analysis: analysisOf(1),
      summary: EVIDENCE_SUMMARY,
    });
    const record = h.manager.current();
    expect(record.analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id]);
    expect(record.panelIds).toEqual([PANEL_V1.id]);
    expect(record.promptVersions).toMatchObject({
      analyze: REPORTED.analyze,
      'generate-panel': REPORTED['generate-panel'],
    });
  });

  it('files a capture analysed without a recorded understanding under analyze, and never generates', async () => {
    const h = harness({
      session: {
        status: 'capturing',
        plans: [PLAN_V1],
        captures: [{ id: CAPTURE_ID, planVersion: 1, startedAt: FIXED_EPOCH_MS }],
      },
    });

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error.details?.['reason']).toBe('missing-understanding');
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['analyze']);
    expect(h.stages.analyze).not.toHaveBeenCalled();
    expect(transitionRequests(h, 'generated')).toBe(0);
  });

  it('files an analysis the session record could not keep under analyze: Stage 6 never runs and generated is never asked for', async () => {
    const h = harness();
    await toCapturing(h);
    const refused = recordWriteRefused();
    h.manager.script.refusePatch = (patch) => (patch.analyses !== undefined ? refused : undefined);

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refused);
    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h)).toEqual([
      { stage: 'analyze', code: 'STORE_ERROR', message: refused.message },
    ]);
    expect(failedRows(h)).toHaveLength(1);
    expect(transitionRequests(h, 'generated')).toBe(0);
    expect(h.stages.generatePanel).not.toHaveBeenCalled();
    expect(h.manager.current().analyses).toEqual([]);
    expect(h.manager.current().panelIds).toEqual([]);
    expect(mirrorWarnings(h.records, 'analyses')).toEqual([
      expect.objectContaining({ field: 'analyses', code: 'STORE_ERROR' }),
    ]);

    // The retry path of AAP §0.5.5: once the store keeps the record again, the
    // stopped capture resumes and both artifacts reach the record exactly once.
    h.manager.script.refusePatch = undefined;
    expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(h.manager.current().status).toBe('generated');
    expect(h.manager.current().analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id]);
    expect(h.manager.current().panelIds).toEqual([PANEL_V1.id]);
    expect(transitionRequests(h, 'generated')).toBe(1);
  });

  it('files a panel the session record could not keep under generate-panel, and never generates', async () => {
    const h = harness();
    await toCapturing(h);
    const refused = recordWriteRefused();
    h.manager.script.refusePatch = (patch) => (patch.panelIds !== undefined ? refused : undefined);

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refused);
    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h)).toEqual([
      { stage: 'generate-panel', code: 'STORE_ERROR', message: refused.message },
    ]);
    expect(failedRows(h)).toHaveLength(1);
    expect(transitionRequests(h, 'generated')).toBe(0);
    expect(h.stages.generatePanel).toHaveBeenCalledTimes(1);
    expect(h.manager.current().analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id]);
    expect(h.manager.current().panelIds).toEqual([]);
    expect(mirrorWarnings(h.records, 'panelIds')).toEqual([
      expect.objectContaining({ field: 'panelIds', code: 'STORE_ERROR' }),
    ]);
  });
});

/* =================================================================================================
 * 4. The capture window — beginCapture and completeCapture
 * ============================================================================================== */

describe('capture', () => {
  it('opens the capture group only after the stage opened and armed the window', async () => {
    const h = harness();
    await toReady(h);
    const requestsBefore = transitionRequests(h, 'capturing');

    const armed = expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(armed).toEqual({
      captureId: CAPTURE_ID,
      planVersion: 1,
      readinessSource: 'supplied',
      degradations: [],
    });
    expect(h.manager.current().status).toBe('capturing');
    expect(h.stages.arm.mock.calls[0]?.[1]).toEqual({ readiness: verdict(true) });
    expectInOrder(h.timeline, [
      'stage:arm',
      'startCapture',
      'armCapture',
      'row:stageStarted:capture',
    ]);
    expect(orchestratorRows(h)).toEqual([
      {
        method: 'stageStarted',
        origin: 'orchestrator',
        stage: 'capture',
        status: 'running',
        message: undefined,
        failure: undefined,
      },
    ]);
    // The window was opened by the stage through the manager, not by a transition of the orchestrator's.
    expect(transitionRequests(h, 'capturing')).toBe(requestsBefore);
  });

  it('brackets Stages 4–6 with its own boundary rows around each stage call', async () => {
    const h = harness();
    await toGenerated(h);

    expectInOrder(h.timeline, [
      'stage:complete',
      'stopCapture:analyzing',
      'row:stageCompleted:capture',
      'row:stageStarted:analyze',
      'stage:analyze',
      'row:stageCompleted:analyze',
      'row:stageStarted:generate-panel',
      'stage:generatePanel',
      'row:stageCompleted:generate-panel',
      'transition:generated',
    ]);
    expect(orchestratorRows(h).map((call) => `${call.method}:${call.stage ?? '-'}`)).toEqual([
      'stageStarted:capture',
      'stageCompleted:capture',
      'stageStarted:analyze',
      'stageCompleted:analyze',
      'stageStarted:generate-panel',
      'stageCompleted:generate-panel',
    ]);
  });

  it('never authors display text: it sends stage boundaries only, leaving titles to the emitter', async () => {
    const h = harness();
    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );
    h.script.followUpPath = 'new-capture';
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why again?',
      }),
    );

    const own = orchestratorRows(h);
    expect(own.length).toBeGreaterThan(0);
    expect([...new Set(own.map((call) => call.method))].sort()).toEqual([
      'stageCompleted',
      'stageStarted',
    ]);
    for (const call of own) {
      expect(call.message).toBeUndefined();
    }
    // Findings, reports and the ready row reach the developer from the stages and the gate only.
    const reportMethods: readonly (keyof SessionProgress)[] = [
      'emit',
      'finding',
      'reportInvestigation',
      'reportInstrumentation',
      'readyToCapture',
    ];
    expect(own.filter((call) => reportMethods.includes(call.method))).toEqual([]);
    expect(
      h.progressCalls.filter((call) => call.method === 'readyToCapture').map((call) => call.origin),
    ).toEqual(['install', 'install']);
  });

  it.each([
    { condition: 'no event at all', emptiness: NO_EVENTS, summary: EMPTY_SUMMARY },
    {
      condition: 'no browser interaction for an interaction question',
      emptiness: NO_INTERACTION,
      summary: EVIDENCE_SUMMARY,
    },
  ])(
    'treats a capture with $condition as empty: analysis skipped, back to ready, never failed',
    async ({ emptiness, summary }) => {
      const h = harness({ script: { emptiness, summary } });
      expect(UNDERSTANDING.signalsNeeded).toContain(INTERACTION_SIGNAL);
      await toCapturing(h);
      const loadsBefore = h.codeIndex.load.mock.calls.length;
      const callsBefore = h.manager.wire.calls.length;

      const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

      expect(result).toEqual({ captureId: CAPTURE_ID, summary, emptyCapture: true });
      expect(h.manager.current().status).toBe('ready');
      const during = h.manager.wire.calls.slice(callsBefore);
      expect(during.filter((call) => call.member === 'stopCapture')).toEqual([
        { member: 'stopCapture', args: [SESSION_ID, { summary, next: 'ready' }] },
      ]);
      expect(during.filter((call) => call.member === 'transitionTo')).toEqual([]);
      expect(h.stages.analyze).not.toHaveBeenCalled();
      expect(h.stages.generatePanel).not.toHaveBeenCalled();
      expect(h.codeIndex.load.mock.calls.length).toBe(loadsBefore);
      expect(transitionRequests(h, 'failed')).toBe(0);
      expect(failedRows(h)).toEqual([]);
      expect(orchestratorRows(h).at(-1)).toMatchObject({
        method: 'stageCompleted',
        stage: 'capture',
        message: EMPTY_CAPTURE_MESSAGE,
      });
      expect(h.manager.current().analyses).toEqual([]);
      expect(h.manager.current().panelIds).toEqual([]);
    },
  );

  it('sends an interaction question captured with the interaction hook off back to ready, never to generated', async () => {
    // The faked stage reports the real rule's verdict: the pure classifier over
    // a capture that recorded requests only, armed — like every fake completion
    // here — with the dormant hooks, so the interaction hook was off. Before
    // AAP §0.5.5 was enforced independently of the hook, this capture was
    // "evidence" and the run reached `generated` without a reproduction.
    const requestsOnly = {
      eventCount: EVIDENCE_SUMMARY.eventCount,
      kindCounts: { ...EVIDENCE_SUMMARY.kindCounts, fetch: EVIDENCE_SUMMARY.eventCount },
    };
    const emptiness = classifyCaptureEmptiness(requestsOnly, UNDERSTANDING, {
      agentHooks: DORMANT_AGENT_HOOK_CONFIG,
    });
    expect(emptiness).toMatchObject({
      empty: true,
      reason: 'no-interaction',
      interactionRequired: true,
      interactionHookArmed: false,
    });
    const h = harness({ script: { emptiness, summary: EVIDENCE_SUMMARY } });
    await toCapturing(h);

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(result).toEqual({
      captureId: CAPTURE_ID,
      summary: EVIDENCE_SUMMARY,
      emptyCapture: true,
    });
    expect(h.manager.current().status).toBe('ready');
    expect(statusesOf(h)).not.toContain('analyzing');
    expect(statusesOf(h)).not.toContain('generated');
    expect(h.stages.analyze).not.toHaveBeenCalled();
    expect(h.stages.generatePanel).not.toHaveBeenCalled();
    expect(failedRows(h)).toEqual([]);
    expect(orchestratorRows(h).at(-1)).toMatchObject({
      method: 'stageCompleted',
      stage: 'capture',
      message: EMPTY_CAPTURE_MESSAGE,
    });
  });

  it('returns a capture conflict unchanged — owningSessionId intact for the 409 — and arms nothing', async () => {
    const h = harness();
    await toReady(h);
    const conflict = new DebuggenError(
      'CAPTURE_ALREADY_ACTIVE',
      'Another session is capturing this project.',
      { details: { owningSessionId: 'session-other-owner' } },
    );
    h.manager.script.startCaptureError = conflict;

    const error = expectErr(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(conflict);
    expect(error.details?.['owningSessionId']).toBe('session-other-owner');
    expect(h.instrumentation.armCapture).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('ready');
    expect(transitionRequests(h, 'failed')).toBe(0);
    expect(failedRows(h)).toEqual([]);
    expect(orchestratorRows(h)).toEqual([]);
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
  });

  it('re-gates an instrumenting session through evaluateReadiness and asks for ready with its verdict', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ script: { install: { satisfied: false } }, evaluateReadiness });
    await toReady(h);
    expect(h.manager.current().status).toBe('instrumenting');

    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateReadiness.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      plan: PLAN_V1,
    });
    expect(membersCalled(h.tripwires.sessionsRepo)).toEqual(['latestPlanVersion', 'getPlan']);
    const asked = h.manager.wire.calls.filter(
      (call) => call.member === 'transitionTo' && call.args[1] === 'ready',
    );
    expect(asked.map((call) => call.args[2])).toEqual([{ readinessSatisfied: true }]);
    expect(h.stages.arm.mock.calls[0]?.[1]).toEqual({ readiness: verdict(true) });
    expect(statusesOf(h).at(-1)).toBe('ready');
    expectInOrder(h.timeline, ['transition:ready', 'stage:arm', 'startCapture']);
    expect(h.manager.current().status).toBe('capturing');
  });

  it('asks for ready with an unsatisfied verdict, returns the refusal unchanged and arms nothing', async () => {
    const h = harness({ script: { install: { satisfied: false } } });
    await toReady(h);
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'Readiness is not satisfied yet.', {
      details: { reason: 'readiness-unsatisfied' },
    });
    h.manager.script.refuseTransition = (_from, to, context) =>
      to === 'ready' && context?.readinessSatisfied !== true ? refusal : undefined;

    const error = expectErr(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refusal);
    const asked = h.manager.wire.calls.filter(
      (call) => call.member === 'transitionTo' && call.args[1] === 'ready',
    );
    expect(asked.map((call) => call.args[2])).toEqual([{ readinessSatisfied: false }]);
    expect(h.stages.arm).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('instrumenting');
    expect(transitionRequests(h, 'failed')).toBe(0);
  });

  it('returns a refusal to complete a capture that is not running without changing anything', async () => {
    const h = harness({ session: { status: 'ready' } });
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'No capture is running.', {
      details: { reason: 'no-active-capture' },
    });
    h.stages.complete.mockResolvedValueOnce(err(refusal));

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refusal);
    expect(h.manager.wire.calls.filter((call) => call.member === 'transitionTo')).toEqual([]);
    expect(failedRows(h)).toEqual([]);
    expect(orchestratorRows(h)).toEqual([]);
    expect(h.instrumentation.armCapture).not.toHaveBeenCalled();
  });

  it('arms the producers of a window left open again when the store refuses both its stop and the move to failed', async () => {
    const h = harness();
    await toCapturing(h);
    const refused = new DebuggenError(
      'STORE_ERROR',
      'The session store could not complete an operation.',
      { details: { reason: 'store-failed' } },
    );
    h.manager.script.stopCaptureError = refused;
    h.manager.script.refuseTransition = (_from, to) => (to === 'failed' ? refused : undefined);
    const armsBefore = h.instrumentation.armCapture.mock.calls.length;
    const timelineMark = h.timeline.length;

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    // The failure the operation reports is the store's, unchanged, and nothing moved.
    expect(error).toBe(refused);
    const record = h.manager.current();
    expect(record.status).toBe('capturing');
    expect(record.captures.at(-1)).toMatchObject({ id: CAPTURE_ID, planVersion: 1 });
    expect(record.captures.at(-1)?.stoppedAt).toBeUndefined();
    expect(transitionRequests(h, 'failed')).toBe(1);
    expect(transitionRequests(h, 'generated')).toBe(0);
    expect(h.stages.analyze).not.toHaveBeenCalled();

    // Disarmed for the stop, then armed again for the same, still-open window.
    expect(h.instrumentation.armCapture.mock.calls.slice(armsBefore)).toEqual([
      [
        {
          sessionId: SESSION_ID,
          captureId: CAPTURE_ID,
          projectRoot: PROJECT_ROOT,
          plan: record.plans.find((plan) => plan.planVersion === 1),
        },
      ],
    ]);
    expectInOrder(h.timeline.slice(timelineMark), [
      'stage:complete',
      'disarmCapture',
      'stopCapture:analyzing',
      'transition:failed',
      'armCapture',
    ]);
    expect(
      h.records.filter(
        (entry) =>
          entry.level === 'info' &&
          entry.message.includes('producers were armed again') &&
          entry.fields['captureId'] === CAPTURE_ID,
      ),
    ).toHaveLength(1);
  });

  it('arms nothing when the stop is refused but the move to failed closes the window', async () => {
    const h = harness();
    await toCapturing(h);
    h.manager.script.stopCaptureError = new DebuggenError(
      'STORE_ERROR',
      'The session store could not complete an operation.',
    );
    const armsBefore = h.instrumentation.armCapture.mock.calls.length;

    expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['capture']);
    expect(h.instrumentation.armCapture.mock.calls.slice(armsBefore)).toEqual([]);
  });

  it('logs a re-arm the instrumentation layer refuses and still reports the original failure', async () => {
    const h = harness();
    await toCapturing(h);
    const refused = new DebuggenError(
      'STORE_ERROR',
      'The session store could not complete an operation.',
    );
    h.manager.script.stopCaptureError = refused;
    h.manager.script.refuseTransition = (_from, to) => (to === 'failed' ? refused : undefined);
    h.instrumentation.armCapture.mockReturnValueOnce(
      err(new DebuggenError('TRANSPORT_DISCONNECTED', 'The page agent could not be armed.')),
    );

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error).toBe(refused);
    expect(h.manager.current().status).toBe('capturing');
    expect(
      h.records.filter(
        (entry) =>
          entry.level === 'warn' &&
          entry.message.includes('could not be armed again') &&
          entry.fields['code'] === 'TRANSPORT_DISCONNECTED',
      ),
    ).toHaveLength(1);
  });

  it('resumes the stored capture of a session left failed after analysis, without closing it again', async () => {
    const h = harness();
    await toCapturing(h);
    h.stages.analyze.mockResolvedValueOnce(err(modelUnavailable()));
    expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));
    expect(h.manager.current().status).toBe('failed');
    const stopsBefore = h.manager.wire.calls.filter((call) => call.member === 'stopCapture').length;

    const result = expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(h.stages.complete.mock.calls.at(-1)?.[1]).toEqual({ captureId: CAPTURE_ID });
    expect(h.manager.wire.calls.filter((call) => call.member === 'stopCapture')).toHaveLength(
      stopsBefore,
    );
    expect(result.panelId).toBe(PANEL_V1.id);
    expect(statusesOf(h).slice(-2)).toEqual(['analyzing', 'generated']);
  });
});

/* =================================================================================================
 * 5. Follow-ups — AAP §0.4.2's two paths
 * ============================================================================================== */

describe('followUp', () => {
  it('existing-evidence: generated → analyzing → generated, new versions superseding the previous ones', async () => {
    const h = harness();
    await toGenerated(h);
    const before = {
      transitions: h.manager.transitions.length,
      installs: h.instrumentation.install.mock.calls.length,
      arms: h.stages.arm.mock.calls.length,
      completes: h.stages.complete.mock.calls.length,
      analyses: h.stages.analyze.mock.calls.length,
      panels: h.stages.generatePanel.mock.calls.length,
    };

    const outcome = expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: `Why did it run twice ${SENTINELS.followUp}?`,
      }),
    );

    expect(outcome).toMatchObject({
      path: 'existing-evidence',
      status: 'generated',
      panelId: panelOf(2).id,
      panelVersion: 2,
      supersedes: PANEL_V1.id,
      fallback: false,
      promptVersionsRecorded: true,
    });
    expect(outcome.analysis).toEqual(analysisOf(2));
    expect(outcome.analysis?.supersedes).toBe(analysisOf(1).id);
    const moved = h.manager.transitions.slice(before.transitions);
    expect(moved.map((entry) => `${entry.from}→${entry.to}`)).toEqual([
      'generated→analyzing',
      'analyzing→generated',
    ]);
    expect(moved.at(-1)?.context?.analysis).toEqual(analysisOf(2));
    expect(moved.at(-1)?.context?.panel).toEqual(panelOf(2));
    expect(h.panelGenerator.regenerate).toHaveBeenCalledTimes(1);
    expect(h.panelGenerator.generate).not.toHaveBeenCalled();
    // No file touched, no capture opened, and neither Stage 5 nor Stage 6 run again from here.
    expect(h.instrumentation.install.mock.calls.length).toBe(before.installs);
    expect(h.stages.arm.mock.calls.length).toBe(before.arms);
    expect(h.stages.complete.mock.calls.length).toBe(before.completes);
    expect(h.stages.analyze.mock.calls.length).toBe(before.analyses);
    expect(h.stages.generatePanel.mock.calls.length).toBe(before.panels);
    const record = h.manager.current();
    expect(record.analyses.map((entry) => entry.id)).toEqual([analysisOf(1).id, analysisOf(2).id]);
    expect(record.panelIds).toEqual([PANEL_V1.id, panelOf(2).id]);
    expect(record.promptVersions).toMatchObject({
      analyze: REGENERATED.analyze,
      'generate-panel': REGENERATED['generate-panel'],
      followup: MANIFEST.followup,
    });
  });

  it('passes the follow-up question to the stage untouched and reuses the run’s handles unrefreshed', async () => {
    const h = harness();
    await toGenerated(h);
    const question = `Why did it run twice ${SENTINELS.followUp}?`;
    const attemptId = nextAttemptId();

    expectOk(await h.orchestrator.followUp({ sessionId: SESSION_ID, attemptId, question }));

    const [context, input] = h.stages.followUp.mock.calls[0] ?? [];
    expect(input?.followUpQuestion).toBe(question);
    // The attempt id reaches the stage — and through it the manager — untouched.
    expect(input?.attemptId).toBe(attemptId);
    expect(h.manager.followUpAttemptIds).toEqual([attemptId]);
    expect(context?.followUpQuestion).toBe(question);
    expect(context?.question).toBe(h.manager.current().question);
    expect(context?.code).toBe(h.code);
    expect(h.codeIndex.load.mock.calls.at(-1)?.[1]).toMatchObject({ refresh: false });
    expect(typeof input?.onPathChosen).toBe('function');
    expect(typeof input?.beforeInstall).toBe('function');
  });

  it('keeps a follow-up on the recorded, superseded prompt version rather than resolving the current one', async () => {
    const h = harness({ session: { promptVersions: { followup: 'v001' } } });
    await toGenerated(h);
    const manifestReads = h.promptVersions.mock.calls.length;

    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );

    expect(MANIFEST.followup).not.toBe('v001');
    expect(manifestReads).toBe(1);
    expect(h.promptVersions.mock.calls.length).toBe(manifestReads);
    expect(h.stages.followUp.mock.calls[0]?.[0].promptVersions.followup).toBe('v001');
    expect(h.manager.current().promptVersions.followup).toBe('v001');
    expect(membersCalled(h.tripwires.promptLoader)).toEqual(['versions']);
  });

  it.each([{ needsNewCapture: true }, { needsNewCapture: false }])(
    'new-capture (needsNewCapture: $needsNewCapture, one additive action): generated → planning → instrumenting → ready at plan version n + 1',
    async ({ needsNewCapture }) => {
      const h = harness();
      await toGenerated(h);
      h.script.followUpPath = 'new-capture';
      h.script.needsNewCapture = needsNewCapture;
      const before = {
        transitions: h.manager.transitions.length,
        installs: h.instrumentation.install.mock.calls.length,
        rows: h.progressCalls.length,
        analyses: h.stages.analyze.mock.calls.length,
        arms: h.stages.arm.mock.calls.length,
      };

      const outcome = expectOk(
        await h.orchestrator.followUp({
          sessionId: SESSION_ID,
          attemptId: nextAttemptId(),
          question: 'Why again?',
        }),
      );

      expect(outcome).toMatchObject({
        path: 'new-capture',
        status: 'ready',
        planVersion: 2,
        ready: true,
        promptVersionsRecorded: true,
      });
      const moved = h.manager.transitions.slice(before.transitions);
      expect(moved.map((entry) => `${entry.from}→${entry.to}`)).toEqual([
        'generated→planning',
        'planning→instrumenting',
        'instrumenting→ready',
      ]);
      expect(moved.at(-1)?.context).toEqual({ readinessSatisfied: true });

      // Plan version n + 1: every earlier action, unchanged, plus the additive delta — nothing removed or re-scoped.
      const record = h.manager.current();
      expect(record.plans.map((plan) => plan.planVersion)).toEqual([1, 2]);
      const [previous, next] = record.plans;
      expect(
        next?.instrumentationTargets.slice(0, previous?.instrumentationTargets.length),
      ).toEqual(previous?.instrumentationTargets);
      expect(next?.instrumentationTargets.slice(previous?.instrumentationTargets.length)).toEqual([
        DELTA_ACTION,
      ]);

      // One install, of the delta over the installed version; only its records are mirrored.
      expect(h.instrumentation.install.mock.calls.length).toBe(before.installs + 1);
      const request = h.instrumentation.install.mock.calls.at(-1)?.[0];
      expect(request?.previousPlanVersion).toBe(1);
      const installedIds = new Set(request?.previousActions?.map((action) => action.id));
      expect(
        request?.plan.instrumentationTargets
          .filter((action) => !installedIds.has(action.id))
          .map((action) => action.id),
      ).toEqual([DELTA_ACTION.id]);
      expect(record.modifications.map((entry) => entry.id)).toEqual([MOD_V1.id, MOD_V2.id]);

      // "Ready to capture" once more — the gate's row, not a second one of the orchestrator's.
      const rows = h.progressCalls.slice(before.rows);
      expect(rows.filter((call) => call.method === 'readyToCapture')).toHaveLength(1);
      expect(rows.filter((call) => call.origin === 'orchestrator')).toEqual([]);
      expect(h.stages.analyze.mock.calls.length).toBe(before.analyses);
      expect(h.stages.arm.mock.calls.length).toBe(before.arms);
      expect(h.panelGenerator.regenerate).not.toHaveBeenCalled();
    },
  );

  it('a failed delta install stays at the previous plan version and takes the failure path', async () => {
    const h = harness();
    await toGenerated(h);
    h.script.followUpPath = 'new-capture';
    const failure = new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      'The follow-up’s additional instrumentation could not be installed.',
      {
        hint: 'Ask the follow-up again.',
        details: { stage: 'instrument', activePlanVersion: 1 },
      },
    );
    h.instrumentation.install.mockResolvedValueOnce(err(failure));
    const transitionsBefore = h.manager.transitions.length;

    const error = expectErr(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why again?',
      }),
    );

    expect(error).toBe(failure);
    expect(h.manager.transitions.slice(transitionsBefore).map((entry) => entry.to)).toEqual([
      'planning',
      'instrumenting',
      'failed',
    ]);
    expect(failuresOf(h)).toEqual([
      {
        stage: 'instrument',
        code: 'INSTRUMENTATION_INSTALL_FAILED',
        message: failure.message,
        hint: failure.hint,
      },
    ]);
    // No plan-version advance is persisted, by the stage or by the orchestrator.
    expect(h.manager.recordedPlans.map((plan) => plan.planVersion)).toEqual([1]);
    expect(h.manager.current().plans.map((plan) => plan.planVersion)).toEqual([1]);
    expect(membersCalled(h.tripwires.sessionsRepo)).not.toContain('insertPlan');
    expect(h.manager.current().modifications.map((entry) => entry.id)).toEqual([MOD_V1.id]);
    expect(transitionRequests(h, 'ready')).toBe(1);
    expect(failedRows(h)).toHaveLength(1);
  });

  it('refuses a follow-up on a session neither path can start from, without calling the stage', async () => {
    const h = harness({ session: { status: 'ready' } });

    const error = expectErr(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why?',
      }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(h.stages.followUp).not.toHaveBeenCalled();
    expect(h.codeIndex.load).not.toHaveBeenCalled();
    expect(h.manager.wire.calls.filter((call) => call.member === 'transitionTo')).toEqual([]);
  });

  it.each([
    {
      kind: 'already answered',
      reason: 'follow-up-attempt-answered',
      ladder: (attemptId: string): SessionRecord['followUps'] => [
        {
          question: 'Why twice?',
          askedAt: FIXED_EPOCH_MS,
          attemptId,
          attempt: 1,
          needsNewCapture: false,
        },
      ],
    },
    {
      kind: 'followed by a later follow-up',
      reason: 'follow-up-attempt-superseded',
      ladder: (attemptId: string): SessionRecord['followUps'] => [
        { question: 'Why twice?', askedAt: FIXED_EPOCH_MS, attemptId, attempt: 1 },
        {
          question: 'Why again?',
          askedAt: FIXED_EPOCH_MS + 1,
          attemptId: nextAttemptId(),
          attempt: 1,
        },
      ],
    },
  ])(
    'refuses an attempt $kind before any stage, progress row or status change',
    async ({ reason, ladder }) => {
      const attemptId = nextAttemptId();
      const h = harness({ session: { status: 'failed', followUps: ladder(attemptId) } });

      const error = expectErr(
        await h.orchestrator.followUp({ sessionId: SESSION_ID, attemptId, question: 'Why twice?' }),
      );

      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details?.['reason']).toBe(reason);
      // A duplicate runs nothing and files nothing: the session is as it was.
      expect(h.stages.followUp).not.toHaveBeenCalled();
      expect(h.codeIndex.load).not.toHaveBeenCalled();
      expect(h.manager.followUpAttemptIds).toEqual([]);
      expect(h.manager.wire.calls.filter((call) => call.member === 'transitionTo')).toEqual([]);
      expect(failedRows(h)).toEqual([]);
      expect(h.manager.current().status).toBe('failed');
    },
  );

  it('admits a retry of the latest unanswered attempt and hands the stage its own id', async () => {
    const attemptId = nextAttemptId();
    const h = harness({
      session: {
        followUps: [{ question: 'Why twice?', askedAt: FIXED_EPOCH_MS, attemptId, attempt: 1 }],
      },
    });
    await toGenerated(h);

    expectOk(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, attemptId, question: 'Why twice?' }),
    );

    expect(h.stages.followUp).toHaveBeenCalledTimes(1);
    expect(h.stages.followUp.mock.calls[0]?.[1].attemptId).toBe(attemptId);
    expect(h.manager.followUpAttemptIds).toEqual([attemptId]);
  });

  it('refuses a malformed attempt id before any stage runs', async () => {
    const h = harness();
    await toGenerated(h);

    const error = expectErr(
      await h.orchestrator.followUp({ sessionId: SESSION_ID, attemptId: '', question: 'Why?' }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.details?.['reason']).toBe('follow-up-attempt-invalid');
    expect(h.stages.followUp).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('generated');
  });

  it('returns a refusal the stage raises before choosing a path unchanged, leaving the session generated', async () => {
    const h = harness();
    await toGenerated(h);
    const refusal = new DebuggenError('SESSION_INVALID_STATE', 'A follow-up needs a question.', {
      details: { reason: 'missing-follow-up-question', stage: 'followup' },
    });
    h.stages.followUp.mockResolvedValueOnce(err(refusal));

    const error = expectErr(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: ' ',
      }),
    );

    expect(error).toBe(refusal);
    expect(h.manager.current().status).toBe('generated');
    expect(transitionRequests(h, 'failed')).toBe(0);
    expect(failedRows(h)).toEqual([]);
  });

  it.each([
    {
      field: 'analyses',
      stage: 'analyze',
      analysesAfter: [analysisOf(1).id],
      panelIdsAfter: [PANEL_V1.id],
    },
    {
      field: 'panelIds',
      stage: 'generate-panel',
      analysesAfter: [analysisOf(1).id, analysisOf(2).id],
      panelIdsAfter: [PANEL_V1.id],
    },
  ] as const)(
    'existing-evidence: a regenerated artifact the record could not keep ($field) fails $stage and never reaches generated again',
    async ({ field, stage, analysesAfter, panelIdsAfter }) => {
      const h = harness();
      await toGenerated(h);
      const transitionsBefore = h.manager.transitions.length;
      const refused = recordWriteRefused();
      h.manager.script.refusePatch = (patch) => (patch[field] !== undefined ? refused : undefined);

      const error = expectErr(
        await h.orchestrator.followUp({
          sessionId: SESSION_ID,
          attemptId: nextAttemptId(),
          question: 'Why twice?',
        }),
      );

      expect(error).toBe(refused);
      expect(
        h.manager.transitions.slice(transitionsBefore).map((entry) => `${entry.from}→${entry.to}`),
      ).toEqual(['generated→analyzing', 'analyzing→failed']);
      // Only the capture's own `analyzing → generated` was ever asked for.
      expect(transitionRequests(h, 'generated')).toBe(1);
      expect(h.manager.current().status).toBe('failed');
      expect(failuresOf(h)).toEqual([{ stage, code: 'STORE_ERROR', message: refused.message }]);
      expect(failedRows(h)).toHaveLength(1);
      const record = h.manager.current();
      expect(record.analyses.map((entry) => entry.id)).toEqual(analysesAfter);
      expect(record.panelIds).toEqual(panelIdsAfter);
      expect(mirrorWarnings(h.records, field)).toEqual([
        expect.objectContaining({ field, code: 'STORE_ERROR' }),
      ]);
    },
  );
});

/* =================================================================================================
 * 6. Concurrency, cancellation and lifecycle
 * ============================================================================================== */

/** Stage 1's artifact, for a test that replaces the default understand fake. */
const UNDERSTOOD: UnderstandResult = Object.freeze({
  understanding: UNDERSTANDING,
  promptVersion: REPORTED.understand,
  repairs: 0,
});

describe('regate', () => {
  it('admits an instrumenting session whose re-evaluated verdict is satisfied', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ script: { install: { satisfied: false } }, evaluateReadiness });
    await toReady(h);
    expect(h.manager.current().status).toBe('instrumenting');

    const outcome = expectOk(await h.orchestrator.regate({ sessionId: SESSION_ID }));

    expect(outcome).toEqual({
      sessionId: SESSION_ID,
      outcome: 'regated',
      status: 'ready',
      ready: true,
    });
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    const asked = h.manager.wire.calls.filter(
      (call) => call.member === 'transitionTo' && call.args[1] === 'ready',
    );
    expect(asked.map((call) => call.args[2])).toEqual([{ readinessSatisfied: true }]);
    expect(h.stages.arm).not.toHaveBeenCalled();
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
  });

  it('leaves the session instrumenting, and asks for nothing, when the verdict is still unsatisfied', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(false))));
    const h = harness({ script: { install: { satisfied: false } }, evaluateReadiness });
    await toReady(h);

    const outcome = expectOk(await h.orchestrator.regate({ sessionId: SESSION_ID }));

    expect(outcome.outcome).toBe('regated');
    expect(outcome.ready).toBe(false);
    expect(h.manager.current().status).toBe('instrumenting');
    expect(transitionRequests(h, 'ready')).toBe(0);
    expect(transitionRequests(h, 'failed')).toBe(0);
  });

  it('skips a session that is not instrumenting, without evaluating anything', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ session: { status: 'ready' }, evaluateReadiness });

    const outcome = expectOk(await h.orchestrator.regate({ sessionId: SESSION_ID }));

    expect(outcome).toMatchObject({ outcome: 'skipped', status: 'ready', ready: true });
    expect(evaluateReadiness).not.toHaveBeenCalled();
  });

  it('defers a re-gate asked for mid-run, then admits the session once the run leaves it instrumenting', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ script: { install: { satisfied: false } }, evaluateReadiness });
    const entered = deferred<PipelineStageContext>();
    const release = deferred();
    h.stages.investigate.mockImplementationOnce(async (context) => {
      entered.resolve(context);
      await release.promise;
      return ok({
        investigation: INVESTIGATION,
        promptVersion: REPORTED.investigate,
        repairs: 0,
        toolRuns: [],
      });
    });

    const first = h.orchestrator.run({ sessionId: SESSION_ID });
    await entered.promise;
    const deferredOutcome = expectOk(await h.orchestrator.regate({ sessionId: SESSION_ID }));
    expect(deferredOutcome.outcome).toBe('deferred');
    expect(evaluateReadiness).not.toHaveBeenCalled();

    release.resolve();
    expectOk(await first);

    await vi.waitFor(() => {
      expect(h.manager.current().status).toBe('ready');
    });
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(transitionRequests(h, 'failed')).toBe(0);
  });
});

describe('concurrency, cancellation and lifecycle', () => {
  it('allows one operation per session: each second call is refused, naming the operation and the active stage', async () => {
    const h = harness();
    const entered = deferred<PipelineStageContext>();
    const release = deferred();
    h.stages.investigate.mockImplementationOnce(async (context) => {
      entered.resolve(context);
      await release.promise;
      return ok({
        investigation: INVESTIGATION,
        promptVersion: REPORTED.investigate,
        repairs: 0,
        toolRuns: [],
      });
    });
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();

    const first = h.orchestrator.run({ sessionId: SESSION_ID });
    await entered.promise;
    expect(h.orchestrator.activeRun(SESSION_ID)).toBe('investigate');

    const seconds: readonly Result<unknown, DebuggenError>[] = [
      await h.orchestrator.run({ sessionId: SESSION_ID }),
      await h.orchestrator.beginCapture({ sessionId: SESSION_ID }),
      await h.orchestrator.completeCapture({ sessionId: SESSION_ID }),
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why?',
      }),
    ];
    seconds.forEach((second, index) => {
      const error = expectErr(second);
      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details).toMatchObject({
        reason: 'pipeline-busy',
        sessionId: SESSION_ID,
        operation: PIPELINE_OPERATIONS[index],
        activeStage: 'investigate',
      });
    });

    release.resolve();
    expectOk(await first);
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
    expect(h.stages.understand).toHaveBeenCalledTimes(1);
    expect(h.stages.arm).not.toHaveBeenCalled();
    expect(h.stages.complete).not.toHaveBeenCalled();
    expect(h.stages.followUp).not.toHaveBeenCalled();
  });

  it('reports the stage the in-flight operation has reached as it advances', async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    h.instrumentation.install.mockImplementationOnce(async (request) => {
      entered.resolve();
      await release.promise;
      return ok(installationOf(request.plan));
    });

    const pending = h.orchestrator.run({ sessionId: SESSION_ID });
    await entered.promise;
    expect(h.orchestrator.activeRun(SESSION_ID)).toBe('instrument');
    expect(h.orchestrator.activeRun('session-unknown')).toBeUndefined();

    release.resolve();
    expectOk(await pending);
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
  });

  it('threads one signal, linked to the caller’s, into the index loader, every stage, the readiness probes and the install', async () => {
    const evaluateReadiness = vi.fn<EvaluateReadinessFn>(() => Promise.resolve(ok(verdict(true))));
    const h = harness({ script: { install: { satisfied: false } }, evaluateReadiness });
    const controller = new AbortController();
    const { signal } = controller;

    expectOk(await h.orchestrator.run({ sessionId: SESSION_ID, signal }));
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID, signal }));
    expectOk(await h.orchestrator.completeCapture({ sessionId: SESSION_ID, signal }));
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why?',
        signal,
      }),
    );

    const received: Readonly<Record<string, readonly (AbortSignal | undefined)[]>> = {
      codeIndex: h.codeIndex.load.mock.calls.map((call) => call[1]?.signal),
      understand: h.stages.understand.mock.calls.map((call) => call[0].signal),
      investigate: h.stages.investigate.mock.calls.map((call) => call[0].signal),
      plan: h.stages.plan.mock.calls.map((call) => call[0].signal),
      observeReadiness: h.observeReadiness.mock.calls.map((call) => call[0].signal),
      install: h.instrumentation.install.mock.calls.map((call) => call[0].signal),
      evaluateReadiness: evaluateReadiness.mock.calls.map((call) => call[0].signal),
      arm: h.stages.arm.mock.calls.map((call) => call[0].signal),
      complete: h.stages.complete.mock.calls.map((call) => call[0].signal),
      analyze: h.stages.analyze.mock.calls.map((call) => call[0].signal),
      generatePanel: h.stages.generatePanel.mock.calls.map((call) => call[0].signal),
      followUp: h.stages.followUp.mock.calls.map((call) => call[0].signal),
    };
    for (const [receiver, signals] of Object.entries(received)) {
      expect(signals.length, receiver).toBeGreaterThan(0);
      for (const given of signals) {
        expect(given, receiver).toBeInstanceOf(AbortSignal);
        expect(given?.aborted, receiver).toBe(false);
      }
    }

    controller.abort();

    for (const [receiver, signals] of Object.entries(received)) {
      for (const given of signals) {
        expect(given?.aborted, receiver).toBe(true);
      }
    }
  });

  it('cancel aborts the in-flight stage, files the cancellation at a stable status and releases the handles', async () => {
    const h = harness();
    const entered = deferred<PipelineStageContext>();
    h.stages.understand.mockImplementationOnce(parkUntilAborted(entered, 'understand'));

    const pending = h.orchestrator.run({ sessionId: SESSION_ID });
    await entered.promise;
    expect(h.orchestrator.cancel(SESSION_ID)).toBe(true);
    const error = expectErr(await pending);

    expect(error.details?.['reason']).toBe('aborted');
    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['understand']);
    expect(transitionRequests(h, 'generated')).toBe(0);
    expect(h.codeIndex.invalidate).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(h.stages.investigate).not.toHaveBeenCalled();
    expect(h.orchestrator.cancel(SESSION_ID)).toBe(false);
    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
  });

  it('files a cancellation observed between stages under the next stage, which never runs', async () => {
    const h = harness();
    h.stages.understand.mockImplementationOnce(() => {
      h.orchestrator.cancel(SESSION_ID);
      return Promise.resolve(ok(UNDERSTOOD));
    });

    const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

    expect(error.details).toMatchObject({ reason: 'aborted', stage: 'investigate' });
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['investigate']);
    expect(h.stages.investigate).not.toHaveBeenCalled();
    expect(h.manager.current().status).toBe('failed');
  });

  it('never reaches generated after a cancellation, even when the last stage completes', async () => {
    const h = harness();
    await toCapturing(h);
    h.stages.generatePanel.mockImplementationOnce(() => {
      h.orchestrator.cancel(SESSION_ID);
      const result: GeneratePanelResult = {
        panelId: PANEL_V1.id,
        panel: PANEL_V1,
        panelVersion: 1,
        promptVersion: REPORTED['generate-panel'],
        fallback: false,
        repairs: 0,
        attempts: 1,
      };
      return Promise.resolve(ok(result));
    });

    const error = expectErr(await h.orchestrator.completeCapture({ sessionId: SESSION_ID }));

    expect(error.details?.['reason']).toBe('aborted');
    expect(transitionRequests(h, 'generated')).toBe(0);
    expect(h.manager.current().status).toBe('failed');
    expect(failuresOf(h).map((failure) => failure.stage)).toEqual(['generate-panel']);
  });

  it('refuses an operation whose signal is already aborted, without moving the session', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    const error = expectErr(
      await h.orchestrator.run({ sessionId: SESSION_ID, signal: controller.signal }),
    );

    expect(error.details?.['reason']).toBe('aborted');
    expect(h.manager.wire.calls.filter((call) => call.member === 'transitionTo')).toEqual([]);
    expect(h.stages.understand).not.toHaveBeenCalled();
  });

  it('dispose aborts in-flight work and waits for it, releases the handles, is idempotent and refuses later operations', async () => {
    const h = harness();
    const entered = deferred<PipelineStageContext>();
    h.stages.understand.mockImplementationOnce(parkUntilAborted(entered, 'understand'));
    const pending = h.orchestrator.run({ sessionId: SESSION_ID });
    await entered.promise;

    const first = h.orchestrator.dispose();
    const second = h.orchestrator.dispose();
    expect(second).toBe(first);
    await first;

    expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
    expect(expectErr(await pending).details?.['reason']).toBe('aborted');
    expect(h.codeIndex.invalidate).toHaveBeenCalledWith(PROJECT_ROOT);
    const released = h.codeIndex.invalidate.mock.calls.length;

    const refused: readonly Result<unknown, DebuggenError>[] = [
      await h.orchestrator.run({ sessionId: SESSION_ID }),
      await h.orchestrator.beginCapture({ sessionId: SESSION_ID }),
      await h.orchestrator.completeCapture({ sessionId: SESSION_ID }),
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why?',
      }),
    ];
    for (const result of refused) {
      expect(expectErr(result).details?.['reason']).toBe('orchestrator-disposed');
    }
    await expect(h.orchestrator.dispose()).resolves.toBeUndefined();
    expect(h.codeIndex.invalidate.mock.calls.length).toBe(released);
    expect(h.orchestrator.cancel(SESSION_ID)).toBe(false);
  });

  it('dispose releases the handles completed work loaded, once', async () => {
    const h = harness();
    await toReady(h);
    expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

    await h.orchestrator.dispose();
    await h.orchestrator.dispose();

    expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
  });
});

/** A second live session of the suite's project, answered by the manager with the same record. */
const OTHER_SESSION_ID = 'session-orchestrator-suite-other';

describe('code-index handle lifetime', () => {
  it('keeps a live session’s handles across its operations and releases them, once, when the session is released', async () => {
    const h = harness();
    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );

    // run, completeCapture and followUp each asked for the handles; each got the same bundle back.
    expect(h.codeIndex.load).toHaveBeenCalledTimes(3);
    expect(h.stages.analyze.mock.calls[0]?.[0].code).toBe(h.code);
    expect(h.stages.followUp.mock.calls[0]?.[0].code).toBe(h.code);
    expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

    h.orchestrator.releaseSession(SESSION_ID);
    expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);

    h.orchestrator.releaseSession(SESSION_ID);
    h.orchestrator.releaseSession('session-unknown');
    await h.orchestrator.dispose();
    h.orchestrator.releaseSession(SESSION_ID);
    expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
  });

  it('releases a ready session’s handles with the session, and forgets its remembered readiness verdict', async () => {
    const h = harness();
    await toReady(h);
    expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

    h.orchestrator.releaseSession(SESSION_ID);

    expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
    // A capture armed afterwards is no longer handed the install's verdict.
    expectOk(await h.orchestrator.beginCapture({ sessionId: SESSION_ID }));
    expect(h.stages.arm.mock.calls.at(-1)?.[1]).toEqual({});
  });

  it('keeps a project’s handles while another live session of it holds them, and releases them with the last', async () => {
    const h = harness({ sessionAliases: [OTHER_SESSION_ID] });
    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: OTHER_SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );

    h.orchestrator.releaseSession(SESSION_ID);
    expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

    h.orchestrator.releaseSession(OTHER_SESSION_ID);
    expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
  });

  it.each(['load', 'observeReadiness'] as const)(
    'defers the release of a session released mid-operation (blocked at %s) until that operation settles',
    async (blockedAt) => {
      const h = harness();
      await toGenerated(h);
      const entered = deferred();
      const unblock = deferred();
      if (blockedAt === 'load') {
        h.codeIndex.load.mockImplementationOnce(async () => {
          entered.resolve();
          await unblock.promise;
          return ok(h.code);
        });
      } else {
        h.observeReadiness.mockImplementationOnce(async () => {
          entered.resolve();
          await unblock.promise;
          return ok({});
        });
      }

      const pending = h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      });
      await entered.promise;
      h.orchestrator.releaseSession(SESSION_ID);
      expect(h.orchestrator.activeRun(SESSION_ID)).toBe('followup');
      expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

      unblock.resolve();
      expectOk(await pending);

      expect(h.orchestrator.activeRun(SESSION_ID)).toBeUndefined();
      expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
      // The settled operation recorded no new hold: nothing is left to release.
      h.orchestrator.releaseSession(SESSION_ID);
      await h.orchestrator.dispose();
      expect(h.codeIndex.invalidate.mock.calls).toEqual([[PROJECT_ROOT]]);
    },
  );

  it('logs, and never throws, when the index port fails to release a project', async () => {
    const h = harness();
    await toReady(h);
    h.codeIndex.invalidate.mockImplementationOnce(() => {
      throw new Error('index port exploded');
    });

    expect(() => {
      h.orchestrator.releaseSession(SESSION_ID);
    }).not.toThrow();

    expect(h.codeIndex.invalidate).toHaveBeenCalledTimes(1);
    expect(
      h.records.filter(
        (record) => record.level === 'warn' && record.fields['code'] === 'CODE_INDEX_FAILED',
      ),
    ).toHaveLength(1);
  });
});

/* =================================================================================================
 * 6b. The project root is re-proved before it is indexed or patched (CWE-367)
 * ============================================================================================== */

/** Where the suite's root was admitted to resolve: the directory behind a link on its path. */
const CANONICAL_ROOT = '/volumes/data/ledger-tool';

/** The log message of a confirmation the orchestrator itself could not accept. */
const ROOT_UNCONFIRMED_MESSAGE =
  'The project root could not be confirmed for indexing; the project was not indexed.';

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

/** One operation that indexes the project, and the stage its refused confirmation fails. */
interface IndexingOperation {
  readonly operation: 'run' | 'completeCapture' | 'followUp';
  readonly stage: ProgressStage;
  /** Drives the session to where the operation starts. */
  readonly arrange: (h: Harness) => Promise<void>;
  readonly act: (h: Harness) => Promise<Result<unknown, DebuggenError>>;
  /** The stage call the refusal must keep from running. */
  readonly stageCall: (h: Harness) => CallCounted;
}

const INDEXING_OPERATIONS: readonly IndexingOperation[] = [
  {
    operation: 'run',
    stage: 'understand',
    arrange: () => Promise.resolve(),
    act: (h) => h.orchestrator.run({ sessionId: SESSION_ID }),
    stageCall: (h) => h.stages.understand,
  },
  {
    operation: 'completeCapture',
    stage: 'analyze',
    arrange: toCapturing,
    act: (h) => h.orchestrator.completeCapture({ sessionId: SESSION_ID }),
    stageCall: (h) => h.stages.analyze,
  },
  {
    operation: 'followUp',
    stage: 'followup',
    arrange: toGenerated,
    act: (h) =>
      h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    stageCall: (h) => h.stages.followUp,
  },
];

describe('the project root is re-proved before it is indexed or patched', () => {
  it('indexes the canonical root the manager confirmed, and holds and releases the handles under it', async () => {
    const h = harness();
    h.manager.script.confirmProjectRoot = () =>
      ok({ projectRoot: PROJECT_ROOT, canonicalRoot: CANONICAL_ROOT });

    await toGenerated(h);

    // run and completeCapture each indexed the directory that was proven…
    expect(h.codeIndex.load.mock.calls.map((call) => call[0])).toEqual([
      CANONICAL_ROOT,
      CANONICAL_ROOT,
    ]);
    // …while every stage still reads the session's root as it was spelled.
    expect(h.stages.understand.mock.calls[0]?.[0].projectRoot).toBe(PROJECT_ROOT);
    expect(h.stages.analyze.mock.calls[0]?.[0].projectRoot).toBe(PROJECT_ROOT);
    expect(h.codeIndex.invalidate).not.toHaveBeenCalled();

    h.orchestrator.releaseSession(SESSION_ID);

    expect(h.codeIndex.invalidate.mock.calls).toEqual([[CANONICAL_ROOT]]);
  });

  it('accepts an identity that names the session’s root in another spelling of the same path', async () => {
    const h = harness();
    h.manager.script.confirmProjectRoot = () =>
      ok({ projectRoot: '/workspace//ledger-tool/', canonicalRoot: CANONICAL_ROOT });

    await toReady(h);

    expect(h.codeIndex.load.mock.calls[0]?.[0]).toBe(CANONICAL_ROOT);
  });

  it('confirms the root immediately before every load, with no await in between', async () => {
    const h = harness();
    h.manager.script.confirmProjectRoot = () => {
      // A microtask queued by the proof runs at the next `await`: had the
      // orchestrator awaited anything between the proof and the load, it would
      // be marked before the load.
      queueMicrotask(() => h.timeline.push('microtask'));
      return CONFIRMED_ROOT;
    };

    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );

    const loads = h.timeline.flatMap((entry, at) => (entry === 'load' ? [at] : []));
    expect(loads).toHaveLength(3);
    for (const at of loads) {
      expect(h.timeline.slice(at - 1, at + 2)).toEqual(['confirmProjectRoot', 'load', 'microtask']);
    }
    // Each confirmation asked about the operation's own session.
    expect(h.manager.wire.calls.filter((call) => call.member === 'confirmProjectRoot')).toEqual(
      Array.from({ length: 3 }, () => ({ member: 'confirmProjectRoot', args: [SESSION_ID] })),
    );
  });

  it.each(INDEXING_OPERATIONS)(
    '$operation fails at the $stage stage when the root moved, indexing nothing',
    async ({ stage, arrange, act, stageCall }) => {
      const h = harness();
      await arrange(h);
      const moved = movedRefusal();
      h.manager.script.confirmProjectRoot = () => err(moved);
      const loadsBefore = h.codeIndex.load.mock.calls.length;
      const stageCallsBefore = stageCall(h).mock.calls.length;

      const error = expectErr(await act(h));

      // The manager's refusal, unchanged — code, message and hint.
      expect(error).toBe(moved);
      expect(h.codeIndex.load.mock.calls.length).toBe(loadsBefore);
      expect(stageCall(h).mock.calls.length).toBe(stageCallsBefore);
      expect(failuresOf(h).at(-1)).toEqual({
        stage,
        code: 'PATH_OUTSIDE_PROJECT',
        message: moved.message,
        hint: moved.hint,
      });
      expect(h.manager.current().status).toBe('failed');
    },
  );

  it.each([
    {
      kind: 'throws',
      reason: 'project-root-confirmation-threw',
      confirm: (): RootConfirmation => {
        throw new Error('/private/leaked/ledger-tool could not be read');
      },
      logged: { errorClass: 'Error' },
    },
    {
      kind: 'answers a relative canonical root',
      reason: 'project-root-confirmation-invalid',
      confirm: (): RootConfirmation =>
        ok({ projectRoot: PROJECT_ROOT, canonicalRoot: 'leaked/ledger-tool' }),
      logged: {},
    },
    {
      kind: 'confirms another root than the session’s',
      reason: 'confirmed-root-mismatch',
      confirm: (): RootConfirmation =>
        ok({ projectRoot: '/workspace/leaked-tool', canonicalRoot: '/volumes/leaked-tool' }),
      logged: {},
    },
  ])(
    'fails the run as INTERNAL when the confirmation $kind, keeping nothing it carried',
    async ({ reason, confirm, logged }) => {
      const h = harness();
      h.manager.script.confirmProjectRoot = confirm;

      const error = expectErr(await h.orchestrator.run({ sessionId: SESSION_ID }));

      expect(error.code).toBe('INTERNAL');
      expect(error.details).toEqual({ reason, sessionId: SESSION_ID });
      expect(error.cause).toBeUndefined();
      expect(h.codeIndex.load).not.toHaveBeenCalled();
      expect(h.stages.understand).not.toHaveBeenCalled();
      expect(failuresOf(h)).toEqual([
        { stage: 'understand', code: 'INTERNAL', message: error.message, hint: error.hint },
      ]);
      expect(h.manager.current().status).toBe('failed');
      const warned = h.records.filter(
        (record) => record.level === 'warn' && record.message === ROOT_UNCONFIRMED_MESSAGE,
      );
      expect(warned.map((record) => record.fields)).toEqual([
        expect.objectContaining({ code: 'INTERNAL', reason, ...logged }),
      ]);
      // No record, failure or error carries what the confirmation held.
      expect(JSON.stringify(h.records)).not.toMatch(/leaked/u);
      expect(JSON.stringify(failuresOf(h))).not.toMatch(/leaked/u);
    },
  );

  it.each([
    {
      stage: 'plan' as const,
      arrange: (): Promise<void> => Promise.resolve(),
      act: async (h: Harness): Promise<void> => {
        await toReady(h);
      },
    },
    {
      stage: 'followUp' as const,
      arrange: async (h: Harness): Promise<void> => {
        await toGenerated(h);
        h.script.followUpPath = 'new-capture';
      },
      act: async (h: Harness): Promise<void> => {
        expectOk(
          await h.orchestrator.followUp({
            sessionId: SESSION_ID,
            attemptId: nextAttemptId(),
            question: 'Why again?',
          }),
        );
      },
    },
  ])(
    'hands every $stage-stage install the manager’s confirmation of the same session',
    async ({ stage, arrange, act }) => {
      const h = harness({ builtStages: [stage] });
      await arrange(h);
      const installsBefore = h.instrumentation.install.mock.calls.length;

      await act(h);

      const requests = h.instrumentation.install.mock.calls
        .slice(installsBefore)
        .map((call) => call[0]);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      if (request === undefined) {
        throw new Error(`Expected the ${stage} stage to install once.`);
      }
      expect(request.reportStageFailure).toBe(false);
      const confirm = request.confirmProjectRoot;
      expect(confirm).toBeTypeOf('function');

      const asked = h.manager.wire.calls.length;
      const answer = confirm?.();

      expect(answer).toBe(CONFIRMED_ROOT);
      expect(h.manager.wire.calls.slice(asked)).toEqual([
        { member: 'confirmProjectRoot', args: [request.sessionId] },
      ]);
      expect(request.sessionId).toBe(SESSION_ID);
    },
  );
});

/* =================================================================================================
 * 7. The model boundary and privacy
 * ============================================================================================== */

describe('model boundary and privacy', () => {
  it('never calls the model, the context builder or the analysis collaborators itself across the lifecycle', async () => {
    const h = harness();
    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why twice?',
      }),
    );
    h.script.followUpPath = 'new-capture';
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: 'Why again?',
      }),
    );

    expect(providerCalls).toEqual([]);
    const handedOn: readonly TripwireName[] = [
      'contextBuilder',
      'panelsRepo',
      'telemetryRepo',
      'modifications',
      'summarizer',
      'facts',
      'adapters',
    ];
    for (const name of handedOn) {
      expect(h.tripwires[name].calls, name).toEqual([]);
    }
    expect(membersCalled(h.tripwires.promptLoader)).toEqual(['versions']);
    expect(h.instrumentation.buildContext).not.toHaveBeenCalled();
    expect(h.panelGenerator.generate).not.toHaveBeenCalled();
    // Only the manager members the pipeline's contract names were reached — never `fail`,
    // `retry`, `end` or another lifecycle method the double does not implement.
    const implemented = new Set([
      'get',
      'confirmProjectRoot',
      'transitionTo',
      'patch',
      'recordPlan',
      'appendFollowUp',
      'startCapture',
      'stopCapture',
    ]);
    expect(membersCalled(h.manager.wire).filter((member) => !implemented.has(member))).toEqual([]);
  });

  it('logs ids, stages and codes only — never the question, a model output, an attribute value or error text', async () => {
    const h = harness();
    await toGenerated(h);
    expectOk(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: `Why did it run twice ${SENTINELS.followUp}?`,
      }),
    );
    h.stages.followUp.mockResolvedValueOnce(
      err(
        subsystemError(
          'MODEL_OUTPUT_INVALID',
          `The decision was rejected ${SENTINELS.errorText}.`,
          {
            hint: `Ask again ${SENTINELS.errorText}.`,
            stage: 'followup',
          },
        ),
      ),
    );
    expectErr(
      await h.orchestrator.followUp({
        sessionId: SESSION_ID,
        attemptId: nextAttemptId(),
        question: `And once more ${SENTINELS.followUp}?`,
      }),
    );

    // Every planted value did reach the collaborators, so its absence from the logs means something.
    const reached = JSON.stringify([
      h.manager.current(),
      h.stages.followUp.mock.calls.map((call) => call[1].followUpQuestion),
      failedRows(h).map((row) => row.failure),
    ]);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(reached).toContain(sentinel);
    }

    expect(h.records.length).toBeGreaterThan(0);
    for (const record of h.records) {
      const line = JSON.stringify(record);
      for (const sentinel of Object.values(SENTINELS)) {
        expect(line).not.toContain(sentinel);
      }
    }
    const boundary = h.records.find((record) => record.message === 'Pipeline stage started.');
    expect(boundary?.fields).toMatchObject({ subsystem: 'pipeline', sessionId: SESSION_ID });
    const failed = h.records.filter((record) => record.level === 'error');
    expect(failed.map((record) => record.fields)).toEqual([
      expect.objectContaining({ stage: 'followup', code: 'MODEL_OUTPUT_INVALID' }),
    ]);
  });
});
