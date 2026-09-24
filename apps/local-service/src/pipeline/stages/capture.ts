/**
 * Stage 4 of the reasoning pipeline — **runtime capture**: the seam between the
 * installed plan and the evidence the later stages reason about (AAP §0.4.2,
 * "AI stage boundaries", Runtime-capture row: "plan → `AgentHookConfig`,
 * readiness → `CaptureSummary` (no model)").
 *
 * It is the one stage of this folder that makes **no model call**. There is no
 * prompt file for it, no entry in `prompts/manifest.json`, no prompt version on
 * its results and no provider among its collaborators; protocol's
 * `PROMPT_STAGE_KEYS` deliberately omits it, which
 * {@link CaptureStageHasNoPrompt} pins at compile time. Everything it does is
 * derivation and gating over artifacts other modules own.
 *
 * ## The two calls
 *
 * The orchestrator's capture window is two requests from the developer —
 * "Start capture" and "Stop capture" — so this stage has two methods, in that
 * order ({@link CaptureStage.arm} and {@link CaptureStage.complete}).
 *
 * **Arm** (AAP §0.5.1, §0.5.5, §0.7.1 Group 2):
 *
 * 1. Reads the session fresh through the session manager and takes its active
 *    plan version, and refuses early — with the state machine's own refusal —
 *    when the session may not enter `capturing` at all.
 * 2. **The readiness gate.** The verdict is re-evaluated through the
 *    instrumentation layer when it offers that
 *    ({@link CaptureReadinessSource}); otherwise the verdict the install reached
 *    is used. `satisfied: false` stops here with a typed `Err` carrying the
 *    verdict's `blocking` entries and `remediations` — `bind-tab`,
 *    `reload-page` or `relaunch-dev-server` — so each surface shows the right
 *    remedy. `degraded` entries never block: an absent or stale dev-server
 *    preload degrades the capture, it does not fail it.
 * 3. Opens the capture window through `SessionManager.startCapture`, whose
 *    one-capture-per-project conflict is returned unchanged so the route can
 *    answer `409 { owningSessionId }`.
 * 4. Arms both producers through `InstrumentationService.armCapture`, which
 *    sends `agent.config` and `server-agent.config` carrying the configuration
 *    the installer derived with the upstream `deriveAgentHookConfig` /
 *    `deriveServerAgentSignals` — nothing is reshaped, enveloped or broadcast
 *    here. A failed arm closes the window it opened again (through the manager,
 *    back to `ready`) so a session is never left `capturing` with nothing
 *    collecting.
 *
 * **Complete**:
 *
 * 1. Resolves the capture window and disarms both producers through
 *    `InstrumentationService.disarmCapture` (the dormant page configuration and
 *    the capture-less preload configuration: disabled, not idled).
 * 2. Produces the {@link CaptureSummary}: the stored one when the capture row
 *    already holds it, otherwise `computeCaptureSummary` from
 *    `@debuggen/telemetry` over the capture's persisted, already-redacted
 *    events. No metric, aggregate, correlation or redaction is computed here.
 * 3. **The empty-capture rule of AAP §0.5.5**, as the pure
 *    {@link classifyCaptureEmptiness}: zero events, or zero browser interactions
 *    for a question whose validated understanding needs interactions. An empty
 *    capture is a legitimate outcome, not a crash.
 * 4. Closes the window through `SessionManager.stopCapture` with
 *    `next: "ready"` for an empty capture and `next: "analyzing"` otherwise —
 *    the decision the manager's contract assigns to this stage. The manager
 *    persists the summary, broadcasts `capture.stopped` and applies the
 *    transition; this stage writes no status of its own and never runs,
 *    skips or fabricates an analysis.
 *
 * ## Boundaries
 *
 * - **No hardcoded behaviour (AAP §0.5.4).** Nothing here reads the
 *   developer's question: whether a capture needed interactions is decided from
 *   the understanding's closed `signalsNeeded` vocabulary. No application
 *   identifier, route or path appears, and no hook or signal configuration is
 *   built by hand.
 * - **Nothing is written to the developer's project.** No filesystem access and
 *   no process spawn; only `../../instrumentation/service.ts` changes a working
 *   tree, and only when handed a validated plan.
 * - **Privacy (AAP §0.5.2).** Log records carry ids, counts per kind and tier,
 *   durations, enumerated reasons and error codes — never an event's name,
 *   attributes, URL or statement, never a request key, token or the question —
 *   and no captured value is echoed into an error.
 * - **Progress is advisory.** The `capture` group's header and closing row go
 *   through `../../sessions/progress.ts`'s stage methods; a row that cannot be
 *   sent is logged and never fails the stage. The only sentence this module
 *   defines is AAP §0.5.5's empty-capture sentence ({@link CAPTURE_EMPTY_MESSAGE}).
 * - Every expected failure is a `Result` `Err`; neither method rejects.
 *
 * @module
 */

import {
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  isCaptureSignal,
  telemetryKindsForSignal,
} from '@debuggen/instrumentation';
import type {
  AdapterRegistry,
  AgentHookConfig,
  CaptureSignal,
  InstrumentationPlan,
  ProblemUnderstanding,
  ServerAgentSignals,
  UnavailableSignal,
} from '@debuggen/instrumentation';
import type {
  BoundTab,
  CaptureRecord,
  ProgressStage,
  PromptStageKey,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';
import type { CaptureSummary, TelemetryEvent } from '@debuggen/telemetry';

import { buildDegradationNotice } from '../../instrumentation/service.js';
import type {
  ArmCaptureOutcome,
  DisarmCaptureOutcome,
  InstrumentationService,
  ServerAgentDelivery,
} from '../../instrumentation/service.js';
import type {
  ReadinessRemediationKind,
  ReadinessVerdict,
} from '../../instrumentation/readiness.js';
import { LOG_BINDING_KEYS, sessionLogger, subsystemLogger } from '../../logging.js';
import type { CaptureStopNext, SessionManager } from '../../sessions/manager.js';
import { CAPTURE_SIGNAL_LABELS, INSTRUMENTATION_ROW_ORDER } from '../../sessions/progress.js';
import type { SessionProgress } from '../../sessions/progress.js';
import { STAGE_STATUS, transition } from '../../sessions/state-machine.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import { TELEMETRY_QUERY_MAX_LIMIT } from '../../store/telemetry-repo.js';
import type { TelemetryRepo } from '../../store/telemetry-repo.js';
import type { PipelineStageContext } from '../context-builder.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in protocol's `PROGRESS_STAGES` — the stage its
 * `session.progress` rows are addressed to. The `satisfies` clause makes a
 * rename upstream a compile error here rather than rows addressed to a stage
 * nobody renders (AAP §0.4.2).
 */
export const CAPTURE_STAGE = 'capture' as const satisfies ProgressStage;

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that the capture stage has **no prompt**: `capture` is not
 * a member of protocol's `PROMPT_STAGE_KEYS`, the stages with a versioned
 * prompt directory (AAP §0.4.2, §0.5.3). Adding it there — which would imply a
 * model call this stage must never make — fails `tsc -b` here. Exported so
 * `noUnusedLocals` treats it as used; it has no runtime existence.
 */
export type CaptureStageHasNoPrompt = AssertTrue<
  typeof CAPTURE_STAGE extends PromptStageKey ? false : true
>;

/**
 * The developer-facing sentence of AAP §0.5.5's "Capture yielded nothing" row,
 * verbatim: the closing row of an empty capture and the message
 * {@link EmptyCapture} carries to the caller. Not reworded anywhere; a surface
 * that shows the empty-capture outcome shows exactly this.
 */
export const CAPTURE_EMPTY_MESSAGE =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/**
 * Why a capture counts as empty — the two conditions AAP §0.5.5 names, as a
 * closed vocabulary:
 *
 * - `'no-events'` — the capture window recorded no event at all, on any tier.
 * - `'no-interaction'` — events arrived, but the validated understanding needs
 *   the interaction signal and the page recorded no user interaction while the
 *   interaction hook was armed. Without an interaction there is no trace root
 *   to hang the browser and server evidence off, so an analysis would answer a
 *   question nobody reproduced.
 */
export const CAPTURE_EMPTINESS_REASONS = Object.freeze(['no-events', 'no-interaction'] as const);

/** One member of {@link CAPTURE_EMPTINESS_REASONS}. */
export type CaptureEmptinessReason = (typeof CAPTURE_EMPTINESS_REASONS)[number];

/**
 * The capture signal whose presence in `signalsNeeded` makes a question an
 * interaction question, typed against the closed signal vocabulary so a rename
 * upstream is a compile error. The telemetry kinds it produces are looked up
 * through `telemetryKindsForSignal` rather than restated.
 */
const INTERACTION_SIGNAL = 'interactions' as const satisfies CaptureSignal;

/** The session status the capture stage runs under, from the state machine's own table. */
const CAPTURING_STATUS = STAGE_STATUS[CAPTURE_STAGE];

/** Where a capture that holds evidence sends its session: the status the analysis stage runs under. */
const NEXT_WITH_EVIDENCE: CaptureStopNext = STAGE_STATUS.analyze;

/** Where an empty capture sends its session: back to `ready`, so "Capture again" re-arms the same plan. */
const NEXT_WHEN_EMPTY: CaptureStopNext = 'ready';

/** The `subsystem` binding of this stage's log records, shared by every pipeline module. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/**
 * The display bound of a composed error message: the `session.progress`
 * transport bound on a row's message, so a caller that renders the error as a
 * row never has to clip it again.
 */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

/** The display bound of a composed hint: the `instrumentation.failed` bound on its hint. */
const MAX_ERROR_HINT_LENGTH = 1000;

/** Punctuation stripped from the end of an adapter's reason before a sentence closes it. */
const TRAILING_PUNCTUATION_PATTERN = /[\s.!?;:,]+$/u;

/** Any run of whitespace, collapsed to one space in display text. */
const WHITESPACE_RUN_PATTERN = /\s+/gu;

/**
 * The error code a blocked readiness gate reports, keyed by the first
 * remediation the verdict names (the verdict lists them in this same order).
 * Total over the remediation kinds, so a new kind is a compile error until it
 * says which failure it is.
 */
const BLOCKED_GATE_CODES = Object.freeze({
  'bind-tab': 'TAB_NOT_BOUND',
  'reload-page': 'AGENT_NOT_READY',
  'relaunch-dev-server': 'SERVER_AGENT_NOT_READY',
} as const satisfies Readonly<Record<ReadinessRemediationKind, DebuggenErrorCode>>);

/** The code of a blocked gate that names no remediation: no planned signal can be delivered. */
const BLOCKED_GATE_FALLBACK_CODE: DebuggenErrorCode = 'INSTRUMENTATION_UNAVAILABLE';

/**
 * The message of a blocked gate whose verdict lists no blocking entry to quote —
 * the verdict's "no planned signal is deliverable" case with nothing more
 * specific attached. Every other blocked gate is described by the readiness
 * module's own reasons.
 */
const NOTHING_DELIVERABLE_MESSAGE = 'None of the planned signals can be collected yet.';

/** The recovery step of {@link NOTHING_DELIVERABLE_MESSAGE}. */
const NOTHING_DELIVERABLE_HINT =
  'Follow the readiness remediations shown for the session, then start the capture again.';

/* -------------------------------------------------------------------------------------------------
 * The empty-capture rule (AAP §0.5.5) — pure
 * ---------------------------------------------------------------------------------------------- */

/** The counts every emptiness classification reports, empty or not. */
export interface CaptureEvidenceCounts {
  /** How many events the summary was computed from (`CaptureSummary.eventCount`). */
  readonly eventCount: number;
  /** How many browser interactions the capture recorded, summed over the interaction signal's kinds. */
  readonly interactionCount: number;
  /**
   * Whether this capture had to record an interaction to be worth analysing:
   * the understanding needs the interaction signal **and** the interaction hook
   * was armed (or its arming is unknown).
   */
  readonly interactionRequired: boolean;
}

/** A capture that holds evidence worth analysing. */
export interface CaptureWithEvidence extends CaptureEvidenceCounts {
  readonly empty: false;
}

/**
 * A capture that yielded nothing to analyse (AAP §0.5.5): analysis is skipped,
 * the session returns to `ready`, and "Capture again" re-arms the same plan.
 */
export interface EmptyCapture extends CaptureEvidenceCounts {
  readonly empty: true;
  /** Which of the two documented conditions held. */
  readonly reason: CaptureEmptinessReason;
  /** The developer-facing sentence, {@link CAPTURE_EMPTY_MESSAGE}. */
  readonly message: typeof CAPTURE_EMPTY_MESSAGE;
}

/**
 * Whether a capture holds evidence, discriminated on `empty` (AAP §0.5.5).
 * Plain, frozen JSON data: safe to log (it holds counts only), persist or send.
 */
export type CaptureEmptiness = CaptureWithEvidence | EmptyCapture;

/** Optional facts {@link classifyCaptureEmptiness} can take into account. */
export interface ClassifyCaptureEmptinessOptions {
  /**
   * The page-agent hooks the capture was armed with. When supplied and its
   * `interactions` hook was off — a plan that armed nothing in the page — the
   * interaction condition does not apply: asking the developer to "interact,
   * then Capture again" could never produce an interaction that nothing was
   * listening for. Absent, the hook is assumed armed.
   */
  readonly agentHooks?: AgentHookConfig | undefined;
}

/** A finite, non-negative whole count from a value that should be one; anything else counts as zero. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * A list read from an artifact that crossed a boundary (a stored record, a
 * caller-supplied verdict): the list itself when it is one, otherwise empty,
 * so a malformed field reads as "nothing" rather than throwing mid-decision.
 */
function listOf<T>(value: readonly T[] | undefined): readonly T[] {
  return isList(value) ? value : [];
}

/**
 * Whether a value that should be a list is one. A named guard rather than a
 * bare `Array.isArray`, whose built-in narrowing of a read-only array widens
 * its elements to `any`.
 */
function isList<T>(value: readonly T[] | undefined): value is readonly T[] {
  return Array.isArray(value);
}

/**
 * Whether a validated understanding says the question can only be answered
 * from a user interaction: its closed `signalsNeeded` vocabulary names the
 * interaction signal.
 *
 * The decision is read from `signalsNeeded` rather than from the `category`
 * alone because a category does not settle it: a `'rendering'` question about
 * work repeated while the page is idle needs renders and no click, and a
 * `'performance'` question about an interaction needs the click — which Stage 1
 * records as the interaction signal. The question text is never consulted
 * (AAP §0.5.4).
 *
 * @param understanding The session's validated Stage 1 understanding, when it
 * has one.
 * @returns `true` when the interaction signal is among the signals needed.
 */
export function understandingNeedsInteraction(
  understanding: ProblemUnderstanding | undefined,
): boolean {
  if (understanding === undefined) {
    return false;
  }
  return listOf<CaptureSignal>(understanding.signalsNeeded).includes(INTERACTION_SIGNAL);
}

/**
 * Classifies a capture as holding evidence or as empty, per AAP §0.5.5: **zero
 * events**, or **zero browser interactions for an interaction question**.
 *
 * Pure and total: no clock, no I/O, no logger, no throw, and the same inputs
 * always give the same frozen answer. The interaction count is summed over the
 * telemetry kinds the interaction signal produces
 * (`telemetryKindsForSignal`), read from the summary's zero-filled per-kind
 * counts, so no kind name is restated here. A malformed count reads as zero.
 *
 * This function **reports**; it does not act. The caller decides what an empty
 * capture means for the session — this stage passes `next: "ready"` to the
 * session manager, and the orchestrator skips analysis.
 *
 * @param summary The capture's summary.
 * @param understanding The session's validated understanding, when it has one;
 * absent, only the zero-events condition applies.
 * @param options Optional arming facts; see
 * {@link ClassifyCaptureEmptinessOptions}.
 * @returns The classification with the counts it was decided from.
 *
 * @example
 * ```ts
 * const emptiness = classifyCaptureEmptiness(summary, session.understanding);
 * if (emptiness.empty) {
 *   // Skip analysis; show emptiness.message.
 * }
 * ```
 */
export function classifyCaptureEmptiness(
  summary: CaptureSummary,
  understanding: ProblemUnderstanding | undefined,
  options?: ClassifyCaptureEmptinessOptions,
): CaptureEmptiness {
  const eventCount = countOf(summary.eventCount);
  let interactionCount = 0;
  for (const kind of telemetryKindsForSignal(INTERACTION_SIGNAL)) {
    interactionCount += countOf(summary.kindCounts[kind]);
  }
  const hookArmed = options?.agentHooks === undefined || options.agentHooks.interactions;
  const interactionRequired = hookArmed && understandingNeedsInteraction(understanding);
  const counts: CaptureEvidenceCounts = { eventCount, interactionCount, interactionRequired };

  if (eventCount === 0) {
    return Object.freeze({
      ...counts,
      empty: true,
      reason: 'no-events',
      message: CAPTURE_EMPTY_MESSAGE,
    });
  }
  if (interactionRequired && interactionCount === 0) {
    return Object.freeze({
      ...counts,
      empty: true,
      reason: 'no-interaction',
      message: CAPTURE_EMPTY_MESSAGE,
    });
  }
  return Object.freeze({ ...counts, empty: false });
}

/* -------------------------------------------------------------------------------------------------
 * Public contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The slice of the pipeline's stage context this stage reads. A full
 * `PipelineStageContext` is accepted as it is; the narrower type lets a caller
 * that only opens or closes a capture window do so without loading the
 * project's code index, which this stage never touches.
 */
export type CaptureStageContext = Pick<
  PipelineStageContext,
  'sessionId' | 'session' | 'projectRoot' | 'logger' | 'now' | 'signal' | 'captureId'
>;

/** What a readiness re-evaluation is asked about; see {@link CaptureReadinessSource}. */
export interface CaptureReadinessRequest {
  /** The session about to capture. */
  readonly sessionId: string;
  /** The session's project root, absolute and POSIX-normalised. */
  readonly projectRoot: string;
  /** The session's active, installed plan version. */
  readonly plan: InstrumentationPlan;
  /** The tab bound to the session, when one is. */
  readonly boundTab?: BoundTab | undefined;
  /** Whether the gate may ask for a page reload. Absent means the gate's own default. */
  readonly allowReloadPrompt?: boolean | undefined;
  /** Whether a missing dev-server preload blocks rather than degrades. Absent means the gate's default. */
  readonly requireServerAgent?: boolean | undefined;
  /** Abandons a reload wait early; the verdict is still returned. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A re-evaluation of the readiness gate at capture time — a page may have
 * reloaded, a tab may have been unbound or a preload may have disconnected
 * since the plan was installed.
 *
 * Declared structurally so the instrumentation layer can offer it on the same
 * object as {@link CaptureInstrumentationPort} without this stage importing
 * the readiness module's functions: `../../instrumentation/readiness.ts` is
 * consumed by `../../instrumentation/service.ts` only, and this stage reaches
 * readiness through that layer.
 */
export interface CaptureReadinessSource {
  /**
   * Evaluates the readiness gate for one session's active plan.
   *
   * @returns The verdict, or the gate's own `Err` when it could not be reached.
   */
  evaluateReadiness(
    request: CaptureReadinessRequest,
  ): Promise<Result<ReadinessVerdict, DebuggenError>>;
}

/**
 * What this stage calls on the instrumentation layer: arming, disarming and
 * the arming state the service holds — plus, when that layer offers it, a
 * readiness re-evaluation. The service built by
 * `createInstrumentationService` satisfies it as it stands.
 */
export type CaptureInstrumentationPort = Pick<
  InstrumentationService,
  'armCapture' | 'disarmCapture' | 'arming'
> &
  Partial<CaptureReadinessSource>;

/**
 * Collaborators of {@link createCaptureStage}; everything is injected (AAP
 * §0.7.1 Group 2). Each member is typed as the narrowest slice of its owning
 * module's interface this stage calls, so the full service objects — and the
 * fakes an orchestrator test substitutes — are accepted. There is no model
 * provider and no context builder: this stage makes no model call and renders
 * no prompt.
 */
export interface CaptureStageDeps {
  /** Arms and disarms the two producers and holds their arming state (`../../instrumentation/service.ts`). */
  readonly instrumentation: CaptureInstrumentationPort;
  /** The capture rows: which window is open and what a stopped one recorded. */
  readonly sessions: Pick<SessionsRepo, 'getCapture' | 'getActiveCapture'>;
  /** The capture's persisted, already-redacted events, read only to summarise them. */
  readonly telemetry: Pick<TelemetryRepo, 'listByCapture'>;
  /** The only writer of session status: reads the record, opens and closes capture windows. */
  readonly sessionManager: Pick<SessionManager, 'get' | 'startCapture' | 'stopCapture'>;
  /** The `session.progress` emitter (`../../sessions/progress.ts`). */
  readonly progress: Pick<SessionProgress, 'stageStarted' | 'stageCompleted' | 'stageFailed'>;
  /**
   * The adapter registry, asked only whether the adapter a stored action names
   * is still registered, so that the arming state recomputed after a restart
   * counts only actions that could have been installed.
   */
  readonly registry: Pick<AdapterRegistry, 'get'>;
  /**
   * A parent logger. Absent, each call logs through the stage context's
   * session-bound logger; either way records are bound to the `pipeline`
   * subsystem, this stage, the session and the capture.
   */
  readonly logger?: Logger | undefined;
  /** The clock durations are measured with. Absent, the stage context's clock is used. */
  readonly now?: (() => number) | undefined;
  /**
   * Whether this stage emits its own group rows — the `running` header when a
   * capture is armed, the closing `done` row when it completes (carrying
   * {@link CAPTURE_EMPTY_MESSAGE} for an empty capture) and the `failed` row
   * when completing fails. Defaults to `true`.
   *
   * A caller that emits every stage's header and closing row itself, and routes
   * a failure to the `failed` status through the session manager (which writes
   * that stage's `failed` row as part of the transition), passes `false` so no
   * row appears twice; it then shows {@link EmptyCapture.message} itself.
   */
  readonly reportStageBoundaries?: boolean | undefined;
}

/** What {@link CaptureStage.arm} is told beyond the stage context. Every member is optional. */
export interface CaptureArmInput {
  /**
   * The verdict the install reached (`InstrumentationOutcome.readiness`). Used
   * when the instrumentation layer offers no re-evaluation; a re-evaluation,
   * when offered, supersedes it because the page may have changed since.
   */
  readonly readiness?: ReadinessVerdict | undefined;
  /** Forwarded to a re-evaluation: whether the gate may ask for a page reload. */
  readonly allowReloadPrompt?: boolean | undefined;
  /** Forwarded to a re-evaluation: whether a missing preload blocks. */
  readonly requireServerAgent?: boolean | undefined;
}

/** Where the verdict an arm was gated on came from. */
export type CaptureReadinessSourceKind = 'reevaluated' | 'supplied';

/**
 * What a successful arm left in place: an open capture window and two armed
 * producers. Plain JSON data, safe to log and broadcast.
 */
export interface CaptureArmResult {
  /** The capture window the session manager opened. */
  readonly captureId: string;
  /** The plan version whose configuration was armed. */
  readonly planVersion: number;
  /** The readiness verdict the capture was gated on — satisfied, possibly with degraded signals. */
  readonly readiness: ReadinessVerdict;
  /** Whether {@link readiness} was re-evaluated now or supplied from the install. */
  readonly readinessSource: CaptureReadinessSourceKind;
  /** The `agent.config` hooks the instrumentation layer sent. */
  readonly agentHooks: AgentHookConfig;
  /** The `server-agent.config` signals the instrumentation layer sent, or would have. */
  readonly serverSignals: ServerAgentSignals;
  /** How the preload configuration fared: delivered, unreachable (the capture degrades) or not needed. */
  readonly serverAgent: ServerAgentDelivery;
  /**
   * AAP §0.5.5's "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled
   * list›." for every degraded signal of the verdict, built by the
   * instrumentation layer's `buildDegradationNotice`. The install already
   * emitted these as progress rows; a caller holding a re-evaluated verdict may
   * surface them again.
   */
  readonly degradations: readonly string[];
}

/** What {@link CaptureStage.complete} is told beyond the stage context. Every member is optional. */
export interface CaptureCompleteInput {
  /**
   * The capture to complete. Defaults to the context's capture, then to the
   * session's open capture window.
   */
  readonly captureId?: string | undefined;
  /**
   * The validated understanding the emptiness rule reads. Defaults to the one
   * recorded on the session.
   */
  readonly understanding?: ProblemUnderstanding | undefined;
}

/** Where the arming facts of a completed capture came from. */
export type ArmedConfigurationSource = 'service' | 'derived' | 'none';

/**
 * Which producers a capture was armed with, as far as this stage can tell:
 * the instrumentation service's own state for the capture's plan version, or —
 * after a restart dropped that state — the upstream derivations over the stored
 * plan's actions whose adapters are still registered, or the dormant and
 * disabled configurations when no plan is known.
 */
export interface ArmedConfiguration {
  /** The page-agent hooks. */
  readonly agentHooks: AgentHookConfig;
  /** The dev-server preload signals. */
  readonly serverSignals: ServerAgentSignals;
  /** Which of the three routes produced them. */
  readonly source: ArmedConfigurationSource;
}

/** Where a completed capture's summary came from. */
export type CaptureSummarySource = 'stored' | 'computed';

/**
 * The outcome of a completed capture: the summary, whether it holds evidence,
 * and where the session was sent. Every field is safe to log except `summary`,
 * whose top-N sections carry capture data for in-process use — log its counts.
 */
export interface CaptureCompleteResult {
  /** The completed capture. */
  readonly captureId: string;
  /** The plan version installed while it ran. */
  readonly planVersion: number;
  /** The capture's summary — the payload of `capture.stopped`. */
  readonly summary: CaptureSummary;
  /** Whether it was read back from the capture row or computed from the stored events now. */
  readonly summarySource: CaptureSummarySource;
  /** Whether the capture holds evidence; see {@link classifyCaptureEmptiness}. */
  readonly emptiness: CaptureEmptiness;
  /** The status the session was sent to: `analyzing` with evidence, `ready` when empty. */
  readonly next: CaptureStopNext;
  /** The capture row as stopped. */
  readonly capture: CaptureRecord;
  /** Whether this call closed the window; `false` when an earlier call already had. */
  readonly stoppedNow: boolean;
  /** What the capture was armed with. */
  readonly armed: ArmedConfiguration;
  /** How the disarm fared, or `undefined` when it was not attempted or could not be sent. */
  readonly disarm?: DisarmCaptureOutcome | undefined;
}

/**
 * Stage 4 of the pipeline: the factory-plus-methods shape the orchestrator's
 * `StageOverrides` port substitutes in tests. Its two methods are the two
 * halves of the capture window, called in order.
 */
export interface CaptureStage {
  /**
   * Gates on readiness, opens the capture window and arms both producers.
   *
   * @param context The stage context of the session about to capture.
   * @param input The install's verdict and the re-evaluation options.
   * @returns `Ok` with the armed configuration, or `Err`: the state machine's
   * refusal, a blocked readiness gate (`TAB_NOT_BOUND`, `AGENT_NOT_READY`,
   * `SERVER_AGENT_NOT_READY` or `INSTRUMENTATION_UNAVAILABLE`, with
   * `details.blocking` and `details.remediations`), the session manager's
   * capture conflict unchanged, or the instrumentation layer's arm failure
   * (after the opened window was closed again). Never rejects.
   */
  arm(
    context: CaptureStageContext,
    input?: CaptureArmInput,
  ): Promise<Result<CaptureArmResult, DebuggenError>>;

  /**
   * Disarms both producers, summarises the capture, classifies it and closes
   * the window — to `analyzing` with evidence, to `ready` when empty.
   *
   * @param context The stage context of the capturing session.
   * @param input The capture to complete and the understanding to judge it by.
   * @returns `Ok` with the summary and its classification — an empty capture is
   * an `Ok` — or `Err` with the failing subsystem's typed error. Never rejects.
   */
  complete(
    context: CaptureStageContext,
    input?: CaptureCompleteInput,
  ): Promise<Result<CaptureCompleteResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Failures this stage raises itself
 *
 * Every other failure is the owning subsystem's error, passed through unchanged. These carry
 * codes, product-minted ids, counts, signal names and enumerated reasons only (AAP §0.5.2).
 * ---------------------------------------------------------------------------------------------- */

/** The call was abandoned through the context's signal. */
function cancelledError(sessionId: string, captureId: string | undefined): DebuggenError {
  return new DebuggenError('INTERNAL', 'The capture stage was cancelled before it finished.', {
    hint: 'Start or stop the capture again when you are ready.',
    details: {
      stage: CAPTURE_STAGE,
      reason: 'aborted',
      sessionId,
      ...(captureId !== undefined ? { captureId } : {}),
    },
  });
}

/** The session manager holds no session under the context's id. */
function sessionNotFoundError(sessionId: string): DebuggenError {
  return new DebuggenError('SESSION_NOT_FOUND', 'This debugging session no longer exists.', {
    hint: 'Start a new session from the Debug Generator view in VS Code.',
    details: { stage: CAPTURE_STAGE, reason: 'session-not-found', sessionId },
  });
}

/** The session has no installed plan to capture under. */
function noPlanError(sessionId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'This session has no instrumentation plan to capture under.',
    {
      hint: 'Let planning and instrumentation finish, then start the capture.',
      details: { stage: CAPTURE_STAGE, reason: 'no-plan', sessionId },
    },
  );
}

/**
 * The instrumentation service holds the arming state of a different plan
 * version than the session's latest: a follow-up plan was recorded but its
 * delta has not been installed, so arming now would capture under instrumentation
 * the capture row would misreport.
 */
function planVersionMismatchError(
  sessionId: string,
  planVersion: number,
  activePlanVersion: number,
): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The installed instrumentation does not match the session’s latest plan version.',
    {
      hint: 'Let the instrumentation for the latest plan finish installing, then start the capture.',
      details: {
        stage: CAPTURE_STAGE,
        reason: 'plan-version-mismatch',
        sessionId,
        planVersion,
        activePlanVersion,
      },
    },
  );
}

/** Neither a re-evaluation nor the install's verdict is available to gate on. */
function noVerdictError(sessionId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'No readiness verdict is available for this session, so the capture cannot be gated.',
    {
      hint: 'Install the session’s instrumentation plan again so readiness is evaluated, then start the capture.',
      details: { stage: CAPTURE_STAGE, reason: 'readiness-unknown', sessionId },
    },
  );
}

/** No capture id was named and the session has no open capture window. */
function noOpenCaptureError(sessionId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'This session has no open capture window to stop.',
    {
      hint: 'Start a capture, reproduce the issue in the page, then stop the capture.',
      details: { stage: CAPTURE_STAGE, reason: 'no-active-capture', sessionId },
    },
  );
}

/** The named capture does not exist in the store. */
function captureNotFoundError(sessionId: string, captureId: string): DebuggenError {
  return new DebuggenError('SESSION_INVALID_STATE', 'The capture to stop does not exist.', {
    hint: 'Stop the capture this session started.',
    details: { stage: CAPTURE_STAGE, reason: 'capture-not-found', sessionId, captureId },
  });
}

/** The named capture belongs to another session. */
function captureOwnershipError(sessionId: string, captureId: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'The capture to stop belongs to a different session.',
    {
      hint: 'Stop each capture from the session that started it.',
      details: { stage: CAPTURE_STAGE, reason: 'capture-session-mismatch', sessionId, captureId },
    },
  );
}

/** The session is not capturing and the named capture was never closed. */
function notCapturingError(sessionId: string, captureId: string, status: string): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    'This session is not capturing, and the capture was never stopped.',
    {
      hint: 'Start a new capture once the session is ready again.',
      details: { stage: CAPTURE_STAGE, reason: 'not-capturing', sessionId, captureId, status },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Rewrites any text as one line of display text: control characters become
 * spaces, whitespace runs collapse to one space, and the ends are trimmed.
 */
function toDisplayLine(text: string): string {
  let spaced = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spaced += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return spaced.replace(WHITESPACE_RUN_PATTERN, ' ').trim();
}

/** Clips display text to `maxLength` code units, closing a clipped text with an ellipsis. */
function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** The product label of a reported signal, or the reported name itself for a third-party signal. */
function labelForSignal(signal: string): string {
  return isCaptureSignal(signal) ? CAPTURE_SIGNAL_LABELS[signal] : toDisplayLine(signal);
}

/**
 * The labels of the signals a capture proceeds with, in the progress view's
 * display order — the enabled list of AAP §0.5.5's degradation sentence.
 */
function enabledLabelsFor(signals: readonly CaptureSignal[]): readonly string[] {
  const labels = new Set<string>(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]));
  return INSTRUMENTATION_ROW_ORDER.filter((label) => labels.has(label));
}

/**
 * The first clause of AAP §0.5.5's sentence for each signal the gate withheld —
 * "Could not enable ‹signal›: ‹reason›." — with the readiness module's reason
 * verbatim (its reasons are worded to read after that colon). The "Continuing
 * with" clause is omitted because a blocked gate does not continue. Identical
 * sentences collapse onto the first.
 */
function blockedSentences(entries: readonly UnavailableSignal[]): readonly string[] {
  const sentences: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const label = labelForSignal(entry.signal);
    if (label.length === 0) {
      continue;
    }
    const reason = toDisplayLine(entry.reason).replace(TRAILING_PUNCTUATION_PATTERN, '');
    const sentence =
      reason.length === 0 ? `Could not enable ${label}.` : `Could not enable ${label}: ${reason}.`;
    if (!seen.has(sentence)) {
      seen.add(sentence);
      sentences.push(sentence);
    }
  }
  return sentences;
}

/**
 * The typed refusal of an unsatisfied readiness gate: the readiness module's
 * own reasons and hints, the code of the first remedy, and — for the surfaces —
 * the verdict's blocking entries and remediations verbatim.
 */
function blockedGateError(sessionId: string, verdict: ReadinessVerdict): DebuggenError {
  const blocking = listOf(verdict.blocking);
  const remediations = listOf(verdict.remediations);
  const degraded = listOf(verdict.degraded);
  const sentences = blockedSentences(blocking);
  const hints = [
    ...new Set(
      blocking.map((entry) => toDisplayLine(entry.hint)).filter((hint) => hint.length > 0),
    ),
  ];
  const first = remediations[0];
  if (hints.length === 0 && first?.kind === 'relaunch-dev-server') {
    const relaunchHint = toDisplayLine(first.hint);
    if (relaunchHint.length > 0) {
      hints.push(relaunchHint);
    }
  }
  const message =
    sentences.length === 0
      ? NOTHING_DELIVERABLE_MESSAGE
      : clip(sentences.join(' '), MAX_ERROR_MESSAGE_LENGTH);
  const hint =
    hints.length === 0 ? NOTHING_DELIVERABLE_HINT : clip(hints.join(' '), MAX_ERROR_HINT_LENGTH);
  const code = first === undefined ? BLOCKED_GATE_FALLBACK_CODE : BLOCKED_GATE_CODES[first.kind];

  return new DebuggenError(code, message, {
    hint,
    details: {
      stage: CAPTURE_STAGE,
      reason: 'readiness-unsatisfied',
      sessionId,
      blocking: blocking.map((entry) => ({
        signal: entry.signal,
        reason: entry.reason,
        hint: entry.hint,
      })),
      remediations: remediations.map((remediation) => ({ ...remediation })),
      degradedSignals: degraded.map((entry) => entry.signal),
      evaluatedAt: verdict.evaluatedAt,
    },
  });
}

/** The session's active plan: the highest plan version on its record. */
function activePlanOf(session: SessionRecord): InstrumentationPlan | undefined {
  let active: InstrumentationPlan | undefined;
  for (const plan of session.plans) {
    if (active === undefined || plan.planVersion > active.planVersion) {
      active = plan;
    }
  }
  return active;
}

/** The entries of a zero-filled count table that are above zero — vocabulary names and counts only. */
function nonZeroCounts(counts: Readonly<Record<string, number>>): LogFields {
  const fields: LogFields = {};
  for (const [name, count] of Object.entries(counts)) {
    const value = countOf(count);
    if (value > 0) {
      fields[name] = value;
    }
  }
  return fields;
}

/** The enumerated `details.reason` of an error, when it carries one. */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** The names of the hooks a configuration turns on — vocabulary names only. */
function enabledHookNames(hooks: AgentHookConfig): readonly string[] {
  return Object.entries(hooks)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

/** Whether a signal has been aborted; a missing signal never has. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Runs a synchronous collaborator call, turning a throw into a typed `Err`. */
function attempt<T>(
  call: () => Result<T, DebuggenError>,
  code: DebuggenErrorCode,
): Result<T, DebuggenError> {
  try {
    return call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code));
  }
}

/** Runs an asynchronous collaborator call, turning a throw or a rejection into a typed `Err`. */
async function attemptAsync<T>(
  call: () => Promise<Result<T, DebuggenError>>,
  code: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code));
  }
}

/* -------------------------------------------------------------------------------------------------
 * The stage
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the runtime-capture stage (AAP §0.4.2, Runtime-capture row).
 *
 * The stage holds no state between calls: the capture window lives in the
 * session store, the arming state in the instrumentation service, so an `arm`
 * and its `complete` may run on different stage instances — or across a
 * service restart — and still agree.
 *
 * @param deps The instrumentation layer, the capture and telemetry stores, the
 * session manager, the progress emitter, the adapter registry and the optional
 * logger, clock and boundary-row switch; see {@link CaptureStageDeps}.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const capture = createCaptureStage({
 *   instrumentation, sessions, telemetry, sessionManager, progress, registry, logger,
 * });
 * const armed = await capture.arm(context, { readiness: installed.readiness });
 * // ...the developer reproduces the issue...
 * const completed = await capture.complete(context, { captureId: armed.value.captureId });
 * if (completed.ok && completed.value.emptiness.empty) {
 *   // The session is back in `ready`; analysis is skipped.
 * }
 * ```
 */
export function createCaptureStage(deps: CaptureStageDeps): CaptureStage {
  const reportBoundaries = deps.reportStageBoundaries ?? true;

  /** The call's logger: bound to the pipeline subsystem, this stage, the session and the capture. */
  const loggerFor = (context: CaptureStageContext, captureId: string | undefined): Logger => {
    const parent =
      deps.logger === undefined ? context.logger : sessionLogger(deps.logger, context.sessionId);
    const bound = subsystemLogger(parent, PIPELINE_SUBSYSTEM).child({ stage: CAPTURE_STAGE });
    return captureId === undefined
      ? bound
      : bound.child({ [LOG_BINDING_KEYS.captureId]: captureId });
  };

  /** One clock reading; a clock that throws or answers a non-finite value yields `undefined`. */
  const readClock = (context: CaptureStageContext): number | undefined => {
    try {
      const value = (deps.now ?? context.now)();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  /** The elapsed-time field of a log record, when both readings exist. */
  const durationFields = (
    context: CaptureStageContext,
    startedAt: number | undefined,
  ): LogFields => {
    const endedAt = readClock(context);
    return startedAt === undefined || endedAt === undefined
      ? {}
      : { durationMs: Math.max(0, endedAt - startedAt) };
  };

  /**
   * Sends one progress row. Progress is advisory: a rejected or throwing
   * emission is logged with its code and the row kind, never its text, and the
   * stage carries on.
   */
  const sendRow = (
    log: Logger,
    row: 'started' | 'completed' | 'failed',
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    const sent = attempt(send, 'INTERNAL');
    if (!sent.ok) {
      log.warn('A progress row of the capture stage could not be sent; the stage continues.', {
        row,
        code: sent.error.code,
      });
    }
  };

  /** The session record as the manager holds it now — never the possibly stale context copy. */
  const loadSession = (sessionId: string): Result<SessionRecord, DebuggenError> => {
    const loaded = attempt(() => deps.sessionManager.get(sessionId), 'STORE_ERROR');
    if (!loaded.ok) {
      return loaded;
    }
    return loaded.value === undefined ? err(sessionNotFoundError(sessionId)) : ok(loaded.value);
  };

  /** The instrumentation service's arming state for a session, if it holds any. */
  const armingSnapshot = (
    log: Logger,
    sessionId: string,
  ): ReturnType<InstrumentationService['arming']> => {
    try {
      return deps.instrumentation.arming(sessionId);
    } catch (thrown) {
      log.warn('The arming state could not be read; it is treated as unknown.', {
        code: DebuggenError.from(thrown, 'INTERNAL').code,
      });
      return undefined;
    }
  };

  /**
   * What a capture of `planVersion` was armed with: the service's own state for
   * that version, else the upstream derivations over the stored plan's actions
   * whose adapter is still registered, else nothing.
   */
  const resolveArmedConfiguration = (
    log: Logger,
    session: SessionRecord,
    planVersion: number,
  ): ArmedConfiguration => {
    const snapshot = armingSnapshot(log, session.id);
    if (snapshot?.activePlanVersion === planVersion) {
      return {
        agentHooks: snapshot.agentHooks,
        serverSignals: snapshot.serverSignals,
        source: 'service',
      };
    }
    const plan = session.plans.find((candidate) => candidate.planVersion === planVersion);
    if (plan === undefined) {
      return {
        agentHooks: DORMANT_AGENT_HOOK_CONFIG,
        serverSignals: { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] },
        source: 'none',
      };
    }
    const installable = plan.instrumentationTargets.filter(
      (action) => deps.registry.get(action.adapter) !== undefined,
    );
    return {
      agentHooks: deriveAgentHookConfig(installable),
      serverSignals: deriveServerAgentSignals(installable),
      source: 'derived',
    };
  };

  /**
   * The verdict to gate on: a re-evaluation when the instrumentation layer
   * offers one (the page may have changed since the install), else the
   * install's verdict the caller supplied.
   */
  const resolveVerdict = async (
    context: CaptureStageContext,
    session: SessionRecord,
    plan: InstrumentationPlan,
    input: CaptureArmInput,
  ): Promise<
    Result<
      { readonly verdict: ReadinessVerdict; readonly source: CaptureReadinessSourceKind },
      DebuggenError
    >
  > => {
    const instrumentation = deps.instrumentation;
    if (instrumentation.evaluateReadiness !== undefined) {
      const request: CaptureReadinessRequest = {
        sessionId: session.id,
        projectRoot: context.projectRoot,
        plan,
        ...(session.boundTab !== undefined ? { boundTab: session.boundTab } : {}),
        ...(input.allowReloadPrompt !== undefined
          ? { allowReloadPrompt: input.allowReloadPrompt }
          : {}),
        ...(input.requireServerAgent !== undefined
          ? { requireServerAgent: input.requireServerAgent }
          : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      };
      let evaluated: Result<ReadinessVerdict, DebuggenError>;
      try {
        evaluated = await instrumentation.evaluateReadiness(request);
      } catch (thrown) {
        evaluated = err(DebuggenError.from(thrown, 'INTERNAL'));
      }
      return evaluated.ok ? ok({ verdict: evaluated.value, source: 'reevaluated' }) : evaluated;
    }
    if (input.readiness !== undefined) {
      return ok({ verdict: input.readiness, source: 'supplied' });
    }
    return err(noVerdictError(session.id));
  };

  /**
   * Reads every persisted event of one capture, page by page, and summarises
   * them with the upstream `computeCaptureSummary`. The events are the
   * already-redacted rows ingest stored; nothing is re-redacted, correlated or
   * aggregated here.
   */
  const summarizeFromStore = (
    log: Logger,
    sessionId: string,
    captureId: string,
    signal: AbortSignal | undefined,
  ): Result<CaptureSummary, DebuggenError> => {
    const events: TelemetryEvent[] = [];
    let offset = 0;
    let skipped = 0;
    let more = true;
    while (more) {
      if (isAborted(signal)) {
        return err(cancelledError(sessionId, captureId));
      }
      const page = attempt(
        () =>
          deps.telemetry.listByCapture(sessionId, captureId, {
            limit: TELEMETRY_QUERY_MAX_LIMIT,
            offset,
          }),
        'STORE_ERROR',
      );
      if (!page.ok) {
        return page;
      }
      for (const row of page.value.rows) {
        events.push(row);
      }
      const pageSkipped = countOf(page.value.skipped);
      skipped += pageSkipped;
      const read = page.value.rows.length + pageSkipped;
      const next = page.value.nextOffset;
      more = next !== undefined && read > 0 && next > offset;
      if (next !== undefined && more) {
        offset = next;
      }
    }
    if (skipped > 0) {
      log.warn('Stored events that no longer validate were left out of the capture summary.', {
        skipped,
      });
    }
    return ok(computeCaptureSummary(events, { captureId, sessionId }));
  };

  /**
   * Sends the dormant page configuration and the capture-less preload
   * configuration through the instrumentation layer. A disarm that cannot be
   * sent is logged and does not stop the capture from closing: once the window
   * is closed, ingest attributes nothing further to it.
   */
  const disarm = (
    log: Logger,
    sessionId: string,
    captureId: string,
    projectRoot: string,
  ): DisarmCaptureOutcome | undefined => {
    const disarmed = attempt(
      () => deps.instrumentation.disarmCapture({ sessionId, captureId, projectRoot }),
      'INTERNAL',
    );
    if (!disarmed.ok) {
      log.warn('The producers could not be disarmed; the capture closes regardless.', {
        code: disarmed.error.code,
      });
      return undefined;
    }
    return disarmed.value;
  };

  /**
   * Closes a capture window this stage opened but could not arm, so the session
   * returns to `ready` instead of sitting in `capturing` with nothing
   * collecting. The window is closed through the session manager with the
   * summary of whatever it holds, exactly as a completed capture is.
   *
   * @returns Whether the window was closed.
   */
  const rollbackOpenedCapture = async (
    log: Logger,
    session: SessionRecord,
    captureId: string,
    projectRoot: string,
  ): Promise<boolean> => {
    disarm(log, session.id, captureId, projectRoot);
    const summary = summarizeFromStore(log, session.id, captureId, undefined);
    if (!summary.ok) {
      log.error('The capture window of a failed arm could not be summarised; it stays open.', {
        code: summary.error.code,
      });
      return false;
    }
    const stopped = await attemptAsync(
      () =>
        deps.sessionManager.stopCapture(session.id, {
          summary: summary.value,
          next: NEXT_WHEN_EMPTY,
        }),
      'INTERNAL',
    );
    if (!stopped.ok) {
      log.error('The capture window of a failed arm could not be closed; it stays open.', {
        code: stopped.error.code,
      });
      return false;
    }
    return true;
  };

  /**
   * Which capture a completion is about: the one the caller named, the
   * context's, or the session's open window.
   */
  const resolveCaptureId = (
    context: CaptureStageContext,
    input: CaptureCompleteInput,
  ): Result<string, DebuggenError> => {
    const named = input.captureId ?? context.captureId;
    if (named !== undefined) {
      return ok(named);
    }
    const active = attempt(() => deps.sessions.getActiveCapture(context.sessionId), 'STORE_ERROR');
    if (!active.ok) {
      return active;
    }
    return active.value === undefined
      ? err(noOpenCaptureError(context.sessionId))
      : ok(active.value.capture.id);
  };

  async function arm(
    context: CaptureStageContext,
    input: CaptureArmInput = {},
  ): Promise<Result<CaptureArmResult, DebuggenError>> {
    const { sessionId } = context;
    const startedAt = readClock(context);
    let log = loggerFor(context, undefined);

    /** Every refusal before a window is opened: logged by code and reason, returned unchanged. */
    const refuse = (error: DebuggenError): Result<never, DebuggenError> => {
      const reason = reasonOf(error);
      log.info('The capture was not started.', {
        code: error.code,
        ...(reason !== undefined ? { reason } : {}),
        ...durationFields(context, startedAt),
      });
      return err(error);
    };

    if (isAborted(context.signal)) {
      return refuse(cancelledError(sessionId, undefined));
    }

    // 1. The session as the manager holds it now, and whether it may capture at all.
    const loaded = loadSession(sessionId);
    if (!loaded.ok) {
      return refuse(loaded.error);
    }
    const session = loaded.value;
    const admissible = transition(session.status, CAPTURING_STATUS);
    if (!admissible.ok) {
      return refuse(admissible.error);
    }
    const plan = activePlanOf(session);
    if (plan === undefined) {
      return refuse(noPlanError(sessionId));
    }
    const snapshot = armingSnapshot(log, sessionId);
    if (snapshot !== undefined && snapshot.activePlanVersion !== plan.planVersion) {
      return refuse(
        planVersionMismatchError(sessionId, plan.planVersion, snapshot.activePlanVersion),
      );
    }

    // 2. The readiness gate: blocking entries stop the capture, degraded ones never do.
    const resolved = await resolveVerdict(context, session, plan, input);
    if (!resolved.ok) {
      return refuse(resolved.error);
    }
    const { verdict, source } = resolved.value;
    if (verdict.satisfied !== true) {
      const blocked = blockedGateError(sessionId, verdict);
      log.info('The readiness gate is not satisfied.', {
        readinessSource: source,
        blockingSignals: listOf(verdict.blocking).length,
        remediations: listOf(verdict.remediations).map((remediation) => remediation.kind),
      });
      return refuse(blocked);
    }
    if (isAborted(context.signal)) {
      return refuse(cancelledError(sessionId, undefined));
    }

    // 3. The capture window, opened by the only writer of session status. Its
    //    one-capture-per-project conflict is returned unchanged for the 409.
    const opened = await attemptAsync(
      () => deps.sessionManager.startCapture(sessionId),
      'INTERNAL',
    );
    if (!opened.ok) {
      return refuse(opened.error);
    }
    const { captureId } = opened.value;
    log = loggerFor(context, captureId);

    // 4. Both producers, armed by the instrumentation layer with the
    //    configuration its installer derived; nothing is reshaped here.
    const armed = attempt(
      () =>
        deps.instrumentation.armCapture({
          sessionId,
          captureId,
          projectRoot: context.projectRoot,
          plan,
        }),
      'INTERNAL',
    );
    if (!armed.ok) {
      const rolledBack = await rollbackOpenedCapture(log, session, captureId, context.projectRoot);
      const reason = reasonOf(armed.error);
      log.warn('The producers could not be armed; the capture window was closed again.', {
        code: armed.error.code,
        ...(reason !== undefined ? { reason } : {}),
        rolledBack,
        ...durationFields(context, startedAt),
      });
      return err(
        new DebuggenError(armed.error.code, armed.error.message, {
          ...(armed.error.hint !== undefined ? { hint: armed.error.hint } : {}),
          details: { ...(armed.error.details ?? {}), stage: CAPTURE_STAGE, captureId, rolledBack },
          cause: armed.error,
        }),
      );
    }
    const outcome: ArmCaptureOutcome = armed.value;

    // 5. The capture group's header, and what the capture proceeds without.
    if (reportBoundaries) {
      sendRow(log, 'started', () => deps.progress.stageStarted(sessionId, CAPTURE_STAGE));
    }
    const degraded = listOf(verdict.degraded);
    const deliverable = listOf(verdict.deliverableSignals);
    const degradations = buildDegradationNotice(degraded, enabledLabelsFor(deliverable));

    log.info('Capture armed.', {
      planVersion: outcome.planVersion,
      readinessSource: source,
      degradedSignals: degraded.length,
      serverAgent: outcome.serverAgent,
      hooks: enabledHookNames(outcome.agentHooks),
      ...durationFields(context, startedAt),
    });

    return ok(
      Object.freeze({
        captureId,
        planVersion: outcome.planVersion,
        readiness: verdict,
        readinessSource: source,
        agentHooks: outcome.agentHooks,
        serverSignals: outcome.serverSignals,
        serverAgent: outcome.serverAgent,
        degradations,
      }),
    );
  }

  async function complete(
    context: CaptureStageContext,
    input: CaptureCompleteInput = {},
  ): Promise<Result<CaptureCompleteResult, DebuggenError>> {
    const { sessionId } = context;
    const startedAt = readClock(context);
    let log = loggerFor(context, input.captureId ?? context.captureId);
    let windowOpen = false;

    /**
     * The single failure path: log the code and enumerated reason, report the
     * capture group's `failed` row when this stage owns its boundary rows and a
     * live window is being completed, and return the error unchanged. A
     * cancellation is not a failure of the capture and adds no row.
     */
    const fail = (error: DebuggenError): Result<never, DebuggenError> => {
      const reason = reasonOf(error);
      log.warn('The capture could not be completed.', {
        code: error.code,
        ...(reason !== undefined ? { reason } : {}),
        ...durationFields(context, startedAt),
      });
      if (reportBoundaries && windowOpen && reason !== 'aborted') {
        const failure: SessionFailure = {
          stage: CAPTURE_STAGE,
          code: error.code,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
        };
        sendRow(log, 'failed', () => deps.progress.stageFailed(sessionId, failure));
      }
      return err(error);
    };

    if (isAborted(context.signal)) {
      return fail(cancelledError(sessionId, input.captureId ?? context.captureId));
    }

    // 1. The session and the capture window being completed.
    const loaded = loadSession(sessionId);
    if (!loaded.ok) {
      return fail(loaded.error);
    }
    const session = loaded.value;
    const resolvedId = resolveCaptureId(context, input);
    if (!resolvedId.ok) {
      return fail(resolvedId.error);
    }
    const captureId = resolvedId.value;
    log = loggerFor(context, captureId);
    const stored = attempt(() => deps.sessions.getCapture(captureId), 'STORE_ERROR');
    if (!stored.ok) {
      return fail(stored.error);
    }
    if (stored.value === undefined) {
      return fail(captureNotFoundError(sessionId, captureId));
    }
    if (stored.value.sessionId !== sessionId) {
      return fail(captureOwnershipError(sessionId, captureId));
    }
    const record = stored.value.capture;
    const capturing = session.status === CAPTURING_STATUS;
    if (!capturing && record.stoppedAt === undefined) {
      return fail(notCapturingError(sessionId, captureId, session.status));
    }
    windowOpen = capturing;

    // 2. Both producers back to dormant while the window is still live.
    const disarmed = capturing ? disarm(log, sessionId, captureId, context.projectRoot) : undefined;

    // 3. The summary: the stored one when the row already holds it, otherwise
    //    the upstream aggregate over the capture's persisted events.
    let summary: CaptureSummary;
    let summarySource: CaptureSummarySource;
    if (record.summary !== undefined && record.summary.captureId === captureId) {
      summary = record.summary;
      summarySource = 'stored';
    } else {
      const computed = summarizeFromStore(log, sessionId, captureId, context.signal);
      if (!computed.ok) {
        return fail(computed.error);
      }
      summary = computed.value;
      summarySource = 'computed';
    }

    // 4. The empty-capture rule of AAP §0.5.5, judged against what was armed.
    const armedWith = resolveArmedConfiguration(log, session, record.planVersion);
    const emptiness = classifyCaptureEmptiness(
      summary,
      input.understanding ?? session.understanding,
      {
        agentHooks: armedWith.agentHooks,
      },
    );
    const next = emptiness.empty ? NEXT_WHEN_EMPTY : NEXT_WITH_EVIDENCE;

    // 5. The window, closed by the only writer of session status, which persists
    //    the summary and broadcasts `capture.stopped`.
    let capture: CaptureRecord = record;
    let stoppedNow = false;
    if (capturing) {
      if (isAborted(context.signal)) {
        return fail(cancelledError(sessionId, captureId));
      }
      const stopped = await attemptAsync(
        () => deps.sessionManager.stopCapture(sessionId, { summary, next }),
        'INTERNAL',
      );
      if (!stopped.ok) {
        return fail(stopped.error);
      }
      capture = stopped.value;
      stoppedNow = true;
    }

    // 6. The capture group's closing row: the stage title, or the empty-capture sentence.
    if (stoppedNow && reportBoundaries) {
      sendRow(log, 'completed', () =>
        deps.progress.stageCompleted(
          sessionId,
          CAPTURE_STAGE,
          emptiness.empty ? emptiness.message : undefined,
        ),
      );
    }

    log.info(
      emptiness.empty ? 'Capture completed with nothing to analyse.' : 'Capture completed.',
      {
        planVersion: record.planVersion,
        eventCount: emptiness.eventCount,
        interactionCount: emptiness.interactionCount,
        traceCount: countOf(summary.traceCount),
        empty: emptiness.empty,
        ...(emptiness.empty ? { reason: emptiness.reason } : {}),
        next,
        summarySource,
        stoppedNow,
        armedSource: armedWith.source,
        kinds: nonZeroCounts(summary.kindCounts),
        tiers: nonZeroCounts(summary.tierCounts),
        ...durationFields(context, startedAt),
      },
    );

    return ok(
      Object.freeze({
        captureId,
        planVersion: record.planVersion,
        summary,
        summarySource,
        emptiness,
        next,
        capture,
        stoppedNow,
        armed: armedWith,
        ...(disarmed !== undefined ? { disarm: disarmed } : {}),
      }),
    );
  }

  return Object.freeze({ arm, complete });
}
