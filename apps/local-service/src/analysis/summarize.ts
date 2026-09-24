/**
 * Analysis-stage input assembly: the bounded, redacted, plain-JSON evidence
 * view the analyze prompt receives.
 *
 * AAP 0.4.2 ("AI stage boundaries", Analysis row) fixes the stage's input as
 * "redacted aggregates: trace trees, top spans, render stats, request/query
 * stats, relevant code excerpts", and AAP 0.7.1 Group 2 names this module the
 * producer of those "aggregates for the analysis prompt". The object returned by
 * {@link AnalysisSummarizer.buildStageInput} becomes `ModelRequest.input` for
 * the analyze prompt (it is assignable to `JsonObject`, asserted by
 * {@link AnalysisStageInputIsJson}); `pipeline/context-builder.ts` serialises it,
 * renders the prompt from it and applies the outbound guard.
 *
 * What this module guarantees, and where each guarantee comes from:
 *
 * - **Prompt input, never a data dump (AAP 0.4.2).** Every list is capped by
 *   {@link ANALYSIS_INPUT_LIMITS}, every cap that bites is reported in
 *   `truncated.sections` and {@link AnalysisInputStats}, and the whole payload
 *   is held under `maxTotalBytes` by {@link applyByteBudget}, which trims or
 *   drops sections in the fixed order of {@link BYTE_BUDGET_STEPS} — never
 *   silently.
 * - **Built from already-redacted, persisted evidence (AAP 0.5.2).** Events are
 *   read only through the injected telemetry port, i.e. from the store, which
 *   the ingest path fills exclusively through the redactor. Provenance is that
 *   ingest ordering (the redactor's own documentation: provenance "is the ingest
 *   path's call ordering, not a field"), so the defence in depth applied here
 *   is structural: an event is admitted only when it is a persisted row of this
 *   very session and capture (see {@link isAdmissibleEvent}); anything else is
 *   excluded and counted, never emitted. Nothing is un-redacted or re-derived.
 * - **Satisfies the outbound guard by construction (AAP 0.5.2).** No request-key
 *   digest is ever emitted (a request group is carried by a positional `id`), the
 *   per-session request-key secret is never read, SQL appears only as the
 *   redacted parameterised statement, React values only as the upstream
 *   truncated previews, the selected element's URL goes through the telemetry
 *   URL redactor, and a code excerpt whose text matches a denied pattern is
 *   withheld and counted. The guard itself (`assertOutboundSafe`) runs in
 *   `pipeline/context-builder.ts`; nothing here relies on it to strip anything.
 * - **Upstream semantics only (AAP 0.2.5).** Ordering, duplicate windows,
 *   render-trigger classification, tier durations and metric definitions are
 *   owned by `@debuggen/telemetry` and are composed, never re-implemented. The
 *   section types below are narrower projections of those upstream shapes, not
 *   second definitions of them.
 * - **No hardcoded behaviour (AAP 0.5.4).** The developer's question is passed
 *   through verbatim and never inspected: no section is chosen, trimmed or
 *   ordered because of its wording.
 * - **Result-typed, injected, deterministic.** Store ports, correlator, code
 *   queries, logger and clock arrive by injection; nothing reads the
 *   environment, the filesystem, the network or a timer. Every expected failure
 *   is an `Err` carrying a {@link DebuggenError} whose message, hint and details
 *   hold only codes, counts, ids and project-relative paths. Identical inputs
 *   yield byte-identical JSON, and no caller array or repository row is mutated.
 *
 * The empty capture (AAP 0.5.5) is a normal outcome, reported as a typed
 * `CAPTURE_EMPTY` error with the developer-facing recovery message, so the
 * pipeline can skip analysis and return the session to `ready`.
 *
 * @example
 * ```ts
 * const summarizer = createAnalysisSummarizer({ telemetry, sessions, panels, correlator, logger });
 * const built = await summarizer.buildStageInput({ sessionId, captureId, question });
 * if (built.ok) {
 *   // built.value.input is the analyze prompt's structured input.
 * }
 * ```
 *
 * @module
 */

import {
  DebuggenError,
  clampNonNegative,
  err,
  isSafeRelativePath,
  noopLogger,
  ok,
  roundMs,
  type Logger,
  type Result,
  type SourceLocation,
} from '@debuggen/shared';
import {
  METRIC_IDS,
  aggregateQueries,
  aggregateRenders,
  aggregateRequests,
  aggregateStateTransitions,
  buildComponentTreeSnapshot,
  buildDependencyGraph,
  buildTimeline,
  computeCaptureSummary,
  computeMetrics,
  correlateEvents,
  findDeniedRules,
  flattenTrace,
  redactUrl,
  scrub,
  selfTimeOf,
  totalTimeOf,
  type AttributeValueType,
  type CaptureSummary,
  type ComponentTreeNode,
  type ComponentTreeSnapshot,
  type DependencyGraphData,
  type DependencyNodeKind,
  type ErrorSummary,
  type MetricId,
  type MetricValue,
  type QueryGroup,
  type RenderPhase,
  type RenderStat,
  type RenderTrigger,
  type RequestGroup,
  type RequestGroupedBy,
  type SpanSummary,
  type StateTransition,
  type TelemetryEvent,
  type TelemetryKind,
  type TelemetryStatus,
  type TelemetryTier,
  type TraceNode,
  type TraceTree,
  type TransitionSource,
} from '@debuggen/telemetry';
import {
  DATA_QUERY_MAX_LIMIT,
  type AnalysisResult,
  type CaptureRecord,
  type RelevantFile,
  type SelectedTarget,
  type SessionRecord,
} from '@debuggen/protocol';
import {
  CODE_QUERY_LIMITS,
  type CodeExcerpt,
  type CodeExcerptTarget,
  type CodeQueries,
  type CodeSymbolMatch,
  type ExcerptOptions,
} from '@debuggen/code-analysis';
import type { JsonObject } from '@debuggen/model-provider';
import type { TelemetryRepo } from '../store/telemetry-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { TraceCorrelator } from '../telemetry/correlate.js';

/* -------------------------------------------------------------------------------------------------
 * Limits
 * ---------------------------------------------------------------------------------------------- */

/**
 * The caps that bound the analysis input. A caller may lower any of them
 * through {@link AnalysisInputOptions.limits}; none can be raised, because the
 * caps are the privacy and cost boundary of the analyze prompt.
 *
 * Sizing rationale. `maxTotalBytes` (192 KiB, roughly 50k tokens of JSON) keeps
 * the whole payload, together with the prompt text and the injected output
 * schema, comfortably inside a single model request. The row caps are chosen so
 * a realistic capture — one interaction trace across three tiers, a few dozen
 * rendering components, a handful of request and query groups — fits under
 * that ceiling without the byte budget having to intervene:
 *
 * - traces: at most 5 traces and 200 span rows in total (80 per trace) — a
 *   correlated interaction rarely has more than a few dozen meaningful spans,
 *   and the longest spans are kept together with their ancestors when a trace
 *   is larger;
 * - renders/requests/queries: 20/15/15 aggregate rows with 5 occurrences each —
 *   the aggregates carry the counts, the occurrences carry citable event ids;
 * - excerpts: 8 excerpts of at most 4 000 bytes, matching the code-analysis
 *   excerpt ceiling, only for files the investigation stage already selected;
 * - `maxEventsConsidered` (25 000 events, five maximum-size store pages) bounds
 *   the memory and CPU spent aggregating a long, render-heavy capture.
 */
export type AnalysisInputLimits = {
  /** Persisted events read from the store and aggregated. */
  readonly maxEventsConsidered: number;
  /** Correlated traces included. */
  readonly maxTraces: number;
  /** Span rows per included trace. */
  readonly maxSpansPerTrace: number;
  /** Span rows across every included trace. */
  readonly maxTotalSpans: number;
  /** Rows the per-trace timeline (tier lanes) is built from. */
  readonly maxTimelineRows: number;
  /** Slowest-span rows. */
  readonly maxTopSpans: number;
  /** Per-component render rows. */
  readonly maxRenderRows: number;
  /** Render occurrences kept per component row. */
  readonly maxRenderOccurrencesPerRow: number;
  /** Changed-prop names kept per render row or occurrence. */
  readonly maxChangedProps: number;
  /** Component-tree nodes. */
  readonly maxComponentTreeNodes: number;
  /** Request groups. */
  readonly maxRequestGroups: number;
  /** Occurrences kept per request group. */
  readonly maxRequestOccurrencesPerGroup: number;
  /** Duplicate windows kept per request group. */
  readonly maxDuplicateWindowsPerGroup: number;
  /** Event ids kept per duplicate window. */
  readonly maxEventIdsPerWindow: number;
  /** Distinct initiators kept per request group. */
  readonly maxInitiatorsPerGroup: number;
  /** Characters kept per initiator (a captured, URL-masked stack). */
  readonly maxInitiatorLength: number;
  /** Query groups. */
  readonly maxQueryGroups: number;
  /** Occurrences kept per query group. */
  readonly maxQueryOccurrencesPerGroup: number;
  /** Callers kept per query group. */
  readonly maxCallersPerQuery: number;
  /** State-transition rows. */
  readonly maxStateTransitions: number;
  /** Dependency-graph nodes. */
  readonly maxGraphNodes: number;
  /** Dependency-graph edges. */
  readonly maxGraphEdges: number;
  /** Captured-error rows. */
  readonly maxErrors: number;
  /** Relevant-file rows. */
  readonly maxRelevantFiles: number;
  /** Characters per relevant-file reason. */
  readonly maxReasonLength: number;
  /** Code excerpts. */
  readonly maxExcerpts: number;
  /** UTF-8 bytes per code excerpt. */
  readonly maxExcerptBytes: number;
  /** Characters per SQL statement. */
  readonly maxStatementLength: number;
  /** Characters per span, component, caller or node name and similar labels. */
  readonly maxNameLength: number;
  /** Characters per (already redacted) URL. */
  readonly maxUrlLength: number;
  /** Deterministic fact candidates. */
  readonly maxFactCandidates: number;
  /** Evidence references per fact candidate. */
  readonly maxEvidencePerCandidate: number;
  /** Characters per fact-candidate statement. */
  readonly maxCandidateStatementLength: number;
  /** UTF-8 bytes of the serialised payload. */
  readonly maxTotalBytes: number;
};

/** The default, and maximum, analysis input caps. See {@link AnalysisInputLimits}. */
export const ANALYSIS_INPUT_LIMITS: AnalysisInputLimits = Object.freeze({
  maxEventsConsidered: 25_000,
  maxTraces: 5,
  maxSpansPerTrace: 80,
  maxTotalSpans: 200,
  maxTimelineRows: 2_000,
  maxTopSpans: 15,
  maxRenderRows: 20,
  maxRenderOccurrencesPerRow: 5,
  maxChangedProps: 16,
  maxComponentTreeNodes: 150,
  maxRequestGroups: 15,
  maxRequestOccurrencesPerGroup: 5,
  maxDuplicateWindowsPerGroup: 5,
  maxEventIdsPerWindow: 10,
  maxInitiatorsPerGroup: 4,
  maxInitiatorLength: 1_200,
  maxQueryGroups: 15,
  maxQueryOccurrencesPerGroup: 5,
  maxCallersPerQuery: 5,
  maxStateTransitions: 60,
  maxGraphNodes: 60,
  maxGraphEdges: 120,
  maxErrors: 20,
  maxRelevantFiles: 20,
  maxReasonLength: 400,
  maxExcerpts: 8,
  maxExcerptBytes: 4_000,
  maxStatementLength: 800,
  maxNameLength: 200,
  maxUrlLength: 1_000,
  maxFactCandidates: 40,
  maxEvidencePerCandidate: 10,
  maxCandidateStatementLength: 400,
  maxTotalBytes: 196_608,
});

/* -------------------------------------------------------------------------------------------------
 * Section names, truncation reasons and messages
 * ---------------------------------------------------------------------------------------------- */

/**
 * The sections of {@link AnalysisStageInput}, in payload order. The closed
 * vocabulary of `truncated.sections` and of {@link AnalysisInputStats}.
 */
export const ANALYSIS_SECTION_NAMES = Object.freeze([
  'capture',
  'metrics',
  'traces',
  'topSpans',
  'renders',
  'componentTree',
  'requests',
  'queries',
  'stateTransitions',
  'dependencyGraph',
  'errors',
  'relevantFiles',
  'excerpts',
  'factCandidates',
] as const);

/** One member of {@link ANALYSIS_SECTION_NAMES}. */
export type AnalysisSectionName = (typeof ANALYSIS_SECTION_NAMES)[number];

/**
 * Why sections were truncated: a row cap of {@link ANALYSIS_INPUT_LIMITS}
 * (`row-limits`), the byte budget (`byte-budget`), or both.
 */
export const ANALYSIS_TRUNCATION_REASONS = Object.freeze([
  'row-limits',
  'byte-budget',
  'row-limits+byte-budget',
] as const);

/** One member of {@link ANALYSIS_TRUNCATION_REASONS}. */
export type AnalysisTruncationReason = (typeof ANALYSIS_TRUNCATION_REASONS)[number];

/**
 * The developer-facing message for a capture that yielded no usable telemetry,
 * worded as AAP 0.5.5 specifies for the "capture yielded nothing" condition.
 */
export const EMPTY_CAPTURE_MESSAGE =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/** The recovery hint attached to {@link EMPTY_CAPTURE_MESSAGE}. */
export const EMPTY_CAPTURE_HINT =
  'Start a capture, reproduce the issue in the page, then stop the capture; analysis runs on what was recorded.';

/* -------------------------------------------------------------------------------------------------
 * Options and fact-candidate slot
 * ---------------------------------------------------------------------------------------------- */

/**
 * One evidence reference of a fact candidate: a persisted event id plus
 * display-only context, the structural shape of panel-schema's `EventRef`.
 */
export type AnalysisEvidenceRef = {
  /** Id of a persisted telemetry event of the capture. */
  readonly eventId: string;
  /** Display-only trace id. */
  readonly traceId?: string | undefined;
  /** Display-only span id. */
  readonly spanId?: string | undefined;
  /** Display-only event kind. */
  readonly kind?: string | undefined;
  /** Display-only label. */
  readonly label?: string | undefined;
};

/**
 * The structural shape of a deterministic fact candidate offered to the model
 * (AAP 0.7.1 Group 2: "deterministic fact candidates … that the model must
 * cite").
 *
 * Declared here, structurally, so this module never imports `./facts.js`: that
 * dependency runs one way only, and `facts.ts` asserts at compile time that its
 * own `FactCandidate` is assignable to this shape — the same one-directional
 * pattern `packages/panel-schema/src/normalize.ts` uses for `NormalizeAnalysis`.
 */
export type AnalysisFactCandidateRef = {
  /** Stable candidate id. */
  readonly id: string;
  /** Mechanism-named candidate kind. */
  readonly kind: string;
  /** Value-substituted statement built from measured values. */
  readonly statement: string;
  /** At least one reference to a persisted event. */
  readonly evidence: readonly AnalysisEvidenceRef[];
  /** Metric the candidate restates, when it restates one. */
  readonly metricId?: string | undefined;
  /** Measured value. */
  readonly value?: number | undefined;
  /** Unit of {@link AnalysisFactCandidateRef.value}. */
  readonly unit?: string | undefined;
};

/** Options of {@link AnalysisSummarizer.buildStageInput}. */
export type AnalysisInputOptions = {
  /** Lower any cap of {@link ANALYSIS_INPUT_LIMITS}; a higher value is clamped to the default. */
  readonly limits?: Partial<AnalysisInputLimits> | undefined;
  /** Traces to include after the focus trace, in the given order. */
  readonly traceIds?: readonly string[] | undefined;
  /** The trace to include first. */
  readonly focusTraceId?: string | undefined;
  /** Include the flattened component tree (default `true`). */
  readonly includeComponentTree?: boolean | undefined;
  /** Include the dependency graph (default `true`). */
  readonly includeDependencyGraph?: boolean | undefined;
  /** Deterministic fact candidates to carry, capped and projected. */
  readonly factCandidates?: readonly AnalysisFactCandidateRef[] | undefined;
  /**
   * Treat a capture without any browser `interaction` event as empty (AAP 0.5.5
   * "zero browser interactions for an interaction question"). The capture stage
   * decides this from the validated problem category, never from the wording
   * of the question. Default `false`.
   */
  readonly requireInteraction?: boolean | undefined;
  /** Cancels the assembly between store pages and sections. */
  readonly signal?: AbortSignal | undefined;
};

/* -------------------------------------------------------------------------------------------------
 * Payload sections
 * ---------------------------------------------------------------------------------------------- */

/**
 * One metric in `METRIC_IDS` order: the upstream `MetricValue`, picked rather
 * than redeclared, so an unavailable metric (`available: false`, AAP 0.6.6)
 * travels as such.
 */
export type AnalysisMetric = Readonly<
  Pick<MetricValue, 'id' | 'label' | 'unit' | 'available' | 'value' | 'note'>
>;

/** The selected element, projected and redacted for the prompt. */
export type AnalysisTargetFacet = {
  /** Lower-case tag name. */
  readonly tagName: string;
  /** CSS selector, pattern-scrubbed and bounded. */
  readonly selector: string;
  /** Visible text, pattern-scrubbed and bounded. */
  readonly text?: string;
  /** React component names from the element outward. */
  readonly componentChain: readonly string[];
  /** Page URL with query values masked by the telemetry URL redactor. */
  readonly url: string;
};

/** Capture identity, window and counts. */
export type AnalysisCaptureFacet = {
  /** Capture id. */
  readonly captureId: string;
  /** Instrumentation plan version the capture ran under. */
  readonly planVersion: number;
  /** Capture start (epoch ms). */
  readonly startedAt: number;
  /** Capture stop (epoch ms), when stopped. */
  readonly stoppedAt?: number;
  /** Earliest event start (epoch ms). */
  readonly startTime: number;
  /** Latest event end (epoch ms). */
  readonly endTime: number;
  /** Span of the captured events. */
  readonly durationMs: number;
  /** Events persisted for the capture. */
  readonly eventCount: number;
  /** Events aggregated into this input. */
  readonly eventsConsidered: number;
  /** Rows refused by the provenance check. */
  readonly eventsExcluded: number;
  /** Whether `maxEventsConsidered` cut the event set. */
  readonly eventsTruncated: boolean;
  /** Distinct traces. */
  readonly traceCount: number;
  /** The capture's primary (interaction) trace. */
  readonly primaryTraceId?: string;
  /** Distinct producers (page documents and server processes). */
  readonly producerCount: number;
  /** Events per tier. */
  readonly tierCounts: Readonly<Record<TelemetryTier, number>>;
  /** Persisted events per kind. */
  readonly kindCounts: Readonly<Record<TelemetryKind, number>>;
  /** Metrics that could not be observed in this capture. */
  readonly unavailableMetrics: readonly MetricId[];
};

/** One span of a correlated trace, in canonical (parent-before-child) order. */
export type AnalysisSpanRow = {
  /** Persisted event id (citable evidence). */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Parent span id; absent for a root. */
  readonly parentSpanId?: string;
  /** Depth in the trace tree (roots are 0). */
  readonly depth: number;
  /** Event kind. */
  readonly kind: TelemetryKind;
  /** Tier. */
  readonly tier: TelemetryTier;
  /** Span name, bounded. */
  readonly name: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Start relative to the trace start. */
  readonly offsetMs: number;
  /** Duration. */
  readonly durationMs: number;
  /** Duration not covered by child spans. */
  readonly selfTimeMs: number;
  /** Span status. */
  readonly status: TelemetryStatus;
  /** Resolved source location. */
  readonly source?: SourceLocation;
  /** Lineage marker (for example an async continuation). */
  readonly lineage?: string;
  /** The parent edge was one of several candidates; do not assert it. */
  readonly lineageAmbiguous?: true;
  /** The parent never arrived; attached to the trace root. */
  readonly orphaned?: true;
};

/** Time one tier occupies within a trace. */
export type AnalysisLaneRow = {
  /** Tier. */
  readonly tier: TelemetryTier;
  /** Rows in the lane. */
  readonly rowCount: number;
  /** Union of the lane's span intervals. */
  readonly occupancyMs: number;
};

/** One correlated trace. */
export type AnalysisTraceSection = {
  /** Trace id. */
  readonly traceId: string;
  /** Whether this is the capture's primary trace. */
  readonly primary: boolean;
  /** Trace start (epoch ms). */
  readonly startTime: number;
  /** Trace duration. */
  readonly totalDurationMs: number;
  /** Nodes in the whole tree. */
  readonly nodeCount: number;
  /** Nodes whose parent never arrived. */
  readonly orphanCount: number;
  /** Depth of the whole tree. */
  readonly maxDepth: number;
  /** Tiers present. */
  readonly tiers: readonly TelemetryTier[];
  /** Kinds present. */
  readonly kinds: readonly TelemetryKind[];
  /** Per-tier occupancy. */
  readonly lanes: readonly AnalysisLaneRow[];
  /** Span rows (longest spans and their ancestors when capped). */
  readonly spans: readonly AnalysisSpanRow[];
  /** Whether span rows were capped. */
  readonly spansTruncated: boolean;
};

/** One of the slowest spans of the capture. */
export type AnalysisTopSpanRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Event kind. */
  readonly kind: TelemetryKind;
  /** Tier. */
  readonly tier: TelemetryTier;
  /** Span name, bounded. */
  readonly name: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Duration. */
  readonly durationMs: number;
  /** Self time, when known. */
  readonly selfTimeMs?: number;
  /** Span status. */
  readonly status: TelemetryStatus;
  /** Resolved source location. */
  readonly source?: SourceLocation;
};

/** One changed prop name with how many renders it changed in. */
export type AnalysisChangedProp = {
  /** Prop name (never its value). */
  readonly name: string;
  /** Renders in which it changed. */
  readonly count: number;
};

/** One render of a component. */
export type AnalysisRenderOccurrenceRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Parent span id (the commit, or the attributed request under a continuation). */
  readonly parentSpanId?: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Render duration. */
  readonly durationMs: number;
  /** Mount or update. */
  readonly phase?: RenderPhase;
  /** Upstream trigger classification. */
  readonly trigger: RenderTrigger;
  /** Names of the props that changed. */
  readonly changedPropNames: readonly string[];
};

/** Render statistics of one component. */
export type AnalysisRenderRow = {
  /** Component display name. */
  readonly component: string;
  /** Renders. */
  readonly renderCount: number;
  /** Summed render time. */
  readonly totalDurationMs: number;
  /** Average render time. */
  readonly averageDurationMs: number;
  /** Longest render. */
  readonly maxDurationMs: number;
  /** First render start (epoch ms). */
  readonly firstStartTime: number;
  /** Last render start (epoch ms). */
  readonly lastStartTime: number;
  /** Renders per trigger. */
  readonly triggers: Readonly<Record<RenderTrigger, number>>;
  /** Renders with unchanged props, own state and consumed context. */
  readonly unchangedRenderCount: number;
  /** Renders whose trigger could not be determined. */
  readonly unknownTriggerCount: number;
  /** Renders per phase. */
  readonly phaseCounts: Readonly<Record<RenderPhase, number>>;
  /** Changed prop names with counts. */
  readonly changedProps: readonly AnalysisChangedProp[];
  /** Component declaration. */
  readonly source?: SourceLocation;
  /** Individual renders (citable evidence). */
  readonly occurrences: readonly AnalysisRenderOccurrenceRow[];
  /** Whether occurrences were capped. */
  readonly occurrencesTruncated: boolean;
};

/** One node of the flattened component tree. */
export type AnalysisComponentTreeRow = {
  /** Node id. */
  readonly id: string;
  /** Parent node id; absent for a root. */
  readonly parentId?: string;
  /** Depth (roots are 0). */
  readonly depth: number;
  /** Component display name. */
  readonly component: string;
  /** Renders of this node. */
  readonly renderCount: number;
  /** Summed render time. */
  readonly totalDurationMs: number;
  /** Trigger of the latest render. */
  readonly lastTrigger?: RenderTrigger;
  /** Event id of the latest render. */
  readonly lastRenderEventId?: string;
  /** Component declaration. */
  readonly source?: SourceLocation;
};

/** The component tree, flattened depth-first (kept shallow for the prompt). */
export type AnalysisComponentTreeSection = {
  /** How the snapshot was obtained. */
  readonly origin: ComponentTreeSnapshot['origin'];
  /** Whether it was reconstructed with reduced fidelity. */
  readonly degraded: boolean;
  /** Nodes in the whole snapshot. */
  readonly nodeCount: number;
  /** Depth of the whole snapshot. */
  readonly maxDepth: number;
  /** Whether nodes were capped (upstream or here). */
  readonly truncated: boolean;
  /** Nodes in depth-first order. */
  readonly nodes: readonly AnalysisComponentTreeRow[];
};

/** A run of identical requests inside the duplicate window. */
export type AnalysisDuplicateWindowRow = {
  /** Window start (epoch ms). */
  readonly startTime: number;
  /** Window end (epoch ms). */
  readonly endTime: number;
  /** Requests in the window. */
  readonly count: number;
  /** Requests beyond the first. */
  readonly redundantCount: number;
  /** Event ids of the requests (citable evidence). */
  readonly eventIds: readonly string[];
};

/** One request of a group. */
export type AnalysisRequestOccurrenceRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Parent span id. */
  readonly parentSpanId?: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Duration. */
  readonly durationMs: number;
  /** HTTP status, when settled. */
  readonly statusCode?: number;
  /** Span status. */
  readonly status: TelemetryStatus;
  /** The request had not settled when the capture stopped. */
  readonly pending?: true;
  /** Initiating call site. */
  readonly source?: SourceLocation;
};

/**
 * One request group. Carries a positional `id` and `groupedBy`, and
 * deliberately no request-key digest (AAP 0.5.2).
 */
export type AnalysisRequestRow = {
  /** Positional group id (`req:g:<ordinal>`), stable within the payload. */
  readonly id: string;
  /** Whether the group is keyed by request identity or method and path. */
  readonly groupedBy: RequestGroupedBy;
  /** HTTP method. */
  readonly method: string;
  /** Redacted URL. */
  readonly url: string;
  /** URL path. */
  readonly path: string;
  /** Requests. */
  readonly count: number;
  /** Redundant requests inside duplicate windows. */
  readonly duplicateCount: number;
  /** Whether any duplicate window exists. */
  readonly hasDuplicates: boolean;
  /** Duplicate windows. */
  readonly duplicateWindows: readonly AnalysisDuplicateWindowRow[];
  /** First start (epoch ms). */
  readonly firstStartTime: number;
  /** Last start (epoch ms). */
  readonly lastStartTime: number;
  /** Summed duration. */
  readonly totalDurationMs: number;
  /** Average duration. */
  readonly averageDurationMs: number;
  /** Longest request. */
  readonly maxDurationMs: number;
  /** Shortest request. */
  readonly minDurationMs: number;
  /** Distinct HTTP statuses. */
  readonly statusCodes: readonly number[];
  /** Failed requests. */
  readonly errorCount: number;
  /** Unsettled requests. */
  readonly pendingCount?: number;
  /** Distinct initiators (URL-masked stacks), bounded. */
  readonly initiators: readonly string[];
  /** Bytes over the wire, when observable. */
  readonly transferredBytes?: number;
  /** Individual requests (citable evidence). */
  readonly occurrences: readonly AnalysisRequestOccurrenceRow[];
  /** Whether occurrences were capped. */
  readonly occurrencesTruncated: boolean;
};

/** A function or span that issued a query. */
export type AnalysisQueryCallerRow = {
  /** Caller name. */
  readonly name: string;
  /** Caller kind. */
  readonly kind?: TelemetryKind;
  /** Executions from this caller. */
  readonly executionCount: number;
  /** Summed duration from this caller. */
  readonly totalDurationMs: number;
  /** Caller location. */
  readonly source?: SourceLocation;
};

/** One execution of a query. */
export type AnalysisQueryOccurrenceRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Parent span id. */
  readonly parentSpanId?: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Duration. */
  readonly durationMs: number;
  /** Rows returned (count only, never contents). */
  readonly rowCount?: number;
  /** Span status. */
  readonly status: TelemetryStatus;
  /** Caller span id. */
  readonly callerSpanId?: string;
  /** Caller name. */
  readonly callerName?: string;
  /** Call site. */
  readonly source?: SourceLocation;
};

/** One query group, by normalised statement. */
export type AnalysisQueryRow = {
  /** Stable group id. */
  readonly id: string;
  /** Redacted, parameterised statement, bounded. */
  readonly statement: string;
  /** Database system. */
  readonly system?: string;
  /** Executions. */
  readonly executionCount: number;
  /** Summed duration. */
  readonly totalDurationMs: number;
  /** Average duration. */
  readonly averageDurationMs: number;
  /** Shortest execution. */
  readonly minDurationMs: number;
  /** Longest execution. */
  readonly maxDurationMs: number;
  /** First start (epoch ms). */
  readonly firstStartTime: number;
  /** Last start (epoch ms). */
  readonly lastStartTime: number;
  /** Summed row count, when reported. */
  readonly totalRowCount?: number;
  /** Failed executions. */
  readonly errorCount: number;
  /** Callers, bounded. */
  readonly callers: readonly AnalysisQueryCallerRow[];
  /** Individual executions (citable evidence). */
  readonly occurrences: readonly AnalysisQueryOccurrenceRow[];
  /** Whether occurrences were capped. */
  readonly occurrencesTruncated: boolean;
};

/** One observed React state transition (previews only, never full values). */
export type AnalysisStateRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Component display name. */
  readonly component?: string;
  /** Hook index. */
  readonly hookIndex?: number;
  /** Hook label. */
  readonly hookLabel?: string;
  /** Upstream-truncated, redacted preview of the previous value. */
  readonly previousValue?: string;
  /** Upstream-truncated, redacted preview of the next value. */
  readonly nextValue?: string;
  /** Value type. */
  readonly valueType?: AttributeValueType;
  /** Whether the value changed. */
  readonly changed: boolean;
  /** Event id of the triggering event. */
  readonly triggerEventId?: string;
  /** Name of the triggering event. */
  readonly triggerName?: string;
  /** Kind of the triggering event. */
  readonly triggerKind?: TelemetryKind;
  /** Whether the transition was own state or a consumed context. */
  readonly transitionSource?: TransitionSource;
  /** Hook declaration. */
  readonly source?: SourceLocation;
};

/** One participant of the dependency graph. */
export type AnalysisGraphNodeRow = {
  /** Node id. */
  readonly id: string;
  /** Participant kind. */
  readonly kind: DependencyNodeKind;
  /** Label, bounded. */
  readonly label: string;
  /** Tier. */
  readonly tier?: TelemetryTier;
  /** Spans aggregated into the node. */
  readonly count: number;
  /** Summed duration. */
  readonly totalDurationMs: number;
  /** Longest span. */
  readonly maxDurationMs: number;
  /** Layout layer. */
  readonly layer?: number;
  /** A representative event id. */
  readonly eventId?: string;
  /** A representative trace id. */
  readonly traceId?: string;
  /** Location. */
  readonly source?: SourceLocation;
};

/** One edge of the dependency graph. */
export type AnalysisGraphEdgeRow = {
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
  /** Calls along the edge. */
  readonly count: number;
  /** Summed duration. */
  readonly totalDurationMs: number;
  /** Calls attributed by inference. */
  readonly inferredCount?: number;
  /** Calls with an ambiguous parent. */
  readonly ambiguousCount?: number;
};

/** The dependency graph (UI event → function → API → service → database). */
export type AnalysisDependencyGraphSection = {
  /** Nodes. */
  readonly nodes: readonly AnalysisGraphNodeRow[];
  /** Edges. */
  readonly edges: readonly AnalysisGraphEdgeRow[];
  /** Layout layers. */
  readonly layerCount: number;
  /** Whether nodes or edges were capped. */
  readonly truncated: boolean;
};

/** One captured error. */
export type AnalysisErrorRow = {
  /** Persisted event id. */
  readonly eventId: string;
  /** Span id. */
  readonly spanId: string;
  /** Trace id. */
  readonly traceId: string;
  /** Error kind. */
  readonly kind: TelemetryKind;
  /** Tier. */
  readonly tier: TelemetryTier;
  /** Error name, bounded. */
  readonly name: string;
  /** Start (epoch ms). */
  readonly startTime: number;
  /** Location. */
  readonly source?: SourceLocation;
};

/** A file the investigation stage selected. */
export type AnalysisRelevantFile = {
  /** Project-relative POSIX path. */
  readonly file: string;
  /** Symbol of interest. */
  readonly symbol?: string;
  /** Why it was selected. */
  readonly reason: string;
  /** Relevance score in `[0, 1]`. */
  readonly score: number;
};

/** A bounded source excerpt of a relevant file. */
export type AnalysisExcerpt = {
  /** Project-relative POSIX path. */
  readonly file: string;
  /** Symbol the excerpt is centred on. */
  readonly symbol?: string;
  /** First line (1-based). */
  readonly startLine: number;
  /** Last line (1-based, inclusive). */
  readonly endLine: number;
  /** Source text. */
  readonly text: string;
  /** Whether the excerpt was cut. */
  readonly truncated: boolean;
};

/** Which sections were capped or trimmed, and why. */
export type AnalysisTruncation = {
  /** Sections capped by a row limit or trimmed by the byte budget, in payload order. */
  readonly sections: readonly AnalysisSectionName[];
  /** Why; absent when nothing was truncated. */
  readonly reason?: AnalysisTruncationReason;
};

/**
 * The analyze prompt's structured input (AAP 0.4.2 Analysis row). Plain JSON:
 * no class instances, no `Map`/`Set`, no `undefined` values, no cycles.
 */
export type AnalysisStageInput = {
  /** Session id. */
  readonly sessionId: string;
  /** Capture id. */
  readonly captureId: string;
  /** The developer's question, verbatim. */
  readonly question: string;
  /** The follow-up question, verbatim, on the follow-up path. */
  readonly followUpQuestion?: string;
  /** The selected element, redacted. */
  readonly target?: AnalysisTargetFacet;
  /** Capture identity, window and counts. */
  readonly capture: AnalysisCaptureFacet;
  /** Every metric, in `METRIC_IDS` order. */
  readonly metrics: readonly AnalysisMetric[];
  /** Correlated traces. */
  readonly traces: readonly AnalysisTraceSection[];
  /** Slowest spans. */
  readonly topSpans: readonly AnalysisTopSpanRow[];
  /** Per-component render statistics. */
  readonly renders: readonly AnalysisRenderRow[];
  /** Flattened component tree. */
  readonly componentTree?: AnalysisComponentTreeSection;
  /** Request groups, duplicates first. */
  readonly requests: readonly AnalysisRequestRow[];
  /** Query groups. */
  readonly queries: readonly AnalysisQueryRow[];
  /** State transitions. */
  readonly stateTransitions: readonly AnalysisStateRow[];
  /** Dependency graph. */
  readonly dependencyGraph?: AnalysisDependencyGraphSection;
  /** Captured errors. */
  readonly errors: readonly AnalysisErrorRow[];
  /** Files the investigation selected. */
  readonly relevantFiles: readonly AnalysisRelevantFile[];
  /** Bounded excerpts of those files. */
  readonly excerpts: readonly AnalysisExcerpt[];
  /** Deterministic fact candidates the model must cite. */
  readonly factCandidates: readonly AnalysisFactCandidateRef[];
  /** Truncation report. */
  readonly truncated: AnalysisTruncation;
};

/** Assembly statistics, for logging and progress (never part of the prompt). */
export type AnalysisInputStats = {
  /** Events aggregated. */
  readonly eventsConsidered: number;
  /** Rows refused by the provenance check. */
  readonly eventsExcluded: number;
  /** Traces included. */
  readonly tracesIncluded: number;
  /** Span rows included. */
  readonly spansIncluded: number;
  /** Excerpts withheld because their text matched a denied pattern. */
  readonly excerptsWithheld: number;
  /** UTF-8 bytes of the serialised input. */
  readonly approxBytes: number;
  /** Sections capped by a row limit. */
  readonly sectionsTruncated: readonly AnalysisSectionName[];
  /** Sections trimmed or dropped by the byte budget. */
  readonly droppedForBudget: readonly AnalysisSectionName[];
};

/** The bounded follow-up context: counters and ids only, never prose. */
export type AnalysisFollowUpContext = {
  /** Id of the latest stored analysis. */
  readonly previousAnalysisId?: string;
  /** Observed facts in it. */
  readonly previousObserved: number;
  /** Likely causes in it. */
  readonly previousLikelyCauses: number;
  /** Id of the latest stored panel. */
  readonly previousPanelId?: string;
};

/* -------------------------------------------------------------------------------------------------
 * Ports and dependencies
 * ---------------------------------------------------------------------------------------------- */

/** One page request against the telemetry store: a capture, in start order. */
export type AnalysisTelemetryPageRequest = {
  /** Session id. */
  readonly sessionId: string;
  /** Capture id. */
  readonly captureId: string;
  /** Page order. */
  readonly sort: 'start_asc';
  /** Page size, at most the store's maximum. */
  readonly limit: number;
  /** Rows to skip. */
  readonly offset: number;
};

/** One page of persisted events. */
export type AnalysisTelemetryPage = {
  /** Persisted events. */
  readonly rows: readonly TelemetryEvent[];
  /** Rows matching the request. */
  readonly total: number;
  /** Offset of the next page, when there is one. */
  readonly nextOffset?: number | undefined;
  /** Stored rows on this page that no longer validated and were skipped by the store. */
  readonly skipped?: number | undefined;
};

/** The telemetry store methods this module reads (satisfied by `TelemetryRepo`). */
export interface TelemetryQueryPort {
  /** One page of a capture's persisted events. */
  query(filter: AnalysisTelemetryPageRequest): Result<AnalysisTelemetryPage, DebuggenError>;
  /** Persisted events per kind. */
  countByKind(
    sessionId: string,
    captureId?: string,
  ): Result<Readonly<Record<TelemetryKind, number>>, DebuggenError>;
}

/** A stored capture and its owning session. */
export type AnalysisStoredCapture = {
  /** Owning session. */
  readonly sessionId: string;
  /** The capture record. */
  readonly capture: CaptureRecord;
};

/** The session store methods this module reads (satisfied by `SessionsRepo`). */
export interface CaptureLookupPort {
  /** A session record. */
  get(id: string): Result<SessionRecord | undefined, DebuggenError>;
  /** A capture by id; the caller checks the owning session. */
  getCapture(captureId: string): Result<AnalysisStoredCapture | undefined, DebuggenError>;
}

/** The analysis and panel history this module reads (satisfied by `PanelsRepo`). */
export interface AnalysisHistoryPort {
  /** The latest stored analysis of a session. */
  getLatestAnalysis(
    sessionId: string,
  ): Result<Pick<AnalysisResult, 'id' | 'observed' | 'likelyCauses'> | undefined, DebuggenError>;
  /** The latest stored panel of a session. */
  getLatestPanel(sessionId: string): Result<{ readonly id: string } | undefined, DebuggenError>;
}

/** The trace-tree port (satisfied by the service's `TraceCorrelator`). */
export interface TraceTreePort {
  /** One correlated trace, built from the capture's persisted events. */
  getTrace(
    sessionId: string,
    traceId: string,
    captureId?: string,
  ): Promise<Result<TraceTree | undefined, DebuggenError>>;
}

/** The bounded code-excerpt port (satisfied by `@debuggen/code-analysis`'s `CodeQueries`). */
export interface CodeExcerptPort {
  /** The declaration of `symbol` in `file`. */
  findSymbol(file: string, symbol: string): Pick<CodeSymbolMatch, 'nodeId'> | undefined;
  /** A bounded excerpt; never an environment file or a path outside the project. */
  excerpt(target: CodeExcerptTarget, options?: ExcerptOptions): CodeExcerpt | undefined;
}

/** Injected dependencies of {@link createAnalysisSummarizer}. */
export type AnalysisSummarizerDeps = {
  /** Persisted telemetry. */
  readonly telemetry: TelemetryQueryPort;
  /** Sessions and captures. */
  readonly sessions: CaptureLookupPort;
  /** Analysis and panel history; the session record is the fallback. */
  readonly panels?: AnalysisHistoryPort | undefined;
  /** Complete trace trees; correlated locally from the loaded events when absent. */
  readonly correlator?: TraceTreePort | undefined;
  /** Default code queries; a request may supply its project's own. */
  readonly codeQueries?: CodeExcerptPort | undefined;
  /** Logger (a child bound to the subsystem). */
  readonly logger?: Logger | undefined;
  /** Clock, used for timing logs only (never for payload content). */
  readonly now?: (() => number) | undefined;
};

/** Input of {@link AnalysisSummarizer.buildStageInput}. */
export type AnalysisStageInputRequest = {
  /** Session id. */
  readonly sessionId: string;
  /** Capture id. */
  readonly captureId: string;
  /** The developer's question, passed through verbatim. */
  readonly question: string;
  /** The follow-up question, passed through verbatim. */
  readonly followUpQuestion?: string | undefined;
  /** Code queries of the session's project (overrides the injected default). */
  readonly codeQueries?: CodeExcerptPort | undefined;
  /** Assembly options. */
  readonly options?: AnalysisInputOptions | undefined;
};

/** A built analysis input with its statistics. */
export type AnalysisStageInputBuild = {
  /** The analyze prompt's structured input. */
  readonly input: AnalysisStageInput;
  /** Assembly statistics. */
  readonly stats: AnalysisInputStats;
};

/** The analysis-input subsystem. */
export interface AnalysisSummarizer {
  /**
   * The capture's summary: the stored `CaptureRecord.summary` when present and
   * matching, otherwise recomputed with `computeCaptureSummary` over the
   * capture's admitted persisted events. This is the summary
   * `panels/validate.ts` passes to `validateAgainstCapture`.
   */
  loadCaptureSummary(
    sessionId: string,
    captureId: string,
  ): Promise<Result<CaptureSummary, DebuggenError>>;
  /** Build the analyze prompt's structured input. */
  buildStageInput(
    request: AnalysisStageInputRequest,
  ): Promise<Result<AnalysisStageInputBuild, DebuggenError>>;
  /** Counters and ids of the previous analysis and panel, for the follow-up prompt. */
  buildFollowUpContext(sessionId: string): Promise<Result<AnalysisFollowUpContext, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract assertions
 * ---------------------------------------------------------------------------------------------- */

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

/** `TelemetryRepo` still satisfies {@link TelemetryQueryPort}. */
export type TelemetryRepoSatisfiesQueryPort = AssertTrue<
  TelemetryRepo extends TelemetryQueryPort ? true : false
>;

/** `SessionsRepo` still satisfies {@link CaptureLookupPort}. */
export type SessionsRepoSatisfiesCaptureLookupPort = AssertTrue<
  SessionsRepo extends CaptureLookupPort ? true : false
>;

/** `PanelsRepo` still satisfies {@link AnalysisHistoryPort}. */
export type PanelsRepoSatisfiesAnalysisHistoryPort = AssertTrue<
  PanelsRepo extends AnalysisHistoryPort ? true : false
>;

/** The service's `TraceCorrelator` still satisfies {@link TraceTreePort}. */
export type TraceCorrelatorSatisfiesTraceTreePort = AssertTrue<
  TraceCorrelator extends TraceTreePort ? true : false
>;

/** `CodeQueries` still satisfies {@link CodeExcerptPort}. */
export type CodeQueriesSatisfyCodeExcerptPort = AssertTrue<
  CodeQueries extends CodeExcerptPort ? true : false
>;

/** {@link AnalysisStageInput} is assignable to `ModelRequest.input`'s `JsonObject`. */
export type AnalysisStageInputIsJson = AssertTrue<
  AnalysisStageInput extends JsonObject ? true : false
>;

/** A stored `RelevantFile` projects onto {@link AnalysisRelevantFile}. */
export type RelevantFileProjects = AssertTrue<
  Pick<RelevantFile, 'file' | 'reason' | 'score'> extends Pick<
    AnalysisRelevantFile,
    'file' | 'reason' | 'score'
  >
    ? true
    : false
>;

/* -------------------------------------------------------------------------------------------------
 * Internal value helpers
 * ---------------------------------------------------------------------------------------------- */

/** The ellipsis appended to text cut by {@link capText}. */
const ELLIPSIS = '\u2026';

/** A finite, non-negative duration rounded to the canonical three decimals. */
function durationOf(value: number): number {
  const clamped = clampNonNegative(value);
  return Number.isFinite(clamped) ? roundMs(clamped) : 0;
}

/** A finite epoch timestamp rounded to the canonical three decimals. */
function timeOf(value: number): number {
  return Number.isFinite(value) ? roundMs(clampNonNegative(value)) : 0;
}

/** A finite, non-negative whole count. */
function countOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * `text` cut to at most `max` characters, ending in an ellipsis when cut. Never
 * splits a surrogate pair, so the result always serialises to well-formed JSON.
 */
function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return max === 1 ? ELLIPSIS : '';
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Locale-independent string order. */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** A fresh copy of a source location carrying only its defined fields. */
function copySource(source: SourceLocation): SourceLocation {
  return {
    file: source.file,
    line: source.line,
    column: source.column,
    ...(source.symbol === undefined ? {} : { symbol: source.symbol }),
    ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
    resolvedBy: source.resolvedBy,
    confidence: source.confidence,
  };
}

/** `{ source }` when a location is present, `{}` otherwise. */
function withSource(source: SourceLocation | undefined): { readonly source?: SourceLocation } {
  return source === undefined ? {} : { source: copySource(source) };
}

/** Whether a string is a key of {@link ANALYSIS_INPUT_LIMITS}. */
function isLimitKey(key: string): key is keyof AnalysisInputLimits {
  return Object.hasOwn(ANALYSIS_INPUT_LIMITS, key);
}

/**
 * Whether the caller's signal has been aborted. A function rather than an
 * inline property read so each check observes the signal's current state.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** The error reported when the caller's signal cancels assembly. */
function abortedError(): DebuggenError {
  return new DebuggenError('INTERNAL', 'Analysis input assembly was cancelled.', {
    details: { reason: 'aborted' },
  });
}

/** The typed empty-capture outcome of AAP 0.5.5. */
function emptyCaptureError(
  sessionId: string,
  captureId: string,
  reason: 'no-events' | 'no-admissible-events' | 'no-interaction',
  eventsExcluded: number,
): DebuggenError {
  return new DebuggenError('CAPTURE_EMPTY', EMPTY_CAPTURE_MESSAGE, {
    hint: EMPTY_CAPTURE_HINT,
    details: { sessionId, captureId, reason, eventsExcluded },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Limits and provenance
 * ---------------------------------------------------------------------------------------------- */

/**
 * The effective limits: {@link ANALYSIS_INPUT_LIMITS} lowered by `overrides`.
 * A value above the default is clamped to the default; a value that is not a
 * non-negative integer is a `CONFIG_INVALID` error naming the limit.
 */
export function resolveAnalysisLimits(
  overrides?: Partial<AnalysisInputLimits>,
): Result<AnalysisInputLimits, DebuggenError> {
  if (overrides === undefined) {
    return ok(ANALYSIS_INPUT_LIMITS);
  }
  const resolved: { -readonly [K in keyof AnalysisInputLimits]: number } = {
    ...ANALYSIS_INPUT_LIMITS,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!isLimitKey(key)) {
      return err(
        new DebuggenError('CONFIG_INVALID', 'Unknown analysis input limit.', {
          details: { limit: capText(key, ANALYSIS_INPUT_LIMITS.maxNameLength) },
        }),
      );
    }
    if (value === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          `Analysis input limit ${key} must be a non-negative integer.`,
          { details: { limit: key } },
        ),
      );
    }
    resolved[key] = Math.min(ANALYSIS_INPUT_LIMITS[key], value);
  }
  return ok(Object.freeze(resolved));
}

/**
 * The provenance check every event passes before any part of it reaches the
 * payload (AAP 0.5.2, defence in depth).
 *
 * The persisted schema carries no boolean "was redacted" flag: its optional
 * `redacted` field lists the attribute paths the redactor replaced and is absent
 * when nothing was replaced, and provenance itself is the ingest path's call
 * ordering (`packages/telemetry/src/redaction/redactor.ts`). What can be checked
 * is that the row is what that ordering produces — a persisted event of *this*
 * session and capture with a store-assigned `ingestSeq` and a well-formed
 * `redacted` list. A row failing any of these did not come through ingest for
 * this capture and is excluded and counted, never emitted.
 */
export function isAdmissibleEvent(
  event: TelemetryEvent,
  sessionId: string,
  captureId: string,
): boolean {
  return (
    event.sessionId === sessionId &&
    event.captureId === captureId &&
    Number.isSafeInteger(event.ingestSeq) &&
    event.ingestSeq > 0 &&
    (event.redacted === undefined || Array.isArray(event.redacted))
  );
}

/* -------------------------------------------------------------------------------------------------
 * Traces
 * ---------------------------------------------------------------------------------------------- */

/** A trace the selection may choose, with its duration. */
export type AnalysisTraceCandidate = {
  /** Trace id. */
  readonly traceId: string;
  /** Trace duration; non-finite values rank as zero. */
  readonly totalDurationMs: number;
};

/** What {@link selectTraces} prefers. */
export type AnalysisTraceSelection = {
  /** At most this many traces. */
  readonly maxTraces: number;
  /** Chosen first. */
  readonly focusTraceId?: string | undefined;
  /** Chosen next, in order. */
  readonly traceIds?: readonly string[] | undefined;
  /** Chosen next: the capture's primary trace. */
  readonly primaryTraceId?: string | undefined;
};

/**
 * The traces to include, deterministically: the focus trace, then the requested
 * traces in order, then the primary trace, then every remaining candidate by
 * descending duration with the trace id as the tie-break. Only candidates are
 * chosen (an id the capture does not hold is skipped), each at most once, and
 * never more than `maxTraces`.
 */
export function selectTraces(
  candidates: readonly AnalysisTraceCandidate[],
  selection: AnalysisTraceSelection,
): string[] {
  const durations = new Map<string, number>();
  for (const candidate of candidates) {
    if (!durations.has(candidate.traceId)) {
      durations.set(
        candidate.traceId,
        Number.isFinite(candidate.totalDurationMs) ? candidate.totalDurationMs : 0,
      );
    }
  }
  const max = Math.max(0, Math.floor(selection.maxTraces));
  const chosen: string[] = [];
  const take = (traceId: string): void => {
    if (chosen.length < max && durations.has(traceId) && !chosen.includes(traceId)) {
      chosen.push(traceId);
    }
  };
  if (selection.focusTraceId !== undefined) {
    take(selection.focusTraceId);
  }
  for (const traceId of selection.traceIds ?? []) {
    take(traceId);
  }
  if (selection.primaryTraceId !== undefined) {
    take(selection.primaryTraceId);
  }
  const remaining = [...durations.entries()]
    .filter(([traceId]) => !chosen.includes(traceId))
    .sort(([leftId, left], [rightId, right]) =>
      right !== left ? right - left : compareStrings(leftId, rightId),
    );
  for (const [traceId] of remaining) {
    take(traceId);
  }
  return chosen;
}

/** The label caps {@link toSpanRow} applies. */
export type AnalysisSpanRowLimits = Pick<AnalysisInputLimits, 'maxNameLength'>;

/**
 * One trace node as a prompt row: depth, parent, timing relative to the trace
 * start, self time and the lineage and orphan markers, so the analysis can say
 * an edge was ambiguous instead of asserting a parent. Timing comes from the
 * upstream `totalTimeOf`/`selfTimeOf`.
 */
export function toSpanRow(
  node: TraceNode,
  traceStartTime: number,
  limits: AnalysisSpanRowLimits = ANALYSIS_INPUT_LIMITS,
): AnalysisSpanRow {
  const event = node.event;
  return {
    eventId: event.id,
    spanId: event.spanId,
    ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
    depth: node.depth,
    kind: event.kind,
    tier: event.tier,
    name: capText(event.name, limits.maxNameLength),
    startTime: timeOf(event.startTime),
    offsetMs: durationOf(event.startTime - traceStartTime),
    durationMs: durationOf(totalTimeOf(node)),
    selfTimeMs: durationOf(selfTimeOf(node)),
    status: event.status,
    ...withSource(event.source),
    ...(node.lineage === undefined ? {} : { lineage: node.lineage.value }),
    ...(node.lineage?.ambiguous === true ? { lineageAmbiguous: true as const } : {}),
    ...(node.orphaned ? { orphaned: true as const } : {}),
  };
}

/**
 * At most `max` rows: the longest spans together with their ancestors, emitted
 * in the rows' own (canonical) order so every kept row's parent precedes it.
 * A span is kept only when its whole ancestor chain fits.
 */
function keepLongestRows(rows: readonly AnalysisSpanRow[], max: number): AnalysisSpanRow[] {
  if (rows.length <= max) {
    return [...rows];
  }
  if (max <= 0) {
    return [];
  }
  const positionBySpanId = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!positionBySpanId.has(row.spanId)) {
      positionBySpanId.set(row.spanId, index);
    }
  });
  const ranked = rows
    .map((row, index) => ({ index, durationMs: row.durationMs }))
    .sort((left, right) =>
      right.durationMs !== left.durationMs
        ? right.durationMs - left.durationMs
        : left.index - right.index,
    );
  const kept = new Set<number>();
  for (const { index } of ranked) {
    if (kept.size >= max) {
      break;
    }
    const chain: number[] = [];
    let cursor: number | undefined = index;
    while (cursor !== undefined && !kept.has(cursor) && !chain.includes(cursor)) {
      chain.push(cursor);
      const parentSpanId: string | undefined = rows[cursor]?.parentSpanId;
      cursor = parentSpanId === undefined ? undefined : positionBySpanId.get(parentSpanId);
    }
    if (kept.size + chain.length <= max) {
      for (const position of chain) {
        kept.add(position);
      }
    }
  }
  return rows.filter((_row, index) => kept.has(index));
}

/** Options of {@link flattenTraceForPrompt}. */
export type FlattenTraceOptions = Pick<AnalysisInputLimits, 'maxNameLength' | 'maxTimelineRows'> & {
  /** Span rows kept. */
  readonly maxSpans: number;
  /** Whether this is the capture's primary trace. */
  readonly primary?: boolean | undefined;
  /** Provenance predicate; a refused node is excluded and counted. */
  readonly admit?: ((event: TelemetryEvent) => boolean) | undefined;
};

/** A flattened trace and the number of nodes the provenance check refused. */
export type FlattenedTrace = {
  /** The trace section. */
  readonly section: AnalysisTraceSection;
  /** Nodes refused by `admit`. */
  readonly excluded: number;
};

/**
 * A correlated trace as ordered span rows plus per-tier lane occupancy.
 *
 * Order is the trace's canonical depth-first order (`flattenTrace`), parents
 * before children. When the provenance check refuses a node, the tree is
 * re-correlated from the admitted events alone (`correlateEvents`), so neither
 * the rows nor the lane occupancy (`buildTimeline`) carry anything of the
 * refused event. When a trace has more spans than `maxSpans`, the longest spans
 * and their ancestors are kept.
 */
export function flattenTraceForPrompt(
  tree: TraceTree,
  options: FlattenTraceOptions,
): FlattenedTrace {
  const admit = options.admit;
  let effective: TraceTree | undefined = tree;
  let excluded = 0;
  if (admit !== undefined) {
    const nodes = flattenTrace(tree);
    const admitted = nodes.filter((node) => admit(node.event)).map((node) => node.event);
    excluded = nodes.length - admitted.length;
    if (excluded > 0) {
      effective = correlateEvents(admitted).byTraceId.get(tree.traceId);
    }
  }
  if (effective === undefined) {
    return {
      excluded,
      section: {
        traceId: tree.traceId,
        primary: options.primary === true,
        startTime: timeOf(tree.startTime),
        totalDurationMs: 0,
        nodeCount: 0,
        orphanCount: 0,
        maxDepth: 0,
        tiers: [],
        kinds: [],
        lanes: [],
        spans: [],
        spansTruncated: excluded > 0,
      },
    };
  }
  const traceStart = effective.startTime;
  const rows = flattenTrace(effective).map((node) => toSpanRow(node, traceStart, options));
  const spans = keepLongestRows(rows, options.maxSpans);
  const timeline = buildTimeline(effective, { maxRows: options.maxTimelineRows });
  return {
    excluded,
    section: {
      traceId: effective.traceId,
      primary: options.primary === true,
      startTime: timeOf(effective.startTime),
      totalDurationMs: durationOf(effective.totalDuration),
      nodeCount: effective.nodeCount,
      orphanCount: effective.orphanCount,
      maxDepth: effective.maxDepth,
      tiers: [...effective.tiers],
      kinds: [...effective.kinds],
      lanes: timeline.lanes.map((lane) => ({
        tier: lane.tier,
        rowCount: lane.rowCount,
        occupancyMs: durationOf(lane.occupancyMs),
      })),
      spans,
      spansTruncated: spans.length < rows.length || effective.truncated,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Aggregate projections
 * ---------------------------------------------------------------------------------------------- */

/** The caps {@link toRenderRow} applies. */
export type AnalysisRenderRowLimits = Pick<
  AnalysisInputLimits,
  'maxRenderOccurrencesPerRow' | 'maxChangedProps' | 'maxNameLength'
>;

/**
 * One upstream `RenderStat` as a prompt row. Changed props travel as names and
 * counts only (never values), and the occurrences — the citable render events —
 * are capped.
 */
export function toRenderRow(
  stat: RenderStat,
  limits: AnalysisRenderRowLimits = ANALYSIS_INPUT_LIMITS,
): AnalysisRenderRow {
  const occurrences = stat.occurrences.slice(0, limits.maxRenderOccurrencesPerRow);
  return {
    component: capText(stat.component, limits.maxNameLength),
    renderCount: countOf(stat.renderCount),
    totalDurationMs: durationOf(stat.totalDurationMs),
    averageDurationMs: durationOf(stat.averageDurationMs),
    maxDurationMs: durationOf(stat.maxDurationMs),
    firstStartTime: timeOf(stat.firstStartTime),
    lastStartTime: timeOf(stat.lastStartTime),
    triggers: { ...stat.triggers },
    unchangedRenderCount: countOf(stat.unchangedRenderCount),
    unknownTriggerCount: countOf(stat.unknownTriggerCount),
    phaseCounts: { ...stat.phaseCounts },
    changedProps: stat.changedPropKeys.slice(0, limits.maxChangedProps).map((name) => ({
      name: capText(name, limits.maxNameLength),
      count: countOf(stat.changedPropCounts[name] ?? 0),
    })),
    ...withSource(stat.source),
    occurrences: occurrences.map((occurrence) => ({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
      ...(occurrence.parentSpanId === undefined ? {} : { parentSpanId: occurrence.parentSpanId }),
      startTime: timeOf(occurrence.startTime),
      durationMs: durationOf(occurrence.durationMs),
      ...(occurrence.phase === undefined ? {} : { phase: occurrence.phase }),
      trigger: occurrence.trigger,
      changedPropNames: occurrence.changedPropKeys
        .slice(0, limits.maxChangedProps)
        .map((name) => capText(name, limits.maxNameLength)),
    })),
    occurrencesTruncated: stat.occurrencesTruncated || occurrences.length < stat.occurrences.length,
  };
}

/** The caps {@link toRequestRow} applies. */
export type AnalysisRequestRowLimits = Pick<
  AnalysisInputLimits,
  | 'maxRequestOccurrencesPerGroup'
  | 'maxDuplicateWindowsPerGroup'
  | 'maxEventIdsPerWindow'
  | 'maxInitiatorsPerGroup'
  | 'maxInitiatorLength'
  | 'maxUrlLength'
  | 'maxNameLength'
>;

/** The prefix of the positional request-group ids {@link toRequestRow} emits. */
export const REQUEST_ROW_ID_PREFIX = 'req:g:';

/**
 * One upstream `RequestGroup` as a prompt row, `ordinal` being its 1-based
 * position in the upstream (deterministic, duplicates-first) group order.
 *
 * The group's request-key digest is never read or emitted (AAP 0.5.2). Because
 * the upstream group id of a request-key group embeds that digest, the row's
 * `id` is positional (`req:g:<ordinal>`), stable within the payload, and the
 * row carries `groupedBy` so the grouping is still explicit. The URL is the
 * stored, redacted one; initiators are the stored, URL-masked stacks, bounded
 * in number and length.
 */
export function toRequestRow(
  group: RequestGroup,
  ordinal: number,
  limits: AnalysisRequestRowLimits = ANALYSIS_INPUT_LIMITS,
): AnalysisRequestRow {
  const occurrences = group.occurrences.slice(0, limits.maxRequestOccurrencesPerGroup);
  return {
    id: `${REQUEST_ROW_ID_PREFIX}${String(countOf(ordinal))}`,
    groupedBy: group.groupedBy,
    method: capText(group.method, limits.maxNameLength),
    url: capText(group.url, limits.maxUrlLength),
    path: capText(group.path, limits.maxUrlLength),
    count: countOf(group.count),
    duplicateCount: countOf(group.duplicateCount),
    hasDuplicates: group.hasDuplicates,
    duplicateWindows: group.duplicateWindows
      .slice(0, limits.maxDuplicateWindowsPerGroup)
      .map((window) => ({
        startTime: timeOf(window.startTime),
        endTime: timeOf(window.endTime),
        count: countOf(window.count),
        redundantCount: countOf(window.redundantCount),
        eventIds: window.eventIds.slice(0, limits.maxEventIdsPerWindow),
      })),
    firstStartTime: timeOf(group.firstStartTime),
    lastStartTime: timeOf(group.lastStartTime),
    totalDurationMs: durationOf(group.totalDurationMs),
    averageDurationMs: durationOf(group.averageDurationMs),
    maxDurationMs: durationOf(group.maxDurationMs),
    minDurationMs: durationOf(group.minDurationMs),
    statusCodes: [...group.statusCodes],
    errorCount: countOf(group.errorCount),
    ...(group.pendingCount === undefined ? {} : { pendingCount: countOf(group.pendingCount) }),
    initiators: group.initiators
      .slice(0, limits.maxInitiatorsPerGroup)
      .map((initiator) => capText(initiator, limits.maxInitiatorLength)),
    ...(group.transferredBytes === undefined
      ? {}
      : { transferredBytes: countOf(group.transferredBytes) }),
    occurrences: occurrences.map((occurrence) => ({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
      ...(occurrence.parentSpanId === undefined ? {} : { parentSpanId: occurrence.parentSpanId }),
      startTime: timeOf(occurrence.startTime),
      durationMs: durationOf(occurrence.durationMs),
      ...(occurrence.statusCode === undefined ? {} : { statusCode: occurrence.statusCode }),
      status: occurrence.status,
      ...(occurrence.pending === true ? { pending: true as const } : {}),
      ...withSource(occurrence.source),
    })),
    occurrencesTruncated:
      group.occurrencesTruncated || occurrences.length < group.occurrences.length,
  };
}

/** The caps {@link toQueryRow} applies. */
export type AnalysisQueryRowLimits = Pick<
  AnalysisInputLimits,
  'maxQueryOccurrencesPerGroup' | 'maxCallersPerQuery' | 'maxStatementLength' | 'maxNameLength'
>;

/**
 * One upstream `QueryGroup` as a prompt row: the redacted, parameterised
 * statement (bounded), counts and timings, callers, and the citable executions.
 * Row contents are never present — only the reported row counts.
 */
export function toQueryRow(
  group: QueryGroup,
  limits: AnalysisQueryRowLimits = ANALYSIS_INPUT_LIMITS,
): AnalysisQueryRow {
  const occurrences = group.occurrences.slice(0, limits.maxQueryOccurrencesPerGroup);
  return {
    id: group.id,
    statement: capText(group.statement, limits.maxStatementLength),
    ...(group.system === undefined ? {} : { system: capText(group.system, limits.maxNameLength) }),
    executionCount: countOf(group.executionCount),
    totalDurationMs: durationOf(group.totalDurationMs),
    averageDurationMs: durationOf(group.averageDurationMs),
    minDurationMs: durationOf(group.minDurationMs),
    maxDurationMs: durationOf(group.maxDurationMs),
    firstStartTime: timeOf(group.firstStartTime),
    lastStartTime: timeOf(group.lastStartTime),
    ...(group.totalRowCount === undefined ? {} : { totalRowCount: countOf(group.totalRowCount) }),
    errorCount: countOf(group.errorCount),
    callers: group.callers.slice(0, limits.maxCallersPerQuery).map((caller) => ({
      name: capText(caller.name, limits.maxNameLength),
      ...(caller.kind === undefined ? {} : { kind: caller.kind }),
      executionCount: countOf(caller.executionCount),
      totalDurationMs: durationOf(caller.totalDurationMs),
      ...withSource(caller.source),
    })),
    occurrences: occurrences.map((occurrence) => ({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
      ...(occurrence.parentSpanId === undefined ? {} : { parentSpanId: occurrence.parentSpanId }),
      startTime: timeOf(occurrence.startTime),
      durationMs: durationOf(occurrence.durationMs),
      ...(occurrence.rowCount === undefined ? {} : { rowCount: countOf(occurrence.rowCount) }),
      status: occurrence.status,
      ...(occurrence.callerSpanId === undefined ? {} : { callerSpanId: occurrence.callerSpanId }),
      ...(occurrence.callerName === undefined
        ? {}
        : { callerName: capText(occurrence.callerName, limits.maxNameLength) }),
      ...withSource(occurrence.source),
    })),
    occurrencesTruncated:
      group.occurrencesTruncated || occurrences.length < group.occurrences.length,
  };
}

/** One upstream `SpanSummary` as a slowest-span row. */
function toTopSpanRow(span: SpanSummary, maxNameLength: number): AnalysisTopSpanRow {
  return {
    eventId: span.id,
    spanId: span.spanId,
    traceId: span.traceId,
    kind: span.kind,
    tier: span.tier,
    name: capText(span.name, maxNameLength),
    startTime: timeOf(span.startTime),
    durationMs: durationOf(span.durationMs),
    ...(span.selfTimeMs === undefined ? {} : { selfTimeMs: durationOf(span.selfTimeMs) }),
    status: span.status,
    ...withSource(span.source),
  };
}

/** One upstream `ErrorSummary` as an error row. */
function toErrorRow(error: ErrorSummary, maxNameLength: number): AnalysisErrorRow {
  return {
    eventId: error.id,
    spanId: error.spanId,
    traceId: error.traceId,
    kind: error.kind,
    tier: error.tier,
    name: capText(error.name, maxNameLength),
    startTime: timeOf(error.startTime),
    ...withSource(error.source),
  };
}

/** One upstream `StateTransition` as a state row (previews only). */
function toStateRow(transition: StateTransition, maxNameLength: number): AnalysisStateRow {
  return {
    eventId: transition.eventId,
    spanId: transition.spanId,
    traceId: transition.traceId,
    startTime: timeOf(transition.startTime),
    ...(transition.component === undefined
      ? {}
      : { component: capText(transition.component, maxNameLength) }),
    ...(transition.hookIndex === undefined ? {} : { hookIndex: transition.hookIndex }),
    ...(transition.hookLabel === undefined
      ? {}
      : { hookLabel: capText(transition.hookLabel, maxNameLength) }),
    ...(transition.previousValue === undefined ? {} : { previousValue: transition.previousValue }),
    ...(transition.nextValue === undefined ? {} : { nextValue: transition.nextValue }),
    ...(transition.valueType === undefined ? {} : { valueType: transition.valueType }),
    changed: transition.changed,
    ...(transition.triggerEventId === undefined
      ? {}
      : { triggerEventId: transition.triggerEventId }),
    ...(transition.triggerName === undefined
      ? {}
      : { triggerName: capText(transition.triggerName, maxNameLength) }),
    ...(transition.triggerKind === undefined ? {} : { triggerKind: transition.triggerKind }),
    ...(transition.transitionSource === undefined
      ? {}
      : { transitionSource: transition.transitionSource }),
    ...withSource(transition.source),
  };
}

/**
 * The upstream component-tree snapshot flattened depth-first into rows, so the
 * payload stays shallow whatever the tree depth. The React `key` is not carried.
 */
function flattenComponentTree(
  snapshot: ComponentTreeSnapshot,
  maxNodes: number,
  maxNameLength: number,
): AnalysisComponentTreeSection {
  const nodes: AnalysisComponentTreeRow[] = [];
  const stack: { readonly node: ComponentTreeNode; readonly parentId: string | undefined }[] = [];
  for (let index = snapshot.roots.length - 1; index >= 0; index -= 1) {
    const root = snapshot.roots[index];
    if (root !== undefined) {
      stack.push({ node: root, parentId: undefined });
    }
  }
  while (stack.length > 0 && nodes.length < maxNodes) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    const node = frame.node;
    nodes.push({
      id: node.id,
      ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      depth: node.depth,
      component: capText(node.component, maxNameLength),
      renderCount: countOf(node.renderCount),
      totalDurationMs: durationOf(node.totalDurationMs),
      ...(node.lastTrigger === undefined ? {} : { lastTrigger: node.lastTrigger }),
      ...(node.lastRenderEventId === undefined
        ? {}
        : { lastRenderEventId: node.lastRenderEventId }),
      ...withSource(node.source),
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push({ node: child, parentId: node.id });
      }
    }
  }
  return {
    origin: snapshot.origin,
    degraded: snapshot.degraded,
    nodeCount: countOf(snapshot.nodeCount),
    maxDepth: countOf(snapshot.maxDepth),
    truncated: snapshot.truncated || stack.length > 0,
    nodes,
  };
}

/** The upstream dependency graph, projected (per-node span-id lists are not carried). */
function toDependencyGraphSection(
  graph: DependencyGraphData,
  maxNameLength: number,
): AnalysisDependencyGraphSection {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: capText(node.label, maxNameLength),
      ...(node.tier === undefined ? {} : { tier: node.tier }),
      count: countOf(node.count),
      totalDurationMs: durationOf(node.totalDurationMs),
      maxDurationMs: durationOf(node.maxDurationMs),
      ...(node.layer === undefined ? {} : { layer: node.layer }),
      ...(node.eventId === undefined ? {} : { eventId: node.eventId }),
      ...(node.traceId === undefined ? {} : { traceId: node.traceId }),
      ...withSource(node.source),
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      count: countOf(edge.count),
      totalDurationMs: durationOf(edge.totalDurationMs),
      ...(edge.inferredCount === undefined ? {} : { inferredCount: countOf(edge.inferredCount) }),
      ...(edge.ambiguousCount === undefined
        ? {}
        : { ambiguousCount: countOf(edge.ambiguousCount) }),
    })),
    layerCount: countOf(graph.layerCount),
    truncated: graph.truncated,
  };
}

/**
 * The selected element for the prompt: tag, bounded component chain, and the
 * selector and text passed through the telemetry pattern scrubber. The page URL
 * goes through the telemetry URL redactor, because a selected target has not
 * crossed the ingest-time redaction boundary.
 */
function toTargetFacet(
  target: SelectedTarget,
  maxNameLength: number,
  maxUrlLength: number,
): AnalysisTargetFacet {
  const text = target.text === undefined ? '' : capText(scrub(target.text), maxNameLength);
  return {
    tagName: capText(target.tagName, maxNameLength),
    selector: capText(scrub(target.selector), maxNameLength),
    ...(text.length === 0 ? {} : { text }),
    componentChain: target.componentChain.map((name) => capText(name, maxNameLength)),
    url: capText(redactUrl(target.url), maxUrlLength),
  };
}

/** The caps a fact-candidate projection applies. */
type CandidateLimits = Pick<
  AnalysisInputLimits,
  'maxEvidencePerCandidate' | 'maxCandidateStatementLength' | 'maxNameLength'
>;

/**
 * A fact candidate, capped and copied with only its defined fields. A
 * candidate left without evidence cannot be cited and is not carried.
 */
function toCandidateRow(
  candidate: AnalysisFactCandidateRef,
  limits: CandidateLimits,
): AnalysisFactCandidateRef | undefined {
  const evidence = candidate.evidence
    .filter((ref) => ref.eventId.length > 0)
    .slice(0, limits.maxEvidencePerCandidate)
    .map((ref) => ({
      eventId: ref.eventId,
      ...(ref.traceId === undefined ? {} : { traceId: ref.traceId }),
      ...(ref.spanId === undefined ? {} : { spanId: ref.spanId }),
      ...(ref.kind === undefined ? {} : { kind: capText(ref.kind, limits.maxNameLength) }),
      ...(ref.label === undefined ? {} : { label: capText(ref.label, limits.maxNameLength) }),
    }));
  if (evidence.length === 0) {
    return undefined;
  }
  return {
    id: capText(candidate.id, limits.maxNameLength),
    kind: capText(candidate.kind, limits.maxNameLength),
    statement: capText(candidate.statement, limits.maxCandidateStatementLength),
    evidence,
    ...(candidate.metricId === undefined
      ? {}
      : { metricId: capText(candidate.metricId, limits.maxNameLength) }),
    ...(candidate.value === undefined || !Number.isFinite(candidate.value)
      ? {}
      : { value: roundMs(candidate.value) }),
    ...(candidate.unit === undefined
      ? {}
      : { unit: capText(candidate.unit, limits.maxNameLength) }),
  };
}

/**
 * The metrics in `METRIC_IDS` order, when `metrics` holds every id exactly
 * once; `undefined` otherwise (the caller then recomputes with
 * `computeMetrics`). Unavailable metrics are preserved as such.
 */
function orderedMetrics(metrics: readonly MetricValue[]): AnalysisMetric[] | undefined {
  const byId = new Map<MetricId, MetricValue>();
  for (const metric of metrics) {
    if (byId.has(metric.id)) {
      return undefined;
    }
    byId.set(metric.id, metric);
  }
  const ordered: AnalysisMetric[] = [];
  for (const id of METRIC_IDS) {
    const metric = byId.get(id);
    if (metric === undefined) {
      return undefined;
    }
    ordered.push({
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      available: metric.available,
      ...(metric.value === undefined || !Number.isFinite(metric.value)
        ? {}
        : { value: roundMs(metric.value) }),
      ...(metric.note === undefined ? {} : { note: metric.note }),
    });
  }
  return byId.size === METRIC_IDS.length ? ordered : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Byte budget
 * ---------------------------------------------------------------------------------------------- */

/**
 * The UTF-8 size of `value` serialised as JSON — the measure `maxTotalBytes`
 * bounds. A value that cannot be serialised measures as infinitely large, so a
 * budget check can never pass it.
 */
export function estimatePayloadBytes(value: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (text === undefined) {
    return 0;
  }
  return new TextEncoder().encode(text).length;
}

/** How one {@link ByteBudgetStep} shrinks its section. */
export type ByteBudgetAction = 'drop' | 'halve' | 'trim-occurrences' | 'trim-spans';

/** One step of the byte budget. */
export type ByteBudgetStep = {
  /** The section it shrinks. */
  readonly section: AnalysisSectionName;
  /** How. */
  readonly action: ByteBudgetAction;
};

/**
 * The fixed order in which {@link applyByteBudget} shrinks sections, lowest
 * evidentiary value first: derived views (dependency graph, component tree)
 * go before source excerpts and state transitions, detail rows (occurrences,
 * span rows) are thinned before aggregate rows are halved, and the fact
 * candidates — the evidence the model must cite — are the very last to be
 * thinned. `capture` and `metrics` are never touched.
 */
export const BYTE_BUDGET_STEPS: readonly ByteBudgetStep[] = Object.freeze([
  { section: 'dependencyGraph', action: 'drop' },
  { section: 'componentTree', action: 'drop' },
  { section: 'excerpts', action: 'halve' },
  { section: 'stateTransitions', action: 'halve' },
  { section: 'renders', action: 'trim-occurrences' },
  { section: 'requests', action: 'trim-occurrences' },
  { section: 'queries', action: 'trim-occurrences' },
  { section: 'traces', action: 'trim-spans' },
  { section: 'relevantFiles', action: 'halve' },
  { section: 'excerpts', action: 'drop' },
  { section: 'stateTransitions', action: 'drop' },
  { section: 'topSpans', action: 'halve' },
  { section: 'traces', action: 'halve' },
  { section: 'traces', action: 'trim-spans' },
  { section: 'renders', action: 'halve' },
  { section: 'requests', action: 'halve' },
  { section: 'queries', action: 'halve' },
  { section: 'errors', action: 'halve' },
  { section: 'relevantFiles', action: 'drop' },
  { section: 'topSpans', action: 'drop' },
  { section: 'renders', action: 'drop' },
  { section: 'requests', action: 'drop' },
  { section: 'queries', action: 'drop' },
  { section: 'errors', action: 'drop' },
  { section: 'traces', action: 'drop' },
  { section: 'factCandidates', action: 'halve' },
] as const satisfies readonly ByteBudgetStep[]);

/** The outcome of {@link applyByteBudget}. */
export type ByteBudgetResult = {
  /** The (possibly shrunk) input, with its truncation report updated. */
  readonly input: AnalysisStageInput;
  /** Sections trimmed or dropped, in payload order. */
  readonly dropped: readonly AnalysisSectionName[];
  /** UTF-8 bytes of the returned input. */
  readonly bytes: number;
  /** Whether the returned input fits the budget. */
  readonly fits: boolean;
};

/** An input under construction: the optional sections as explicit, possibly undefined, fields. */
type AnalysisInputDraft = Omit<
  AnalysisStageInput,
  'followUpQuestion' | 'target' | 'componentTree' | 'dependencyGraph'
> & {
  readonly followUpQuestion: string | undefined;
  readonly target: AnalysisTargetFacet | undefined;
  readonly componentTree: AnalysisComponentTreeSection | undefined;
  readonly dependencyGraph: AnalysisDependencyGraphSection | undefined;
};

/** An input as a draft. */
function toDraft(input: AnalysisStageInput): AnalysisInputDraft {
  return {
    ...input,
    followUpQuestion: input.followUpQuestion,
    target: input.target,
    componentTree: input.componentTree,
    dependencyGraph: input.dependencyGraph,
  };
}

/** A draft as an input, in the documented section order, with no undefined field. */
function composeInput(draft: AnalysisInputDraft): AnalysisStageInput {
  return {
    sessionId: draft.sessionId,
    captureId: draft.captureId,
    question: draft.question,
    ...(draft.followUpQuestion === undefined ? {} : { followUpQuestion: draft.followUpQuestion }),
    ...(draft.target === undefined ? {} : { target: draft.target }),
    capture: draft.capture,
    metrics: draft.metrics,
    traces: draft.traces,
    topSpans: draft.topSpans,
    renders: draft.renders,
    ...(draft.componentTree === undefined ? {} : { componentTree: draft.componentTree }),
    requests: draft.requests,
    queries: draft.queries,
    stateTransitions: draft.stateTransitions,
    ...(draft.dependencyGraph === undefined ? {} : { dependencyGraph: draft.dependencyGraph }),
    errors: draft.errors,
    relevantFiles: draft.relevantFiles,
    excerpts: draft.excerpts,
    factCandidates: draft.factCandidates,
    truncated: draft.truncated,
  };
}

/** The first half (rounded down) of a list, or `undefined` when it is empty. */
function halved<T>(items: readonly T[]): T[] | undefined {
  return items.length === 0 ? undefined : items.slice(0, Math.floor(items.length / 2));
}

/** `[]` for a non-empty list, `undefined` when it is already empty. */
function dropped<T>(items: readonly T[]): T[] | undefined {
  return items.length === 0 ? undefined : [];
}

/** Rows with at most one occurrence each, or `undefined` when none had more. */
function trimmedOccurrences<
  R extends { readonly occurrences: readonly unknown[]; readonly occurrencesTruncated: boolean },
>(rows: readonly R[]): R[] | undefined {
  if (!rows.some((row) => row.occurrences.length > 1)) {
    return undefined;
  }
  return rows.map((row) =>
    row.occurrences.length > 1
      ? { ...row, occurrences: row.occurrences.slice(0, 1), occurrencesTruncated: true }
      : row,
  );
}

/** Traces with half their span rows (longest spans and ancestors kept), or `undefined`. */
function trimmedSpans(traces: readonly AnalysisTraceSection[]): AnalysisTraceSection[] | undefined {
  if (!traces.some((trace) => trace.spans.length > 1)) {
    return undefined;
  }
  return traces.map((trace) =>
    trace.spans.length > 1
      ? {
          ...trace,
          spans: keepLongestRows(trace.spans, Math.floor(trace.spans.length / 2)),
          spansTruncated: true,
        }
      : trace,
  );
}

/** A list section shrunk by `action`, or `undefined` when the action changes nothing. */
function shrinkList<T>(items: readonly T[], action: ByteBudgetAction): T[] | undefined {
  if (action === 'halve') {
    return halved(items);
  }
  if (action === 'drop') {
    return dropped(items);
  }
  return undefined;
}

/** The draft with one budget step applied, or `undefined` when the step is a no-op. */
function applyStep(
  draft: AnalysisInputDraft,
  step: ByteBudgetStep,
): AnalysisInputDraft | undefined {
  const { section, action } = step;
  switch (section) {
    case 'dependencyGraph':
      return action === 'drop' && draft.dependencyGraph !== undefined
        ? { ...draft, dependencyGraph: undefined }
        : undefined;
    case 'componentTree':
      return action === 'drop' && draft.componentTree !== undefined
        ? { ...draft, componentTree: undefined }
        : undefined;
    case 'traces': {
      const traces =
        action === 'trim-spans' ? trimmedSpans(draft.traces) : shrinkList(draft.traces, action);
      return traces === undefined ? undefined : { ...draft, traces };
    }
    case 'renders': {
      const renders =
        action === 'trim-occurrences'
          ? trimmedOccurrences(draft.renders)
          : shrinkList(draft.renders, action);
      return renders === undefined ? undefined : { ...draft, renders };
    }
    case 'requests': {
      const requests =
        action === 'trim-occurrences'
          ? trimmedOccurrences(draft.requests)
          : shrinkList(draft.requests, action);
      return requests === undefined ? undefined : { ...draft, requests };
    }
    case 'queries': {
      const queries =
        action === 'trim-occurrences'
          ? trimmedOccurrences(draft.queries)
          : shrinkList(draft.queries, action);
      return queries === undefined ? undefined : { ...draft, queries };
    }
    case 'topSpans': {
      const topSpans = shrinkList(draft.topSpans, action);
      return topSpans === undefined ? undefined : { ...draft, topSpans };
    }
    case 'stateTransitions': {
      const stateTransitions = shrinkList(draft.stateTransitions, action);
      return stateTransitions === undefined ? undefined : { ...draft, stateTransitions };
    }
    case 'errors': {
      const errors = shrinkList(draft.errors, action);
      return errors === undefined ? undefined : { ...draft, errors };
    }
    case 'relevantFiles': {
      const relevantFiles = shrinkList(draft.relevantFiles, action);
      return relevantFiles === undefined ? undefined : { ...draft, relevantFiles };
    }
    case 'excerpts': {
      const excerpts = shrinkList(draft.excerpts, action);
      return excerpts === undefined ? undefined : { ...draft, excerpts };
    }
    case 'factCandidates': {
      const factCandidates = shrinkList(draft.factCandidates, action);
      return factCandidates === undefined ? undefined : { ...draft, factCandidates };
    }
    case 'capture':
    case 'metrics':
      return undefined;
  }
}

/** Sections in payload order, de-duplicated. */
function inPayloadOrder(sections: Iterable<AnalysisSectionName>): AnalysisSectionName[] {
  const present = new Set(sections);
  return ANALYSIS_SECTION_NAMES.filter((name) => present.has(name));
}

/** The truncation reason for row-limit and byte-budget truncation. */
function truncationReason(
  rowLimits: boolean,
  byteBudget: boolean,
): AnalysisTruncationReason | undefined {
  if (rowLimits && byteBudget) {
    return 'row-limits+byte-budget';
  }
  if (byteBudget) {
    return 'byte-budget';
  }
  return rowLimits ? 'row-limits' : undefined;
}

/** A truncation report with `section` recorded as trimmed by the byte budget. */
function withBudgetTruncation(
  truncation: AnalysisTruncation,
  section: AnalysisSectionName,
): AnalysisTruncation {
  const rowLimits =
    truncation.reason === 'row-limits' || truncation.reason === 'row-limits+byte-budget';
  const reason = truncationReason(rowLimits, true);
  return {
    sections: inPayloadOrder([...truncation.sections, section]),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * `input` held under `maxTotalBytes`: while it is too large, the steps of
 * {@link BYTE_BUDGET_STEPS} are applied in order, each recorded in the returned
 * `dropped` list and in the input's own `truncated` report (never silently).
 * Pure: `input` is not mutated. When every step has been applied and the input
 * still does not fit, `fits` is `false` and the caller must not use it.
 */
export function applyByteBudget(
  input: AnalysisStageInput,
  maxTotalBytes: number,
): ByteBudgetResult {
  let draft = toDraft(input);
  let current = composeInput(draft);
  let bytes = estimatePayloadBytes(current);
  const trimmed: AnalysisSectionName[] = [];
  for (const step of BYTE_BUDGET_STEPS) {
    if (bytes <= maxTotalBytes) {
      break;
    }
    const next = applyStep(draft, step);
    if (next === undefined) {
      continue;
    }
    draft = { ...next, truncated: withBudgetTruncation(next.truncated, step.section) };
    trimmed.push(step.section);
    current = composeInput(draft);
    bytes = estimatePayloadBytes(current);
  }
  return {
    input: current,
    dropped: inPayloadOrder(trimmed),
    bytes,
    fits: bytes <= maxTotalBytes,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Excerpts
 * ---------------------------------------------------------------------------------------------- */

/** `text` cut so its UTF-8 encoding fits `maxBytes`. */
function capBytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return { text, cut: false };
  }
  let end = Math.min(text.length, maxBytes);
  let candidate = capText(text, end);
  while (end > 0 && encoder.encode(candidate).length > maxBytes) {
    end = Math.floor(end * 0.9);
    candidate = capText(text, end);
  }
  return { text: end > 0 ? candidate : '', cut: true };
}

/**
 * A bounded excerpt of one relevant file through the injected code queries: the
 * symbol's declaration when the investigation named one and it resolves,
 * otherwise the head of the file. Never reads a path itself; the code-analysis
 * excerpt already refuses environment files and paths outside the project.
 */
function excerptFor(
  codeQueries: CodeExcerptPort,
  file: AnalysisRelevantFile,
  limits: Pick<AnalysisInputLimits, 'maxExcerptBytes'>,
): AnalysisExcerpt | undefined {
  const symbolNode =
    file.symbol === undefined ? undefined : codeQueries.findSymbol(file.file, file.symbol);
  const target: CodeExcerptTarget =
    symbolNode === undefined
      ? { file: file.file, line: 1, endLine: CODE_QUERY_LIMITS.maxExcerptLines }
      : symbolNode.nodeId;
  const excerpt = codeQueries.excerpt(target, { maxChars: limits.maxExcerptBytes });
  if (excerpt === undefined || !isSafeRelativePath(excerpt.file) || excerpt.text.length === 0) {
    return undefined;
  }
  const bounded = capBytes(excerpt.text, limits.maxExcerptBytes);
  if (bounded.text.length === 0) {
    return undefined;
  }
  return {
    file: excerpt.file,
    ...(symbolNode === undefined || file.symbol === undefined ? {} : { symbol: file.symbol }),
    startLine: countOf(excerpt.startLine),
    endLine: countOf(excerpt.endLine),
    text: bounded.text,
    truncated: excerpt.truncated || bounded.cut,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/** A session and one of its captures. */
type FoundCapture = {
  readonly session: SessionRecord;
  readonly capture: CaptureRecord;
};

/** The admitted events of a capture, as read from the store. */
type LoadedEvents = {
  readonly events: readonly TelemetryEvent[];
  readonly total: number;
  readonly truncated: boolean;
};

/** The latest analysis in a session record: highest version, later entry on a tie. */
function latestRecordedAnalysis(
  analyses: readonly AnalysisResult[],
): Pick<AnalysisResult, 'id' | 'observed' | 'likelyCauses'> | undefined {
  let latest: AnalysisResult | undefined;
  for (const analysis of analyses) {
    if (latest === undefined || analysis.analysisVersion >= latest.analysisVersion) {
      latest = analysis;
    }
  }
  return latest;
}

/**
 * Create the analysis-input subsystem over injected ports. Construction has no
 * side effect; every method reads through the ports and returns a `Result`.
 */
export function createAnalysisSummarizer(deps: AnalysisSummarizerDeps): AnalysisSummarizer {
  const logger = deps.logger ?? noopLogger;

  /** The session and a capture it owns. */
  const findCapture = (
    sessionId: string,
    captureId: string,
  ): Result<FoundCapture, DebuggenError> => {
    const session = deps.sessions.get(sessionId);
    if (!session.ok) {
      return err(session.error);
    }
    if (session.value === undefined) {
      return err(
        new DebuggenError('SESSION_NOT_FOUND', 'The session does not exist.', {
          details: { sessionId },
        }),
      );
    }
    const stored = deps.sessions.getCapture(captureId);
    if (!stored.ok) {
      return err(stored.error);
    }
    if (
      stored.value === undefined ||
      stored.value.sessionId !== sessionId ||
      stored.value.capture.id !== captureId
    ) {
      return err(
        new DebuggenError('SESSION_INVALID_STATE', 'The session has no such capture.', {
          hint: 'Run and stop a capture in this session before analysing it.',
          details: { sessionId, captureId },
        }),
      );
    }
    return ok({ session: session.value, capture: stored.value.capture });
  };

  /**
   * The capture's admitted events, page by page in start order, stopping at
   * `maxEvents` rows read. Refused rows are recorded in `refused`.
   */
  const loadEvents = (
    sessionId: string,
    captureId: string,
    maxEvents: number,
    refused: Set<string>,
    signal: AbortSignal | undefined,
  ): Result<LoadedEvents, DebuggenError> => {
    const events: TelemetryEvent[] = [];
    let read = 0;
    let offset = 0;
    let total = 0;
    while (read < maxEvents) {
      if (isAborted(signal)) {
        return err(abortedError());
      }
      const limit = Math.min(DATA_QUERY_MAX_LIMIT, maxEvents - read);
      const page = deps.telemetry.query({ sessionId, captureId, sort: 'start_asc', limit, offset });
      if (!page.ok) {
        return err(page.error);
      }
      total = countOf(page.value.total);
      for (const row of page.value.rows) {
        if (isAdmissibleEvent(row, sessionId, captureId)) {
          events.push(row);
        } else {
          refused.add(row.id);
        }
      }
      const skipped = countOf(page.value.skipped ?? 0);
      read += page.value.rows.length + skipped;
      const next = page.value.nextOffset;
      if (next === undefined || next <= offset || page.value.rows.length + skipped === 0) {
        break;
      }
      offset = next;
    }
    return ok({ events, total, truncated: read < total });
  };

  /** One trace tree: from the correlator when injected, else from the loaded events. */
  const traceTreeFor = async (
    sessionId: string,
    captureId: string,
    traceId: string,
    local: ReadonlyMap<string, TraceTree>,
  ): Promise<TraceTree | undefined> => {
    if (deps.correlator !== undefined) {
      const remote = await deps.correlator.getTrace(sessionId, traceId, captureId);
      if (remote.ok && remote.value !== undefined) {
        return remote.value;
      }
      if (!remote.ok) {
        logger.warn('Trace correlator failed; correlating the loaded events instead.', {
          sessionId,
          captureId,
          code: remote.error.code,
        });
      }
    }
    return local.get(traceId);
  };

  const loadCaptureSummary = (
    sessionId: string,
    captureId: string,
  ): Promise<Result<CaptureSummary, DebuggenError>> => {
    const found = findCapture(sessionId, captureId);
    if (!found.ok) {
      return Promise.resolve(err(found.error));
    }
    const stored = found.value.capture.summary;
    if (stored !== undefined && stored.captureId === captureId) {
      return Promise.resolve(ok(stored));
    }
    const refused = new Set<string>();
    const loaded = loadEvents(
      sessionId,
      captureId,
      ANALYSIS_INPUT_LIMITS.maxEventsConsidered,
      refused,
      undefined,
    );
    if (!loaded.ok) {
      return Promise.resolve(err(loaded.error));
    }
    if (refused.size > 0) {
      logger.warn('Persisted rows failed the provenance check and were left out of the summary.', {
        sessionId,
        captureId,
        excluded: refused.size,
      });
    }
    return Promise.resolve(
      ok(computeCaptureSummary(loaded.value.events, { captureId, sessionId })),
    );
  };

  const buildStageInput = async (
    request: AnalysisStageInputRequest,
  ): Promise<Result<AnalysisStageInputBuild, DebuggenError>> => {
    const started = deps.now?.();
    const options = request.options ?? {};
    const signal = options.signal;
    if (isAborted(signal)) {
      return err(abortedError());
    }
    const resolvedLimits = resolveAnalysisLimits(options.limits);
    if (!resolvedLimits.ok) {
      return err(resolvedLimits.error);
    }
    const limits = resolvedLimits.value;
    const { sessionId, captureId } = request;

    // 1. The session and the capture it owns.
    const found = findCapture(sessionId, captureId);
    if (!found.ok) {
      return err(found.error);
    }
    const { session, capture } = found.value;

    // 2. The empty-capture check (AAP 0.5.5), before any row is paged.
    const counts = deps.telemetry.countByKind(sessionId, captureId);
    if (!counts.ok) {
      return err(counts.error);
    }
    let persisted = 0;
    for (const count of Object.values(counts.value)) {
      persisted += countOf(count);
    }
    if (persisted === 0) {
      return err(emptyCaptureError(sessionId, captureId, 'no-events', 0));
    }
    if (options.requireInteraction === true && countOf(counts.value.interaction) === 0) {
      return err(emptyCaptureError(sessionId, captureId, 'no-interaction', 0));
    }

    // 3. The admitted events, paged and capped.
    const refused = new Set<string>();
    const admit = (event: TelemetryEvent): boolean => {
      if (isAdmissibleEvent(event, sessionId, captureId)) {
        return true;
      }
      refused.add(event.id);
      return false;
    };
    const loaded = loadEvents(sessionId, captureId, limits.maxEventsConsidered, refused, signal);
    if (!loaded.ok) {
      return err(loaded.error);
    }
    const { events, truncated: eventsTruncated } = loaded.value;
    if (events.length === 0) {
      return err(emptyCaptureError(sessionId, captureId, 'no-admissible-events', refused.size));
    }

    // 4. The capture summary and metrics, owned upstream.
    const stored = capture.summary;
    const summary =
      stored !== undefined && stored.captureId === captureId
        ? stored
        : computeCaptureSummary(events, { captureId, sessionId });
    const metrics = orderedMetrics(summary.metrics) ?? orderedMetrics(computeMetrics(events));
    if (metrics === undefined) {
      return err(
        new DebuggenError('INTERNAL', 'The capture metric set is incomplete.', {
          details: { sessionId, captureId, expected: METRIC_IDS.length },
        }),
      );
    }
    const sectionSummary = computeCaptureSummary(
      events,
      { captureId, sessionId },
      { topN: Math.max(limits.maxTopSpans, limits.maxErrors) + 1, includeComponentTree: false },
    );

    // 5. Traces: selected deterministically, flattened canonically.
    const correlation = correlateEvents(events);
    const candidates: AnalysisTraceCandidate[] = correlation.traces.map((tree) => ({
      traceId: tree.traceId,
      totalDurationMs: tree.totalDuration,
    }));
    const known = new Set(candidates.map((candidate) => candidate.traceId));
    for (const traceId of summary.traceIds) {
      if (!known.has(traceId)) {
        known.add(traceId);
        candidates.push({ traceId, totalDurationMs: 0 });
      }
    }
    const selected = selectTraces(candidates, {
      maxTraces: limits.maxTraces,
      focusTraceId: options.focusTraceId,
      traceIds: options.traceIds,
      primaryTraceId: summary.primaryTraceId,
    });
    const traces: AnalysisTraceSection[] = [];
    let spanBudget = limits.maxTotalSpans;
    for (const traceId of selected) {
      if (isAborted(signal)) {
        return err(abortedError());
      }
      const tree = await traceTreeFor(sessionId, captureId, traceId, correlation.byTraceId);
      if (tree === undefined) {
        continue;
      }
      const flattened = flattenTraceForPrompt(tree, {
        maxSpans: Math.min(limits.maxSpansPerTrace, spanBudget),
        maxNameLength: limits.maxNameLength,
        maxTimelineRows: limits.maxTimelineRows,
        primary: traceId === summary.primaryTraceId,
        admit,
      });
      spanBudget = Math.max(0, spanBudget - flattened.section.spans.length);
      traces.push(flattened.section);
    }
    if (isAborted(signal)) {
      return err(abortedError());
    }

    // 6. Aggregate sections, owned upstream and projected here.
    const topSpans = sectionSummary.topSpans
      .slice(0, limits.maxTopSpans)
      .map((span) => toTopSpanRow(span, limits.maxNameLength));
    const errors = sectionSummary.errors
      .slice(0, limits.maxErrors)
      .map((error) => toErrorRow(error, limits.maxNameLength));

    const renderStats = aggregateRenders(events, {
      maxOccurrencesPerComponent: limits.maxRenderOccurrencesPerRow,
      includeOccurrences: true,
    });
    const renders = renderStats
      .slice(0, limits.maxRenderRows)
      .map((stat) => toRenderRow(stat, limits));

    let componentTree: AnalysisComponentTreeSection | undefined;
    if (options.includeComponentTree !== false && limits.maxComponentTreeNodes > 0) {
      const snapshot = buildComponentTreeSnapshot(events, {
        maxNodes: limits.maxComponentTreeNodes,
      });
      if (snapshot !== undefined) {
        componentTree = flattenComponentTree(
          snapshot,
          limits.maxComponentTreeNodes,
          limits.maxNameLength,
        );
      }
    }

    const requestGroups = aggregateRequests(events, {
      maxOccurrencesPerGroup: limits.maxRequestOccurrencesPerGroup,
    });
    const requests = requestGroups
      .slice(0, limits.maxRequestGroups)
      .map((group, index) => toRequestRow(group, index + 1, limits));

    const queryGroups = aggregateQueries(events, {
      maxOccurrencesPerGroup: limits.maxQueryOccurrencesPerGroup,
      maxCallersPerGroup: limits.maxCallersPerQuery,
    });
    const queries = queryGroups
      .slice(0, limits.maxQueryGroups)
      .map((group) => toQueryRow(group, limits));

    const transitions = aggregateStateTransitions(events, {
      maxTransitions: limits.maxStateTransitions + 1,
    });
    const stateTransitions = transitions
      .slice(0, limits.maxStateTransitions)
      .map((transition) => toStateRow(transition, limits.maxNameLength));

    let dependencyGraph: AnalysisDependencyGraphSection | undefined;
    if (options.includeDependencyGraph !== false && limits.maxGraphNodes > 0) {
      const graph = buildDependencyGraph(events, {
        maxNodes: limits.maxGraphNodes,
        maxEdges: limits.maxGraphEdges,
      });
      if (graph.nodes.length > 0) {
        dependencyGraph = toDependencyGraphSection(graph, limits.maxNameLength);
      }
    }

    // 7. Relevant files and excerpts: only what the investigation selected.
    const safeFiles = session.relevantFiles.filter((file) => isSafeRelativePath(file.file));
    const relevantFiles: AnalysisRelevantFile[] = safeFiles
      .slice(0, limits.maxRelevantFiles)
      .map((file) => ({
        file: file.file,
        ...(file.symbol === undefined
          ? {}
          : { symbol: capText(file.symbol, limits.maxNameLength) }),
        reason: capText(file.reason, limits.maxReasonLength),
        score: roundMs(file.score),
      }));
    const codeQueries = request.codeQueries ?? deps.codeQueries;
    const excerpts: AnalysisExcerpt[] = [];
    let excerptsWithheld = 0;
    let excerptsTruncated = false;
    if (codeQueries !== undefined && limits.maxExcerpts > 0) {
      for (const file of relevantFiles) {
        if (excerpts.length >= limits.maxExcerpts) {
          excerptsTruncated = true;
          break;
        }
        const excerpt = excerptFor(codeQueries, file, limits);
        if (excerpt === undefined) {
          continue;
        }
        if (findDeniedRules(excerpt.text).length > 0) {
          excerptsWithheld += 1;
          continue;
        }
        excerpts.push(excerpt);
        excerptsTruncated ||= excerpt.truncated;
      }
    }

    // 8. Fact candidates, capped and projected.
    const offeredCandidates = options.factCandidates ?? [];
    const projectedCandidates = offeredCandidates
      .map((candidate) => toCandidateRow(candidate, limits))
      .filter((candidate): candidate is AnalysisFactCandidateRef => candidate !== undefined);
    const factCandidates = projectedCandidates.slice(0, limits.maxFactCandidates);
    const candidatesTruncated =
      projectedCandidates.length > limits.maxFactCandidates ||
      projectedCandidates.length < offeredCandidates.length ||
      offeredCandidates.some(
        (candidate) =>
          candidate.evidence.length > limits.maxEvidencePerCandidate ||
          candidate.statement.length > limits.maxCandidateStatementLength,
      );

    // 9. The row-limit truncation report.
    const capped = new Set<AnalysisSectionName>();
    if (eventsTruncated || refused.size > 0) {
      capped.add('capture');
    }
    if (
      selected.length < candidates.length ||
      traces.length < selected.length ||
      traces.some((trace) => trace.spansTruncated)
    ) {
      capped.add('traces');
    }
    if (sectionSummary.topSpans.length > limits.maxTopSpans) {
      capped.add('topSpans');
    }
    if (
      renderStats.length > limits.maxRenderRows ||
      renders.some((row) => row.occurrencesTruncated)
    ) {
      capped.add('renders');
    }
    if (componentTree?.truncated === true) {
      capped.add('componentTree');
    }
    if (
      requestGroups.length > limits.maxRequestGroups ||
      requests.some((row) => row.occurrencesTruncated)
    ) {
      capped.add('requests');
    }
    if (
      queryGroups.length > limits.maxQueryGroups ||
      queries.some((row) => row.occurrencesTruncated)
    ) {
      capped.add('queries');
    }
    if (transitions.length > limits.maxStateTransitions) {
      capped.add('stateTransitions');
    }
    if (dependencyGraph?.truncated === true) {
      capped.add('dependencyGraph');
    }
    if (sectionSummary.errors.length > limits.maxErrors) {
      capped.add('errors');
    }
    if (safeFiles.length > limits.maxRelevantFiles) {
      capped.add('relevantFiles');
    }
    if (excerptsTruncated || excerptsWithheld > 0) {
      capped.add('excerpts');
    }
    if (candidatesTruncated) {
      capped.add('factCandidates');
    }
    const sectionsTruncated = inPayloadOrder(capped);
    const rowLimitReason = truncationReason(sectionsTruncated.length > 0, false);

    // 10. Assemble, then hold the payload under the byte ceiling.
    const target = session.target;
    const draft: AnalysisInputDraft = {
      sessionId,
      captureId,
      question: request.question,
      followUpQuestion: request.followUpQuestion,
      target:
        target === undefined
          ? undefined
          : toTargetFacet(target, limits.maxNameLength, limits.maxUrlLength),
      capture: {
        captureId,
        planVersion: capture.planVersion,
        startedAt: timeOf(capture.startedAt),
        ...(capture.stoppedAt === undefined ? {} : { stoppedAt: timeOf(capture.stoppedAt) }),
        startTime: timeOf(summary.startTime),
        endTime: timeOf(summary.endTime),
        durationMs: durationOf(summary.durationMs),
        eventCount: persisted,
        eventsConsidered: events.length,
        eventsExcluded: refused.size,
        eventsTruncated,
        traceCount: countOf(summary.traceCount),
        ...(summary.primaryTraceId === undefined ? {} : { primaryTraceId: summary.primaryTraceId }),
        producerCount: summary.producerIds.length,
        tierCounts: { ...summary.tierCounts },
        kindCounts: { ...counts.value },
        unavailableMetrics: [...summary.unavailableMetrics],
      },
      metrics,
      traces,
      topSpans,
      renders,
      componentTree,
      requests,
      queries,
      stateTransitions,
      dependencyGraph,
      errors,
      relevantFiles,
      excerpts,
      factCandidates,
      truncated: {
        sections: sectionsTruncated,
        ...(rowLimitReason === undefined ? {} : { reason: rowLimitReason }),
      },
    };
    const budget = applyByteBudget(composeInput(draft), limits.maxTotalBytes);
    if (!budget.fits) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          'The analysis input cannot be reduced below the configured byte ceiling.',
          {
            hint: 'Raise maxTotalBytes towards its default; the minimal input is larger than the ceiling.',
            details: {
              sessionId,
              captureId,
              maxTotalBytes: limits.maxTotalBytes,
              ...(Number.isFinite(budget.bytes) ? { approxBytes: budget.bytes } : {}),
            },
          },
        ),
      );
    }

    const input = budget.input;
    let spansIncluded = 0;
    for (const trace of input.traces) {
      spansIncluded += trace.spans.length;
    }
    const stats: AnalysisInputStats = {
      eventsConsidered: events.length,
      eventsExcluded: refused.size,
      tracesIncluded: input.traces.length,
      spansIncluded,
      excerptsWithheld,
      approxBytes: budget.bytes,
      sectionsTruncated,
      droppedForBudget: budget.dropped,
    };
    if (refused.size > 0) {
      logger.warn(
        'Persisted rows failed the provenance check and were excluded from the analysis input.',
        {
          sessionId,
          captureId,
          excluded: refused.size,
        },
      );
    }
    if (excerptsWithheld > 0) {
      logger.warn(
        'Code excerpts matching a denied pattern were withheld from the analysis input.',
        {
          sessionId,
          captureId,
          withheld: excerptsWithheld,
        },
      );
    }
    const finished = deps.now?.();
    logger.debug('Analysis input assembled.', {
      sessionId,
      captureId,
      eventsConsidered: stats.eventsConsidered,
      eventsExcluded: stats.eventsExcluded,
      tracesIncluded: stats.tracesIncluded,
      spansIncluded: stats.spansIncluded,
      approxBytes: stats.approxBytes,
      sectionsTruncated: stats.sectionsTruncated,
      droppedForBudget: stats.droppedForBudget,
      ...(started === undefined || finished === undefined
        ? {}
        : { durationMs: durationOf(finished - started) }),
    });
    return ok({ input, stats });
  };

  const buildFollowUpContext = (
    sessionId: string,
  ): Promise<Result<AnalysisFollowUpContext, DebuggenError>> => {
    const session = deps.sessions.get(sessionId);
    if (!session.ok) {
      return Promise.resolve(err(session.error));
    }
    if (session.value === undefined) {
      return Promise.resolve(
        err(
          new DebuggenError('SESSION_NOT_FOUND', 'The session does not exist.', {
            details: { sessionId },
          }),
        ),
      );
    }
    let analysis: Pick<AnalysisResult, 'id' | 'observed' | 'likelyCauses'> | undefined;
    let panelId: string | undefined;
    if (deps.panels === undefined) {
      analysis = latestRecordedAnalysis(session.value.analyses);
      panelId = session.value.panelIds.at(-1);
    } else {
      const latestAnalysis = deps.panels.getLatestAnalysis(sessionId);
      if (!latestAnalysis.ok) {
        return Promise.resolve(err(latestAnalysis.error));
      }
      const latestPanel = deps.panels.getLatestPanel(sessionId);
      if (!latestPanel.ok) {
        return Promise.resolve(err(latestPanel.error));
      }
      analysis = latestAnalysis.value;
      panelId = latestPanel.value?.id;
    }
    return Promise.resolve(
      ok({
        ...(analysis === undefined ? {} : { previousAnalysisId: analysis.id }),
        previousObserved: analysis === undefined ? 0 : analysis.observed.length,
        previousLikelyCauses: analysis === undefined ? 0 : analysis.likelyCauses.length,
        ...(panelId === undefined ? {} : { previousPanelId: panelId }),
      }),
    );
  };

  return Object.freeze({ loadCaptureSummary, buildStageInput, buildFollowUpContext });
}
