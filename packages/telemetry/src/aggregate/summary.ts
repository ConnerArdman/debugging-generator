/**
 * The capture rollup: one bounded, JSON-serializable object describing
 * everything a finished capture measured, plus the fourteen computed metric
 * values a generated panel's `metricCards` node can ask for (AAP 0.2.3).
 *
 * This is the last module of the `aggregate` folder and the only one that
 * composes the other four. Nothing here re-derives a semantic a sibling owns:
 *
 * - render counts and the unchanged/unknown split come from
 *   `summarizeRenderTriggers` in `./renders.js`;
 * - duplicate counting comes from `countDuplicateRequests` in `./requests.js`;
 * - statement grouping comes from `aggregateQueries` in `./queries.js`, and so
 *   does the count of statement executions: `query_count` is the sum of the
 *   resolved groups' `executionCount`, so the metric card and the query table
 *   beneath it are arithmetically identical by construction rather than by two
 *   passes that happen to agree. That sibling owns which database spans are
 *   executions at all — a lifecycle span that ran no statement and the inner of
 *   two observations of one execution are neither — and this module does not
 *   second-guess it;
 * - every per-tier duration is an **interval union** computed by
 *   `unionDurationMs` / `subtractIntervalsDurationMs` in `./timeline.js`;
 * - the metric **vocabulary** — the ids, their units and the semantic groups
 *   over them — belongs to `../schema/attributes.js`, which states the
 *   division of labour explicitly: the ids live there, their values live here.
 *   This module re-exports that vocabulary so a consumer holding a
 *   {@link CaptureSummary} can validate a metric id without a second import,
 *   and there is still exactly one declaration of it.
 *
 * ## Where this object travels, and why it is bounded
 *
 * A {@link CaptureSummary} is the body of the `capture.stop` HTTP response and
 * the payload of the `capture.stopped` WebSocket broadcast (AAP 0.4.2), and it
 * is the "redacted aggregates" input the analysis stage is prompted with. It
 * therefore has to stay small and serialisable:
 *
 * - every section is sliced to {@link CaptureSummaryOptions.topN};
 * - the trace id list is clipped to {@link DEFAULT_MAX_TRACE_IDS};
 * - the component tree is **opt-in** ({@link
 *   CaptureSummaryOptions.includeComponentTree}, default `false`);
 * - the timeline, the trace trees and the full occurrence lists are **never**
 *   embedded — a panel fetches those through `POST /sessions/:id/panel-data`;
 * - nothing in the result is a `Map`, a `Set`, a class instance or a cycle, so
 *   `JSON.parse(JSON.stringify(summary))` is the same object.
 *
 * ## Privacy
 *
 * The summary is an input to the model stages, so it carries **aggregate
 * numbers and already-redacted identifiers only** (AAP 0.5.2). Every string it
 * publishes is either a product-owned label, an identifier, a span name or a
 * value a sibling aggregate already produced from redacted events: the
 * redacted display URL of a request group, the parameterized statement of a
 * query group. No request or response body, no SQL literal, no prop or state
 * value and no error stack passes through this module, and none is read.
 *
 * ## Honesty
 *
 * Two rules are structural rather than stylistic, because breaking either
 * would let an absence read as an observation (AAP 0.8.4):
 *
 * 1. A metric nobody could measure is published with `available: false` and
 *    **no** `value` — never as `0`. `transferred_bytes` is the metric this
 *    exists for: a transfer size is exposed for same-origin responses only
 *    (AAP 0.6.6), so a capture may genuinely have nothing to report, and the
 *    card reads `n/a`. A *reported* zero is not automatically a measurement
 *    either: a cross-origin response served without `Timing-Allow-Origin`
 *    reports every byte count as `0`, and `./requests.ts`'s
 *    `readExposedTransferSize` — the single reader of those attributes in this
 *    layer — is what tells that absence apart from the genuine zero of a
 *    same-origin cache hit. This module counts only what it can tell was
 *    measured.
 * 2. A render whose trigger could not be determined counts into
 *    `render_trigger_unknown_count` and **never** into
 *    `unchanged_render_count`. That split is `./renders.js`'s classification,
 *    consumed here unchanged.
 *
 * ## Environment
 *
 * Pure, environment-neutral and non-mutating. No `node:` builtin, no DOM
 * global, no clock: the capture *window* is derived from the events and the
 * capture *identity* is supplied by the caller in a
 * {@link CaptureSummaryContext}. The same code runs in the service, in the
 * page agent's bundle and in a test.
 */

import type {
  CaptureId,
  EventId,
  ProducerId,
  SessionId,
  SourceLocation,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import { clampNonNegative, roundMs } from '@debuggen/shared';

import { compareEventsCanonical, correlateEvents } from '../correlation/correlator.js';
import { selfTimeOf, walkTrace } from '../correlation/tree.js';
import {
  KIND_ATTRIBUTE_KEYS,
  METRIC_IDS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  PERF_LONGTASK_ATTRIBUTE_KEYS,
  metricUnitFor,
  type MetricId,
  type MetricUnit,
} from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import {
  ERROR_KINDS,
  PERF_KINDS,
  REQUEST_KINDS,
  type TelemetryKind,
  type TelemetryTier,
} from '../schema/kinds.js';
import { aggregateQueries, type QueryGroup } from './queries.js';
import {
  aggregateRenders,
  buildComponentTreeSnapshot,
  summarizeRenderTriggers,
  type ComponentTreeSnapshot,
  type RenderStat,
  type RenderTriggerSummary,
} from './renders.js';
import {
  RESOURCE_ENTRY_TYPE,
  aggregateRequests,
  countDuplicateRequests,
  readExposedTransferSize,
  type RequestGroup,
} from './requests.js';
import { subtractIntervalsDurationMs, unionDurationMs, type Interval } from './timeline.js';

/*
 * ---------------------------------------------------------------------------
 * The metric vocabulary
 *
 * Re-exported, not redeclared. `../schema/attributes.ts` is the single
 * declaration site of the closed fourteen-member id set, of the unit each id
 * carries and of the three semantic groups over them; its colocated suite
 * pins the list and its order against AAP 0.2.3, and `packages/panel-schema`
 * validates a `metricCards` node's `metrics` against the same set.
 *
 * The re-export exists because this module publishes the *values*: a consumer
 * that receives a `CaptureSummary` and wants to narrow an untrusted metric id
 * before rendering a card would otherwise need to know which of the two files
 * owns which half. Both paths resolve to one declaration, so there is nothing
 * to keep in step.
 *
 * Adding a metric is four edits, none of them optional: a member of
 * `METRIC_IDS`, an entry in `METRIC_ID_UNITS`, a place in one semantic group
 * (all three in `../schema/attributes.ts`) and the computation below, which
 * the compiler then demands through {@link METRIC_DEFINITIONS} and the
 * exhaustive measurement record inside {@link computeMetrics}.
 * ---------------------------------------------------------------------------
 */

export { METRIC_IDS, METRIC_UNITS, isMetricId } from '../schema/attributes.js';
export type { MetricId, MetricUnit } from '../schema/attributes.js';

/*
 * ---------------------------------------------------------------------------
 * Bounds and thresholds
 * ---------------------------------------------------------------------------
 */

/**
 * How many rows each bounded section of a {@link CaptureSummary} carries by
 * default.
 *
 * Ten is a rollup, not a data set: the summary rides on a WebSocket broadcast
 * and into a prompt, and a developer reading "the slowest operations" wants
 * the handful that dominate rather than the whole capture. Everything the
 * sections leave out is reachable through `POST /sessions/:id/panel-data`,
 * which pages properly (AAP 0.4.2).
 *
 * The same bound also caps the occurrence samples inside the published request
 * and query groups, so one number governs the object's size.
 */
export const DEFAULT_TOP_N = 10;

/**
 * How many distinct trace ids {@link CaptureSummary.traceIds} lists.
 *
 * A capture normally holds one interaction and therefore one trace; fifty is
 * roomy for a capture that spanned several interactions and small enough that
 * a runaway page cannot inflate the payload without bound. When the list is
 * clipped, {@link CaptureSummary.truncated} says so — the clip is never
 * silent, because "these are the traces" and "these are fifty of the traces"
 * support different conclusions.
 */
export const DEFAULT_MAX_TRACE_IDS = 50;

/**
 * The long-task threshold, in milliseconds, that `blocking_time` measures
 * beyond.
 *
 * This is Total Blocking Time as the web-performance community defines it: the
 * portion of each long task past 50 ms, summed. The browser's own long-task
 * definition uses the same 50 ms boundary, so a task that qualifies as long
 * contributes exactly its excess and a 50 ms task contributes nothing.
 */
export const LONG_TASK_BLOCKING_THRESHOLD_MS = 50;

/*
 * ---------------------------------------------------------------------------
 * Vocabulary members this module classifies by
 *
 * Each constant is annotated with its vocabulary's type, so a misspelling is a
 * compile error rather than a silently empty filter, and each is spelled once.
 * Every *set* decision — which kinds are requests, which are queries, which
 * are failures — goes through the kind groups of `../schema/kinds.ts` instead;
 * these three name a single member that a group cannot pick out on its own.
 * ---------------------------------------------------------------------------
 */

/** The browser tier: the page-injected agent's events. */
const BROWSER_TIER: TelemetryTier = 'browser';

/** The server tier: the dev-server preload's events. */
const SERVER_TIER: TelemetryTier = 'server';

/** The database tier: spans attributed to the datastore. */
const DATABASE_TIER: TelemetryTier = 'db';

/**
 * The one member of the performance kind group whose events are long tasks.
 *
 * The group holds both performance kinds, and only this one is a long task, so
 * the member has to be named. It is still selected *through* the group at
 * runtime ({@link isLongTaskEvent}), which is what keeps an event of a kind
 * outside the group from being counted should the vocabulary change.
 */
const LONG_TASK_KIND: TelemetryKind = 'perf.longtask';

/** The long-task attribute carrying the producer's own blocking-time figure. */
const BLOCKING_TIME_ATTRIBUTE: (typeof PERF_LONGTASK_ATTRIBUTE_KEYS)[number] = 'blockingTime';

/**
 * The attribute carrying bytes over the wire.
 *
 * Declared against the resource-timing key tuple because that is where a
 * transfer size originates; the fetch, XHR and navigation catalogs declare the
 * same key, and {@link reportsTransferSize} asks the registry which kinds
 * those are rather than restating them.
 */
const TRANSFER_SIZE_ATTRIBUTE: (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number] = 'transferSize';

/**
 * The attribute naming which `PerformanceEntry` type a `perf.entry` describes.
 *
 * Read by {@link measuresTransferSize} alone, to keep a paint mark — an
 * instant with no response — out of the transfer-coverage denominator.
 */
const ENTRY_TYPE_ATTRIBUTE: (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number] = 'entry.type';

/** The span status that marks a failed operation of any kind. */
const ERROR_STATUS: TelemetryEvent['status'] = 'error';

/*
 * ---------------------------------------------------------------------------
 * Metric definitions
 *
 * The presentation half of the vocabulary: the label a card shows and the
 * sentence that says how the number was computed. The descriptions are
 * surfaced to the panel-generation prompt through
 * `packages/panel-schema`'s node catalog, so each one states a *rule* in
 * generic product vocabulary and never names a component, a service, a table
 * or a route (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

/**
 * What a metric is, for a consumer that has to render or explain it.
 *
 * `unit` is read from the vocabulary rather than restated, and `kind` is
 * derived from `unit`, so a definition cannot disagree with
 * `../schema/attributes.ts` about what sort of number the id names.
 */
export interface MetricDefinition {
  /** The metric this defines. */
  readonly id: MetricId;
  /** Short UI label, as a card's heading. */
  readonly label: string;
  /** The unit the value carries, from the vocabulary. */
  readonly unit: MetricUnit;
  /**
   * How the value should be formatted and compared: a duration eligible for
   * the renderer's duration-severity tokens, a whole count, or a byte size.
   *
   * A coarser statement than {@link unit} on purpose — a renderer chooses a
   * formatter from this, and the prose layer chooses a noun from it — and
   * derived from the unit so the two can never drift.
   */
  readonly kind: 'duration' | 'count' | 'bytes';
  /** One sentence naming the computation rule. */
  readonly description: string;
}

/**
 * The formatting class each unit implies.
 *
 * Exhaustive over the unit vocabulary by annotation: a unit added to
 * `METRIC_UNITS` without an entry here is a compile error, which is the point
 * — an unclassified unit would otherwise fall through to a default formatter
 * and render a number in the wrong shape without failing anywhere.
 */
const METRIC_KIND_BY_UNIT: Readonly<Record<MetricUnit, MetricDefinition['kind']>> = Object.freeze({
  milliseconds: 'duration',
  count: 'count',
  bytes: 'bytes',
});

/**
 * Builds one definition, taking the unit from the vocabulary and the kind from
 * the unit.
 *
 * @param id The metric being defined.
 * @param label Its short UI label.
 * @param description One sentence stating how it is computed.
 */
function metricDefinition(id: MetricId, label: string, description: string): MetricDefinition {
  const unit = metricUnitFor(id);
  return Object.freeze({ id, label, unit, kind: METRIC_KIND_BY_UNIT[unit], description });
}

/**
 * Every metric's label, unit and computation rule, keyed by id.
 *
 * Exhaustive by construction: the annotation is `Record<MetricId, …>`, so a
 * missing entry and an invented one are both compile errors, and every lookup
 * below is therefore total under `noUncheckedIndexedAccess` without an
 * assertion or a fallback.
 *
 * Frozen, and every definition inside it is frozen too: this table is shared
 * by the service, both extensions and the prose layer.
 */
export const METRIC_DEFINITIONS: Readonly<Record<MetricId, MetricDefinition>> = Object.freeze({
  total_duration: metricDefinition(
    'total_duration',
    'Total duration',
    'Wall-clock span of the events in scope: the latest end minus the earliest start.',
  ),
  frontend_duration: metricDefinition(
    'frontend_duration',
    'Frontend duration',
    'Browser-tier time the server tier did not cover: the union of browser intervals minus the union of server intervals.',
  ),
  backend_duration: metricDefinition(
    'backend_duration',
    'Backend duration',
    'Union of the server-tier intervals, so work that ran in parallel is counted once.',
  ),
  database_duration: metricDefinition(
    'database_duration',
    'Database duration',
    'Union of the database-tier intervals, so overlapping statements are counted once.',
  ),
  render_count: metricDefinition(
    'render_count',
    'Renders',
    'Renders observed across every component that rendered during the capture.',
  ),
  unchanged_render_count: metricDefinition(
    'unchanged_render_count',
    'Unchanged renders',
    'Renders whose props were shallow-equal, own hook state unchanged and consumed context values unchanged.',
  ),
  render_trigger_unknown_count: metricDefinition(
    'render_trigger_unknown_count',
    'Renders with unknown trigger',
    'Renders whose trigger could not be determined, counted apart from unchanged renders and never folded into them.',
  ),
  request_count: metricDefinition(
    'request_count',
    'Requests',
    'Requests the page issued, counted per occurrence rather than per group.',
  ),
  query_count: metricDefinition(
    'query_count',
    'Queries',
    'Database statements that ran, counted per execution: the executions the query groups account for, so the card and the query table state one fact.',
  ),
  transferred_bytes: metricDefinition(
    'transferred_bytes',
    'Transferred bytes',
    'Sum of the transfer sizes the capture reported; unavailable when nothing reported one, since a transfer size is exposed for same-origin responses only.',
  ),
  blocking_time: metricDefinition(
    'blocking_time',
    'Blocking time',
    `Total blocking time: each long task's duration beyond the ${String(
      LONG_TASK_BLOCKING_THRESHOLD_MS,
    )} ms threshold, summed.`,
  ),
  duplicate_request_count: metricDefinition(
    'duplicate_request_count',
    'Duplicate requests',
    'Redundant request occurrences: the occurrences past the first in each duplicate window.',
  ),
  long_task_count: metricDefinition(
    'long_task_count',
    'Long tasks',
    'Long tasks the performance timeline reported during the capture.',
  ),
  error_count: metricDefinition(
    'error_count',
    'Errors',
    'Events that are failures by kind or that carry an error status, counted once each.',
  ),
});

/*
 * ---------------------------------------------------------------------------
 * Published shapes
 * ---------------------------------------------------------------------------
 */

/**
 * One metric's value, ready for a card.
 *
 * ## Absence is a state, not a zero
 *
 * `available: false` with **no** `value` is how this module says "the capture
 * could not measure this". The renderer shows `n/a`; it never shows a number.
 * Substituting `0` would turn an absence into an observation, which the
 * product forbids structurally (AAP 0.8.4), and `transferred_bytes` is the
 * metric that takes this path in an ordinary capture (AAP 0.6.6).
 *
 * `label` and `unit` are copied from {@link METRIC_DEFINITIONS} so that a
 * consumer holding only this object can render it without a second lookup;
 * they are never computed here.
 */
export interface MetricValue {
  /** Which metric this is. */
  readonly id: MetricId;
  /** The card's heading, from {@link METRIC_DEFINITIONS}. */
  readonly label: string;
  /** The unit the value carries, from the metric vocabulary. */
  readonly unit: MetricUnit;
  /** Whether the capture could measure this metric at all. */
  readonly available: boolean;
  /** The measured number. Present if and only if `available` is `true`. */
  readonly value?: number;
  /**
   * A short, generic caveat about coverage — for example that transfer sizes
   * are reported for same-origin responses only.
   *
   * Never a captured value, a URL or a statement: a note is product prose that
   * a renderer may show verbatim.
   */
  readonly note?: string;
}

/**
 * The compact projection of one event used by {@link CaptureSummary.topSpans}.
 *
 * This is the "top spans" evidence the analysis stage is prompted with (AAP
 * 0.4.2): enough to say what was slow, where it ran and which source location
 * it points at, and nothing else. The attribute bag is deliberately **not**
 * carried — a panel that needs it queries the event by id.
 */
export interface SpanSummary {
  /** The event's own id, and the evidence reference a fact cites. */
  readonly id: EventId;
  /** The span this event represents. */
  readonly spanId: SpanId;
  /** The trace it belongs to. */
  readonly traceId: TraceId;
  /** What sort of operation it was. */
  readonly kind: TelemetryKind;
  /** Which tier produced it. */
  readonly tier: TelemetryTier;
  /** The span name as the producer reported it. */
  readonly name: string;
  /** When it started, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** How long it took inclusive of its children, in milliseconds. */
  readonly durationMs: number;
  /**
   * Its own time, in milliseconds: the inclusive duration minus the wall-clock
   * time its direct children covered.
   *
   * Absent when the span has no correlated position — the summary was asked
   * for no sections, or the event's trace could not be built — because "no
   * self time was computed" and "this span did all the work itself" are
   * different statements. Computed by `selfTimeOf` in
   * `../correlation/tree.js`, so a span that spent its time waiting on a child
   * reads as nearly zero rather than as expensive.
   */
  readonly selfTimeMs?: number;
  /** The status the producer reported. */
  readonly status: TelemetryEvent['status'];
  /** Where it came from, when a resolution route supplied a location. */
  readonly source?: SourceLocation;
}

/**
 * The compact projection of one failure used by {@link CaptureSummary.errors}.
 *
 * Identity, position and the already-redacted span `name` only. No message
 * body beyond that name and **no stack**: a stack can quote source text, and
 * this object is put in front of a model (AAP 0.5.2).
 */
export interface ErrorSummary {
  /** The event's own id. */
  readonly id: EventId;
  /** The span that failed. */
  readonly spanId: SpanId;
  /** The trace it belongs to. */
  readonly traceId: TraceId;
  /** The event's kind: a failure kind, or the kind of the operation that failed. */
  readonly kind: TelemetryKind;
  /** Which tier produced it. */
  readonly tier: TelemetryTier;
  /** The span name as the producer reported it, already redacted. */
  readonly name: string;
  /** When it was recorded, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** Where it came from, when a resolution route supplied a location. */
  readonly source?: SourceLocation;
}

/**
 * How the stop barrier that closed a capture window ended — the closed
 * vocabulary of {@link CaptureCoverage.drain}.
 *
 * When a capture stops, the service disarms both producers and then waits,
 * bounded, for the batches they flush on disarm (and any already in flight) to
 * land before it summarises the window:
 *
 * - `'quiescent'` — ingest for the window went quiet for the barrier's quiet
 *   period: nothing the producers sent is known to be missing.
 * - `'deadline'` — events were still arriving when the barrier's upper bound
 *   ran out, so the window's last events may be missing from it.
 * - `'unverified'` — whether anything was still in flight is unknown: the
 *   store could not be read to watch the window, or ingest went quiet but a
 *   producer that contributed events to the window could not be confirmed to
 *   have received its disarm (its dormant configuration unsent, its dev-server
 *   preload unreachable, or the disarm itself failed), so its final flush may
 *   never have arrived. A producer that contributed no event never makes the
 *   barrier unverified.
 * - `'not-applicable'` — no live window was closed by this summary (a capture
 *   rolled back before anything was armed, or one already stopped earlier).
 */
export const CAPTURE_DRAIN_OUTCOMES = Object.freeze([
  'quiescent',
  'deadline',
  'unverified',
  'not-applicable',
] as const);

/** One member of {@link CAPTURE_DRAIN_OUTCOMES}. */
export type CaptureDrainOutcome = (typeof CAPTURE_DRAIN_OUTCOMES)[number];

/**
 * How completely a capture summary covers what the capture's producers
 * observed — the evidence-loss diagnostics a summary must carry so it never
 * looks whole when it is not.
 *
 * {@link computeCaptureSummary} never sets it: it summarises the events it is
 * handed and cannot know what it was not handed. The service attaches it when
 * it closes a capture window (`apps/local-service/src/pipeline/stages/capture.ts`),
 * from the store's count of the window's events, the per-capture loss reports
 * the producers sent and the outcome of the stop barrier. Plain JSON, safe to
 * log and broadcast: counts and a vocabulary member only.
 */
export interface CaptureCoverage {
  /** How many events the store holds for the capture window when it closed. */
  readonly storedEvents: number;
  /**
   * How many of them the summary was computed from — {@link storedEvents}, or
   * fewer when the window held more than the service summarises in one pass.
   */
  readonly summarizedEvents: number;
  /**
   * How many events the producers reported discarding before delivery (the
   * page agent's bounded buffer while the bridge was away). Counts the reports
   * the summarising service process received; `0` when none were reported.
   */
  readonly producerDroppedEvents: number;
  /**
   * How the stop barrier ended — `'unverified'` also when the window went quiet
   * but a producer that contributed events to it could not be confirmed to
   * have flushed (see {@link CAPTURE_DRAIN_OUTCOMES}).
   */
  readonly drain: CaptureDrainOutcome;
  /**
   * `true` only when nothing is known to be missing: every stored event was
   * summarised, no producer reported a loss, and the barrier did not end at its
   * deadline or unverified — so never while a contributing producer's final
   * flush is unconfirmed.
   */
  readonly complete: boolean;
}

/**
 * Everything a finished capture measured, in one bounded object.
 *
 * The payload of the `capture.stop` response and the `capture.stopped`
 * broadcast, the analysis stage's evidence input, and the object a
 * deterministic fallback panel is assembled from (AAP 0.4.2, 0.5.3).
 *
 * ## Invariants
 *
 * - `metrics` always holds **all fourteen** values, in `METRIC_IDS` order, so
 *   a `metricCards` node can resolve any id in the vocabulary without a lookup
 *   miss. A metric the capture could not measure is present and unavailable.
 * - `tierCounts` and `kindCounts` are zero-filled over their whole
 *   vocabularies, so no consumer indexes into a hole.
 * - `endTime >= startTime` and `durationMs === endTime - startTime` rounded;
 *   all three are `0` for an empty capture.
 * - `unavailableMetrics` lists exactly the ids whose `MetricValue.available`
 *   is `false`.
 * - Every array is a fresh array of plain objects: no `Map`, no `Set`, no
 *   class instance and no cycle, so the object survives `JSON.stringify`
 *   unchanged.
 */
export interface CaptureSummary {
  /** The capture these numbers describe, supplied by the caller. */
  readonly captureId: CaptureId;
  /** The session that owns the capture, when the caller named one. */
  readonly sessionId?: SessionId;
  /** Earliest event start, in Unix epoch milliseconds; `0` when empty. */
  readonly startTime: number;
  /** Latest event end, in Unix epoch milliseconds; `0` when empty. */
  readonly endTime: number;
  /** `endTime - startTime`, in milliseconds, clamped and rounded. */
  readonly durationMs: number;
  /** How many events the summary was computed from. */
  readonly eventCount: number;
  /** How many distinct traces the capture holds, whatever `traceIds` lists. */
  readonly traceCount: number;
  /**
   * The distinct trace ids, ascending, clipped to
   * {@link DEFAULT_MAX_TRACE_IDS}. {@link truncated} reports the clip.
   */
  readonly traceIds: readonly TraceId[];
  /**
   * The trace a generated `timeline` or `flame` node should filter on by
   * default: the longest trace in the capture.
   *
   * Chosen by total duration descending, then earliest start, then id
   * ascending — a total order, so two processes summarising the same capture
   * pick the same trace. Absent only when the capture holds no events.
   */
  readonly primaryTraceId?: TraceId;
  /** The producers that contributed, ascending by id. */
  readonly producerIds: readonly ProducerId[];
  /** Events per tier, zero-filled over `TELEMETRY_TIERS`. */
  readonly tierCounts: Readonly<Record<TelemetryTier, number>>;
  /** Events per kind, zero-filled over `TELEMETRY_KINDS`. */
  readonly kindCounts: Readonly<Record<TelemetryKind, number>>;
  /** All fourteen metric values, in `METRIC_IDS` order. */
  readonly metrics: readonly MetricValue[];
  /** The slowest spans, longest first; bounded by `topN`. */
  readonly topSpans: readonly SpanSummary[];
  /** The busiest components, most renders first; bounded by `topN`. */
  readonly topRenders: readonly RenderStat[];
  /** The request groups, most redundant first; bounded by `topN`. */
  readonly topRequests: readonly RequestGroup[];
  /** The query groups, most total time first; bounded by `topN`. */
  readonly topQueries: readonly QueryGroup[];
  /** The failures, in canonical time order; bounded by `topN`. */
  readonly errors: readonly ErrorSummary[];
  /**
   * The component structure, only when the caller opted in.
   *
   * Opt-in because it is the one section whose size is set by the page rather
   * than by `topN`, and this object is broadcast over a WebSocket. A panel
   * that needs it asks the `componentTree` panel-data source instead.
   */
  readonly componentTree?: ComponentTreeSnapshot;
  /**
   * Whether anything the summary published was clipped: a section hit `topN`,
   * the trace list hit {@link DEFAULT_MAX_TRACE_IDS}, or an included component
   * tree reports its own truncation.
   *
   * Never means "some events were dropped" — every event handed in is counted
   * in `eventCount`, the metrics and the per-tier and per-kind tallies.
   */
  readonly truncated: boolean;
  /** The ids whose metric value is unavailable, in `METRIC_IDS` order. */
  readonly unavailableMetrics: readonly MetricId[];
  /**
   * How completely this summary covers the capture window, attached by the
   * service when it closes the window; see {@link CaptureCoverage}. Absent on a
   * summary {@link computeCaptureSummary} returns directly, which describes
   * exactly the events it was handed.
   */
  readonly coverage?: CaptureCoverage;
}

/**
 * The capture's identity, supplied by the caller.
 *
 * This module never mints an id and never reads a clock: a summary describes
 * the capture the service says it describes, and its window comes from the
 * events themselves. That is what makes the function reproducible — the same
 * events and the same context always produce the same object.
 */
export interface CaptureSummaryContext {
  /** The capture being summarised. */
  readonly captureId: CaptureId;
  /** The session that owns it, when there is one. */
  readonly sessionId?: SessionId;
}

/**
 * How large a summary to build.
 *
 * Every field is optional and an out-of-range value falls back to its default
 * rather than throwing, because these options arrive from a request body.
 */
export interface CaptureSummaryOptions {
  /**
   * Rows per bounded section, and occurrence samples per published group.
   * Defaults to {@link DEFAULT_TOP_N}. `0` publishes no rows, which is
   * reported through {@link CaptureSummary.truncated} rather than as "there
   * were none".
   */
  readonly topN?: number;
  /**
   * Whether to embed the component-tree snapshot. Defaults to `false`; see
   * {@link CaptureSummary.componentTree}.
   */
  readonly includeComponentTree?: boolean;
  /**
   * The duplicate window, in milliseconds, forwarded to `aggregateRequests`.
   * Defaults to that module's `DEFAULT_DUPLICATE_WINDOW_MS`.
   */
  readonly duplicateWindowMs?: number;
}

/**
 * Aggregates a caller already holds, so they are computed once per capture.
 *
 * {@link computeCaptureSummary} aggregates renders, requests and queries for
 * its sections and then hands the very same results to
 * {@link computeMetrics}. Without this, a card and the table beneath it could
 * be computed from two separate aggregations of the same capture and disagree
 * in front of the developer — which is the one inconsistency a rollup must not
 * have.
 *
 * Each field is independent: supply one, two or all three, and anything absent
 * is aggregated from the events.
 */
export interface PrecomputedCaptureAggregates {
  /** Render statistics, as `aggregateRenders` returns them. */
  readonly renders?: readonly RenderStat[];
  /** Request groups, as `aggregateRequests` returns them. */
  readonly requests?: readonly RequestGroup[];
  /**
   * Query groups, as `aggregateQueries` returns them.
   *
   * Consumed by {@link CaptureSummary.topQueries} **and** by `query_count`,
   * which is the sum of these groups' `executionCount`. Supplying them is
   * therefore what makes the card and the table one fact rather than two
   * aggregations of one capture; omitting them has {@link computeMetrics}
   * aggregate its own, counts-only.
   */
  readonly queries?: readonly QueryGroup[];
}

/** How to compute the metric values. */
export interface ComputeMetricsOptions {
  /**
   * The duplicate window forwarded to `aggregateRequests` when the request
   * groups are not supplied. Ignored when they are — the groups already carry
   * the window they were computed with.
   */
  readonly duplicateWindowMs?: number;
  /** Aggregates the caller already has; see {@link PrecomputedCaptureAggregates}. */
  readonly precomputed?: PrecomputedCaptureAggregates;
}

/*
 * ---------------------------------------------------------------------------
 * Internals: vocabulary membership
 *
 * The kind groups are read-only arrays, so each is turned into a set once at
 * module load and every classification below is a single lookup. A group is a
 * filter rather than a partition (a `fetch` belongs to more than one), which
 * is why each metric names the group it means instead of switching on a kind.
 * ---------------------------------------------------------------------------
 */

/** Requests the page issued: the request kind group, as a lookup. */
const REQUEST_KIND_SET: ReadonlySet<TelemetryKind> = new Set(REQUEST_KINDS);

/** Performance-timeline entries: the perf kind group, as a lookup. */
const PERF_KIND_SET: ReadonlySet<TelemetryKind> = new Set(PERF_KINDS);

/** Events whose subject is a failure: the error kind group, as a lookup. */
const ERROR_KIND_SET: ReadonlySet<TelemetryKind> = new Set(ERROR_KINDS);

/**
 * The caveat published with `transferred_bytes`, whether the metric is
 * unavailable or only partially covered.
 *
 * Product prose, deliberately generic: it explains the platform limitation
 * (AAP 0.6.6) and quotes nothing the capture observed.
 */
const TRANSFER_SIZE_NOTE =
  'A transfer size is reported for same-origin responses only, so this total may not cover every response.';

/** Whether an event is one the page issued as a request. */
function isRequestEvent(event: TelemetryEvent): boolean {
  return REQUEST_KIND_SET.has(event.kind);
}

/**
 * Whether an event is a long task.
 *
 * Selected through the perf group first, so a kind outside that group can
 * never be counted here, and then narrowed to the group's long-task member —
 * the group holds both performance kinds and only one of them is a long task.
 */
function isLongTaskEvent(event: TelemetryEvent): boolean {
  return PERF_KIND_SET.has(event.kind) && event.kind === LONG_TASK_KIND;
}

/**
 * Whether an event records a failure.
 *
 * The **union** of two conditions, counted once per event: the event's kind is
 * one of the failure kinds, or the producer reported an error status. Both are
 * needed and neither subsumes the other — a request that came back 503 is a
 * failure carrying `status: 'error'` on a `fetch` event, while an uncaught
 * exception is a failure by kind. Counting the two separately and adding them
 * would double-count an error-kind event that also carries the status.
 */
function isFailureEvent(event: TelemetryEvent): boolean {
  return ERROR_KIND_SET.has(event.kind) || event.status === ERROR_STATUS;
}

/**
 * Whether a kind's attribute catalog declares a transfer size.
 *
 * Asked of the registry rather than answered with a list of kinds, so the set
 * of kinds that *could* report bytes follows `../schema/attributes.ts`.
 */
function reportsTransferSize(kind: TelemetryKind): boolean {
  return KIND_ATTRIBUTE_KEYS[kind].includes(TRANSFER_SIZE_ATTRIBUTE);
}

/**
 * Whether an event describes a response whose bytes could have been measured.
 *
 * The denominator behind the partial-coverage note, and narrower than "a kind
 * that declares the key": `perf.entry` covers resource loads *and* paint
 * marks, and a paint mark is an instant with no response and no bytes, so
 * counting one as a candidate that failed to report would put a coverage
 * caveat on captures with complete coverage. An entry whose `entry.type` is
 * absent is admitted, matching `./requests.ts`'s join — a producer that omits
 * the label may still have measured a response.
 */
function measuresTransferSize(event: TelemetryEvent): boolean {
  if (!reportsTransferSize(event.kind)) {
    return false;
  }
  if (!PERF_KIND_SET.has(event.kind)) {
    return true;
  }
  const entryType: unknown = event.attributes[ENTRY_TYPE_ATTRIBUTE];
  return entryType === undefined || entryType === RESOURCE_ENTRY_TYPE;
}

/*
 * ---------------------------------------------------------------------------
 * Internals: reading events
 * ---------------------------------------------------------------------------
 */

/** A number that can take part in arithmetic; `0` for anything else. */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** An event's half-open interval on the capture's time axis. */
function intervalOf(event: TelemetryEvent): Interval {
  const start = finiteOrZero(event.startTime);
  return { start, end: start + clampNonNegative(finiteOrZero(event.duration)) };
}

/**
 * A non-negative finite number at `key`, or `undefined`.
 *
 * Absence, a wrong type and a nonsensical value are one case on purpose: each
 * means the producer did not report a usable measurement, and none of them is
 * worth distinguishing in a rollup.
 */
function readNonNegativeNumber(event: TelemetryEvent, key: string): number | undefined {
  const value: unknown = event.attributes[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * How much of a long task blocked the main thread.
 *
 * The producer's own `blockingTime` is preferred where it reported one: it is
 * the same quantity measured at the source, from the entry the browser
 * delivered. Where it is absent the figure is derived from the task's duration
 * with the Total Blocking Time rule — the portion past
 * {@link LONG_TASK_BLOCKING_THRESHOLD_MS} — so a producer that reports only a
 * duration still contributes.
 */
function blockingTimeOf(event: TelemetryEvent): number {
  const reported = readNonNegativeNumber(event, BLOCKING_TIME_ATTRIBUTE);
  if (reported !== undefined) {
    return reported;
  }
  return clampNonNegative(
    clampNonNegative(finiteOrZero(event.duration)) - LONG_TASK_BLOCKING_THRESHOLD_MS,
  );
}

/*
 * ---------------------------------------------------------------------------
 * Internals: the single scan
 *
 * Every scalar, every per-tier interval list and every tally the metrics and
 * the summary need is collected in one pass over the events. The aggregates
 * this module composes do their own passes — they have to, they group — but
 * nothing here scans the capture twice for two numbers.
 * ---------------------------------------------------------------------------
 */

/** The window one trace occupies, accumulated as its events are seen. */
interface TraceWindow {
  /** Earliest start seen for the trace. */
  startTime: number;
  /** Latest end seen for the trace. */
  endTime: number;
}

/**
 * One measured transfer size observed outside the request stream, and the
 * event it came from.
 *
 * The event id is the whole point: `./requests.ts` reports which resource
 * entries its join attributed to a request, and a report is added to the total
 * only when its id is **not** among them. Matching by id rather than by URL is
 * what makes "count each response once" exact — two loads of one URL are two
 * ids, while a redacted URL cannot tell them apart.
 */
interface TransferReport {
  /** The event that measured the size. */
  readonly eventId: EventId;
  /** The measured size, in bytes. */
  readonly bytes: number;
}

/** Everything one pass over the events can answer. */
interface CaptureScan {
  /** How many events were scanned. */
  eventCount: number;
  /** Earliest start, meaningful only when {@link hasWindow}. */
  startTime: number;
  /** Latest end, meaningful only when {@link hasWindow}. */
  endTime: number;
  /** Whether any event positioned the window at all. */
  hasWindow: boolean;
  /** Events per tier, total over the tier vocabulary. */
  readonly tierCounts: Record<TelemetryTier, number>;
  /** Events per kind, total over the kind vocabulary. */
  readonly kindCounts: Record<TelemetryKind, number>;
  /** Distinct producers. */
  readonly producerIds: Set<ProducerId>;
  /** Per-trace windows, for the primary-trace choice. */
  readonly traceWindows: Map<TraceId, TraceWindow>;
  /** Browser-tier intervals, for the frontend duration. */
  readonly browserIntervals: Interval[];
  /** Server-tier intervals, for the backend duration. */
  readonly serverIntervals: Interval[];
  /** Database-tier intervals, for the database duration. */
  readonly databaseIntervals: Interval[];
  /** Request occurrences. */
  requestCount: number;
  /** Long tasks. */
  longTaskCount: number;
  /** Summed blocking time, in milliseconds. */
  blockingTimeMs: number;
  /** Failures, counted once per event. */
  errorCount: number;
  /** Events that describe a response whose bytes could have been measured. */
  transferCandidateCount: number;
  /** Candidates whose bytes actually were; see {@link readExposedTransferSize}. */
  transferReportCount: number;
  /** Measured sizes from navigation and resource entries; see {@link TransferReport}. */
  readonly resourceTransferReports: TransferReport[];
  /** The slowest spans, ranked and bounded later. */
  readonly spans: TelemetryEvent[];
  /** The failures, ordered and bounded later. */
  readonly failures: TelemetryEvent[];
}

/**
 * Events per tier, every member of the vocabulary present and zero.
 *
 * The keys enumerate the tier vocabulary once; the annotation is what makes
 * that enumeration complete, since a missing key and an invented one are both
 * compile errors. This is enumeration, not classification — every decision
 * about *which* tier an event belongs to is `event.tier` compared against the
 * three named constants above.
 */
function zeroFilledTierCounts(): Record<TelemetryTier, number> {
  return { browser: 0, server: 0, db: 0 };
}

/**
 * Events per kind, every member of the vocabulary present and zero.
 *
 * Complete by the same mechanism as {@link zeroFilledTierCounts}: a kind added
 * to `TELEMETRY_KINDS` fails to compile here until it is counted, which is
 * exactly the reminder a new signal needs.
 */
function zeroFilledKindCounts(): Record<TelemetryKind, number> {
  return {
    interaction: 0,
    render: 0,
    commit: 0,
    fetch: 0,
    xhr: 0,
    navigation: 0,
    'perf.longtask': 0,
    'perf.entry': 0,
    error: 0,
    state: 0,
    'http.server': 0,
    'route.handler': 0,
    function: 0,
    'db.query': 0,
    'http.client': 0,
    'server.error': 0,
    log: 0,
  };
}

/** A scan with every tally total and every list empty. */
function createScan(): CaptureScan {
  return {
    eventCount: 0,
    startTime: 0,
    endTime: 0,
    hasWindow: false,
    tierCounts: zeroFilledTierCounts(),
    kindCounts: zeroFilledKindCounts(),
    producerIds: new Set<ProducerId>(),
    traceWindows: new Map<TraceId, TraceWindow>(),
    browserIntervals: [],
    serverIntervals: [],
    databaseIntervals: [],
    requestCount: 0,
    longTaskCount: 0,
    blockingTimeMs: 0,
    errorCount: 0,
    transferCandidateCount: 0,
    transferReportCount: 0,
    resourceTransferReports: [],
    spans: [],
    failures: [],
  };
}

/** Files one event's interval under its tier. */
function recordTierInterval(scan: CaptureScan, event: TelemetryEvent): void {
  const interval = intervalOf(event);
  if (event.tier === BROWSER_TIER) {
    scan.browserIntervals.push(interval);
    return;
  }
  if (event.tier === SERVER_TIER) {
    scan.serverIntervals.push(interval);
    return;
  }
  if (event.tier === DATABASE_TIER) {
    scan.databaseIntervals.push(interval);
  }
}

/** Widens the capture window and the event's own trace window. */
function recordWindows(scan: CaptureScan, event: TelemetryEvent): void {
  const { start, end } = intervalOf(event);

  if (!scan.hasWindow) {
    scan.hasWindow = true;
    scan.startTime = start;
    scan.endTime = end;
  } else {
    scan.startTime = Math.min(scan.startTime, start);
    scan.endTime = Math.max(scan.endTime, end);
  }

  const traceWindow = scan.traceWindows.get(event.traceId);
  if (traceWindow === undefined) {
    scan.traceWindows.set(event.traceId, { startTime: start, endTime: end });
    return;
  }
  traceWindow.startTime = Math.min(traceWindow.startTime, start);
  traceWindow.endTime = Math.max(traceWindow.endTime, end);
}

/**
 * Count one transfer-size candidate, and keep the measurement if it made one.
 *
 * Coverage is counted for every candidate, requests included, because the
 * caveat is about how much of the capture could be measured at all. The
 * *bytes* of a request are not accumulated here: they belong to the request
 * groups, where `./requests.ts` has already joined each request to its
 * resource-timing entry and counted each response once (AAP 0.6.6 makes that
 * join the only route to a browser byte count). Keeping a second running total
 * beside the groups is exactly how a metric card and the table under it come
 * to disagree.
 */
function recordTransferSize(scan: CaptureScan, event: TelemetryEvent): void {
  if (!measuresTransferSize(event)) {
    return;
  }
  scan.transferCandidateCount += 1;

  const bytes = readExposedTransferSize(event);
  if (bytes === undefined) {
    return;
  }
  scan.transferReportCount += 1;

  if (isRequestEvent(event)) {
    return;
  }
  scan.resourceTransferReports.push({ eventId: event.id, bytes });
}

/**
 * One pass over the events, collecting everything the metrics and the summary
 * are built from. Neither the array nor any event is modified.
 */
function scanEvents(events: readonly TelemetryEvent[]): CaptureScan {
  const scan = createScan();

  for (const event of events) {
    scan.eventCount += 1;
    scan.tierCounts[event.tier] += 1;
    scan.kindCounts[event.kind] += 1;
    scan.producerIds.add(event.producerId);
    scan.spans.push(event);

    recordWindows(scan, event);
    recordTierInterval(scan, event);
    recordTransferSize(scan, event);

    if (isRequestEvent(event)) {
      scan.requestCount += 1;
    }
    if (isLongTaskEvent(event)) {
      scan.longTaskCount += 1;
      scan.blockingTimeMs += blockingTimeOf(event);
    }
    if (isFailureEvent(event)) {
      scan.errorCount += 1;
      scan.failures.push(event);
    }
  }

  return scan;
}

/**
 * The bytes the capture measured, counting each response once.
 *
 * Two disjoint contributions, and their disjointness is what makes the total
 * exact:
 *
 * - **What the requests account for.** Each group's `transferredBytes` is the
 *   sum its own occurrences carry, every one of them either the request's own
 *   exposed reading or the bytes of the single resource-timing entry that
 *   occurrence claimed. This is the same number the `requestTable` shows, so
 *   the card and the table state one fact (AAP 0.6.2).
 * - **What nothing requested.** A resource entry no occurrence claimed — a
 *   script, a stylesheet, an image — and the document's own navigation entry.
 *   They are added by event id, so an entry a request already accounted for is
 *   skipped rather than counted a second time.
 *
 * @param scan the single pass over the events.
 * @param requestGroups the groups the metrics and the sections share.
 */
function resolveTransferredBytes(
  scan: CaptureScan,
  requestGroups: readonly RequestGroup[],
): number {
  let total = 0;
  const claimed = new Set<EventId>();

  for (const group of requestGroups) {
    if (group.transferredBytes !== undefined) {
      total += group.transferredBytes;
    }
    for (const eventId of group.transferEventIds ?? []) {
      claimed.add(eventId);
    }
  }

  for (const report of scan.resourceTransferReports) {
    if (claimed.has(report.eventId)) {
      continue;
    }
    total += report.bytes;
  }

  return total;
}

/*
 * ---------------------------------------------------------------------------
 * Internals: composing the sibling aggregates
 *
 * Each aggregate is asked for exactly once per call, and the same results feed
 * both the metric values and the summary's sections. That is the only way a
 * card and the table under it are guaranteed to state the same fact.
 * ---------------------------------------------------------------------------
 */

/**
 * The occurrence bound used when the aggregates are computed for metrics
 * alone: none.
 *
 * Bounds cut sample lists and never arithmetic in any of the three aggregates,
 * so a metrics-only caller pays nothing for lists it will not publish. When
 * {@link computeCaptureSummary} does the aggregating it passes `topN` instead
 * and hands the results on, so the published groups keep their samples.
 */
const METRICS_ONLY_OCCURRENCE_BOUND = 0;

/** Render statistics: the caller's, or aggregated counts-only. */
function resolveRenderStats(
  events: readonly TelemetryEvent[],
  precomputed: PrecomputedCaptureAggregates | undefined,
  includeOccurrences: boolean,
  maxOccurrencesPerComponent: number,
): readonly RenderStat[] {
  return (
    precomputed?.renders ??
    aggregateRenders(events, { includeOccurrences, maxOccurrencesPerComponent })
  );
}

/** Request groups: the caller's, or aggregated with the requested window. */
function resolveRequestGroups(
  events: readonly TelemetryEvent[],
  precomputed: PrecomputedCaptureAggregates | undefined,
  duplicateWindowMs: number | undefined,
  maxOccurrencesPerGroup: number,
): readonly RequestGroup[] {
  if (precomputed?.requests !== undefined) {
    return precomputed.requests;
  }
  return aggregateRequests(events, {
    maxOccurrencesPerGroup,
    // Conditional rather than `duplicateWindowMs: undefined`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
    // an absent property, and absent is what selects the sibling's default.
    ...(duplicateWindowMs !== undefined ? { duplicateWindowMs } : {}),
  });
}

/** Query groups: the caller's, or aggregated with the requested bound. */
function resolveQueryGroups(
  events: readonly TelemetryEvent[],
  precomputed: PrecomputedCaptureAggregates | undefined,
  maxOccurrencesPerGroup: number,
): readonly QueryGroup[] {
  return precomputed?.queries ?? aggregateQueries(events, { maxOccurrencesPerGroup });
}

/**
 * The statement executions a capture's query groups account for.
 *
 * `query_count` is this number and nothing else, the rule this module already
 * follows for the request-group metrics (`duplicate_request_count` and
 * `transferred_bytes` are both read off the groups rather than re-counted
 * here): the metric card and the query table under it are then arithmetically
 * identical **by construction**, and a reader can never be shown "24 queries"
 * above a table whose rows sum to a different number.
 *
 * Counting database events instead would count the database tier's lifecycle
 * spans — a connection acquisition, an argument serialization, a transaction
 * boundary — and the inner of two observations of one execution, neither of
 * which is a statement that ran. `./queries.ts` owns that judgement; this
 * function only adds up what it decided, and every group's `executionCount` is
 * exact whatever the occurrence bound cut.
 */
function countQueryExecutions(groups: readonly QueryGroup[]): number {
  let executions = 0;
  for (const group of groups) {
    executions += group.executionCount;
  }
  return executions;
}

/*
 * ---------------------------------------------------------------------------
 * Internals: measurements
 *
 * A measurement is the arithmetic; a {@link MetricValue} is the presentation.
 * Keeping them apart is what lets the fourteen values be assembled in one
 * exhaustive literal — the compiler checks the set, and the labels and units
 * are read from the definitions rather than restated per metric.
 * ---------------------------------------------------------------------------
 */

/**
 * One metric's arithmetic result.
 *
 * An absent `value` means the capture could not measure the metric; the
 * resulting {@link MetricValue} then carries `available: false` and no number.
 */
interface Measurement {
  /** The measured number, absent when the metric is unobservable. */
  readonly value?: number;
  /** A coverage caveat to publish alongside it. */
  readonly note?: string;
}

/** A duration measurement, clamped at zero and rounded. */
function durationMeasurement(value: number): Measurement {
  return { value: roundMs(clampNonNegative(finiteOrZero(value))) };
}

/** A count measurement: a whole, non-negative number. */
function countMeasurement(value: number): Measurement {
  return { value: Math.trunc(clampNonNegative(finiteOrZero(value))) };
}

/**
 * The `transferred_bytes` measurement, with the three coverage cases the
 * platform limitation forces (AAP 0.6.6):
 *
 * - nothing **measured** a size → **unavailable**, no value, with the caveat.
 *   The card reads `n/a`, which is the honest answer; `0` would claim the
 *   capture observed no bytes. A capture of nothing but cross-origin responses
 *   takes this path even though every one of them *reported* `transferSize:
 *   0`, because a withheld count is not a measurement — see the header and
 *   `./requests.ts`'s `readExposedTransferSize`.
 * - some candidates measured → the partial sum, with the same caveat.
 * - every candidate measured → the sum, no caveat.
 *
 * @param scan the single pass over the events.
 * @param requestGroups the groups the value is composed from.
 */
function transferredBytesMeasurement(
  scan: CaptureScan,
  requestGroups: readonly RequestGroup[],
): Measurement {
  if (scan.transferReportCount === 0) {
    return { note: TRANSFER_SIZE_NOTE };
  }

  const value = Math.round(clampNonNegative(resolveTransferredBytes(scan, requestGroups)));
  if (scan.transferReportCount < scan.transferCandidateCount) {
    return { value, note: TRANSFER_SIZE_NOTE };
  }
  return { value };
}

/** Turns one measurement into the published value, labelled from the definitions. */
function toMetricValue(id: MetricId, measurement: Measurement): MetricValue {
  const definition = METRIC_DEFINITIONS[id];
  return {
    id,
    label: definition.label,
    unit: definition.unit,
    available: measurement.value !== undefined,
    ...(measurement.value !== undefined ? { value: measurement.value } : {}),
    ...(measurement.note !== undefined ? { note: measurement.note } : {}),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Public API: the metric values
 * ---------------------------------------------------------------------------
 */

/**
 * The fourteen metric values for a set of events.
 *
 * ## Scope is the caller's choice
 *
 * The events handed in *are* the scope. The service normally passes one
 * capture, and a panel that asks about a single interaction passes that
 * interaction's trace — for which `total_duration` is the interaction's wall
 * clock, exactly the figure a correlated timeline totals to.
 *
 * ## How each metric is computed
 *
 * - `total_duration` — the latest `startTime + duration` minus the earliest
 *   `startTime`.
 * - `backend_duration` / `database_duration` — the **interval union** of the
 *   server-tier and database-tier spans, selected by `event.tier`, so work
 *   that ran in parallel is counted once rather than summed.
 * - `frontend_duration` — the browser tier's union **minus** the server
 *   tier's: the page's time awaiting the server belongs to the backend, and
 *   counting it in both would make the parts exceed the whole. The invariants
 *   that follow are `frontend_duration + backend_duration <= total_duration`,
 *   and `database_duration <= backend_duration` whenever the database spans
 *   nest inside server spans, as they do when both tiers are captured
 *   together.
 * - `render_count`, `unchanged_render_count`,
 *   `render_trigger_unknown_count` — from `summarizeRenderTriggers`. The
 *   classification is **not** recomputed here: `unchanged` requires
 *   shallow-equal props *and* unchanged own hook state *and* no changed
 *   consumed context, and a render whose trigger could not be determined
 *   counts only into `render_trigger_unknown_count` — never as unchanged
 *   (AAP 0.2.3).
 * - `request_count` — occurrences, not groups, selected through the request
 *   kind group.
 * - `query_count` — statement executions, not groups: the sum of the query
 *   groups' `executionCount`, so this card and a `queryTable` beside it cannot
 *   disagree. `aggregateQueries` decides which database spans are executions,
 *   and a database span that ran no statement is not one — its time is still in
 *   `database_duration` and its event still in `kindCounts['db.query']`.
 * - `duplicate_request_count` — `countDuplicateRequests`, which sums the
 *   redundant occurrences per duplicate window.
 * - `transferred_bytes` — see {@link transferredBytesMeasurement}: the one
 *   metric that can legitimately be unavailable.
 * - `blocking_time` — Total Blocking Time over the long tasks; see
 *   {@link blockingTimeOf}.
 * - `long_task_count` — long tasks, selected through the perf kind group.
 * - `error_count` — failures counted once per event; see
 *   {@link isFailureEvent}.
 *
 * @param events Any slice of a capture's events, in any order. Neither the
 * array nor any event is modified.
 * @param options Duplicate window and precomputed aggregates; see
 * {@link ComputeMetricsOptions}.
 * @returns Exactly fourteen values, one per id, in `METRIC_IDS` order. Never
 * throws; an empty input yields zeroes for every count and duration and an
 * unavailable `transferred_bytes`.
 *
 * @example
 * ```ts
 * const values = computeMetrics(events);
 * const byId = new Map(values.map((value) => [value.id, value]));
 * const total = byId.get('total_duration');
 * ```
 */
export function computeMetrics(
  events: readonly TelemetryEvent[],
  options?: ComputeMetricsOptions,
): MetricValue[] {
  const scan = scanEvents(events);
  const precomputed = options?.precomputed;

  const renderStats = resolveRenderStats(events, precomputed, false, METRICS_ONLY_OCCURRENCE_BOUND);
  const requestGroups = resolveRequestGroups(
    events,
    precomputed,
    options?.duplicateWindowMs,
    METRICS_ONLY_OCCURRENCE_BOUND,
  );
  const queryGroups = resolveQueryGroups(events, precomputed, METRICS_ONLY_OCCURRENCE_BOUND);

  return metricValuesFrom(scan, summarizeRenderTriggers(renderStats), requestGroups, queryGroups);
}

/**
 * Assembles the fourteen values from one scan and the two aggregates that
 * carry a semantic this module must not recompute.
 *
 * Separated from {@link computeMetrics} so that
 * {@link computeCaptureSummary} — which has already scanned the events and
 * already aggregated for its sections — reuses all three instead of scanning
 * and aggregating a second time. One scan and one aggregation per call is what
 * keeps a metric card and the table beneath it arithmetically identical.
 *
 * @param scan The single pass over the events.
 * @param triggers Render totals from `summarizeRenderTriggers`.
 * @param requestGroups Request groups from `aggregateRequests`.
 * @param queryGroups Query groups from `aggregateQueries`.
 */
function metricValuesFrom(
  scan: CaptureScan,
  triggers: RenderTriggerSummary,
  requestGroups: readonly RequestGroup[],
  queryGroups: readonly QueryGroup[],
): MetricValue[] {
  const measurements: Readonly<Record<MetricId, Measurement>> = {
    total_duration: durationMeasurement(scan.hasWindow ? scan.endTime - scan.startTime : 0),
    frontend_duration: durationMeasurement(
      subtractIntervalsDurationMs(scan.browserIntervals, scan.serverIntervals),
    ),
    backend_duration: durationMeasurement(unionDurationMs(scan.serverIntervals)),
    database_duration: durationMeasurement(unionDurationMs(scan.databaseIntervals)),
    render_count: countMeasurement(triggers.renderCount),
    unchanged_render_count: countMeasurement(triggers.unchangedRenderCount),
    render_trigger_unknown_count: countMeasurement(triggers.unknownTriggerCount),
    request_count: countMeasurement(scan.requestCount),
    query_count: countMeasurement(countQueryExecutions(queryGroups)),
    transferred_bytes: transferredBytesMeasurement(scan, requestGroups),
    blocking_time: durationMeasurement(scan.blockingTimeMs),
    duplicate_request_count: countMeasurement(countDuplicateRequests(requestGroups)),
    long_task_count: countMeasurement(scan.longTaskCount),
    error_count: countMeasurement(scan.errorCount),
  };

  return METRIC_IDS.map((id) => toMetricValue(id, measurements[id]));
}

/*
 * ---------------------------------------------------------------------------
 * Internals: ordering, projection and bounds
 * ---------------------------------------------------------------------------
 */

/**
 * Code-unit string order.
 *
 * Comparison rather than `localeCompare`, so the order a summary publishes is
 * identical on every machine: this object is compared in tests, cached by the
 * service and re-rendered from storage.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** The section bound: a whole, non-negative row count. */
function resolveTopN(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_TOP_N;
  }
  return Math.trunc(value);
}

/** An event's published duration, in milliseconds. */
function durationOf(event: TelemetryEvent): number {
  return roundMs(clampNonNegative(finiteOrZero(event.duration)));
}

/**
 * Most expensive span first, then by id.
 *
 * The id tie-break is what makes the ranking a total order, so two processes
 * summarising the same capture publish the same rows in the same positions —
 * without it, two equally slow spans could swap places between runs and a
 * reader could not tell a real change from a sort artefact.
 */
function compareSpanCost(left: TelemetryEvent, right: TelemetryEvent): number {
  const leftDuration = durationOf(left);
  const rightDuration = durationOf(right);
  if (leftDuration !== rightDuration) {
    return leftDuration < rightDuration ? 1 : -1;
  }
  return compareStrings(left.id, right.id);
}

/** Projects one event into the compact span shape. */
function toSpanSummary(event: TelemetryEvent, selfTimeMs: number | undefined): SpanSummary {
  return {
    id: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    kind: event.kind,
    tier: event.tier,
    name: event.name,
    startTime: finiteOrZero(event.startTime),
    durationMs: durationOf(event),
    ...(selfTimeMs !== undefined ? { selfTimeMs } : {}),
    status: event.status,
    ...(event.source !== undefined ? { source: event.source } : {}),
  };
}

/** Projects one failure into the compact error shape — identity and position only. */
function toErrorSummary(event: TelemetryEvent): ErrorSummary {
  return {
    id: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    kind: event.kind,
    tier: event.tier,
    name: event.name,
    startTime: finiteOrZero(event.startTime),
    ...(event.source !== undefined ? { source: event.source } : {}),
  };
}

/**
 * Self times for the events named in `targets`, by event id.
 *
 * Self time is a property of a span's *position* — its inclusive duration
 * minus the wall-clock time its direct children covered — so it can only be
 * read from a correlated tree. The tree is therefore built once here,
 * discarded immediately, and never embedded in the summary: a panel that wants
 * the tree asks the `trace` panel-data source for it.
 *
 * Only the ranked top spans are looked up, so the map stays tiny however large
 * the capture is. The correlation itself is `O(n log n)` (see
 * `correlateEvents`), which is the cost of answering "did this span do the
 * work, or did it wait for something?" — the distinction the analysis stage
 * turns into two different findings.
 *
 * @param events The capture's events, unmodified.
 * @param targets The event ids to answer for.
 * @returns A map holding an entry for every target the correlator placed.
 */
function collectSelfTimes(
  events: readonly TelemetryEvent[],
  targets: ReadonlySet<EventId>,
): ReadonlyMap<EventId, number> {
  const selfTimes = new Map<EventId, number>();
  if (targets.size === 0) {
    return selfTimes;
  }

  for (const trace of correlateEvents(events).traces) {
    walkTrace(trace, (node) => {
      if (targets.has(node.event.id)) {
        selfTimes.set(node.event.id, selfTimeOf(node));
      }
    });
  }

  return selfTimes;
}

/**
 * The trace a view should anchor on: the longest one in the capture.
 *
 * Ordered by total duration descending, then by earliest start, then by id
 * ascending — a total order, so the choice is reproducible. A trace's total is
 * its latest end minus its earliest start, which is exactly what
 * `TraceTree.totalDuration` reports for the same events; computing it from the
 * scan avoids building every tree for one identifier.
 *
 * @param windows The per-trace windows collected during the scan.
 * @returns The chosen id, or `undefined` when the capture holds no events.
 */
function selectPrimaryTraceId(windows: ReadonlyMap<TraceId, TraceWindow>): TraceId | undefined {
  let bestId: TraceId | undefined;
  let bestDuration = 0;
  let bestStart = 0;

  for (const [traceId, traceWindow] of windows) {
    const duration = roundMs(clampNonNegative(traceWindow.endTime - traceWindow.startTime));

    if (bestId === undefined) {
      bestId = traceId;
      bestDuration = duration;
      bestStart = traceWindow.startTime;
      continue;
    }

    if (duration !== bestDuration) {
      if (duration > bestDuration) {
        bestId = traceId;
        bestDuration = duration;
        bestStart = traceWindow.startTime;
      }
      continue;
    }

    if (traceWindow.startTime !== bestStart) {
      if (traceWindow.startTime < bestStart) {
        bestId = traceId;
        bestStart = traceWindow.startTime;
      }
      continue;
    }

    if (compareStrings(traceId, bestId) < 0) {
      bestId = traceId;
    }
  }

  return bestId;
}

/*
 * ---------------------------------------------------------------------------
 * Public API: the capture rollup
 * ---------------------------------------------------------------------------
 */

/**
 * Everything a capture measured, as one bounded, JSON-serializable object.
 *
 * ## What it does
 *
 * Scans the events once, aggregates renders, requests and queries once each,
 * and builds the metric values from those very results — so a card can never
 * disagree with the table beneath it. Each section is then ordered
 * deterministically and sliced to `topN`:
 *
 * | Section | Order | Source |
 * | --- | --- | --- |
 * | `topSpans` | duration descending, then id | the event scan, with self time from one correlation |
 * | `topRenders` | render count descending | `aggregateRenders` (counts only) |
 * | `topRequests` | most redundant first | `aggregateRequests` |
 * | `topQueries` | total duration descending | `aggregateQueries` |
 * | `errors` | canonical time order | the event scan |
 *
 * ## The empty capture is a first-class case
 *
 * A capture that recorded nothing returns zero counts, a zero window, empty
 * sections and **all fourteen** metric values — counts and durations zero,
 * `transferred_bytes` unavailable. It never throws and never looks like a
 * successful analysis, which is what the service's "No telemetry was captured"
 * path depends on (AAP 0.5.5).
 *
 * ## What it never does
 *
 * Mint an identifier, read a clock, mutate its input, or embed the timeline,
 * the trace trees or a full occurrence list. Identity comes from `context`,
 * the window from the events, and everything unbounded is fetched through
 * `POST /sessions/:id/panel-data`.
 *
 * @param events The capture's events, in any order. Neither the array nor any
 * event is modified.
 * @param context The capture's identity; see {@link CaptureSummaryContext}.
 * @param options Bounds and opt-ins; see {@link CaptureSummaryOptions}.
 * @returns The rollup described by {@link CaptureSummary}.
 *
 * @example
 * ```ts
 * const summary = computeCaptureSummary(events, { captureId, sessionId });
 * broadcast({ type: 'capture.stopped', payload: { sessionId, captureId, summary } });
 * ```
 */
export function computeCaptureSummary(
  events: readonly TelemetryEvent[],
  context: CaptureSummaryContext,
  options?: CaptureSummaryOptions,
): CaptureSummary {
  const topN = resolveTopN(options?.topN);
  const scan = scanEvents(events);

  // Each aggregate is asked once, and the same results feed the metrics and
  // the sections below. Renders are aggregated counts-only: the per-render
  // occurrence lists are what the `renders` panel-data source is for, and they
  // would dominate this payload's size.
  const renderStats = resolveRenderStats(events, undefined, false, METRICS_ONLY_OCCURRENCE_BOUND);
  const requestGroups = resolveRequestGroups(events, undefined, options?.duplicateWindowMs, topN);
  const queryGroups = resolveQueryGroups(events, undefined, topN);

  // The same query groups the `topQueries` section publishes: one aggregation
  // per call, so `query_count` and the rows below it are one fact.
  const metrics = metricValuesFrom(
    scan,
    summarizeRenderTriggers(renderStats),
    requestGroups,
    queryGroups,
  );
  const unavailableMetrics = metrics
    .filter((metric) => !metric.available)
    .map((metric) => metric.id);

  const rankedSpans = [...scan.spans].sort(compareSpanCost).slice(0, topN);
  const selfTimes = collectSelfTimes(events, new Set(rankedSpans.map((event) => event.id)));
  const topSpans = rankedSpans.map((event) => toSpanSummary(event, selfTimes.get(event.id)));

  const topRenders = renderStats.slice(0, topN);
  const topRequests = requestGroups.slice(0, topN);
  const topQueries = queryGroups.slice(0, topN);
  const errors = [...scan.failures].sort(compareEventsCanonical).slice(0, topN).map(toErrorSummary);

  const traceIds = [...scan.traceWindows.keys()].sort(compareStrings);
  const publishedTraceIds = traceIds.slice(0, DEFAULT_MAX_TRACE_IDS);
  const primaryTraceId = selectPrimaryTraceId(scan.traceWindows);
  const componentTree =
    options?.includeComponentTree === true ? buildComponentTreeSnapshot(events) : undefined;

  const truncated =
    publishedTraceIds.length < traceIds.length ||
    topSpans.length < scan.spans.length ||
    topRenders.length < renderStats.length ||
    topRequests.length < requestGroups.length ||
    topQueries.length < queryGroups.length ||
    errors.length < scan.failures.length ||
    componentTree?.truncated === true;

  return {
    captureId: context.captureId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    startTime: scan.hasWindow ? scan.startTime : 0,
    endTime: scan.hasWindow ? scan.endTime : 0,
    durationMs: scan.hasWindow ? roundMs(clampNonNegative(scan.endTime - scan.startTime)) : 0,
    eventCount: scan.eventCount,
    traceCount: traceIds.length,
    traceIds: publishedTraceIds,
    ...(primaryTraceId !== undefined ? { primaryTraceId } : {}),
    producerIds: [...scan.producerIds].sort(compareStrings),
    tierCounts: scan.tierCounts,
    kindCounts: scan.kindCounts,
    metrics,
    topSpans,
    topRenders,
    topRequests,
    topQueries,
    errors,
    ...(componentTree !== undefined ? { componentTree } : {}),
    truncated,
    unavailableMetrics,
  };
}
