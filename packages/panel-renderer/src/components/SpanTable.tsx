/**
 * # `components/SpanTable` — the renderer for the panel-schema `table` node
 *
 * A sortable, pageable table of captured span records: what each one was, which
 * tier produced it, when it started, how long it took, and — where the capture
 * resolved one — a chip that opens the code behind it. AAP 0.6.2 maps the
 * catalog's `table` node type to this component and names its job: "the user's
 * 'Slowest Operations' example; sortable via `DataTable`".
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
 * 2. **Sorting is a re-query, never an array operation.** The service applied
 *    `filter`, `sort`, `limit` and `offset` before these rows existed
 *    (AAP 0.4.2), so re-ordering them here would show an order the panel
 *    specification never asked for and quietly break the ranking this node
 *    exists to present. A header click changes the query and the data comes
 *    back ordered.
 * 3. **A page is a page, and the footer says so.** A response carries `total`
 *    and `nextOffset`; this component renders the loaded count against the
 *    total and offers "Load more" only while the service reports a next offset
 *    that moves past the page on screen, requesting exactly that offset. The
 *    service is the one authority on whether another page exists: no offset is
 *    derived from the length of a page or from `total`, and when the total
 *    counts rows the service offered no page for, the footer says so instead of
 *    inventing one. It never truncates in silence, and when the service reported
 *    no total it says the total is unknown instead of implying the table is
 *    complete.
 * 4. **Three states, one precedence.** A query in flight with nothing to show
 *    renders `LoadingState`; a failure with nothing to show renders
 *    `ErrorState` with the serialised query and a retry; a successful result
 *    with no rows renders `EmptyState`, whose copy tells an empty capture
 *    (nothing matched) apart from a count-only query (`limit: 0`) and from a
 *    page that holds none of the rows the reported total counts, and names that
 *    total instead of claiming nothing was captured. Once rows are on screen
 *    they stay on screen: a page that fails or is still loading is reported in
 *    the footer rather than by replacing rows the reader is already reading.
 *
 * ## What this component is not allowed to do, and therefore does not
 *
 * - **No transport.** Data arrives through {@link useQuery}, which resolves the
 *   query against the `DataProvider` the host provided; interactions leave
 *   through `PanelActions`. There is no `fetch`, no socket and no extension API
 *   in this file, which is what lets the same component render inside the
 *   DevTools panel, the editor webview and a component test (AAP 0.1.2, 0.6.2).
 * - **No redaction, no reformatting of evidence.** Everything here arrived
 *   already redacted at ingest (AAP 0.5.2). Names, kinds, tiers, durations and
 *   source locations are rendered as given; nothing is re-joined, re-parsed or
 *   "improved", and no attribute is copied anywhere.
 * - **No visual values.** Not one colour, length or font appears below. Colour
 *   comes from `../utils/color` as `var(--dg-*)` token references, spacing from
 *   `layout/Stack`, and everything else from the class contract
 *   `../styles/components.css` already implements for this block (AAP 0.6.4):
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
 *   this file, its copy or its comments (AAP 0.5.4).
 * - **No toolbar.** The only interaction this node offers is ordering, and the
 *   grid's own sortable headers already offer it — with the applied order shown
 *   where the reader is looking, which a separate control cannot do. A toolbar
 *   here would be a second, competing way to express one intent, so there is
 *   none; `../styles/components.css` allots this block no toolbar row either.
 * - **No grid of its own.** `primitives/DataTable` owns the ARIA grid roles,
 *   the header, the roving tab stop, the keyboard model and the virtual
 *   viewport; this module contributes rows, columns and callbacks. It adds no
 *   `role`, no second scroll container and no measurement of its own — the
 *   primitive's measurement fallback is what makes these rows render in a
 *   test environment that measures nothing.
 *
 * ## Which fields it may read
 *
 * The authority is the node catalog, not this file: `PANEL_NODE_CATALOG.table`
 * declares the `TelemetryEvent` fields this node type reads, and
 * {@link TABLE_NODE_ENTRY} holds that entry. Each column declares the field it
 * requires and is rendered only while the entry grants it, so narrowing the
 * catalog withdraws a column instead of leaving this component reading a field
 * the schema no longer sanctions. The same entry supplies the sources this node
 * may read and the generic label used when the node carries no title of its own
 * (AAP 0.6.2 — "the renderer depends on the schema, never the reverse").
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
import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';

import { usePanelSessionId } from '../host/DataProvider';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn, DataTableSort } from '../primitives/DataTable';
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
 * Serialisation: one stable string, used for identity and for display
 * ---------------------------------------------------------------------------
 */

/**
 * A data query as a compact, stable string: keys sorted, absent members
 * dropped, so the same query always serialises identically.
 *
 * Used for two things and nothing else — the identity of a page sequence (see
 * {@link PageAccumulator}) and the text `ErrorState` shows for a failed query,
 * which `primitives/ErrorState` takes as a plain string because the primitives
 * layer does not depend on the panel schema. A data query holds a source, a
 * narrowing filter, an ordering and two whole numbers; there is nothing
 * sensitive in it to withhold (AAP 0.5.2).
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
 * table reports upward through `onSortChange` translates into the data layer's
 * ordering vocabulary without a second lookup table. `satisfies` is what keeps
 * that true: renaming a field in the event schema fails this file rather than
 * silently producing a column that sorts nothing.
 */
const NAME_COLUMN_KEY = 'name' satisfies keyof TelemetryEvent;
const KIND_COLUMN_KEY = 'kind' satisfies keyof TelemetryEvent;
const TIER_COLUMN_KEY = 'tier' satisfies keyof TelemetryEvent;
const START_COLUMN_KEY = 'startTime' satisfies keyof TelemetryEvent;
const DURATION_COLUMN_KEY = 'duration' satisfies keyof TelemetryEvent;

/**
 * The identity column's grid track: four times the share of each other column,
 * because an operation name is the one value here that is long and variable.
 * A ratio rather than an intrinsic track, so the column lands at the same
 * offset in every row (the header and each row are separate grid containers).
 */
const NAME_COLUMN_TRACK = 'minmax(0, 4fr)';

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
function displaySortFor(sort: DataQuerySort | undefined): DataTableSort | null {
  if (sort === 'duration_desc') {
    return { key: DURATION_COLUMN_KEY, direction: 'desc' };
  }

  if (sort === 'start_asc') {
    return { key: START_COLUMN_KEY, direction: 'asc' };
  }

  return null;
}

/**
 * The data-query ordering nearest to a sort the table proposed.
 *
 * The direction is deliberately ignored. The data layer offers one direction per
 * key — longest first, or earliest first — so a second click on a sorted column,
 * which the primitive proposes as a flip, has no equivalent to re-query with.
 * Returning the same ordering leaves the applied order and the header's
 * `aria-sort` in agreement instead of showing an ascending arrow over rows the
 * service ordered descending (AAP 0.4.2). A column outside that vocabulary
 * yields `undefined` and the caller declines the change.
 *
 * @param sort The sort the primitive proposed.
 * @returns The ordering to request, or `undefined` when there is none.
 */
function querySortFor(sort: DataTableSort): DataQuerySort | undefined {
  if (sort.key === DURATION_COLUMN_KEY) {
    return 'duration_desc';
  }

  if (sort.key === START_COLUMN_KEY) {
    return 'start_asc';
  }

  return undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Copy. Product vocabulary only - nothing here names anything from an
 * inspected project (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

const NAME_HEADER = 'Operation';
const KIND_HEADER = 'Kind';
const TIER_HEADER = 'Tier';
const START_HEADER = 'Start';
const DURATION_HEADER = 'Duration';

/** Names the sort control of a column whose values are relative, not absolute. */
const START_HEADER_LABEL = 'Start, relative to the earliest listed operation';

/** Names the duration sort control, which orders longest-first in one direction only. */
const DURATION_HEADER_LABEL = 'Duration, longest first';

const EMPTY_MESSAGE = 'No spans matched this query.';
const COUNT_ONLY_TITLE = 'Count only';
const COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';
const EMPTY_PAGE_TITLE = 'Nothing on this page';
const ERROR_MESSAGE = 'The spans for this view could not be loaded.';
const UNSUPPORTED_SOURCE_MESSAGE =
  'This view reads span records, and its query names a source that does not provide them.';
const PAGE_ERROR_MESSAGE = 'The next page of spans could not be loaded.';
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
      width: NAME_COLUMN_TRACK,
      // The row's header cell, so a reader hears the operation named as they
      // move across the row rather than hearing five unattributed values.
      rowHeader: true,
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
              <SourceLink location={event.source} compact onOpenSource={onOpenSource} />
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
      cell: (event) => (
        <span className="dg-span-table__kind-cell">
          {/* The kind scale is spent on the chip's hairline, never on its label:
              the scale is held to the non-text contrast ratio (AAP 0.6.3). */}
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
      align: 'end',
      sortable: true,
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
      headerLabel: DURATION_HEADER_LABEL,
      align: 'end',
      sortable: true,
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
 * the whole of the capture (AAP 0.4.2). A query that starts part-way through the
 * result also names its starting position, because "12 of 900" would otherwise
 * suggest the first twelve.
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

/** What the empty state says: an optional first line, and the sentence under it. */
interface EmptyPageCopy {
  /** The short label above the sentence, or `undefined` for none. */
  readonly title: string | undefined;

  /** The sentence itself. */
  readonly message: string;
}

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
    return { title: undefined, message: EMPTY_MESSAGE };
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
   * other class in this package (AAP 0.6.4).
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
 * of local state and nothing else — the ordering the reader asked for, the pages
 * they have loaded, and the row they last activated in this table.
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

  // The ordering the reader asked for, which overrides the node's own. Undefined
  // until they ask, so a panel's authored ordering is what they first see.
  const [sortOverride, setSortOverride] = useState<DataQuerySort | undefined>(undefined);
  const [pages, setPages] = useState<PageAccumulator | undefined>(undefined);
  // The row this table last activated. Local by design: the host owns what a
  // selection means elsewhere in the panel, and this is only the feedback that
  // the click landed on the row the reader aimed at.
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

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

  const { status, data, error, total, nextOffset, retry } = useQuery<SpanSource>(query);

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
  const displaySort = useMemo(() => displaySortFor(appliedSort), [appliedSort]);
  // Serialised once, for the one consumer that needs it as text. `query` is
  // undefined only when the node named a source this view cannot draw, and then
  // the node's own query is the thing worth showing.
  const serializedQuery = useMemo(() => stableJson(query ?? node.query), [query, node.query]);

  const handleRowActivate = useCallback(
    (event: TelemetryEvent): void => {
      setSelectedRowKey(event.id);
      actions?.onSelectEvent({
        eventId: event.id,
        spanId: event.spanId,
        traceId: event.traceId,
      });
    },
    [actions],
  );

  const handleSortRequest = useCallback(
    (proposed: DataTableSort): void => {
      const requested = querySortFor(proposed);

      // A column outside the data layer's ordering vocabulary, or the ordering
      // already applied: nothing to re-query, so nothing changes. The header
      // keeps reporting the order the rows are actually in.
      if (requested === undefined || requested === appliedSort) {
        return;
      }

      setSortOverride(requested);
      // A new ordering is a new page sequence: rows accumulated under the old one
      // describe a different ranking and must not be carried into this one.
      setPages(undefined);
      actions?.onFilterChange?.(identity, { sort: requested });
    },
    [actions, appliedSort, identity],
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
  const showFooter =
    showLoadMore || pageFailed || knownTotal === undefined || unreachable !== undefined;
  const coverageText = describeCoverage(loadedCount, knownTotal, baseOffset);
  const footerText =
    unreachable === undefined
      ? coverageText
      : `${coverageText} ${describeUnreachable(unreachable)}`;

  const blockClassName = clsx('dg-span-table', className);
  // The grid's accessible name. The node's title when it has one, and otherwise
  // the catalog's own generic label - never a name invented here.
  const caption = node.title ?? TABLE_NODE_ENTRY.label;

  // A node whose query names a source that does not resolve to span records: a
  // validated specification cannot reach this state, so it is reported as the
  // failure it is rather than drawn as an empty table. No retry is offered,
  // because re-issuing the same query cannot change the answer.
  if (source === undefined) {
    return (
      <Stack className={blockClassName} gap={2}>
        <ErrorState
          className="dg-span-table__error"
          message={UNSUPPORTED_SOURCE_MESSAGE}
          query={serializedQuery}
        />
      </Stack>
    );
  }

  if (status === 'loading' && loadedCount === 0) {
    return (
      <Stack className={blockClassName} gap={2}>
        <LoadingState className="dg-span-table__loading" variant="rows" />
      </Stack>
    );
  }

  if (status === 'error' && loadedCount === 0) {
    return (
      <Stack className={blockClassName} gap={2}>
        <ErrorState
          className="dg-span-table__error"
          message={error?.message ?? ERROR_MESSAGE}
          code={error?.code}
          query={serializedQuery}
          onRetry={retry}
        />
      </Stack>
    );
  }

  // Nothing loaded, nothing in flight and nothing failed: the query succeeded
  // and left no row on screen. That is an empty capture only when nothing
  // matched; a count-only query, a page past the end and a page the total says
  // should hold rows are each described as what they are. When the service
  // still named a forward page, the state carries the control that reaches it,
  // so an empty page never strands the rows after it.
  if (loadedCount === 0) {
    const emptyCopy = describeEmptyPage(limit, knownTotal, offset, canLoadMore);

    return (
      <Stack className={blockClassName} gap={2}>
        <EmptyState
          className="dg-span-table__empty"
          title={emptyCopy.title}
          message={emptyCopy.message}
          action={
            canLoadMore ? (
              <Button variant="secondary" size="sm" onClick={handleLoadMore}>
                {LOAD_MORE_LABEL}
              </Button>
            ) : undefined
          }
        />
      </Stack>
    );
  }

  return (
    <Stack className={blockClassName} gap={2}>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={rowKeyOf}
        caption={caption}
        sort={displaySort}
        onSortChange={handleSortRequest}
        selectedRowKey={selectedRowKey}
        onRowActivate={handleRowActivate}
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
          <Text as="p" size="xs" tone="muted">
            {footerText}
          </Text>
          {showLoadMore ? (
            <Button variant="secondary" size="sm" disabled={!canLoadMore} onClick={handleLoadMore}>
              {appending ? LOADING_MORE_LABEL : LOAD_MORE_LABEL}
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {pageFailed ? (
        <ErrorState
          className="dg-span-table__error"
          message={error?.message ?? PAGE_ERROR_MESSAGE}
          code={error?.code}
          query={serializedQuery}
          onRetry={retry}
        />
      ) : null}
    </Stack>
  );
}
