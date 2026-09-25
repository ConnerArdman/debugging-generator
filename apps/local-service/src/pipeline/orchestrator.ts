/**
 * The sequencer of the local service's six-stage reasoning pipeline (AAP
 * §0.4.2 "AI stage boundaries", §0.7.1 Group 2 "stage sequence with typed
 * artifacts", §0.8.1 slices 8–11).
 *
 * It **orchestrates; it does not reason.** No model call, no prompt rendering,
 * no schema validation and no write to the developer's project happens here:
 *
 * - every model call, prompt and structured-output gate lives in `./stages/*.ts`
 *   and `./context-builder.ts`;
 * - every write to the project is the instrumentation layer's
 *   (`../instrumentation/service.ts`), which is only ever asked — by the plan
 *   and follow-up stages — to install a plan those stages validated;
 * - every display string is `../sessions/progress.ts`'s, every status rule is
 *   `../sessions/state-machine.ts`'s, and every developer-facing failure
 *   sentence is the failing subsystem's own `DebuggenError`.
 *
 * What this module owns is the order, the status choreography, the one
 * in-flight operation per session, cancellation, the code-index handles shared
 * by every stage of a run, the prompt versions recorded on the session, and the
 * rule of AAP §0.5.5 that **a failure is never presented as a successful
 * analysis**: the session reaches `generated` only through the state machine's
 * guarded edge, with the validated analysis and the validated panel in hand.
 *
 * ## Operations and status choreography
 *
 * | Operation | Stages | Statuses |
 * |---|---|---|
 * | {@link PipelineOrchestrator.run} | understand → investigate → plan (records and installs) | `created`/`failed` → `understanding` → `investigating` → `planning` → `instrumenting` → `ready` (when readiness is satisfied) |
 * | {@link PipelineOrchestrator.beginCapture} | capture (arm) | `instrumenting` → `ready` (re-evaluated readiness) → `capturing` |
 * | {@link PipelineOrchestrator.completeCapture} | capture (complete) → analyze → generate-panel | `capturing` → `ready` (empty capture) or `analyzing` → `generated` |
 * | {@link PipelineOrchestrator.followUp} | followup, then either analyze + generate-panel or plan + instrument | `generated` → `analyzing` → `generated`, or `generated` → `planning` → `instrumenting` → `ready` |
 *
 * ## Progress rows
 *
 * Understand, investigate, plan and follow-up emit their own group rows. The
 * capture, analyze and generate-panel stages are built with
 * `reportStageBoundaries: false`, and this module emits their header and
 * closing rows around each call, because only the orchestrator sees where a
 * capture window opens (one request) and closes (a later one). A stage's
 * `failed` row is never emitted twice: every failure moves the session to
 * `failed` through the session manager, which writes that row as part of the
 * transition, so the stages are handed a progress view whose `stageFailed`
 * records the failure instead of sending it, and installs are asked not to
 * report their own failure row (`reportStageFailure: false`).
 *
 * ## What is deliberately not repeated here
 *
 * - The plan stage records the plan (`recordPlan`) and installs it; the
 *   follow-up stage appends the question, installs the delta and records plan
 *   version n + 1. Neither is repeated.
 * - The install's readiness gate emits "Ready to capture" when satisfied, and
 *   the degradation sentences built by `buildDegradationNotice`; they are not
 *   emitted again.
 * - `panel.generated` is broadcast by `../panels/generate.ts` and
 *   `analysis.completed` by `./stages/analyze.ts` (given `deps.broadcaster`);
 *   both are also replayed by `../sessions/reopen.ts`. Neither is sent from
 *   here.
 *
 * ## Privacy
 *
 * Log records carry ids, stage names, versions, counts and error codes only —
 * never the question, a prompt, a model output, a SQL statement, a URL, an
 * attribute value or a token (AAP §0.5.2). The follow-up question is passed to
 * the follow-up stage verbatim and is never inspected here (AAP §0.5.4).
 *
 * @module
 */

import {
  createCodeQueries,
  createIndexCache,
  createReferenceResolver,
  indexProject,
  openProject,
  summarizeProject,
} from '@debuggen/code-analysis';
import type { IndexCache } from '@debuggen/code-analysis';
import { isOpenModificationStatus } from '@debuggen/instrumentation';
import type {
  AdapterRegistry,
  InstrumentationPlan,
  ModificationRecord,
  ObservedReadinessInputs,
} from '@debuggen/instrumentation';
import { PROMPT_STAGES } from '@debuggen/model-provider';
import type { ModelProvider, PromptLoader, PromptStage } from '@debuggen/model-provider';
import type { PanelSpec } from '@debuggen/panel-schema';
import { PROGRESS_STAGES, SESSION_STATUSES } from '@debuggen/protocol';
import type {
  AnalysisResult,
  ProgressStage,
  ProgressStatus,
  PromptVersions,
  SessionProgressPayload,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { DebuggenError, err, nowEpochMs, normalizePosix, ok } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import type { AnalysisFacts } from '../analysis/facts.js';
import type { AnalysisSummarizer } from '../analysis/summarize.js';
import type { ServiceConfig } from '../config.js';
import type {
  CollectObservedReadinessRequest,
  ReadinessVerdict,
} from '../instrumentation/readiness.js';
import type {
  InstallRequest,
  InstrumentationOutcome,
  InstrumentationService,
} from '../instrumentation/service.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import type { PanelGenerator } from '../panels/generate.js';
import type { SessionBroadcaster, SessionManager, SessionPatch } from '../sessions/manager.js';
import { PROGRESS_STAGE_TITLES } from '../sessions/progress.js';
import type { SessionProgress } from '../sessions/progress.js';
import { isTerminalSessionStatus, statusForStage, transition } from '../sessions/state-machine.js';
import type { SessionFailure, SessionTransitionContext } from '../sessions/state-machine.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { TelemetryRepo } from '../store/telemetry-repo.js';
import { createPipelineStageContext } from './context-builder.js';
import type {
  ContextBuilder,
  PipelineCodeHandles,
  PipelineStageContext,
} from './context-builder.js';
import { ANALYZE_STAGE, createAnalyzeStage } from './stages/analyze.js';
import type { AnalyzeStage } from './stages/analyze.js';
import { CAPTURE_STAGE, createCaptureStage } from './stages/capture.js';
import type {
  CaptureInstrumentationPort,
  CaptureReadinessSource,
  CaptureStage,
  CaptureStageContext,
} from './stages/capture.js';
import { FOLLOW_UP_STAGE, createFollowUpStage } from './stages/followup.js';
import type { FollowUpPath, FollowUpStage, FollowUpStageDeps } from './stages/followup.js';
import { GENERATE_PANEL_STAGE, createGeneratePanelStage } from './stages/generate-panel.js';
import type { GeneratePanelStage } from './stages/generate-panel.js';
import { createInvestigateStage } from './stages/investigate.js';
import type { InvestigateStage } from './stages/investigate.js';
import { createPlanStage } from './stages/plan.js';
import type { PlanStage } from './stages/plan.js';
import { createUnderstandStage } from './stages/understand.js';
import type { UnderstandStage } from './stages/understand.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary — derived from the owning modules, never restated
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding of every log record of this module, shared by every pipeline module. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/**
 * A progress stage the pipeline runs. At run time every value this module
 * reports is a member of {@link PIPELINE_STAGE_ORDER}; the type is protocol's
 * own so that adding a stage upstream cannot leave a narrower local union stale.
 */
export type PipelineStageKey = ProgressStage;

/**
 * The pipeline's stages in execution order, **derived** from protocol's
 * `PROGRESS_STAGES`: every stage that owns a session status
 * (`../sessions/state-machine.ts`'s `STAGE_STATUS`), plus the follow-up stage,
 * which owns none because it branches into one of two paths. Cleanup is not a
 * pipeline stage: it runs on the way into `ended`, from `../cleanup/cleanup.ts`.
 *
 * The order is protocol's order, so a stage inserted upstream appears here in
 * its place without an edit to this file.
 */
export const PIPELINE_STAGE_ORDER: readonly PipelineStageKey[] = Object.freeze(
  PROGRESS_STAGES.filter(
    (stage) => statusForStage(stage) !== undefined || stage === FOLLOW_UP_STAGE,
  ),
);

/** Stage 1's progress key; the understand stage does not export its own. */
const UNDERSTAND_STAGE = 'understand' as const satisfies PipelineStageKey;

/** Stage 2's progress key; the investigate stage does not export its own. */
const INVESTIGATE_STAGE = 'investigate' as const satisfies PipelineStageKey;

/** Stage 3's progress key; the plan stage does not export its own. */
const PLAN_STAGE = 'plan' as const satisfies PipelineStageKey;

/** The installation step's progress key, under which install failures are filed. */
const INSTRUMENT_STAGE = 'instrument' as const satisfies PipelineStageKey;

/** The status a satisfied readiness gate admits, through the guarded edge. */
const READY_STATUS = 'ready' as const satisfies SessionStatus;

/** The status only the guarded `analyzing → generated` edge reaches. */
const GENERATED_STATUS = 'generated' as const satisfies SessionStatus;

/** The status every stage failure is filed under. */
const FAILED_STATUS = 'failed' as const satisfies SessionStatus;

/** The progress status of a stage-failure row. */
const FAILED_ROW_STATUS = 'failed' as const satisfies ProgressStatus;

/**
 * The statuses a follow-up may start from: those from which **both** of its
 * paths' first edges (`→ analyzing` and `→ planning`) exist in the state
 * machine's table. Derived, so the table remains the only statement of it.
 */
const FOLLOW_UP_START_STATUSES: readonly SessionStatus[] = Object.freeze(
  SESSION_STATUSES.filter(
    (status) =>
      transition(status, statusOrThrow(ANALYZE_STAGE)).ok &&
      transition(status, statusOrThrow(PLAN_STAGE)).ok,
  ),
);

/**
 * The status a stage runs under, for a stage that owns one. Used only at module
 * load for {@link FOLLOW_UP_START_STATUSES}, where both stages own a status by
 * the state machine's own compile-time table.
 */
function statusOrThrow(stage: PipelineStageKey): SessionStatus {
  const status = statusForStage(stage);
  if (status === undefined) {
    throw new DebuggenError(
      'INTERNAL',
      'The session state machine no longer assigns a status to a pipeline stage the orchestrator enters.',
      { details: { stage } },
    );
  }
  return status;
}

/**
 * The public operations of the orchestrator; each is the `operation` of the
 * busy refusal a second concurrent call receives.
 */
export const PIPELINE_OPERATIONS = Object.freeze([
  'run',
  'beginCapture',
  'completeCapture',
  'followUp',
  'regate',
] as const);

/** One public operation of the orchestrator. */
export type PipelineOperation = (typeof PIPELINE_OPERATIONS)[number];

/**
 * The `details.reason` of every refusal this module raises itself. Every other
 * refusal and failure is the owning subsystem's error, passed through
 * unchanged.
 *
 * - `pipeline-busy` — another operation is in flight for the session;
 * - `session-not-found` — the manager holds no session under the id;
 * - `instrumentation-installed` — `run` was asked to start over while the
 *   session's instrumentation is still installed;
 * - `missing-understanding` — a capture was analysed for a session that never
 *   recorded a problem understanding;
 * - `orchestrator-disposed` — the service is shutting down;
 * - `aborted` — the operation was cancelled (the shape every pipeline layer
 *   uses: code `INTERNAL`, `details.reason: "aborted"`).
 */
export const PIPELINE_REFUSAL_REASONS = Object.freeze([
  'pipeline-busy',
  'session-not-found',
  'instrumentation-installed',
  'missing-understanding',
  'orchestrator-disposed',
  'aborted',
] as const);

/** One `details.reason` of {@link PIPELINE_REFUSAL_REASONS}. */
export type PipelineRefusalReason = (typeof PIPELINE_REFUSAL_REASONS)[number];

/** The default number of projects {@link createCodeIndexLoader} keeps loaded at once. */
export const DEFAULT_MAX_LOADED_PROJECTS = 2;

/* -------------------------------------------------------------------------------------------------
 * Public contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The code-analysis handles of one project, loaded **once per run** and shared
 * by every stage and by the install request (`./context-builder.ts`'s
 * {@link PipelineCodeHandles}; `../instrumentation/service.ts` expects them
 * injected and never indexes a project itself).
 */
export interface CodeIndexPort {
  /**
   * Loads — or returns the cached — handles of a project.
   *
   * @param projectRoot The absolute project root.
   * @param options `refresh: true` discards any cached handles and re-indexes
   * (the on-disk index cache still spares unchanged files); `signal` cancels.
   * @returns The handles, or the indexer's typed failure. Never rejects.
   */
  load(
    projectRoot: string,
    options?: { readonly signal?: AbortSignal | undefined; readonly refresh?: boolean | undefined },
  ): Promise<Result<PipelineCodeHandles, DebuggenError>>;

  /**
   * Releases the cached handles of a project — the ts-morph program above
   * all, which is the largest object a session holds.
   */
  invalidate?(projectRoot: string): void;
}

/** What {@link createCodeIndexLoader} is given. */
export interface CodeIndexLoaderOptions {
  /** The service configuration; only `indexCacheDir` (`$DEBUGGEN_HOME/index`) is read. */
  readonly config: Pick<ServiceConfig, 'indexCacheDir'>;
  /** The parent logger; records are bound to the `pipeline` subsystem. */
  readonly logger: Logger;
  /**
   * How many projects stay loaded at once, least recently used evicted first.
   * A positive integer; defaults to {@link DEFAULT_MAX_LOADED_PROJECTS}.
   */
  readonly maxProjects?: number | undefined;
}

/**
 * The seven stages the orchestrator sequences. Each member is the stage's own
 * factory-plus-methods interface, so a suite can substitute a fake of any one
 * without a provider, a store or a project.
 */
export interface PipelineStages {
  readonly understand: UnderstandStage;
  readonly investigate: InvestigateStage;
  readonly plan: PlanStage;
  readonly capture: CaptureStage;
  readonly analyze: AnalyzeStage;
  readonly generatePanel: GeneratePanelStage;
  readonly followUp: FollowUpStage;
}

/**
 * Replacements for any of the seven stages. An absent member is constructed
 * from `./stages/*.js` with the orchestrator's collaborators, lazily, the first
 * time it is needed.
 */
export type StageOverrides = Partial<PipelineStages>;

/**
 * The readiness facts the service has observed for a session — the preload
 * and page-agent reports the adapter catalog's preconditions describe. Typed
 * as `../instrumentation/readiness.ts`'s `collectObservedReadiness` bound to
 * its collaborators, which is what the service wiring passes.
 */
export type ObserveReadinessFn = (
  request: CollectObservedReadinessRequest,
) => Promise<Result<ObservedReadinessInputs, DebuggenError>>;

/**
 * Everything {@link createPipelineOrchestrator} is given; all of it injected.
 * No module-level singleton, environment variable, database handle or network
 * client is reached from this file.
 */
export interface PipelineOrchestratorDeps {
  /** The resolved service configuration (the default code-index loader reads `indexCacheDir`). */
  readonly config: ServiceConfig;
  /** The service logger; records are bound to the `pipeline` subsystem and the session. */
  readonly logger: Logger;
  /** The configured model provider, handed to the stages. **Never called here.** */
  readonly provider: ModelProvider;
  /** The versioned prompt files; only `versions()` is read here, to record them on a new session. */
  readonly promptLoader: PromptLoader;
  /** Renders every stage request; handed to the stages. */
  readonly contextBuilder: ContextBuilder;
  /** The only writer of session status and of the session record. */
  readonly sessions: SessionManager;
  /** The `session.progress` emitter; owns every title and label. */
  readonly progress: SessionProgress;
  /** The session store: the plan ladder and the capture rows. */
  readonly sessionsRepo: SessionsRepo;
  /** The analysis and panel history. */
  readonly panelsRepo: PanelsRepo;
  /** The captured, already-redacted events, read by the capture stage to summarise a window. */
  readonly telemetryRepo: TelemetryRepo;
  /**
   * The instrumentation driver — the only writer to the developer's project.
   * A wiring that also offers `evaluateReadiness` (the capture stage's
   * {@link CaptureReadinessSource}) lets a capture re-evaluate readiness at
   * the moment it starts, which is what moves an `instrumenting` session whose
   * page was not ready at install time to `ready`.
   */
  readonly instrumentation: InstrumentationService & Partial<CaptureReadinessSource>;
  /**
   * The modification journal, read only, as the follow-up stage needs it: the
   * chain head of each file a delta patches (AAP §0.5.1). The follow-up stage
   * requires it, so it is required here rather than left for a run to discover.
   */
  readonly modifications: FollowUpStageDeps['modifications'];
  /** The bounded, redacted analysis inputs. */
  readonly summarizer: AnalysisSummarizer;
  /** Evidence verification and versioned analysis persistence. */
  readonly facts: AnalysisFacts;
  /** Panel generation, validation, fallback, persistence and broadcast. */
  readonly panelGenerator: PanelGenerator;
  /**
   * Delivers `analysis.completed` from the analyze stage once an analysis is
   * stored — the client registry in production. Absent, no analysis frame is
   * broadcast live and clients see the analysis on their next reopen replay.
   */
  readonly broadcaster?: Pick<SessionBroadcaster, 'broadcastToKinds'> | undefined;
  /** The live adapter registry — the same one the instrumentation service installs with. */
  readonly adapters: AdapterRegistry;
  /**
   * The observed readiness facts placed on each planning context. Absent, the
   * adapter catalog is built as if nothing had reported yet.
   */
  readonly observeReadiness?: ObserveReadinessFn | undefined;
  /** The code-index loader; defaults to {@link createCodeIndexLoader} over `config`. */
  readonly codeIndex?: CodeIndexPort | undefined;
  /** Stage replacements; see {@link StageOverrides}. */
  readonly stages?: StageOverrides | undefined;
  /** The clock every stage context is built with; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/** What {@link PipelineOrchestrator.run} is asked. */
export interface PipelineRunRequest {
  /** The session to run. Its question, target and project root are read from the stored record. */
  readonly sessionId: string;
  /** Cancels the run. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link PipelineOrchestrator.run} concluded. */
export interface PipelineRunOutcome {
  readonly sessionId: string;
  /** The session's status afterwards: `ready`, or `instrumenting` while readiness is not yet satisfied. */
  readonly status: SessionStatus;
  /** Whether the readiness gate admitted `ready`. */
  readonly ready: boolean;
  /** The recorded, installed plan version. */
  readonly planVersion: number;
  /** Whether the installed plan is the plan stage's runtime-only fallback. */
  readonly fallbackPlan: boolean;
  /** How many relevant files the investigation recorded on the session. */
  readonly relevantFileCount: number;
  /** How many modification records the install applied. */
  readonly appliedModifications: number;
  /** The degradation sentences the install emitted, one per signal it could not enable. */
  readonly degradations: readonly string[];
  /** The readiness gate's verdict for the installed plan. */
  readonly readiness: ReadinessVerdict;
  /** The prompt versions recorded on the session. */
  readonly promptVersions: PromptVersions;
  /** Whether {@link promptVersions} were stored (bookkeeping; a store failure is logged, never fatal). */
  readonly promptVersionsRecorded: boolean;
}

/** What {@link PipelineOrchestrator.beginCapture} is asked. */
/** Input of {@link PipelineOrchestrator.regate}. */
export interface RegateRequest {
  readonly sessionId: string;
  /** Cancels the readiness re-evaluation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * What {@link PipelineOrchestrator.regate} did.
 *
 * - `'regated'` — the readiness gate ran; `ready` says whether it admitted the
 *   session;
 * - `'deferred'` — another operation holds the session, so the gate runs once
 *   that operation has ended;
 * - `'skipped'` — the session is not `instrumenting`, so there was nothing to
 *   re-gate.
 */
export interface RegateOutcome {
  readonly sessionId: string;
  readonly outcome: 'regated' | 'deferred' | 'skipped';
  readonly status: SessionStatus;
  readonly ready: boolean;
}

export interface CaptureBeginRequest {
  readonly sessionId: string;
  /** Cancels the readiness re-evaluation and the arm. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link PipelineOrchestrator.beginCapture} left in place: an open, armed capture window. */
export interface CaptureBeginResult {
  /** The capture window the session manager opened. */
  readonly captureId: string;
  /** The plan version whose configuration was armed. */
  readonly planVersion: number;
  /** Whether readiness was re-evaluated now or taken from the install. */
  readonly readinessSource: 'reevaluated' | 'supplied';
  /** The degradation sentences of the verdict the capture was gated on. */
  readonly degradations: readonly string[];
}

/** What {@link PipelineOrchestrator.completeCapture} is asked. */
export interface CaptureCompleteRequest {
  readonly sessionId: string;
  /** Cancels the analysis and panel generation. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link PipelineOrchestrator.completeCapture} concluded. */
export interface CaptureCompleteResult {
  /** The completed capture. */
  readonly captureId: string;
  /** Its summary — the payload of `capture.stopped`. */
  readonly summary: CaptureSummary;
  /** `true` for AAP §0.5.5's "Capture yielded nothing": analysis was skipped. */
  readonly emptyCapture: boolean;
  /** The validated, stored analysis, when the capture held evidence. */
  readonly analysis?: AnalysisResult | undefined;
  /** The stored panel's id, when one was generated. */
  readonly panelId?: string | undefined;
  /** The stored panel's version. */
  readonly panelVersion?: number | undefined;
  /** Whether the panel is the deterministic fallback, shown under the fallback banner. */
  readonly fallback?: boolean | undefined;
  /** Whether the prompt versions the stages reported were stored. */
  readonly promptVersionsRecorded?: boolean | undefined;
}

/** What {@link PipelineOrchestrator.followUp} is asked. */
export interface FollowUpRequest {
  readonly sessionId: string;
  /** The follow-up question, verbatim; passed to the follow-up stage untouched. */
  readonly question: string;
  /** Cancels the follow-up. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link PipelineOrchestrator.followUp} concluded. */
export interface FollowUpOutcome {
  /** Which of AAP §0.4.2's two follow-up paths ran. */
  readonly path: FollowUpPath;
  /** The session's status afterwards. */
  readonly status: SessionStatus;
  /** The new plan version, on the new-capture path. */
  readonly planVersion?: number | undefined;
  /** Whether readiness admitted `ready`, on the new-capture path. */
  readonly ready?: boolean | undefined;
  /** The regenerated analysis (`analyses[n + 1]`), on the existing-evidence path. */
  readonly analysis?: AnalysisResult | undefined;
  /** The regenerated panel's id, on the existing-evidence path. */
  readonly panelId?: string | undefined;
  /** The regenerated panel's version (`n + 1`), on the existing-evidence path. */
  readonly panelVersion?: number | undefined;
  /** The panel it supersedes, on the existing-evidence path. */
  readonly supersedes?: string | undefined;
  /** Whether the regenerated panel is the fallback, on the existing-evidence path. */
  readonly fallback?: boolean | undefined;
  /** Whether the prompt versions the stages reported were stored. */
  readonly promptVersionsRecorded: boolean;
}

/**
 * The pipeline orchestrator of one service process. The four operations are
 * `async`, answer with a `Result` and never reject for an expected failure.
 * At most one of them is in flight per session.
 */
export interface PipelineOrchestrator {
  /**
   * Stages 1–3 and the installation, ending at `ready` (or `instrumenting`
   * while readiness is unsatisfied). Starts from `created`, or from `failed`
   * when no instrumentation of the session is still installed.
   */
  run(request: PipelineRunRequest): Promise<Result<PipelineRunOutcome, DebuggenError>>;

  /**
   * Opens and arms a capture window. A capture conflict with another session
   * of the same project is returned unchanged, so the route can answer `409`.
   * Refusals leave the session's status as it was.
   */
  beginCapture(request: CaptureBeginRequest): Promise<Result<CaptureBeginResult, DebuggenError>>;

  /**
   * Closes the capture window, then — when it holds evidence — analyses it and
   * generates the panel, ending at `generated`. Also resumes a session left at
   * `analyzing` or `failed` after its capture was stopped.
   */
  completeCapture(
    request: CaptureCompleteRequest,
  ): Promise<Result<CaptureCompleteResult, DebuggenError>>;

  /** Answers a follow-up question along one of AAP §0.4.2's two paths. */
  followUp(request: FollowUpRequest): Promise<Result<FollowUpOutcome, DebuggenError>>;

  /**
   * Re-evaluates the readiness gate of an `instrumenting` session and takes the
   * guarded `instrumenting → ready` edge when it is satisfied. Called when the
   * bound tab's page agent reports, so a session whose install ran before its
   * tab was bound — or before the page reloaded — reaches "Ready to capture"
   * without waiting for a capture to re-gate it. A session held by another
   * operation is re-gated as soon as that operation ends; a session in any other
   * status is left alone.
   */
  regate(request: RegateRequest): Promise<Result<RegateOutcome, DebuggenError>>;

  /**
   * Aborts the session's in-flight operation, if any. The operation settles
   * with the session at a stable status — `failed` with the cancellation, or
   * the status it had before a refused step — and never at `generated`.
   *
   * @returns Whether an operation was in flight.
   */
  cancel(sessionId: string): boolean;

  /** The stage the session's in-flight operation is at, or `undefined` when idle. */
  activeRun(sessionId: string): PipelineStageKey | undefined;

  /**
   * Aborts every in-flight operation, waits for each to settle, and releases
   * the code-index handles loaded for them. Idempotent; later calls to the
   * four operations are refused.
   */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * The default code-index loader
 * ---------------------------------------------------------------------------------------------- */

/** Info record of a loaded project. Fields: whether the index came from the cache, and timing. */
const INDEX_LOADED_LOG = 'Code index loaded for a pipeline run.';

/** Warn record of an on-disk index cache that could not be opened; indexing proceeds uncached. */
const INDEX_CACHE_UNAVAILABLE_LOG =
  'The on-disk code-index cache could not be opened; projects are indexed without it.';

/** Error record of a project that could not be indexed. Fields: error code. */
const INDEX_FAILED_LOG = 'Code index could not be loaded for a pipeline run.';

/**
 * Creates the default {@link CodeIndexPort} over `@debuggen/code-analysis`:
 * `openProject` → `indexProject` (cached on disk under
 * `config.indexCacheDir`, i.e. `$DEBUGGEN_HOME/index`) → `createCodeQueries`
 * over the graph and its route map, with lazily resolved references →
 * `summarizeProject`.
 *
 * The handles of up to `maxProjects` projects stay in memory, least recently
 * used evicted first, so the capture and follow-up operations of a session
 * reuse the program its run loaded instead of parsing the project again.
 * `invalidate` drops a project's handles; nothing else holds them.
 *
 * @param options The configuration, logger and memory bound.
 * @returns The loader.
 *
 * @example
 * ```ts
 * const codeIndex = createCodeIndexLoader({ config, logger });
 * const handles = await codeIndex.load(session.projectRoot, { refresh: true, signal });
 * ```
 */
export function createCodeIndexLoader(options: CodeIndexLoaderOptions): CodeIndexPort {
  const log = subsystemLogger(options.logger, PIPELINE_SUBSYSTEM);
  const requested = options.maxProjects ?? DEFAULT_MAX_LOADED_PROJECTS;
  const maxProjects =
    Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_LOADED_PROJECTS;
  const loaded = new Map<string, PipelineCodeHandles>();
  let diskCache: IndexCache | false | undefined;

  /** The on-disk cache, opened once; `false` (index uncached) when it cannot be opened. */
  function cacheOf(): IndexCache | false {
    if (diskCache === undefined) {
      try {
        diskCache = createIndexCache({ cacheDir: options.config.indexCacheDir, logger: log });
      } catch (thrown) {
        log.warn(INDEX_CACHE_UNAVAILABLE_LOG, {
          code: DebuggenError.from(thrown, 'CODE_INDEX_FAILED').code,
        });
        diskCache = false;
      }
    }
    return diskCache;
  }

  /** Keeps `handles` as the most recently used entry, evicting beyond the bound. */
  function remember(root: string, handles: PipelineCodeHandles): void {
    loaded.delete(root);
    loaded.set(root, handles);
    while (loaded.size > maxProjects) {
      const oldest = loaded.keys().next();
      if (oldest.done === true) {
        break;
      }
      loaded.delete(oldest.value);
    }
  }

  async function build(
    root: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<PipelineCodeHandles, DebuggenError>> {
    const started = nowEpochMs();
    const opened = openProject({ projectRoot: root, logger: log });
    if (!opened.ok) {
      return opened;
    }
    const project = opened.value;
    const indexed = await indexProject({
      projectRoot: root,
      loaded: project,
      cache: cacheOf(),
      signal,
      logger: log,
    });
    if (!indexed.ok) {
      return indexed;
    }
    const { index, graph, routeMap, fromCache } = indexed.value;
    const queries = createCodeQueries(graph, {
      loaded: project,
      routes: routeMap.entries,
      references: createReferenceResolver(project),
      logger: log,
    });
    const projectSummary = summarizeProject({
      loaded: project,
      index,
      graph,
      routeMap,
      logger: log,
    });
    log.info(INDEX_LOADED_LOG, { fromCache, durationMs: Math.max(0, nowEpochMs() - started) });
    return ok(Object.freeze({ graph, queries, routeMap, projectSummary, loaded: project }));
  }

  async function load(
    projectRoot: string,
    loadOptions?: {
      readonly signal?: AbortSignal | undefined;
      readonly refresh?: boolean | undefined;
    },
  ): Promise<Result<PipelineCodeHandles, DebuggenError>> {
    const root = normalizePosix(projectRoot);
    const cached = loaded.get(root);
    if (cached !== undefined && loadOptions?.refresh !== true) {
      remember(root, cached);
      return ok(cached);
    }
    loaded.delete(root);

    let built: Result<PipelineCodeHandles, DebuggenError>;
    try {
      built = await build(root, loadOptions?.signal);
    } catch (thrown) {
      built = err(DebuggenError.from(thrown, 'CODE_INDEX_FAILED'));
    }
    if (!built.ok) {
      log.error(INDEX_FAILED_LOG, { code: built.error.code });
      return built;
    }
    remember(root, built.value);
    return built;
  }

  function invalidate(projectRoot: string): void {
    loaded.delete(normalizePosix(projectRoot));
  }

  return Object.freeze({ load, invalidate });
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers — errors this module raises itself, failures, merges
 * ---------------------------------------------------------------------------------------------- */

/** The refusal of a second operation for a session that already has one in flight. */
function busyError(
  sessionId: string,
  operation: PipelineOperation,
  stage: PipelineStageKey,
): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    `Debug Generator is already working on this session (${PROGRESS_STAGE_TITLES[stage]}).`,
    {
      hint: 'Wait for the current step to finish, or cancel it, then try again.',
      details: { reason: 'pipeline-busy', sessionId, operation, activeStage: stage },
    },
  );
}

/** The refusal of an operation on a session the manager does not hold. */
function sessionNotFoundError(sessionId: string): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', 'This debugging session no longer exists.', {
    hint: 'Start a new session from the Debug Generator view in VS Code.',
    details: { reason: 'session-not-found', sessionId },
  });
}

/** The refusal of a restart while the session's instrumentation is still installed. */
function instrumentationInstalledError(sessionId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'This session’s instrumentation is still installed, so its pipeline cannot start over.',
    {
      hint: 'Start a capture, ask a follow-up question, or end the session so its instrumentation is removed.',
      details: { reason: 'instrumentation-installed', sessionId },
    },
  );
}

/** A capture analysed for a session that never recorded a problem understanding. */
function missingUnderstandingError(sessionId: string, captureId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'This session has no recorded problem understanding to analyze its capture against.',
    {
      hint: 'Start the session again from VS Code so the question is understood before capturing.',
      details: { reason: 'missing-understanding', sessionId, captureId },
    },
  );
}

/** The refusal of an operation after {@link PipelineOrchestrator.dispose}. */
function disposedError(sessionId: string): DebuggenError {
  return new DebuggenError('INTERNAL', 'The Debug Generator service is shutting down.', {
    hint: 'Restart the Debug Generator service, then try again.',
    details: { reason: 'orchestrator-disposed', sessionId },
  });
}

/**
 * The cancellation this module observes between stages — the same shape every
 * pipeline layer reports (`INTERNAL`, `details.reason: "aborted"`), so a
 * cancellation is recognised the same way whichever layer saw it first.
 */
function cancelledError(sessionId: string, stage: PipelineStageKey): DebuggenError {
  return new DebuggenError('INTERNAL', 'The debugging step was cancelled before it finished.', {
    hint: 'Run the step again when you are ready.',
    details: { reason: 'aborted', sessionId, stage },
  });
}

/** Whether `error` reports a cancellation, whichever layer raised it. */
function isCancellation(error: DebuggenError): boolean {
  return error.details?.['reason'] === 'aborted';
}

/**
 * Whether `error` is a refusal of the request itself — a state the session
 * does not admit, or a session that does not exist — rather than a failure of
 * work that started. Only meaningful before the operation changed any status.
 */
function isRequestRefusal(error: DebuggenError): boolean {
  return error.code === 'SESSION_INVALID_STATE' || error.code === 'SESSION_NOT_FOUND';
}

/** Whether `value` names one of the pipeline's stages. */
function isPipelineStage(value: unknown): value is PipelineStageKey {
  return typeof value === 'string' && (PIPELINE_STAGE_ORDER as readonly string[]).includes(value);
}

/**
 * The stage a failure belongs to: the stage the error names in
 * `details.stage` (the plan and follow-up stages tag theirs, because one call
 * spans several stages), else the stage the orchestrator was running.
 */
function stageOfFailure(error: DebuggenError, running: PipelineStageKey): PipelineStageKey {
  const named = error.details?.['stage'];
  return isPipelineStage(named) ? named : running;
}

/** The {@link SessionFailure} of `error`, filed under `stage`: the subsystem's own code, message and hint. */
function failureOf(stage: PipelineStageKey, error: DebuggenError): SessionFailure {
  return error.hint === undefined
    ? { stage, code: error.code, message: error.message }
    : { stage, code: error.code, message: error.message, hint: error.hint };
}

/**
 * Merges `incoming` records into `current` by id: a record already present is
 * replaced in place (its status may have moved), a new one is appended in
 * application order.
 */
function mergeModifications(
  current: readonly ModificationRecord[],
  incoming: readonly ModificationRecord[],
): readonly ModificationRecord[] {
  const byId = new Map(incoming.map((record) => [record.id, record]));
  const merged = current.map((record) => byId.get(record.id) ?? record);
  const known = new Set(current.map((record) => record.id));
  for (const record of incoming) {
    if (!known.has(record.id)) {
      merged.push(record);
      known.add(record.id);
    }
  }
  return merged;
}

/** Appends `value` to `list` unless an element with the same key is already present. */
function appendUnique<T>(list: readonly T[], value: T, key: (item: T) => string): readonly T[] {
  const wanted = key(value);
  return list.some((item) => key(item) === wanted) ? list : [...list, value];
}

/**
 * Whether `version` names a version at all. Its format is the session schema's
 * to judge (`packages/protocol/src/session-record.ts`), when the record is
 * patched; it is not restated here.
 */
function isRecordableVersion(version: unknown): version is string {
  return typeof version === 'string' && version.length > 0;
}

/**
 * The prompt versions to record: every version a stage reported, then every
 * version already recorded, then — when `manifest` is given, at the start of a
 * session — the manifest's current version of every stage that did not run
 * yet, so a later stage, a reopened session and a follow-up all stay on the
 * prompts the session started with.
 */
function mergePromptVersions(
  recorded: PromptVersions,
  reported: Readonly<Partial<Record<PromptStage, string>>>,
  manifest: Readonly<Partial<Record<PromptStage, string>>> | undefined,
): PromptVersions {
  const merged: Partial<Record<PromptStage, string>> = {};
  for (const stage of PROMPT_STAGES) {
    const candidate = [reported[stage], recorded[stage], manifest?.[stage]].find(
      isRecordableVersion,
    );
    if (candidate !== undefined) {
      merged[stage] = candidate;
    }
  }
  return merged;
}

/** Whether two prompt-version records name the same version for every stage. */
function samePromptVersions(left: PromptVersions, right: PromptVersions): boolean {
  return PROMPT_STAGES.every((stage) => left[stage] === right[stage]);
}

/**
 * Runs a collaborator call that is contracted never to throw, converting a
 * throw into the `Err` it should have been.
 */
async function settle<T>(
  call: () => Promise<Result<T, DebuggenError>> | Result<T, DebuggenError>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, 'INTERNAL'));
  }
}

/** The synchronous twin of {@link settle}, for the store's synchronous reads. */
function settleSync<T>(call: () => Result<T, DebuggenError>): Result<T, DebuggenError> {
  try {
    return call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, 'STORE_ERROR'));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Log records — fields are ids, stage names, versions, counts and codes; never content
 * ---------------------------------------------------------------------------------------------- */

/** Info record of a stage boundary. Fields: stage, capture id when known. */
const STAGE_STARTED_LOG = 'Pipeline stage started.';

/** Info record of a stage that returned its validated artifact. Fields: stage, timing. */
const STAGE_COMPLETED_LOG = 'Pipeline stage completed.';

/** Error record of a stage failure. Fields: stage, error code. */
const STAGE_FAILED_LOG = 'Pipeline stage failed; the session is filed as failed at that stage.';

/** Info record of a cancelled operation. Fields: stage, error code. */
const CANCELLED_LOG = 'Pipeline operation cancelled; the session is filed as failed at that stage.';

/** Info record of a refused operation that changed nothing. Fields: operation, error code. */
const REFUSED_LOG = 'Pipeline operation refused; the session is unchanged.';

/** Warn record of a failure that could not be filed on the session. Fields: stage, error code. */
const FAIL_TRANSITION_LOG =
  'A pipeline failure could not be filed on the session; its status could not move to failed.';

/** Warn record of a progress row that could not be sent. Fields: stage, error code. */
const PROGRESS_ROW_LOG = 'A pipeline progress row could not be sent; the operation continues.';

/** Warn record of a record mirror that could not be stored. Fields: field, error code. */
const MIRROR_FAILED_LOG =
  'A pipeline artifact could not be mirrored onto the session record; its own store holds it.';

/** Warn record of prompt versions that could not be stored or read. Fields: error code. */
const PROMPT_VERSIONS_LOG = 'The prompt versions of a pipeline run could not be recorded.';

/** Warn record of observed readiness facts that could not be collected. Fields: error code. */
const OBSERVE_READINESS_LOG =
  'Observed readiness facts could not be collected; planning proceeds as if nothing had reported.';

/** Warn record of a readiness re-evaluation that failed. Fields: error code. */
const REEVALUATE_READINESS_LOG =
  'Readiness could not be re-evaluated at capture time; the install verdict is used.';

/** Info record of a finished operation. Fields: operation, status, timing. */
const OPERATION_COMPLETED_LOG = 'Pipeline operation completed.';

/** Debug record of a deferred re-gate that did not run. Fields: session id, error code. */
const REGATE_FAILED_LOG = 'A deferred readiness re-gate did not run.';

/* -------------------------------------------------------------------------------------------------
 * The orchestrator
 * ---------------------------------------------------------------------------------------------- */

/** The status Stage 1 runs under, from the state machine's table. */
const UNDERSTANDING_STATUS = statusOrThrow(UNDERSTAND_STAGE);

/** The status the installation runs under, from the state machine's table. */
const INSTRUMENTING_STATUS = statusOrThrow(INSTRUMENT_STAGE);

/** The status analysis and panel generation run under, from the state machine's table. */
const ANALYZING_STATUS = statusOrThrow(ANALYZE_STAGE);

/** The stage each follow-up path enters first; checked exhaustive over `FollowUpPath`. */
const FOLLOW_UP_PATH_STAGE = Object.freeze({
  'existing-evidence': ANALYZE_STAGE,
  'new-capture': PLAN_STAGE,
} as const satisfies Readonly<Record<FollowUpPath, PipelineStageKey>>);

/** One operation in flight for one session. */
interface ActiveOperation {
  readonly sessionId: string;
  readonly operation: PipelineOperation;
  /** The stage the operation is at; what {@link PipelineOrchestrator.activeRun} reports. */
  stage: PipelineStageKey;
  /** Aborted by {@link PipelineOrchestrator.cancel} and {@link PipelineOrchestrator.dispose}. */
  readonly controller: AbortController;
  /** The operation's signal: the controller's, joined with the caller's. */
  readonly signal: AbortSignal;
  /** The session-bound logger; re-bound with the capture id once the operation knows it. */
  log: Logger;
  /** When the operation started, by the injected clock. */
  readonly startedAt: number;
  /** The project whose code handles the operation loaded, if it loaded any. */
  projectRoot: string | undefined;
  /**
   * Whether the operation has moved the session's status. Before it has, a
   * refusal is returned unchanged and nothing is filed as a failure.
   */
  statusChanged: boolean;
  /** The prompt versions the stages of this operation reported. */
  readonly reported: Partial<Record<PromptStage, string>>;
}

/** The prompt versions recorded by one operation, and whether storing them succeeded. */
interface RecordedPromptVersions {
  readonly versions: PromptVersions;
  readonly recorded: boolean;
}

/**
 * Creates the pipeline orchestrator of one service process.
 *
 * The stages are constructed lazily from `./stages/*.js` with the injected
 * collaborators — or taken from `deps.stages` — so one instance serves every
 * session. Nothing is started by construction.
 *
 * @param deps The collaborators; see {@link PipelineOrchestratorDeps}.
 * @returns The orchestrator.
 *
 * @example
 * ```ts
 * const pipeline = createPipelineOrchestrator({
 *   config, logger, provider, promptLoader, contextBuilder, sessions, progress,
 *   sessionsRepo, panelsRepo, telemetryRepo, instrumentation, modifications,
 *   summarizer, facts, panelGenerator, adapters,
 * });
 *
 * const planned = await pipeline.run({ sessionId });
 * const armed = await pipeline.beginCapture({ sessionId });
 * const analysed = await pipeline.completeCapture({ sessionId });
 * const answered = await pipeline.followUp({ sessionId, question });
 * ```
 */
export function createPipelineOrchestrator(deps: PipelineOrchestratorDeps): PipelineOrchestrator {
  const { sessions, progress, instrumentation } = deps;
  const log = subsystemLogger(deps.logger, PIPELINE_SUBSYSTEM);
  const clock = deps.now ?? nowEpochMs;
  const codeIndex =
    deps.codeIndex ?? createCodeIndexLoader({ config: deps.config, logger: deps.logger });
  const overrides: StageOverrides = deps.stages ?? {};

  /** The one operation in flight per session. */
  const active = new Map<string, ActiveOperation>();
  /** Sessions whose re-gate was asked for while another operation held them. */
  const pendingRegates = new Set<string>();
  /** Every operation's settlement, for {@link dispose}. */
  const settling = new Set<Promise<unknown>>();
  /** The failure a stage tried to report through {@link stageProgress}, per session. */
  const recordedFailures = new Map<string, SessionFailure>();
  /** The last readiness verdict reached for each session: the gate a capture arms on. */
  const verdicts = new Map<string, ReadinessVerdict>();
  /** The project roots whose code handles an operation loaded. */
  const loadedRoots = new Set<string>();
  let disposed = false;
  let disposing: Promise<void> | undefined;

  /* ----------------------------------------------------------------------------------------------
   * The views the default stages are built with
   * -------------------------------------------------------------------------------------------- */

  /**
   * The progress emitter every stage is handed: `session.progress` exactly as
   * the service's emitter sends it, except that a stage's `failed` row is
   * **recorded, not sent**. The failure it describes reaches the developer
   * once, through the session manager's transition into `failed`
   * ({@link failStage}), which writes that row as part of the transition.
   */
  const stageProgress: SessionProgress = Object.freeze({
    emit: (sessionId, row) => progress.emit(sessionId, row),
    stageStarted: (sessionId, stage, message) => progress.stageStarted(sessionId, stage, message),
    stageCompleted: (sessionId, stage, message) =>
      progress.stageCompleted(sessionId, stage, message),
    stageFailed: (sessionId, failure) => {
      recordedFailures.set(sessionId, failure);
      const row: SessionProgressPayload = {
        sessionId,
        stage: failure.stage,
        status: FAILED_ROW_STATUS,
        message: failure.message,
      };
      return ok(row);
    },
    finding: (sessionId, stage, message, detail) =>
      progress.finding(sessionId, stage, message, detail),
    reportInvestigation: (sessionId, findings) => progress.reportInvestigation(sessionId, findings),
    reportInstrumentation: (sessionId, installed) =>
      progress.reportInstrumentation(sessionId, installed),
    readyToCapture: (sessionId) => progress.readyToCapture(sessionId),
  } satisfies SessionProgress);

  /**
   * The installer the plan and follow-up stages are handed: the service's own,
   * asked not to emit the instrument stage's `failed` row, because the session
   * manager emits it when the failure moves the session to `failed`.
   */
  const quietInstaller: Pick<InstrumentationService, 'buildContext' | 'install'> = Object.freeze({
    buildContext: (input) => instrumentation.buildContext(input),
    install: (request: InstallRequest) =>
      instrumentation.install({ ...request, reportStageFailure: false }),
  } satisfies Pick<InstrumentationService, 'buildContext' | 'install'>);

  /** The default stages, built on first use. */
  const built: { -readonly [K in keyof PipelineStages]?: PipelineStages[K] } = {};

  const stages = Object.freeze({
    understand: (): UnderstandStage =>
      overrides.understand ??
      (built.understand ??= createUnderstandStage({
        contextBuilder: deps.contextBuilder,
        provider: deps.provider,
        progress: stageProgress,
        logger: deps.logger,
      })),
    investigate: (): InvestigateStage =>
      overrides.investigate ??
      (built.investigate ??= createInvestigateStage({
        contextBuilder: deps.contextBuilder,
        provider: deps.provider,
        progress: stageProgress,
        logger: deps.logger,
      })),
    plan: (): PlanStage =>
      overrides.plan ??
      (built.plan ??= createPlanStage({
        contextBuilder: deps.contextBuilder,
        provider: deps.provider,
        registry: deps.adapters,
        instrumentation: quietInstaller,
        sessions: deps.sessionsRepo,
        sessionManager: sessions,
        progress: stageProgress,
        logger: deps.logger,
      })),
    capture: (): CaptureStage =>
      overrides.capture ??
      (built.capture ??= createCaptureStage({
        instrumentation: instrumentation satisfies CaptureInstrumentationPort,
        sessions: deps.sessionsRepo,
        telemetry: deps.telemetryRepo,
        sessionManager: sessions,
        progress: stageProgress,
        registry: deps.adapters,
        logger: deps.logger,
        now: clock,
        reportStageBoundaries: false,
      })),
    analyze: (): AnalyzeStage =>
      overrides.analyze ??
      (built.analyze ??= createAnalyzeStage({
        contextBuilder: deps.contextBuilder,
        provider: deps.provider,
        summarizer: deps.summarizer,
        facts: deps.facts,
        panels: deps.panelsRepo,
        progress: stageProgress,
        logger: deps.logger,
        reportStageBoundaries: false,
        broadcaster: deps.broadcaster,
      })),
    generatePanel: (): GeneratePanelStage =>
      overrides.generatePanel ??
      (built.generatePanel ??= createGeneratePanelStage({
        panelGenerator: deps.panelGenerator,
        progress: stageProgress,
        logger: deps.logger,
        reportStageBoundaries: false,
      })),
    followUp: (): FollowUpStage =>
      overrides.followUp ??
      (built.followUp ??= createFollowUpStage({
        contextBuilder: deps.contextBuilder,
        provider: deps.provider,
        summarizer: deps.summarizer,
        facts: deps.facts,
        // The existing-evidence path's analysis emits its own `analyze` group:
        // the follow-up stage emits none for that step.
        analysisRegeneration: createAnalyzeStage({
          contextBuilder: deps.contextBuilder,
          provider: deps.provider,
          summarizer: deps.summarizer,
          facts: deps.facts,
          panels: deps.panelsRepo,
          progress: stageProgress,
          logger: deps.logger,
          reportStageBoundaries: true,
          broadcaster: deps.broadcaster,
        }),
        panelRegeneration: deps.panelGenerator,
        instrumentation: quietInstaller,
        registry: deps.adapters,
        sessions: deps.sessionsRepo,
        panels: deps.panelsRepo,
        modifications: deps.modifications,
        sessionManager: sessions,
        progress: stageProgress,
        logger: deps.logger,
      })),
  });

  /* ----------------------------------------------------------------------------------------------
   * Small steps shared by the operations
   * -------------------------------------------------------------------------------------------- */

  /** Sends one progress row; a failure to send is logged and never fails the operation. */
  function sendRow(
    op: ActiveOperation,
    stage: PipelineStageKey,
    send: () => Result<unknown, DebuggenError>,
  ): void {
    let sent: Result<unknown, DebuggenError>;
    try {
      sent = send();
    } catch (thrown) {
      sent = err(DebuggenError.from(thrown, 'INTERNAL'));
    }
    if (!sent.ok) {
      op.log.warn(PROGRESS_ROW_LOG, { stage, code: sent.error.code });
    }
  }

  /** The stored session record, or `SESSION_NOT_FOUND`. */
  function readSession(sessionId: string): Result<SessionRecord, DebuggenError> {
    let got: Result<SessionRecord | undefined, DebuggenError>;
    try {
      got = sessions.get(sessionId);
    } catch (thrown) {
      got = err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }
    if (!got.ok) {
      return got;
    }
    return got.value === undefined ? err(sessionNotFoundError(sessionId)) : ok(got.value);
  }

  /** Moves the session through the manager — the only writer of status. */
  async function moveTo(
    op: ActiveOperation,
    to: SessionStatus,
    context?: SessionTransitionContext,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    const moved = await settle(() => sessions.transitionTo(op.sessionId, to, context));
    if (moved.ok) {
      op.statusChanged = true;
    }
    return moved;
  }

  /**
   * Makes `stage` the operation's current stage and moves the session to the
   * status that stage runs under, when it owns one and the session is not
   * already there — so consecutive stages sharing a status (analyze and
   * generate-panel) and a seam a stage may have called already are no-ops.
   */
  async function enterStage(
    op: ActiveOperation,
    stage: PipelineStageKey,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    op.stage = stage;
    op.log.info(STAGE_STARTED_LOG, { stage });
    const current = readSession(op.sessionId);
    if (!current.ok) {
      return current;
    }
    const status = statusForStage(stage);
    if (status === undefined || current.value.status === status) {
      return current;
    }
    return moveTo(op, status);
  }

  /**
   * Files a failure: moves the session to `failed` through the manager, which
   * writes the failing stage's `failed` row as part of the transition, and
   * returns `error` unchanged.
   *
   * The failure filed is the one the stage itself reported through
   * {@link stageProgress} when it did, else the error's own code, message and
   * hint under the stage the error names (or the stage running). A session
   * already `failed` keeps its status and still shows the new row; an ended
   * session is left alone.
   */
  async function failStage(
    op: ActiveOperation,
    stage: PipelineStageKey,
    error: DebuggenError,
  ): Promise<Result<never, DebuggenError>> {
    const reported = recordedFailures.get(op.sessionId);
    recordedFailures.delete(op.sessionId);
    const failure = reported ?? failureOf(stageOfFailure(error, stage), error);

    if (isCancellation(error)) {
      op.log.info(CANCELLED_LOG, { stage: failure.stage, code: error.code });
    } else {
      op.log.error(STAGE_FAILED_LOG, { stage: failure.stage, code: error.code });
    }

    const current = readSession(op.sessionId);
    if (current.ok) {
      const status = current.value.status;
      if (status === FAILED_STATUS) {
        sendRow(op, failure.stage, () => progress.stageFailed(op.sessionId, failure));
      } else if (!isTerminalSessionStatus(status)) {
        const moved = await moveTo(op, FAILED_STATUS, { failure });
        if (!moved.ok) {
          op.log.warn(FAIL_TRANSITION_LOG, { stage: failure.stage, code: moved.error.code });
        }
      }
    }
    return err(error);
  }

  /**
   * Returns a refusal unchanged when the operation has not moved the session
   * yet, and files it as a failure of `stage` otherwise.
   */
  async function refuseOrFail(
    op: ActiveOperation,
    stage: PipelineStageKey,
    error: DebuggenError,
  ): Promise<Result<never, DebuggenError>> {
    if (!op.statusChanged && isRequestRefusal(error)) {
      recordedFailures.delete(op.sessionId);
      op.log.info(REFUSED_LOG, { operation: op.operation, code: error.code });
      return err(error);
    }
    return failStage(op, stage, error);
  }

  /** Loads the project's code handles through the index port, for the whole operation. */
  async function loadCode(
    op: ActiveOperation,
    projectRoot: string,
    refresh: boolean,
  ): Promise<Result<PipelineCodeHandles, DebuggenError>> {
    op.projectRoot = normalizePosix(projectRoot);
    const loadedCode = await settle(() =>
      codeIndex.load(projectRoot, { signal: op.signal, refresh }),
    );
    if (loadedCode.ok) {
      loadedRoots.add(op.projectRoot);
    }
    return loadedCode;
  }

  /** Releases a project's code handles unless another operation in flight still uses them. */
  function releaseCode(projectRoot: string): void {
    for (const other of active.values()) {
      if (other.projectRoot === projectRoot) {
        return;
      }
    }
    loadedRoots.delete(projectRoot);
    codeIndex.invalidate?.(projectRoot);
  }

  /**
   * Runs one stage call against a stage context built from the **fresh**
   * session record — a tab may have bound, or the record moved, since the
   * operation began — and files its failure. `extras` carries the capture and
   * the follow-up question, passed through untouched.
   */
  async function inStage<T>(
    op: ActiveOperation,
    code: PipelineCodeHandles,
    extras: { readonly captureId?: string; readonly followUpQuestion?: string },
    call: (context: PipelineStageContext) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    if (op.signal.aborted) {
      return failStage(op, op.stage, cancelledError(op.sessionId, op.stage));
    }
    const session = readSession(op.sessionId);
    if (!session.ok) {
      return refuseOrFail(op, op.stage, session.error);
    }
    const context = createPipelineStageContext({
      session: session.value,
      code,
      logger: log,
      now: clock,
      signal: op.signal,
      ...(extras.captureId !== undefined ? { captureId: extras.captureId } : {}),
      ...(extras.followUpQuestion !== undefined
        ? { followUpQuestion: extras.followUpQuestion }
        : {}),
    });
    if (!context.ok) {
      return refuseOrFail(op, op.stage, context.error);
    }

    const started = clock();
    const outcome = await settle(() => call(context.value));
    if (!outcome.ok) {
      return refuseOrFail(op, op.stage, outcome.error);
    }
    op.log.info(STAGE_COMPLETED_LOG, {
      stage: op.stage,
      durationMs: Math.max(0, clock() - started),
    });
    return outcome;
  }

  /** The capture stage's slice of a stage context; opening or closing a window needs no code index. */
  function captureContext(op: ActiveOperation, session: SessionRecord): CaptureStageContext {
    return {
      sessionId: session.id,
      session,
      projectRoot: normalizePosix(session.projectRoot),
      logger: sessionLogger(log, session.id),
      now: clock,
      signal: op.signal,
    };
  }

  /** Whether the session still has instrumentation installed: arming state here, or an open record. */
  function hasLiveInstrumentation(session: SessionRecord): boolean {
    return (
      instrumentation.arming(session.id) !== undefined ||
      session.modifications.some((record) => isOpenModificationStatus(record.status))
    );
  }

  /** The readiness facts observed for the session, or `undefined` when none could be collected. */
  async function observedReadiness(
    op: ActiveOperation,
    session: SessionRecord,
  ): Promise<ObservedReadinessInputs | undefined> {
    const observe = deps.observeReadiness;
    if (observe === undefined) {
      return undefined;
    }
    const observed = await settle(() =>
      observe({
        sessionId: session.id,
        projectRoot: normalizePosix(session.projectRoot),
        boundTab: session.boundTab,
        devServerUrl: session.devServerUrl,
        signal: op.signal,
      }),
    );
    if (!observed.ok) {
      op.log.warn(OBSERVE_READINESS_LOG, { code: observed.error.code });
      return undefined;
    }
    return observed.value;
  }

  /**
   * Mirrors an artifact onto the session record (`modifications`, `analyses`,
   * `panelIds`), which both user interfaces render. The artifact's own store
   * is authoritative, so a mirror that cannot be written is logged, not fatal.
   */
  async function mirror(
    op: ActiveOperation,
    field: keyof SessionPatch,
    build: (session: SessionRecord) => SessionPatch | undefined,
  ): Promise<void> {
    const session = readSession(op.sessionId);
    if (!session.ok) {
      op.log.warn(MIRROR_FAILED_LOG, { field, code: session.error.code });
      return;
    }
    const patch = build(session.value);
    if (patch === undefined) {
      return;
    }
    const patched = await settle(() => sessions.patch(op.sessionId, patch));
    if (!patched.ok) {
      op.log.warn(MIRROR_FAILED_LOG, { field, code: patched.error.code });
    }
  }

  /** Mirrors the records an install applied onto `session.modifications`. */
  function mirrorModifications(
    op: ActiveOperation,
    applied: readonly ModificationRecord[],
  ): Promise<void> {
    return mirror(op, 'modifications', (session) =>
      applied.length === 0
        ? undefined
        : { modifications: mergeModifications(session.modifications, applied) },
    );
  }

  /** Mirrors a stored analysis onto `session.analyses`. */
  function mirrorAnalysis(op: ActiveOperation, analysis: AnalysisResult): Promise<void> {
    return mirror(op, 'analyses', (session) => {
      const analyses = appendUnique(session.analyses, analysis, (item) => item.id);
      return analyses === session.analyses ? undefined : { analyses };
    });
  }

  /** Mirrors a stored panel's id onto `session.panelIds`. */
  function mirrorPanel(op: ActiveOperation, panel: Pick<PanelSpec, 'id'>): Promise<void> {
    return mirror(op, 'panelIds', (session) => {
      const panelIds = appendUnique(session.panelIds, panel.id, (item) => item);
      return panelIds === session.panelIds ? undefined : { panelIds };
    });
  }

  /**
   * Records the prompt versions the operation's stages reported — and, at the
   * start of a session, the manifest's current version of every stage that has
   * not run yet — on the session, so every later stage, a reopened session and
   * a follow-up load the same prompt through `PromptLoader.loadVersion`.
   */
  async function recordPromptVersions(
    op: ActiveOperation,
    withManifest: boolean,
  ): Promise<RecordedPromptVersions> {
    const session = readSession(op.sessionId);
    if (!session.ok) {
      op.log.warn(PROMPT_VERSIONS_LOG, { code: session.error.code });
      return { versions: {}, recorded: false };
    }

    let manifest: Readonly<Partial<Record<PromptStage, string>>> | undefined;
    if (withManifest) {
      let current: Result<Readonly<Record<PromptStage, string>>, DebuggenError>;
      try {
        current = deps.promptLoader.versions();
      } catch (thrown) {
        current = err(DebuggenError.from(thrown, 'INTERNAL'));
      }
      if (current.ok) {
        manifest = current.value;
      } else {
        op.log.warn(PROMPT_VERSIONS_LOG, { code: current.error.code });
      }
    }

    const recorded = session.value.promptVersions;
    const versions = mergePromptVersions(recorded, op.reported, manifest);
    if (samePromptVersions(recorded, versions)) {
      return { versions, recorded: true };
    }
    const patched = await settle(() => sessions.patch(op.sessionId, { promptVersions: versions }));
    if (!patched.ok) {
      op.log.warn(PROMPT_VERSIONS_LOG, { code: patched.error.code });
      return { versions: recorded, recorded: false };
    }
    return { versions, recorded: true };
  }

  /**
   * Re-evaluates readiness for the session's active plan, when the
   * instrumentation layer offers it; otherwise, or when it fails, the last
   * verdict reached for the session.
   */
  async function currentVerdict(
    op: ActiveOperation,
    session: SessionRecord,
  ): Promise<ReadinessVerdict | undefined> {
    const remembered = verdicts.get(session.id);
    const latest = settleSync(() => deps.sessionsRepo.latestPlanVersion(session.id));
    if (!latest.ok || latest.value === undefined) {
      return remembered;
    }
    const planVersion = latest.value;
    const plan = settleSync(() => deps.sessionsRepo.getPlan(session.id, planVersion));
    if (!plan.ok || plan.value === undefined) {
      return remembered;
    }
    const activePlan: InstrumentationPlan = plan.value;
    const pending = instrumentation.evaluateReadiness?.({
      sessionId: session.id,
      projectRoot: normalizePosix(session.projectRoot),
      plan: activePlan,
      boundTab: session.boundTab,
      signal: op.signal,
    });
    if (pending === undefined) {
      return remembered;
    }
    const evaluated = await settle(() => pending);
    if (!evaluated.ok) {
      op.log.warn(REEVALUATE_READINESS_LOG, { code: evaluated.error.code });
      return remembered;
    }
    verdicts.set(session.id, evaluated.value);
    return evaluated.value;
  }

  /**
   * Runs one operation: refuses a second one for a busy session, joins the
   * caller's signal to the operation's own, and clears the operation's state
   * however it ends. An unexpected throw is filed as a failure of the stage
   * running once the operation has moved the session, and returned unchanged
   * before.
   */
  function execute<T>(
    operation: PipelineOperation,
    sessionId: string,
    stage: PipelineStageKey,
    callerSignal: AbortSignal | undefined,
    body: (op: ActiveOperation) => Promise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    if (disposed) {
      return Promise.resolve(err(disposedError(sessionId)));
    }
    const busy = active.get(sessionId);
    if (busy !== undefined) {
      return Promise.resolve(err(busyError(sessionId, operation, busy.stage)));
    }

    const controller = new AbortController();
    const op: ActiveOperation = {
      sessionId,
      operation,
      stage,
      controller,
      signal:
        callerSignal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, callerSignal]),
      log: sessionLogger(log, sessionId),
      startedAt: clock(),
      projectRoot: undefined,
      statusChanged: false,
      reported: {},
    };
    active.set(sessionId, op);
    recordedFailures.delete(sessionId);

    const settled = (async (): Promise<Result<T, DebuggenError>> => {
      try {
        const outcome = await body(op);
        if (outcome.ok) {
          const after = readSession(sessionId);
          op.log.info(OPERATION_COMPLETED_LOG, {
            operation,
            ...(after.ok ? { status: after.value.status } : {}),
            durationMs: Math.max(0, clock() - op.startedAt),
          });
        }
        return outcome;
      } catch (thrown) {
        const error = DebuggenError.from(thrown, 'INTERNAL');
        return op.statusChanged ? failStage(op, op.stage, error) : err(error);
      } finally {
        if (active.get(sessionId) === op) {
          active.delete(sessionId);
        }
        recordedFailures.delete(sessionId);
        if (pendingRegates.delete(sessionId) && !disposed) {
          // After this operation has fully released the session.
          queueMicrotask(() => {
            void regate({ sessionId }).then((outcome) => {
              if (!outcome.ok) {
                log.debug(REGATE_FAILED_LOG, { sessionId, code: outcome.error.code });
              }
            });
          });
        }
        if (controller.signal.aborted && op.projectRoot !== undefined) {
          releaseCode(op.projectRoot);
        }
      }
    })();

    settling.add(settled);
    void settled.finally(() => settling.delete(settled));
    return settled;
  }

  /* ----------------------------------------------------------------------------------------------
   * run — Stages 1–3 and the installation
   * -------------------------------------------------------------------------------------------- */

  function run(request: PipelineRunRequest): Promise<Result<PipelineRunOutcome, DebuggenError>> {
    const { sessionId } = request;

    return execute<PipelineRunOutcome>(
      'run',
      sessionId,
      UNDERSTAND_STAGE,
      request.signal,
      async (op) => {
        if (op.signal.aborted) {
          return err(cancelledError(sessionId, UNDERSTAND_STAGE));
        }
        const initial = readSession(sessionId);
        if (!initial.ok) {
          return initial;
        }
        const startable = transition(initial.value.status, UNDERSTANDING_STATUS);
        if (!startable.ok) {
          return startable;
        }
        if (initial.value.status === FAILED_STATUS && hasLiveInstrumentation(initial.value)) {
          return err(instrumentationInstalledError(sessionId));
        }

        // Stage 1 — problem understanding. The index is refreshed once for the run
        // (the on-disk cache spares unchanged files) and shared by every stage.
        const entered = await enterStage(op, UNDERSTAND_STAGE);
        if (!entered.ok) {
          return refuseOrFail(op, UNDERSTAND_STAGE, entered.error);
        }
        const code = await loadCode(op, entered.value.projectRoot, true);
        if (!code.ok) {
          return failStage(op, UNDERSTAND_STAGE, code.error);
        }
        const understood = await inStage(op, code.value, {}, (context) =>
          stages.understand().run(context, {}),
        );
        if (!understood.ok) {
          return understood;
        }
        const { understanding } = understood.value;
        op.reported.understand = understood.value.promptVersion;
        const keptUnderstanding = await settle(() => sessions.patch(sessionId, { understanding }));
        if (!keptUnderstanding.ok) {
          return failStage(op, UNDERSTAND_STAGE, keptUnderstanding.error);
        }

        // Stage 2 — code investigation; its findings rows are the stage's own.
        const investigating = await enterStage(op, INVESTIGATE_STAGE);
        if (!investigating.ok) {
          return failStage(op, INVESTIGATE_STAGE, investigating.error);
        }
        const investigated = await inStage(op, code.value, {}, (context) =>
          stages.investigate().run(context, { understanding }),
        );
        if (!investigated.ok) {
          return investigated;
        }
        const { investigation } = investigated.value;
        op.reported.investigate = investigated.value.promptVersion;
        const keptFiles = await settle(() =>
          sessions.patch(sessionId, { relevantFiles: investigation.relevantFiles }),
        );
        if (!keptFiles.ok) {
          return failStage(op, INVESTIGATE_STAGE, keptFiles.error);
        }

        // Stage 3 — planning. The stage validates, records and installs the plan;
        // its `beforeInstall` seam is where the session moves to `instrumenting`.
        const planning = await enterStage(op, PLAN_STAGE);
        if (!planning.ok) {
          return failStage(op, PLAN_STAGE, planning.error);
        }
        const readiness = await observedReadiness(op, planning.value);
        const planned = await inStage(op, code.value, {}, (context) =>
          stages.plan().run(context, {
            understanding,
            investigation,
            ...(readiness !== undefined ? { readiness } : {}),
            beforeInstall: () => enterStage(op, INSTRUMENT_STAGE),
          }),
        );
        if (!planned.ok) {
          return planned;
        }
        op.reported.plan = planned.value.promptVersion;

        // Installation happened inside the plan stage; the readiness verdict it
        // reached gates the guarded `instrumenting → ready` edge.
        const instrumenting = await enterStage(op, INSTRUMENT_STAGE);
        if (!instrumenting.ok) {
          return failStage(op, INSTRUMENT_STAGE, instrumenting.error);
        }
        const { installation } = planned.value;
        await mirrorModifications(op, installation.applied);
        verdicts.set(sessionId, installation.readiness);

        const admitted = await admitReadiness(op, installation);
        if (!admitted.ok) {
          return admitted;
        }
        const prompts = await recordPromptVersions(op, true);

        return ok(
          Object.freeze({
            sessionId,
            status: admitted.value.status,
            ready: installation.readiness.satisfied,
            planVersion: planned.value.planVersion,
            fallbackPlan: planned.value.fallback,
            relevantFileCount: investigation.relevantFiles.length,
            appliedModifications: installation.applied.length,
            degradations: installation.degradations,
            readiness: installation.readiness,
            promptVersions: prompts.versions,
            promptVersionsRecorded: prompts.recorded,
          }),
        );
      },
    );
  }

  /**
   * Takes the guarded `instrumenting → ready` edge when the install's
   * readiness verdict is satisfied; otherwise the session stays
   * `instrumenting` (the gate has already asked for what it lacks, and a
   * capture re-evaluates it). The "Ready to capture" row is the gate's own.
   */
  async function admitReadiness(
    op: ActiveOperation,
    installation: InstrumentationOutcome,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    if (op.signal.aborted) {
      return failStage(op, INSTRUMENT_STAGE, cancelledError(op.sessionId, INSTRUMENT_STAGE));
    }
    if (!installation.readiness.satisfied) {
      const current = readSession(op.sessionId);
      return current.ok ? current : failStage(op, INSTRUMENT_STAGE, current.error);
    }
    const ready = await moveTo(op, READY_STATUS, { readinessSatisfied: true });
    return ready.ok ? ready : failStage(op, INSTRUMENT_STAGE, ready.error);
  }

  /* ----------------------------------------------------------------------------------------------
   * regate — the readiness gate, re-run when the bound tab's page agent reports
   * -------------------------------------------------------------------------------------------- */

  function regate(request: RegateRequest): Promise<Result<RegateOutcome, DebuggenError>> {
    const { sessionId } = request;
    const outcomeOf = (outcome: RegateOutcome['outcome'], status: SessionStatus): RegateOutcome =>
      Object.freeze({ sessionId, outcome, status, ready: status === READY_STATUS });

    if (!disposed && active.has(sessionId)) {
      pendingRegates.add(sessionId);
      const current = readSession(sessionId);
      return Promise.resolve(
        current.ok ? ok(outcomeOf('deferred', current.value.status)) : current,
      );
    }

    return execute<RegateOutcome>(
      'regate',
      sessionId,
      INSTRUMENT_STAGE,
      request.signal,
      async (op) => {
        const initial = readSession(sessionId);
        if (!initial.ok) {
          return initial;
        }
        if (initial.value.status !== INSTRUMENTING_STATUS) {
          return ok(outcomeOf('skipped', initial.value.status));
        }
        const verdict = await currentVerdict(op, initial.value);
        if (op.signal.aborted) {
          return err(cancelledError(sessionId, INSTRUMENT_STAGE));
        }
        if (verdict?.satisfied !== true) {
          return ok(outcomeOf('regated', INSTRUMENTING_STATUS));
        }
        // A refused edge leaves the session `instrumenting`; a capture re-gates it.
        const ready = await moveTo(op, READY_STATUS, { readinessSatisfied: true });
        return ready.ok ? ok(outcomeOf('regated', ready.value.status)) : ready;
      },
    );
  }

  /* ----------------------------------------------------------------------------------------------
   * beginCapture — the readiness gate and an armed capture window
   * -------------------------------------------------------------------------------------------- */

  function beginCapture(
    request: CaptureBeginRequest,
  ): Promise<Result<CaptureBeginResult, DebuggenError>> {
    const { sessionId } = request;

    return execute<CaptureBeginResult>(
      'beginCapture',
      sessionId,
      CAPTURE_STAGE,
      request.signal,
      async (op) => {
        if (op.signal.aborted) {
          return err(cancelledError(sessionId, CAPTURE_STAGE));
        }
        const initial = readSession(sessionId);
        if (!initial.ok) {
          return initial;
        }
        let session = initial.value;

        // A page may have reloaded, or a tab bound, since the install: an
        // `instrumenting` session is re-gated now, and moves to `ready` only
        // through the guarded edge. A refusal is returned unchanged.
        if (session.status === INSTRUMENTING_STATUS) {
          const verdict = await currentVerdict(op, session);
          const readied = await moveTo(op, READY_STATUS, {
            readinessSatisfied: verdict?.satisfied === true,
          });
          if (!readied.ok) {
            op.log.info(REFUSED_LOG, { operation: op.operation, code: readied.error.code });
            return readied;
          }
          session = readied.value;
        }

        // The stage gates, opens the window and arms both producers; it closes
        // the window again when arming fails, so a refusal changes nothing.
        const remembered = verdicts.get(sessionId);
        const armed = await settle(() =>
          stages
            .capture()
            .arm(
              captureContext(op, session),
              remembered !== undefined ? { readiness: remembered } : {},
            ),
        );
        if (!armed.ok) {
          op.log.info(REFUSED_LOG, { operation: op.operation, code: armed.error.code });
          return armed;
        }

        op.statusChanged = true;
        op.log = sessionLogger(log, sessionId, armed.value.captureId);
        verdicts.set(sessionId, armed.value.readiness);
        sendRow(op, CAPTURE_STAGE, () => progress.stageStarted(sessionId, CAPTURE_STAGE));
        op.log.info(STAGE_STARTED_LOG, { stage: CAPTURE_STAGE });

        return ok(
          Object.freeze({
            captureId: armed.value.captureId,
            planVersion: armed.value.planVersion,
            readinessSource: armed.value.readinessSource,
            degradations: armed.value.degradations,
          }),
        );
      },
    );
  }

  /* ----------------------------------------------------------------------------------------------
   * completeCapture — the window closes, then Stage 5 and Stage 6
   * -------------------------------------------------------------------------------------------- */

  /**
   * The capture to resume: the session's latest, already stopped capture when
   * the session was left `analyzing` or `failed` after it — the retry path of
   * AAP §0.5.5. Otherwise the stage completes the open window.
   */
  function resumableCaptureId(session: SessionRecord): string | undefined {
    if (session.status !== ANALYZING_STATUS && session.status !== FAILED_STATUS) {
      return undefined;
    }
    const latest = session.captures.at(-1);
    return latest !== undefined && latest.stoppedAt !== undefined ? latest.id : undefined;
  }

  function completeCapture(
    request: CaptureCompleteRequest,
  ): Promise<Result<CaptureCompleteResult, DebuggenError>> {
    const { sessionId } = request;

    return execute<CaptureCompleteResult>(
      'completeCapture',
      sessionId,
      CAPTURE_STAGE,
      request.signal,
      async (op) => {
        if (op.signal.aborted) {
          return err(cancelledError(sessionId, CAPTURE_STAGE));
        }
        const initial = readSession(sessionId);
        if (!initial.ok) {
          return initial;
        }
        const session = initial.value;
        const resumeId = resumableCaptureId(session);

        // Stage 4 — no model call: disarm, summarise, classify, close the window
        // (to `analyzing` with evidence, to `ready` when empty).
        const completed = await settle(() =>
          stages
            .capture()
            .complete(
              captureContext(op, session),
              resumeId !== undefined ? { captureId: resumeId } : {},
            ),
        );
        if (!completed.ok) {
          const after = readSession(sessionId);
          if (after.ok && after.value.status !== session.status) {
            op.statusChanged = true;
          }
          return refuseOrFail(op, CAPTURE_STAGE, completed.error);
        }
        op.statusChanged = true;
        const { captureId, summary, emptiness } = completed.value;
        op.log = sessionLogger(log, sessionId, captureId);

        // AAP §0.5.5, "Capture yielded nothing": analysis is skipped and the
        // stage has already returned the session to `ready`.
        if (emptiness.empty) {
          if (completed.value.stoppedNow) {
            sendRow(op, CAPTURE_STAGE, () =>
              progress.stageCompleted(sessionId, CAPTURE_STAGE, emptiness.message),
            );
          }
          return ok(Object.freeze({ captureId, summary, emptyCapture: true }));
        }
        if (completed.value.stoppedNow) {
          sendRow(op, CAPTURE_STAGE, () => progress.stageCompleted(sessionId, CAPTURE_STAGE));
        }

        const current = readSession(sessionId);
        if (!current.ok) {
          return failStage(op, ANALYZE_STAGE, current.error);
        }
        const { understanding } = current.value;
        if (understanding === undefined) {
          return failStage(op, ANALYZE_STAGE, missingUnderstandingError(sessionId, captureId));
        }

        const analysing = await enterStage(op, ANALYZE_STAGE);
        if (!analysing.ok) {
          return failStage(op, ANALYZE_STAGE, analysing.error);
        }
        const code = await loadCode(op, analysing.value.projectRoot, false);
        if (!code.ok) {
          return failStage(op, ANALYZE_STAGE, code.error);
        }

        // Stage 5 — analysis. There is deliberately no fallback analysis: an
        // evidence rejection is a stage failure (AAP §0.5.3).
        sendRow(op, ANALYZE_STAGE, () => progress.stageStarted(sessionId, ANALYZE_STAGE));
        const analysed = await inStage(op, code.value, { captureId }, (context) =>
          stages.analyze().run(context, { captureId, understanding }),
        );
        if (!analysed.ok) {
          return analysed;
        }
        sendRow(op, ANALYZE_STAGE, () => progress.stageCompleted(sessionId, ANALYZE_STAGE));
        const { analysis } = analysed.value;
        op.reported.analyze = analysed.value.promptVersion;
        await mirrorAnalysis(op, analysis);

        // Stage 6 — panel generation, delegated to `../panels/generate.ts`, which
        // validates, falls back, stores and broadcasts `panel.generated` itself.
        const generating = await enterStage(op, GENERATE_PANEL_STAGE);
        if (!generating.ok) {
          return failStage(op, GENERATE_PANEL_STAGE, generating.error);
        }
        sendRow(op, GENERATE_PANEL_STAGE, () =>
          progress.stageStarted(sessionId, GENERATE_PANEL_STAGE),
        );
        const generated = await inStage(op, code.value, { captureId }, (context) =>
          stages.generatePanel().run(context, { captureId, analysis, summary }),
        );
        if (!generated.ok) {
          return generated;
        }
        sendRow(op, GENERATE_PANEL_STAGE, () =>
          progress.stageCompleted(sessionId, GENERATE_PANEL_STAGE),
        );
        const { panel } = generated.value;
        op.reported['generate-panel'] = generated.value.promptVersion;
        await mirrorPanel(op, panel);

        // The guarded edge: both validated artifacts in hand. A fallback panel is
        // a validated panel, so it satisfies the guard; its flag travels on.
        const done = await reachGenerated(op, analysis, panel);
        if (!done.ok) {
          return done;
        }
        const prompts = await recordPromptVersions(op, false);

        return ok(
          Object.freeze({
            captureId,
            summary,
            emptyCapture: false,
            analysis,
            panelId: generated.value.panelId,
            panelVersion: generated.value.panelVersion,
            fallback: generated.value.fallback,
            promptVersionsRecorded: prompts.recorded,
          }),
        );
      },
    );
  }

  /**
   * Takes the guarded `analyzing → generated` edge with the validated analysis
   * and panel — never after a cancellation, and never from any other status.
   */
  async function reachGenerated(
    op: ActiveOperation,
    analysis: AnalysisResult,
    panel: PanelSpec,
  ): Promise<Result<SessionRecord, DebuggenError>> {
    if (op.signal.aborted) {
      return failStage(
        op,
        GENERATE_PANEL_STAGE,
        cancelledError(op.sessionId, GENERATE_PANEL_STAGE),
      );
    }
    const analysing = await enterStage(op, GENERATE_PANEL_STAGE);
    if (!analysing.ok) {
      return failStage(op, GENERATE_PANEL_STAGE, analysing.error);
    }
    const done = await moveTo(op, GENERATED_STATUS, { analysis, panel });
    return done.ok ? done : failStage(op, GENERATE_PANEL_STAGE, done.error);
  }

  /* ----------------------------------------------------------------------------------------------
   * followUp — AAP §0.4.2's two paths
   * -------------------------------------------------------------------------------------------- */

  function followUp(request: FollowUpRequest): Promise<Result<FollowUpOutcome, DebuggenError>> {
    const { sessionId } = request;

    return execute<FollowUpOutcome>(
      'followUp',
      sessionId,
      FOLLOW_UP_STAGE,
      request.signal,
      async (op) => {
        if (op.signal.aborted) {
          return err(cancelledError(sessionId, FOLLOW_UP_STAGE));
        }
        const initial = readSession(sessionId);
        if (!initial.ok) {
          return initial;
        }
        const session = initial.value;
        if (!FOLLOW_UP_START_STATUSES.includes(session.status)) {
          const refusal = [ANALYZE_STAGE, PLAN_STAGE]
            .map((stage) => transition(session.status, statusOrThrow(stage)))
            .find((attempt) => !attempt.ok);
          if (refusal !== undefined && !refusal.ok) {
            return refusal;
          }
        }

        op.stage = FOLLOW_UP_STAGE;
        op.log.info(STAGE_STARTED_LOG, { stage: FOLLOW_UP_STAGE });
        const code = await loadCode(op, session.projectRoot, false);
        if (!code.ok) {
          return failStage(op, FOLLOW_UP_STAGE, code.error);
        }
        const readiness = await observedReadiness(op, session);

        // The stage appends the question, decides the path through the model
        // gate and executes it; its two seams are where the session moves.
        const followed = await inStage(
          op,
          code.value,
          { followUpQuestion: request.question },
          (context) =>
            stages.followUp().run(context, {
              followUpQuestion: request.question,
              ...(readiness !== undefined ? { readiness } : {}),
              onPathChosen: (path) => enterStage(op, FOLLOW_UP_PATH_STAGE[path]),
              beforeInstall: () => enterStage(op, INSTRUMENT_STAGE),
            }),
        );
        if (!followed.ok) {
          return followed;
        }
        const outcome = followed.value;
        op.reported.followup = outcome.decision.promptVersion;

        if (outcome.path === 'existing-evidence') {
          // `generated → analyzing → generated`: both artifacts are new versions
          // drawn from the stored capture; no file was touched.
          op.reported.analyze = outcome.analysisPromptVersion;
          op.reported['generate-panel'] = outcome.panelPromptVersion;
          await mirrorAnalysis(op, outcome.analysis);
          await mirrorPanel(op, outcome.panel);
          const done = await reachGenerated(op, outcome.analysis, outcome.panel);
          if (!done.ok) {
            return done;
          }
          const prompts = await recordPromptVersions(op, false);
          return ok(
            Object.freeze({
              path: outcome.path,
              status: done.value.status,
              analysis: outcome.analysis,
              panelId: outcome.panel.id,
              panelVersion: outcome.panelVersion,
              supersedes: outcome.supersededPanelId,
              fallback: outcome.fallbackPanel,
              promptVersionsRecorded: prompts.recorded,
            }),
          );
        }

        // `generated → planning → instrumenting → ready`: plan version n + 1 is
        // recorded and only its delta installed; the developer reproduces again.
        const instrumenting = await enterStage(op, INSTRUMENT_STAGE);
        if (!instrumenting.ok) {
          return failStage(op, INSTRUMENT_STAGE, instrumenting.error);
        }
        await mirrorModifications(op, outcome.installation.applied);
        verdicts.set(sessionId, outcome.installation.readiness);
        const admitted = await admitReadiness(op, outcome.installation);
        if (!admitted.ok) {
          return admitted;
        }
        const prompts = await recordPromptVersions(op, false);
        return ok(
          Object.freeze({
            path: outcome.path,
            status: admitted.value.status,
            planVersion: outcome.planVersion,
            ready: outcome.installation.readiness.satisfied,
            promptVersionsRecorded: prompts.recorded,
          }),
        );
      },
    );
  }

  /* ----------------------------------------------------------------------------------------------
   * Lifecycle
   * -------------------------------------------------------------------------------------------- */

  function cancel(sessionId: string): boolean {
    const op = active.get(sessionId);
    if (op === undefined) {
      return false;
    }
    op.controller.abort();
    return true;
  }

  function activeRun(sessionId: string): PipelineStageKey | undefined {
    return active.get(sessionId)?.stage;
  }

  function dispose(): Promise<void> {
    if (disposing !== undefined) {
      return disposing;
    }
    disposed = true;
    for (const op of active.values()) {
      op.controller.abort();
    }
    disposing = (async () => {
      await Promise.allSettled([...settling]);
      for (const root of loadedRoots) {
        codeIndex.invalidate?.(root);
      }
      loadedRoots.clear();
      verdicts.clear();
      recordedFailures.clear();
    })();
    return disposing;
  }

  return Object.freeze({
    run,
    beginCapture,
    completeCapture,
    followUp,
    regate,
    cancel,
    activeRun,
    dispose,
  });
}
