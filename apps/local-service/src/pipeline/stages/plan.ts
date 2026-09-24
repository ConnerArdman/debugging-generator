/**
 * Stage 3 of the local service's reasoning pipeline: **instrumentation
 * planning** (AAP §0.4.2, "AI stage boundaries", Instrumentation-planning row;
 * AAP §0.7.1 Group 2; AAP §0.8.1 slices 8–9).
 *
 * This is the most safety-critical stage in the folder, because its output is
 * the only artifact permitted to cause a change in the developer's project. It
 * turns the validated Stage 1 {@link ProblemUnderstanding} and the Stage 2
 * {@link CodeInvestigation} into a validated, feasible, recorded and installed
 * {@link InstrumentationPlan}.
 *
 * ## The gate, in the only order it may run (AAP §0.5.3)
 *
 * ```text
 * model output
 *   1. instrumentationPlanInputSchema   authoring validation, ≤ DEFAULT_MAX_REPAIRS re-prompts
 *   2. normalizePlan(...)               deterministic; adapter + mode + id assigned here
 *   3. instrumentationPlanSchema        internal validation
 *   4. checkPlanFeasibility(...)        rejections returned as data
 * ```
 *
 * Step 1 is `generateStructuredWithRepair`, the one repair loop in the product.
 * Steps 2–4 are {@link gateInstrumentationPlan}. A failure in step 2 or 3 is a
 * **product defect, never the model's fault**: it is logged at `error` with the
 * parsed input (the single record AAP §0.5.3 sanctions carrying a value) and the
 * plan is rejected without a re-prompt. This file adds no second repair loop, no
 * retry and no fallback beyond the one below.
 *
 * ## The one sanctioned fallback (AAP §0.5.3)
 *
 * A rejected plan — authoring schema exhausted, normaliser or internal
 * validation failed, or nothing in it feasible — falls back to
 * {@link buildRuntimeOnlyFallbackPlan}: a runtime-only default plan assembled
 * **entirely from the live adapter registry** (`handling(context)` →
 * `createPlan(context, understanding)` → `mode: "runtime"` only) and held to the
 * same steps 2–4. It touches no file by construction, and a patch-mode action
 * that survives normalisation makes the fallback refuse rather than emit. A
 * provider outage is **not** a rejected plan: it fails the stage with the
 * provider's own sentence (AAP §0.5.5, `modelUnavailableMessage`).
 *
 * ## Partially infeasible plans
 *
 * Feasibility is a report, not a filter. When some actions are feasible the
 * plan is recorded and installed **as validated**, infeasible actions included:
 * the installer runs the same gate before writing a byte, turns every refusal
 * into an `UnavailableSignal`, and the instrumentation service renders AAP
 * §0.5.5's sentence ("Could not enable ‹signal›: ‹reason›. Continuing with: …")
 * through `buildDegradationNotice`. Only a plan with **no** feasible action is
 * treated as rejected. The {@link FeasibilityReport} travels out on the result
 * either way so the orchestrator and both user interfaces can show it.
 *
 * ## What this stage owns, and what it hands on
 *
 * - The plan version comes from `SessionsRepo.nextPlanVersion`; the plan is
 *   recorded through `SessionManager.recordPlan`, which stamps and validates the
 *   ladder. Session **status** is never written here.
 * - Installation is `InstrumentationService.install`, the only path allowed to
 *   write to the developer's project (hash, backup, journal and diff recorded
 *   before any byte, AAP §0.5.1). A follow-up passes `previousActions`, whose
 *   ids `normalizePlan` reuses through `actionIdentityKey` and against which the
 *   service installs only the delta.
 * - Progress: this stage emits the `plan` group's header, its closing row (or
 *   `failed` row) and, on the fallback path, the rejecting subsystem's own
 *   sentences as `running` rows. The `instrument` group — header, the Step-8 ✓
 *   rows from `reportInstrumentation`, degradation rows, "Ready to capture" and
 *   its `failed` row — is emitted by the instrumentation service from the real
 *   installed set, so this module emits none of them and authors no display
 *   string.
 *
 * ## No hardcoded behaviour (AAP §0.5.4)
 *
 * No adapter id, route, file, symbol or application name appears here; the
 * adapter catalog and the fallback are derived from the registry at run time,
 * so an adapter registered tomorrow appears in both with no change to this file.
 * Nothing reads the developer's question.
 *
 * ## Privacy
 *
 * Log records carry stage, status, plan version, action counts by type and
 * mode, feasibility rejection codes and error codes — never the question, the
 * prompt, a file's contents, a URL, a statement or a token. Errors composed here
 * name field paths and codes, never values.
 *
 * @module
 */

import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  FEASIBILITY_REJECTION_CODES,
  INSTRUMENTATION_ACTION_TYPES,
  SERVER_AGENT_SIGNAL_KEYS,
  actionIdentityKey,
  checkPlanFeasibility,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  instrumentationActionSchema,
  instrumentationPlanInputSchema,
  instrumentationPlanSchema,
  normalizePlan,
  parseReadiness,
} from '@debuggen/instrumentation';
import type {
  AdapterRegistry,
  CaptureSignal,
  FeasibilityRejectionCode,
  FeasibilityReport,
  InfeasibleAction,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationAdapter,
  InstrumentationContext,
  InstrumentationMode,
  InstrumentationPlan,
  InstrumentationPlanInput,
  ObservedReadinessInputs,
  PlanAdapterResolver,
  ProblemUnderstanding,
  ReadinessSignal,
  ReadinessStatus,
  UnavailableSignal,
} from '@debuggen/instrumentation';
import { DEFAULT_MAX_REPAIRS, generateStructuredWithRepair } from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import type { ProgressStage, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, err, fromPromise, ok, tryCatch } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import { buildDegradationNotice } from '../../instrumentation/service.js';
import type {
  CodeAnalysisHandles,
  InstallRequest,
  InstrumentationOutcome,
  InstrumentationService,
} from '../../instrumentation/service.js';
import { sessionLogger, subsystemLogger } from '../../logging.js';
import type { RecordedPlan, SessionManager } from '../../sessions/manager.js';
import { CAPTURE_SIGNAL_LABELS } from '../../sessions/progress.js';
import type { ProgressRow, SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import type {
  ContextBuilder,
  PipelineStageContext,
  StageRequestBuild,
} from '../context-builder.js';
import type { CodeInvestigation } from './investigate.js';

/* -------------------------------------------------------------------------------------------------
 * Stage identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in both vocabularies it reports under: protocol's
 * `PROGRESS_STAGES` and the model boundary's `PROMPT_STAGES`. The `satisfies`
 * clause turns a rename in either tuple into a compile error here.
 */
const PLAN_STAGE = 'plan' as const satisfies ProgressStage & PromptStage;

/**
 * The progress stage the installation this stage hands off to reports under —
 * the member of protocol's `PROGRESS_STAGES` that names instrumentation. An
 * install failure is tagged with it so the orchestrator files the session's
 * failure under the stage that actually failed.
 */
const INSTRUMENT_STAGE = 'instrument' as const satisfies ProgressStage;

/** The logger subsystem binding of every pipeline module, per `../../logging.ts`. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/** The artifact name repair feedback and rejection details use. */
const PLAN_SCHEMA_NAME = 'instrumentation plan';

/** The most validation issues an internal-validation error lists (paths and codes only). */
const MAX_REPORTED_ISSUES = 20;

/** The install mode that touches no file (AAP §0.5.1); the only mode the fallback may emit. */
const RUNTIME_MODE: InstrumentationMode = 'runtime';

/** The display-order index of every capture signal, for byte-stable sorting. */
const SIGNAL_ORDER: ReadonlyMap<string, number> = new Map(
  CAPTURE_SIGNALS.map((signal, index) => [signal, index]),
);

/** The vocabulary-order index of every action type, for byte-stable sorting. */
const ACTION_TYPE_ORDER: ReadonlyMap<string, number> = new Map(
  INSTRUMENTATION_ACTION_TYPES.map((type, index) => [type, index]),
);

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why a plan was rejected and replaced by the runtime-only fallback
 * (AAP §0.5.3):
 *
 * - `'model-output-invalid'` — the model's answer failed the authoring schema
 *   after every permitted repair, or was empty.
 * - `'normalization-failed'` — `normalizePlan` refused an input the authoring
 *   schema had accepted (a product defect; never re-prompted).
 * - `'internal-validation-failed'` — the normalised plan failed the internal
 *   schema (a product defect; never re-prompted).
 * - `'infeasible'` — the plan validated but no action in it can be installed
 *   on this project.
 */
export type PlanRejectionReason =
  'model-output-invalid' | 'normalization-failed' | 'internal-validation-failed' | 'infeasible';

/**
 * Why the stage used the fallback plan (AAP §0.5.3, rejected-plan fallback;
 * AAP §0.5.5): the reason and the rejecting subsystem's own code and
 * sentences. Carries no payload value.
 */
export interface PlanFallbackCause {
  /** Which gate rejected the plan. */
  readonly reason: PlanRejectionReason;
  /** The rejecting subsystem's error code. */
  readonly code: DebuggenErrorCode;
  /** The rejecting subsystem's sentence. */
  readonly message: string;
  /** The rejecting subsystem's next step, when it gave one. */
  readonly hint?: string | undefined;
}

/**
 * One signal row of an adapter catalog entry that is not fully available: the
 * adapter's own readiness verdict and reason (AAP §0.5.5), without its hint —
 * a hint can carry a relaunch command with local paths, which has no business
 * in a model payload.
 */
export interface AdapterCatalogPrecondition {
  /** The capture signal the row is about. */
  readonly signal: CaptureSignal;
  /** `'degraded'` or `'unavailable'`, as the adapter reported it. */
  readonly status: ReadinessStatus;
  /** The adapter's reason, when it gave one. */
  readonly reason?: string | undefined;
}

/**
 * One entry of the `{{adapterCatalog}}` placeholder (AAP §0.4.2,
 * Instrumentation-planning row, "adapter capability catalog"): the action types
 * one adapter would install **for this project** in one mode, the signals it
 * supplies and the preconditions it reports (`prompts/plan/v001.md`, Inputs).
 *
 * Derived from the live registry by {@link buildAdapterCatalog}, never
 * hand-written. One entry per `(adapter, mode)` pair, so every entry states a
 * single mode and a reader never has to guess which of an adapter's types
 * changes a file.
 */
export interface AdapterCatalogEntry {
  /** The adapter's registered id, as the registry reports it. */
  readonly adapter: string;
  /** How this entry's action types are installed. */
  readonly mode: InstrumentationMode;
  /** Whether installing this entry's action types edits a file (`mode === "patch"`). */
  readonly changesFiles: boolean;
  /** The action types normalisation would route to this adapter, in vocabulary order. */
  readonly actionTypes: readonly InstrumentationActionType[];
  /** The capture signals the adapter's readiness report names, in signal order. */
  readonly signals: readonly CaptureSignal[];
  /** The adapter's readiness rows that are not `available`, in signal order. */
  readonly preconditions: readonly AdapterCatalogPrecondition[];
}

/** Options of {@link gateInstrumentationPlan} (AAP §0.5.3, steps 2–4 of the model-output gate). */
export interface PlanGateOptions {
  /** The adapter registry: the only source of adapter identity and install mode. */
  readonly registry: AdapterRegistry;
  /** The instrumentation context of the plan version being gated. */
  readonly context: InstrumentationContext;
  /** The previous plan version's actions, on the follow-up path; their ids are reused. */
  readonly previousActions?: readonly InstrumentationAction[] | undefined;
  /** An id factory for new action ids; defaults to `normalizePlan`'s own. */
  readonly newActionId?: (() => string) | undefined;
  /** Where the product-defect record of a normaliser or internal failure goes. */
  readonly logger?: Logger | undefined;
}

/**
 * What {@link gateInstrumentationPlan} concluded about one authored plan
 * (AAP §0.5.3; partial infeasibility per AAP §0.5.5).
 *
 * - `accepted` — normalised, internally valid, and at least one action is
 *   feasible. Infeasible actions stay in the plan and in the report.
 * - `rejected` — the plan must not be used; `reason` says which gate refused
 *   it. For `'infeasible'` the normalised plan and its report are attached.
 * - `failed` — the gate itself could not run (an unusable instrumentation
 *   context). Not a rejection of the plan, and not a reason to fall back.
 */
export type PlanGateOutcome =
  | {
      readonly kind: 'accepted';
      readonly plan: InstrumentationPlan;
      readonly feasibility: FeasibilityReport;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: Exclude<PlanRejectionReason, 'model-output-invalid'>;
      readonly error: DebuggenError;
      readonly plan?: InstrumentationPlan | undefined;
      readonly feasibility?: FeasibilityReport | undefined;
    }
  | { readonly kind: 'failed'; readonly error: DebuggenError };

/** Options of {@link buildRuntimeOnlyFallbackPlan} (AAP §0.5.3, rejected-plan fallback). */
export interface RuntimeOnlyFallbackOptions {
  /** The previous plan version's actions, on the follow-up path; their ids are reused. */
  readonly previousActions?: readonly InstrumentationAction[] | undefined;
  /** An id factory for new action ids; defaults to `normalizePlan`'s own. */
  readonly newActionId?: (() => string) | undefined;
  /** Where adapter failures and product defects are logged. Defaults to the context's logger. */
  readonly logger?: Logger | undefined;
}

/**
 * A runtime-only fallback plan, gated exactly as a model's plan is (AAP §0.5.3;
 * runtime mode touches no file, AAP §0.5.1).
 */
export interface RuntimeOnlyFallbackPlan {
  /** The normalised, internally valid, runtime-only plan. */
  readonly plan: InstrumentationPlan;
  /** Its feasibility report; `feasible` is never empty. */
  readonly feasibility: FeasibilityReport;
  /** The authoring input it was normalised from, assembled from the adapters' proposals. */
  readonly input: InstrumentationPlanInput;
}

/**
 * The collaborators of the plan stage, all injected (AAP §0.7.1 Group 2). The
 * registry is **never** constructed here and no concrete adapter is imported:
 * that is what keeps AAP §0.4.2's "add an adapter without an orchestrator
 * change" true. Pass the same registry the instrumentation service installs
 * with, so the adapter a plan names is the adapter that installs it.
 */
export interface PlanStageDeps {
  /** Builds, caps, renders and guard-checks the plan request. */
  readonly contextBuilder: Pick<ContextBuilder, 'buildPlanRequest'>;
  /** The configured model provider; called only through `generateStructuredWithRepair`. */
  readonly provider: ModelProvider;
  /** The live adapter registry. */
  readonly registry: AdapterRegistry;
  /** Builds adapter contexts and installs validated plans — the only writer to the project. */
  readonly instrumentation: Pick<InstrumentationService, 'buildContext' | 'install'>;
  /** The session store's plan ladder: the source of the next plan version. */
  readonly sessions: Pick<SessionsRepo, 'nextPlanVersion'>;
  /** Records the plan on the session (the store's `plans` table and the record). */
  readonly sessionManager: Pick<SessionManager, 'recordPlan'>;
  /** Emits the plan stage's progress rows; owns every title and label. */
  readonly progress: Pick<
    SessionProgress,
    'stageStarted' | 'stageCompleted' | 'stageFailed' | 'emit'
  >;
  /** A parent logger, bound to the session per run; absent, the context's logger is used. */
  readonly logger?: Logger | undefined;
  /**
   * The repair budget: an integer from `0` to `DEFAULT_MAX_REPAIRS`, defaulting
   * to the maximum (AAP §0.5.3). A value outside that range fails every run
   * with `CONFIG_INVALID` before anything is sent.
   */
  readonly maxRepairs?: number | undefined;
}

/**
 * What a run needs beyond the {@link PipelineStageContext} (AAP §0.4.2,
 * Instrumentation-planning row inputs; the follow-up delta of the Follow-up row).
 */
export interface PlanStageInput {
  /** The validated Stage 1 artifact; also every adapter's `createPlan` argument. */
  readonly understanding: ProblemUnderstanding;
  /** The validated Stage 2 artifact. */
  readonly investigation: CodeInvestigation;
  /**
   * The plan prompt version to use. Absent, the version recorded on the
   * session is reused, and failing that the manifest's current version.
   */
  readonly promptVersion?: string | undefined;
  /**
   * The previous plan version's actions, on a follow-up that needs new
   * instrumentation (AAP §0.4.2). Their ids are reused for every action that
   * survives (`actionIdentityKey`), and the install applies only the delta
   * against them. Pass them verbatim; the stage requires `planVersion ≥ 2`
   * when they are present.
   */
  readonly previousActions?: readonly InstrumentationAction[] | undefined;
  /**
   * The readiness facts the service has observed (`collectReadinessEvidence`'s
   * `observed`), placed on the planning context so the adapter catalog's
   * preconditions describe this machine. Absent means nothing has reported yet.
   */
  readonly readiness?: ObservedReadinessInputs | undefined;
  /**
   * Called once the plan is recorded and before installation starts — the
   * orchestrator's seam for the `planning → instrumenting` transition, since
   * this stage never writes status. An `Err` (or a throw) stops the stage
   * before anything is installed.
   */
  readonly beforeInstall?:
    ((recorded: RecordedPlan) => Promise<Result<unknown, DebuggenError>>) | undefined;
}

/**
 * The validated, recorded and installed outcome of a run (AAP §0.4.2, the
 * Instrumentation-planning row's validated output artifact; AAP §0.5.1).
 */
export interface PlanStageResult {
  /** The plan as recorded on the session. */
  readonly plan: InstrumentationPlan;
  /** Its version on the session's plan ladder. */
  readonly planVersion: number;
  /** The prompt version actually loaded; the orchestrator records it on the session. */
  readonly promptVersion: string;
  /** How many repair attempts the model's answer needed. */
  readonly repairs: number;
  /** The feasibility report of the recorded plan. */
  readonly feasibility: FeasibilityReport;
  /** `true` when the recorded plan is the runtime-only fallback. */
  readonly fallback: boolean;
  /** Why the fallback was used; present exactly when {@link fallback} is `true`. */
  readonly fallbackCause?: PlanFallbackCause | undefined;
  /** The session record as stored after the plan was recorded. */
  readonly session: SessionRecord;
  /**
   * The installation outcome, as the instrumentation service returned it —
   * applied records, runtime hooks, unavailable signals and the readiness
   * verdict the orchestrator's guarded `instrumenting → ready` edge needs. The
   * plan is already installed: do not install it again.
   */
  readonly installation: InstrumentationOutcome;
}

/**
 * Stage 3 of the pipeline (AAP §0.4.2, AI stage boundaries; AAP §0.7.1 Group 2).
 * One method, so the orchestrator's stage overrides can substitute a fake.
 */
export interface PlanStage {
  /**
   * Plans, gates, records and installs the instrumentation for one run.
   *
   * Never throws. Every failure is an `Err` carrying the failing subsystem's own
   * `DebuggenError`, with `details.stage` set to `"plan"` or `"instrument"` so
   * the orchestrator can file the session's failure under the right stage. The
   * stage writes no session status.
   *
   * @param context The run's stage context.
   * @param input The upstream artifacts and the run's options.
   * @returns The recorded, installed plan, or the failure.
   */
  run(
    context: PipelineStageContext,
    input: PlanStageInput,
  ): Promise<Result<PlanStageResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Log records — fields are ids, counts, codes and versions; never content
 * ---------------------------------------------------------------------------------------------- */

/** Info record of a recorded plan. Fields: plan version, counts, fallback flag, codes, timing. */
const COMPLETED_LOG = 'Plan stage recorded a validated instrumentation plan.';

/** Warn record of a failed run. Fields: stage, error code, rejection reason. */
const FAILED_LOG = 'Plan stage failed; no instrumentation plan was installed.';

/** Warn record of the fallback path. Fields: rejection reason and code, fallback action counts. */
const FALLBACK_LOG =
  'The planned instrumentation was rejected; using the runtime-only fallback plan.';

/**
 * Error record of a normaliser or internal-validation failure — a product
 * defect (AAP §0.5.3). The one record in this module that carries a value: the
 * parsed authoring input, which whoever fixes the defect needs, routed through
 * the service logger's redaction layers.
 */
const PRODUCT_DEFECT_LOG =
  'An authored instrumentation plan passed its schema but failed deterministic normalisation or internal validation; it was rejected without a re-prompt.';

/** Error record of a feasibility gate that could not run at all. Fields: error code. */
const GATE_FAILED_LOG = 'The instrumentation feasibility gate could not run.';

/** Warn record of an adapter whose proposal or readiness report could not be used. */
const ADAPTER_SKIPPED_LOG = 'An adapter could not contribute to the plan stage; it was skipped.';

/** Debug record of a run whose signal was aborted before it began. */
const CANCELLED_LOG = 'Plan stage cancelled.';

/** Warn record of a progress row that could not be emitted. Fields: stage, row, error code. */
const PROGRESS_FAILED_LOG =
  'A progress row of the plan stage could not be emitted; the stage continues.';

/** Which progress row a {@link PROGRESS_FAILED_LOG} record is about. */
type ProgressRowKind = 'started' | 'completed' | 'failed' | 'fallback';

/** The most fallback degradation rows one run emits; the omitted count is logged. */
const MAX_FALLBACK_ROWS = 12;

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Orders strings by UTF-16 code unit. `localeCompare` is avoided on purpose:
 * its answer depends on host locale data, and the catalog must be byte-stable.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** A value's position in a fixed vocabulary order; unknown values sort last. */
function rankOf(order: ReadonlyMap<string, number>, value: string): number {
  return order.get(value) ?? order.size;
}

/**
 * The resolver normalisation and feasibility are given: the live registry,
 * narrowed to the adapters that can handle **this** project.
 *
 * `PlanAdapterResolver.resolveActionType` takes the type alone, while the
 * registry answers per project when handed a context — which is what routes a
 * database action to the driver adapter in a project that has no ORM. Binding
 * the context here makes normalisation, feasibility, the catalog and the
 * installer agree on one answer per action type (AAP §0.4.2).
 *
 * @param registry The live adapter registry.
 * @param context The session's instrumentation context.
 * @returns A side-effect-free resolver bound to the context.
 */
export function contextBoundResolver(
  registry: AdapterRegistry,
  context: InstrumentationContext,
): PlanAdapterResolver {
  return Object.freeze({
    resolveActionType: (type: InstrumentationActionType) => {
      try {
        return registry.resolveActionType(type, context);
      } catch {
        // The registry is documented as total; a substitute that throws is
        // treated as claiming nothing rather than taking the stage down.
        return undefined;
      }
    },
  });
}

/**
 * The capture signals a set of actions enables, in `CAPTURE_SIGNALS` order,
 * read through the product's own derivations (`deriveAgentHookConfig`,
 * `deriveServerAgentSignals`) rather than a table restated here.
 */
function enabledSignals(actions: readonly InstrumentationAction[]): readonly CaptureSignal[] {
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

  return CAPTURE_SIGNALS.filter((signal) => enabled.has(signal));
}

/**
 * The product's display labels of a set of signals, distinct, in signal order.
 * The labels belong to `../../sessions/progress.ts`; none is restated here.
 */
function signalLabels(signals: readonly CaptureSignal[]): readonly string[] {
  return [...new Set(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]))];
}

/** Action counts keyed `type/mode`, keys sorted — the only shape of a plan this module logs. */
function countsByTypeAndMode(actions: readonly InstrumentationAction[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const key = `${action.type}/${action.mode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted: Record<string, number> = {};
  for (const key of [...counts.keys()].sort(compareCodeUnits)) {
    sorted[key] = counts.get(key) ?? 0;
  }
  return sorted;
}

/** The distinct rejection codes of a report, in the vocabulary's order. */
function rejectionCodes(rejected: readonly InfeasibleAction[]): FeasibilityRejectionCode[] {
  return FEASIBILITY_REJECTION_CODES.filter((code) =>
    rejected.some((refusal) => refusal.code === code),
  );
}

/** The closed-vocabulary rejection reason of an error, when it carries one. */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** A numeric detail of an error, or `0`. */
function numericDetail(error: DebuggenError, key: string): number {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The same error, re-issued with extra `details` merged over its own. Code,
 * message and hint are preserved verbatim — the failing subsystem's sentence is
 * the developer's sentence — and the original is kept as the cause.
 */
function annotate(error: DebuggenError, extra: Readonly<Record<string, unknown>>): DebuggenError {
  const alreadyCarried = Object.entries(extra).every(
    ([key, value]) => error.details?.[key] === value,
  );
  if (alreadyCarried) {
    return error;
  }
  return new DebuggenError(error.code, error.message, {
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    details: { ...(error.details ?? {}), ...extra },
    cause: error,
  });
}

/** The error tagged with the pipeline stage it belongs to (`details.stage`). */
function withStage(error: DebuggenError, stage: ProgressStage): DebuggenError {
  return annotate(error, { stage });
}

/** The failure of a run that was cancelled; shaped like the context builder's own. */
function cancelledError(stage: ProgressStage): DebuggenError {
  return new DebuggenError('INTERNAL', 'The plan stage was cancelled before it finished.', {
    hint: 'No instrumentation was installed by the cancelled run. Plan the instrumentation again when ready.',
    details: { stage, reason: 'aborted' },
  });
}

/**
 * Whether a run's cancellation signal has fired. A function rather than an
 * inline test so each check reads the signal afresh after an `await`, instead
 * of inheriting the compiler's narrowing from an earlier check.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Whether a repair budget is one `generateStructuredWithRepair` accepts. */
function isValidRepairBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= DEFAULT_MAX_REPAIRS;
}

/** The failure of a run configured with a repair budget outside the permitted range. */
function repairBudgetError(value: number): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The plan stage was configured with a repair budget outside 0 to ${String(DEFAULT_MAX_REPAIRS)}, so no request was sent.`,
    {
      hint: 'Construct the stage without maxRepairs to use the default budget, or pass an integer within the permitted range.',
      details: {
        stage: PLAN_STAGE,
        reason: 'repair-budget',
        maxRepairs: Number.isFinite(value) ? value : String(value),
      },
    },
  );
}

/** The {@link SessionFailure} a `failed` progress row is built from. */
function sessionFailureOf(error: DebuggenError, stage: ProgressStage): SessionFailure {
  return error.hint === undefined
    ? { stage, code: error.code, message: error.message }
    : { stage, code: error.code, message: error.message, hint: error.hint };
}

/** The error a progress emission reported or threw, or `undefined` when it succeeded. */
function progressFailureOf(
  sent: Result<Result<unknown, DebuggenError>, DebuggenError>,
): DebuggenError | undefined {
  if (!sent.ok) {
    return sent.error;
  }
  return sent.value.ok ? undefined : sent.value.error;
}

/** A thrown value's constructor name, for a log record — never its message. */
function thrownName(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}

/**
 * Any text as one display line: control characters become spaces, whitespace
 * runs collapse and the ends are trimmed — the form a progress row carries.
 */
function toDisplayLine(text: string): string {
  let spaced = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spaced += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return spaced.replace(/\s+/gu, ' ').trim();
}

/**
 * The issue paths and codes of a failed schema parse — never the rejected
 * values (AAP §0.5.2).
 */
function describeIssues(
  issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[],
): string[] {
  return issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join('.') || '(root)'}: ${issue.code}`,
    );
}

/**
 * The feasibility refusals of a plan as AAP §0.5.5 gaps. The signal is the
 * refused action type — the thing the plan asked for — and the reason and hint
 * are the gate's own words.
 */
function unavailableFromRejections(rejected: readonly InfeasibleAction[]): UnavailableSignal[] {
  return rejected.map((refusal) => ({
    signal: refusal.action.type,
    reason: refusal.reason,
    hint: refusal.hint,
  }));
}

/** The code-analysis handles in the shape the instrumentation service names them. */
function codeHandlesOf(context: PipelineStageContext): CodeAnalysisHandles {
  const { graph, queries, routeMap, projectSummary, loaded } = context.code;
  return { graph, queries, routeMap, summary: projectSummary, project: loaded };
}

/* -------------------------------------------------------------------------------------------------
 * The adapter catalog — `{{adapterCatalog}}`, derived from the live registry
 * ---------------------------------------------------------------------------------------------- */

/**
 * An adapter's readiness rows, validated; empty when the adapter is not
 * registered, throws, or returns something that is not a readiness report.
 */
async function readinessRows(
  adapter: InstrumentationAdapter | undefined,
  context: InstrumentationContext,
): Promise<readonly ReadinessSignal[]> {
  if (adapter === undefined) {
    return [];
  }
  try {
    const parsed = parseReadiness(await adapter.readiness(context));
    if (parsed.ok) {
      return parsed.value.signals;
    }
    context.logger.warn(ADAPTER_SKIPPED_LOG, {
      stage: PLAN_STAGE,
      adapter: adapter.id,
      step: 'readiness',
      code: parsed.error.code,
    });
  } catch (thrown) {
    context.logger.warn(ADAPTER_SKIPPED_LOG, {
      stage: PLAN_STAGE,
      adapter: adapter.id,
      step: 'readiness',
      errorName: thrownName(thrown),
    });
  }
  return [];
}

/**
 * Derives the plan prompt's `{{adapterCatalog}}` value from the **live**
 * registry (AAP §0.4.2: an adapter added by registration reaches the planner
 * with no change here).
 *
 * For every member of `INSTRUMENTATION_ACTION_TYPES`, the registry is asked
 * which adapter would install it for this project and in which mode —
 * `resolveActionType(type, context)`, the exact answer normalisation will get —
 * and the types are grouped into one {@link AdapterCatalogEntry} per
 * `(adapter, mode)`. Each entry carries the signals that adapter's readiness
 * report names and the rows it reports as not fully available (its
 * preconditions, AAP §0.5.5). A type no applicable adapter claims appears in no
 * entry, which is how the prompt learns it is unavailable here.
 *
 * Deterministic and byte-stable: entries sorted by adapter id then mode, types
 * in vocabulary order, signals in signal order, no timestamp and no hint. An
 * adapter whose readiness probe throws contributes its types with no signal
 * rows rather than failing the stage.
 *
 * @param registry The live adapter registry.
 * @param context The planning context (its `readiness` holds what was observed).
 * @returns The catalog entries, frozen.
 */
export async function buildAdapterCatalog(
  registry: AdapterRegistry,
  context: InstrumentationContext,
): Promise<readonly AdapterCatalogEntry[]> {
  const resolver = contextBoundResolver(registry, context);
  const groups = new Map<
    string,
    { adapter: string; mode: InstrumentationMode; types: InstrumentationActionType[] }
  >();

  for (const type of INSTRUMENTATION_ACTION_TYPES) {
    const resolution = resolver.resolveActionType(type);
    if (resolution === undefined) {
      continue;
    }
    const key = `${resolution.adapter}\u0000${resolution.mode}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { adapter: resolution.adapter, mode: resolution.mode, types: [type] });
    } else {
      group.types.push(type);
    }
  }

  const rowsByAdapter = new Map<string, readonly ReadinessSignal[]>();
  const entries: AdapterCatalogEntry[] = [];

  for (const group of groups.values()) {
    let rows = rowsByAdapter.get(group.adapter);
    if (rows === undefined) {
      rows = await readinessRows(registry.get(group.adapter), context);
      rowsByAdapter.set(group.adapter, rows);
    }

    const signals = [...new Set(rows.map((row) => row.signal))].sort(
      (left, right) => rankOf(SIGNAL_ORDER, left) - rankOf(SIGNAL_ORDER, right),
    );
    const preconditions = rows
      .filter((row) => row.status !== 'available')
      .map((row): AdapterCatalogPrecondition =>
        Object.freeze({
          signal: row.signal,
          status: row.status,
          ...(row.reason !== undefined ? { reason: toDisplayLine(row.reason) } : {}),
        }),
      )
      .sort(
        (left, right) =>
          rankOf(SIGNAL_ORDER, left.signal) - rankOf(SIGNAL_ORDER, right.signal) ||
          compareCodeUnits(left.status, right.status) ||
          compareCodeUnits(left.reason ?? '', right.reason ?? ''),
      );

    entries.push(
      Object.freeze({
        adapter: group.adapter,
        mode: group.mode,
        changesFiles: group.mode !== RUNTIME_MODE,
        actionTypes: Object.freeze(
          [...group.types].sort(
            (left, right) => rankOf(ACTION_TYPE_ORDER, left) - rankOf(ACTION_TYPE_ORDER, right),
          ),
        ),
        signals: Object.freeze(signals),
        preconditions: Object.freeze(preconditions),
      }),
    );
  }

  entries.sort(
    (left, right) =>
      compareCodeUnits(left.adapter, right.adapter) || compareCodeUnits(left.mode, right.mode),
  );
  return Object.freeze(entries);
}

/* -------------------------------------------------------------------------------------------------
 * Steps 2–4 of the gate
 * ---------------------------------------------------------------------------------------------- */

/**
 * The failure of a plan with no feasible action, carrying the gate's first
 * hint (its own words) and the distinct rejection codes.
 */
function infeasibleError(feasibility: FeasibilityReport): DebuggenError {
  const hint = feasibility.rejected[0]?.hint;
  return new DebuggenError(
    'INSTRUMENTATION_UNAVAILABLE',
    'None of the planned instrumentation actions can be installed on this project.',
    {
      ...(hint !== undefined ? { hint } : {}),
      details: {
        stage: PLAN_STAGE,
        reason: 'infeasible',
        rejected: feasibility.rejected.length,
        codes: rejectionCodes(feasibility.rejected),
      },
    },
  );
}

/**
 * Steps 2–4 of AAP §0.5.3's gate for a plan whose authoring form has already
 * validated: **normalise → validate internally → check feasibility**, in that
 * order and no other. Exported so every producer of a plan version — this
 * stage, its fallback and the follow-up path — holds its plan to one gate.
 *
 * - **Normalisation** (`normalizePlan`) assigns `adapter`, `mode` and ids by
 *   asking the context-bound registry, reuses `previousActions` ids through
 *   `actionIdentityKey`, and keeps order and duplicates.
 * - **Internal validation** re-parses the result with `instrumentationPlanSchema`.
 * - A failure of either is a **product defect**: it is logged at `error` with
 *   the parsed input and the plan is rejected. This function never talks to a
 *   model, so nothing here can re-prompt.
 * - **Feasibility** (`checkPlanFeasibility`) returns its refusals as data. A
 *   plan with at least one feasible action is `accepted` with its infeasible
 *   actions left in place (the installer reports them as unavailable signals);
 *   a plan with none is `rejected` as `'infeasible'`.
 *
 * @param input The validated authoring input.
 * @param options The registry, the instrumentation context and the follow-up ids.
 * @returns The gate's verdict; never throws.
 */
export function gateInstrumentationPlan(
  input: InstrumentationPlanInput,
  options: PlanGateOptions,
): PlanGateOutcome {
  const { registry, context } = options;
  const log = options.logger ?? context.logger;
  const resolver = contextBoundResolver(registry, context);

  // Step 2 — deterministic normalisation.
  const normalized = normalizePlan(input, {
    sessionId: context.sessionId,
    planVersion: context.planVersion,
    resolver,
    previousActions: options.previousActions,
    newActionId: options.newActionId,
  });
  if (!normalized.ok) {
    log.error(PRODUCT_DEFECT_LOG, {
      stage: PLAN_STAGE,
      step: 'normalize',
      code: normalized.error.code,
      planVersion: context.planVersion,
      input,
    });
    return {
      kind: 'rejected',
      reason: 'normalization-failed',
      error: annotate(normalized.error, { stage: PLAN_STAGE }),
    };
  }

  // Step 3 — internal validation, against the imported schema object.
  const internal = instrumentationPlanSchema.safeParse(normalized.value);
  if (!internal.success) {
    const issues = describeIssues(internal.error.issues);
    log.error(PRODUCT_DEFECT_LOG, {
      stage: PLAN_STAGE,
      step: 'internal-validation',
      code: 'PLAN_INVALID',
      planVersion: context.planVersion,
      issues,
      input,
    });
    return {
      kind: 'rejected',
      reason: 'internal-validation-failed',
      error: new DebuggenError(
        'PLAN_INVALID',
        'The normalised instrumentation plan failed its internal schema.',
        {
          hint: 'This is a defect in plan normalisation rather than in the authored plan, so it was not re-prompted; report the logged field paths.',
          details: {
            stage: PLAN_STAGE,
            reason: 'internal-validation',
            issues,
            issueCount: internal.error.issues.length,
          },
        },
      ),
    };
  }
  const plan = internal.data;

  // Step 4 — feasibility, rejections as data.
  const checked = tryCatch(() => checkPlanFeasibility(plan, context, { resolver }), 'INTERNAL');
  if (!checked.ok) {
    log.error(GATE_FAILED_LOG, { stage: PLAN_STAGE, code: checked.error.code });
    return { kind: 'failed', error: annotate(checked.error, { stage: PLAN_STAGE }) };
  }
  const feasibility = checked.value;
  if (feasibility.feasible.length === 0) {
    return {
      kind: 'rejected',
      reason: 'infeasible',
      error: infeasibleError(feasibility),
      plan,
      feasibility,
    };
  }
  return { kind: 'accepted', plan, feasibility };
}

/* -------------------------------------------------------------------------------------------------
 * The one sanctioned fallback — a runtime-only default plan (AAP §0.5.3)
 * ---------------------------------------------------------------------------------------------- */

/** The failure of a fallback that no adapter could contribute a runtime action to. */
function noFallbackError(counts: Readonly<Record<string, number>>): DebuggenError {
  return new DebuggenError(
    'INSTRUMENTATION_UNAVAILABLE',
    'No registered adapter proposed a runtime-only signal for this project, so no fallback plan could be built.',
    {
      hint: 'Check that the project indexed with its components, requests or route handlers, then plan the instrumentation again.',
      details: { stage: PLAN_STAGE, reason: 'fallback-empty', ...counts },
    },
  );
}

/**
 * The objective of a fallback plan, composed at run time from what the
 * registry-derived actions capture and the validated understanding's category
 * — the only inputs it has. No objective, file, symbol or application name is
 * written here.
 */
function fallbackObjective(
  understanding: ProblemUnderstanding,
  labels: readonly string[],
  actions: readonly InstrumentationAction[],
): string {
  const captured =
    labels.length > 0
      ? labels.join(', ')
      : [...new Set(actions.map((action) => action.type))].join(', ');
  return `Capture ${captured} through runtime hooks only (problem category: ${understanding.category}), because the planned instrumentation could not be used.`;
}

/**
 * Builds the runtime-only default plan a rejected plan falls back to
 * (AAP §0.5.3) — **entirely from the live registry**, never pre-authored.
 *
 * 1. `registry.handling(context)` names the adapters that apply to the project.
 * 2. Each one's `createPlan(context, understanding)` is asked, in registration
 *    order. An adapter that throws or answers with something that is not a list
 *    is skipped and logged; a proposal that is not a valid action is dropped.
 * 3. Only `mode: "runtime"` actions whose type the context-bound registry also
 *    resolves to runtime mode are kept, de-duplicated by `actionIdentityKey`.
 *    Runtime is the whole point: such a plan touches no file (AAP §0.5.1).
 * 4. The authoring input is assembled from them — the objective and capture
 *    phrases from the product's signal labels and the understanding's category,
 *    each target's rationale the adapter's own — and held to exactly the gate a
 *    model's plan passes ({@link gateInstrumentationPlan}).
 * 5. If normalisation resolved any action to a file-changing mode, the plan is
 *    refused rather than emitted. Nothing feasible is also a refusal.
 *
 * @param registry The live adapter registry.
 * @param context The planning context; its `planVersion` and `sessionId` are stamped.
 * @param understanding The validated Stage 1 artifact every adapter plans from.
 * @param options Follow-up ids, an id factory and a logger.
 * @returns The gated fallback plan, or why none could be built.
 */
export async function buildRuntimeOnlyFallbackPlan(
  registry: AdapterRegistry,
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  options: RuntimeOnlyFallbackOptions = {},
): Promise<Result<RuntimeOnlyFallbackPlan, DebuggenError>> {
  const log = options.logger ?? context.logger;
  const resolver = contextBoundResolver(registry, context);

  const handling = tryCatch(() => registry.handling(context), 'INTERNAL');
  if (!handling.ok) {
    return err(annotate(handling.error, { stage: PLAN_STAGE, reason: 'fallback-registry' }));
  }

  const actions: InstrumentationAction[] = [];
  const seen = new Set<string>();
  const dropped = { patchMode: 0, unclaimed: 0, invalid: 0, duplicate: 0, adapterFailures: 0 };

  for (const adapter of handling.value) {
    if (isAborted(context.signal)) {
      return err(cancelledError(PLAN_STAGE));
    }

    let proposed: unknown;
    try {
      proposed = await adapter.createPlan(context, understanding);
    } catch (thrown) {
      dropped.adapterFailures += 1;
      log.warn(ADAPTER_SKIPPED_LOG, {
        stage: PLAN_STAGE,
        adapter: adapter.id,
        step: 'createPlan',
        errorName: thrownName(thrown),
      });
      continue;
    }
    if (!Array.isArray(proposed)) {
      dropped.adapterFailures += 1;
      log.warn(ADAPTER_SKIPPED_LOG, {
        stage: PLAN_STAGE,
        adapter: adapter.id,
        step: 'createPlan',
        errorName: typeof proposed,
      });
      continue;
    }

    const candidates: readonly unknown[] = proposed;
    for (const candidate of candidates) {
      const parsed = instrumentationActionSchema.safeParse(candidate);
      if (!parsed.success) {
        dropped.invalid += 1;
        continue;
      }
      const action = parsed.data;
      if (action.mode !== RUNTIME_MODE) {
        dropped.patchMode += 1;
        continue;
      }
      const resolution = resolver.resolveActionType(action.type);
      if (resolution === undefined) {
        dropped.unclaimed += 1;
        continue;
      }
      if (resolution.mode !== RUNTIME_MODE) {
        dropped.patchMode += 1;
        continue;
      }
      const key = actionIdentityKey(action);
      if (seen.has(key)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(key);
      actions.push(action);
    }
  }

  if (actions.length === 0) {
    return err(noFallbackError(dropped));
  }

  const labels = signalLabels(enabledSignals(actions));
  const input: InstrumentationPlanInput = {
    objective: fallbackObjective(understanding, labels, actions),
    capture: [...labels],
    instrumentationTargets: actions.map((action) => ({
      file: action.file,
      symbol: action.symbol,
      type: action.type,
      rationale: action.rationale,
    })),
    hypotheses: [],
  };

  const gated = gateInstrumentationPlan(input, {
    registry,
    context,
    previousActions: options.previousActions,
    newActionId: options.newActionId,
    logger: log,
  });
  if (gated.kind !== 'accepted') {
    return err(annotate(gated.error, { stage: PLAN_STAGE, fallback: true }));
  }

  // Runtime-only is the whole point: a fallback may never patch a file.
  const fileChanging = gated.plan.instrumentationTargets.filter(
    (action) => action.mode !== RUNTIME_MODE,
  );
  if (fileChanging.length > 0) {
    log.error(PRODUCT_DEFECT_LOG, {
      stage: PLAN_STAGE,
      step: 'fallback-mode',
      planVersion: context.planVersion,
      actions: countsByTypeAndMode(fileChanging),
    });
    return err(
      new DebuggenError(
        'INTERNAL',
        'The runtime-only fallback plan resolved an action to a file-changing mode, so it was not used.',
        {
          hint: 'No file was modified. Report the logged action counts; the adapter registry and its claims disagree.',
          details: {
            stage: PLAN_STAGE,
            reason: 'fallback-patch-mode',
            actions: fileChanging.length,
          },
        },
      ),
    );
  }

  log.debug('Built the runtime-only fallback plan.', {
    stage: PLAN_STAGE,
    planVersion: context.planVersion,
    actions: countsByTypeAndMode(gated.plan.instrumentationTargets),
    feasible: gated.feasibility.feasible.length,
    rejectionCodes: rejectionCodes(gated.feasibility.rejected),
    ...dropped,
  });
  return ok(Object.freeze({ plan: gated.plan, feasibility: gated.feasibility, input }));
}

/* -------------------------------------------------------------------------------------------------
 * The stage
 * ---------------------------------------------------------------------------------------------- */

/** What the model half of a run settled on, before anything is recorded. */
interface PlanDecision {
  readonly plan: InstrumentationPlan;
  readonly feasibility: FeasibilityReport;
  readonly repairs: number;
  readonly fallbackCause?: PlanFallbackCause | undefined;
}

/** A fallback cause in the rejecting subsystem's own words. */
function causeOf(reason: PlanRejectionReason, error: DebuggenError): PlanFallbackCause {
  return error.hint === undefined
    ? { reason, code: error.code, message: error.message }
    : { reason, code: error.code, message: error.message, hint: error.hint };
}

/**
 * The `running` rows that tell both user interfaces a fallback plan is in use —
 * composed only from the rejecting subsystem's sentences: the structured-output
 * gate's or the normaliser's error, or, for an infeasible plan,
 * `buildDegradationNotice`'s AAP §0.5.5 sentence per refused action with the
 * fallback's enabled signals as the "Continuing with" list.
 */
function fallbackRows(
  cause: PlanFallbackCause,
  rejected: FeasibilityReport | undefined,
  fallbackFeasible: readonly InstrumentationAction[],
): { readonly rows: readonly ProgressRow[]; readonly omitted: number } {
  const rows: ProgressRow[] = [];
  const seen = new Set<string>();

  const push = (message: string, detail: string | undefined): void => {
    const line = toDisplayLine(message);
    const second = detail === undefined ? '' : toDisplayLine(detail);
    const key = `${line}\n${second}`;
    if (line.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    rows.push({
      stage: PLAN_STAGE,
      status: 'running',
      message: line,
      ...(second.length > 0 ? { detail: second } : {}),
    });
  };

  if (cause.reason === 'infeasible' && rejected !== undefined) {
    const enabled = signalLabels(enabledSignals(fallbackFeasible));
    for (const entry of unavailableFromRejections(rejected.rejected)) {
      const [sentence] = buildDegradationNotice([entry], enabled);
      if (sentence !== undefined) {
        push(sentence, entry.hint);
      }
    }
  } else {
    push(cause.message, cause.hint);
  }

  return {
    rows: rows.slice(0, MAX_FALLBACK_ROWS),
    omitted: Math.max(0, rows.length - MAX_FALLBACK_ROWS),
  };
}

/** Awaits a collaborator's `Result`; a rejected promise or a throw becomes an `Err`. */
async function settle<T>(
  call: () => Promise<Result<T, DebuggenError>>,
  code: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code));
  }
}

/**
 * Creates Stage 3, instrumentation planning (AAP §0.4.2).
 *
 * One run, in order:
 *
 * 1. `plan` group header; the next plan version from `SessionsRepo`.
 * 2. The planning context from `InstrumentationService.buildContext`, and
 *    {@link buildAdapterCatalog} from the live registry.
 * 3. `ContextBuilder.buildPlanRequest` with the prompt's four placeholders —
 *    `understanding`, `investigation`, `adapterCatalog` and (rendered by the
 *    builder from the authoring schema) `outputSchema`. A builder `Err` is the
 *    outbound guard or a prompt that cannot load: the provider is never called.
 * 4. `generateStructuredWithRepair` against `instrumentationPlanInputSchema`,
 *    then {@link gateInstrumentationPlan}. A rejected plan becomes
 *    {@link buildRuntimeOnlyFallbackPlan}; a provider outage fails the stage.
 * 5. `SessionManager.recordPlan`, the `plan` group's closing row, the optional
 *    `beforeInstall` hand-off, then `InstrumentationService.install` — only the
 *    delta when `previousActions` marks a follow-up.
 *
 * The factory holds no state beyond its collaborators; one instance serves every
 * session of the process.
 *
 * @param deps The collaborators and options; see {@link PlanStageDeps}.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const plan = createPlanStage({
 *   contextBuilder, provider, registry, instrumentation, sessions, sessionManager, progress, logger,
 * });
 * const outcome = await plan.run(context, { understanding, investigation, readiness: evidence.observed });
 * if (outcome.ok && outcome.value.installation.readiness.satisfied) {
 *   await manager.transitionTo(sessionId, 'ready', { readinessSatisfied: true });
 * }
 * ```
 */
export function createPlanStage(deps: PlanStageDeps): PlanStage {
  const {
    contextBuilder,
    provider,
    registry,
    instrumentation,
    sessions,
    sessionManager,
    progress,
  } = deps;
  const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;

  /** The run's logger: session-bound, then bound to the pipeline subsystem and this stage. */
  const loggerFor = (context: PipelineStageContext): Logger => {
    const base =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, context.captureId);
    return subsystemLogger(base, PIPELINE_SUBSYSTEM).child({ stage: PLAN_STAGE });
  };

  /** Emits one progress row; a failure is logged at `warn` and never fails the stage. */
  const emitProgress = (
    row: ProgressRowKind,
    log: Logger,
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    const failure = progressFailureOf(tryCatch(send, 'INTERNAL'));
    if (failure !== undefined) {
      log.warn(PROGRESS_FAILED_LOG, { stage: PLAN_STAGE, row, code: failure.code });
    }
  };

  /**
   * Tags the failure with its stage, logs it, closes that stage's progress
   * group with a `failed` row (unless the failing subsystem already did) and
   * returns it.
   */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    error: DebuggenError,
    stage: ProgressStage = PLAN_STAGE,
    emitRow = true,
  ): Result<PlanStageResult, DebuggenError> => {
    const tagged = withStage(error, stage);
    const reason = reasonOf(tagged);
    log.warn(FAILED_LOG, {
      stage,
      code: tagged.code,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (emitRow) {
      emitProgress('failed', log, () =>
        progress.stageFailed(context.sessionId, sessionFailureOf(tagged, stage)),
      );
    }
    return err(tagged);
  };

  /** The next plan version, checked against the follow-up flag. */
  const resolvePlanVersion = (
    context: PipelineStageContext,
    input: PlanStageInput,
  ): Result<number, DebuggenError> => {
    const next = tryCatch(() => sessions.nextPlanVersion(context.sessionId), 'STORE_ERROR');
    const version = next.ok ? next.value : next;
    if (!version.ok) {
      return version;
    }
    if (input.previousActions !== undefined && version.value < 2) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'A follow-up plan was requested for a session that has no earlier plan version.',
          {
            hint: "Plan the session's first instrumentation without previous actions.",
            details: { stage: PLAN_STAGE, reason: 'no-previous-plan', planVersion: version.value },
          },
        ),
      );
    }
    return version;
  };

  /** The instrumentation context of the plan version about to be authored. */
  const planningContext = (
    context: PipelineStageContext,
    input: PlanStageInput,
    planVersion: number,
  ): Result<InstrumentationContext, DebuggenError> => {
    const built = tryCatch(
      () =>
        instrumentation.buildContext({
          sessionId: context.sessionId,
          projectRoot: context.projectRoot,
          plan: { planVersion },
          code: codeHandlesOf(context),
          readiness: input.readiness ?? {},
          signal: context.signal,
        }),
      'INTERNAL',
    );
    return built.ok ? built.value : built;
  };

  /** Builds the request through the context builder; an unexpected throw becomes an `Err`. */
  const buildRequest = (
    context: PipelineStageContext,
    input: PlanStageInput,
    catalog: readonly AdapterCatalogEntry[],
  ): Result<StageRequestBuild, DebuggenError> => {
    const built = tryCatch(
      () =>
        contextBuilder.buildPlanRequest({
          context,
          promptVersion: input.promptVersion,
          understanding: input.understanding,
          investigation: input.investigation,
          adapterCatalog: catalog,
        }),
      'INTERNAL',
    );
    return built.ok ? built.value : built;
  };

  /**
   * The model half: the authoring gate with its repair loop, then steps 2–4,
   * then — for a rejected plan only — the runtime-only fallback.
   */
  const decide = async (
    context: PipelineStageContext,
    log: Logger,
    input: PlanStageInput,
    planning: InstrumentationContext,
    request: StageRequestBuild['request'],
  ): Promise<Result<PlanDecision, DebuggenError>> => {
    // Step 1 — authoring validation. The repair budget, the abort check before
    // every call and the typed rejections all live upstream; nothing wraps it.
    const answer = await settle(
      () =>
        generateStructuredWithRepair(provider, instrumentationPlanInputSchema, request, {
          maxRepairs,
          schemaName: PLAN_SCHEMA_NAME,
          logger: log,
        }),
      'INTERNAL',
    );

    let cause: PlanFallbackCause;
    let rejected: FeasibilityReport | undefined;
    let repairs: number;

    if (!answer.ok) {
      const reason = reasonOf(answer.error);
      // Only a rejected *answer* falls back. A provider outage, a cancellation
      // or an unexpected defect is a stage failure carrying its own sentence.
      if (reason !== 'schema' && reason !== 'empty') {
        return err(answer.error);
      }
      cause = causeOf('model-output-invalid', answer.error);
      repairs = numericDetail(answer.error, 'repairs');
    } else {
      repairs = answer.value.repairs;
      // Steps 2–4 — deterministic; never re-prompted.
      const gated = gateInstrumentationPlan(answer.value.value, {
        registry,
        context: planning,
        previousActions: input.previousActions,
        logger: log,
      });
      if (gated.kind === 'accepted') {
        return ok({ plan: gated.plan, feasibility: gated.feasibility, repairs });
      }
      if (gated.kind === 'failed') {
        return err(gated.error);
      }
      cause = causeOf(gated.reason, gated.error);
      rejected = gated.feasibility;
    }

    if (isAborted(context.signal)) {
      return err(cancelledError(PLAN_STAGE));
    }

    // The one sanctioned fallback (AAP §0.5.3).
    const fallback = await settle(
      () =>
        buildRuntimeOnlyFallbackPlan(registry, planning, input.understanding, {
          previousActions: input.previousActions,
          logger: log,
        }),
      'INTERNAL',
    );
    if (!fallback.ok) {
      return err(annotate(fallback.error, { planRejection: cause.reason }));
    }

    log.warn(FALLBACK_LOG, {
      stage: PLAN_STAGE,
      reason: cause.reason,
      code: cause.code,
      repairs,
      fallbackActions: countsByTypeAndMode(fallback.value.plan.instrumentationTargets),
      ...(rejected !== undefined ? { rejectionCodes: rejectionCodes(rejected.rejected) } : {}),
    });
    const { rows, omitted } = fallbackRows(cause, rejected, fallback.value.feasibility.feasible);
    for (const row of rows) {
      emitProgress('fallback', log, () => progress.emit(context.sessionId, row));
    }
    if (omitted > 0) {
      log.debug('Fallback degradation rows were capped.', { stage: PLAN_STAGE, omitted });
    }

    return ok({
      plan: fallback.value.plan,
      feasibility: fallback.value.feasibility,
      repairs,
      fallbackCause: cause,
    });
  };

  const run = async (
    context: PipelineStageContext,
    input: PlanStageInput,
  ): Promise<Result<PlanStageResult, DebuggenError>> => {
    const log = loggerFor(context);

    if (!isValidRepairBudget(maxRepairs)) {
      // A programmer error, reported before any progress row or provider call.
      const error = repairBudgetError(maxRepairs);
      log.error(FAILED_LOG, { stage: PLAN_STAGE, code: error.code, reason: 'repair-budget' });
      return err(error);
    }
    if (isAborted(context.signal)) {
      log.debug(CANCELLED_LOG, { stage: PLAN_STAGE });
      return err(cancelledError(PLAN_STAGE));
    }

    const started = context.now();
    emitProgress('started', log, () => progress.stageStarted(context.sessionId, PLAN_STAGE));

    const version = resolvePlanVersion(context, input);
    if (!version.ok) {
      return fail(context, log, version.error);
    }
    const planVersion = version.value;

    const planning = planningContext(context, input, planVersion);
    if (!planning.ok) {
      return fail(context, log, planning.error);
    }

    const catalog = await fromPromise(buildAdapterCatalog(registry, planning.value), 'INTERNAL');
    if (!catalog.ok) {
      return fail(context, log, catalog.error);
    }

    // The builder has already run the outbound guard: an `Err` here means the
    // payload must not leave the machine, so the provider is never called.
    const built = buildRequest(context, input, catalog.value);
    if (!built.ok) {
      return fail(context, log, built.error);
    }
    const { request, promptVersion } = built.value;

    const decided = await decide(context, log, input, planning.value, request);
    if (!decided.ok) {
      return fail(context, log, decided.error);
    }
    const decision = decided.value;

    if (isAborted(context.signal)) {
      return fail(context, log, cancelledError(PLAN_STAGE));
    }

    // Persistence: the manager stamps and validates the ladder, writes the
    // store's `plans` row and the record, and broadcasts `session.updated`.
    const recorded = await settle(
      () => sessionManager.recordPlan(context.sessionId, decision.plan),
      'INTERNAL',
    );
    if (!recorded.ok) {
      return fail(context, log, recorded.error);
    }
    const plan = recorded.value.plan;

    log.info(COMPLETED_LOG, {
      stage: PLAN_STAGE,
      planVersion: plan.planVersion,
      promptVersion,
      repairs: decision.repairs,
      fallback: decision.fallbackCause !== undefined,
      actions: countsByTypeAndMode(plan.instrumentationTargets),
      feasible: decision.feasibility.feasible.length,
      rejectionCodes: rejectionCodes(decision.feasibility.rejected),
      catalogEntries: catalog.value.length,
      bytes: built.value.bytes,
      truncatedSections: built.value.truncated.length,
      followUp: input.previousActions !== undefined,
      durationMs: Math.max(0, context.now() - started),
    } satisfies LogFields);
    emitProgress('completed', log, () => progress.stageCompleted(context.sessionId, PLAN_STAGE));

    // The orchestrator's seam for `planning → instrumenting`; this stage writes no status.
    const beforeInstall = input.beforeInstall;
    if (beforeInstall !== undefined) {
      const handed = await settle(() => beforeInstall(recorded.value), 'INTERNAL');
      if (!handed.ok) {
        return fail(context, log, handed.error, INSTRUMENT_STAGE);
      }
    }
    if (isAborted(context.signal)) {
      return fail(context, log, cancelledError(INSTRUMENT_STAGE), INSTRUMENT_STAGE);
    }

    // Installation — the only path that may write to the developer's project.
    // A follow-up installs only the delta against the previous version's actions.
    const installRequest: InstallRequest = {
      sessionId: context.sessionId,
      projectRoot: context.projectRoot,
      plan,
      code: codeHandlesOf(context),
      boundTab: context.session.boundTab,
      devServerUrl: context.session.devServerUrl,
      ...(input.previousActions !== undefined
        ? { previousPlanVersion: plan.planVersion - 1, previousActions: input.previousActions }
        : {}),
      signal: context.signal,
    };

    let installed: Result<InstrumentationOutcome, DebuggenError>;
    try {
      installed = await instrumentation.install(installRequest);
    } catch (thrown) {
      return fail(context, log, DebuggenError.from(thrown, 'INTERNAL'), INSTRUMENT_STAGE);
    }
    if (!installed.ok) {
      // The instrumentation service has already sent `instrumentation.failed`
      // and the instrument stage's `failed` row; it is not repeated here.
      return fail(context, log, installed.error, INSTRUMENT_STAGE, false);
    }

    return ok(
      Object.freeze({
        plan,
        planVersion: plan.planVersion,
        promptVersion,
        repairs: decision.repairs,
        feasibility: decision.feasibility,
        fallback: decision.fallbackCause !== undefined,
        ...(decision.fallbackCause !== undefined ? { fallbackCause: decision.fallbackCause } : {}),
        session: recorded.value.session,
        installation: installed.value,
      }),
    );
  };

  return Object.freeze({ run });
}
