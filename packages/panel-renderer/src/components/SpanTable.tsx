/**
 * # `components/SpanTable` — the renderer for the panel-schema `table` node
 *
 * A sortable, pageable table of captured span records: what each one was, which
 * tier produced it, when it started, how long it took, and — where the capture
 * resolved one — a chip that opens the code behind it. The catalog's `table`
 * node type maps to this component, and its job is a "Slowest Operations" view:
 * a ranking of spans, sortable via `DataTable`.
 *
 * ## This module is the pattern for every query-backed component here
 *
 * `EventLog`, `RenderTable`, `RequestTable`, `QueryTable` and
 * `StateTransitionViewer` are written against the same four decisions, and they
 * are stated here rather than left to be inferred:
 *
 * 1. **The query is derived once, in one memoised place.** It starts as the
 *    node's own {@link DataQuery}, takes the reader's sort when they have
 *    expressed one, and has its page size clamped to the bounds the schema
 *    publishes ({@link DATA_QUERY_DEFAULT_LIMIT}, {@link DATA_QUERY_MAX_LIMIT},
 *    {@link DATA_QUERY_DEFAULT_OFFSET}). Nothing else constructs a query.
 * 2. **An order the service can apply is a re-query, never an array
 *    operation.** The service applied `filter`, `sort`, `limit` and `offset`
 *    before these rows existed (`docs/ARCHITECTURE.md`, "Panel data"), so
 *    re-ordering them here would show an order the panel specification never
 *    asked for and quietly break the ranking this node exists to present. A
 *    header click that names one of the data layer's orderings changes the
 *    query and the data comes back ordered.
 *
 *    This table goes one step further, and says so. The data layer can order a
 *    span list in exactly two ways — longest duration first (`duration_desc`)
 *    and earliest start first (`start_asc`) — and its sort vocabulary for a
 *    span list is fixed to these two values. Every other column and direction
 *    a reader asks for (Operation, Kind and Tier either way, Start latest
 *    first, Duration shortest first) is a **view order**: the rows already
 *    loaded are re-arranged here, stably, with the service's own position as
 *    the tie-break, and nothing is re-queried. The rows are never re-arranged
 *    inside `primitives/DataTable`, which stays controlled; this component
 *    hands it the arranged rows and the view order as its `sort`, so the
 *    header's indicator and `aria-sort` show the order on screen. A view order
 *    changes only the arrangement, never which rows are loaded, so "Load more"
 *    still requests the next page in the service's order and the view order is
 *    re-applied to every accumulated row. While the loaded rows are not the
 *    whole result, the footer says that the order covers only those rows — the
 *    one thing a local re-arrangement could otherwise misrepresent.
 *    Re-activating a service ordering that is already applied clears the view
 *    order without a re-query, because the accumulated rows are already in
 *    that order.
 * 3. **A page is a page, and the footer says so.** A response carries `total`
 *    and `nextOffset`; this component renders the loaded count against the
 *    total and offers "Load more" only while the service reports a next offset
 *    that moves past the page on screen, requesting exactly that offset. The
 *    service is the one authority on whether another page exists: no offset is
 *    derived from the length of a page or from `total`, and when the total
 *    counts rows the service offered no page for, the footer says so instead of
 *    inventing one. It never truncates in silence, and when the service reported
 *    no total it says the total is unknown instead of implying the table is
 *    complete. The footer's sentence is a polite live region, so the new count
 *    is announced when a page arrives.
 *
 *    The footer is drawn whenever rows are on screen, including when every row
 *    is loaded ("Showing 115 of 115 spans."): a count is how a reader knows the
 *    table is complete, and a footer that appeared only for partial results
 *    would make its absence the signal. The node's `limit` is the **page
 *    size**, not a cap on the table (the data layer pages with `limit`/`offset`;
 *    `RenderTable` and `QueryTable` read it the same way), so "Load more"
 *    continues past it for as long as the service reports a next page, and
 *    while a further page is offered or loading the footer states that size so
 *    the reader can tell a page of the result from the whole of it.
 * 4. **Three states, one precedence.** A query in flight with nothing to show
 *    renders `LoadingState`; a failure with nothing to show renders
 *    `ErrorState` with the serialised query and a retry, worded by the host's
 *    one error-state contract (`queryFailureProps` in `host/useQuery`) so it
 *    reads like every other failed node in the panel; a successful result
 *    with no rows renders `EmptyState`, whose copy tells an empty capture
 *    (nothing matched) apart from a count-only query (`limit: 0`) and from a
 *    page that holds none of the rows the reported total counts, and names that
 *    total instead of claiming nothing was captured. Once rows are on screen
 *    they stay on screen: a page that fails or is still loading is reported in
 *    the footer rather than by replacing rows the reader is already reading.
 *    Once the reader has asked for an order, the grid's header stays on screen
 *    too: the state that follows a re-query is drawn in the grid's empty slot,
 *    so the sort control they activated keeps its place and their focus.
 *
 * ## What this component is not allowed to do, and therefore does not
 *
 * - **No transport.** Data arrives through {@link useQuery}, which resolves the
 *   query against the `DataProvider` the host provided; interactions leave
 *   through `PanelActions`. There is no `fetch`, no socket and no extension API
 *   in this file, which is what lets the same component render inside the
 *   DevTools panel, the editor webview and a component test
 *   (`docs/ARCHITECTURE.md`, "The renderer contract").
 * - **No redaction, no reformatting of evidence.** Everything here arrived
 *   already redacted at ingest (`docs/SECURITY.md`, "Redaction"). Names, kinds,
 *   tiers, durations and source locations are rendered as given; nothing is
 *   re-joined, re-parsed or "improved", and no attribute is copied anywhere.
 * - **No visual values.** Not one colour, length or font appears below. Colour
 *   comes from `../utils/color` as `var(--dg-*)` token references, spacing from
 *   `layout/Stack`, and everything else from the class contract
 *   `../styles/components.css` already implements for this block:
 *
 *     dg-span-table                the block — a column that may shrink
 *     dg-span-table__name-cell     the identity text: monospace, truncating
 *     dg-span-table__kind-cell     the kind chip box
 *     dg-span-table__tier-cell     the tier chip box
 *     dg-span-table__duration-cell tabular figures on the duration
 *     dg-span-table__source-cell   the source chip box
 *     dg-span-table__footer        the paging row, whose spacing and direction
 *                                  are `layout/Stack`'s and whose class is the
 *                                  hook the stylesheet may take for anything
 *                                  beyond them
 *     dg-span-table__empty         the empty state
 *     dg-span-table__loading       the loading skeleton
 *     dg-span-table__error         the failure state
 *
 * - **No project knowledge.** Every string below is product vocabulary. No
 *   component name, route or symbol of any inspected application appears in
 *   this file, its copy or its comments.
 * - **No toolbar.** The only interaction this node offers is ordering, and the
 *   grid's own sortable headers already offer it — with the applied order shown
 *   where the reader is looking, which a separate control cannot do. A toolbar
 *   here would be a second, competing way to express one intent, so there is
 *   none; `../styles/components.css` allots this block no toolbar row either.
 * - **No grid of its own.** `primitives/DataTable` owns the ARIA grid roles,
 *   the header, the roving tab stop, the keyboard model and the virtual
 *   viewport; this module contributes rows, columns and callbacks. It adds no
 *   `role`, no key handler, no second scroll container and no measurement of
 *   its own — the primitive's measurement fallback is what makes these rows
 *   render in a test environment that measures nothing.
 * - **No Tab stop inside a row.** The grid is one Tab stop, its active row;
 *   ArrowRight (or F2) moves into that row's controls and ArrowLeft or Escape
 *   returns, while ArrowUp/Down, Home/End and PageUp/PageDown move between
 *   rows and Enter or Space selects one. The one obligation that model places
 *   on a caller is met here: the only focusable control a cell renders — the
 *   source chip — carries `tabIndex={-1}`, so it is reached by those keys and
 *   by the pointer, never by Tab.
 *
 * ## Which fields it may read
 *
 * The authority is the node catalog, not this file: `PANEL_NODE_CATALOG.table`
 * declares the `TelemetryEvent` fields this node type reads, and
 * {@link TABLE_NODE_ENTRY} holds that entry. Each column declares the field it
 * requires and is rendered only while the entry grants it, so narrowing the
 * catalog withdraws a column instead of leaving this component reading a field
 * the schema no longer sanctions. The same entry supplies the sources this node
 * may read and the generic label used when the node carries no title of its own:
 * the renderer depends on the schema, never the reverse.
 *
 * @packageDocumentation
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, TableNode } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import type { TelemetryEvent } from '@debuggen/telemetry';
import clsx from 'clsx';
import { Timer } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';

import { usePanelSessionId } from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { DataTable } from '../primitives/DataTable';
import type {
  DataTableColumn,
  DataTableColumnWidth,
  DataTableSort,
  DataTableSortDirection,
} from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { kindColorVar, tierColorVar } from '../utils/color';
import {
  ELLIPSIS,
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
  formatTierLabel,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The catalog entry, and everything taken from it
 * ---------------------------------------------------------------------------
 */

/**
 * `PANEL_NODE_CATALOG.table` — the single registry entry for the node type this
 * component renders.
 *
 * Read once at module scope because it is frozen data: the sources this node may
 * query, the `TelemetryEvent` fields it may read, and the generic label a
 * caption falls back to all come from here rather than from a list retyped in
 * this file.
 */
const TABLE_NODE_ENTRY = catalogEntryFor('table');

/**
 * Whether the catalog entry grants this component the named event field.
 *
 * @param field The `TelemetryEvent` field a column or a cell part wants.
 * @returns `true` while the entry's `reads` list names it.
 */
function readsField(field: keyof TelemetryEvent): boolean {
  return TABLE_NODE_ENTRY.reads.includes(field);
}

/*
 * ---------------------------------------------------------------------------
 * Sources: the two the result shape of this node resolves to
 * ---------------------------------------------------------------------------
 */

/**
 * The data-query sources whose result is a flat list of span records — the only
 * shape this table can draw.
 */
type SpanSource = 'spans' | 'events';

/** The query this component issues: a data query narrowed to a span source. */
type SpanQuery = DataQuery & { source: SpanSource };

/**
 * Narrow a node's authored source to one this table can render.
 *
 * Two checks, deliberately: the catalog entry decides which sources the node
 * type is permitted to read, and the literal comparison is what lets TypeScript
 * see that the result resolves to a list of events
 * (`DataResultFor<'spans' | 'events'>`). The two agree today and the catalog is
 * the one a reviewer should change; the literals exist because a type cannot be
 * narrowed by a runtime array lookup.
 *
 * @param source The source named by the node's query.
 * @returns The narrowed source, or `undefined` when this table cannot draw it.
 */
function spanSourceOf(source: DataQuery['source']): SpanSource | undefined {
  if (!TABLE_NODE_ENTRY.sources.includes(source)) {
    return undefined;
  }

  return source === 'spans' || source === 'events' ? source : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Paging: the bounds the schema publishes, applied here
 * ---------------------------------------------------------------------------
 */

/**
 * The page size of a count-only query: an explicit request for the total and no
 * rows, and the smallest page size {@link clampLimit} returns.
 */
const COUNT_ONLY_LIMIT = 0;

/**
 * The page size to request, inside the bounds the schema publishes.
 *
 * An absent or unusable value falls back to the schema's default page size, and
 * anything larger than the published maximum is clamped to it — the service
 * would reject a larger page anyway, and asking for one would turn a bounded
 * table into a failed query.
 *
 * An explicit zero is preserved exactly and sent as `limit: 0`. The schema
 * accepts it as a request for a total without rows (`panel-schema`'s
 * `nodes/query`: only the absence of the field means "unset"), and the service
 * echoes it on the page it returns, so raising it to one row would draw a row
 * the panel specification never asked for. Such a query is never paged — see
 * {@link forwardOffsetOf} — and its successful answer is drawn as a count-only
 * state that names the total instead of as an empty capture.
 *
 * @param limit The `limit` the node's query carried, if any.
 * @returns A whole page size within `[0, DATA_QUERY_MAX_LIMIT]`.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), COUNT_ONLY_LIMIT), DATA_QUERY_MAX_LIMIT);
}

/**
 * The offset the node's first page starts at.
 *
 * @param offset The `offset` the node's query carried, if any.
 * @returns A whole, non-negative offset, defaulting to the schema's base.
 */
function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return DATA_QUERY_DEFAULT_OFFSET;
  }

  return Math.max(Math.floor(offset), DATA_QUERY_DEFAULT_OFFSET);
}

/*
 * ---------------------------------------------------------------------------
 * Serialisation: one stable string, used for identity
 * ---------------------------------------------------------------------------
 */

/**
 * A data query as a compact, stable string: keys sorted, absent members
 * dropped, so the same query always serialises identically.
 *
 * Used for one thing and nothing else — the identity of a page sequence (see
 * {@link PageAccumulator}). It is never shown to a reader: the text an
 * `ErrorState` shows for a failed query is the host's one formatter's
 * (`formatDataQuery`, reached through `queryFailureProps` and
 * `unsupportedQueryProps`), so every node prints a query the same way. A data
 * query holds a source, a narrowing filter, an ordering and two whole numbers;
 * there is nothing sensitive in it to withhold.
 *
 * Deliberately mirrors the serialiser inside `host/useQuery`: this component
 * must be able to tell "the same query, one page further" from "a different
 * query" by exactly the rule the hook uses to decide whether to re-issue one.
 *
 * @param value The query, or any part of one.
 * @returns The stable rendering of `value`.
 */
function stableJson(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;

      return `[${items.map(stableJson).join(',')}]`;
    }

    const record = value as Readonly<Record<string, unknown>>;
    const members = Object.keys(record)
      .sort()
      .filter((name) => record[name] !== undefined)
      .map((name) => `${JSON.stringify(name)}:${stableJson(record[name])}`);

    return `{${members.join(',')}}`;
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return 'null';
  }
}

/*
 * ---------------------------------------------------------------------------
 * Columns, and the ordering vocabulary they map onto
 * ---------------------------------------------------------------------------
 */

/*
 * A column's key is the name of the event field it orders by, so the key the
 * table reports upward through `onSortChange` names the field a view order
 * compares and the field a service ordering ranks by. `satisfies` is what keeps
 * that true: renaming a field in the event schema fails this file rather than
 * silently producing a column that sorts nothing.
 */
const NAME_COLUMN_KEY = 'name' satisfies keyof TelemetryEvent;
const KIND_COLUMN_KEY = 'kind' satisfies keyof TelemetryEvent;
const TIER_COLUMN_KEY = 'tier' satisfies keyof TelemetryEvent;
const START_COLUMN_KEY = 'startTime' satisfies keyof TelemetryEvent;
const DURATION_COLUMN_KEY = 'duration' satisfies keyof TelemetryEvent;

/*
 * The column width ROLES. A role names what a column holds, never how wide it
 * is: `primitives/DataTable` resolves each one through
 * `DATA_TABLE_COLUMN_TRACKS` to a grid track built from the `--dg-column-min-*`
 * floor and `--dg-column-share-*` share tokens, so this table agrees with every
 * other table on both extension surfaces about how wide a name or a duration
 * is, and no length is chosen here. Each column below takes the smallest role
 * whose floor keeps its content readable, in the vocabulary every table shares,
 * and every role's track has two parts:
 *
 * - The FLOOR is what a compact column never shrinks below; a truncating
 *   column (`name`, `text`) may narrow to the `--dg-column-yield` fraction of
 *   its floor, and only when that makes the table fit its panel, so names
 *   narrow while figures stay in view. `primitives/DataTable` sums the floors
 *   and those minimums into the grid's own width, so a surface too narrow even
 *   for the minimums keeps every floor and scrolls the table horizontally with
 *   every column readable, instead of squeezing each column to its padding and
 *   letting one cell's content paint over the next.
 * - The SHARE is a ratio, so a column lands at the same offset in every row
 *   (the header and each row are separate grid containers), and the largest
 *   share of spare width goes to the operation name, the one long and variable
 *   value here.
 */

/**
 * The operation name, its failure chip and its source chip: an identifier, so
 * the `name` role, whose floor keeps a readable excerpt of the name beside a
 * compact source chip whose file label ellipsizes, and whose share is the
 * widest of the table's, so the full name wins spare width.
 */
const NAME_COLUMN_WIDTH: DataTableColumnWidth = 'name';

/** The kind chip, a short categorical label such as "Performance entry". */
const KIND_COLUMN_WIDTH: DataTableColumnWidth = 'label';

/** The tier chip, a short badge such as "Database". */
const TIER_COLUMN_WIDTH: DataTableColumnWidth = 'status';

/**
 * The relative start, a formatted offset with its unit such as "12,345.678 s",
 * under a sortable header.
 */
const START_COLUMN_WIDTH: DataTableColumnWidth = 'quantity';

/**
 * The duration, a formatted measurement with its unit - a millisecond value
 * such as "999.99 ms" or seconds such as "1,234.567 s" - under a sortable
 * header.
 */
const DURATION_COLUMN_WIDTH: DataTableColumnWidth = 'quantity';

/** The key of one of this table's columns. */
type SpanColumnKey =
  | typeof NAME_COLUMN_KEY
  | typeof KIND_COLUMN_KEY
  | typeof TIER_COLUMN_KEY
  | typeof START_COLUMN_KEY
  | typeof DURATION_COLUMN_KEY;

/** Every column key, for narrowing the plain string the primitive reports. */
const SPAN_COLUMN_KEYS: readonly SpanColumnKey[] = Object.freeze([
  NAME_COLUMN_KEY,
  KIND_COLUMN_KEY,
  TIER_COLUMN_KEY,
  START_COLUMN_KEY,
  DURATION_COLUMN_KEY,
]);

/**
 * Narrow a key `primitives/DataTable` reported to one of this table's columns.
 *
 * @param key The {@link DataTableSort.key} the primitive proposed.
 * @returns The column key, or `undefined` for a key this table never rendered.
 */
function spanColumnKeyOf(key: string): SpanColumnKey | undefined {
  return SPAN_COLUMN_KEYS.find((candidate) => candidate === key);
}

/**
 * One column and one direction of this table: what the reader asked for by
 * activating a header, and — when the service cannot apply it — the view order
 * the loaded rows are arranged in. Assignable to {@link DataTableSort}, which
 * is how the arranged order reaches the header's indicator and `aria-sort`.
 */
interface SpanOrder {
  /** The column the rows are ordered by. */
  readonly key: SpanColumnKey;

  /** The direction that ordering runs in. */
  readonly direction: DataTableSortDirection;
}

/**
 * The name each column's ordering is reported under, as the first half of
 * `<column>_<direction>` — see {@link sortReportFor}.
 */
const SORT_REPORT_COLUMN_NAMES: Readonly<Record<SpanColumnKey, string>> = Object.freeze({
  [NAME_COLUMN_KEY]: 'name',
  [KIND_COLUMN_KEY]: 'kind',
  [TIER_COLUMN_KEY]: 'tier',
  [START_COLUMN_KEY]: 'start',
  [DURATION_COLUMN_KEY]: 'duration',
});

/**
 * What an order change is reported to the host as, through
 * `PanelActions.onFilterChange(nodeId, { sort })`.
 *
 * `<column>_<direction>` for every column (`name_asc`, `tier_desc`, …). The two
 * orderings the service applies are spelled exactly as the data layer spells
 * them — `duration_desc` and `start_asc` — so a host that remembers the
 * reader's choice sees the {@link DataQuerySort} names for those two, and a
 * name outside that vocabulary is, by construction, a view order.
 *
 * @param order The column and direction now in force.
 * @returns The report's `sort` value.
 */
function sortReportFor(order: SpanOrder): string {
  return `${SORT_REPORT_COLUMN_NAMES[order.key]}_${order.direction}`;
}

/**
 * The ordering a data query can actually be given, rendered as the table's own
 * sort state so the header shows the order that was applied rather than one the
 * service was never asked for.
 *
 * `count_desc` is a grouped-source ordering: a span list has no count, so a node
 * carrying it is drawn in the order the service returned and no column claims an
 * ordering. Same for a query with no `sort` at all.
 *
 * @param sort The ordering the effective query carries, if any.
 * @returns The column and direction to show as sorted, or `null` for none.
 */
function displaySortFor(sort: DataQuerySort | undefined): SpanOrder | null {
  if (sort === 'duration_desc') {
    return { key: DURATION_COLUMN_KEY, direction: 'desc' };
  }

  if (sort === 'start_asc') {
    return { key: START_COLUMN_KEY, direction: 'asc' };
  }

  return null;
}

/**
 * The data-query ordering that applies a requested order, when the service can
 * apply it.
 *
 * The data layer orders a span list in two ways only, and its sort vocabulary
 * is fixed to them: longest duration first and earliest start first. Exactly
 * those two column-and-direction pairs are service orders, and re-query; every
 * other pair — including the reverse of either — yields `undefined` and becomes
 * a view order over the rows already loaded (module decision 2). The direction
 * is therefore part of the mapping: re-activating the sorted Duration header,
 * which the primitive proposes as a flip to ascending, is a view order rather
 * than a silent no-op or a re-query that would come back in the same order.
 *
 * @param order The column and direction the reader asked for.
 * @returns The ordering to request, or `undefined` when the service has none.
 */
function serviceSortFor(order: SpanOrder): DataQuerySort | undefined {
  if (order.key === DURATION_COLUMN_KEY && order.direction === 'desc') {
    return 'duration_desc';
  }

  if (order.key === START_COLUMN_KEY && order.direction === 'asc') {
    return 'start_asc';
  }

  return undefined;
}

/*
 * ---------------------------------------------------------------------------
 * View orders: arranging the rows already loaded
 * ---------------------------------------------------------------------------
 */

/**
 * Compares operation names and kind labels as a reader reads them: by the
 * runtime's locale, with digit runs compared as numbers so `step 2` precedes
 * `step 10`. Built once, because a collator is costly to construct and cheap to
 * call.
 */
const DISPLAY_TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * The tiers in the order a request travels through them: the page, then the
 * server, then the datastore. Ascending Tier follows this pipeline order,
 * descending reverses it. Keyed by the closed tier vocabulary, so a tier added
 * to the event schema fails this file until it is placed.
 */
const TIER_PIPELINE_RANK: Readonly<Record<TelemetryEvent['tier'], number>> = Object.freeze({
  browser: 0,
  server: 1,
  db: 2,
});

/** `1` for ascending, `-1` for descending: the factor a comparison is scaled by. */
type OrderSign = 1 | -1;

/**
 * Compares two figures in the requested direction, with any value that is not
 * a finite number placed after every finite one in either direction: such a
 * value renders as "n/a", and a reversal should not bring the unmeasured rows
 * to the top of a ranking.
 *
 * @param left The first figure.
 * @param right The second figure.
 * @param sign The direction factor.
 * @returns A negative number, zero or a positive number, as `Array#sort` expects.
 */
function compareFigures(left: number, right: number, sign: OrderSign): number {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);

  if (!leftFinite || !rightFinite) {
    if (leftFinite === rightFinite) {
      return 0;
    }

    return leftFinite ? -1 : 1;
  }

  return sign * (left - right);
}

/**
 * The pipeline position of a tier, or `NaN` — which {@link compareFigures}
 * places last — for a tier this build does not know. The annotation widens the
 * lookup so that runtime case is handled rather than assumed away.
 *
 * @param tier The event's tier.
 * @returns Its rank in {@link TIER_PIPELINE_RANK}.
 */
function tierRankOf(tier: TelemetryEvent['tier']): number {
  const rank: number | undefined = TIER_PIPELINE_RANK[tier];

  return rank ?? Number.NaN;
}

/** Compares two rows by one column, in the direction the sign names. */
type RowComparator = (left: TelemetryEvent, right: TelemetryEvent, sign: OrderSign) => number;

/**
 * How each column compares two rows: text columns by the text the cell
 * displays, through {@link DISPLAY_TEXT_COLLATOR}; Tier by pipeline position;
 * Start and Duration numerically. Keyed by every column, so a column added to
 * {@link SpanColumnKey} fails this file until it can be ordered.
 */
const ROW_COMPARATORS: Readonly<Record<SpanColumnKey, RowComparator>> = Object.freeze({
  [NAME_COLUMN_KEY]: (left, right, sign) =>
    sign * DISPLAY_TEXT_COLLATOR.compare(left.name, right.name),
  [KIND_COLUMN_KEY]: (left, right, sign) =>
    sign * DISPLAY_TEXT_COLLATOR.compare(formatKindLabel(left.kind), formatKindLabel(right.kind)),
  [TIER_COLUMN_KEY]: (left, right, sign) =>
    compareFigures(tierRankOf(left.tier), tierRankOf(right.tier), sign),
  [START_COLUMN_KEY]: (left, right, sign) => compareFigures(left.startTime, right.startTime, sign),
  [DURATION_COLUMN_KEY]: (left, right, sign) => compareFigures(left.duration, right.duration, sign),
});

/**
 * The loaded rows arranged in a view order, as a new array.
 *
 * Stable by construction rather than by trusting the engine: rows that compare
 * equal keep the position the service gave them, in both directions, so a
 * reversal re-ranks only what differs and the service's own tie-break (its
 * stable secondary key) still decides among equals. The input is
 * never mutated: it is the accumulated service-ordered sequence that "Load
 * more" appends to.
 *
 * @param rows The accumulated rows, in the service's order.
 * @param order The view order to arrange them in.
 * @returns The same rows, re-arranged.
 */
function arrangeRows(rows: readonly TelemetryEvent[], order: SpanOrder): readonly TelemetryEvent[] {
  const compare = ROW_COMPARATORS[order.key];
  const sign: OrderSign = order.direction === 'asc' ? 1 : -1;
  const positioned = rows.map((event, position) => ({ event, position }));

  positioned.sort((left, right) => {
    const primary = compare(left.event, right.event, sign);

    return primary === 0 ? left.position - right.position : primary;
  });

  return positioned.map((entry) => entry.event);
}

/*
 * ---------------------------------------------------------------------------
 * Copy. Product vocabulary only - nothing here names anything from an
 * inspected project.
 * ---------------------------------------------------------------------------
 */

const NAME_HEADER = 'Operation';
const KIND_HEADER = 'Kind';
const TIER_HEADER = 'Tier';
const START_HEADER = 'Start';
const DURATION_HEADER = 'Duration';

/*
 * Every header's accessible name is its column's name and nothing about a
 * direction: each column sorts both ways, and the direction in force is
 * reported by the header cell's `aria-sort`, never by a label that would go
 * stale the moment the reader reversed it.
 */

/** Names the sort control of a column whose values are relative, not absolute. */
const START_HEADER_LABEL = 'Start, relative to the earliest listed operation';

const EMPTY_MESSAGE = 'No spans matched this query.';
const EMPTY_TITLE = 'No spans';
const COUNT_ONLY_TITLE = 'Count only';
const COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';
const EMPTY_PAGE_TITLE = 'Nothing on this page';
/**
 * What the first page's loading state announces, ending in the single `…` every
 * busy region in a panel announces itself with.
 */
const LOADING_LABEL = `Loading captured spans${ELLIPSIS}`;
const LOAD_MORE_LABEL = 'Load more';
const LOADING_MORE_LABEL = `Loading${ELLIPSIS}`;

/*
 * ---------------------------------------------------------------------------
 * Cell rendering
 * ---------------------------------------------------------------------------
 */

/** What {@link buildColumns} needs from the component to render its cells. */
interface ColumnContext {
  /**
   * The earliest start time among the rows on screen, in epoch milliseconds, or
   * `undefined` when no row carried a usable one. Start times are shown relative
   * to it — see {@link START_HEADER_LABEL}, which is what tells a reader the
   * reference point rather than leaving them to assume the capture's own start.
   */
  readonly origin: number | undefined;

  /**
   * Where a source chip's activation goes. Supplied from `PanelActions`, and
   * `undefined` when the host offered no handler, in which case `SourceLink`
   * renders a static chip instead of a control that cannot act.
   */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

/**
 * Keeps a source chip's activation from also activating its row.
 *
 * `DataTable` already declines to activate a row for a click that originated
 * inside a control, and the chip is a real button, so this is the second of two
 * independent guarantees rather than the only one — and it is the one that lives
 * beside the chip, where a reader of this file can see it.
 *
 * @param event The click on the chip's box.
 */
function stopRowActivation(event: ReactMouseEvent<HTMLSpanElement>): void {
  event.stopPropagation();
}

/**
 * The row's own identity, and the React key of its row.
 *
 * @param event The span record.
 * @returns The event id, which the capture guarantees unique.
 */
function rowKeyOf(event: TelemetryEvent): string {
  return event.id;
}

/**
 * The pointer a row stands for: what it reports when activated and what it is
 * matched against the panel's selection by.
 *
 * The span's own coordinates travel with the id, so a selection another view
 * reported for the same span under a different record id still marks this row
 * (see `matchesPanelSelection`).
 *
 * @param event The span record.
 * @returns The event reference `PanelActions.onSelectEvent` takes.
 */
function eventRefOf(event: TelemetryEvent): PanelEventRef {
  return { eventId: event.id, spanId: event.spanId, traceId: event.traceId };
}

/**
 * The key of the loaded row that stands for the panel's selected event.
 *
 * Only rows on screen can be marked: a selection whose event this table has not
 * loaded — or never will, because its query does not select it — leaves every
 * row unselected rather than inventing a mark, and the row is marked the moment
 * a page that holds it arrives.
 *
 * @param rows The rows on screen, in the service's order: the first record that
 *   matches keeps the mark under every view order.
 * @param selection The panel's selection, or `undefined` for none.
 * @returns The matching row's key, or `null` when no loaded row stands for it.
 */
function selectedRowKeyOf(
  rows: readonly TelemetryEvent[],
  selection: PanelSelection | undefined,
): string | null {
  if (selection === undefined) {
    return null;
  }

  const match = rows.find((event) => matchesPanelSelection(selection, eventRefOf(event)));

  return match === undefined ? null : rowKeyOf(match);
}

/**
 * The columns to render, in display order.
 *
 * Each column names the one event field it cannot render without, and is
 * included only while {@link TABLE_NODE_ENTRY} grants that field: the catalog is
 * the authority on what this node type reads, so a narrowing there withdraws a
 * column rather than leaving this file reading a field the schema no longer
 * sanctions. The optional parts of the identity cell — the failure chip and the
 * source chip — are gated the same way.
 *
 * @param context The per-render values the cells close over.
 * @returns The column definitions for `primitives/DataTable`.
 */
function buildColumns(context: ColumnContext): readonly DataTableColumn<TelemetryEvent>[] {
  const { origin, onOpenSource } = context;
  const showStatus = readsField('status');
  const showSource = readsField('source');

  const columns: DataTableColumn<TelemetryEvent>[] = [];

  if (readsField('name')) {
    columns.push({
      key: NAME_COLUMN_KEY,
      header: NAME_HEADER,
      width: NAME_COLUMN_WIDTH,
      // The row's header cell, so a reader hears the operation named as they
      // move across the row rather than hearing five unattributed values.
      rowHeader: true,
      // A view order either way (module decision 2): A to Z first.
      sortable: true,
      defaultSortDirection: 'asc',
      cell: (event) => (
        <>
          <Text as="span" size="sm" truncate className="dg-span-table__name-cell">
            {event.name}
          </Text>
          {showStatus && event.status === 'error' ? (
            <Badge tone="danger" variant="soft">
              {formatStatusLabel(event.status)}
            </Badge>
          ) : null}
          {showSource && event.source !== undefined ? (
            <span className="dg-span-table__source-cell" onClick={stopRowActivation}>
              {/* `tabIndex={-1}`: the grid is ONE Tab stop, its active row, and its
                  arrow keys move focus onto this chip (`primitives/DataTable`'s
                  keyboard model). Left in the Tab order, every row would add a
                  stop of its own. Pointer activation and Enter/Space on the
                  focused chip are unchanged. */}
              <SourceLink
                location={event.source}
                compact
                onOpenSource={onOpenSource}
                tabIndex={-1}
              />
            </span>
          ) : null}
        </>
      ),
    });
  }

  if (readsField('kind')) {
    columns.push({
      key: KIND_COLUMN_KEY,
      header: KIND_HEADER,
      width: KIND_COLUMN_WIDTH,
      // A view order either way, by the label the chip displays.
      sortable: true,
      defaultSortDirection: 'asc',
      cell: (event) => (
        <span className="dg-span-table__kind-cell">
          {/* The kind scale is spent on the chip's hairline, never on its label:
              the scale is held to the non-text contrast ratio. */}
          <Badge variant="soft" color={kindColorVar(event.kind)}>
            {formatKindLabel(event.kind)}
          </Badge>
        </span>
      ),
    });
  }

  if (readsField('tier')) {
    columns.push({
      key: TIER_COLUMN_KEY,
      header: TIER_HEADER,
      width: TIER_COLUMN_WIDTH,
      // A view order either way: pipeline order (browser, server, database)
      // first, then its reverse.
      sortable: true,
      defaultSortDirection: 'asc',
      cell: (event) => (
        <span className="dg-span-table__tier-cell">
          <Badge variant="outline" color={tierColorVar(event.tier)}>
            {formatTierLabel(event.tier)}
          </Badge>
        </span>
      ),
    });
  }

  if (readsField('startTime')) {
    columns.push({
      key: START_COLUMN_KEY,
      header: START_HEADER,
      headerLabel: START_HEADER_LABEL,
      width: START_COLUMN_WIDTH,
      align: 'end',
      sortable: true,
      // Earliest first is the service's `start_asc`; latest first is a view order.
      defaultSortDirection: 'asc',
      cell: (event) => (
        <Text as="span" size="sm" numeric>
          {origin === undefined ? NOT_AVAILABLE_LABEL : formatOffset(event.startTime, origin)}
        </Text>
      ),
    });
  }

  if (readsField('duration')) {
    columns.push({
      key: DURATION_COLUMN_KEY,
      header: DURATION_HEADER,
      width: DURATION_COLUMN_WIDTH,
      align: 'end',
      sortable: true,
      // Longest first is the service's `duration_desc`; shortest first is a
      // view order.
      defaultSortDirection: 'desc',
      cell: (event) => (
        // Severity - and the thresholds behind it - belong to `../utils/color`
        // and are applied by the primitive. Never re-derived here.
        <DurationCell
          ms={event.duration}
          severity="auto"
          className="dg-span-table__duration-cell"
        />
      ),
    });
  }

  return columns;
}

/*
 * ---------------------------------------------------------------------------
 * Coverage: what the footer is allowed to claim
 * ---------------------------------------------------------------------------
 */

/** The row count this table holds when nothing has resolved yet. */
const NO_ROWS: readonly TelemetryEvent[] = Object.freeze([]);

/** The first position of a page, as a reader counts positions. */
const FIRST_POSITION_OFFSET = 1;

/**
 * The noun for a row count, so a single row is not described in the plural.
 *
 * @param count The count the noun follows.
 * @returns The singular or plural product term.
 */
function spanNoun(count: number): string {
  return count === 1 ? 'span' : 'spans';
}

/**
 * One honest sentence about how much of the query's result is on screen.
 *
 * Three cases, and the third is the one that matters: a service that reported no
 * total leaves this component unable to know whether more rows exist, and saying
 * so is the only truthful option — a count presented on its own would read as
 * the whole of the capture. A query that starts part-way through the result also
 * names its starting position, because "12 of 900" would otherwise suggest the
 * first twelve.
 *
 * @param loaded How many rows are on screen.
 * @param total The total the service reported for the whole query, if any.
 * @param baseOffset The offset the node's first page started at.
 * @returns The footer's sentence.
 */
function describeCoverage(loaded: number, total: number | undefined, baseOffset: number): string {
  const loadedText = formatCount(loaded);

  if (total === undefined) {
    return `Showing ${loadedText} ${spanNoun(loaded)}. The total for this query was not reported.`;
  }

  const totalText = `${formatCount(total)} ${spanNoun(total)}`;

  if (baseOffset === DATA_QUERY_DEFAULT_OFFSET) {
    return `Showing ${loadedText} of ${totalText}.`;
  }

  return `Showing ${loadedText} of ${totalText}, from position ${formatCount(
    baseOffset + FIRST_POSITION_OFFSET,
  )}.`;
}

/**
 * The sentence the footer adds when the reported total and the service's paging
 * disagree: the total counts rows beyond those on screen, yet the service
 * reported no page that moves past the one that resolved.
 *
 * The service is the authority on paging — `nextOffset: null` means the end of
 * the data even when `total` is stale or surprising (`DataPage.nextOffset`) — so
 * no page is invented to reach the rows the total counts. The reader is told how
 * many remain and why they cannot be loaded from this view, rather than being
 * offered a control that would request a page the service never offered.
 *
 * @param remaining How many rows the total counts beyond those on screen; positive.
 * @returns The footer's explanatory sentence.
 */
function describeUnreachable(remaining: number): string {
  return `The service reported no further page past this one, so the remaining ${formatCount(
    remaining,
  )} ${spanNoun(remaining)} cannot be loaded here.`;
}

/**
 * The sentence the footer adds while a view order is applied to rows that are
 * not the whole result: a further page exists, the total is unknown, the node
 * starts part-way through, or the total counts rows that are not loaded.
 *
 * A view order arranges only what is on screen (module decision 2), so without
 * this sentence a reader would take the first row under "Kind, A to Z" or
 * "Duration, shortest first" as the first of the whole capture — the silent
 * re-ordering of a visible slice that `primitives/DataTable` refuses to do on
 * its own. The sentence names the scope and the two orderings that do cover
 * the full result, so the reader knows which header to use for a ranking of
 * everything that matched.
 *
 * @param loaded How many rows the view order arranged; positive.
 * @returns The footer's scope sentence.
 */
function describeViewOrderScope(loaded: number): string {
  return `This order covers only the ${formatCount(loaded)} loaded ${spanNoun(
    loaded,
  )}; the service orders the full result only by longest duration or earliest start.`;
}

/**
 * The sentence the footer adds while a further page is offered or loading: the
 * page size each "Load more" request asks for.
 *
 * The node's `limit` is a page size, never a cap on the table (module decision
 * 3), so a node authored with `limit: 10` shows ten rows first and "Load more"
 * continues past them. Stating the size is what keeps that honest: without it
 * a reader could take "Showing 10 of 115" for a table the panel meant to stop
 * at ten.
 *
 * @param limit The page size the query requests; positive.
 * @returns The footer's page-size sentence.
 */
function describePageSize(limit: number): string {
  return `Each page holds up to ${formatCount(limit)} ${spanNoun(limit)}.`;
}

/** What the empty state says: an optional first line, and the sentence under it. */
interface EmptyPageCopy {
  /** The short label above the sentence, or `undefined` for none. */
  readonly title: string | undefined;

  /** The sentence itself. */
  readonly message: string;
}

/**
 * The copy of the empty capture — nothing matched the query — as one frozen
 * value, so the empty state recognises the case by reference and gives it the
 * view's glyph. Every other empty page is a statement about paging.
 */
const NOTHING_CAPTURED_COPY: EmptyPageCopy = Object.freeze({
  title: EMPTY_TITLE,
  message: EMPTY_MESSAGE,
});

/**
 * The copy for a successful query that left no row on screen.
 *
 * An empty page is not the same thing as an empty capture: a page can hold
 * nothing while the query matched plenty, because it asked for no rows or
 * because it starts past the rows that matched (`nodes/query`: an offset past
 * the end is an empty page, not an error). Saying "nothing matched" for those
 * would contradict the total the service reported, so the cases are told apart,
 * first match wins:
 *
 * 1. **Count only** — the query asked for no rows ({@link COUNT_ONLY_LIMIT}). Its
 *    empty page is its answer: titled as a count, naming the total, or saying
 *    that none was reported.
 * 2. **A further page exists** — the service named a forward next offset
 *    (`hasFollowingPage`). The state says so, and the caller places the
 *    "Load more" control that reaches it.
 * 3. **Nothing matched** — the total is zero, or no total was reported for a
 *    page starting at the first item. The only case that reads as an empty
 *    capture, and the product's original sentence.
 * 4. **Past the end** — the page starts at or beyond the total.
 * 5. **Matched, not on this page** — the total counts rows at or after this
 *    page's position, none arrived, and the service named no further page. The
 *    total and the paging disagree, and the service's paging wins, so the state
 *    adds {@link describeUnreachable}'s sentence: how many matched rows remain
 *    past this position and that this view cannot load them. No page is
 *    invented to reach them.
 * 6. **No total, part-way through** — the page starts after the first item and
 *    the service reported no total, so whether earlier rows exist is unknown.
 *
 * `pageOffset` is the offset the resolved page was requested at: the node's own
 * base offset for the first page, and the service's next offset for a page
 * reached through "Load more" from an earlier empty one.
 *
 * @param limit The page size the query was requested with.
 * @param total The total the service reported for the whole query, if any.
 * @param pageOffset The offset the resolved page was requested at.
 * @param hasFollowingPage Whether the service named a forward next page.
 * @returns The empty state's title and message.
 */
function describeEmptyPage(
  limit: number,
  total: number | undefined,
  pageOffset: number,
  hasFollowingPage: boolean,
): EmptyPageCopy {
  // A count of none takes the plural: "holds no spans".
  const noneNoun = spanNoun(0);

  if (limit === COUNT_ONLY_LIMIT) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        total === undefined
          ? COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE
          : `This view requests a count without rows: ${formatCount(total)} ${spanNoun(
              total,
            )} matched its query.`,
    };
  }

  if (hasFollowingPage) {
    return {
      title: EMPTY_PAGE_TITLE,
      message:
        total === undefined
          ? `This page holds no ${noneNoun}, and the service reported a further page.`
          : `This page holds none of the ${formatCount(total)} ${spanNoun(
              total,
            )} that matched this query, and the service reported a further page.`,
    };
  }

  if (total === 0 || (total === undefined && pageOffset === DATA_QUERY_DEFAULT_OFFSET)) {
    return NOTHING_CAPTURED_COPY;
  }

  const position = formatCount(pageOffset + FIRST_POSITION_OFFSET);

  if (total === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${position} and holds no ${noneNoun}; no total was reported for this query.`,
    };
  }

  const matched = `${formatCount(total)} ${spanNoun(total)}`;

  if (pageOffset >= total) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${position}, past the end of the ${matched} that matched this query.`,
    };
  }

  // Reached only without a forward page and with rows requested, so the total
  // counts rows the service's paging will never deliver: say so, as the footer
  // does for a populated page, rather than leave the disagreement unexplained.
  return {
    title: EMPTY_PAGE_TITLE,
    message: `${matched} matched this query, but none are shown on this page. ${describeUnreachable(
      total - pageOffset,
    )}`,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Paging: where the next page starts, and who decides
 * ---------------------------------------------------------------------------
 */

/**
 * The offset of the following page, when the service reported one this table
 * may request.
 *
 * The service's `nextOffset` is the only authority on whether another page
 * exists: it is `null` on the last page, which `host/useQuery` folds into
 * `undefined`. This table never computes an offset of its own — not from the
 * length of the page that arrived, which drifts the moment a limit is clamped,
 * and not from `total`, which can disagree with the paging the service applied.
 *
 * A reported offset is honoured only when it is a safe whole number strictly
 * past the offset the resolved page was requested at. One at or before that
 * offset would re-request rows already on screen, so a table that followed it
 * would page in place forever; it is treated as the end of the data instead.
 *
 * A count-only query ({@link COUNT_ONLY_LIMIT}) is never paged, whatever the
 * service reported: every page of it is a page of nothing, so following a next
 * offset could only issue a second request that draws nothing more.
 *
 * @param nextOffset The next offset the resolved page reported, if any.
 * @param pageOffset The offset the resolved page was requested at.
 * @param limit The page size the resolved page was requested with.
 * @returns The offset to request next, or `undefined` when there is no forward page.
 */
function forwardOffsetOf(
  nextOffset: number | undefined,
  pageOffset: number,
  limit: number,
): number | undefined {
  if (
    limit === COUNT_ONLY_LIMIT ||
    nextOffset === undefined ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset <= pageOffset
  ) {
    return undefined;
  }

  return nextOffset;
}

/*
 * ---------------------------------------------------------------------------
 * Paging state
 * ---------------------------------------------------------------------------
 */

/**
 * The pages already loaded for one query, and the page being loaded next.
 *
 * Written **only** from the "Load more" handler, which is what keeps this
 * component free of state written from an effect: at the moment of the click the
 * rows on screen, the offset to advance to and the total the service last
 * reported are all in hand, so the accumulator is complete before the next page
 * is even requested. Nothing here is derived after the fact.
 *
 * `identity` is the page sequence's identity: the session and the query as
 * authored, its base offset included, apart from the offset paging advanced
 * to. A different session, source, filter, ordering, page size or authored
 * starting position is a different sequence, and comparing it during render is
 * how the accumulator is discarded — again with no effect, and no chance of one
 * render showing rows from two different sequences.
 */
interface PageAccumulator {
  /**
   * The identity of the sequence these pages belong to: authored base offset
   * and session included, advanced offset excluded.
   */
  readonly identity: string;

  /** Every row loaded before the page currently in flight, in arrival order. */
  readonly rows: readonly TelemetryEvent[];

  /** The offset of the page currently in flight. */
  readonly offset: number;

  /**
   * The total the service last reported for this query, carried across the
   * request so the footer's sentence does not lose the total while the next page
   * is in flight and momentarily claim it was never reported.
   */
  readonly total: number | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/** The inputs of one span table. */
export interface SpanTableProps {
  /**
   * The validated `table` node to render: its identity, its optional title and
   * description, and the data query it draws.
   *
   * The title and description are NOT rendered here. A node's heading belongs to
   * the container the host wraps it in (`layout/Section`, which takes
   * `title={node.title}`), so rendering it again would put the same words on
   * screen twice and insert an outline level this component cannot place. The
   * title is used for one thing: the accessible caption of the grid.
   */
  node: TableNode;

  /**
   * An identity to report to `PanelActions` instead of the node's own `id`.
   *
   * For a host that renders the same node in more than one place and needs to
   * tell the copies apart. Omitted, `node.id` is the identity, which is what the
   * panel specification named it.
   */
  nodeId?: string | undefined;

  /**
   * Extra classes composed after `dg-span-table`, for the placement the
   * surrounding node owns — a column span, a grow factor.
   *
   * Composition, never an escape hatch for visual values: a class named here is
   * defined in `../styles/components.css` against `--dg-*` tokens like every
   * other class in this package.
   */
  className?: string | undefined;
}

/**
 * Renders the `table` node: a sortable, pageable list of the span records its
 * query selected, with the duration severity, tier and kind vocabularies of the
 * design system and a source chip on every row the capture resolved.
 *
 * Data comes from the host's `DataProvider` through {@link useQuery} and
 * interactions leave through `PanelActions`; this component holds three pieces
 * of local state and nothing else — the service ordering the reader asked for,
 * the view order they asked for when the service has none (module decision 2),
 * and the pages they have loaded. The selected row is the panel's shared
 * selection, read through `useViewSelection`: under the panel host a selection
 * made in any view or evidence chip marks the row for the same event here, and
 * a row activated here marks the same event everywhere else.
 * Outside a host the hook falls back to the row last activated in this table.
 * A view order re-arranges rows, never which row is selected: the mark follows
 * the event wherever the arrangement places it.
 *
 * @param props The props documented on {@link SpanTableProps}.
 * @returns The block, in whichever of its four states the query is in.
 *
 * @example
 * // As the host renders it, from a validated panel specification.
 * <SpanTable node={node} />
 */
export function SpanTable(props: SpanTableProps): ReactElement {
  const { node, nodeId, className } = props;

  const actions = usePanelActions();
  // The panel's one selection, shared with every other view under the host, and
  // the recorder this table calls on activation (a no-op under a host, which
  // records the report itself; the table's own fallback outside one).
  const { selection, markSelected } = useViewSelection();

  // The ordering the reader asked for, which overrides the node's own. Undefined
  // until they ask, so a panel's authored ordering is what they first see.
  const [sortOverride, setSortOverride] = useState<DataQuerySort | undefined>(undefined);
  // The order the reader asked for that the service cannot apply, arranged over
  // the loaded rows here; `null` while the rows are shown in the service's
  // order. Not part of the query or of the page sequence's identity: it changes
  // how the loaded rows are arranged, never which rows are loaded.
  const [viewOrder, setViewOrder] = useState<SpanOrder | null>(null);
  const [pages, setPages] = useState<PageAccumulator | undefined>(undefined);

  const identity = nodeId ?? node.id;
  const source = spanSourceOf(node.query.source);
  const filter = node.query.filter;
  const appliedSort = sortOverride ?? node.query.sort;
  const limit = clampLimit(node.query.limit);
  const baseOffset = clampOffset(node.query.offset);

  // The session this panel reads from. `useQuery` re-issues the query when it
  // changes, and the pages another session answered are another capture's
  // evidence, so the session is part of the page sequence's identity.
  const sessionId = usePanelSessionId();

  // The identity of the page sequence: the session and the query as AUTHORED,
  // its base offset included — a node that starts from another position is
  // another slice of the result and must not inherit this one's pages. The
  // ADVANCED offset (`PageAccumulator.offset`) is deliberately left out, or
  // every "Load more" would discard the pages it was meant to append to.
  const pagingIdentity = useMemo(
    () =>
      stableJson({
        sessionId,
        source: node.query.source,
        filter,
        sort: appliedSort,
        limit,
        offset: baseOffset,
      }),
    [sessionId, node.query.source, filter, appliedSort, limit, baseOffset],
  );

  // Discarding a stale accumulator during render rather than in an effect: the
  // comparison is pure, and it means a re-ordered table, a node paged from
  // another position or a panel switched to another session can never paint
  // rows from the previous sequence, not even for one frame — and the request
  // returns to the authored base offset at once.
  const activePages = pages !== undefined && pages.identity === pagingIdentity ? pages : undefined;
  const offset = activePages?.offset ?? baseOffset;

  // The one place a query is constructed. `exactOptionalPropertyTypes` is in
  // force, so an absent filter or ordering is an absent member rather than a
  // member set to `undefined` - which also keeps the serialised identity above
  // and the hook's own request key in agreement.
  const query = useMemo<SpanQuery | undefined>(() => {
    if (source === undefined) {
      return undefined;
    }

    return {
      source,
      limit,
      offset,
      ...(filter === undefined ? {} : { filter }),
      ...(appliedSort === undefined ? {} : { sort: appliedSort }),
    };
  }, [source, limit, offset, filter, appliedSort]);

  const { status, data, error, announcement, total, nextOffset, retry } =
    useQuery<SpanSource>(query);

  // The page that resolved, or `undefined` while one is in flight or has failed.
  const pageRows = status === 'success' ? (data ?? NO_ROWS) : undefined;

  // Earlier pages first, then the page that just arrived. The service ordered
  // both and guarantees paging never repeats or skips an item, so appending is
  // the whole of the operation: there is no sorting, no de-duplication and no
  // re-ranking here, which is what keeps the ranking the panel asked for intact.
  const rows = useMemo<readonly TelemetryEvent[]>(() => {
    const loaded = activePages?.rows ?? NO_ROWS;

    if (pageRows === undefined) {
      return loaded;
    }

    if (loaded.length === 0) {
      return pageRows;
    }

    return [...loaded, ...pageRows];
  }, [activePages, pageRows]);

  // The rows as the grid draws them: the accumulated sequence in the service's
  // order, or — while the reader has asked for an order the service cannot
  // apply — that same sequence arranged in the view order (module decision 2).
  // Derived here rather than held in state, so every page "Load more" appends is
  // arranged with the rest in the same render it arrives in; `rows` itself stays
  // in the service's order, because it is what the next page is appended to.
  const displayRows = useMemo<readonly TelemetryEvent[]>(
    () => (viewOrder === null ? rows : arrangeRows(rows, viewOrder)),
    [rows, viewOrder],
  );

  // The reference point for the relative start column: the earliest start among
  // the rows on screen. It moves when a later page brings an earlier row, which
  // is why the column's accessible name states what the offsets are relative to
  // instead of implying the capture's own start.
  const origin = useMemo<number | undefined>(() => {
    let earliest: number | undefined;

    for (const event of rows) {
      const { startTime } = event;

      if (!Number.isFinite(startTime)) {
        continue;
      }

      if (earliest === undefined || startTime < earliest) {
        earliest = startTime;
      }
    }

    return earliest;
  }, [rows]);

  const onOpenSource = actions?.onOpenSource;

  const columns = useMemo(() => buildColumns({ origin, onOpenSource }), [origin, onOpenSource]);
  // The order the header reports: the view order while one is applied, so the
  // indicator and `aria-sort` describe the rows on screen, and otherwise the
  // service ordering the query carries.
  const displaySort = useMemo<DataTableSort | null>(
    () => viewOrder ?? displaySortFor(appliedSort),
    [viewOrder, appliedSort],
  );

  // The loaded row that stands for the panel's selected event, whichever view
  // selected it. Re-derived when either the rows or the selection change, so a
  // page that brings the selected event marks it as it arrives. Matched against
  // the service-ordered `rows`, never `displayRows`: where a selection names
  // only a trace and span that more than one loaded record carries, the mark
  // stays on the same record whichever view order arranges them, instead of
  // moving to whichever match the arrangement happens to place first.
  const selectedRowKey = useMemo(() => selectedRowKeyOf(rows, selection), [rows, selection]);

  const handleRowActivate = useCallback(
    (event: TelemetryEvent): void => {
      const ref = eventRefOf(event);

      // Recorded first, reported second: under the panel host the report is
      // what moves the shared selection (the recorder is a no-op there), and
      // outside one the recorder is what marks the row.
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  const handleSortRequest = useCallback(
    (proposed: DataTableSort): void => {
      const key = spanColumnKeyOf(proposed.key);

      // A key this table never rendered as a column: there is nothing to order
      // by, so nothing changes.
      if (key === undefined) {
        return;
      }

      const requested: SpanOrder = { key, direction: proposed.direction };
      const serviceSort = serviceSortFor(requested);

      // An order the service cannot apply: arrange the loaded rows instead, with
      // no re-query — the rows loaded are the same rows, only their arrangement
      // changes. The primitive always proposes a change, so an unchanged view
      // order is declined rather than reported twice.
      if (serviceSort === undefined) {
        if (
          viewOrder !== null &&
          viewOrder.key === requested.key &&
          viewOrder.direction === requested.direction
        ) {
          return;
        }

        setViewOrder(requested);
        actions?.onFilterChange?.(identity, { sort: sortReportFor(requested) });
        return;
      }

      // The service ordering already applied: the accumulated rows are in that
      // order as they stand, so returning to it — Duration shortest first back
      // to longest first — clears the view order without a re-query. With no
      // view order in force nothing would change, so nothing is reported.
      if (serviceSort === appliedSort) {
        if (viewOrder === null) {
          return;
        }

        setViewOrder(null);
        actions?.onFilterChange?.(identity, { sort: serviceSort });
        return;
      }

      setSortOverride(serviceSort);
      setViewOrder(null);
      // A new ordering is a new page sequence: rows accumulated under the old one
      // describe a different ranking and must not be carried into this one.
      setPages(undefined);
      actions?.onFilterChange?.(identity, { sort: serviceSort });
    },
    [actions, appliedSort, identity, viewOrder],
  );

  // The page the service says follows the one that resolved, when it named one
  // that moves forward. Read only off a settled page: `offset` is then the
  // offset that page was requested at, because `useQuery` reports a settlement
  // only while it answers the current query. While a page is in flight or has
  // failed there is no answer to follow, so there is no next page either.
  const followingOffset =
    status === 'success' ? forwardOffsetOf(nextOffset, offset, limit) : undefined;

  const handleLoadMore = useCallback((): void => {
    // Exactly the offset the service reported, and nothing else: no page is
    // derived from the length of what arrived or from the total, so this table
    // can never request a page the service did not offer.
    if (followingOffset === undefined) {
      return;
    }

    setPages({ identity: pagingIdentity, rows, offset: followingOffset, total });
  }, [followingOffset, rows, pagingIdentity, total]);

  const loadedCount = rows.length;
  const knownTotal = total ?? activePages?.total;
  const remaining = knownTotal === undefined ? undefined : knownTotal - (baseOffset + loadedCount);
  const canLoadMore = followingOffset !== undefined;
  // The total counts rows beyond those on screen, yet the settled page named no
  // forward page. The service is the authority on paging, so the footer says how
  // many rows remain and why they cannot be loaded, rather than offering a
  // control that would request a page nobody offered. A count-only query is
  // excluded: it is never paged by its own request, so blaming the service for
  // the rows it did not return would be untrue.
  const unreachable =
    status === 'success' &&
    limit !== COUNT_ONLY_LIMIT &&
    !canLoadMore &&
    remaining !== undefined &&
    remaining > 0
      ? remaining
      : undefined;
  // A page arriving behind rows that are already on screen, and a page that
  // failed behind them: reported in the footer, never by replacing what the
  // reader is reading.
  const appending = status === 'loading' && loadedCount > 0;
  const pageFailed = status === 'error' && loadedCount > 0;
  const showLoadMore = canLoadMore || appending;
  // Every row the query matched is on screen: the service reported a total, the
  // node starts at the first item, the loaded rows reach that total, and no
  // further page is offered or in flight. Only then does a view order cover the
  // whole result; anything less and the footer says what the order covers.
  const wholeResultLoaded =
    knownTotal !== undefined &&
    baseOffset === DATA_QUERY_DEFAULT_OFFSET &&
    loadedCount >= knownTotal &&
    !showLoadMore;
  const scopeCaveat =
    viewOrder !== null && loadedCount > 0 && !wholeResultLoaded
      ? describeViewOrderScope(loadedCount)
      : undefined;
  // Drawn whenever rows are on screen, the complete case included (module
  // decision 3): the count is how a reader knows the table is complete.
  const showFooter = loadedCount > 0;
  const footerText = [
    describeCoverage(loadedCount, knownTotal, baseOffset),
    unreachable === undefined ? undefined : describeUnreachable(unreachable),
    showLoadMore ? describePageSize(limit) : undefined,
    scopeCaveat,
  ]
    .filter((sentence): sentence is string => sentence !== undefined)
    .join(' ');

  const blockClassName = clsx('dg-span-table', className);
  // The grid's accessible name. The node's title when it has one, and otherwise
  // the catalog's own generic label - never a name invented here.
  const caption = node.title ?? TABLE_NODE_ENTRY.label;

  // A node whose query names a source that does not resolve to span records: a
  // validated specification cannot reach this state, so it is reported as the
  // failure it is rather than drawn as an empty table. No retry is offered,
  // because re-issuing the same query cannot change the answer, and the node's
  // own query is the thing worth showing. `query` is undefined exactly when
  // `source` is; testing both narrows it for the failure states below.
  if (source === undefined || query === undefined) {
    return (
      <Stack className={blockClassName} gap={2}>
        <ErrorState
          className="dg-span-table__error"
          {...unsupportedQueryProps(node.type, node.query)}
        />
      </Stack>
    );
  }

  // The state that stands in for rows while none are on screen, in decision 4's
  // precedence; `undefined` once rows are on screen.
  let inPlaceOfRows: ReactElement | undefined;

  if (loadedCount === 0) {
    if (status === 'loading') {
      inPlaceOfRows = (
        <LoadingState className="dg-span-table__loading" variant="rows" label={LOADING_LABEL} />
      );
    } else if (status === 'error') {
      // The shared failure contract, with the query exactly as it was asked: the
      // generic lead and the provider's own cause, its hint, its code and a retry.
      inPlaceOfRows = (
        <ErrorState
          className="dg-span-table__error"
          {...queryFailureProps({ error, announcement, retry }, query, { scope: 'view' })}
        />
      );
    } else {
      // Nothing loaded, nothing in flight and nothing failed: the query
      // succeeded and left no row on screen. That is an empty capture only when
      // nothing matched; a count-only query, a page past the end and a page the
      // total says should hold rows are each described as what they are. When
      // the service still named a forward page, the state carries the control
      // that reaches it, so an empty page never strands the rows after it.
      const emptyCopy = describeEmptyPage(limit, knownTotal, offset, canLoadMore);

      inPlaceOfRows = (
        <EmptyState
          className="dg-span-table__empty"
          title={emptyCopy.title}
          message={emptyCopy.message}
          icon={emptyCopy === NOTHING_CAPTURED_COPY ? <Timer className="dg-icon" /> : undefined}
          action={
            canLoadMore ? (
              <Button variant="secondary" size="sm" onClick={handleLoadMore}>
                {LOAD_MORE_LABEL}
              </Button>
            ) : undefined
          }
        />
      );
    }
  }

  // Where that state is drawn. Before the reader has asked for any order it
  // replaces the grid, as on first load: there is no column context yet worth
  // keeping. Once they have, a service re-query empties the accumulated rows,
  // and replacing the grid then would unmount the very sort control they just
  // activated and drop their focus to the document. So from then on the state
  // is drawn in the grid's own empty slot — outside the grid's rows, where
  // `primitives/DataTable` places it — and the header stays mounted with the
  // new order already on its indicator. No row of the previous order is drawn
  // under it: the accumulated rows were discarded with the old sequence.
  const holdGrid = sortOverride !== undefined || viewOrder !== null;

  if (inPlaceOfRows !== undefined && !holdGrid) {
    return (
      <Stack className={blockClassName} gap={2}>
        {inPlaceOfRows}
      </Stack>
    );
  }

  return (
    <Stack className={blockClassName} gap={2}>
      <DataTable
        rows={displayRows}
        columns={columns}
        rowKey={rowKeyOf}
        caption={caption}
        sort={displaySort}
        onSortChange={handleSortRequest}
        selectedRowKey={selectedRowKey}
        onRowActivate={handleRowActivate}
        empty={inPlaceOfRows}
      />
      {showFooter ? (
        <Stack
          className="dg-span-table__footer"
          direction="horizontal"
          gap={2}
          align="center"
          justify="between"
          wrap
        >
          {/* Polite, so a reader who pressed "Load more" hears how much of the
              result is now on screen instead of nothing at all. */}
          <Text as="p" size="xs" tone="muted" aria-live="polite" aria-atomic="true">
            {footerText}
          </Text>
          {showLoadMore ? (
            <Button variant="secondary" size="sm" disabled={!canLoadMore} onClick={handleLoadMore}>
              {appending ? LOADING_MORE_LABEL : LOAD_MORE_LABEL}
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {/* The rows already drawn stay above this failure, so it is scoped to the
          page that failed, and its query is that page's, advanced offset and all. */}
      {pageFailed ? (
        <ErrorState
          className="dg-span-table__error"
          {...queryFailureProps({ error, announcement, retry }, query, { scope: 'page' })}
        />
      ) : null}
    </Stack>
  );
}
