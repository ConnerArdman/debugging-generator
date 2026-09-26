/**
 * The panel-data resolver: the read-only query side of the panel subsystem.
 *
 * Every visualization node of a generated panel except the source-link leaf
 * carries a `DataQuery`, and `PanelHost` resolves each one through its
 * `DataProvider` into a request to `POST /sessions/:id/panel-data` (AAP 0.4.2).
 * This module is what answers that request: it takes a parsed, authorised
 * `DataQuery` and returns the `DataResult` member for its `source`, built from
 * the session's persisted evidence. `../server/routes/panel-data.ts` owns the
 * HTTP — parsing, authentication, the session binding — and calls
 * {@link PanelDataResolver.resolve}; nothing here knows about a request.
 *
 * ## Ten sources, one union, one paging rule
 *
 * The discriminants of `DataResult` are exactly `DATA_QUERY_SOURCES`, and the
 * resolver dispatches on `query.source` with an exhaustive `switch` closed by
 * `assertNever`: an eleventh source fails compilation here instead of silently
 * resolving to nothing. Each branch hands the **narrowed** `query.source` value
 * back as the result's discriminant, so the source a result claims and the
 * source that was asked for cannot disagree.
 *
 * Every source is composed from pieces that already exist, and none is
 * re-derived here:
 *
 * | source             | result                  | built from                                              |
 * |--------------------|-------------------------|---------------------------------------------------------|
 * | `trace`            | `TraceTree \| null`      | the service's `TraceCorrelator` (`../telemetry/correlate.ts`), narrowed by the filter and held to {@link TRACE_NODE_BUDGET} |
 * | `spans`, `events`  | `TelemetryEvent[]`      | `TelemetryRepo.query`, with filter, sort and page pushed down |
 * | `renders`          | `RenderStat[]`          | `aggregateRenders`                                      |
 * | `componentTree`    | snapshot `\| null`       | `buildComponentTreeSnapshot`                            |
 * | `requests`         | `RequestGroup[]`        | `aggregateRequests` (grouped by the ingest `request_key`, never by URL) |
 * | `queries`          | `QueryGroup[]`          | `aggregateQueries`                                      |
 * | `stateTransitions` | `StateTransition[]`     | `aggregateStateTransitions`                             |
 * | `graph`            | `DependencyGraphData`   | `buildDependencyGraph`                                  |
 * | `metrics`          | `MetricValue[]`         | the capture summary when it covers every event, else `computeMetrics` |
 *
 * ## Paging (AAP 0.4.2)
 *
 * "`filter` narrows, `sort` orders with a stable secondary key (`id`) per
 * source, `limit` (default 200, max 5 000) and `offset` (default 0) page the
 * array-valued sources and the response carries `total` and `nextOffset`."
 *
 * - {@link resolvePaging} fills the defaults from `@debuggen/panel-schema`'s
 *   `DATA_QUERY_DEFAULT_LIMIT` and `DATA_QUERY_DEFAULT_OFFSET`, **clamps** a
 *   larger limit to `DATA_QUERY_MAX_LIMIT` rather than refusing it, and refuses
 *   a negative or fractional value.
 * - {@link buildDataPage} computes the echo protocol's `DataPage` declares:
 *   `total` counted **before** paging, and `nextOffset` equal to `offset` plus
 *   the page length while the page returned something and more remain, and
 *   `null` — never an absent key — otherwise. A page that returned nothing is
 *   therefore always the last one, which is what makes a loop that follows
 *   `nextOffset` terminate.
 * - {@link SOURCE_SORT_KEYS} states, for **every** paged source and **every**
 *   `DataQuerySort`, the full comparator chain, and every chain ends in `id`
 *   ascending. The table's type is total, so a sort or a paged source added to
 *   either vocabulary fails compilation until it says what it orders by, and it
 *   makes that final key mandatory. Without it two rows that tie on the sort
 *   key could trade places between two reads, and a multi-page walk would
 *   repeat one and never show the other.
 * - A requested sort is always the order answered, applied to the whole
 *   filtered source **before** the page is cut, so the page echo never claims a
 *   query it did not honour; no named sort is ever replaced by another. An
 *   omitted sort means the source's entry in {@link DEFAULT_SORT_BY_SOURCE}.
 *   Where a row carries no field a sort names — a flat record has no count, a
 *   state transition no duration, a metric value no start — the chain ranks it
 *   by a value derived for exactly that sort (see {@link SOURCE_SORT_KEYS}), so
 *   the order is never unspecified and never silently another one.
 * - The three single-value sources (`trace`, `componentTree`, `graph`) carry no
 *   page and ignore `sort`. `metrics` is a paged source like the others: its
 *   values are ordered by the requested sort, and with none in `METRIC_IDS`
 *   order, and a default-sized page returns every one of them. The protocol
 *   validates a metrics page by the same window arithmetic as any other page,
 *   so an explicit `limit` or `offset` is honoured as a window over that order
 *   rather than ignored.
 *
 * ## Capture scoping
 *
 * Evidence is always read from **one** capture, chosen in this order:
 *
 * 1. **The rendered panel's capture.** A query sent for a node of a rendered
 *    panel names that panel (`panelId` on the request body, carried here as
 *    {@link PanelDataContext.panelId}), and the read is bound to the capture the
 *    panel was generated from — the `capture_id` its row was stored with — so a
 *    panel still on screen after a newer capture started keeps drawing the
 *    evidence its own findings cite. A panel the session does not hold is
 *    refused; a panel whose capture has been purged answers every source with
 *    its empty value, never with some other capture's evidence.
 * 2. **A named capture** ({@link PanelDataContext.captureId}), checked to belong
 *    to the session.
 * 3. **Live evidence**, when neither is named: the session's open capture, else
 *    its most recent one — each one indexed lookup, never a walk of the
 *    session's capture history.
 *
 * A read never spans captures, because two reproductions of an issue mixed into
 * one table would be evidence of neither. A session with no capture yet answers
 * every source with its empty value — an empty array, `null` or an empty graph —
 * which is a success the components render as their empty state.
 *
 * ## Filters
 *
 * `traceId`, `kinds`, `tier`, `minDuration` and `component` are pushed into the
 * store read for the flat sources, where the repository applies them with its
 * own indexes. The aggregate sources read the capture's events as whole slices
 * and hand them to the aggregate, and several of them need records the filter
 * would otherwise remove: a query's caller is found by walking up its parent
 * spans, a state transition's trigger is another record entirely, and a request
 * joins to its resource-timing entry. For those, the filter narrows the
 * aggregate's **subjects** — the records of the kind group it summarises —
 * while every other record of the capture (narrowed by `traceId` only) stays in
 * the slice as the context it resolves against. Both halves come from store
 * reads that apply the filter; the only thing done here is partitioning a read
 * by event kind — the column a store `kinds` narrowing filters on — and no
 * other filter field is re-implemented.
 *
 * The `trace` source applies the filter too, to the one tree it answers with:
 * `traceId` chooses the tree, and the other fields keep the nodes the store
 * matches for them **plus every ancestor of a match**, because a correlated
 * tree's structure is its meaning and a matched span shown without the path
 * that caused it would be a row with no context. The matching is again the
 * store's read, never a second implementation here.
 *
 * ## Completeness, and the one bound
 *
 * An aggregate is always computed from **every** event of its slice, so
 * `total`, `nextOffset` and every count an aggregate reports describe the
 * whole capture — the result carries no coverage field, so it may only ever be
 * complete. Each slice is **one scan** (`TelemetryRepo.scanEvents`): one count
 * over the filter and, when the selection fits, one ordered statement in
 * capture order (`start_time`, then `id`) — never a walk of pages, each with
 * its own count and offset. A subject-narrowed slice is two such scans, and
 * the shared traversal (below) two at most.
 *
 * The one bound is on memory: a slice larger than
 * {@link MAX_AGGREGATE_INPUT_EVENTS} — the two scans of one answer counted
 * together — is **refused** with `PANEL_INVALID` (reason
 * `aggregate-input-too-large`) and a hint to narrow the view, from the count
 * alone and without a row being read, rather than answered from a prefix that
 * would present partial totals as the capture's. A scan that contradicts its
 * own count or budget is refused with `STORE_ERROR` (reason
 * `scan-inconsistent`) rather than trusted. The unfiltered `metrics` source is
 * held to the same rule: a capture summary is served only when it was computed
 * from every event the capture now holds (its `eventCount` equals the
 * capture's stored count, read with `captureStamp`), and the values are
 * computed from the whole capture otherwise.
 *
 * A correlated tree is bounded separately, by {@link TRACE_NODE_BUDGET} nodes
 * in canonical pre-order, and a tree cut by it says so through its own
 * `truncated` flag — the one completeness marker the wire shape carries.
 *
 * ## The aggregate cache
 *
 * Computing an aggregate means reading and parsing its whole slice, and one
 * generated panel asks for several — each node separately, a paged table once
 * per page — over the same capture and, usually, the same filter.
 *
 * - **One traversal serves every aggregate source.** A cold read of a source
 *   whose slice is every kind (`queries`, `stateTransitions`, `graph`,
 *   `metrics`) reads the capture once under its filter — the trace's whole
 *   slice, plus the whole filter's selection when the filter narrows by more
 *   than the trace — and derives **all seven** aggregate sources' inputs from
 *   it by kind, each row for row and in the order its own read would return
 *   ({@link sharedAggregateInput}). A traversal that does not fit the ceiling
 *   is abandoned without an error and the source reads its own, narrower
 *   slice, so a view is refused only when its own slice is too large. A source
 *   whose slice is a subset of the kinds (`renders`, `componentTree`,
 *   `requests`) never widens its read: on a miss it reads its own slice.
 * - **One entry per capture and filter.** The resulting values are kept as one
 *   bundle, keyed by session, capture and filter (not by source), in a
 *   least-recently-used cache bounded by entry count
 *   ({@link AGGREGATE_CACHE_MAX_ENTRIES}) and by the events its entries' values
 *   were computed from ({@link AGGREGATE_CACHE_MAX_INPUT_EVENTS}). An entry
 *   weighs the events read by the writes it still holds — a traversal weighs
 *   what it read, however many sources it serves — so a 100 000-event capture
 *   is one entry of that weight rather than one per source.
 * - **Validated by the capture's generation.** Every read of an entry checks
 *   it against `captureGeneration` — a pragma and a lookup in the store's
 *   write ledger, which every insert into the capture and every purge moves,
 *   as does any other connection's commit — so a hit reads no telemetry row
 *   and counts nothing. The generation is read before, and in the same
 *   synchronous turn as, the reads a value is computed from, so a cached value
 *   always describes exactly the rows its generation names: a panel reloaded
 *   during a capture sees the evidence that has arrived since, and a stopped
 *   capture is traversed once.
 *
 * Only aggregates are cached — never events, never a failure.
 *
 * ## Privacy and failure (AAP 0.5.2, 0.5.5)
 *
 * Events arrive already redacted at ingest; nothing here re-redacts them and
 * nothing undoes a redaction. No request key is computed or exposed beyond the
 * aggregate's own output, and no session secret is read. Log records carry the
 * source, sort names, identifiers, counts and timings only — never an event
 * name, an attribute value, a URL or a statement. Every operation answers with a
 * `Result`; a store failure arrives as its own typed `Err`, a throw from a port
 * is converted to `STORE_ERROR`, and nothing throws out of this module.
 *
 * @example
 * ```ts
 * const resolver = createPanelDataResolver({ telemetry, correlator, sessions, captures, logger });
 * // A node of the rendered panel `panelId`: answered from that panel's capture.
 * const result = await resolver.resolve(
 *   { sessionId, panelId },
 *   { source: 'renders', sort: 'count_desc' },
 * );
 * if (result.ok && result.value.source === 'renders') {
 *   // result.value.renders, result.value.total, result.value.nextOffset
 * }
 * ```
 */

import { Buffer } from 'node:buffer';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SOURCES,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
} from '@debuggen/panel-schema';
import type { DataPage, DataResult, DataResultFor } from '@debuggen/protocol';
import { DebuggenError, assertNever, err, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, EventId, Logger, PanelId, Result, SessionId } from '@debuggen/shared';
import {
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  ERROR_KINDS,
  METRIC_IDS,
  PERF_KINDS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  aggregateQueries,
  aggregateRenders,
  aggregateRequests,
  aggregateStateTransitions,
  attributeKeysFor,
  buildComponentTreeSnapshot,
  buildDependencyGraph,
  buildTraceTree,
  computeMetrics,
  walkNode,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  MetricId,
  MetricUnit,
  MetricValue,
  TelemetryEvent,
  TelemetryKind,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import type { AnalysisSummarizer } from '../analysis/summarize.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import type { SessionsRepo, StoredCapture } from '../store/sessions-repo.js';
import type {
  CaptureEventStamp,
  CaptureGeneration,
  TelemetryGroupKey,
  TelemetryPage,
  TelemetryRepo,
  TelemetryScan,
  TelemetryScanFilter,
} from '../store/telemetry-repo.js';
import type { TraceCorrelator } from '../telemetry/correlate.js';

/* -------------------------------------------------------------------------------------------------
 * Source classification, derived from the result union
 * ---------------------------------------------------------------------------------------------- */

/**
 * The sources whose result carries a `DataPage` echo.
 *
 * Derived from protocol's `DataResult` rather than listed: a member is paged
 * exactly when it declares `nextOffset`, so a source added to the union with a
 * page joins this type in the same edit, and every table below keyed by it
 * fails to compile until it says what the new source means.
 */
export type PagedDataSource = Extract<DataResult, { readonly nextOffset: unknown }>['source'];

/**
 * The single-value sources: one tree, one snapshot, one graph. No page, no
 * sort, no window.
 */
export type SingleValueDataSource = Exclude<DataQuerySource, PagedDataSource>;

/**
 * The paged sources whose order a query may choose: **every** paged source.
 *
 * `metrics` included. A metric card addresses a value by id, so the order of
 * the list never changes what a card shows, but a panel that pages the values
 * or ranks them — the longest durations, the largest counts — reads that order,
 * and the shared `DataQuery` schema accepts every sort on it. Kept as its own
 * name because it is what every ordering table is keyed by.
 */
export type SortedDataSource = PagedDataSource;

/**
 * The payload field of one source's result — `DataResultFor<'renders'>['renders']`
 * and so on.
 *
 * @typeParam S One query source.
 */
type PayloadOf<S extends DataQuerySource> =
  DataResultFor<S> extends infer R ? (S extends keyof R ? R[S] : never) : never;

/**
 * One row of a paged source's payload: `TelemetryEvent` for the flat sources,
 * `RenderStat`, `RequestGroup`, `QueryGroup`, `StateTransition` and
 * `MetricValue` for the others.
 *
 * Read off the protocol's result type, so the rows this module orders are the
 * rows the response is validated against.
 *
 * @typeParam S One paged source.
 */
export type DataRowOf<S extends PagedDataSource> =
  PayloadOf<S> extends readonly (infer Row)[] ? Row : never;

/* -------------------------------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------------------------------- */

/** Which way one key of a comparator chain orders. */
export type SortDirection = 'asc' | 'desc';

/** A value one key of a comparator chain ranks by. */
export type SortValue = number | string;

/**
 * How a key compares two strings.
 *
 * - `utf16` — by UTF-16 code unit, JavaScript's own `<`: the default, and the
 *   order of every chain this module evaluates in memory.
 * - `utf8` — by the strings' UTF-8 bytes, which is SQLite's default `BINARY`
 *   collation: the order of a chain the store executes, stated here as data.
 *
 * The two disagree only for a character above U+FFFF against one in
 * U+E000–U+FFFF. Neither is `localeCompare`, whose answer depends on the host's
 * locale and would let two machines page one capture differently.
 */
export type StringCollation = 'utf16' | 'utf8';

/**
 * The fields of `Row` a comparator can read: the required ones holding a
 * number or a string.
 *
 * An optional field is excluded by construction — `string | undefined` does
 * not extend `string` — so no field key can rank rows by a value some of them
 * lack. A value some rows lack is ranked only through a {@link DerivedSortKey},
 * whose rule for the rows without one is part of its definition.
 */
type ComparableField<Row> = {
  [K in keyof Row]-?: Row[K] extends SortValue ? K : never;
}[keyof Row] &
  string;

/** One key of a comparator chain that reads a required field of the row. */
export interface FieldSortKey<Row> {
  /** The row field compared. */
  readonly field: ComparableField<Row>;
  /** The direction the field orders in. */
  readonly direction: SortDirection;
  /** How a string value compares; `'utf16'` when absent. Numbers compare numerically. */
  readonly collation?: StringCollation;
}

/**
 * The values a chain may rank by that no row carries as a required field of
 * its own, each derived for exactly the sort that needs it (see
 * {@link SOURCE_SORT_KEYS}):
 *
 * - `nameGroupSize` — how many records of the ordered set share the record's
 *   operation `name`;
 * - `hookGroupSize` — how many transitions of the ordered set share the
 *   transition's hook, the pair (`component`, `hookIndex`); none for a row that
 *   names neither half;
 * - `hookComponent`, `hookIndex` — the two halves of that hook identity, none
 *   where the row lacks one;
 * - `eventDuration` — the measured duration of the event a row projects, none
 *   where it is unknown;
 * - `metricPosition` — a metric value's position in `METRIC_IDS`;
 * - `measuredMilliseconds`, `measuredCount` — a metric's value when it was
 *   measured and its unit is `milliseconds` (respectively `count`), none
 *   otherwise.
 *
 * A closed vocabulary, so a suite can hold every derived key to a derivation of
 * its own, written independently of the ones below.
 */
export type DerivedSortKeyName =
  | 'nameGroupSize'
  | 'hookGroupSize'
  | 'hookComponent'
  | 'hookIndex'
  | 'eventDuration'
  | 'metricPosition'
  | 'measuredMilliseconds'
  | 'measuredCount';

/** What a derived key may read besides the rows it orders. */
export interface SortContext {
  /**
   * The measured duration of each event a row projects, by event id: what
   * ranks a state transition — whose row carries no duration — by the `state`
   * event it was built from. Empty for every source that has none to offer.
   */
  readonly eventDurations: ReadonlyMap<EventId, number>;
}

/** The context of an ordering with nothing to offer beyond its rows. */
const EMPTY_SORT_CONTEXT: SortContext = Object.freeze({
  eventDurations: new Map<EventId, number>(),
});

/**
 * One key of a comparator chain whose value is derived rather than read.
 *
 * `evaluate` runs **once per ordering**, over the whole set being ordered —
 * never per comparison and never per page — and answers one value per row,
 * aligned with the rows. That is what lets a value depend on the set (a
 * group's size) or on the context (an event's duration) while a sort of `n`
 * rows stays one derivation plus `O(n log n)` comparisons. A row the key has no
 * value for — `undefined`, or a number that is not finite — ranks **after every
 * row with one, in either direction**, the store's rule for a row that belongs
 * to no group; rows without a value tie on the key and are ordered by the rest
 * of the chain.
 *
 * @typeParam Row The row type the key ranks.
 */
export interface DerivedSortKey<Row> {
  /** What the key ranks by. */
  readonly derived: DerivedSortKeyName;
  /** The direction the value orders in. */
  readonly direction: SortDirection;
  /** How a string value compares; `'utf16'` when absent. Numbers compare numerically. */
  readonly collation?: StringCollation;
  /**
   * Every row's value, in row order.
   *
   * @param rows The whole set being ordered.
   * @param context What the source offers beyond its rows.
   * @returns One value per row, `undefined` where the row has none.
   */
  readonly evaluate: (
    rows: readonly Row[],
    context: SortContext,
  ) => readonly (SortValue | undefined)[];
}

/** One key of a comparator chain: a field of the row, or a value derived for the sort. */
export type SortKey<Row> = FieldSortKey<Row> | DerivedSortKey<Row>;

/**
 * A complete comparator chain: any number of keys, then **`id` ascending**.
 *
 * The final element is fixed by the type, so a chain that omits the stable
 * secondary key AAP 0.4.2 requires — or that names a row without an `id` — does
 * not compile. `id` is unique within every paged source (an event id, a
 * `render:` or request-group id derived from the group key, a state-transition
 * row's event id, a metric id), which is what makes each chain a total order
 * and each page boundary exact.
 *
 * @typeParam Row The row type the chain orders.
 */
export type SortChain<Row> = readonly [
  ...SortKey<Row>[],
  FieldSortKey<Row> & { readonly field: 'id'; readonly direction: 'asc' },
];

/** Whether a key is derived rather than read from a field. */
function isDerivedKey<Row>(key: SortKey<Row>): key is DerivedSortKey<Row> {
  return 'derived' in key;
}

/** A finite number, or `undefined`: the only numbers a derived key ranks by. */
function finiteOrAbsent(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/**
 * How many of `keys` equal each one, aligned with `keys`; an `undefined` key
 * belongs to no group and has no size.
 *
 * The keys are held in memory for the count only — never logged, never
 * returned — because a key is built from captured names.
 */
function groupSizes(keys: readonly (string | undefined)[]): (number | undefined)[] {
  const sizes = new Map<string, number>();
  for (const key of keys) {
    if (key !== undefined) {
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
  }
  return keys.map((key) => (key === undefined ? undefined : sizes.get(key)));
}

/** One row of the `stateTransitions` source. */
type StateTransitionRow = DataRowOf<'stateTransitions'>;

/** One row of the `metrics` source. */
type MetricRow = DataRowOf<'metrics'>;

/**
 * The identity of a transition's hook — the pair (`component`, `hookIndex`) —
 * as a collision-free text, or `undefined` for a row that names neither half
 * (the truncation sentinel), which belongs to no hook.
 *
 * A JSON pair rather than a joined string, so no component name can collide
 * with another pair. Used only to count rows per hook; the order between hooks
 * is decided by the `hookComponent` and `hookIndex` keys themselves.
 */
function hookIdentity(row: StateTransitionRow): string | undefined {
  if (row.component === undefined && row.hookIndex === undefined) {
    return undefined;
  }
  return JSON.stringify([row.component ?? null, row.hookIndex ?? null]);
}

/** `nameGroupSize`: each record's operation-name group size within the ordered set. */
function nameGroupSizes(rows: readonly TelemetryEvent[]): readonly (SortValue | undefined)[] {
  return groupSizes(rows.map((row) => row.name));
}

/** `hookGroupSize`: each transition's hook group size within the ordered set. */
function hookGroupSizes(rows: readonly StateTransitionRow[]): readonly (SortValue | undefined)[] {
  return groupSizes(rows.map(hookIdentity));
}

/** `hookComponent`: each transition's component, where it names one. */
function hookComponents(rows: readonly StateTransitionRow[]): readonly (SortValue | undefined)[] {
  return rows.map((row) => row.component);
}

/** `hookIndex`: each transition's hook index, where it names one. */
function hookIndexes(rows: readonly StateTransitionRow[]): readonly (SortValue | undefined)[] {
  return rows.map((row) => finiteOrAbsent(row.hookIndex));
}

/** `eventDuration`: the measured duration of the `state` event each transition projects. */
function transitionEventDurations(
  rows: readonly StateTransitionRow[],
  context: SortContext,
): readonly (SortValue | undefined)[] {
  return rows.map((row) => finiteOrAbsent(context.eventDurations.get(row.eventId)));
}

/** Each metric id's position in `METRIC_IDS`, the vocabulary order. */
const METRIC_POSITIONS: ReadonlyMap<MetricId, number> = new Map(
  METRIC_IDS.map((id, position) => [id, position] as const),
);

/** `metricPosition`: each value's position in `METRIC_IDS`. */
function metricPositions(rows: readonly MetricRow[]): readonly (SortValue | undefined)[] {
  return rows.map((row) => METRIC_POSITIONS.get(row.id));
}

/** The unit whose measured values `duration_desc` ranks first among the metrics. */
const DURATION_METRIC_UNIT = 'milliseconds' satisfies MetricUnit;

/** The unit whose measured values `count_desc` ranks first among the metrics. */
const COUNT_METRIC_UNIT = 'count' satisfies MetricUnit;

/**
 * The derivation of a metric measure key: each value's measured number when
 * the capture measured it (`available`) and its unit is `unit`, and none
 * otherwise — so every other value ranks after the measured ones.
 */
function measuredIn(
  unit: MetricUnit,
): (rows: readonly MetricRow[]) => readonly (SortValue | undefined)[] {
  return (rows) =>
    rows.map((row) => (row.available && row.unit === unit ? finiteOrAbsent(row.value) : undefined));
}

/** `measuredMilliseconds`: the measured durations. */
const measuredMilliseconds = measuredIn(DURATION_METRIC_UNIT);

/** `measuredCount`: the measured counts. */
const measuredCounts = measuredIn(COUNT_METRIC_UNIT);

/**
 * The group key the flat sources' `count_desc` ranks records by, sent with
 * every page read: the operation `name`, the one key every stored row carries,
 * so no record falls into the ungrouped tail. Named explicitly rather than
 * left to the store's default, so the statement the store runs and the
 * `nameGroupSize` key of {@link SOURCE_SORT_KEYS} can only describe one
 * grouping.
 */
const FLAT_SOURCE_GROUP_KEY = 'name' satisfies TelemetryGroupKey;

/** The flat sources' `count_desc` chain: the store's ranking by operation-name group. */
const FLAT_COUNT_DESC_CHAIN: SortChain<TelemetryEvent> = [
  { derived: 'nameGroupSize', direction: 'desc', evaluate: nameGroupSizes },
  { field: FLAT_SOURCE_GROUP_KEY, direction: 'asc', collation: 'utf8' },
  { field: 'id', direction: 'asc' },
];

/**
 * For every sortable source, the chain **every** sort orders it by.
 *
 * Total by type — a `Record` over the whole `DataQuerySort` vocabulary for each
 * source — so no requested sort can find a source without an ordering, and a
 * sort added to the vocabulary fails compilation here until every source says
 * what it means.
 */
export type SourceSortKeys = {
  readonly [S in SortedDataSource]: Readonly<Record<DataQuerySort, SortChain<DataRowOf<S>>>>;
};

/**
 * The comparator chains of every sortable source under every sort — the stable
 * ordering half of the paging contract. Each chain is applied to the whole
 * filtered source before a page is cut.
 *
 * - **`spans`, `events`** — ordered by the store, which is where filtering and
 *   paging of those sources happen; the chains state its orderings as data.
 *   `duration_desc` and `start_asc` are `PANEL_DURATION_DESC_ORDER_BY` and
 *   `PANEL_START_ASC_ORDER_BY` (`../store/telemetry-repo.ts`): duration
 *   descending or start ascending, then the event id. `count_desc` is the
 *   store's row ranking under the group key the resolver sends with the read
 *   (`name`): each record ranked by how many records of the filtered source
 *   share its operation name — `COUNT(name) OVER (PARTITION BY name) DESC` —
 *   the most frequent operation first; then the name itself in UTF-8 byte
 *   order (SQLite's `BINARY` collation), which keeps one operation's records
 *   together and separates two equally frequent ones; then the event id.
 * - **`renders`** — most renders, most total render time, or earliest first
 *   render, then the `render:` id.
 * - **`requests`** — largest group first, with the more redundant of two
 *   equally frequent groups ahead (duplicates are the finding this source
 *   exists for); or most total time; or earliest first occurrence; then the
 *   group id.
 * - **`queries`** — most executions, most total time, or earliest first
 *   execution, then the group id.
 * - **`stateTransitions`** — `start_asc` in the order the transitions happened.
 *   `count_desc` ranks each transition by how many transitions of the whole
 *   ordered set share its hook — the pair (`component`, `hookIndex`) — the most
 *   frequently changing hook first; then the hook identity ascending (the
 *   component by code unit, then the hook index), which keeps one hook's
 *   transitions together; then the start time and the id. A row naming neither
 *   half of a hook — the truncation sentinel — belongs to no group and ranks
 *   after every group, the store's rule for an ungrouped row. `duration_desc`
 *   ranks each transition by the measured duration of the `state` event it
 *   projects (its `eventId`, which is also its `id`), longest first, a row
 *   whose event duration is unknown after every row with one; then the start
 *   time and the id. The browser producer (`packages/telemetry/src/browser/
 *   state.ts`) records every transition as an instant of duration 0, so its
 *   transitions tie and are, in practice, ordered chronologically — but a
 *   producer's non-zero durations are honoured.
 * - **`metrics`** — every value describes the same capture window, so under
 *   `start_asc` they all tie on start and their `METRIC_IDS` position decides:
 *   the vocabulary order, which is also the order with no sort. `duration_desc`
 *   puts the measured values whose unit is `milliseconds` first, largest
 *   first; `count_desc` does the same for the values whose unit is `count`.
 *   Under both, every other value — another unit, or `available: false` —
 *   follows in `METRIC_IDS` order, and equal values are separated by that
 *   position too; the id comes last.
 */
export const SOURCE_SORT_KEYS: SourceSortKeys = Object.freeze({
  spans: {
    duration_desc: [
      { field: 'duration', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: FLAT_COUNT_DESC_CHAIN,
  },
  events: {
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'duration', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: FLAT_COUNT_DESC_CHAIN,
  },
  renders: {
    count_desc: [
      { field: 'renderCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  requests: {
    count_desc: [
      { field: 'count', direction: 'desc' },
      { field: 'duplicateCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  queries: {
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: [
      { field: 'executionCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  stateTransitions: {
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: [
      { derived: 'hookGroupSize', direction: 'desc', evaluate: hookGroupSizes },
      { derived: 'hookComponent', direction: 'asc', evaluate: hookComponents },
      { derived: 'hookIndex', direction: 'asc', evaluate: hookIndexes },
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { derived: 'eventDuration', direction: 'desc', evaluate: transitionEventDurations },
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  metrics: {
    start_asc: [
      { derived: 'metricPosition', direction: 'asc', evaluate: metricPositions },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { derived: 'measuredMilliseconds', direction: 'desc', evaluate: measuredMilliseconds },
      { derived: 'metricPosition', direction: 'asc', evaluate: metricPositions },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: [
      { derived: 'measuredCount', direction: 'desc', evaluate: measuredCounts },
      { derived: 'metricPosition', direction: 'asc', evaluate: metricPositions },
      { field: 'id', direction: 'asc' },
    ],
  },
});

/**
 * The order each sortable source takes when a query names no sort.
 *
 * Each is the question the source is read for — and the order the renderer's
 * own table for it opens in: the slowest work first for `spans` (the "slowest
 * operations" ranking), capture order for the `events` log, the busiest
 * components and the most repeated requests first, the costliest statements
 * first, transitions in the order they happened, and the metric values in
 * `METRIC_IDS` order (`start_asc`, under which they all tie on start). A named
 * sort is never replaced by this default: every sort has a chain on every
 * source ({@link SOURCE_SORT_KEYS}).
 */
export const DEFAULT_SORT_BY_SOURCE: Readonly<Record<SortedDataSource, DataQuerySort>> =
  Object.freeze({
    spans: 'duration_desc',
    events: 'start_asc',
    renders: 'count_desc',
    requests: 'count_desc',
    queries: 'duration_desc',
    stateTransitions: 'start_asc',
    metrics: 'start_asc',
  });

/**
 * The sort a query on `source` is answered in: the requested one whenever the
 * query names one — every sort orders every sortable source — and the source's
 * default ({@link DEFAULT_SORT_BY_SOURCE}) when it names none.
 *
 * @param source A sortable source.
 * @param requested The query's `sort`, possibly absent.
 * @returns The sort whose chain in {@link SOURCE_SORT_KEYS} orders the answer.
 */
export function effectiveSort(
  source: SortedDataSource,
  requested: DataQuerySort | undefined,
): DataQuerySort {
  return requested ?? DEFAULT_SORT_BY_SOURCE[source];
}

/**
 * Compares two values of one key.
 *
 * Numbers numerically; strings by UTF-16 code unit, or by UTF-8 bytes under
 * the `utf8` collation — never `localeCompare` (see {@link StringCollation}).
 * A number sorts before a string and a value of any other type after both;
 * neither case is reachable, because a field key admits only required number
 * or string fields and each derived key yields one type.
 */
function compareValues(left: unknown, right: unknown, collation: StringCollation): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (left === right) {
      return 0;
    }
    if (collation === 'utf8') {
      return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
    }
    return left < right ? -1 : 1;
  }
  return typeRank(left) - typeRank(right);
}

/** The rank of a value's type in {@link compareValues}: numbers, strings, then anything else. */
function typeRank(value: unknown): number {
  if (typeof value === 'number') {
    return 0;
  }
  return typeof value === 'string' ? 1 : 2;
}

/**
 * A derived value as it is ranked: a string, or a finite number; anything else
 * — `undefined`, `NaN`, an infinity — is "no value", which ranks last.
 */
function rankable(value: SortValue | undefined): SortValue | undefined {
  return typeof value === 'number' ? finiteOrAbsent(value) : value;
}

/**
 * Compares two rows' values of one derived key: rows with a value in the key's
 * direction, and every row without one after them in either direction.
 */
function compareDerived(
  left: SortValue | undefined,
  right: SortValue | undefined,
  direction: SortDirection,
  collation: StringCollation,
): number {
  const leftValue = rankable(left);
  const rightValue = rankable(right);
  if (leftValue === undefined || rightValue === undefined) {
    if (leftValue === rightValue) {
      return 0;
    }
    return leftValue === undefined ? 1 : -1;
  }
  const order = compareValues(leftValue, rightValue, collation);
  return direction === 'desc' ? -order : order;
}

/**
 * Orders rows by a comparator chain, into a fresh array.
 *
 * Every derived key is evaluated once, over the whole of `rows`, before any
 * comparison; the rows are then compared key by key, a field key reading the
 * row and a derived key reading the value evaluated for it. The input is never
 * sorted in place: it may be an aggregate's own result, which that aggregate
 * documents as being in its base order.
 *
 * @param rows The rows to order — the whole set, never a page of it, since a
 * derived value may depend on every row.
 * @param chain The chain, ending in `id` ascending.
 * @param context What a derived key may read besides the rows; empty unless
 * the source supplies something (the `stateTransitions` event durations).
 * @returns A new array in chain order.
 *
 * @example
 * ```ts
 * // Largest group first, then the id.
 * orderRows(groups, [
 *   { field: 'count', direction: 'desc' },
 *   { field: 'id', direction: 'asc' },
 * ]);
 * ```
 */
export function orderRows<Row>(
  rows: readonly Row[],
  chain: SortChain<Row>,
  context: SortContext = EMPTY_SORT_CONTEXT,
): Row[] {
  const keys: readonly SortKey<Row>[] = chain;
  const steps = keys.map((key) => ({
    key,
    values: isDerivedKey(key) ? key.evaluate(rows, context) : undefined,
  }));
  const entries = rows.map((row, index) => ({ row, index }));
  entries.sort((left, right) => {
    for (const { key, values } of steps) {
      let order: number;
      if (isDerivedKey(key)) {
        order = compareDerived(
          values?.[left.index],
          values?.[right.index],
          key.direction,
          key.collation ?? 'utf16',
        );
      } else {
        const compared = compareValues(
          left.row[key.field],
          right.row[key.field],
          key.collation ?? 'utf16',
        );
        order = key.direction === 'desc' ? -compared : compared;
      }
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
  return entries.map((entry) => entry.row);
}

/* -------------------------------------------------------------------------------------------------
 * Paging
 * ---------------------------------------------------------------------------------------------- */

/** The page window the service applies: the query's own values, defaulted and clamped. */
export interface ResolvedPaging {
  /** Items to return, at most `DATA_QUERY_MAX_LIMIT`. Zero is a count-only request. */
  readonly limit: number;
  /** Items to skip before the page. */
  readonly offset: number;
}

/** A page of in-memory rows and the echo describing it. */
export interface PagedRows<Row> {
  /** The rows inside the window. */
  readonly items: Row[];
  /** The `DataPage` echo for those rows. */
  readonly page: DataPage;
}

/** The recovery instruction every paging refusal carries. */
const PAGING_HINT =
  'Send limit and offset as whole numbers of zero or more, or omit them to accept the defaults.';

/** Whether `value` is a whole number of zero or more that arithmetic keeps exact. */
function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The page window for a query.
 *
 * `limit` is the query's own value or `DATA_QUERY_DEFAULT_LIMIT`, **clamped** to
 * `DATA_QUERY_MAX_LIMIT` — a panel asking for more gets the ceiling and a
 * `total` that says more remain. `offset` is the query's own value or
 * `DATA_QUERY_DEFAULT_OFFSET`; an offset past the end is legal and answers with
 * an empty last page.
 *
 * @param query The query's paging fields.
 * @returns The window, or `PANEL_INVALID` naming the field — never its value —
 * when a field is negative, fractional or not finite.
 */
export function resolvePaging(
  query: Pick<DataQuery, 'limit' | 'offset'>,
): Result<ResolvedPaging, DebuggenError> {
  const limit = query.limit ?? DATA_QUERY_DEFAULT_LIMIT;
  const offset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;

  for (const [field, value] of [
    ['limit', limit],
    ['offset', offset],
  ] as const) {
    if (!isNonNegativeInteger(value)) {
      return err(
        new DebuggenError(
          'PANEL_INVALID',
          `The data query's ${field} is not a whole number of zero or more.`,
          {
            hint: PAGING_HINT,
            details: { field, reason: 'not-a-non-negative-integer' },
          },
        ),
      );
    }
  }

  return ok({ limit: Math.min(limit, DATA_QUERY_MAX_LIMIT), offset });
}

/**
 * The `DataPage` echo for a window over `total` items that returned `returned`
 * of them.
 *
 * `nextOffset` is `offset + returned` while the page returned at least one item
 * and items remain after it, and `null` otherwise: a page that returned nothing —
 * a count-only `limit: 0`, or an offset at or past the end — is the last page,
 * so a loop following `nextOffset` always advances and always stops. This is the
 * rule protocol's metrics member validates and the store's own pages follow.
 *
 * @param total Items the filtered source holds, before paging.
 * @param paging The applied window.
 * @param returned Items actually on the page.
 * @returns The echo.
 */
export function buildDataPage(total: number, paging: ResolvedPaging, returned: number): DataPage {
  const following = paging.offset + returned;
  return {
    total,
    limit: paging.limit,
    offset: paging.offset,
    nextOffset: returned > 0 && following < total ? following : null,
  };
}

/**
 * Applies a window to rows already in their final order.
 *
 * @param rows Every row of the filtered source, ordered.
 * @param paging The window.
 * @returns The rows inside it and their echo, `total` being `rows.length`.
 */
export function applyPage<Row>(rows: readonly Row[], paging: ResolvedPaging): PagedRows<Row> {
  const items = rows.slice(paging.offset, paging.offset + paging.limit);
  return { items, page: buildDataPage(rows.length, paging, items.length) };
}

/**
 * The echo for a page the store computed.
 *
 * `total` and `nextOffset` are the store's — it counts in table rows and
 * advances past rows it had to skip as unreadable, which only it can see — and
 * its absent `nextOffset` becomes the `null` the protocol requires. A
 * `nextOffset` that would not advance is treated as the end, so a malformed
 * store answer can never make a caller request the same page forever.
 */
function pageFromStore(page: TelemetryPage, paging: ResolvedPaging): DataPage {
  const next = page.nextOffset;
  return {
    total: page.total,
    limit: paging.limit,
    offset: paging.offset,
    nextOffset: next !== undefined && next > paging.offset ? next : null,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Kind groups — derived from `@debuggen/telemetry`'s vocabulary, never listed
 * ---------------------------------------------------------------------------------------------- */

/**
 * Deduplicated union of kind groups, in vocabulary order.
 *
 * @param groups Kind groups from `@debuggen/telemetry`.
 * @returns Every kind in at least one group, ordered as `TELEMETRY_KINDS` is.
 */
function unionOfKinds(...groups: readonly (readonly TelemetryKind[])[]): readonly TelemetryKind[] {
  return Object.freeze(
    TELEMETRY_KINDS.filter((kind) => groups.some((group) => group.includes(kind))),
  );
}

/**
 * The kind groups whose records are instants rather than work.
 *
 * `packages/telemetry/src/schema/event.ts` names failures and hook state
 * transitions as records whose zero duration is their nature, not a
 * measurement; a ranking of work by duration has nothing to say about them, and
 * the event log is where they are read.
 */
const INSTANT_KIND_GROUPS: readonly (readonly TelemetryKind[])[] = Object.freeze([
  ERROR_KINDS,
  STATE_KINDS,
]);

/**
 * The kinds the `spans` source reads: every kind except the instant groups.
 *
 * `events` reads every kind. A query's own `kinds` filter narrows either set
 * further and never widens it.
 */
export const SPAN_SOURCE_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => !INSTANT_KIND_GROUPS.some((group) => group.includes(kind))),
);

/**
 * The kinds that carry a component-tree snapshot: those whose declared
 * attribute keys include every component-tree key.
 *
 * Resolved from the attribute registry, the way `aggregate/renders.ts` resolves
 * the same kind, so no kind string is written here.
 */
const COMPONENT_SNAPSHOT_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => {
    const declared = attributeKeysFor(kind);
    return COMPONENT_TREE_ATTRIBUTE_KEYS.every((key) => declared.includes(key));
  }),
);

/**
 * The narrowest kind set an aggregate can be computed from, or `undefined` for
 * every kind; and the kind group whose records are its subjects, or
 * `undefined` when every record read is one.
 */
interface AggregateReadPlan {
  /** The kinds read as the aggregate's input slice; `undefined` reads every kind. */
  readonly sliceKinds: readonly TelemetryKind[] | undefined;
  /**
   * The kinds a filter narrows while the rest of the slice stays whole, for an
   * aggregate that resolves its subjects against other records. `undefined`
   * pushes the whole filter into the one read.
   */
  readonly subjectKinds: readonly TelemetryKind[] | undefined;
}

/** The paged or single-value sources computed from a slice of events. */
type AggregateDataSource = Exclude<DataQuerySource, 'trace' | 'spans' | 'events'>;

/**
 * How each aggregate source reads its slice.
 *
 * - `renders` — render and commit records only; every one is a subject.
 * - `componentTree` — renders, commits and the snapshot records; every one is a
 *   subject, so a `component` filter reconstructs the paths leading to that
 *   component from its own renders.
 * - `requests` — requests plus the performance entries they join to for
 *   transfer sizes; the requests are the subjects.
 * - `queries` — every kind, because a caller is found by walking up the
 *   statement's parent spans; the statements are the subjects.
 * - `stateTransitions` — every kind, because a trigger is any other record;
 *   the transitions are the subjects.
 * - `graph` — every kind, and every record is a participant, so the filter
 *   narrows the participants directly.
 * - `metrics` — every kind; a filtered metrics read computes the values over
 *   the records the filter selects.
 *
 * The four every-kind plans are the sources that take the shared traversal on
 * a cache miss ("The aggregate cache" above); the other three read their own
 * slice. Either way, these plans define each source's input: the shared
 * traversal derives exactly the rows these reads return.
 */
const AGGREGATE_READ_PLANS: Readonly<Record<AggregateDataSource, AggregateReadPlan>> =
  Object.freeze({
    renders: { sliceKinds: RENDER_KINDS, subjectKinds: undefined },
    componentTree: {
      sliceKinds: unionOfKinds(RENDER_KINDS, COMPONENT_SNAPSHOT_KINDS),
      subjectKinds: undefined,
    },
    requests: { sliceKinds: unionOfKinds(REQUEST_KINDS, PERF_KINDS), subjectKinds: REQUEST_KINDS },
    queries: { sliceKinds: undefined, subjectKinds: QUERY_KINDS },
    stateTransitions: { sliceKinds: undefined, subjectKinds: STATE_KINDS },
    graph: { sliceKinds: undefined, subjectKinds: undefined },
    metrics: { sliceKinds: undefined, subjectKinds: undefined },
  });

/**
 * The intersection of two kind narrowings, `undefined` meaning "every kind".
 *
 * @returns `undefined` when neither narrows; otherwise the kinds in both, in
 * the first narrowing's order.
 */
function intersectKinds(
  left: readonly TelemetryKind[] | undefined,
  right: readonly TelemetryKind[] | undefined,
): readonly TelemetryKind[] | undefined {
  if (left === undefined) {
    return right === undefined ? undefined : unionOfKinds(right);
  }
  if (right === undefined) {
    return left;
  }
  return Object.freeze(left.filter((kind) => right.includes(kind)));
}

/* -------------------------------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The most events one panel read aggregates: `250 000`.
 *
 * A memory ceiling, not a window. An aggregate is computed from **every**
 * event of its slice or not at all: the store's scan counts a slice before it
 * reads a row (`TelemetryRepo.scanEvents`), and a slice counted above this —
 * both halves of a subject-narrowed slice together — is refused with
 * `PANEL_INVALID` (reason `aggregate-input-too-large`) without its events being
 * read, with a hint to narrow the view, because an answer computed from a
 * prefix would carry totals the protocol presents as the capture's. The shared
 * traversal is held to it too, its two reads together; one that does not fit
 * is abandoned for the source's own slice rather than refused.
 *
 * Sized from a measurement: a parsed event of the shapes the agent and the
 * preload emit holds about 0.66 KB on a Node 24 heap, so a slice at the ceiling
 * is about 165 MB for the duration of one read. A capture of a reproduced
 * interaction is two to three orders of magnitude smaller; the ceiling exists
 * for the capture left running for hours, which must fail loudly rather than
 * take the service's memory with it.
 */
export const MAX_AGGREGATE_INPUT_EVENTS = 250_000;

/**
 * The most nodes a `trace` answer holds: `5 000`, the protocol's page ceiling.
 *
 * A correlated tree is one value rather than a page, so it cannot be paged
 * through; a tree larger than this is cut to its first nodes in canonical
 * pre-order — which keeps every kept node's ancestors, so the answer is still
 * one connected tree per root — and says so through `truncated: true`, the
 * flag `TraceTree` carries for exactly this ("a caller's node budget").
 */
export const TRACE_NODE_BUDGET = DATA_QUERY_MAX_LIMIT;

/**
 * How many cache entries the resolver keeps: `64`.
 *
 * One entry holds every aggregate source of one capture under one filter, so
 * this is enough for the distinct filters of a few generated panels at once,
 * across their captures. Past it the least recently used entry is evicted.
 */
export const AGGREGATE_CACHE_MAX_ENTRIES = 64;

/**
 * The most events the cached entries' values may have been computed from,
 * together: {@link MAX_AGGREGATE_INPUT_EVENTS}.
 *
 * An aggregate is a reduction or a projection of its input, so its size is at
 * most proportional to the events it was computed from. An entry weighs the
 * events read by the writes it still holds — one traversal weighs what it
 * read, whichever sources it serves, and a write whose every slot a later one
 * replaced weighs nothing — and least recently used entries are evicted while
 * the sum is above this, which bounds the cache at about the size of one slice
 * at the ceiling however many sessions and captures its entries describe. A
 * merge into an entry that would weigh more than this keeps the newest write
 * alone, and a write weighing more on its own is answered but not kept.
 */
export const AGGREGATE_CACHE_MAX_INPUT_EVENTS = MAX_AGGREGATE_INPUT_EVENTS;

/* -------------------------------------------------------------------------------------------------
 * Ports and dependencies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The telemetry reads this module performs, picked from `TelemetryRepo`:
 *
 * - `query` — the panel-data surface of the store: one filtered, ordered page,
 *   which is how the flat `spans` and `events` sources are served.
 * - `scanEvents` — the whole of a filtered selection in capture order, or the
 *   statement that it exceeds a row budget: one count and at most one ordered
 *   statement, never a page walk. Every aggregate slice, and the node matching
 *   of a filtered `trace`, is one such call.
 * - `firstTraceId` — a capture's earliest trace (earliest start, then the
 *   first-arrived event), one indexed read, for a `trace` query that names
 *   none and has no primary trace to fall back on.
 * - `captureStamp` — a capture's event count and highest arrival number, one
 *   covering index read: what tells a stored capture summary that still
 *   covers every event from one that no longer does.
 * - `captureGeneration` — where a capture's rows stand, read without touching
 *   a telemetry row: what every cached aggregate is validated against.
 *
 * A consumer-side port picked from the production interface, so the real
 * repository satisfies it by construction and a suite supplies a plain object
 * with five functions instead of an open database.
 */
export type PanelTelemetryPort = Pick<
  TelemetryRepo,
  'query' | 'scanEvents' | 'firstTraceId' | 'captureStamp' | 'captureGeneration'
>;

/** The trace read this module performs, picked from the service's `TraceCorrelator`. */
export type PanelTracePort = Pick<TraceCorrelator, 'getTrace'>;

/**
 * The capture lookups this module performs, picked from `SessionsRepo`, each
 * one indexed read: a named capture's owner, a rendered panel's capture, and a
 * session's open and most recent captures.
 */
export type SessionCapturePort = Pick<
  SessionsRepo,
  'getCapture' | 'getActiveCapture' | 'getLatestCapture' | 'getPanelCapture'
>;

/**
 * The capture-summary read behind the `metrics` source, satisfied by
 * `AnalysisSummarizer` in `../analysis/summarize.ts`: the stored summary when
 * the capture has one, and a summary computed from its events otherwise.
 */
export type CaptureSummaryPort = Pick<AnalysisSummarizer, 'loadCaptureSummary'>;

/** What {@link createPanelDataResolver} is constructed from. */
export interface PanelDataResolverDeps {
  /** Persisted telemetry. */
  readonly telemetry: PanelTelemetryPort;
  /** Correlated trace trees. */
  readonly correlator: PanelTracePort;
  /**
   * Capture lookups. Without it a request must name its capture, which is then
   * read as named; the store scopes every read by session as well, so a capture
   * of another session can never be read either way.
   */
  readonly sessions?: SessionCapturePort | undefined;
  /**
   * Capture summaries for the `metrics` source. Without it the capture's stored
   * summary is used when the capture lookup returned one, and the values are
   * computed from the capture's events otherwise.
   */
  readonly captures?: CaptureSummaryPort | undefined;
  /** Where records go; defaults to the shared no-op logger. */
  readonly logger?: Logger | undefined;
  /** Clock for timing records only — never for any result. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/**
 * Which session a query reads, and which of its captures: the rendered
 * panel's, a named one, or the live one (see "Capture scoping" above).
 */
export interface PanelDataContext {
  /** The session whose evidence is read; already authorised by the route. */
  readonly sessionId: SessionId;
  /**
   * The rendered panel the query was sent for. Present, the read is bound to
   * the capture that panel was generated from, whatever capture is open or
   * newest; absent, the query reads live evidence.
   */
  readonly panelId?: PanelId | undefined;
  /**
   * The capture to read. Absent means the rendered panel's capture when a
   * panel is named, and otherwise the session's open capture, else its most
   * recent one. Named together with a panel, it must be that panel's capture.
   */
  readonly captureId?: CaptureId | undefined;
}

/** Resolves panel-data queries. Construct with {@link createPanelDataResolver}. */
export interface PanelDataResolver {
  /**
   * Answers one data query.
   *
   * @param context The session, and the panel or capture, to read.
   * @param query A parsed `DataQuery`.
   * @returns The `DataResult` member for `query.source`, computed from every
   * event of the scope it reads — an empty one when the scope holds no matching
   * evidence, or when the rendered panel's capture has since been purged — or a
   * typed error:
   * - `PANEL_INVALID` for a paging value outside its domain, and for an
   *   aggregate whose slice exceeds {@link MAX_AGGREGATE_INPUT_EVENTS} (reason
   *   `aggregate-input-too-large`);
   * - `SESSION_INVALID_STATE` for a panel the session does not hold (reason
   *   `panel-not-in-session`), a capture that is not the session's
   *   (`capture-not-in-session`) or not the named panel's
   *   (`panel-capture-mismatch`), and when no capture can be looked up at all
   *   (`no-capture-lookup`);
   * - `STORE_ERROR` for a failed or throwing read, or a scan that contradicts
   *   its own count or row budget (`scan-inconsistent`);
   * - `INTERNAL` for anything unforeseen.
   *
   * Never rejects.
   */
  resolve(context: PanelDataContext, query: DataQuery): Promise<Result<DataResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal shapes and errors
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding of every record from this module. */
const SUBSYSTEM = 'panels.data';

/** The recovery instruction a store failure carries. */
const STORE_FAILURE_HINT =
  'Check the service log and reload the panel; the captured evidence is stored and unaffected.';

/** The recovery instruction an unforeseen failure carries. */
const INTERNAL_FAILURE_HINT =
  'Reload the panel; if the view still fails, report it with the service log.';

/**
 * How a query's capture was chosen, for its timing record: bound to a rendered
 * panel, named by the caller, or the session's live capture.
 */
type ScopeBinding = 'panel' | 'capture' | 'live';

/**
 * The one capture a query reads, or none when the session has not captured
 * yet (or the rendered panel's capture has been purged).
 */
interface ResolvedScope {
  /** The session. */
  readonly sessionId: SessionId;
  /** The capture, or `undefined` when there is none to read. */
  readonly captureId: CaptureId | undefined;
  /** The summary stored with that capture, when it has one and it describes it. */
  readonly storedSummary: CaptureSummary | undefined;
  /** How the capture was chosen. */
  readonly binding: ScopeBinding;
}

/**
 * The narrowing of one store read: the filter fields a scan and a page both
 * accept (`TelemetryScanFilter` is `TelemetryQuery` without its ordering and
 * paging fields).
 */
type SliceNarrowing = Pick<
  TelemetryScanFilter,
  'traceId' | 'kinds' | 'tier' | 'minDuration' | 'component'
>;

/** A complete read of the events a narrowing selects in one capture. */
interface EventSlice {
  /** Every event the narrowing selects, in capture order (`startTime`, then `id`). */
  readonly events: readonly TelemetryEvent[];
  /**
   * What the read was held to the ceiling as: the scan's `total`, which for a
   * complete scan is `events.length` plus `skipped`.
   */
  readonly counted: number;
  /** Stored rows the store could not reconstruct and left out. */
  readonly skipped: number;
}

/**
 * One scan's outcome within its row budget: the whole slice, or the
 * statement that the slice is larger than the budget and was not read.
 */
type ScannedSlice =
  | { readonly fits: true; readonly slice: EventSlice }
  | { readonly fits: false; readonly total: number };

/** The empty slice: what a scope without a capture, or a narrowing to no kind, reads. */
const EMPTY_SLICE: EventSlice = Object.freeze({
  events: Object.freeze([]),
  counted: 0,
  skipped: 0,
});

/**
 * The `stateTransitions` value of a slice: its transitions, and what ranks them
 * under `duration_desc`.
 *
 * A `StateTransition` row carries no duration, so the measured duration of the
 * `state` event each row projects is kept beside the rows, taken from the same
 * slice in the same computation — which is why it is cached with them and can
 * never describe another read.
 */
interface StateTransitionValue {
  /** Every transition of the slice, in the aggregate's base order. */
  readonly rows: readonly StateTransitionRow[];
  /**
   * The duration of every `state` event of the slice, by event id: the
   * {@link SortContext.eventDurations} the rows are ordered with.
   */
  readonly durations: ReadonlyMap<EventId, number>;
}

/**
 * The value each aggregate source computes from its slice, before ordering and
 * paging: what a cache entry holds per source. Typed off the protocol's result
 * members, so a cached value is exactly what a response is built from.
 */
interface AggregateValues {
  readonly renders: readonly DataRowOf<'renders'>[];
  readonly componentTree: PayloadOf<'componentTree'>;
  readonly requests: readonly DataRowOf<'requests'>[];
  readonly queries: readonly DataRowOf<'queries'>[];
  readonly stateTransitions: StateTransitionValue;
  readonly graph: PayloadOf<'graph'>;
  readonly metrics: readonly MetricValue[];
}

/**
 * The measured duration of every `state` event of a slice, by event id — the
 * events `aggregateStateTransitions` builds its rows from, each row's `eventId`
 * naming one.
 *
 * Event ids are unique within a capture (the store's `id` column is `UNIQUE`);
 * should one ever repeat, its first event in the slice decides. A duration
 * that is not a finite number is left out, so its row ranks with the rows
 * whose duration is unknown rather than on an invented value.
 */
function stateEventDurations(events: readonly TelemetryEvent[]): ReadonlyMap<EventId, number> {
  const durations = new Map<EventId, number>();
  const seen = new Set<EventId>();
  for (const event of events) {
    if (!STATE_KINDS.includes(event.kind) || seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    if (Number.isFinite(event.duration)) {
      durations.set(event.id, event.duration);
    }
  }
  return durations;
}

/** How each aggregate source is computed from its input events. */
type AggregateComputations = {
  readonly [S in AggregateDataSource]: (events: readonly TelemetryEvent[]) => AggregateValues[S];
};

/**
 * The one computation of each aggregate source, used by the shared traversal
 * and by a source's own slice read alike, so the two can only differ in their
 * input — which the shared traversal derives to be the same.
 *
 * `stateTransitions` lifts the aggregate's own cap to the slice ceiling, so
 * `total` is every transition of the slice rather than the aggregate's
 * default, and keeps the slice's `state` event durations beside the rows
 * ({@link StateTransitionValue}); `componentTree` turns "no rendering evidence"
 * (`undefined`, which does not survive JSON) into the wire's `null`.
 */
const AGGREGATE_COMPUTE: AggregateComputations = Object.freeze({
  renders: (events) => aggregateRenders(events),
  componentTree: (events) => buildComponentTreeSnapshot(events) ?? null,
  requests: (events) => aggregateRequests(events),
  queries: (events) => aggregateQueries(events),
  stateTransitions: (events) => ({
    rows: aggregateStateTransitions(events, { maxTransitions: MAX_AGGREGATE_INPUT_EVENTS }),
    durations: stateEventDurations(events),
  }),
  graph: (events) => buildDependencyGraph(events),
  metrics: (events) => computeMetrics(events),
});

/**
 * Everything one cache entry can hold for a capture and a filter: the value
 * of each aggregate source, and the answer of an unfiltered `metrics` read.
 */
interface BundleValues extends AggregateValues {
  /**
   * What an unfiltered `metrics` read answers with at the entry's generation:
   * the capture summary's values when a summary covers every stored event, and
   * otherwise the values computed from the events. Held apart from `metrics` —
   * always computed from the events — because a covering summary takes
   * precedence over the computation.
   */
  readonly unfilteredMetrics: readonly MetricValue[];
}

/** One value a cache entry can hold. */
type BundleSlot = keyof BundleValues;

/** The values a cache entry holds, or a write supplies: any subset of the slots. */
type AggregateBundle = Partial<BundleValues>;

/** The aggregate sources, in vocabulary order, read off the query vocabulary itself. */
const AGGREGATE_DATA_SOURCES: readonly AggregateDataSource[] = Object.freeze(
  DATA_QUERY_SOURCES.filter(
    (source): source is AggregateDataSource =>
      source !== 'trace' && source !== 'spans' && source !== 'events',
  ),
);

/** Every slot of a cache entry. */
const BUNDLE_SLOTS: readonly BundleSlot[] = Object.freeze([
  ...AGGREGATE_DATA_SOURCES,
  'unfilteredMetrics',
]);

/** A write of one source's value alone. */
type SingleSlotWriters = {
  readonly [S in AggregateDataSource]: (value: AggregateValues[S]) => AggregateBundle;
};

/**
 * The bundle holding one source's value and nothing else: what a source that
 * read its own slice caches.
 */
const SINGLE_SLOT: SingleSlotWriters = Object.freeze({
  renders: (renders) => ({ renders }),
  componentTree: (componentTree) => ({ componentTree }),
  requests: (requests) => ({ requests }),
  queries: (queries) => ({ queries }),
  stateTransitions: (stateTransitions) => ({ stateTransitions }),
  graph: (graph) => ({ graph }),
  metrics: (metrics) => ({ metrics }),
});

/** The refusal of a slice larger than {@link MAX_AGGREGATE_INPUT_EVENTS}. Counts only. */
function sliceTooLarge(source: DataQuerySource, total: number): DebuggenError {
  return new DebuggenError(
    'PANEL_INVALID',
    'The view covers more captured events than one panel read aggregates.',
    {
      hint: 'Narrow the view — filter it to one trace or to fewer kinds — so it reads fewer events.',
      details: {
        source,
        total,
        bound: MAX_AGGREGATE_INPUT_EVENTS,
        reason: 'aggregate-input-too-large',
      },
    },
  );
}

/** The refusal of a scan that contradicts its own count or row budget. Counts only. */
function scanInconsistent(): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The store scanned capture events inconsistently with its own count.',
    {
      hint: STORE_FAILURE_HINT,
      details: { operation: 'reading capture events', reason: 'scan-inconsistent' },
    },
  );
}

/**
 * Whether a scan contradicts itself under the row budget it was given.
 *
 * `TelemetryRepo.scanEvents` is complete exactly when its selection fits the
 * budget, and a complete scan's `total` is its rows plus the rows it skipped.
 * A scan claiming completeness over more than the budget, or over more rows
 * than it counted, would let a slice past the memory ceiling; one declaring
 * itself incomplete within the budget would refuse a view that fits. Either is
 * a store fault rather than an answer.
 */
function scanContradictsItself(scan: TelemetryScan, budget: number): boolean {
  if (!scan.complete) {
    return scan.total <= budget;
  }
  return scan.total > budget || scan.rows.length + (scan.skipped ?? 0) > scan.total;
}

/**
 * The store failure a throwing port is converted to.
 *
 * Names the operation and nothing the throw carried: a caught value may quote
 * captured data, so it never reaches a message, a detail or a log record.
 */
function storeFailure(operation: string): DebuggenError {
  return new DebuggenError('STORE_ERROR', `The store failed while ${operation}.`, {
    hint: STORE_FAILURE_HINT,
    details: { operation, reason: 'port-threw' },
  });
}

/** Runs a synchronous port call, converting a throw into {@link storeFailure}. */
function guarded<T>(
  operation: string,
  call: () => Result<T, DebuggenError>,
): Result<T, DebuggenError> {
  try {
    return call();
  } catch {
    return err(storeFailure(operation));
  }
}

/** Runs an asynchronous port call, converting a throw or rejection into {@link storeFailure}. */
async function guardedAsync<T>(
  operation: string,
  call: () => Promise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await call();
  } catch {
    return err(storeFailure(operation));
  }
}

/** The filter fields a query set, by name — what a record may say about a filter. */
function filterFieldsOf(filter: DataQueryFilter | undefined): string[] {
  if (filter === undefined) {
    return [];
  }
  return Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

/** Whether a filter narrows by anything other than the trace. */
function narrowsSubjects(filter: DataQueryFilter | undefined): boolean {
  return (
    filter !== undefined &&
    (filter.kinds !== undefined ||
      filter.tier !== undefined ||
      filter.minDuration !== undefined ||
      filter.component !== undefined)
  );
}

/** The whole of a filter as a store narrowing. */
function fullNarrowing(filter: DataQueryFilter | undefined): SliceNarrowing {
  return {
    traceId: filter?.traceId,
    kinds: filter?.kinds,
    tier: filter?.tier,
    minDuration: filter?.minDuration,
    component: filter?.component,
  };
}

/** A stored summary, when it describes `captureId`. */
function summaryFor(
  stored: StoredCapture | undefined,
  captureId: CaptureId,
): CaptureSummary | undefined {
  const summary = stored?.capture.summary;
  return summary !== undefined && summary.captureId === captureId ? summary : undefined;
}

/**
 * The metric values in vocabulary order, one per id.
 *
 * A summary built upstream already holds all of them in that order; projecting
 * through `METRIC_IDS` guarantees it for a stored summary read back from disk
 * as well, and keeps the first value of an id should one ever repeat. An id with
 * no value is left out rather than invented — "not computed" is never presented
 * as a measurement — and an `available: false` value is kept exactly as it came,
 * so the card renders "n/a" rather than a zero.
 *
 * This is the set the `metrics` source orders — by the requested sort's chain
 * in {@link SOURCE_SORT_KEYS}, whose `start_asc` and no-sort order is this one —
 * before its window is cut.
 */
function orderMetrics(values: readonly MetricValue[]): MetricValue[] {
  const byId = new Map<MetricValue['id'], MetricValue>();
  for (const value of values) {
    if (!byId.has(value.id)) {
      byId.set(value.id, value);
    }
  }
  const ordered: MetricValue[] = [];
  for (const id of METRIC_IDS) {
    const value = byId.get(id);
    if (value !== undefined) {
      ordered.push(value);
    }
  }
  return ordered;
}

/**
 * The roots of a tree reduced to the nodes `keep` selects **and every ancestor
 * of one**, each surviving node otherwise unchanged.
 *
 * Because a node survives whenever a descendant does, the path from every kept
 * node to its root is kept whole, so every `depth`, orphan flag and lineage
 * stays true of the reduced tree. A node whose children all survive untouched
 * is returned as the same object; any other survivor is copied with only its
 * surviving children, in their canonical order. Iterative, like the package's
 * own traversals, so a deep tree cannot exhaust the stack.
 */
function pruneTraceRoots(
  roots: readonly TraceNode[],
  keep: (node: TraceNode) => boolean,
): TraceNode[] {
  interface Frame {
    readonly node: TraceNode;
    next: number;
    readonly kept: TraceNode[];
  }
  const survivors: TraceNode[] = [];
  for (const root of roots) {
    const stack: Frame[] = [{ node: root, next: 0, kept: [] }];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const child = frame.node.children[frame.next];
      if (child !== undefined) {
        frame.next += 1;
        stack.push({ node: child, next: 0, kept: [] });
        continue;
      }
      stack.pop();
      if (frame.kept.length === 0 && !keep(frame.node)) {
        continue;
      }
      const { node, kept } = frame;
      const untouched =
        kept.length === node.children.length &&
        kept.every((survivor, index) => survivor === node.children[index]);
      const survived: TraceNode = untouched ? node : { ...node, children: kept };
      (stack.at(-1)?.kept ?? survivors).push(survived);
    }
  }
  return survivors;
}

/**
 * A tree rebuilt from a subset of its own nodes, every aggregate re-derived.
 *
 * The builder's own observations are carried over only as far as they still
 * hold: the primary root while it is still a root, and the duplicated span ids
 * that still have a node in the tree.
 */
function rebuiltTree(tree: TraceTree, roots: readonly TraceNode[], truncated: boolean): TraceTree {
  const present = new Set<string>();
  for (const root of roots) {
    walkNode(root, (node) => {
      present.add(node.event.spanId);
    });
  }
  const primary = tree.primaryRootSpanId;
  return buildTraceTree(tree.traceId, roots, {
    primaryRootSpanId:
      primary !== undefined && roots.some((root) => root.event.spanId === primary)
        ? primary
        : undefined,
    duplicateSpanIds: tree.duplicateSpanIds.filter((spanId) => present.has(spanId)),
    truncated,
  });
}

/**
 * A tree cut to its first `budget` nodes in canonical pre-order, flagged
 * `truncated`; the tree itself when it is within the budget.
 *
 * Pre-order visits a parent before any of its children, so the first `budget`
 * nodes always include every ancestor of each of them and the cut tree stays
 * connected. Counts the nodes it walks rather than trusting `nodeCount`, and
 * stops one past the budget.
 */
function withinNodeBudget(tree: TraceTree, budget: number): TraceTree {
  const inBudget = new Set<TraceNode>();
  const stack: TraceNode[] = [...tree.roots].reverse();
  let exceeded = false;
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (inBudget.size === budget) {
      exceeded = true;
      break;
    }
    inBudget.add(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  if (!exceeded) {
    return tree;
  }
  return rebuiltTree(
    tree,
    pruneTraceRoots(tree.roots, (node) => inBudget.has(node)),
    true,
  );
}

/**
 * Capture order, the order every scan returns its rows in (`start_time ASC,
 * id ASC`): `startTime`, then `id`.
 */
function compareStartOrder(left: TelemetryEvent, right: TelemetryEvent): number {
  if (left.startTime !== right.startTime) {
    return left.startTime < right.startTime ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * Two slices, each in capture order and disjoint by kind, merged into one in
 * capture order.
 *
 * Every row is appended one at a time, remainders included. A spread
 * (`push(...rest)`) passes each remaining row as a call argument, and a
 * remainder of the size a slice may reach — up to
 * {@link MAX_AGGREGATE_INPUT_EVENTS} rows — exceeds the engine's argument
 * limit (Node 24 throws `RangeError` from about 150 000), which would turn a
 * readable view into an `INTERNAL` failure.
 */
function mergeInStartOrder(
  left: readonly TelemetryEvent[],
  right: readonly TelemetryEvent[],
): TelemetryEvent[] {
  const merged: TelemetryEvent[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const fromLeft = left[leftIndex];
    const fromRight = right[rightIndex];
    // Unreachable for the dense arrays a scan returns; a hole is skipped
    // rather than allowed to end the merge early.
    if (fromLeft === undefined) {
      leftIndex += 1;
      continue;
    }
    if (fromRight === undefined) {
      rightIndex += 1;
      continue;
    }
    if (compareStartOrder(fromLeft, fromRight) <= 0) {
      merged.push(fromLeft);
      leftIndex += 1;
    } else {
      merged.push(fromRight);
      rightIndex += 1;
    }
  }
  for (; leftIndex < left.length; leftIndex += 1) {
    const rest = left[leftIndex];
    if (rest !== undefined) {
      merged.push(rest);
    }
  }
  for (; rightIndex < right.length; rightIndex += 1) {
    const rest = right[rightIndex];
    if (rest !== undefined) {
      merged.push(rest);
    }
  }
  return merged;
}

/**
 * The cache key of one capture and filter: every aggregate source read under
 * that filter shares the entry, which is what lets one traversal serve them
 * all.
 *
 * The filter's fields are listed by name in a fixed order and `kinds` as a
 * sorted copy, because the store reads a kind list as a set: two filters that
 * select the same events share one entry. Held in memory only, never logged —
 * a filter may carry a captured component name.
 */
function aggregateCacheKey(
  sessionId: SessionId,
  captureId: CaptureId,
  filter: DataQueryFilter | undefined,
): string {
  const canonical: Readonly<Record<string, unknown>> = {
    ...filter,
    ...(filter?.kinds === undefined ? {} : { kinds: [...filter.kinds].sort(compareText) }),
  };
  const fields = Object.entries(canonical)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return JSON.stringify([sessionId, captureId, fields]);
}

/** Code-unit order of two strings, for the canonical forms above. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Whether two capture generations are the same, field for field — the only
 * comparison `CaptureGeneration` supports: equal means the capture holds the
 * rows it held, and nothing is implied by an order.
 */
function sameGeneration(left: CaptureGeneration, right: CaptureGeneration): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.purges === right.purges &&
    left.writes === right.writes
  );
}

/** The slots a bundle actually carries, in {@link BUNDLE_SLOTS} order. */
function slotsOf(values: AggregateBundle): BundleSlot[] {
  return BUNDLE_SLOTS.filter((slot) => values[slot] !== undefined);
}

/** One write still represented in a cache entry. */
interface CacheContribution {
  /** The slots the write supplied that no later write has replaced. */
  readonly slots: readonly BundleSlot[];
  /** How many events the write read: its share of the entry's weight. */
  readonly weight: number;
}

/** One cached bundle and the capture generation its values describe. */
interface CacheEntry {
  /** The capture's generation, read before any event the values were computed from. */
  readonly generation: CaptureGeneration;
  /** The values. */
  readonly values: AggregateBundle;
  /** The writes the values came from, so a replaced slot stops weighing. */
  readonly contributions: readonly CacheContribution[];
  /** The sum of the contributions' weights: the entry's weight against the bound. */
  readonly weight: number;
}

/** The resolver's aggregate cache (see "The aggregate cache" above). */
interface AggregateCache {
  /**
   * One slot of the entry under `key`, when the entry was computed at exactly
   * `generation`; an entry of any other generation is dropped. A read that
   * finds the entry marks it most recently used, whether or not it holds the
   * slot.
   */
  read<K extends BundleSlot>(
    key: string,
    generation: CaptureGeneration,
    slot: K,
  ): BundleValues[K] | undefined;
  /**
   * Caches `values`, computed at `generation` from `weight` events: merged into
   * the entry under `key` when that entry is of the same generation, and
   * replacing it otherwise. Least recently used entries are evicted past
   * either bound.
   */
  write(key: string, generation: CaptureGeneration, values: AggregateBundle, weight: number): void;
}

/**
 * A least-recently-used cache of aggregate bundles, bounded by entry count and
 * by the events its entries were computed from.
 *
 * One `Map` — whose insertion order is the recency order — holds every entry,
 * so eviction is global across sessions, captures and filters. An entry's
 * weight is the events read by the writes it still holds: a write that
 * replaces every slot an earlier write supplied (the shared traversal after a
 * source's own read) retires that write's weight, so one capture's bundle
 * weighs what one traversal of it read, however many sources it serves. A
 * merge that would weigh more than the bound keeps the newest write alone; a
 * write heavier than the bound by itself is not kept, and its values are still
 * the caller's answer.
 */
function createAggregateCache(maxEntries: number, maxWeight: number): AggregateCache {
  const entries = new Map<string, CacheEntry>();
  let weight = 0;

  const forget = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    entries.delete(key);
    weight -= entry.weight;
  };

  const keep = (key: string, entry: CacheEntry): void => {
    entries.set(key, entry);
    weight += entry.weight;
    while (entries.size > maxEntries || weight > maxWeight) {
      const oldest = entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      forget(oldest.value);
    }
  };

  return {
    read(key, generation, slot) {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (!sameGeneration(entry.generation, generation)) {
        forget(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.values[slot];
    },
    write(key, generation, values, written) {
      const slots = slotsOf(values);
      if (slots.length === 0) {
        return;
      }
      const incoming: CacheContribution = { slots, weight: Math.max(1, written) };
      const existing = entries.get(key);
      forget(key);

      let entry: CacheEntry = {
        generation,
        values,
        contributions: [incoming],
        weight: incoming.weight,
      };
      if (existing !== undefined && sameGeneration(existing.generation, generation)) {
        const contributions = [
          ...existing.contributions
            .map((contribution) => ({
              slots: contribution.slots.filter((slot) => !slots.includes(slot)),
              weight: contribution.weight,
            }))
            .filter((contribution) => contribution.slots.length > 0),
          incoming,
        ];
        const merged = contributions.reduce((sum, contribution) => sum + contribution.weight, 0);
        if (merged <= maxWeight) {
          entry = {
            generation,
            values: { ...existing.values, ...values },
            contributions,
            weight: merged,
          };
        }
      }
      if (entry.weight > maxWeight) {
        return;
      }
      keep(key, entry);
    },
  };
}

/** Whether a kind narrowing selects no kind at all, and so matches nothing. */
function selectsNoKind(kinds: readonly TelemetryKind[] | undefined): boolean {
  return kinds !== undefined && kinds.length === 0;
}

/**
 * The context kinds of a subject-narrowed read plan: the kinds of its slice
 * except the subjects'. Disjoint from the subject kinds by construction, so
 * the two halves of the slice never hold one record twice.
 */
function contextKindsOf(
  plan: AggregateReadPlan,
  subjectKinds: readonly TelemetryKind[],
): readonly TelemetryKind[] {
  return (plan.sliceKinds ?? TELEMETRY_KINDS).filter((kind) => !subjectKinds.includes(kind));
}

/**
 * The events of `events` whose kind is one of `kinds`, in their order; all of
 * them, as the same array, when `kinds` is `undefined`.
 *
 * This is the partition a store read's `kinds` narrowing applies — the store
 * filters on the same `kind` value — so partitioning a capture-ordered read
 * yields exactly the rows, in exactly the order, the narrowed read returns.
 */
function ofKinds(
  events: readonly TelemetryEvent[],
  kinds: readonly TelemetryKind[] | undefined,
): readonly TelemetryEvent[] {
  if (kinds === undefined) {
    return events;
  }
  const selected = new Set<TelemetryKind>(kinds);
  return events.filter((event) => selected.has(event.kind));
}

/** The reads of one shared traversal of a capture under one filter, both in capture order. */
interface SharedSlices {
  /** Every event of the capture the filter's `traceId` selects, of every kind. */
  readonly whole: readonly TelemetryEvent[];
  /**
   * Every event the whole filter selects: a read of its own when the filter
   * narrows by more than the trace, and `whole` itself otherwise.
   */
  readonly narrowed: readonly TelemetryEvent[];
  /** Whether the filter narrows by more than the trace ({@link narrowsSubjects}). */
  readonly narrowing: boolean;
  /** How many events the traversal read, both reads together: the bundle's cache weight. */
  readonly read: number;
}

/**
 * The input of one aggregate source derived from a shared traversal — row for
 * row, and in the same order, what the source's own read under its
 * {@link AGGREGATE_READ_PLANS} entry returns:
 *
 * - a source whose every record is a subject reads the whole filter narrowed
 *   to its slice kinds: `narrowed`, partitioned by kind;
 * - a subject-narrowed source under a filter that narrows by the trace only
 *   reads its slice kinds of the trace: `whole`, partitioned by kind;
 * - under a filter that narrows further, its context half (its slice kinds
 *   except the subjects', narrowed by the trace only) is `whole` partitioned
 *   by kind, its subject half (the subjects the whole filter selects) is
 *   `narrowed` partitioned by kind, and the two are merged into capture order
 *   by the same merge the two reads are.
 */
function sharedAggregateInput(
  source: AggregateDataSource,
  shared: SharedSlices,
): readonly TelemetryEvent[] {
  const plan = AGGREGATE_READ_PLANS[source];
  const subjectKinds = plan.subjectKinds;
  if (subjectKinds === undefined) {
    return ofKinds(shared.narrowed, plan.sliceKinds);
  }
  if (!shared.narrowing) {
    return ofKinds(shared.whole, plan.sliceKinds);
  }
  return mergeInStartOrder(
    ofKinds(shared.whole, contextKindsOf(plan, subjectKinds)),
    ofKinds(shared.narrowed, subjectKinds),
  );
}

/**
 * Every aggregate source computed from one shared traversal: the bundle a
 * cold read of an every-kind source caches, one explicit property per source.
 */
function computeBundle(shared: SharedSlices): AggregateValues {
  return {
    renders: AGGREGATE_COMPUTE.renders(sharedAggregateInput('renders', shared)),
    componentTree: AGGREGATE_COMPUTE.componentTree(sharedAggregateInput('componentTree', shared)),
    requests: AGGREGATE_COMPUTE.requests(sharedAggregateInput('requests', shared)),
    queries: AGGREGATE_COMPUTE.queries(sharedAggregateInput('queries', shared)),
    stateTransitions: AGGREGATE_COMPUTE.stateTransitions(
      sharedAggregateInput('stateTransitions', shared),
    ),
    graph: AGGREGATE_COMPUTE.graph(sharedAggregateInput('graph', shared)),
    metrics: AGGREGATE_COMPUTE.metrics(sharedAggregateInput('metrics', shared)),
  };
}

/**
 * The paging counts of a result and the sort that ordered it, for a timing
 * record: nothing for a single-value result, which has neither. The sort is a
 * vocabulary name, never captured data.
 */
function pageCounts(
  result: DataResult,
  requested: DataQuerySort | undefined,
): Record<string, number | boolean | string> {
  if (!('total' in result)) {
    return {};
  }
  return {
    sort: effectiveSort(result.source, requested),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    endOfData: result.nextOffset === null,
  };
}

/** The flat sources whose rows are persisted events, served page by page by the store. */
type EventRowDataSource = {
  [S in SortedDataSource]: DataRowOf<S> extends TelemetryEvent ? S : never;
}[SortedDataSource];

/* -------------------------------------------------------------------------------------------------
 * The resolver
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the panel-data resolver.
 *
 * Every query reads its scope from the store, so a panel reloaded during a
 * capture sees the evidence that has arrived since. The one state kept between
 * calls is the aggregate cache ("The aggregate cache" above), and it cannot
 * change an answer: an entry is served only while the capture's generation is
 * the one read before the rows its values were computed from.
 *
 * @param deps The store, correlator and lookups the resolver reads.
 * @returns The resolver.
 */
export function createPanelDataResolver(deps: PanelDataResolverDeps): PanelDataResolver {
  const logger = subsystemLogger(deps.logger ?? noopLogger, SUBSYSTEM);
  const now = deps.now ?? Date.now;
  const { telemetry, correlator } = deps;
  const cache = createAggregateCache(AGGREGATE_CACHE_MAX_ENTRIES, AGGREGATE_CACHE_MAX_INPUT_EVENTS);

  /** The refusal of a read no capture lookup can scope. */
  const noCaptureLookup = (sessionId: SessionId, message: string): DebuggenError =>
    new DebuggenError('SESSION_INVALID_STATE', message, {
      hint: 'Name the capture to read, or construct the resolver with the session store.',
      details: { sessionId, reason: 'no-capture-lookup' },
    });

  /** The refusal of a capture that is not the session's. */
  const captureNotInSession = (sessionId: SessionId, captureId: CaptureId): DebuggenError =>
    new DebuggenError('SESSION_INVALID_STATE', 'The session has no such capture.', {
      hint: 'Choose a capture of this session, or omit the capture to read its latest one.',
      details: { sessionId, captureId, reason: 'capture-not-in-session' },
    });

  /**
   * The capture a rendered panel was generated from.
   *
   * One indexed read of the panel's row and its linked capture. A panel the
   * session does not hold is refused; a panel whose capture was purged scopes
   * the read to no capture, so every source answers with its empty value and
   * never with another capture's evidence. The panel id reaches no error and no
   * record: the caller knows which panel it asked about.
   */
  const panelScope = (
    sessions: SessionCapturePort,
    sessionId: SessionId,
    panelId: PanelId,
    named: CaptureId | undefined,
  ): Result<ResolvedScope, DebuggenError> => {
    const lookup = guarded("reading a panel's capture", () =>
      sessions.getPanelCapture(sessionId, panelId),
    );
    if (!lookup.ok) {
      return err(lookup.error);
    }
    if (lookup.value.panel === 'unknown') {
      return err(
        new DebuggenError('SESSION_INVALID_STATE', 'The session has no such panel.', {
          hint: 'Reload the panel from the session that generated it.',
          details: { sessionId, reason: 'panel-not-in-session' },
        }),
      );
    }
    const stored = lookup.value.capture;
    if (stored !== undefined && stored.sessionId !== sessionId) {
      return err(captureNotInSession(sessionId, stored.capture.id));
    }
    const captureId = stored?.capture.id;
    if (named !== undefined && named !== captureId) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'The named capture is not the one the panel was generated from.',
          {
            hint: 'Name only the panel; its data is read from its own capture.',
            details: { sessionId, captureId: named, reason: 'panel-capture-mismatch' },
          },
        ),
      );
    }
    if (captureId === undefined) {
      return ok({ sessionId, captureId: undefined, storedSummary: undefined, binding: 'panel' });
    }
    return ok({
      sessionId,
      captureId,
      storedSummary: summaryFor(stored, captureId),
      binding: 'panel',
    });
  };

  /**
   * The one capture a query reads: the rendered panel's, else the named one,
   * else the session's open capture, else its most recent — each an indexed
   * lookup, never a walk of the session's capture history.
   */
  const resolveScope = (context: PanelDataContext): Result<ResolvedScope, DebuggenError> => {
    const { sessionId } = context;
    const sessions = deps.sessions;

    if (context.panelId !== undefined) {
      if (sessions === undefined) {
        return err(
          noCaptureLookup(sessionId, "A panel was named, and its capture can't be looked up."),
        );
      }
      return panelScope(sessions, sessionId, context.panelId, context.captureId);
    }

    if (context.captureId !== undefined) {
      const captureId = context.captureId;
      if (sessions === undefined) {
        return ok({ sessionId, captureId, storedSummary: undefined, binding: 'capture' });
      }
      const stored = guarded('reading a capture', () => sessions.getCapture(captureId));
      if (!stored.ok) {
        return err(stored.error);
      }
      const found = stored.value;
      if (found === undefined || found.sessionId !== sessionId || found.capture.id !== captureId) {
        return err(captureNotInSession(sessionId, captureId));
      }
      return ok({
        sessionId,
        captureId,
        storedSummary: summaryFor(found, captureId),
        binding: 'capture',
      });
    }

    if (sessions === undefined) {
      return err(noCaptureLookup(sessionId, 'No capture was named and none can be looked up.'));
    }

    const active = guarded('reading the open capture', () => sessions.getActiveCapture(sessionId));
    if (!active.ok) {
      return err(active.error);
    }
    let chosen = active.value?.sessionId === sessionId ? active.value : undefined;
    if (chosen === undefined) {
      const latest = guarded('reading the latest capture', () =>
        sessions.getLatestCapture(sessionId),
      );
      if (!latest.ok) {
        return err(latest.error);
      }
      chosen = latest.value?.sessionId === sessionId ? latest.value : undefined;
    }
    if (chosen === undefined) {
      return ok({ sessionId, captureId: undefined, storedSummary: undefined, binding: 'live' });
    }
    const captureId = chosen.capture.id;
    return ok({
      sessionId,
      captureId,
      storedSummary: summaryFor(chosen, captureId),
      binding: 'live',
    });
  };

  /**
   * Reads **every** event a narrowing selects in the scope's capture — one
   * `scanEvents` call, which is one count and, when the selection fits
   * `budget`, one ordered statement in capture order — or reports that it does
   * not fit, having read no row.
   *
   * A store failure is an `Err`; so is a scan that contradicts its own count
   * or budget ({@link scanContradictsItself}), refused as `scan-inconsistent`
   * rather than trusted. Synchronous, so no ingest interleaves with the read.
   */
  const scanSlice = (
    log: Logger,
    source: DataQuerySource,
    scope: ResolvedScope,
    narrowing: SliceNarrowing,
    budget: number,
  ): Result<ScannedSlice, DebuggenError> => {
    const captureId = scope.captureId;
    if (captureId === undefined || selectsNoKind(narrowing.kinds)) {
      return ok({ fits: true, slice: EMPTY_SLICE });
    }

    const scanned = guarded('reading capture events', () =>
      telemetry.scanEvents({ sessionId: scope.sessionId, captureId, ...narrowing }, budget),
    );
    if (!scanned.ok) {
      return err(scanned.error);
    }
    const scan = scanned.value;
    const skipped = scan.skipped ?? 0;
    if (scanContradictsItself(scan, budget)) {
      log.warn(
        'The store scanned a slice inconsistently with its own count; the view was refused.',
        {
          source,
          complete: scan.complete,
          read: scan.rows.length,
          skipped,
          total: scan.total,
          budget,
        },
      );
      return err(scanInconsistent());
    }
    if (!scan.complete) {
      return ok({ fits: false, total: scan.total });
    }

    if (skipped > 0) {
      log.warn('Stored events that no longer validate were left out of a panel view.', {
        source,
        skipped,
      });
    }
    return ok({ fits: true, slice: { events: scan.rows, counted: scan.total, skipped } });
  };

  /**
   * Reads **every** event a narrowing selects in the scope's capture, or
   * refuses: one {@link scanSlice} whose row budget is what the ceiling leaves.
   *
   * `alreadyCounted` is what an earlier read for the same answer was held to
   * the ceiling as, so the two halves of a subject-narrowed slice are held to
   * one ceiling together. A slice that does not fit is refused with
   * {@link sliceTooLarge}, never answered from part of it.
   */
  const readSlice = (
    log: Logger,
    source: DataQuerySource,
    scope: ResolvedScope,
    narrowing: SliceNarrowing,
    alreadyCounted: number,
  ): Result<EventSlice, DebuggenError> => {
    const scanned = scanSlice(
      log,
      source,
      scope,
      narrowing,
      Math.max(0, MAX_AGGREGATE_INPUT_EVENTS - alreadyCounted),
    );
    if (!scanned.ok) {
      return err(scanned.error);
    }
    if (!scanned.value.fits) {
      const covered = alreadyCounted + scanned.value.total;
      log.warn('A panel view covers more events than one read aggregates; it was refused.', {
        source,
        total: covered,
        bound: MAX_AGGREGATE_INPUT_EVENTS,
      });
      return err(sliceTooLarge(source, covered));
    }
    return ok(scanned.value.slice);
  };

  /**
   * The input slice of one aggregate source, per its {@link AGGREGATE_READ_PLANS}
   * entry — every event of it — read for that source alone.
   *
   * A subject-narrowed slice is read in two disjoint halves, each read once: the
   * context records (every kind of the slice but the subjects', narrowed by
   * `traceId` only) and the subjects the whole filter selects, merged back into
   * capture order and held to the ceiling together.
   */
  const readAggregateSlice = (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Result<EventSlice, DebuggenError> => {
    const plan = AGGREGATE_READ_PLANS[source];
    const subjectKinds = plan.subjectKinds;

    if (subjectKinds === undefined) {
      return readSlice(
        log,
        source,
        scope,
        { ...fullNarrowing(filter), kinds: intersectKinds(plan.sliceKinds, filter?.kinds) },
        0,
      );
    }
    if (!narrowsSubjects(filter)) {
      return readSlice(log, source, scope, { traceId: filter?.traceId, kinds: plan.sliceKinds }, 0);
    }

    const context = readSlice(
      log,
      source,
      scope,
      { traceId: filter?.traceId, kinds: contextKindsOf(plan, subjectKinds) },
      0,
    );
    if (!context.ok) {
      return context;
    }
    const subjects = readSlice(
      log,
      source,
      scope,
      { ...fullNarrowing(filter), kinds: intersectKinds(subjectKinds, filter?.kinds) },
      context.value.counted,
    );
    if (!subjects.ok) {
      return subjects;
    }
    return ok({
      events: mergeInStartOrder(context.value.events, subjects.value.events),
      counted: context.value.counted + subjects.value.counted,
      skipped: context.value.skipped + subjects.value.skipped,
    });
  };

  /**
   * One shared traversal of the scope's capture under `filter`: the reads
   * every aggregate source's input is derived from ({@link sharedAggregateInput}).
   *
   * When the filter narrows by more than the trace, the whole filter's
   * selection is read first, then the trace's whole slice with what the
   * ceiling leaves; otherwise the trace's whole slice alone, which is then the
   * filter's selection as well. `undefined` when either read does not fit the
   * ceiling — no error: the requesting source then reads its own, narrower
   * slice, and is refused only if that does not fit either. A store failure is
   * an `Err`.
   */
  const readShared = (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Result<SharedSlices | undefined, DebuggenError> => {
    const narrowing = narrowsSubjects(filter);
    let narrowed: EventSlice = EMPTY_SLICE;
    if (narrowing) {
      const selection = scanSlice(
        log,
        source,
        scope,
        fullNarrowing(filter),
        MAX_AGGREGATE_INPUT_EVENTS,
      );
      if (!selection.ok) {
        return err(selection.error);
      }
      if (!selection.value.fits) {
        return ok(undefined);
      }
      narrowed = selection.value.slice;
    }
    const trace = scanSlice(
      log,
      source,
      scope,
      { traceId: filter?.traceId },
      Math.max(0, MAX_AGGREGATE_INPUT_EVENTS - narrowed.counted),
    );
    if (!trace.ok) {
      return err(trace.error);
    }
    if (!trace.value.fits) {
      return ok(undefined);
    }
    const whole = trace.value.slice.events;
    return ok({
      whole,
      narrowed: narrowing ? narrowed.events : whole,
      narrowing,
      read: whole.length + (narrowing ? narrowed.events.length : 0),
    });
  };

  /** The capture's generation: what every cached aggregate is validated against. */
  const readGeneration = (
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<CaptureGeneration, DebuggenError> =>
    guarded('reading the capture generation', () =>
      telemetry.captureGeneration(sessionId, captureId),
    );

  /** The capture's stamp: how many events it holds, for the summary coverage check. */
  const readStamp = (
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<CaptureEventStamp, DebuggenError> =>
    guarded('reading the capture stamp', () => telemetry.captureStamp(sessionId, captureId));

  /**
   * One aggregate of a capture whose generation `generation` was read in the
   * caller's synchronous turn, before any event: from the cache while the
   * entry of this capture and filter was computed at that generation, and
   * otherwise computed and cached under it.
   *
   * On a miss, a source that reads every kind (`sliceKinds` undefined:
   * `queries`, `stateTransitions`, `graph`, `metrics`) takes one shared
   * traversal and computes **every** aggregate source from it, caching them as
   * one bundle, so the other nodes of the panel are answered from memory; when
   * that traversal does not fit the ceiling it reads its own slice instead. A
   * source that reads a subset of the kinds (`renders`, `componentTree`,
   * `requests`) reads only its own slice and caches only its own value. Both
   * compute through {@link AGGREGATE_COMPUTE}. Failures are never cached.
   */
  const aggregateAt = <S extends AggregateDataSource>(
    log: Logger,
    source: S,
    scope: ResolvedScope,
    captureId: CaptureId,
    filter: DataQueryFilter | undefined,
    generation: CaptureGeneration,
  ): Result<AggregateValues[S], DebuggenError> => {
    const key = aggregateCacheKey(scope.sessionId, captureId, filter);
    const cached = cache.read(key, generation, source);
    if (cached !== undefined) {
      log.debug('A panel view was answered from the aggregate cache.', { source });
      return ok(cached);
    }

    if (AGGREGATE_READ_PLANS[source].sliceKinds === undefined) {
      const shared = readShared(log, source, scope, filter);
      if (!shared.ok) {
        return err(shared.error);
      }
      if (shared.value !== undefined) {
        const bundle = computeBundle(shared.value);
        cache.write(key, generation, bundle, shared.value.read);
        log.debug('Every aggregate of a panel view was computed from one traversal.', {
          source,
          read: shared.value.read,
        });
        return ok(bundle[source]);
      }
      log.debug('The shared traversal exceeds the ceiling; the view reads its own slice.', {
        source,
        bound: MAX_AGGREGATE_INPUT_EVENTS,
      });
    }

    const slice = readAggregateSlice(log, source, scope, filter);
    if (!slice.ok) {
      return err(slice.error);
    }
    const compute: (events: readonly TelemetryEvent[]) => AggregateValues[S] =
      AGGREGATE_COMPUTE[source];
    const value = compute(slice.value.events);
    const single: (computed: AggregateValues[S]) => AggregateBundle = SINGLE_SLOT[source];
    cache.write(key, generation, single(value), slice.value.events.length);
    return ok(value);
  };

  /**
   * One aggregate of the scope's capture ({@link aggregateAt}), its capture's
   * generation read first, in the same synchronous turn as any read of its
   * events — so a value is cached under a generation that describes exactly
   * the rows it was computed from, and a hit costs that one read.
   */
  const aggregateOf = <S extends AggregateDataSource>(
    log: Logger,
    source: S,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Result<AggregateValues[S], DebuggenError> => {
    const captureId = scope.captureId;
    if (captureId === undefined) {
      const compute: (events: readonly TelemetryEvent[]) => AggregateValues[S] =
        AGGREGATE_COMPUTE[source];
      return ok(compute(EMPTY_SLICE.events));
    }
    const generation = readGeneration(scope.sessionId, captureId);
    if (!generation.ok) {
      return err(generation.error);
    }
    return aggregateAt(log, source, scope, captureId, filter, generation.value);
  };

  /**
   * One page of a flat event source, filtered, ordered and paged by the store.
   *
   * The requested sort — or the source's default when none is named — reaches
   * the store unchanged, with {@link FLAT_SOURCE_GROUP_KEY} as the group
   * `count_desc` ranks by (the other two sorts do not read it), so the store
   * applies exactly the chain {@link SOURCE_SORT_KEYS} states for the source.
   */
  const readEventRows = (
    log: Logger,
    source: EventRowDataSource,
    scope: ResolvedScope,
    narrowing: SliceNarrowing,
    requested: DataQuerySort | undefined,
    paging: ResolvedPaging,
  ): Result<PagedRows<TelemetryEvent>, DebuggenError> => {
    const captureId = scope.captureId;
    if (captureId === undefined || selectsNoKind(narrowing.kinds)) {
      return ok(applyPage<TelemetryEvent>([], paging));
    }

    const page = guarded('reading a page of events', () =>
      telemetry.query({
        sessionId: scope.sessionId,
        captureId,
        ...narrowing,
        sort: effectiveSort(source, requested),
        groupBy: FLAT_SOURCE_GROUP_KEY,
        limit: paging.limit,
        offset: paging.offset,
      }),
    );
    if (!page.ok) {
      return err(page.error);
    }
    const skipped = page.value.skipped ?? 0;
    if (skipped > 0) {
      log.warn('Stored events that no longer validate were left out of a panel view.', {
        source,
        skipped,
      });
    }
    return ok({ items: page.value.rows, page: pageFromStore(page.value, paging) });
  };

  /**
   * Every row of an in-memory source, ordered by the chain of the requested
   * sort — or of the source's default when none is named. Total: the table
   * has a chain for every sort of every sortable source, so a named sort is
   * always the one applied.
   */
  const orderFor = <S extends SortedDataSource>(
    source: S,
    rows: readonly DataRowOf<S>[],
    requested: DataQuerySort | undefined,
    context: SortContext = EMPTY_SORT_CONTEXT,
  ): DataRowOf<S>[] => {
    const chains: SourceSortKeys[S] = SOURCE_SORT_KEYS[source];
    return orderRows(rows, chains[effectiveSort(source, requested)], context);
  };

  /**
   * The correlated tree a `trace` query names, or its capture's default one.
   *
   * With no `traceId`, the default is the stored summary's `primaryTraceId` —
   * the longest interaction, the trace a timeline anchors on — read directly
   * when the capture still holds it, and otherwise the trace of the capture's
   * earliest event, one indexed read (`firstTraceId`: `start_time` first, and
   * two traces tied at the earliest instant go to the event that arrived
   * first, by `ingest_seq` — not to the smaller trace id). Arrival numbers are
   * never reused, so both rules are total orders: every read of one capture
   * picks the same trace, and neither lists the capture's traces. After a
   * purge removes the earliest rows, the default moves to the trace of the
   * earliest event that remains.
   */
  const findTrace = async (
    scope: ResolvedScope,
    captureId: CaptureId,
    named: string | undefined,
  ): Promise<Result<TraceTree | undefined, DebuggenError>> => {
    const read = (traceId: string): Promise<Result<TraceTree | undefined, DebuggenError>> =>
      guardedAsync('reading a trace', () =>
        correlator.getTrace(scope.sessionId, traceId, captureId),
      );

    if (named !== undefined) {
      return read(named);
    }
    const primary = scope.storedSummary?.primaryTraceId;
    if (primary !== undefined) {
      const tree = await read(primary);
      if (!tree.ok || tree.value !== undefined) {
        return tree;
      }
    }
    const first = guarded('finding the first trace', () =>
      telemetry.firstTraceId(scope.sessionId, captureId),
    );
    if (!first.ok) {
      return err(first.error);
    }
    const earliest = first.value;
    if (earliest === undefined || earliest === primary) {
      return ok(undefined);
    }
    return read(earliest);
  };

  /**
   * The `trace` source: one correlated interaction, or `null`.
   *
   * The filter's other fields keep the nodes the store matches for them in
   * that trace plus every ancestor of a match; a filter no node matches
   * answers `null`, the empty value. Whatever it keeps, the answer holds at
   * most {@link TRACE_NODE_BUDGET} nodes and says so when cut.
   */
  const resolveTrace = async (
    log: Logger,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Promise<Result<TraceTree | null, DebuggenError>> => {
    const captureId = scope.captureId;
    if (captureId === undefined) {
      return ok(null);
    }

    const found = await findTrace(scope, captureId, filter?.traceId);
    if (!found.ok) {
      return err(found.error);
    }
    const tree = found.value;
    if (tree === undefined) {
      return ok(null);
    }

    let shaped = tree;
    if (narrowsSubjects(filter)) {
      const matched = readSlice(
        log,
        'trace',
        scope,
        { ...fullNarrowing(filter), traceId: tree.traceId },
        0,
      );
      if (!matched.ok) {
        return err(matched.error);
      }
      const matchedIds = new Set(matched.value.events.map((event) => event.id));
      const roots = pruneTraceRoots(tree.roots, (node) => matchedIds.has(node.event.id));
      if (roots.length === 0) {
        log.debug('No node of the trace matches the filter.', {
          fields: filterFieldsOf(filter),
          nodes: tree.nodeCount,
        });
        return ok(null);
      }
      shaped = rebuiltTree(tree, roots, tree.truncated);
    }

    const bounded = withinNodeBudget(shaped, TRACE_NODE_BUDGET);
    if (bounded !== shaped) {
      log.debug('A trace was cut to the node budget.', {
        nodes: shaped.nodeCount,
        budget: TRACE_NODE_BUDGET,
      });
    }
    return ok(bounded);
  };

  /**
   * The capture summary a `metrics` read may be answered from: the one loaded
   * through the captures port, else the one stored with the capture, else
   * none. A load that fails or describes another capture is logged and falls
   * back; it never fails the read.
   */
  const loadSummary = async (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    captureId: CaptureId,
  ): Promise<CaptureSummary | undefined> => {
    const captures = deps.captures;
    if (captures !== undefined) {
      const loaded = await guardedAsync('loading the capture summary', () =>
        captures.loadCaptureSummary(scope.sessionId, captureId),
      );
      if (loaded.ok && loaded.value.captureId === captureId) {
        return loaded.value;
      }
      log.warn('The capture summary could not be used; computing the metrics from events.', {
        source,
        ...(loaded.ok
          ? { reason: 'summary-describes-another-capture' }
          : { reason: 'summary-load-failed', code: loaded.error.code }),
      });
    }
    return scope.storedSummary;
  };

  /**
   * The summary's metrics when it accounts for **every** event the capture now
   * holds — its `eventCount` equals the capture's stored count, read here —
   * and `undefined` otherwise.
   *
   * A summary computed from part of the capture (the summarizer reads a
   * bounded prefix) or before later events arrived does not account for all of
   * them and is not used, so the metric cards never show totals of a prefix as
   * the capture's.
   */
  const coveringMetrics = (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    captureId: CaptureId,
    summary: CaptureSummary | undefined,
  ): Result<readonly MetricValue[] | undefined, DebuggenError> => {
    if (summary === undefined) {
      return ok(undefined);
    }
    const stamp = readStamp(scope.sessionId, captureId);
    if (!stamp.ok) {
      return err(stamp.error);
    }
    if (summary.eventCount !== stamp.value.count) {
      log.debug('The capture summary does not cover every stored event; computing the metrics.', {
        source,
        summarized: summary.eventCount,
        stored: stamp.value.count,
      });
      return ok(undefined);
    }
    return ok(summary.metrics);
  };

  /**
   * The metric values of the capture, before ordering, always describing every
   * event of it.
   *
   * Filtered, the values computed over the events the filter selects — the
   * `metrics` value of the filter's bundle — because a summary describes the
   * whole capture and would silently ignore the filter.
   *
   * Unfiltered, a capture summary's values when one accounts for every stored
   * event, and the values computed from the whole capture otherwise: the
   * summary takes precedence. Whichever answers is cached as the entry's
   * `unfilteredMetrics` under the capture's generation, so a repeated read is
   * one generation read — it neither reloads the summary nor recounts the
   * capture. After the summary settles, the generation, the coverage count
   * and any computation are read in one synchronous turn, so the answer
   * cached describes exactly the rows that generation names.
   */
  const metricValues = async (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    captureId: CaptureId,
    filter: DataQueryFilter | undefined,
  ): Promise<Result<readonly MetricValue[], DebuggenError>> => {
    if (filterFieldsOf(filter).length > 0) {
      return aggregateOf(log, 'metrics', scope, filter);
    }

    const key = aggregateCacheKey(scope.sessionId, captureId, undefined);
    const before = readGeneration(scope.sessionId, captureId);
    if (!before.ok) {
      return err(before.error);
    }
    const cached = cache.read(key, before.value, 'unfilteredMetrics');
    if (cached !== undefined) {
      log.debug('A panel view was answered from the aggregate cache.', { source });
      return ok(cached);
    }

    const summary = await loadSummary(log, source, scope, captureId);

    // One synchronous turn from here: the generation is read before the count
    // and before any event, and nothing interleaves until the answer is cached.
    const generation = readGeneration(scope.sessionId, captureId);
    if (!generation.ok) {
      return err(generation.error);
    }
    const covering = coveringMetrics(log, source, scope, captureId, summary);
    if (!covering.ok) {
      return err(covering.error);
    }
    if (covering.value !== undefined) {
      cache.write(key, generation.value, { unfilteredMetrics: covering.value }, 1);
      return ok(covering.value);
    }
    const computed = aggregateAt(log, 'metrics', scope, captureId, undefined, generation.value);
    if (!computed.ok) {
      return err(computed.error);
    }
    cache.write(key, generation.value, { unfilteredMetrics: computed.value }, 1);
    return ok(computed.value);
  };

  /** Dispatches one query to its source. */
  const resolveQuery = async (
    log: Logger,
    scope: ResolvedScope,
    query: DataQuery,
    paging: ResolvedPaging,
  ): Promise<Result<DataResult, DebuggenError>> => {
    const filter = query.filter;

    switch (query.source) {
      case 'trace': {
        const trace = await resolveTrace(log, scope, filter);
        return trace.ok ? ok({ source: query.source, trace: trace.value }) : err(trace.error);
      }

      case 'spans': {
        const rows = readEventRows(
          log,
          query.source,
          scope,
          { ...fullNarrowing(filter), kinds: intersectKinds(SPAN_SOURCE_KINDS, filter?.kinds) },
          query.sort,
          paging,
        );
        return rows.ok
          ? ok({ source: query.source, spans: rows.value.items, ...rows.value.page })
          : err(rows.error);
      }

      case 'events': {
        const rows = readEventRows(
          log,
          query.source,
          scope,
          fullNarrowing(filter),
          query.sort,
          paging,
        );
        return rows.ok
          ? ok({ source: query.source, events: rows.value.items, ...rows.value.page })
          : err(rows.error);
      }

      case 'renders': {
        const renders = aggregateOf(log, query.source, scope, filter);
        if (!renders.ok) {
          return err(renders.error);
        }
        const { items, page } = applyPage(
          orderFor(query.source, renders.value, query.sort),
          paging,
        );
        return ok({ source: query.source, renders: items, ...page });
      }

      case 'componentTree': {
        // `null` when the capture holds no rendering evidence (see AGGREGATE_COMPUTE).
        const snapshot = aggregateOf(log, query.source, scope, filter);
        return snapshot.ok
          ? ok({ source: query.source, componentTree: snapshot.value })
          : err(snapshot.error);
      }

      case 'requests': {
        const requests = aggregateOf(log, query.source, scope, filter);
        if (!requests.ok) {
          return err(requests.error);
        }
        const { items, page } = applyPage(
          orderFor(query.source, requests.value, query.sort),
          paging,
        );
        return ok({ source: query.source, requests: items, ...page });
      }

      case 'queries': {
        const queries = aggregateOf(log, query.source, scope, filter);
        if (!queries.ok) {
          return err(queries.error);
        }
        const { items, page } = applyPage(
          orderFor(query.source, queries.value, query.sort),
          paging,
        );
        return ok({ source: query.source, queries: items, ...page });
      }

      case 'stateTransitions': {
        // Every transition of the slice: the aggregate's own cap is lifted to the
        // slice ceiling (see AGGREGATE_COMPUTE). The slice's state-event
        // durations travel with the rows, for `duration_desc`.
        const transitions = aggregateOf(log, query.source, scope, filter);
        if (!transitions.ok) {
          return err(transitions.error);
        }
        const { rows, durations } = transitions.value;
        const { items, page } = applyPage(
          orderFor(query.source, rows, query.sort, { eventDurations: durations }),
          paging,
        );
        return ok({ source: query.source, stateTransitions: items, ...page });
      }

      case 'graph': {
        const graph = aggregateOf(log, query.source, scope, filter);
        return graph.ok ? ok({ source: query.source, graph: graph.value }) : err(graph.error);
      }

      case 'metrics': {
        const captureId = scope.captureId;
        if (captureId === undefined) {
          const { items, page } = applyPage<MetricValue>([], paging);
          return ok({ source: query.source, metrics: items, ...page });
        }
        const values = await metricValues(log, query.source, scope, captureId, filter);
        if (!values.ok) {
          return err(values.error);
        }
        // One value per id in `METRIC_IDS` order, then the requested order —
        // `METRIC_IDS` order again when none is named — then the window.
        const { items, page } = applyPage(
          orderFor(query.source, orderMetrics(values.value), query.sort),
          paging,
        );
        return ok({ source: query.source, metrics: items, ...page });
      }

      default:
        return assertNever(query.source, 'Unhandled panel data source');
    }
  };

  const resolve = async (
    context: PanelDataContext,
    query: DataQuery,
  ): Promise<Result<DataResult, DebuggenError>> => {
    const started = now();
    const log = sessionLogger(logger, context.sessionId, context.captureId);
    const source = query.source;

    try {
      const paging = resolvePaging(query);
      if (!paging.ok) {
        log.debug('A panel data query was refused.', { source, code: paging.error.code });
        return err(paging.error);
      }

      const scope = resolveScope(context);
      if (!scope.ok) {
        log.warn('The capture of a panel data query could not be determined.', {
          source,
          code: scope.error.code,
        });
        return err(scope.error);
      }

      const scopedLog =
        context.captureId === undefined && scope.value.captureId !== undefined
          ? sessionLogger(logger, context.sessionId, scope.value.captureId)
          : log;
      const result = await resolveQuery(scopedLog, scope.value, query, paging.value);
      if (!result.ok) {
        scopedLog.warn('Panel data could not be resolved.', { source, code: result.error.code });
        return result;
      }

      scopedLog.debug('Panel data resolved.', {
        source,
        binding: scope.value.binding,
        hasCapture: scope.value.captureId !== undefined,
        ...pageCounts(result.value, query.sort),
        durationMs: now() - started,
      });
      return result;
    } catch {
      // Nothing the throw carried is kept: it may quote captured data.
      log.error('Panel data resolution failed unexpectedly.', { source });
      return err(
        new DebuggenError('INTERNAL', 'The panel data could not be resolved.', {
          hint: INTERNAL_FAILURE_HINT,
          details: { source, reason: 'unexpected-failure' },
        }),
      );
    }
  };

  return Object.freeze({ resolve });
}
