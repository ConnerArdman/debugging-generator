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
 * | `trace`            | `TraceTree \| null`      | the service's `TraceCorrelator` (`../telemetry/correlate.ts`) |
 * | `spans`, `events`  | `TelemetryEvent[]`      | `TelemetryRepo.query`, with filter, sort and page pushed down |
 * | `renders`          | `RenderStat[]`          | `aggregateRenders`                                      |
 * | `componentTree`    | snapshot `\| null`       | `buildComponentTreeSnapshot`                            |
 * | `requests`         | `RequestGroup[]`        | `aggregateRequests` (grouped by the ingest `request_key`, never by URL) |
 * | `queries`          | `QueryGroup[]`          | `aggregateQueries`                                      |
 * | `stateTransitions` | `StateTransition[]`     | `aggregateStateTransitions`                             |
 * | `graph`            | `DependencyGraphData`   | `buildDependencyGraph`                                  |
 * | `metrics`          | `MetricValue[]`         | the capture summary, else `computeMetrics`              |
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
 * - {@link SOURCE_SORT_KEYS} states, for every sortable source and every sort
 *   that applies to it, the full comparator chain, and every chain ends in `id`
 *   ascending. The type makes that final key mandatory. Without it two rows
 *   that tie on the sort key could trade places between two reads, and a
 *   multi-page walk would repeat one and never show the other.
 * - A sort that does not apply to a source — `count_desc` on a flat record
 *   list, `duration_desc` on instants — falls back to that source's entry in
 *   {@link DEFAULT_SORT_BY_SOURCE}, deterministically and without an error, and
 *   an omitted sort means the same default. The order is never unspecified.
 * - The three single-value sources (`trace`, `componentTree`, `graph`) carry no
 *   page. `metrics` is fixed-length and fixed-order: its values are always in
 *   `METRIC_IDS` order, whatever `sort` says, and a default-sized page returns
 *   every one of them. The protocol validates a metrics page by the same window
 *   arithmetic as any other page, so an explicit `limit` or `offset` is honoured
 *   as a window over that fixed order rather than ignored.
 *
 * ## Capture scoping
 *
 * Evidence is always read from **one** capture: the one the context names, or
 * else the session's open capture, or else its most recent one. A read never
 * spans captures, because two reproductions of an issue mixed into one table
 * would be evidence of neither. A session with no capture yet answers every
 * source with its empty value — an empty array, `null` or an empty graph — which
 * is a success the components render as their empty state.
 *
 * ## Filters
 *
 * `traceId`, `kinds`, `tier`, `minDuration` and `component` are pushed into the
 * store read for the flat sources, where the repository applies them with its
 * own indexes. The aggregate sources read the capture's events in bounded pages
 * and hand them to the aggregate, and two of them need records the filter would
 * otherwise remove: a query's caller is found by walking up its parent spans, a
 * state transition's trigger is another record entirely, and a request joins to
 * its resource-timing entry. For those, the filter narrows the aggregate's
 * **subjects** — the records of the kind group it summarises — while every other
 * record of the capture (narrowed by `traceId` only) stays in the slice as the
 * context it resolves against. Both halves are store reads; no filter is
 * re-implemented here.
 *
 * The `trace` source is the one exception: a correlated tree's structure is its
 * meaning, and the correlator never drops a node, so only `traceId` narrows it.
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
 * const result = await resolver.resolve({ sessionId }, { source: 'renders', sort: 'count_desc' });
 * if (result.ok && result.value.source === 'renders') {
 *   // result.value.renders, result.value.total, result.value.nextOffset
 * }
 * ```
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
} from '@debuggen/panel-schema';
import type { DataPage, DataResult, DataResultFor } from '@debuggen/protocol';
import { DebuggenError, assertNever, err, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, Logger, Result, SessionId, TraceId } from '@debuggen/shared';
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
  computeMetrics,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  MetricValue,
  TelemetryEvent,
  TelemetryKind,
  TraceTree,
} from '@debuggen/telemetry';

import type { AnalysisSummarizer } from '../analysis/summarize.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import type { SessionsRepo, StoredCapture } from '../store/sessions-repo.js';
import {
  TELEMETRY_QUERY_DEFAULT_OFFSET,
  TELEMETRY_QUERY_MAX_LIMIT,
} from '../store/telemetry-repo.js';
import type { TelemetryPage, TelemetryQuery, TelemetryRepo } from '../store/telemetry-repo.js';
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
 * The paged sources whose order a query may choose.
 *
 * Every paged source except `metrics`, whose order is fixed to `METRIC_IDS`
 * (see the module notes): a metric card addresses a value by id, and a
 * vocabulary-ordered list is what lets two reads of one capture agree.
 */
export type SortedDataSource = Exclude<PagedDataSource, 'metrics'>;

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

/**
 * The fields of `Row` a comparator can read: the required ones holding a
 * number or a string.
 *
 * An optional field is excluded by construction — `string | undefined` does
 * not extend `string` — so no chain can rank rows by a value some of them lack,
 * which is the one way a declared order could still leave two rows unordered.
 */
type ComparableField<Row> = {
  [K in keyof Row]-?: Row[K] extends number | string ? K : never;
}[keyof Row] &
  string;

/** One key of a comparator chain: a comparable field and a direction. */
export interface SortKey<Row> {
  /** The row field compared. */
  readonly field: ComparableField<Row>;
  /** The direction the field orders in. */
  readonly direction: SortDirection;
}

/**
 * A complete comparator chain: any number of keys, then **`id` ascending**.
 *
 * The final element is fixed by the type, so a chain that omits the stable
 * secondary key AAP 0.4.2 requires — or that names a row without an `id` — does
 * not compile. `id` is unique within every paged source (an event id, a
 * `render:` or request-group id derived from the group key, a state-transition
 * row's event id), which is what makes each chain a total order and each page
 * boundary exact.
 *
 * @typeParam Row The row type the chain orders.
 */
export type SortChain<Row> = readonly [
  ...SortKey<Row>[],
  SortKey<Row> & { readonly field: 'id'; readonly direction: 'asc' },
];

/**
 * For every sortable source, the chain each applicable sort orders by.
 *
 * A sort absent from a source's entry does not apply to it and falls back to
 * {@link DEFAULT_SORT_BY_SOURCE}.
 */
export type SourceSortKeys = {
  readonly [S in SortedDataSource]: Readonly<
    Partial<Record<DataQuerySort, SortChain<DataRowOf<S>>>>
  >;
};

/**
 * The comparator chains of every sortable source — the stable ordering half of
 * the paging contract.
 *
 * - **`spans`, `events`** — ordered by the store, which is where filtering and
 *   paging of those sources happen. The chains are the store's panel orderings
 *   (`PANEL_DURATION_DESC_ORDER_BY` and `PANEL_START_ASC_ORDER_BY` in
 *   `../store/telemetry-repo.ts`) stated as data: duration descending or start
 *   ascending, then the event id. `count_desc` does not apply to a flat record
 *   list and is not offered.
 * - **`renders`** — most renders, most total render time, or earliest first
 *   render, then the `render:` id.
 * - **`requests`** — largest group first, with the more redundant of two
 *   equally frequent groups ahead (duplicates are the finding this source
 *   exists for); or most total time; or earliest first occurrence; then the
 *   group id.
 * - **`queries`** — most executions, most total time, or earliest first
 *   execution, then the group id.
 * - **`stateTransitions`** — chronological only: a transition is an instant, so
 *   neither a duration nor a count ranks it.
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
  },
});

/**
 * The order each sortable source takes when a query names no sort, or names
 * one that does not apply to it.
 *
 * Each is the question the source is read for — and the order the renderer's
 * own table for it opens in: the slowest work first for `spans` (the "slowest
 * operations" ranking), capture order for the `events` log, the busiest
 * components and the most repeated requests first, the costliest statements
 * first, and transitions in the order they happened. Every value is a key of
 * that source's {@link SOURCE_SORT_KEYS} entry, which this module's suite
 * asserts.
 */
export const DEFAULT_SORT_BY_SOURCE: Readonly<Record<SortedDataSource, DataQuerySort>> =
  Object.freeze({
    spans: 'duration_desc',
    events: 'start_asc',
    renders: 'count_desc',
    requests: 'count_desc',
    queries: 'duration_desc',
    stateTransitions: 'start_asc',
  });

/**
 * The sort a query on `source` is actually answered in: the requested one when
 * it applies to the source, and the source's default otherwise.
 *
 * @param source A sortable source.
 * @param requested The query's `sort`, possibly absent.
 * @returns A sort with a chain in {@link SOURCE_SORT_KEYS} for `source`.
 */
export function effectiveSort(
  source: SortedDataSource,
  requested: DataQuerySort | undefined,
): DataQuerySort {
  const fallback = DEFAULT_SORT_BY_SOURCE[source];
  if (requested === undefined) {
    return fallback;
  }
  return SOURCE_SORT_KEYS[source][requested] === undefined ? fallback : requested;
}

/**
 * Compares two values of one comparable field.
 *
 * Numbers numerically, strings by UTF-16 code unit — never `localeCompare`,
 * whose answer depends on the host's locale and would let two machines page one
 * capture differently. A value of any other type sorts after both, which no
 * chain can reach because {@link ComparableField} admits only the two.
 */
function compareValues(left: unknown, right: unknown): number {
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
    return left < right ? -1 : 1;
  }
  const leftRank = typeof left === 'number' || typeof left === 'string' ? 0 : 1;
  const rightRank = typeof right === 'number' || typeof right === 'string' ? 0 : 1;
  return leftRank - rightRank;
}

/**
 * Orders rows by a comparator chain, into a fresh array.
 *
 * The input is never sorted in place: it may be an aggregate's own result,
 * which that aggregate documents as being in its base order.
 *
 * @param rows The rows to order.
 * @param chain The chain, ending in `id` ascending.
 * @returns A new array in chain order.
 */
export function orderRows<Row>(rows: readonly Row[], chain: SortChain<Row>): Row[] {
  const keys: readonly SortKey<Row>[] = chain;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const order = compareValues(left[key.field], right[key.field]);
      if (order !== 0) {
        return key.direction === 'desc' ? -order : order;
      }
    }
    return 0;
  });
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
 * How many store pages one aggregate read walks at most: `10`.
 *
 * Each page is the store's own ceiling, `TELEMETRY_QUERY_MAX_LIMIT`, so an
 * aggregate is computed from at most {@link MAX_AGGREGATE_INPUT_EVENTS} events
 * and the resolver never holds an unbounded result set in memory. A capture
 * larger than that is aggregated over its first events in start order — the
 * same window on every read — and the read is reported at `warn` with its
 * counts.
 */
export const MAX_AGGREGATE_INPUT_PAGES = 10;

/** The most events one aggregate is computed from. */
export const MAX_AGGREGATE_INPUT_EVENTS = MAX_AGGREGATE_INPUT_PAGES * TELEMETRY_QUERY_MAX_LIMIT;

/**
 * The order an aggregate's input slice is read in: capture order.
 *
 * Every aggregate is order-independent, but the **window** a bounded read
 * keeps is not, and reading in start order makes it the earliest events of the
 * capture, identically on every read.
 */
const SLICE_READ_SORT: DataQuerySort = 'start_asc';

/* -------------------------------------------------------------------------------------------------
 * Ports and dependencies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The telemetry read this module performs: `TelemetryRepo.query`, the
 * panel-data surface of the store.
 *
 * A consumer-side port picked from the production interface, so the real
 * repository satisfies it by construction and a suite supplies a plain object
 * with one function instead of an open database.
 */
export type PanelTelemetryPort = Pick<TelemetryRepo, 'query'>;

/** The trace reads this module performs, picked from the service's `TraceCorrelator`. */
export type PanelTracePort = Pick<TraceCorrelator, 'getTrace' | 'listTraceIds'>;

/**
 * The capture lookups this module performs, picked from `SessionsRepo`: a named
 * capture's owner, and a session's open and most recent captures.
 */
export type SessionCapturePort = Pick<
  SessionsRepo,
  'getCapture' | 'getActiveCapture' | 'listCaptures'
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

/** Which session, and optionally which capture, a query reads. */
export interface PanelDataContext {
  /** The session whose evidence is read; already authorised by the route. */
  readonly sessionId: SessionId;
  /**
   * The capture to read. Absent means the session's open capture, else its most
   * recent one.
   */
  readonly captureId?: CaptureId | undefined;
}

/** Resolves panel-data queries. Construct with {@link createPanelDataResolver}. */
export interface PanelDataResolver {
  /**
   * Answers one data query.
   *
   * @param context The session and optional capture to read.
   * @param query A parsed `DataQuery`.
   * @returns The `DataResult` member for `query.source` — an empty one when the
   * scope holds no matching evidence — or a typed error: `PANEL_INVALID` for a
   * paging value outside its domain, `SESSION_INVALID_STATE` for a capture that
   * is not the session's (or when no capture can be determined), `STORE_ERROR`
   * for a failed or throwing read, and `INTERNAL` for anything unforeseen. Never
   * rejects.
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

/** The one capture a query reads, or none when the session has not captured yet. */
interface ResolvedScope {
  /** The session. */
  readonly sessionId: SessionId;
  /** The capture, or `undefined` when the session holds none. */
  readonly captureId: CaptureId | undefined;
  /** The summary stored with that capture, when it has one and it describes it. */
  readonly storedSummary: CaptureSummary | undefined;
}

/** The narrowing of one store read: the filter fields `TelemetryQuery` accepts. */
type SliceNarrowing = Pick<
  TelemetryQuery,
  'traceId' | 'kinds' | 'tier' | 'minDuration' | 'component'
>;

/** A bounded read of a capture's events. */
interface EventSlice {
  /** The events read, in start order. */
  readonly events: readonly TelemetryEvent[];
  /** How many events the store holds for the narrowing. */
  readonly total: number;
  /** Whether events remain that the bound left unread. */
  readonly truncated: boolean;
  /** Stored rows the store could not reconstruct and left out. */
  readonly skipped: number;
}

/** The empty slice: what a scope without a capture, or a narrowing to no kind, reads. */
const EMPTY_SLICE: EventSlice = Object.freeze({
  events: Object.freeze([]),
  total: 0,
  truncated: false,
  skipped: 0,
});

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
 * The trace a `trace` query without a `traceId` resolves to.
 *
 * The capture summary's `primaryTraceId` — the longest interaction, which is
 * the trace a timeline filters on by default — when the stored summary names
 * one the capture still holds; otherwise the capture's first trace in the
 * store's order (earliest event first). Both are total orders, so every read
 * of one capture picks the same trace.
 */
function defaultTraceId(
  traceIds: readonly TraceId[],
  summary: CaptureSummary | undefined,
): TraceId | undefined {
  const primary = summary?.primaryTraceId;
  if (primary !== undefined && traceIds.includes(primary)) {
    return primary;
  }
  return traceIds[0];
}

/** Whether a kind narrowing selects no kind at all, and so matches nothing. */
function selectsNoKind(kinds: readonly TelemetryKind[] | undefined): boolean {
  return kinds !== undefined && kinds.length === 0;
}

/** The paging counts of a result, for a timing record. */
function pageCounts(result: DataResult): Record<string, number | boolean> {
  if (!('total' in result)) {
    return {};
  }
  return {
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
 * Holds no state of its own between calls: every query reads the store afresh,
 * so a panel reloaded during a capture sees the evidence that has arrived since.
 *
 * @param deps The store, correlator and lookups the resolver reads.
 * @returns The resolver.
 */
export function createPanelDataResolver(deps: PanelDataResolverDeps): PanelDataResolver {
  const logger = subsystemLogger(deps.logger ?? noopLogger, SUBSYSTEM);
  const now = deps.now ?? Date.now;
  const { telemetry, correlator } = deps;

  /** The one capture a query reads. */
  const resolveScope = (context: PanelDataContext): Result<ResolvedScope, DebuggenError> => {
    const { sessionId } = context;
    const sessions = deps.sessions;

    if (context.captureId !== undefined) {
      const captureId = context.captureId;
      if (sessions === undefined) {
        return ok({ sessionId, captureId, storedSummary: undefined });
      }
      const stored = guarded('reading a capture', () => sessions.getCapture(captureId));
      if (!stored.ok) {
        return err(stored.error);
      }
      const found = stored.value;
      if (found === undefined || found.sessionId !== sessionId || found.capture.id !== captureId) {
        return err(
          new DebuggenError('SESSION_INVALID_STATE', 'The session has no such capture.', {
            hint: 'Choose a capture of this session, or omit the capture to read its latest one.',
            details: { sessionId, captureId, reason: 'capture-not-in-session' },
          }),
        );
      }
      return ok({ sessionId, captureId, storedSummary: summaryFor(found, captureId) });
    }

    if (sessions === undefined) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'No capture was named and none can be looked up.',
          {
            hint: 'Name the capture to read, or construct the resolver with the session store.',
            details: { sessionId, reason: 'no-capture-lookup' },
          },
        ),
      );
    }

    const active = guarded('reading the open capture', () => sessions.getActiveCapture(sessionId));
    if (!active.ok) {
      return err(active.error);
    }
    let chosen = active.value?.sessionId === sessionId ? active.value : undefined;
    if (chosen === undefined) {
      const listed = guarded('listing captures', () => sessions.listCaptures(sessionId));
      if (!listed.ok) {
        return err(listed.error);
      }
      chosen = listed.value.filter((capture) => capture.sessionId === sessionId).at(-1);
    }
    if (chosen === undefined) {
      return ok({ sessionId, captureId: undefined, storedSummary: undefined });
    }
    const captureId = chosen.capture.id;
    return ok({ sessionId, captureId, storedSummary: summaryFor(chosen, captureId) });
  };

  /**
   * Reads a capture's events for an aggregate, page by page in start order, up
   * to {@link MAX_AGGREGATE_INPUT_EVENTS}.
   */
  const readSlice = (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    narrowing: SliceNarrowing,
  ): Result<EventSlice, DebuggenError> => {
    const captureId = scope.captureId;
    if (captureId === undefined || selectsNoKind(narrowing.kinds)) {
      return ok(EMPTY_SLICE);
    }

    const events: TelemetryEvent[] = [];
    let offset = TELEMETRY_QUERY_DEFAULT_OFFSET;
    let total = 0;
    let skipped = 0;
    let pages = 0;
    let truncated = false;

    for (;;) {
      if (pages >= MAX_AGGREGATE_INPUT_PAGES) {
        truncated = true;
        break;
      }
      const pageOffset = offset;
      const page = guarded('reading capture events', () =>
        telemetry.query({
          sessionId: scope.sessionId,
          captureId,
          ...narrowing,
          sort: SLICE_READ_SORT,
          limit: TELEMETRY_QUERY_MAX_LIMIT,
          offset: pageOffset,
        }),
      );
      if (!page.ok) {
        return err(page.error);
      }
      pages += 1;
      total = page.value.total;
      skipped += page.value.skipped ?? 0;
      for (const row of page.value.rows) {
        events.push(row);
      }
      const next = page.value.nextOffset;
      if (next === undefined) {
        break;
      }
      if (next <= pageOffset) {
        // A pager that does not advance cannot be followed; what was read is
        // kept and reported as incomplete rather than requested again forever.
        truncated = true;
        break;
      }
      offset = next;
    }

    if (truncated) {
      log.warn('An aggregate read reached its bound; the view covers the earliest events.', {
        source,
        read: events.length,
        total,
        bound: MAX_AGGREGATE_INPUT_EVENTS,
      });
    }
    if (skipped > 0) {
      log.warn('Stored events that no longer validate were left out of a panel view.', {
        source,
        skipped,
      });
    }

    return ok({ events, total, truncated, skipped });
  };

  /** The input slice of one aggregate source, per its {@link AGGREGATE_READ_PLANS} entry. */
  const readAggregateSlice = (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Result<EventSlice, DebuggenError> => {
    const plan = AGGREGATE_READ_PLANS[source];
    const subjectKinds = plan.subjectKinds;

    if (subjectKinds === undefined) {
      return readSlice(log, source, scope, {
        ...fullNarrowing(filter),
        kinds: intersectKinds(plan.sliceKinds, filter?.kinds),
      });
    }

    const context = readSlice(log, source, scope, {
      traceId: filter?.traceId,
      kinds: plan.sliceKinds,
    });
    if (!context.ok || !narrowsSubjects(filter)) {
      return context;
    }

    const subjects = readSlice(log, source, scope, {
      ...fullNarrowing(filter),
      kinds: intersectKinds(subjectKinds, filter?.kinds),
    });
    if (!subjects.ok) {
      return subjects;
    }

    const selected = new Set(subjects.value.events.map((event) => event.id));
    const events = context.value.events.filter(
      (event) => !subjectKinds.includes(event.kind) || selected.has(event.id),
    );
    return ok({
      events,
      total: context.value.total,
      truncated: context.value.truncated || subjects.value.truncated,
      skipped: context.value.skipped + subjects.value.skipped,
    });
  };

  /** One page of a flat event source, filtered, ordered and paged by the store. */
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

    const sort = effectiveSort(source, requested);
    if (requested !== undefined && requested !== sort) {
      log.debug('The requested sort does not apply to this source; using its default.', {
        source,
        requested,
        applied: sort,
      });
    }

    const page = guarded('reading a page of events', () =>
      telemetry.query({
        sessionId: scope.sessionId,
        captureId,
        ...narrowing,
        sort,
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

  /** Rows of an in-memory source, ordered by the chain of the sort that applies. */
  const orderFor = <S extends SortedDataSource>(
    log: Logger,
    source: S,
    rows: readonly DataRowOf<S>[],
    requested: DataQuerySort | undefined,
  ): Result<DataRowOf<S>[], DebuggenError> => {
    const applied = effectiveSort(source, requested);
    if (requested !== undefined && requested !== applied) {
      log.debug('The requested sort does not apply to this source; using its default.', {
        source,
        requested,
        applied,
      });
    }
    const chains: SourceSortKeys[S] = SOURCE_SORT_KEYS[source];
    const chain = chains[applied];
    if (chain === undefined) {
      return err(
        new DebuggenError('INTERNAL', 'No ordering is declared for a panel data source.', {
          hint: INTERNAL_FAILURE_HINT,
          details: { source, sort: applied, reason: 'missing-sort-chain' },
        }),
      );
    }
    return ok(orderRows(rows, chain));
  };

  /** The `trace` source: one correlated interaction, or `null`. */
  const resolveTrace = async (
    log: Logger,
    scope: ResolvedScope,
    filter: DataQueryFilter | undefined,
  ): Promise<Result<TraceTree | null, DebuggenError>> => {
    const captureId = scope.captureId;
    if (captureId === undefined) {
      return ok(null);
    }

    if (narrowsSubjects(filter)) {
      log.debug('A trace is narrowed by its trace id only; the other filter fields do not apply.', {
        ignored: filterFieldsOf(filter).filter((field) => field !== 'traceId'),
      });
    }

    let traceId = filter?.traceId;
    if (traceId === undefined) {
      const listed = await guardedAsync('listing traces', () =>
        correlator.listTraceIds(scope.sessionId, captureId),
      );
      if (!listed.ok) {
        return err(listed.error);
      }
      traceId = defaultTraceId(listed.value, scope.storedSummary);
    }
    if (traceId === undefined) {
      return ok(null);
    }

    const wanted = traceId;
    const tree = await guardedAsync('reading a trace', () =>
      correlator.getTrace(scope.sessionId, wanted, captureId),
    );
    if (!tree.ok) {
      return err(tree.error);
    }
    return ok(tree.value ?? null);
  };

  /**
   * The metric values of the capture, before ordering: the stored or loaded
   * capture summary's when the query is unfiltered, and values computed over
   * the filtered events when it narrows anything, because a summary describes
   * the whole capture and would silently ignore the filter.
   */
  const metricValues = async (
    log: Logger,
    source: AggregateDataSource,
    scope: ResolvedScope,
    captureId: CaptureId,
    filter: DataQueryFilter | undefined,
  ): Promise<Result<readonly MetricValue[], DebuggenError>> => {
    if (filterFieldsOf(filter).length === 0) {
      const captures = deps.captures;
      if (captures !== undefined) {
        const loaded = await guardedAsync('loading the capture summary', () =>
          captures.loadCaptureSummary(scope.sessionId, captureId),
        );
        if (loaded.ok && loaded.value.captureId === captureId) {
          return ok(loaded.value.metrics);
        }
        log.warn('The capture summary could not be used; computing the metrics from events.', {
          source,
          ...(loaded.ok
            ? { reason: 'summary-describes-another-capture' }
            : { reason: 'summary-load-failed', code: loaded.error.code }),
        });
      }
      if (scope.storedSummary !== undefined) {
        return ok(scope.storedSummary.metrics);
      }
    }

    const slice = readAggregateSlice(log, source, scope, filter);
    if (!slice.ok) {
      return err(slice.error);
    }
    return ok(computeMetrics(slice.value.events));
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
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        const ordered = orderFor(
          log,
          query.source,
          aggregateRenders(slice.value.events),
          query.sort,
        );
        if (!ordered.ok) {
          return err(ordered.error);
        }
        const { items, page } = applyPage(ordered.value, paging);
        return ok({ source: query.source, renders: items, ...page });
      }

      case 'componentTree': {
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        // `undefined` means "no rendering evidence", and does not survive JSON;
        // the wire value for it is `null`.
        const snapshot = buildComponentTreeSnapshot(slice.value.events) ?? null;
        return ok({ source: query.source, componentTree: snapshot });
      }

      case 'requests': {
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        const ordered = orderFor(
          log,
          query.source,
          aggregateRequests(slice.value.events),
          query.sort,
        );
        if (!ordered.ok) {
          return err(ordered.error);
        }
        const { items, page } = applyPage(ordered.value, paging);
        return ok({ source: query.source, requests: items, ...page });
      }

      case 'queries': {
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        const ordered = orderFor(
          log,
          query.source,
          aggregateQueries(slice.value.events),
          query.sort,
        );
        if (!ordered.ok) {
          return err(ordered.error);
        }
        const { items, page } = applyPage(ordered.value, paging);
        return ok({ source: query.source, queries: items, ...page });
      }

      case 'stateTransitions': {
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        // The aggregate's own cap is lifted to the slice bound, so `total` is
        // every transition in the slice rather than the aggregate's default.
        const transitions = aggregateStateTransitions(slice.value.events, {
          maxTransitions: MAX_AGGREGATE_INPUT_EVENTS,
        });
        const ordered = orderFor(log, query.source, transitions, query.sort);
        if (!ordered.ok) {
          return err(ordered.error);
        }
        const { items, page } = applyPage(ordered.value, paging);
        return ok({ source: query.source, stateTransitions: items, ...page });
      }

      case 'graph': {
        const slice = readAggregateSlice(log, query.source, scope, filter);
        if (!slice.ok) {
          return err(slice.error);
        }
        return ok({ source: query.source, graph: buildDependencyGraph(slice.value.events) });
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
        // Fixed order, whatever `sort` says: a window over `METRIC_IDS` order.
        const { items, page } = applyPage(orderMetrics(values.value), paging);
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
        hasCapture: scope.value.captureId !== undefined,
        ...pageCounts(result.value),
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
