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
 *    answer `409 { owningSessionId }`, and begins the telemetry store's
 *    producer-loss accounting for it — only a window this process began
 *    accounting for can later report its loss total as the whole loss.
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
 * 2. **The stop barrier.** The window stays open — ingest keeps attributing to
 *    it — while the capture's ingest watermark is polled until it stands still
 *    for a quiet period, bounded by {@link CAPTURE_DRAIN_DEFAULTS}: the batches
 *    the producers flush on disarm, and any already in flight, then belong to
 *    the capture that recorded them rather than arriving after it closed.
 * 3. Produces the {@link CaptureSummary}: the stored one when the capture row
 *    already holds it, otherwise `computeCaptureSummary` from
 *    `@debuggen/telemetry` over the capture's persisted, already-redacted
 *    events — read page by page, yielding between pages, and bounded by
 *    {@link MAX_SUMMARY_EVENTS} and {@link MAX_SUMMARY_BYTES}, whichever comes
 *    first, so the one synchronous aggregate over them stays short and the
 *    events it holds stay small. No metric, aggregate, correlation or redaction
 *    is computed here. A computed summary carries its `coverage`: stored versus
 *    summarised events, the events the producers reported discarding, and how
 *    the barrier ended — `'unverified'` rather than `'quiescent'` when a
 *    producer that sent the capture events could not be confirmed disarmed, so
 *    its final flush may still be missing.
 * 4. **The empty-capture rule of AAP §0.5.5**, as the pure
 *    {@link classifyCaptureEmptiness}: zero events, or zero browser interactions
 *    for a question whose validated, classified understanding needs
 *    interactions — whether or not the interaction hook was armed. A capped summary is judged by the
 *    store's exact per-kind counts. An empty capture is a legitimate outcome,
 *    not a crash.
 * 5. Closes the window through `SessionManager.stopCapture` with
 *    `next: "ready"` for an empty capture and `next: "analyzing"` otherwise —
 *    the decision the manager's contract assigns to this stage. The manager
 *    persists the summary, broadcasts `capture.stopped` and applies the
 *    transition; this stage writes no status of its own and never runs,
 *    skips or fabricates an analysis. Once the window is closed, the loss
 *    ledger's entry for it is released.
 * 6. Tells both user interfaces, as `finding` rows of counts only, when the
 *    evidence is incomplete and when an interaction question's capture is
 *    empty because its interaction hook was off.
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
 *   sent is logged and never fails the stage. The sentences this module
 *   defines are AAP §0.5.5's empty-capture sentence ({@link CAPTURE_EMPTY_MESSAGE}),
 *   the hook-off explanation ({@link INTERACTION_HOOK_OFF_MESSAGE}) and the
 *   incomplete-evidence row, which states counts only.
 * - Every expected failure is a `Result` `Err`; neither method rejects.
 *
 * @module
 */

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

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
import { TELEMETRY_KINDS, allowedTiersFor, computeCaptureSummary } from '@debuggen/telemetry';
import type {
  CaptureCoverage,
  CaptureDrainOutcome,
  CaptureSummary,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
} from '@debuggen/telemetry';

import { buildDegradationNotice } from '../../instrumentation/service.js';
import type {
  ArmCaptureOutcome,
  DisarmCaptureOutcome,
  InstrumentationService,
  ServerAgentDelivery,
} from '../../instrumentation/service.js';
import type {
  ReadinessRemediation,
  ReadinessRemediationKind,
  ReadinessVerdict,
} from '../../instrumentation/readiness.js';
import { LOG_BINDING_KEYS, sessionLogger, subsystemLogger } from '../../logging.js';
import type { CaptureStopNext, SessionManager } from '../../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  FAILURE_COPY_BY_CODE,
  INSTRUMENTATION_ROW_ORDER,
  authorProductText,
  isProductAuthoredText,
} from '../../sessions/progress.js';
import type { PublicFailureCopy, SessionProgress } from '../../sessions/progress.js';
import { STAGE_STATUS, transition } from '../../sessions/state-machine.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import type { SessionsRepo } from '../../store/sessions-repo.js';
import type { CaptureIngestWatermark, TelemetryRepo } from '../../store/telemetry-repo.js';
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
 * The `session.progress` finding row that precedes {@link CAPTURE_EMPTY_MESSAGE}
 * when an interaction question's capture is empty because the page agent's
 * interaction hook was off (AAP §0.5.5): the developer learns why no
 * interaction could be recorded instead of only being asked to interact again.
 * No name, route or question text — the hook and the signal are product
 * vocabulary.
 */
export const INTERACTION_HOOK_OFF_MESSAGE =
  'The browser interaction hook was off for this capture, so the interaction this question needs could not be recorded.';

/**
 * Why a capture counts as empty — the two conditions AAP §0.5.5 names, as a
 * closed vocabulary:
 *
 * - `'no-events'` — the capture window recorded no event at all, on any tier.
 * - `'no-interaction'` — events arrived, but the validated understanding
 *   classifies the problem and needs the interaction signal
 *   ({@link understandingNeedsInteraction}), and the capture recorded no user
 *   interaction.
 *   Without an interaction there is no trace root to hang the browser and
 *   server evidence off, so an analysis would answer a question nobody
 *   reproduced. This holds whether or not the page's interaction hook was
 *   armed: with the hook off, unrelated server or performance events are still
 *   no reproduction of the interaction the question is about.
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

/**
 * The category an understanding answers with when it could not classify the
 * problem: the most general member of the closed category vocabulary
 * (`PROBLEM_CATEGORIES`), typed against it so a rename upstream is a compile
 * error.
 */
const UNCLASSIFIED_CATEGORY = 'other' as const satisfies ProblemUnderstanding['category'];

/** The session status the capture stage runs under, from the state machine's own table. */
const CAPTURING_STATUS = STAGE_STATUS[CAPTURE_STAGE];

/** Where a capture that holds evidence sends its session: the status the analysis stage runs under. */
const NEXT_WITH_EVIDENCE: CaptureStopNext = STAGE_STATUS.analyze;

/** Where an empty capture sends its session: back to `ready`, so "Capture again" re-arms the same plan. */
const NEXT_WHEN_EMPTY: CaptureStopNext = 'ready';

/**
 * The most stored events one capture summary is computed from: **10 000**
 * (AAP §0.5.5).
 *
 * `computeCaptureSummary` needs every event it summarises in memory at once
 * and runs synchronously over all of them, so a noisy capture read in full
 * could exhaust the service's heap and hold the one event loop — ingest, both
 * user interfaces' requests — for as long as the aggregate took. The stage
 * therefore reads the capture page by page in canonical order, yields to the
 * event loop between pages, and stops at whichever ceiling comes first, this
 * one or {@link MAX_SUMMARY_BYTES}: the summary then covers the capture's
 * earliest events, the emptiness rule reads the store's exact per-kind counts
 * instead of the summary's, and the summary's coverage reports how many stored
 * events it left out — `summary.truncated` keeps its own meaning, the top-N
 * clipping of its sections.
 *
 * The value is measured, not chosen: `computeCaptureSummary` costs about
 * 12 ms per 1 000 events on the development host (Node 24.21.0), almost
 * independently of attribute size. Over events of a realistic cross-tier mix
 * (about 520 stored characters each) 10 000 events took 116–136 ms, where the
 * previous ceiling of 50 000 took 570–640 ms — more than half a second of a
 * frozen service at every stop of a noisy capture.
 */
export const MAX_SUMMARY_EVENTS = 10_000;

/**
 * The most stored event data one capture summary is computed from: **16 MiB**
 * of stored JSON, counted in characters of the events' stored documents
 * (AAP §0.5.5).
 *
 * The event ceiling alone does not bound memory: attributes are open JSON and
 * one dev-server ingest request may carry 32 MiB, so 10 000 rich events could
 * still hold hundreds of megabytes. The events a summary holds occupy about
 * their stored size in heap (measured at 1.05×), so this ceiling is what bounds
 * the read's memory. Measured on the development host:
 *
 * | Events offered | Stored each | Summarised | Held heap | Heap after the aggregate | `computeCaptureSummary` |
 * | --- | --- | --- | --- | --- | --- |
 * | 12 000, realistic mix | ~0.5 KB | 10 000 (event ceiling) | ~7 MiB | ~35 MiB | 116–172 ms |
 * | 50 000, 2 KB attributes | ~2.6 KB | 6 750 (this ceiling) | 18 MiB | ~80 MiB | 81–97 ms |
 * | 12 000, 10 KB attributes | ~10.8 KB | 1 750 (this ceiling) | 19 MiB | ~37 MiB | 23–48 ms |
 *
 * Under the previous, count-only ceiling the second row held 132 MiB and took
 * 552–628 ms, and the third held 126 MiB.
 */
export const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;

/**
 * How many rows one page of the summary walk reads: **250**.
 *
 * Both ceilings are checked between pages, so a walk overshoots the one that
 * stops it by at most one page. At 250 rows that is 2.5 % of
 * {@link MAX_SUMMARY_EVENTS}, and about 2.6 MiB — 16 % of
 * {@link MAX_SUMMARY_BYTES} — for events with 10 KB of attributes; the one row
 * a page cannot bound is a single stored event larger than that, which only
 * the ingest request ceiling limits. A page is also one synchronous slice of
 * the store read and the event validation between two yields: measured at
 * 1.4–9 ms for 250 rows on the development host, against 19–52 ms for a
 * page at the store's 5 000-row ceiling.
 */
export const SUMMARY_PAGE_SIZE = 250;

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
 * module's own proven reasons, and by fixed code copy where an entry's reason
 * is not product-authored (see `blockedGateError`).
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
   * the understanding needs the interaction signal. Independent of what was
   * armed (AAP §0.5.5).
   */
  readonly interactionRequired: boolean;
  /**
   * Whether the page agent's interaction hook was armed for the capture —
   * present only when the arming is known. A diagnostic that never changes the
   * classification: it lets a caller explain an interaction question's empty
   * capture by saying the hook was off, rather than only asking the developer
   * to interact again.
   */
  readonly interactionHookArmed?: boolean;
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
   * The page-agent hooks the capture was armed with, when they are known.
   * Supplied, the classification reports whether the `interactions` hook was on
   * ({@link CaptureEvidenceCounts.interactionHookArmed}); absent, that
   * diagnostic is left out.
   *
   * The hooks never exempt a capture from the interaction condition. An
   * interaction question whose capture recorded no interaction is empty
   * whether the hook was off or on — events from other signals are not a
   * reproduction of the interaction — so the session returns to `ready`
   * instead of an analysis answering a question nobody reproduced (AAP §0.5.5).
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
 * from a user interaction: it classifies the problem, and its closed
 * `signalsNeeded` vocabulary names the interaction signal.
 *
 * The decision is read from `signalsNeeded` rather than from the `category`
 * alone because a category does not settle it: a `'rendering'` question about
 * work repeated while the page is idle needs renders and no click, and a
 * `'performance'` question about an interaction needs the click — which Stage 1
 * records as the interaction signal. The question text is never consulted
 * (AAP §0.5.4).
 *
 * An unclassified understanding (`'other'`) never makes an interaction
 * question. Its signals are not the ones a class of problem is settled by; they
 * are what the context's shape makes worth capturing — the rules-based provider
 * adds the interaction signal for any selected element and for any project
 * with event handlers. Demanding an interaction then would call empty every
 * capture of a problem that shows without input, such as a page that
 * re-renders or re-requests while the developer does nothing (AAP §0.5.5 asks
 * for an interaction only for an interaction question).
 *
 * @param understanding The session's validated Stage 1 understanding, when it
 * has one.
 * @returns `true` when the problem is classified and the interaction signal is
 * among the signals needed.
 */
export function understandingNeedsInteraction(
  understanding: ProblemUnderstanding | undefined,
): boolean {
  if (understanding === undefined || understanding.category === UNCLASSIFIED_CATEGORY) {
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
 * The interaction condition depends on the question alone. What was armed is
 * reported (`interactionHookArmed`) but never exempts a capture: an interaction
 * question's capture with no interaction is empty even when the plan left the
 * interaction hook off.
 *
 * This function **reports**; it does not act. The caller decides what an empty
 * capture means for the session — this stage passes `next: "ready"` to the
 * session manager, and the orchestrator skips analysis.
 *
 * @param summary The capture's event count and zero-filled per-kind counts: a
 * `CaptureSummary`, or the store's exact counts when the summary was capped at
 * {@link MAX_SUMMARY_EVENTS} or {@link MAX_SUMMARY_BYTES}.
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
  summary: Pick<CaptureSummary, 'eventCount' | 'kindCounts'>,
  understanding: ProblemUnderstanding | undefined,
  options?: ClassifyCaptureEmptinessOptions,
): CaptureEmptiness {
  const eventCount = countOf(summary.eventCount);
  let interactionCount = 0;
  for (const kind of telemetryKindsForSignal(INTERACTION_SIGNAL)) {
    interactionCount += countOf(summary.kindCounts[kind]);
  }
  const interactionRequired = understandingNeedsInteraction(understanding);
  const hooks = options?.agentHooks;
  const counts: CaptureEvidenceCounts = {
    eventCount,
    interactionCount,
    interactionRequired,
    ...(hooks !== undefined ? { interactionHookArmed: hooks.interactions === true } : {}),
  };

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
 * The stop barrier (AAP §0.5.5) — timing
 * ---------------------------------------------------------------------------------------------- */

/**
 * The stop barrier's default timing, in milliseconds (AAP §0.5.5).
 *
 * When a capture stops, both producers are disarmed and each flushes what it
 * still holds: the page agent's transport drains its queue on the dormant
 * configuration (its own flush timer runs every 250 ms), and the dev-server
 * preload flushes its span processor before tearing its instrumentation down
 * (its exporter sends a partial batch at the latest 1 000 ms after its first
 * span and gives one ingest request 5 000 ms). Those batches are still on
 * their way when the stop request arrives, so the stage keeps the capture
 * window open — ingest keeps attributing to it — and polls the window's ingest
 * watermark until it stands still:
 *
 * - `pollIntervalMs` — **100**: how often the watermark is read (an in-memory
 *   lookup of the arrivals ingest committed, never a statement, so a poll costs
 *   the same however much the capture holds).
 * - `quietPeriodMs` — **600**: how long the watermark must stand still when
 *   both producers were told to disarm — more than two page-agent flush
 *   intervals, and the flush-on-disarm batches go out immediately.
 * - `unreachableQuietPeriodMs` — **1 500**: the quiet period when a producer
 *   could not be told to disarm (the preload unreachable, the dormant page
 *   configuration unsent, or the disarm itself failed). Such a producer keeps
 *   flushing on its own timer, so the barrier outlasts one whole preload flush
 *   interval with margin.
 * - `maxDrainMs` — **5 000**: the hard ceiling, the preload's own ingest
 *   request timeout. A watermark still moving then ends the barrier as
 *   `'deadline'`, and the summary's coverage says the window may be missing
 *   its last events.
 */
export const CAPTURE_DRAIN_DEFAULTS = Object.freeze({
  pollIntervalMs: 100,
  quietPeriodMs: 600,
  unreachableQuietPeriodMs: 1_500,
  maxDrainMs: 5_000,
} as const);

/**
 * The stop barrier's sleeper, monotonic clock and durations (AAP §0.5.5). Every
 * member is injectable through {@link CaptureStageDeps.drain} so a suite can
 * drive each barrier outcome without real time passing.
 *
 * The clock is deliberately **not** the stage's `now`: that is the service's
 * wall clock, stamped on records (and an integration harness advances it per
 * read rather than with time), while the barrier measures elapsed real time
 * and needs a source that never jumps.
 */
export interface CaptureDrainTiming {
  /**
   * Resolves after `ms` milliseconds, or as soon as `signal` aborts. A rejection
   * is tolerated and treated as an early wake-up. Defaults to a timer that
   * resolves on abort.
   */
  readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** A monotonic millisecond clock. Defaults to `performance.now()`. */
  readonly monotonicNow: () => number;
  /** How often the watermark is read; see {@link CAPTURE_DRAIN_DEFAULTS}. Positive. */
  readonly pollIntervalMs: number;
  /** How long the watermark must stand still when every producer was told to disarm. */
  readonly quietPeriodMs: number;
  /** How long it must stand still when a producer could not be told. */
  readonly unreachableQuietPeriodMs: number;
  /** The hard ceiling of the whole barrier. */
  readonly maxDrainMs: number;
}

/**
 * Which ceiling ended a summary walk before the capture's end:
 * {@link MAX_SUMMARY_EVENTS} (`'events'`) or {@link MAX_SUMMARY_BYTES}
 * (`'bytes'`).
 */
type SummaryCeiling = 'events' | 'bytes';

/** What a bounded read of one capture's stored events produced: the summary and its counts. */
interface SummarizedCapture {
  /** The upstream summary over the events read. */
  readonly summary: CaptureSummary;
  /**
   * How many stored rows the walk read, readable or not: every row the capture
   * holds when the walk reached its end, a lower bound when a ceiling stopped it.
   */
  readonly rowsRead: number;
  /** How many events the summary was computed from. */
  readonly summarizedEvents: number;
  /** How many rows read no longer validate and were left out. */
  readonly skipped: number;
  /** The stored size of the rows read, in characters of their JSON documents. */
  readonly storedChars: number;
  /**
   * The ceiling that stopped the walk on a full page, when one did — the
   * capture may then hold more rows than were read — or `undefined` when the
   * walk reached the capture's end.
   */
  readonly ceiling: SummaryCeiling | undefined;
}

/**
 * The counts a computed summary is judged and reported by — the capture's
 * size, its per-kind counts and producers, and whether the summary covers only
 * part of it — reconciled with the store's exact counts when a ceiling stopped
 * the walk.
 */
interface CaptureEvidence {
  /** The per-kind counts the emptiness rule reads. */
  readonly counts: Pick<CaptureSummary, 'eventCount' | 'kindCounts'>;
  /**
   * How many events the store holds for the capture — exact, except when a
   * capped capture's exact counts could not be read, where it is the rows read.
   */
  readonly storedEvents: number;
  /** Which producers delivered events to the capture. */
  readonly contributing: ContributingProducers;
  /**
   * The ceiling that left stored events out of the summary, or `undefined`
   * when it covers every row — including a walk stopped at a ceiling exactly
   * where the capture ended.
   */
  readonly ceiling: SummaryCeiling | undefined;
}

/** What one run of the stop barrier observed: counts and a vocabulary member only. */
interface CaptureDrainReport {
  /** How the barrier ended; becomes the summary's `coverage.drain`. */
  readonly outcome: CaptureDrainOutcome;
  /** How many times the watermark was read. */
  readonly polls: number;
  /** How many of those reads saw the watermark move. */
  readonly changes: number;
  /** How long the barrier ran on the monotonic clock, `0` when it could not be read. */
  readonly waitedMs: number;
  /** The quiet period the barrier waited for. */
  readonly quietPeriodMs: number;
  /** The last watermark read, when any read succeeded. */
  readonly watermark?: CaptureIngestWatermark;
}

/**
 * The default sleeper: a timer that resolves after `ms`, or at once when the
 * signal aborts. It never rejects, so the barrier's only way out of a wait is
 * the next watermark read or the abort check that follows it.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const wake = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
}

/** An injected duration when it is a finite number within bounds, otherwise the default. */
function durationOr(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

/**
 * The barrier timing a stage runs with: each injected member that is usable,
 * the default for the rest. A poll interval must be positive (a zero interval
 * would spin); the other durations may be zero.
 */
function resolveDrainTiming(injected: Partial<CaptureDrainTiming> | undefined): CaptureDrainTiming {
  return Object.freeze({
    sleep: injected?.sleep ?? sleepUnlessAborted,
    monotonicNow: injected?.monotonicNow ?? ((): number => performance.now()),
    pollIntervalMs: durationOr(injected?.pollIntervalMs, CAPTURE_DRAIN_DEFAULTS.pollIntervalMs, 1),
    quietPeriodMs: durationOr(injected?.quietPeriodMs, CAPTURE_DRAIN_DEFAULTS.quietPeriodMs, 0),
    unreachableQuietPeriodMs: durationOr(
      injected?.unreachableQuietPeriodMs,
      CAPTURE_DRAIN_DEFAULTS.unreachableQuietPeriodMs,
      0,
    ),
    maxDrainMs: durationOr(injected?.maxDrainMs, CAPTURE_DRAIN_DEFAULTS.maxDrainMs, 0),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Coverage (AAP §0.5.5) — pure
 * ---------------------------------------------------------------------------------------------- */

/** What {@link coverageNotice} is told beyond the coverage itself. */
interface CoverageFacts {
  /** The coverage attached to the summary. */
  readonly coverage: CaptureCoverage;
  /**
   * The ceiling that left stored events out of the summary, when one did —
   * which is what tells a capped summary from one missing unreadable rows.
   */
  readonly ceiling: SummaryCeiling | undefined;
  /**
   * Whether the producer-loss total is the whole loss: it could be read, and
   * the ledger has tracked the capture since its window opened in this
   * process. Otherwise `coverage.producerDroppedEvents` is a lower bound.
   */
  readonly lossAccounted: boolean;
}

/** A count as display text, digits grouped the same way on every host. */
function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** Bytes per mebibyte, for display. */
const BYTES_PER_MIB = 1024 * 1024;

/** The ceiling that stopped a summary, as the words the finding row names it by. */
function ceilingText(ceiling: SummaryCeiling): string {
  return ceiling === 'events'
    ? `${formatCount(MAX_SUMMARY_EVENTS)} events`
    : `${formatCount(Math.round(MAX_SUMMARY_BYTES / BYTES_PER_MIB))} MiB of stored event data`;
}

/**
 * The `session.progress` finding row that tells both user interfaces a
 * capture's evidence is incomplete, in counts only: the summary was capped or
 * left unreadable rows out, a producer discarded events before delivery, or
 * the stop barrier could not confirm that every in-flight event arrived.
 *
 * @returns The row's message, or `undefined` for a complete coverage.
 */
function coverageNotice(facts: CoverageFacts): string | undefined {
  const { coverage, ceiling } = facts;
  if (coverage.complete) {
    return undefined;
  }
  const sentences: string[] = [];
  const missing = coverage.storedEvents - coverage.summarizedEvents;
  if (ceiling !== undefined) {
    sentences.push(
      missing > 0
        ? `The summary covers the first ${formatCount(coverage.summarizedEvents)} of ${formatCount(coverage.storedEvents)} captured events; one summary covers at most ${ceilingText(ceiling)}.`
        : `The summary covers the first ${formatCount(coverage.summarizedEvents)} captured events; the capture may hold more, and one summary covers at most ${ceilingText(ceiling)}.`,
    );
  } else if (missing > 0) {
    sentences.push(
      `The summary covers ${formatCount(coverage.summarizedEvents)} of ${formatCount(coverage.storedEvents)} captured events; ${formatCount(missing)} stored ${missing === 1 ? 'event' : 'events'} could not be read back.`,
    );
  }
  const dropped = coverage.producerDroppedEvents;
  if (dropped > 0) {
    sentences.push(
      `${facts.lossAccounted ? '' : 'At least '}${formatCount(dropped)} ${dropped === 1 ? 'event was' : 'events were'} discarded by a producer before delivery.`,
    );
  } else if (!facts.lossAccounted) {
    sentences.push('Whether any producer discarded events before delivery could not be confirmed.');
  }
  if (coverage.drain === 'deadline') {
    sentences.push(
      'Events were still arriving when the capture stopped, so its last events may be missing.',
    );
  } else if (coverage.drain === 'unverified') {
    sentences.push(
      'Whether every event in flight when the capture stopped arrived could not be confirmed.',
    );
  }
  return `Capture evidence is incomplete. ${sentences.join(' ')}`;
}

/**
 * Whether a disarm left a producer that may still be sending on its own timer:
 * the disarm could not be sent at all, the dormant page configuration was not
 * sent, or the preload could not be reached.
 */
function producerMayStillSend(disarmed: DisarmCaptureOutcome | undefined): boolean {
  return (
    disarmed === undefined || !disarmed.agentDisarmed || disarmed.serverAgent === 'unreachable'
  );
}

/** The tier the page agent reports every event in (AAP §0.2.3). */
const PAGE_AGENT_TIERS: readonly TelemetryTier[] = Object.freeze(['browser'] as const);

/** The tiers the dev-server preload reports its events in: request handling and database spans (AAP §0.2.3). */
const SERVER_AGENT_TIERS: readonly TelemetryTier[] = Object.freeze(['server', 'db'] as const);

/**
 * Which of the two producers delivered events to a capture, as far as the
 * capture's counts show: the page agent through browser-tier events, the
 * dev-server preload through server- and db-tier events.
 */
interface ContributingProducers {
  /** Whether the capture holds, or may hold, events of {@link PAGE_AGENT_TIERS}. */
  readonly pageAgent: boolean;
  /** Whether the capture holds, or may hold, events of {@link SERVER_AGENT_TIERS}. */
  readonly serverAgent: boolean;
}

/** The two producers, as the vocabulary a log record names an unconfirmed one by. */
type ProducerName = 'page-agent' | 'server-agent';

/** The summed count of the tiers named, from a zero-filled per-tier table. */
function tierTotal(
  tierCounts: Readonly<Record<TelemetryTier, number>>,
  tiers: readonly TelemetryTier[],
): number {
  let total = 0;
  for (const tier of tiers) {
    total += countOf(tierCounts[tier]);
  }
  return total;
}

/**
 * The producers a fully summarised capture holds events of, read off the
 * summary's exact per-tier counts.
 */
function contributorsFromTiers(
  tierCounts: Readonly<Record<TelemetryTier, number>>,
): ContributingProducers {
  return {
    pageAgent: tierTotal(tierCounts, PAGE_AGENT_TIERS) > 0,
    serverAgent: tierTotal(tierCounts, SERVER_AGENT_TIERS) > 0,
  };
}

/**
 * The producers a capped capture may hold events of, read off the store's
 * exact per-kind counts of the whole window. A kind the telemetry schema allows
 * in several tiers (`function`, `log`) counts towards every producer that may
 * have sent it: an over-approximation can only report a flush as unconfirmed,
 * never confirm one, and a capped capture is already reported incomplete.
 */
function contributorsFromKinds(
  kindCounts: Readonly<Record<TelemetryKind, number>>,
): ContributingProducers {
  let pageAgent = false;
  let serverAgent = false;
  for (const kind of TELEMETRY_KINDS) {
    if (countOf(kindCounts[kind]) === 0) {
      continue;
    }
    const tiers = allowedTiersFor(kind);
    pageAgent ||= tiers.some((tier) => PAGE_AGENT_TIERS.includes(tier));
    serverAgent ||= tiers.some((tier) => SERVER_AGENT_TIERS.includes(tier));
  }
  return { pageAgent, serverAgent };
}

/**
 * The producers that delivered events to this capture but whose final flush
 * the stop cannot confirm (AAP §0.5.5), in a fixed order:
 *
 * - the **page agent** when the capture holds browser-tier events and the
 *   dormant page configuration was not sent (`agentDisarmed: false`), or the
 *   disarm could not be sent at all;
 * - the **dev-server preload** when the capture holds server- or db-tier
 *   events and the preload could not be reached (`serverAgent:
 *   'unreachable'`), or the disarm could not be sent at all.
 *
 * A producer that sent the capture nothing is never listed: an unreachable
 * preload of a page-only capture has no flush this capture could be missing,
 * and listing it would mark ordinary captures incomplete.
 */
function unconfirmedContributors(
  disarmed: DisarmCaptureOutcome | undefined,
  contributing: ContributingProducers,
): readonly ProducerName[] {
  const unconfirmed: ProducerName[] = [];
  if (contributing.pageAgent && (disarmed === undefined || !disarmed.agentDisarmed)) {
    unconfirmed.push('page-agent');
  }
  if (
    contributing.serverAgent &&
    (disarmed === undefined || disarmed.serverAgent === 'unreachable')
  ) {
    unconfirmed.push('server-agent');
  }
  return unconfirmed;
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
  /**
   * The capture's persisted, already-redacted events, read only: paged —
   * with each page's stored size — to summarise them, counted per kind when the
   * summary is capped, and watched through the ingest watermark by the stop
   * barrier. Beside the events, the in-process producer-loss ledger: begun when
   * the window opens, read for the total the summary's coverage reports, and
   * released once the window is closed.
   */
  readonly telemetry: Pick<
    TelemetryRepo,
    | 'pageCaptureForSummary'
    | 'countByKind'
    | 'captureWatermark'
    | 'beginProducerLossAccounting'
    | 'producerLoss'
    | 'releaseProducerLoss'
  >;
  /** The only writer of session status: reads the record, opens and closes capture windows. */
  readonly sessionManager: Pick<SessionManager, 'get' | 'startCapture' | 'stopCapture'>;
  /**
   * The `session.progress` emitter (`../../sessions/progress.ts`): the group
   * rows, and the `finding` rows that say a capture's evidence is incomplete or
   * that its interaction hook was off.
   */
  readonly progress: Pick<
    SessionProgress,
    'stageStarted' | 'stageCompleted' | 'stageFailed' | 'finding'
  >;
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
   * The stop barrier's sleeper, monotonic clock and durations, member by
   * member; absent members take {@link CAPTURE_DRAIN_DEFAULTS}, real timers and
   * `performance.now()`. Never derived from {@link now}.
   */
  readonly drain?: Partial<CaptureDrainTiming> | undefined;
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
  /**
   * The capture's summary — the payload of `capture.stopped`. A summary
   * computed by this call carries its `coverage`; a stored one carries what it
   * was stored with.
   */
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
   * Disarms both producers, waits — bounded — for the batches they flush to
   * land, summarises the capture with its coverage, classifies it and closes
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

/** The gate's sentences, and whether any blocking entry's reason could not be proven. */
interface BlockedSentences {
  /** One "Could not enable ‹signal›: ‹reason›." per proven entry, collapsed. */
  readonly sentences: readonly string[];
  /** Whether an entry was left out because its reason is not product-authored. */
  readonly unproven: boolean;
}

/**
 * Whether a blocking entry's wording may be quoted in the refusal: its reason
 * is text the product registered (`isProductAuthoredText` — readiness's gate
 * wording, detection's preload-gap reason, readiness's fixed sentence for a
 * failed probe), and its label is either product vocabulary
 * (`CAPTURE_SIGNAL_LABELS`) or quoted inside that proven reason, as a failed
 * probe's adapter id is. An adapter's own reason — which may quote a path, a
 * statement or a URL (CWE-209) — is never proven.
 */
function isProvenEntry(entry: UnavailableSignal, label: string): boolean {
  return (
    isProductAuthoredText(entry.reason) &&
    (isCaptureSignal(entry.signal) || entry.reason.includes(label))
  );
}

/**
 * The first clause of AAP §0.5.5's sentence for each signal the gate withheld —
 * "Could not enable ‹signal›: ‹reason›." — with the reason verbatim when it is
 * proven product text (readiness's reasons are worded to read after that
 * colon). An entry whose reason is not proven contributes no sentence; the
 * caller puts the code's fixed copy in its place. The "Continuing with" clause
 * is omitted because a blocked gate does not continue. Identical sentences
 * collapse onto the first.
 */
function blockedSentences(entries: readonly UnavailableSignal[]): BlockedSentences {
  const sentences: string[] = [];
  const seen = new Set<string>();
  let unproven = false;
  for (const entry of entries) {
    const label = labelForSignal(entry.signal);
    if (label.length === 0) {
      continue;
    }
    if (!isProvenEntry(entry, label)) {
      unproven = true;
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
  return { sentences, unproven };
}

/** The recovery steps of the blocking entries, and whether any could not be proven. */
interface BlockedHints {
  /** Each proven hint once, as one line of display text, in entry order. */
  readonly hints: readonly string[];
  /** Whether a non-empty hint was left out because it is not product-authored. */
  readonly unproven: boolean;
}

/**
 * The blocking entries' hints that are proven product text — readiness's gate
 * hints, detection's relaunch hint — deduplicated. When no entry states a hint
 * and the first remedy is a relaunch, its hint stands in, on the same proof.
 */
function blockedHints(
  entries: readonly UnavailableSignal[],
  first: ReadinessRemediation | undefined,
): BlockedHints {
  const hints: string[] = [];
  let unproven = false;
  const take = (text: string): void => {
    const line = toDisplayLine(text);
    if (line.length === 0) {
      return;
    }
    if (!isProductAuthoredText(text)) {
      unproven = true;
    } else if (!hints.includes(line)) {
      hints.push(line);
    }
  };
  for (const entry of entries) {
    take(entry.hint);
  }
  if (hints.length === 0 && !unproven && first?.kind === 'relaunch-dev-server') {
    take(first.hint);
  }
  return { hints, unproven };
}

/** The fixed public copy of a failure code, `INTERNAL`'s for a code outside the vocabulary. */
function fixedCopyOf(code: DebuggenErrorCode): PublicFailureCopy {
  return Object.hasOwn(FAILURE_COPY_BY_CODE, code)
    ? FAILURE_COPY_BY_CODE[code]
    : FAILURE_COPY_BY_CODE.INTERNAL;
}

/**
 * The typed refusal of an unsatisfied readiness gate: the code of the first
 * remedy, a message and hint composed only of product-authored text, and — for
 * the local log alone — the verdict's blocking entries and remediations
 * verbatim in `details`.
 *
 * The refusal is shown verbatim by both user interfaces (an HTTP 409/503 body,
 * a failed row), so its text is proven before it is used (CWE-209): a blocking
 * entry's reason or hint is quoted only when `isProductAuthoredText` accepts
 * it, and every unproven fragment is replaced by the code's fixed copy from
 * `FAILURE_COPY_BY_CODE` — its summary for an unproven reason, its hint for an
 * unproven hint. What the refusal then says is wholly the product's, so it is
 * registered with `authorProductText` and a surface may show it as is.
 */
function blockedGateError(sessionId: string, verdict: ReadinessVerdict): DebuggenError {
  const blocking = listOf(verdict.blocking);
  const remediations = listOf(verdict.remediations);
  const degraded = listOf(verdict.degraded);
  const first = remediations[0];
  const code = first === undefined ? BLOCKED_GATE_FALLBACK_CODE : BLOCKED_GATE_CODES[first.kind];
  const copy = fixedCopyOf(code);
  const worded = blockedSentences(blocking);
  const hinted = blockedHints(blocking, first);
  const sentences = worded.unproven ? [...worded.sentences, copy.summary] : worded.sentences;
  const hints =
    hinted.unproven && !hinted.hints.includes(copy.hint)
      ? [...hinted.hints, copy.hint]
      : hinted.hints;
  const message = authorProductText(
    sentences.length === 0
      ? NOTHING_DELIVERABLE_MESSAGE
      : clip(sentences.join(' '), MAX_ERROR_MESSAGE_LENGTH),
  );
  const hint = authorProductText(
    hints.length === 0 ? NOTHING_DELIVERABLE_HINT : clip(hints.join(' '), MAX_ERROR_HINT_LENGTH),
  );

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

/** An enumerated reason: a short kebab-case identifier, the only `details.reason` shape logged. */
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * The enumerated `details.reason` of an error, when it carries one. Upstream
 * modules put a closed-vocabulary identifier there, but a collaborator's error
 * can carry a wrapped exception's text under the same key; anything outside
 * {@link REASON_PATTERN} is therefore left out of the log record rather than
 * trusted (CWE-532), and never matches a reason this stage branches on.
 */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : undefined;
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
  const drainTiming = resolveDrainTiming(deps.drain);

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
    row: 'started' | 'completed' | 'failed' | 'finding',
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
   * Reads one capture's persisted events page by page, {@link SUMMARY_PAGE_SIZE}
   * rows at a time in canonical order, and summarises them with the upstream
   * `computeCaptureSummary`. The events are the already-redacted rows ingest
   * stored; nothing is re-redacted, correlated or aggregated here.
   *
   * Bounded twice: the walk stops once {@link MAX_SUMMARY_EVENTS} rows or
   * {@link MAX_SUMMARY_BYTES} of stored documents have been read — unreadable
   * rows count towards both, so a capture of poisoned rows is bounded too —
   * checking both between pages, so it overshoots the ceiling that stops it by
   * at most one page. It yields to the event loop between pages, so ingest and
   * every other request keep being served while a large capture is read, and
   * the one synchronous aggregate at the end runs over at most one bounded
   * summary's events.
   *
   * @returns The summary with its counts. `rowsRead` is the capture's full size
   * only when no ceiling stopped the walk; `evidenceCountsOf` reconciles a
   * capped walk with the store's exact counts.
   */
  const summarizeFromStore = async (
    log: Logger,
    sessionId: string,
    captureId: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<SummarizedCapture, DebuggenError>> => {
    const events: TelemetryEvent[] = [];
    let offset = 0;
    let rowsRead = 0;
    let skipped = 0;
    let storedChars = 0;
    let ceiling: SummaryCeiling | undefined;
    for (;;) {
      if (isAborted(signal)) {
        return err(cancelledError(sessionId, captureId));
      }
      const limit = Math.min(SUMMARY_PAGE_SIZE, MAX_SUMMARY_EVENTS - rowsRead);
      const page = attempt(
        () => deps.telemetry.pageCaptureForSummary(sessionId, captureId, { limit, offset }),
        'STORE_ERROR',
      );
      if (!page.ok) {
        return page;
      }
      for (const row of page.value.rows) {
        events.push(row);
      }
      const pageSkipped = countOf(page.value.skipped);
      const read = Math.max(countOf(page.value.rowsRead), page.value.rows.length + pageSkipped);
      skipped += pageSkipped;
      rowsRead += read;
      storedChars += countOf(page.value.storedChars);
      const next = page.value.nextOffset;
      if (next === undefined || read === 0 || next <= offset) {
        break;
      }
      if (rowsRead >= MAX_SUMMARY_EVENTS) {
        ceiling = 'events';
        break;
      }
      if (storedChars >= MAX_SUMMARY_BYTES) {
        ceiling = 'bytes';
        break;
      }
      offset = next;
      await yieldToEventLoop();
    }
    if (skipped > 0) {
      log.warn('Stored events that no longer validate were left out of the capture summary.', {
        skipped,
      });
    }
    return ok(
      Object.freeze({
        summary: computeCaptureSummary(events, { captureId, sessionId }),
        rowsRead,
        summarizedEvents: events.length,
        skipped,
        storedChars,
        ceiling,
      }),
    );
  };

  /**
   * The counts the empty-capture rule reads. A walk a ceiling stopped saw only
   * the capture's earliest events, so its per-kind counts would under-report
   * the rest; the store's exact per-kind count of the whole capture is used
   * instead, and its total is the capture's size. A total no larger than the
   * rows read means the capture ended exactly where the walk stopped: the
   * summary covers it in full after all. Should the exact count fail, the
   * summary's own counts — the evidence the analysis will reason from — are
   * used, the rows read stand in for the capture's size, and the fallback is
   * logged.
   *
   * The same counts say which producers delivered events to the capture: the
   * summary's per-tier counts of a capture summarised in full, the exact
   * per-kind counts of a capped one. A capped capture whose exact counts
   * cannot be read may hold events of either producer beyond the cap, so both
   * are reported as contributing — it is reported incomplete regardless.
   *
   * @returns The counts, the capture's size, its producers and the ceiling
   * that left events out of the summary.
   */
  const evidenceCountsOf = (
    log: Logger,
    sessionId: string,
    captureId: string,
    summarized: SummarizedCapture,
  ): CaptureEvidence => {
    const inFull: CaptureEvidence = {
      counts: summarized.summary,
      storedEvents: summarized.rowsRead,
      contributing: contributorsFromTiers(summarized.summary.tierCounts),
      ceiling: undefined,
    };
    const { ceiling } = summarized;
    if (ceiling === undefined) {
      return inFull;
    }
    const exact = attempt(() => deps.telemetry.countByKind(sessionId, captureId), 'STORE_ERROR');
    if (!exact.ok) {
      log.warn(
        'The exact event counts of a capped capture could not be read; the summary counts are used.',
        {
          code: exact.error.code,
          ceiling,
          rowsRead: summarized.rowsRead,
        },
      );
      return {
        counts: summarized.summary,
        storedEvents: summarized.rowsRead,
        contributing: { pageAgent: true, serverAgent: true },
        ceiling,
      };
    }
    let eventCount = 0;
    for (const count of Object.values(exact.value)) {
      eventCount += countOf(count);
    }
    if (eventCount <= summarized.rowsRead) {
      return inFull;
    }
    log.warn('The capture holds more than one summary covers; the summary was capped.', {
      ceiling,
      storedEvents: eventCount,
      summarizedEvents: summarized.summarizedEvents,
      storedChars: summarized.storedChars,
      maxSummaryEvents: MAX_SUMMARY_EVENTS,
      maxSummaryBytes: MAX_SUMMARY_BYTES,
    });
    return {
      counts: { eventCount, kindCounts: exact.value },
      storedEvents: eventCount,
      contributing: contributorsFromKinds(exact.value),
      ceiling,
    };
  };

  /**
   * How the stop barrier ended once the capture's producers are known (AAP
   * §0.5.5). A barrier that went quiet only proves that nothing arrived for the
   * quiet period; a producer that sent this capture events and could not be
   * told to disarm — its dormant configuration unsent, its preload unreachable,
   * or the disarm itself failed — may still hold a final flush the window never
   * saw. Such a capture's barrier is reported `'unverified'`, so its coverage is
   * not complete and both user interfaces are told. Every other ending is
   * returned unchanged, and a producer that contributed nothing never changes
   * the ending.
   *
   * @returns The drain outcome the summary's coverage records.
   */
  const confirmDrain = (
    log: Logger,
    drain: CaptureDrainOutcome,
    disarmed: DisarmCaptureOutcome | undefined,
    contributing: ContributingProducers,
  ): CaptureDrainOutcome => {
    if (drain !== 'quiescent') {
      return drain;
    }
    const unconfirmed = unconfirmedContributors(disarmed, contributing);
    if (unconfirmed.length === 0) {
      return drain;
    }
    log.warn(
      'A producer that sent this capture events could not be confirmed to have flushed; the capture window is reported unverified.',
      {
        drain: 'unverified',
        reason: 'producer-flush-unconfirmed',
        producers: unconfirmed,
        ...(disarmed === undefined
          ? { disarm: 'failed' }
          : { agentDisarmed: disarmed.agentDisarmed, serverAgent: disarmed.serverAgent }),
      },
    );
    return 'unverified';
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
   * The coverage a computed summary carries (AAP §0.5.5): how many events the
   * store holds for the window and how many the summary covers, how many the
   * producers reported discarding (the telemetry store's per-capture ledger,
   * fed by ingest), and how the stop barrier ended. `complete` only when
   * nothing is known to be missing — a loss total that cannot be read, or one
   * the in-memory ledger cannot vouch for (the service restarted since the
   * window opened, or the ledger forgot the capture), is not known to be zero,
   * and a summary a ceiling capped is not whole even when the capture's exact
   * size could not be read.
   */
  const coverageOf = (
    log: Logger,
    sessionId: string,
    captureId: string,
    evidence: CaptureEvidence,
    summarized: SummarizedCapture,
    drain: CaptureDrainOutcome,
  ): CoverageFacts => {
    const loss = attempt(() => deps.telemetry.producerLoss(sessionId, captureId), 'STORE_ERROR');
    if (!loss.ok) {
      log.warn('The producer-loss total could not be read; the capture is not reported complete.', {
        code: loss.error.code,
      });
    }
    const producerDroppedEvents = loss.ok ? countOf(loss.value.droppedEvents) : 0;
    const lossAccounted = loss.ok && loss.value.accounted === true;
    if (loss.ok && !lossAccounted) {
      log.warn(
        'The producer-loss ledger has not tracked this capture since its window opened; the loss total is a lower bound and the capture is not reported complete.',
        {
          reason: 'producer-loss-unaccounted',
          producerDroppedEvents,
        },
      );
    }
    const { storedEvents, ceiling } = evidence;
    const summarizedEvents = summarized.summarizedEvents;
    const coverage: CaptureCoverage = Object.freeze({
      storedEvents,
      summarizedEvents,
      producerDroppedEvents,
      drain,
      complete:
        lossAccounted &&
        ceiling === undefined &&
        summarizedEvents >= storedEvents &&
        producerDroppedEvents === 0 &&
        drain !== 'deadline' &&
        drain !== 'unverified',
    });
    return { coverage, ceiling, lossAccounted };
  };

  /**
   * Starts the producer-loss ledger's accounting for a window this stage just
   * opened, so the capture's coverage can later vouch for its loss total. A
   * ledger that refuses is logged and does not stop the capture: its coverage
   * then reads as unaccounted and is never reported complete.
   */
  const beginLossAccounting = (log: Logger, sessionId: string, captureId: string): void => {
    const begun = attempt(
      () => deps.telemetry.beginProducerLossAccounting(sessionId, captureId),
      'STORE_ERROR',
    );
    if (!begun.ok) {
      log.warn(
        'The producer-loss ledger could not begin accounting for the capture; its coverage will not be reported complete.',
        { code: begun.error.code },
      );
    }
  };

  /**
   * Releases the ledger's entry and the ingest arrivals the stop barrier
   * watched for a window this stage has closed, once the loss total is
   * persisted in the summary's coverage. A release that fails is logged only:
   * both bounded structures forget the entry in time regardless.
   */
  const releaseLossAccounting = (log: Logger, sessionId: string, captureId: string): void => {
    const released = attempt(
      () => deps.telemetry.releaseProducerLoss(sessionId, captureId),
      'STORE_ERROR',
    );
    if (!released.ok) {
      log.warn('The producer-loss ledger entry of a closed capture could not be released.', {
        code: released.error.code,
      });
    }
  };

  /** One monotonic reading for the stop barrier; a clock that throws or answers a non-finite value yields `undefined`. */
  const readMonotonic = (): number | undefined => {
    try {
      const value = drainTiming.monotonicNow();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The stop barrier (AAP §0.5.5): after the producers were disarmed and
   * **before** the window is closed, waits — bounded — for the batches they
   * flush on disarm, and any already in flight, to be stored under this
   * capture.
   *
   * The window stays open throughout, so ingest keeps attributing late batches
   * to the capture that recorded them instead of discarding them once the
   * window has closed. The capture's ingest watermark is read every
   * `pollIntervalMs`; the barrier ends:
   *
   * - `'quiescent'` once the watermark has stood still for the quiet period
   *   ({@link CaptureDrainTiming.unreachableQuietPeriodMs} when a producer
   *   could not be told to disarm, {@link CaptureDrainTiming.quietPeriodMs}
   *   otherwise);
   * - `'deadline'` when the watermark is still moving at `maxDrainMs` (or, as a
   *   guard against a clock that does not advance, after twice the polls that
   *   ceiling allows);
   * - `'unverified'` when the watermark or the monotonic clock could not be
   *   read.
   *
   * A `'quiescent'` ending is provisional: once the summary shows which
   * producers sent the capture events, `confirmDrain` reports it
   * `'unverified'` when one of them could not be confirmed disarmed.
   *
   * Each ending is logged with counts only; none of them fails the capture.
   *
   * @returns The report, or the cancellation when `signal` aborted.
   */
  const awaitIngestQuiescence = async (
    log: Logger,
    sessionId: string,
    captureId: string,
    disarmed: DisarmCaptureOutcome | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<CaptureDrainReport, DebuggenError>> => {
    const quietPeriodMs = producerMayStillSend(disarmed)
      ? drainTiming.unreachableQuietPeriodMs
      : drainTiming.quietPeriodMs;
    const maxPolls = 2 * Math.ceil(drainTiming.maxDrainMs / drainTiming.pollIntervalMs) + 2;
    let polls = 0;
    let changes = 0;

    const readWatermark = (): Result<CaptureIngestWatermark, DebuggenError> => {
      polls += 1;
      return attempt(() => deps.telemetry.captureWatermark(sessionId, captureId), 'STORE_ERROR');
    };

    const finish = (
      outcome: CaptureDrainOutcome,
      startedAt: number | undefined,
      watermark: CaptureIngestWatermark | undefined,
      code?: DebuggenErrorCode,
    ): Result<CaptureDrainReport, DebuggenError> => {
      const endedAt = readMonotonic();
      const waitedMs =
        startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
      const report: CaptureDrainReport = Object.freeze({
        outcome,
        polls,
        changes,
        waitedMs,
        quietPeriodMs,
        ...(watermark !== undefined ? { watermark } : {}),
      });
      const fields: LogFields = {
        drain: outcome,
        polls,
        changes,
        waitedMs,
        quietPeriodMs,
        // Arrivals, not stored events: the watermark counts the rows ingest
        // committed while tracking the capture, a change detector only.
        ...(watermark !== undefined ? { arrivals: watermark.eventCount } : {}),
        ...(code !== undefined ? { code } : {}),
      };
      if (outcome === 'quiescent') {
        log.debug('The capture window went quiet before it closed.', fields);
      } else {
        log.warn(
          'The capture window closes without confirming that every in-flight event arrived.',
          fields,
        );
      }
      return ok(report);
    };

    const startedAt = readMonotonic();
    if (startedAt === undefined) {
      return finish('unverified', undefined, undefined);
    }
    const first = readWatermark();
    if (!first.ok) {
      return finish('unverified', startedAt, undefined, first.error.code);
    }
    let watermark = first.value;
    let lastChangeAt = startedAt;

    for (;;) {
      if (isAborted(signal)) {
        return err(cancelledError(sessionId, captureId));
      }
      const now = readMonotonic();
      if (now === undefined) {
        return finish('unverified', startedAt, watermark);
      }
      const quietFor = now - lastChangeAt;
      const elapsed = now - startedAt;
      if (quietFor >= quietPeriodMs) {
        return finish('quiescent', startedAt, watermark);
      }
      if (elapsed >= drainTiming.maxDrainMs || polls >= maxPolls) {
        return finish('deadline', startedAt, watermark);
      }
      const waitMs = Math.max(
        1,
        Math.min(
          drainTiming.pollIntervalMs,
          quietPeriodMs - quietFor,
          drainTiming.maxDrainMs - elapsed,
        ),
      );
      try {
        await drainTiming.sleep(waitMs, signal);
      } catch (thrown) {
        // A sleeper that rejects is an early wake-up: the poll bound still ends the barrier.
        log.debug('The stop barrier woke early.', {
          code: DebuggenError.from(thrown, 'INTERNAL').code,
        });
      }
      if (isAborted(signal)) {
        return err(cancelledError(sessionId, captureId));
      }
      const next = readWatermark();
      if (!next.ok) {
        return finish('unverified', startedAt, watermark, next.error.code);
      }
      if (
        next.value.eventCount !== watermark.eventCount ||
        next.value.lastIngestSeq !== watermark.lastIngestSeq
      ) {
        watermark = next.value;
        changes += 1;
        lastChangeAt = readMonotonic() ?? now;
      }
    }
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
    const summarized = await summarizeFromStore(log, session.id, captureId, undefined);
    if (!summarized.ok) {
      log.error('The capture window of a failed arm could not be summarised; it stays open.', {
        code: summarized.error.code,
      });
      return false;
    }
    // Nothing was armed, so there is no flush to wait for: the barrier is not applicable.
    const { coverage } = coverageOf(
      log,
      session.id,
      captureId,
      evidenceCountsOf(log, session.id, captureId, summarized.value),
      summarized.value,
      'not-applicable',
    );
    const stopped = await attemptAsync(
      () =>
        deps.sessionManager.stopCapture(session.id, {
          summary: Object.freeze({ ...summarized.value.summary, coverage }),
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
    releaseLossAccounting(log, session.id, captureId);
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
    // The loss ledger accounts for the window from the moment it exists, so
    // every loss report ingest attributes to it is counted (AAP §0.5.5).
    beginLossAccounting(log, sessionId, captureId);

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
    const holdsSummary = record.summary !== undefined && record.summary.captureId === captureId;

    // 3. The stop barrier: the window stays open — so ingest keeps attributing
    //    to it — until the batches the producers flush on disarm have landed,
    //    bounded. Only a live window being summarised now has anything to wait
    //    for; a window closed earlier is `not-applicable`.
    let drain: CaptureDrainOutcome = 'not-applicable';
    if (capturing && !holdsSummary) {
      const drained = await awaitIngestQuiescence(
        log,
        sessionId,
        captureId,
        disarmed,
        context.signal,
      );
      if (!drained.ok) {
        return fail(drained.error);
      }
      drain = drained.value.outcome;
    }

    // 4. The summary: the stored one when the row already holds it, otherwise
    //    the upstream aggregate over the capture's persisted events, bounded.
    //    A computed summary carries its coverage: what it left out, what the
    //    producers reported discarding and how the barrier ended — persisted with
    //    it and broadcast in `capture.stopped`. A quiet barrier is reported
    //    unverified when a producer that sent this capture events could not be
    //    confirmed disarmed: its final flush may never have arrived.
    let summary: CaptureSummary;
    let summarySource: CaptureSummarySource;
    let evidence: Pick<CaptureSummary, 'eventCount' | 'kindCounts'>;
    let coverageFacts: CoverageFacts | undefined;
    if (record.summary !== undefined && holdsSummary) {
      summary = record.summary;
      summarySource = 'stored';
      evidence = summary;
    } else {
      const computed = await summarizeFromStore(log, sessionId, captureId, context.signal);
      if (!computed.ok) {
        return fail(computed.error);
      }
      const measured = evidenceCountsOf(log, sessionId, captureId, computed.value);
      drain = confirmDrain(log, drain, disarmed, measured.contributing);
      coverageFacts = coverageOf(log, sessionId, captureId, measured, computed.value, drain);
      summary = Object.freeze({ ...computed.value.summary, coverage: coverageFacts.coverage });
      summarySource = 'computed';
      evidence = measured.counts;
    }
    const coverage = summary.coverage;

    // 5. The empty-capture rule of AAP §0.5.5, judged by the question alone;
    //    what was armed is only reported, as the interaction-hook diagnostic.
    const armedWith = resolveArmedConfiguration(log, session, record.planVersion);
    const emptiness = classifyCaptureEmptiness(
      evidence,
      input.understanding ?? session.understanding,
      // The dormant stand-in of an unknown arming would misreport the hook as off.
      armedWith.source === 'none' ? {} : { agentHooks: armedWith.agentHooks },
    );
    const next = emptiness.empty ? NEXT_WHEN_EMPTY : NEXT_WITH_EVIDENCE;

    // 6. The window, closed by the only writer of session status, which persists
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
      // The loss total now lives in the persisted coverage; the ledger's entry
      // and the window's arrivals are no longer needed.
      releaseLossAccounting(log, sessionId, captureId);
    }

    // 7. What the developer needs to read before the closing row, in counts
    //    only: that the evidence is incomplete, and why an interaction
    //    question's capture is empty when its hook was off.
    const incomplete = coverageFacts === undefined ? undefined : coverageNotice(coverageFacts);
    if (stoppedNow && incomplete !== undefined) {
      sendRow(log, 'finding', () => deps.progress.finding(sessionId, CAPTURE_STAGE, incomplete));
    }
    if (
      stoppedNow &&
      emptiness.empty &&
      emptiness.reason === 'no-interaction' &&
      emptiness.interactionHookArmed === false
    ) {
      sendRow(log, 'finding', () =>
        deps.progress.finding(sessionId, CAPTURE_STAGE, INTERACTION_HOOK_OFF_MESSAGE),
      );
    }

    // 8. The capture group's closing row: the stage title, or the empty-capture sentence.
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
        ...(emptiness.interactionHookArmed !== undefined
          ? { interactionHookArmed: emptiness.interactionHookArmed }
          : {}),
        traceCount: countOf(summary.traceCount),
        empty: emptiness.empty,
        ...(emptiness.empty ? { reason: emptiness.reason } : {}),
        next,
        summarySource,
        drain,
        ...(coverage !== undefined
          ? {
              coverageComplete: coverage.complete,
              storedEvents: coverage.storedEvents,
              summarizedEvents: coverage.summarizedEvents,
              producerDroppedEvents: coverage.producerDroppedEvents,
            }
          : {}),
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
