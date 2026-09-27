/**
 * The `queryTable` node: database statements grouped by their parameterized
 * text, with how often each ran, how long it took, how many rows it reported
 * and which code issued it.
 *
 * ## What it shows, and what it can never show
 *
 * Statements only. A statement arrives here already redacted and already
 * parameterized — `$n` placeholders as the driver wrote them, inline literals
 * replaced with `?` by `packages/telemetry/src/redaction/sql.ts` — and the only
 * thing recorded about a result is a row *count*. Nothing in this file
 * transforms that text: it is not re-formatted, not pretty-printed, not
 * re-cased, not highlighted, not parsed, and no placeholder is ever filled in.
 * The single string operation applied anywhere below is the package's own
 * display truncation for the collapsed cell (`oneLinePreview`), and wherever a
 * preview is shown the untouched statement is carried beside it — in the cell's
 * tooltip, whose bubble is in the document at all times and which keyboard
 * focus opens as readily as a pointer does, and in the expanded row's block.
 * There is no "show values" affordance and nothing resembling a result-set
 * preview, because the evidence to build one was never captured.
 *
 * The instinct this file is written with, and the one to keep when editing it:
 * **display, never transform.** An "improvement" that formatted a statement,
 * expanded a placeholder or sampled a row would quietly break the product's
 * central privacy promise while looking like a readability fix.
 *
 * ## Where its data comes from
 *
 * From the node's own `DataQuery` and nothing else. The component resolves it
 * through `../host/useQuery`, which reaches the ambient `DataProvider` — an
 * interface, never a transport: no socket, no `fetch`, no message port, no
 * knowledge of which host surface it is rendering inside. Ordering, filtering
 * and paging belong to the side that holds the whole capture, so a sort change
 * here is a *re-query*, never a local re-ordering, and a page is appended by
 * asking for the next `offset` rather than by slicing what arrived. Every field
 * read below comes from the `reads` list of this node type's catalog entry —
 * `catalogEntryFor('queryTable').reads` in `packages/panel-schema/src/catalog.ts`,
 * which is also what the semantic validator checks a generated panel against —
 * resolved into the `queries` result shape by
 * `packages/telemetry/src/aggregate/queries.ts`: span identity, timing,
 * taxonomy, label and status, with `db.statement` required (a span without one
 * forms no group), and `parentSpanId`, `source`, `db.system` and `db.rowCount`
 * read when present. The caller walk resolves a call site through
 * `parentSpanId`, not through function or route-handler keys.
 *
 * ## Where the click-to-source flow ends
 *
 * The click-to-source flow ends at this table's caller chip, which opens the
 * editor at the statement's call site. That chip is a `SourceLink` handed the
 * caller's own `SourceLocation` **by reference** — this file neither rebuilds,
 * adjusts nor re-validates a location — so what the host receives through
 * `PanelActions.onOpenSource` is exactly what the resolver produced. A caller
 * the resolver could not place renders as plain text rather than as a control
 * that leads nowhere.
 *
 * ## Composition
 *
 * Every visible element is a primitive or a layout primitive of this package:
 * no raw `<table>`, `<button>`, `<input>`, `<select>` or heading element, no
 * inline `style`, and no CSS value of its own. `DataTable` owns the grid roles,
 * the header sort reporting, the roving tab stop, the expansion keys and the
 * row state classes (`dg-is-selected`, `dg-is-expanded`), which is why none of
 * them appears here; spacing comes from `Stack`, the ordering control from
 * `Toolbar`, colour only ever from `../utils/color`.
 *
 * ## Keyboard: one Tab stop, and the grid's arrow keys for everything inside
 *
 * The table is ONE stop in the page's Tab order — `DataTable`'s active row —
 * and every focusable element this file renders inside a cell or an expanded
 * row carries `tabIndex={-1}`: the expand toggle, the caller chips, the
 * execution selectors, the expanded statement blocks, and the triggers of the
 * tooltips on an abbreviated statement, a row count and a caller's execution
 * count. `DataTable`'s cell navigation is what reaches them (ArrowRight into the
 * row and across it and its open detail, ArrowLeft back, Home/End, the vertical
 * keys to the adjacent row, Escape back to the row), so this file handles no key
 * itself and keeps no focus bookkeeping of its own.
 *
 * A tooltip trigger is described, never operated: it gains no role, no handler
 * and no name of its own (its visible text is what is read, the bubble its
 * description), so the set of controls on screen is unchanged, and its focus
 * ring is the global `:focus-visible` rule of `../styles/base.css`. Focus opens
 * the bubble however it arrives — an arrow key or a pointer — so a description a
 * pointer reaches by hovering, a keyboard reaches by moving onto the figure; the
 * first Escape closes the bubble and only the second returns to the row. An
 * expanded statement block, once focused, keeps the arrow keys along an axis it
 * actually scrolls, so a long statement stays scrollable from the keyboard.
 *
 * The row's disclosure state lives on its toggle, not on the row: a `grid` row
 * does not support `aria-expanded`, so the toggle carries `aria-expanded` and
 * `aria-controls` from the `DataTableCellMeta` its cell receives, and
 * `aria-controls` names the detail row exactly while that row is rendered.
 *
 * ## States
 *
 * All three, in precedence, for the first page: loading → an `ErrorState` with
 * the serialised query and a working retry → an `EmptyState` whose copy says
 * what the empty page actually means (see {@link describeEmptyPage}): a capture
 * that holds no statements, a count-only query (`limit: 0`), or a page that
 * starts past the end of — or simply holds none of — a positive total. Once a
 * page has been loaded and frozen, a further page resolves *underneath* the rows
 * already on screen: blanking a table the reader is using in order to re-show a
 * spinner would lose their place, so the incremental loading state lives in the
 * footer beside the control that asked for it, and a failed further page raises
 * the same `ErrorState` — message, code, the failing query with its `offset`,
 * and a retry of exactly that request — below the footer, with the earlier rows
 * still on screen.
 *
 * Once the reader has chosen an ordering — from the "Order by" select or a
 * sortable header — the toolbar and the grid stay mounted through the re-query
 * that follows, and its loading, error or empty state is drawn in the grid's
 * empty slot, so the control the reader used keeps its element and their focus.
 *
 * A retry that succeeds hands keyboard focus to the recovered rows: the expand
 * toggle of the first row the settled page brought carries the error state's
 * successor focus key (`RETRY_SUCCESSOR_FOCUS_ATTRIBUTES`), which the host's
 * node frame moves focus to from the Retry that left the document.
 *
 * @see packages/panel-schema/src/catalog.ts — the `queryTable` catalog entry
 * @see packages/telemetry/src/aggregate/queries.ts — the `queries` result shape
 * @see docs/SECURITY.md — "Redaction": the SQL placeholder and row-count treatment
 * @see docs/ARCHITECTURE.md — "Panel data", "The renderer contract" and "A click,
 * end to end": the paging contract, the component rules and the click-to-source path
 */

import type { DataQuery, DataQuerySort, QueryTableNode } from '@debuggen/panel-schema';
import { isDataQuerySort } from '@debuggen/panel-schema';
import type { QueryCaller, QueryGroup, QueryOccurrence } from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Database } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DataTable } from '../primitives/DataTable';
import type {
  DataTableCellMeta,
  DataTableColumn,
  DataTableColumnWidth,
  DataTableSort,
} from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState, RETRY_SUCCESSOR_FOCUS_ATTRIBUTES } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import type { SelectOption } from '../primitives/Select';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { statusColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatOffset,
  formatStatusLabel,
  oneLinePreview,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary borrowed from the data layer
 *
 * `@debuggen/telemetry` is a TYPE-ONLY dependency of this package, so the two
 * labels its aggregate tells consumers to display are mirrored here and typed
 * against their upstream declarations. `typeof import(...)` is a type-level
 * import: it is erased, adds no runtime edge, and — because both constants are
 * declared as literals upstream — makes the mirrored value below fail to
 * compile the moment either spelling changes. This is the same tripwire
 * `../utils/format` uses for the telemetry preview bound.
 * ---------------------------------------------------------------------------
 */

/** The type of the aggregate's own "no readable statement" key. */
type UnknownStatementKey = typeof import('@debuggen/telemetry').UNKNOWN_STATEMENT_KEY;

/** The type of the aggregate's own "no reported engine" label. */
type UnknownDbSystemLabel = typeof import('@debuggen/telemetry').UNKNOWN_DB_SYSTEM_LABEL;

/**
 * What a group's `statement` holds when no occurrence carried readable text.
 *
 * Mirrored from `packages/telemetry/src/aggregate/queries.ts`, which owns it. It
 * is matched rather than displayed as code: the value is the aggregate's prose
 * for an absence, not a statement, so it renders as muted text and is never
 * dressed up as SQL the producer never sent.
 */
const UNKNOWN_STATEMENT: UnknownStatementKey = '(unknown statement)';

/**
 * What the system column shows for a group whose `system` is absent.
 *
 * Mirrored from the same module, which exports it precisely so that each
 * renderer does not invent its own wording. An absent `system` means "never
 * observed", which is a different claim from an engine that happens to be
 * named something — hence a label rather than a blank cell.
 */
const UNKNOWN_DB_SYSTEM: UnknownDbSystemLabel = '(unknown system)';

/** The one data source this view can read, and the narrowing the hook needs. */
const QUERIES_SOURCE = 'queries' satisfies DataQuery['source'];

/**
 * The ordering a node that authored none is resolved with.
 *
 * Slowest first: the question this table answers is almost always "what cost
 * the time", and the statement that cost it belongs in the first row rather
 * than wherever the store happened to hold it.
 */
const DEFAULT_SORT: DataQuerySort = 'duration_desc';

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Generic throughout: no component, table, route or symbol name from any
 * inspected project appears in this file, in its markup or in its comments,
 * and no example statement is written down anywhere — every statement on
 * screen came from the capture.
 * ---------------------------------------------------------------------------
 */

/** The grid's accessible name when the node carried no title of its own. */
const DEFAULT_CAPTION = 'Database statements captured during this interaction';

/** Shown for a capture that genuinely holds no database statements. */
const EMPTY_MESSAGE = 'No database queries were captured for this interaction.';

/** The first line above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No queries';

/**
 * Title of the empty state for a count-only query (`limit: 0`): the node asked
 * for a total and no rows, so an empty grid is the answer it requested rather
 * than an absence in the capture.
 */
const COUNT_ONLY_TITLE = 'Count only';

/** A count-only query whose provider reported no total, so there is no number to show. */
const COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';

/**
 * Title of the empty state for a page that holds no rows although the capture
 * is not known to be empty: an offset past the end, a page the provider left
 * empty beneath a positive total, or a later page with no reported total.
 */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/**
 * The accessible name of the busy region while the first page resolves, ending
 * in the single-character ellipsis (`…`) every loading label of this package
 * carries, so every busy region is announced alike.
 */
const LOADING_LABEL = 'Loading captured database queries…';

/** The ordering control's own name, and the toolbar's group name. */
const ORDER_LABEL = 'Order by';

/** The toolbar's accessible group name. */
const TOOLBAR_LABEL = 'Query table controls';

/** Label of the control that asks for the next page. */
const LOAD_MORE_LABEL = 'Load more';

/** Label of the control that re-asks for a page whose request failed. */
const RETRY_PAGE_LABEL = 'Try again';

/** Shown in the footer while a further page is in flight. */
const LOADING_MORE_MESSAGE = 'Loading more statements…';

/** Explains the ambiguous number in an occurrence row. */
const ROW_COUNT_TOOLTIP =
  'Rows this execution reported returning. Row contents are never captured.';

/** Explains the ambiguous number beside a caller chip. */
const CALLER_COUNT_TOOLTIP = 'How many of this statement’s executions came from this location.';

/** Introduces the grouping basis in an expanded row. */
const GROUPING_BASIS_MESSAGE =
  'Executions were grouped by this normalised form of the statement, which is why several of them share one row:';

/** Shown in an expanded row that carries no individual executions. */
const NO_OCCURRENCES_MESSAGE = 'No individual executions were carried with this group.';

/**
 * Opens the accessible name of the expand affordance while the row is
 * collapsed; the row's own statement preview completes it (see
 * {@link disclosureLabel}).
 */
const EXPAND_ROW_PREFIX = 'Show the executions of';

/** Opens the accessible name of the same control while the row is open. */
const COLLAPSE_ROW_PREFIX = 'Hide the executions of';

/**
 * Introduces the name of the span that issued a statement from a caller's
 * location, shown as plain text beside that location's chip.
 */
const CALLER_SPAN_PREFIX = 'via';

/** Names the control that selects one execution, which the offset completes. */
const SELECT_OCCURRENCE_PREFIX = 'Select the execution at';

/** Names the group's fastest execution in an expanded row. */
const FASTEST_LABEL = 'Fastest';

/** The column headers, left to right. Generic: a column names a measurement, never a project. */
const HEADER = Object.freeze({
  statement: 'Statement',
  system: 'System',
  executions: 'Executions',
  totalDuration: 'Total time',
  averageDuration: 'Average time',
  maxDuration: 'Slowest',
  rowCount: 'Rows',
  callers: 'Called from',
});

/**
 * How many of the group's executions failed, for the badge in an expanded row.
 *
 * @param errorCount The group's own count of failed executions.
 * @returns The badge text.
 */
function failureBadgeText(errorCount: number): string {
  return `${formatCount(errorCount)} reported a failure`;
}

/**
 * The accessible name of a row's disclosure control, naming the row it opens.
 *
 * Every row carries the same icon-only toggle, so a name without the row's
 * identity would read "Show the executions of this statement" once per row and
 * tell a screen-reader or voice-control user nothing about which one they are
 * on. The identity is the statement preview the row header already shows — the
 * package's own one-line display form of the received text, passed in rather
 * than re-derived here — so the name repeats what is on screen and transforms
 * nothing.
 *
 * @param expanded Whether the row's detail is open, which picks the verb.
 * @param statementPreview The row's statement as its header cell displays it.
 * @returns The control's accessible name.
 */
function disclosureLabel(expanded: boolean, statementPreview: string): string {
  return `${expanded ? COLLAPSE_ROW_PREFIX : EXPAND_ROW_PREFIX} ${statementPreview}`;
}

/**
 * States that a group carries fewer executions than it counted.
 *
 * The aggregate bounds the sample it puts on the wire while keeping every count
 * and total exact, and marks that it did. Saying so is the difference between a
 * bounded list and a wrong one.
 *
 * @param carried How many executions the group carries.
 * @param counted How many it counted.
 * @returns The notice text.
 */
function truncationNoticeText(carried: number, counted: number): string {
  return `Showing ${formatCount(carried)} of ${formatCount(counted)} executions; the rest were not carried with this group.`;
}

/**
 * How much of the source the rows on screen cover.
 *
 * The total is reported by the provider and is absent while a page is in flight
 * and for any provider that cannot know it, so the sentence states only what is
 * known rather than printing a placeholder where a number belongs.
 *
 * @param loaded How many groups are rendered.
 * @param total How many the source holds after the query's filter, if reported.
 * @returns The footer text.
 */
function loadedText(loaded: number, total: number | undefined): string {
  return total === undefined
    ? `Showing ${formatCount(loaded)} statements`
    : `Showing ${formatCount(loaded)} of ${formatCount(total)} statements`;
}

/**
 * The noun the empty-page copy counts in, agreeing with its count.
 *
 * @param count How many statement groups the sentence counts.
 * @returns `"query"` for exactly one, `"queries"` otherwise (zero included).
 */
function queryNoun(count: number): string {
  return count === 1 ? 'query' : 'queries';
}

/**
 * The count-only message when the provider reported the total the node asked for.
 *
 * @param total The reported total.
 * @returns The message text.
 */
function countOnlyMessage(total: number): string {
  return `This view requests a count without rows: ${formatCount(total)} ${queryNoun(total)} matched its query.`;
}

/**
 * The message for a page that starts at or beyond the reported total.
 *
 * Positions are 1-based for the reader, so an `offset` of 200 is position 201.
 *
 * @param offset The page's 0-based offset.
 * @param total The reported, positive total.
 * @returns The message text.
 */
function pastEndMessage(offset: number, total: number): string {
  return `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCount(total)} ${queryNoun(total)} that matched this query.`;
}

/**
 * The message for a page inside a positive total that nonetheless holds no rows.
 *
 * @param total The reported, positive total.
 * @returns The message text.
 */
function emptyWithinTotalMessage(total: number): string {
  return `${formatCount(total)} ${queryNoun(total)} matched this query, but none are shown on this page.`;
}

/**
 * The message for a page with no reported total that holds no rows.
 *
 * @param offset The page's 0-based offset.
 * @returns The message text.
 */
function emptyWithoutTotalMessage(offset: number): string {
  return `This page starts at position ${formatCount(offset + 1)} and holds no ${queryNoun(0)}; no total was reported for this query.`;
}

/*
 * ---------------------------------------------------------------------------
 * Classes
 *
 * Block `dg-query-table`, its elements, and the two `DataTable` element classes
 * this component legitimately composes into (the expand affordance inside a cell
 * and the footer below the grid). Every one of them is defined in
 * `../styles/components.css` against `--dg-*` tokens; none carries a value.
 * ---------------------------------------------------------------------------
 */

/** The block. */
const BLOCK_CLASS = 'dg-query-table';

/** The statement text, in the collapsed cell, the expanded block and the basis block. */
const STATEMENT_CLASS = 'dg-query-table__statement';

/** The execution-count cell. */
const COUNT_CLASS = 'dg-query-table__count';

/** The row-count cell, and the row count of an occurrence. */
const ROWS_CLASS = 'dg-query-table__rows';

/** A duration cell, wherever it appears. */
const DURATION_CLASS = 'dg-query-table__duration';

/** One caller chip and its count. */
const CALLER_CLASS = 'dg-query-table__caller';

/**
 * A caller's execution count: the one slot of a caller that never gives up
 * width, so the source chip beside it is what ellipsizes. Named by class rather
 * than by position, because the caller's span name can follow it.
 */
const CALLER_COUNT_CLASS = 'dg-query-table__caller-count';

/** The list of caller chips in a cell. */
const CALLERS_CLASS = 'dg-query-table__callers';

/** The list of executions in an expanded row. */
const OCCURRENCES_CLASS = 'dg-query-table__occurrences';

/** One execution in that list. */
const OCCURRENCE_ROW_CLASS = 'dg-query-table__occurrence-row';

/** The paging footer, below the grid. */
const FOOTER_CLASS = 'dg-query-table__footer';

/** The three node states. */
const EMPTY_CLASS = 'dg-query-table__empty';

/** @see EMPTY_CLASS */
const LOADING_CLASS = 'dg-query-table__loading';

/** @see EMPTY_CLASS */
const ERROR_CLASS = 'dg-query-table__error';

/** The toolbar row. */
const TOOLBAR_CLASS = 'dg-query-table__toolbar';

/*
 * ---------------------------------------------------------------------------
 * Columns and the closed sort vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * The column keys, held in one place because three things must agree on them:
 * the column definitions, the `DataTableSort` this component reports downward,
 * and the map that turns a header activation back into a `DataQuerySort`.
 */
const COLUMN_KEY = Object.freeze({
  statement: 'statement',
  system: 'system',
  executions: 'executionCount',
  totalDuration: 'totalDurationMs',
  averageDuration: 'averageDurationMs',
  maxDuration: 'maxDurationMs',
  rowCount: 'totalRowCount',
  callers: 'callers',
});

/**
 * The width ROLE of each column, keyed like {@link COLUMN_KEY}.
 *
 * A role names what a column holds, never how wide it is: `DataTable` resolves
 * each one through `DATA_TABLE_COLUMN_TRACKS` to a grid track built from the
 * `--dg-column-min-*` floor and `--dg-column-share-*` share tokens, so this
 * table, every other visualization table and both extension surfaces agree on
 * how wide a statement or a duration is, and no length is chosen here. Each
 * column takes the smallest role whose floor keeps its content readable, in the
 * vocabulary every table shares:
 *
 *   statement   text      the identity column: long free text that wraps and
 *                         never clips, so the widest share of spare width goes
 *                         to it and its length does not set the floor
 *   system      label     a short categorical chip — `postgresql`, or the
 *                         aggregate's `(unknown system)` label at its widest
 *   executions  count     an integer tally, sortable
 *   durations   quantity  a formatted measurement with its unit, such as
 *                         `940.50 ms` or `12.345 s`; the total sorts
 *   rows        count     an integer tally
 *   callers     name      a list of caller source chips, each showing its
 *                         caller's name beside its execution count. A longer
 *                         name ellipsizes inside its chip, and the chip's
 *                         tooltip still carries the full location
 *
 * Every role has a non-zero floor, and `DataTable` sums the columns' floors
 * and minimums into the grid's width (`--dgc-readable-inline`,
 * `--dgc-min-inline`). A panel just too narrow for every floor therefore
 * narrows the statement (`text`) and caller (`name`) columns, never below the
 * `--dg-column-yield` fraction of their floor, only as far as the table needs
 * to fit: the statement wraps onto more lines and a caller chip ellipsizes. A
 * panel too narrow even for that keeps every floor and scrolls horizontally
 * with every column readable. A floorless
 * `minmax(0, …)` track would let each column shrink to its padding in a narrow
 * panel, where a chip covers the next column's value and the caller stack
 * spills outside its cell. And every role track is a token floor and a ratio
 * rather than a content-based size (`auto`, `min-content`): the header row and
 * each data row are separate grid containers, so a track sized from one row's
 * content would stop sitting under its own header.
 */
const COLUMN_WIDTH = Object.freeze({
  statement: 'text',
  system: 'label',
  executions: 'count',
  totalDuration: 'quantity',
  averageDuration: 'quantity',
  maxDuration: 'quantity',
  rowCount: 'count',
  callers: 'name',
} satisfies Record<keyof typeof COLUMN_KEY, DataTableColumnWidth>);

/**
 * Which ordering a header activation asks the data layer for.
 *
 * The vocabulary is closed at three members and holds one *direction* per
 * ordering, so only the columns those three describe appear here — and a
 * proposal this map cannot express (an ascending count, say) is ignored rather
 * than approximated, which is why the two columns below declare the direction
 * their ordering actually runs in as their first-click direction.
 */
const SORT_FOR_COLUMN: Readonly<Record<string, DataQuerySort>> = Object.freeze({
  [COLUMN_KEY.executions]: 'count_desc',
  [COLUMN_KEY.totalDuration]: 'duration_desc',
});

/**
 * Which column, if any, a resolved ordering is reported on.
 *
 * `start_asc` maps to `null`: the table shows no start-time column, so no
 * header may claim to hold that order. `null` is `DataTable`'s own spelling for
 * "the rows are in the data layer's natural order", which is exactly the truth
 * being told.
 */
const TABLE_SORT_FOR_SORT: Readonly<Record<DataQuerySort, DataTableSort | null>> = Object.freeze({
  duration_desc: Object.freeze({ key: COLUMN_KEY.totalDuration, direction: 'desc' } as const),
  count_desc: Object.freeze({ key: COLUMN_KEY.executions, direction: 'desc' } as const),
  start_asc: null,
});

/**
 * The orderings offered by the toolbar, one option per member of the closed
 * vocabulary — so every option in the list is an ordering the data layer can
 * actually apply, and the control never offers something it cannot deliver.
 */
const ORDER_OPTIONS: readonly SelectOption[] = Object.freeze([
  Object.freeze({ value: 'duration_desc', label: 'Slowest first' }),
  Object.freeze({ value: 'count_desc', label: 'Most executions first' }),
  Object.freeze({ value: 'start_asc', label: 'Earliest first' }),
]);

/** The rows a first-page skeleton stands in for. A count, never a measurement. */
const LOADING_SKELETON_ROWS = 6;

/** The empty page, allocated once so an unpaged render keeps a stable identity. */
const NO_GROUPS: readonly QueryGroup[] = Object.freeze([]);

/**
 * What a toggle that is not the retry successor spreads in place of
 * `RETRY_SUCCESSOR_FOCUS_ATTRIBUTES`: nothing, allocated once.
 */
const NO_FOCUS_ATTRIBUTES: Readonly<Record<string, never>> = Object.freeze({});

/*
 * ---------------------------------------------------------------------------
 * Props and paging state
 * ---------------------------------------------------------------------------
 */

/** The props of {@link QueryTable}. */
export interface QueryTableProps {
  /**
   * The validated `queryTable` node to draw: its identity, its labels and the
   * `DataQuery` it reads.
   *
   * `node.id` is the identity reported through every {@link PanelActions}
   * callback, so a host with two query tables in one panel can tell them apart.
   */
  node: QueryTableNode;

  /**
   * Extra classes composed after `dg-query-table`, for the layout the enclosing
   * layout node owns. Composition only: any class named by a caller is defined
   * in `../styles/components.css` against `--dg-*` tokens.
   */
  className?: string | undefined;
}

/**
 * One view's paging position, and the pages it has already been handed.
 *
 * Held as a single value keyed by the *identity* of the request it belongs to,
 * which is what lets the reset be a pure read rather than a write: when the
 * node's query, the chosen ordering or the page size changes, the identity no
 * longer matches and the component simply reads a fresh position instead of
 * setting state during a render or from an effect — both of which the React
 * Compiler lint rules this package runs under forbid outright, and rightly so.
 *
 * `frozen` holds the pages already resolved and displayed, captured at the
 * moment the reader asked for the next one. Nothing merges, re-orders or
 * de-duplicates them: each page is appended in the order the data layer paged it.
 */
interface PagingState {
  /** The request these pages belong to; see {@link pagingIdentityOf}. */
  readonly identity: string;

  /** The `offset` the current page was requested with. */
  readonly offset: number;

  /** Every page before the current one, in the order they arrived. */
  readonly frozen: readonly QueryGroup[];
}

/*
 * ---------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------
 */

/**
 * The page size a query is resolved with: the contract's default when no
 * `limit` was authored, and otherwise the authored value, preserved, within
 * `[0, DATA_QUERY_MAX_LIMIT]`.
 *
 * Zero is kept exactly. The schema admits `limit: 0` as an explicit request for
 * a total without rows (`packages/panel-schema/src/nodes/query.ts`), the page
 * echo reports it back unchanged, and only the *absence* of the field means
 * "unset" — so this view sends `limit: 0`, renders the count-only state and
 * never pages (see {@link canAdvance}). Raising it to one row would draw a
 * statement the node never asked for.
 *
 * A value a validated node cannot carry is still bounded rather than trusted:
 * a non-finite one is treated as unauthored, a fractional one is truncated, a
 * negative one is floored at zero and an oversized one is capped at the
 * contract's ceiling.
 *
 * @param limit The node's authored `limit`, if any.
 * @returns A page size in `[0, DATA_QUERY_MAX_LIMIT]`; `0` only when authored.
 */
function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 0), DATA_QUERY_MAX_LIMIT);
}

/**
 * Whether the provider's `nextOffset` names a page this view may request next.
 *
 * Paging only ever moves forward, and only along the offsets the service
 * reports (`packages/protocol/src/http.ts`, `nextOffset`): the response has to
 * have settled, the page size has to be positive — a count-only query has no
 * next page by definition — and the reported offset has to be a safe integer
 * strictly beyond the one this page was requested at. Anything else — end of
 * data, a value that repeats or rewinds the current offset — offers no Load
 * More, because following it would re-request, and re-append, rows already on
 * screen. The offset is never derived from the length of the page.
 *
 * @param status The hook's status for the current page.
 * @param pageLimit The resolved page size of the request.
 * @param pageOffset The `offset` the current page was requested with.
 * @param nextOffset The provider's reported next offset, if any.
 * @returns `true` when `nextOffset` may be requested next, and is then a number.
 */
function canAdvance(
  status: 'loading' | 'error' | 'success',
  pageLimit: number,
  pageOffset: number,
  nextOffset: number | undefined,
): nextOffset is number {
  return (
    status === 'success' &&
    pageLimit > 0 &&
    nextOffset !== undefined &&
    Number.isSafeInteger(nextOffset) &&
    nextOffset > pageOffset
  );
}

/** The copy of an empty state: an optional first line and the required message. */
interface EmptyPageCopy {
  /** The first line, when the absence needs a label of its own. */
  readonly title: string | undefined;

  /** The explanation. */
  readonly message: string;
}

/**
 * The copy of the empty capture — the one empty page that says no statements
 * were captured — as one frozen value, so the empty state recognises it by
 * reference and gives it the view's glyph.
 */
const NOTHING_CAPTURED_COPY: EmptyPageCopy = Object.freeze({
  title: EMPTY_TITLE,
  message: EMPTY_MESSAGE,
});

/** The paging facts {@link describeEmptyPage} chooses between. */
interface EmptyPageFacts {
  /** The resolved page size; `0` is a count-only query. */
  readonly pageLimit: number;

  /** Where the node asked paging to begin. */
  readonly baseOffset: number;

  /** The `offset` the empty page was requested with. */
  readonly pageOffset: number;

  /** The provider's reported total for the query, if it reported one. */
  readonly total: number | undefined;

  /** Whether the provider reported a forward next page (see {@link canAdvance}). */
  readonly hasNextPage: boolean;
}

/**
 * What a successful request that put no rows on screen actually means.
 *
 * An empty page is not an empty capture. In precedence:
 *
 * 1. **Count only** — `limit: 0` asked for a total and no rows, so the total is
 *    the whole answer and is shown when reported.
 * 2. **Nothing captured** — the provider reported a total of zero, or reported
 *    no total for a walk that began at the first item and found no further
 *    page: {@link EMPTY_MESSAGE}, unchanged.
 * 3. **Past the end** — a positive total and a page starting at or beyond it
 *    (an authored offset past the end is an empty page, never an error).
 * 4. **Empty within the total** — a positive total and a page inside it that
 *    the provider nonetheless left empty.
 * 5. **No total** — a page past the first item with no reported total.
 *
 * A forward page (which the empty state then offers through Load More) changes
 * one thing: "no total, from the first item" can no longer claim that nothing
 * was captured — the provider says more pages exist — so it reads as case 5 at
 * the page's own position instead. A reported total of zero keeps case 2 even
 * then, because that sentence is the provider's own count, not an inference.
 *
 * @param facts The paging facts of the empty page.
 * @returns The title and message of its empty state.
 */
function describeEmptyPage(facts: EmptyPageFacts): EmptyPageCopy {
  const { pageLimit, baseOffset, pageOffset, hasNextPage } = facts;

  // A total the page echo could not carry — negative, fractional, non-finite —
  // is not a number anyone can be told, so it reads as "not reported".
  const total =
    facts.total !== undefined && Number.isSafeInteger(facts.total) && facts.total >= 0
      ? facts.total
      : undefined;

  if (pageLimit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message: total === undefined ? COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE : countOnlyMessage(total),
    };
  }

  if (total === 0 || (total === undefined && baseOffset === 0 && !hasNextPage)) {
    return NOTHING_CAPTURED_COPY;
  }

  if (total === undefined) {
    return { title: EMPTY_PAGE_TITLE, message: emptyWithoutTotalMessage(pageOffset) };
  }

  return {
    title: EMPTY_PAGE_TITLE,
    message:
      pageOffset >= total ? pastEndMessage(pageOffset, total) : emptyWithinTotalMessage(total),
  };
}

/**
 * The offset a view starts paging from: the node's own `offset`, or the
 * contract's first page.
 *
 * @param offset The node's authored `offset`, if any.
 * @returns A non-negative starting offset.
 */
function resolveBaseOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return DATA_QUERY_DEFAULT_OFFSET;
  }

  return offset;
}

/**
 * A string that is equal for two requests whose pages may be concatenated, and
 * different for two that may not.
 *
 * Everything that changes *which* items a page holds is in it — the source, the
 * filter field by field, the ordering, the page size and the starting offset —
 * and the current offset is deliberately not, because advancing it is precisely
 * the operation that appends rather than resets.
 *
 * @param query The node's query, as authored.
 * @param sort The ordering actually in force, which may be the reader's.
 * @param pageLimit The resolved page size.
 * @param baseOffset The resolved starting offset.
 * @returns The identity of the paged request.
 */
function pagingIdentityOf(
  query: DataQuery,
  sort: DataQuerySort,
  pageLimit: number,
  baseOffset: number,
): string {
  const filter = query.filter;

  return [
    query.source,
    sort,
    String(pageLimit),
    String(baseOffset),
    filter?.traceId ?? '',
    filter?.kinds === undefined ? '' : filter.kinds.join(','),
    filter?.component ?? '',
    filter?.tier ?? '',
    filter?.minDuration === undefined ? '' : String(filter.minDuration),
  ].join('\u0000');
}

/**
 * The paging position a request starts at.
 *
 * @param identity The request's identity.
 * @param baseOffset Where the node asked paging to begin.
 * @returns A position with no frozen pages.
 */
function freshPaging(identity: string, baseOffset: number): PagingState {
  return { identity, offset: baseOffset, frozen: NO_GROUPS };
}

/**
 * The row whose expand toggle takes over keyboard focus from a retry that
 * succeeded: the first group of the page the settled request returned.
 *
 * That is the error state's successor contract
 * (`RETRY_SUCCESSOR_FOCUS_ATTRIBUTES` in `../primitives/ErrorState`), applied to
 * both scopes this view retries in. After a failed first page the settled page
 * is the whole table, so focus lands on its first row; after a failed further
 * page it is the page appended below the rows already read, so focus lands on
 * the first row that arrived rather than jumping back to the top. Only a page
 * that succeeded names one: while a page is loading or has failed there is
 * nothing recovered to hand focus to, and a failure's own Retry must be the
 * only keyed control in the node.
 *
 * @param page The page that settled successfully, or `undefined` while none has.
 * @returns The id of that page's first group, or `undefined` for none.
 */
function retrySuccessorKeyOf(page: readonly QueryGroup[] | undefined): string | undefined {
  return page?.[0]?.id;
}

/**
 * Whether a string carries something to render.
 *
 * @param value The candidate.
 * @returns `true` when it holds a non-blank character.
 */
function hasText(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * A count for display, or {@link NOT_AVAILABLE_LABEL} when the producer never
 * reported one.
 *
 * The distinction is load-bearing and is why this is not a `?? 0`: a group from
 * a producer that reports no row counts says nothing, and printing `0` would
 * turn "never measured" into the observation "returned no rows".
 *
 * @param value The reported count, if any.
 * @returns The formatted count, or `n/a`.
 */
function countOrUnavailable(value: number | undefined): string {
  return value === undefined ? NOT_AVAILABLE_LABEL : formatCount(value);
}

/**
 * When one execution started, as an offset from the group's first execution.
 *
 * An offset rather than a wall-clock time, which is this package's convention
 * for every captured instant: the canonical time base is epoch milliseconds and
 * epoch text would be noise beside the statement it belongs to.
 *
 * @param startTime The execution's `startTime`, in epoch milliseconds.
 * @param originEpochMs The group's first `startTime`.
 * @returns A signed offset, or `n/a` for an immeasurable pair.
 */
function occurrenceOffsetText(startTime: number, originEpochMs: number): string {
  const offset = formatOffset(startTime, originEpochMs);

  return offset === NOT_AVAILABLE_LABEL ? offset : `+${offset}`;
}

/*
 * ---------------------------------------------------------------------------
 * Cells
 *
 * Plain functions, module-level and pure: they take a row and return nodes, so
 * the same markup is produced wherever they are called from and none of them is
 * a component definition nested inside another (which the React Compiler lint
 * rules of this package forbid, and which would remount a cell on every render
 * of the table).
 * ---------------------------------------------------------------------------
 */

/**
 * The row header: the expand affordance and the statement.
 *
 * The statement is the **received** text. Collapsed, the cell shows this
 * package's display preview of it — one line, bounded by the same 120-code-point
 * budget that bounds every captured preview — and, whenever that preview is not
 * the whole statement, the untouched statement travels with it as the cell's
 * tooltip, whose bubble is in the document whether it is shown or not and whose
 * trigger — the preview — is focusable (`tabIndex={-1}`, reached by the grid's
 * arrow keys), so the full text opens without a pointer. A preview that already
 * is the whole statement has nothing to disclose, so it carries neither a
 * tooltip nor a `tabIndex`, and the grid's arrow keys pass over it. Nothing
 * re-formats, re-cases, highlights or completes a placeholder, here or anywhere
 * below.
 *
 * The toggle reports the disclosure state itself — `aria-expanded` and the
 * `aria-controls` that names the open detail row, both from `meta` — because a
 * `grid` row cannot carry `aria-expanded` (see `../primitives/DataTable`). Its
 * name carries the same preview the cell shows, so each row's toggle names the
 * statement it opens (see {@link disclosureLabel}).
 *
 * A group whose statement is the aggregate's "no readable statement" key is the
 * one case rendered as prose rather than as code: it is the data layer's word
 * for an absence, and dressing it as a statement would invent one.
 *
 * The toggle of the first row the settled page brought also carries the error
 * state's successor focus key (see {@link retrySuccessorKeyOf}): it is the
 * row's first control, named by the statement it opens, so a reader whose
 * retry succeeded lands on the recovered rows rather than on the node's
 * heading or its bare frame.
 *
 * @param group The row.
 * @param meta The row's expansion state and the id of its detail row, as
 * `DataTable` hands it to every cell of the row.
 * @param onToggle Called with the row when the affordance is activated.
 * @param retrySuccessor Whether this row's toggle is where a successful retry's
 * focus belongs.
 * @returns The cell's content.
 */
function renderStatementCell(
  group: QueryGroup,
  meta: DataTableCellMeta,
  onToggle: (group: QueryGroup) => void,
  retrySuccessor: boolean,
): ReactNode {
  const { expanded, detailRowId } = meta;
  const unknown = group.statement === UNKNOWN_STATEMENT;
  const preview = oneLinePreview(group.statement);
  const abbreviated = !unknown && preview !== group.statement;

  // Deliberately left to inference rather than annotated as `ReactElement`: the
  // tooltip below takes a child whose props carry `aria-describedby`, which it
  // clones the description onto, and a widened element type does not satisfy
  // that. Both primitives accept the attribute; the element type says so.
  //
  // An abbreviated preview is focusable because its tooltip is the only place
  // the whole statement appears in a collapsed row, and focus is how a keyboard
  // reader opens one. `-1`, not `0`: the grid is a single Tab stop, and its
  // arrow keys move onto the preview. It stays a plain `<code>` — no role, no
  // handler, no name — so the preview is what is read and the bubble describes
  // it. A preview that is the whole statement has no tooltip, and so no index.
  const statement = unknown ? (
    <Text size="sm" tone="muted">
      {group.statement}
    </Text>
  ) : (
    <Code size="sm" wrap className={STATEMENT_CLASS} tabIndex={abbreviated ? -1 : undefined}>
      {preview}
    </Code>
  );

  return (
    <Stack direction="horizontal" gap={1} align="start">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        className="dg-data-table__expand-button"
        tabIndex={-1}
        aria-expanded={expanded}
        aria-controls={detailRowId}
        aria-label={disclosureLabel(expanded, preview)}
        icon={
          expanded ? (
            <ChevronDown aria-hidden="true" className="dg-icon" />
          ) : (
            <ChevronRight aria-hidden="true" className="dg-icon" />
          )
        }
        onClick={() => {
          onToggle(group);
        }}
        {...(retrySuccessor ? RETRY_SUCCESSOR_FOCUS_ATTRIBUTES : NO_FOCUS_ATTRIBUTES)}
      />
      {abbreviated ? <Tooltip content={group.statement}>{statement}</Tooltip> : statement}
    </Stack>
  );
}

/**
 * The engine that ran the statement, or the data layer's label for never having
 * been told.
 *
 * The two cases are distinguished by the chip's own variant rather than by
 * inventing wording: a reported engine is a filled chip, an unreported one an
 * outlined chip carrying the aggregate's label.
 *
 * @param group The row.
 * @returns The cell's content.
 */
function renderSystemCell(group: QueryGroup): ReactNode {
  const system = group.system;

  return system !== undefined && hasText(system) ? (
    <Badge tone="neutral" variant="soft">
      {system}
    </Badge>
  ) : (
    <Badge tone="neutral" variant="outline">
      {UNKNOWN_DB_SYSTEM}
    </Badge>
  );
}

/**
 * How many times the statement ran — the number that makes "this one ran twice"
 * legible, and the reason a duplicate-query follow-up can be answered from this
 * table at all.
 *
 * @param group The row.
 * @returns The cell's content.
 */
function renderExecutionsCell(group: QueryGroup): ReactNode {
  return (
    <Code size="sm" numeric className={COUNT_CLASS}>
      {formatCount(group.executionCount)}
    </Code>
  );
}

/**
 * Rows returned across every execution that reported a count, or `n/a`.
 *
 * A count, never a hint that the rows themselves exist anywhere in this
 * product: nothing about a result is captured beyond its size, which the cell's
 * tooltip states in as many words. The figure is focusable — `tabIndex={-1}`,
 * reached by the grid's arrow keys — so that note is reachable without a
 * pointer.
 *
 * @param group The row.
 * @returns The cell's content.
 */
function renderRowCountCell(group: QueryGroup): ReactNode {
  return (
    <Tooltip content={ROW_COUNT_TOOLTIP}>
      {/* Focusable on purpose: focus is how a keyboard reader opens the
          tooltip, and `-1` keeps the grid a single Tab stop whose arrow keys
          move onto the figure. The figure is read and the bubble describes
          it, so the `<code>` gains no role, handler or name of its own. */}
      <Code size="sm" numeric className={ROWS_CLASS} tabIndex={-1}>
        {countOrUnavailable(group.totalRowCount)}
      </Code>
    </Tooltip>
  );
}

/**
 * One chip per code location that ran the statement, busiest first as the
 * aggregate ordered them.
 *
 * The click-to-source flow ends at this table's caller chip: the chip is a
 * `SourceLink` handed the caller's `SourceLocation` by reference, so the
 * location the host opens is field-for-field the one the resolver produced. A
 * caller the resolver could not place renders as its name in plain text — never
 * as a control that would do nothing — and a group whose executions could not
 * be attributed to anybody says `n/a` rather than naming a caller it does not
 * have.
 *
 * The chip is captioned by the location it opens — its symbol and compacted
 * `file:line` — with that caller's share of the group's executions beside it
 * and the caller's span name after both as plain text; see
 * {@link renderCaller}. The count's meaning is in its tooltip, because a bare
 * number next to a location is ambiguous, and the count is focusable — reached
 * by the grid's arrow keys — so that meaning is reachable without a pointer.
 *
 * The list is a vertical `Stack` that STRETCHES its callers across the cell,
 * and this is set explicitly because a centred list would break the cell. A
 * chip is often wider than its column. Centred, such a chip would overflow both
 * edges of the cell: it would start before the cell's start edge, cutting off
 * the start of the caller's name, and its end would spill into the Rows column.
 * Stretched, every caller is exactly as wide as the cell, so the chip starts at
 * the cell's start edge and ellipsizes when there is not enough room.
 *
 * @param group The row.
 * @returns The cell's content.
 */
function renderCallersCell(group: QueryGroup): ReactNode {
  if (group.callers.length === 0) {
    return (
      <Text size="xs" tone="muted">
        {NOT_AVAILABLE_LABEL}
      </Text>
    );
  }

  return (
    <Stack gap={1} align="stretch" className={CALLERS_CLASS}>
      {group.callers.map((caller) => renderCaller(caller))}
    </Stack>
  );
}

/**
 * One caller: where it ran the statement from (as a chip when it resolved to a
 * location), the span that issued it, and its share of the executions.
 *
 * `caller.name` is the name of the span the statement ran under — a request, a
 * route handler — not of the place in the code the chip opens, so it never
 * captions the chip: a control labelled with one thing that opens another
 * fails WCAG 2.5.3 and misleads every reader. The chip derives its caption from
 * the resolved location itself (the symbol and the compacted `file:line`), so
 * what it says is where it goes, and its accessible name starts with exactly
 * that visible text. The span name stays on screen as separate plain text
 * after the chip and its count, outside the button, because which operation
 * issued the statement is context a reader needs beside the location. A
 * caller the resolver could not place has no location to caption a chip with,
 * so its span name alone is shown, as text rather than as a control that leads
 * nowhere.
 *
 * A horizontal `Stack`. Its main axis runs inline and is packed at the START
 * (`justify="start"`), so the chip always begins at the cell's start edge and
 * the count follows it. `align="center"` applies only to the cross axis: it
 * centres the chip and the count VERTICALLY against each other and never
 * moves either one horizontally.
 *
 * @param caller The caller, exactly as the aggregate produced it.
 * @returns The chip group.
 */
function renderCaller(caller: QueryCaller): ReactElement {
  const source = caller.source;

  // Wrapping, so the group never needs more width than its widest part: the
  // chip and its count share the first line, and the span name moves onto a
  // line of its own when the cell cannot hold all three side by side, rather
  // than pushing the group out of its column. On that first line the count
  // keeps its full width and the chip is what ellipsizes, so the figure a
  // reader compares across callers is always whole.
  return (
    <Stack
      key={caller.id}
      direction="horizontal"
      gap={1}
      align="center"
      justify="start"
      wrap
      className={CALLER_CLASS}
    >
      {source === undefined ? (
        <Text size="xs" tone="secondary" truncate>
          {caller.name}
        </Text>
      ) : (
        // `location` is passed straight through: no rebuilding, no adjusting,
        // no re-validating, and no caption of this file's own. The chip reads
        // the host's `onOpenSource` from the panel actions context itself, and
        // leaves the Tab order to the grid, whose arrow keys move onto it.
        <SourceLink location={source} tabIndex={-1} />
      )}
      <Tooltip content={CALLER_COUNT_TOOLTIP}>
        {/* Focusable on purpose (`-1`, reached by the grid's arrow keys), and
            still a label rather than a control: no role, handler or name, so
            the source chip, where there is one, stays the only thing here that
            acts, and the bubble describes the figure that is read. */}
        <Badge tone="neutral" variant="soft" tabIndex={-1} className={CALLER_COUNT_CLASS}>
          {formatCount(caller.executionCount)}
        </Badge>
      </Tooltip>
      {source !== undefined && hasText(caller.name) ? (
        // The span the statement ran under, as context after the chip and its
        // count: plain text, outside every control, never the chip's caption.
        // It wraps rather than truncates: no tooltip carries it, so an
        // ellipsis would hide the part of a long name a reader came for, and a
        // wrapping line asks the cell for no more width than its longest word.
        <Text size="xs" tone="secondary">
          {`${CALLER_SPAN_PREFIX} ${caller.name}`}
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * One execution inside an expanded row: when it ran relative to the group's
 * first execution, how long it took, how many rows it reported, how it ended,
 * and where it came from.
 *
 * Activating it selects the underlying event, which is the one place in this
 * view where a single event exists to select. The aggregate row above has none —
 * it stands for many — so it never reports one, and no identifier is invented to
 * fill the gap. The execution that is the panel's selected event carries the
 * one selected-state class, `dg-is-selected`, and its select control reports
 * `aria-pressed`, so the mark every other view draws for that event is drawn
 * here too, as an attribute as well as a colour.
 *
 * It sits in the expanded detail row, inside the grid, so every focusable
 * element here — the selector, the row-count trigger, the source chip — is
 * `tabIndex={-1}` and reached by the grid's arrow keys, which continue from the
 * data row's controls into its detail.
 *
 * @param occurrence The execution.
 * @param originEpochMs The group's first `startTime`, the offsets' origin.
 * @param onSelect Called with the execution when it is activated, when a host
 * offered somewhere to send it.
 * @param selection The panel's selected event, if any.
 * @returns The occurrence row.
 */
function renderOccurrenceRow(
  occurrence: QueryOccurrence,
  originEpochMs: number,
  onSelect: ((occurrence: QueryOccurrence) => void) | undefined,
  selection: PanelSelection | undefined,
): ReactElement {
  const selected = matchesPanelSelection(selection, occurrence);
  const offsetText = occurrenceOffsetText(occurrence.startTime, originEpochMs);
  const offset: ReactElement = (
    <Code size="sm" numeric>
      {offsetText}
    </Code>
  );

  return (
    <Stack
      key={occurrence.id}
      direction="horizontal"
      gap={2}
      align="center"
      wrap
      className={clsx(OCCURRENCE_ROW_CLASS, selected && 'dg-is-selected')}
    >
      {onSelect === undefined ? (
        offset
      ) : (
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          aria-label={`${SELECT_OCCURRENCE_PREFIX} ${offsetText}`}
          aria-pressed={selected}
          onClick={() => {
            onSelect(occurrence);
          }}
        >
          {offset}
        </Button>
      )}
      <DurationCell
        ms={occurrence.durationMs}
        severity="auto"
        size="sm"
        className={DURATION_CLASS}
      />
      <Tooltip content={ROW_COUNT_TOOLTIP}>
        {/* Focusable on purpose, as in the row-count column: focus is how a
            keyboard reader opens the privacy note that explains this figure,
            and the grid's arrow keys are what move it there. */}
        <Code size="sm" numeric className={ROWS_CLASS} tabIndex={-1}>
          {countOrUnavailable(occurrence.rowCount)}
        </Code>
      </Tooltip>
      <Badge tone="neutral" variant="soft" color={statusColorVar(occurrence.status)}>
        {formatStatusLabel(occurrence.status)}
      </Badge>
      {occurrence.source === undefined ? null : (
        <SourceLink location={occurrence.source} compact tabIndex={-1} />
      )}
    </Stack>
  );
}

/**
 * A measurement the table has no column for, named beside its value.
 *
 * @param label The measurement's name.
 * @param ms Its value in milliseconds.
 * @returns The labelled duration.
 */
function renderLabelledDuration(label: string, ms: number): ReactElement {
  return (
    <Stack direction="horizontal" gap={1} align="center">
      <Text size="xs" tone="muted">
        {label}
      </Text>
      <DurationCell ms={ms} severity="auto" size="sm" className={DURATION_CLASS} />
    </Stack>
  );
}

/**
 * The detail of one expanded row: the full statement, the measurements the table
 * has no column for, the grouping basis where it differs from the statement
 * shown, and the executions themselves.
 *
 * The statement here is the whole received text in a block that preserves its
 * whitespace byte-for-byte and stays keyboard-reachable when it scrolls. The
 * grouping basis is the aggregate's own `normalizedStatement`, displayed and
 * never recomputed: it is what collapsed several executions into one row, and
 * showing it is how the row stays honest about having done so.
 *
 * Both blocks override `Code`'s scrollable-box default of `tabIndex={0}` with
 * `-1`: the detail row is inside the grid, whose single Tab stop is the active
 * row, and the grid's arrow keys move focus onto a block. Once focused, a block
 * that actually overflows keeps the arrow keys along the axis it scrolls
 * (`DataTable` leaves those keys to it), so a long statement is still scrolled
 * from the keyboard.
 *
 * @param group The expanded row.
 * @param onSelect Called when one of the executions is activated.
 * @param selection The panel's selected event, if any.
 * @returns The detail content.
 */
function renderDetail(
  group: QueryGroup,
  onSelect: ((occurrence: QueryOccurrence) => void) | undefined,
  selection: PanelSelection | undefined,
): ReactNode {
  const showsBasis = group.normalizedStatement !== group.statement;

  return (
    <Stack gap={2}>
      <Code block wrap size="sm" className={STATEMENT_CLASS} tabIndex={-1}>
        {group.statement}
      </Code>

      <Stack direction="horizontal" gap={4} align="center" wrap>
        {renderLabelledDuration(FASTEST_LABEL, group.minDurationMs)}
        {group.errorCount > 0 ? (
          <Badge tone="danger" variant="soft">
            {failureBadgeText(group.errorCount)}
          </Badge>
        ) : null}
      </Stack>

      {showsBasis ? (
        <Stack gap={1}>
          <Text size="xs" tone="muted">
            {GROUPING_BASIS_MESSAGE}
          </Text>
          <Code block wrap size="sm" className={STATEMENT_CLASS} tabIndex={-1}>
            {group.normalizedStatement}
          </Code>
        </Stack>
      ) : null}

      {group.occurrences.length === 0 ? (
        <Text size="xs" tone="muted">
          {NO_OCCURRENCES_MESSAGE}
        </Text>
      ) : (
        <Stack gap={1} className={OCCURRENCES_CLASS}>
          {group.occurrences.map((occurrence) =>
            renderOccurrenceRow(occurrence, group.firstStartTime, onSelect, selection),
          )}
        </Stack>
      )}

      {group.occurrencesTruncated ? (
        <Text size="xs" tone="warning">
          {truncationNoticeText(group.occurrences.length, group.executionCount)}
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * The eight columns, left to right.
 *
 * Each column's width is its role in {@link COLUMN_WIDTH}, which `DataTable`
 * resolves to a token-built track: a share of the spare width above a floor
 * that lets a narrow panel scroll horizontally without squeezing a column below
 * what its content needs. Numeric columns align to the end so their last digits
 * line up down the column.
 *
 * Only the two columns the closed sort vocabulary can actually order are
 * sortable, and each declares the one direction its ordering runs in.
 *
 * The statement column reads a row's disclosure state from the `meta`
 * `DataTable` hands its cells rather than from this view's own key list, so the
 * toggle's `aria-expanded` and `aria-controls` report exactly the detail row the
 * table rendered.
 *
 * @param onToggle Called with a row when its expand affordance is activated.
 * @param retrySuccessorKey The id of the row whose toggle takes over focus from
 * a successful retry, or `undefined` while no row may (see
 * {@link retrySuccessorKeyOf}).
 * @returns The column definitions.
 */
function buildColumns(
  onToggle: (group: QueryGroup) => void,
  retrySuccessorKey: string | undefined,
): readonly DataTableColumn<QueryGroup>[] {
  return [
    {
      key: COLUMN_KEY.statement,
      header: HEADER.statement,
      width: COLUMN_WIDTH.statement,
      rowHeader: true,
      cell: (group, _rowIndex, meta) =>
        renderStatementCell(group, meta, onToggle, group.id === retrySuccessorKey),
    },
    {
      key: COLUMN_KEY.system,
      header: HEADER.system,
      width: COLUMN_WIDTH.system,
      cell: (group) => renderSystemCell(group),
    },
    {
      key: COLUMN_KEY.executions,
      header: HEADER.executions,
      width: COLUMN_WIDTH.executions,
      align: 'end',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (group) => renderExecutionsCell(group),
    },
    {
      key: COLUMN_KEY.totalDuration,
      header: HEADER.totalDuration,
      width: COLUMN_WIDTH.totalDuration,
      align: 'end',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (group) => (
        <DurationCell
          ms={group.totalDurationMs}
          severity="auto"
          size="sm"
          className={DURATION_CLASS}
        />
      ),
    },
    {
      key: COLUMN_KEY.averageDuration,
      header: HEADER.averageDuration,
      width: COLUMN_WIDTH.averageDuration,
      align: 'end',
      cell: (group) => (
        <DurationCell
          ms={group.averageDurationMs}
          severity="auto"
          size="sm"
          className={DURATION_CLASS}
        />
      ),
    },
    {
      key: COLUMN_KEY.maxDuration,
      header: HEADER.maxDuration,
      width: COLUMN_WIDTH.maxDuration,
      align: 'end',
      cell: (group) => (
        <DurationCell
          ms={group.maxDurationMs}
          severity="auto"
          size="sm"
          className={DURATION_CLASS}
        />
      ),
    },
    {
      key: COLUMN_KEY.rowCount,
      header: HEADER.rowCount,
      width: COLUMN_WIDTH.rowCount,
      align: 'end',
      cell: (group) => renderRowCountCell(group),
    },
    {
      key: COLUMN_KEY.callers,
      header: HEADER.callers,
      width: COLUMN_WIDTH.callers,
      cell: (group) => renderCallersCell(group),
    },
  ];
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/** No row is open when the view mounts. Allocated once, for a stable identity. */
const NO_EXPANDED_KEYS: readonly string[] = Object.freeze([]);

/**
 * Renders the `queryTable` node.
 *
 * See this module's header for the privacy guarantee it keeps, the data seam it
 * reaches through and the states it renders. Everything the component decides is
 * below: which ordering is in force, which page is requested, which pages are
 * already on screen, and which rows are open.
 *
 * @param props See {@link QueryTableProps}.
 * @returns The node's content: the table, or the state that stands in for it.
 */
export function QueryTable(props: QueryTableProps): ReactElement {
  const { node, className } = props;

  // The host's callbacks, or `undefined` outside a panel. Read unconditionally,
  // as a hook must be, and safe outside a provider by that module's contract —
  // which is what lets every affordance below degrade to an inert value rather
  // than to a control that silently does nothing.
  const actions = usePanelActions();

  /** The reader's ordering, when they have chosen one. The node's own otherwise. */
  const [sortOverride, setSortOverride] = useState<DataQuerySort | undefined>(undefined);

  /** The rows whose detail is open, keyed by group id. */
  const [expandedKeys, setExpandedKeys] = useState<readonly string[]>(NO_EXPANDED_KEYS);

  const authoredQuery = node.query;

  // A node that reached this component with another source is malformed: the
  // catalog admits exactly one for this type and the validator enforces it, so
  // rather than quietly querying something else, nothing is requested and the
  // error is shown where a developer can see it.
  const readableSource = authoredQuery.source === QUERIES_SOURCE;

  const sort = sortOverride ?? authoredQuery.sort ?? DEFAULT_SORT;
  const pageLimit = resolvePageLimit(authoredQuery.limit);
  const baseOffset = resolveBaseOffset(authoredQuery.offset);
  const identity = pagingIdentityOf(authoredQuery, sort, pageLimit, baseOffset);

  const [paging, setPaging] = useState<PagingState>(() => freshPaging(identity, baseOffset));

  // The reset, as a pure read. When the request's identity has moved on — the
  // node's query changed, the reader re-ordered, the page size changed — the
  // pages held in state belong to a question nobody is asking any more, so this
  // render simply uses a fresh position. No state is written during a render and
  // none from an effect: both are forbidden here, and neither is needed.
  const position = paging.identity === identity ? paging : freshPaging(identity, baseOffset);

  const query = useMemo<(DataQuery & { source: typeof QUERIES_SOURCE }) | undefined>(
    () =>
      readableSource
        ? {
            ...authoredQuery,
            // Re-stated rather than spread: it narrows the type to the one
            // source this view reads, and at runtime it is the value the guard
            // above already established.
            source: QUERIES_SOURCE,
            sort,
            limit: pageLimit,
            offset: position.offset,
          }
        : undefined,
    [authoredQuery, pageLimit, position.offset, readableSource, sort],
  );

  const { status, data, error, announcement, total, nextOffset, retry } = useQuery(query);

  /** The page the provider resolved, present only on success. */
  const page = status === 'success' ? data : undefined;

  /**
   * Whether a forward page exists to offer. `position.offset` is the offset the
   * settled page was requested at: the hook reports a settlement only while it
   * answers the current query, so the two can never belong to different pages.
   */
  const hasNextPage = canAdvance(status, pageLimit, position.offset, nextOffset);

  /**
   * What is on screen: the pages already frozen, then the current one. Appended
   * in the order the data layer paged them and never re-ordered, re-sorted or
   * de-duplicated here.
   */
  const rows = useMemo<readonly QueryGroup[]>(
    () => (page === undefined ? position.frozen : [...position.frozen, ...page]),
    [page, position.frozen],
  );

  const handleToggle = useCallback(
    (group: QueryGroup): void => {
      const expanded = !expandedKeys.includes(group.id);

      setExpandedKeys(
        expanded ? [...expandedKeys, group.id] : expandedKeys.filter((key) => key !== group.id),
      );

      // The state after the gesture, which is what the host is told — never a
      // request to toggle, so a host persisting disclosure needs no parity.
      actions?.onExpand?.(node.id, group.id, expanded);
    },
    [actions, expandedKeys, node.id],
  );

  // The panel's one shared selection: the execution that stands for it is
  // marked, and a selection made here is recorded for every view (a no-op
  // under a host, which records the report itself).
  const { selection, markSelected } = useViewSelection();

  const handleSelectOccurrence = useCallback(
    (occurrence: QueryOccurrence): void => {
      const ref = {
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      };
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  // Absent a host there is nowhere to send a selection, so the occurrence rows
  // render their offset as text instead of as a control that leads nowhere.
  const selectOccurrence = actions === undefined ? undefined : handleSelectOccurrence;

  const handleOrderChange = useCallback(
    (next: string): void => {
      // The control's options are the closed vocabulary itself, so this guard
      // never fires for a value this component offered; it is what keeps a
      // string arriving from anywhere else out of the query.
      if (!isDataQuerySort(next)) {
        return;
      }

      setSortOverride(next);
      actions?.onFilterChange?.(node.id, { sort: next });
    },
    [actions, node.id],
  );

  const handleHeaderSort = useCallback(
    (next: DataTableSort): void => {
      const mapped = SORT_FOR_COLUMN[next.key];

      // The vocabulary holds one direction per ordering, so a proposal it cannot
      // express — the ascending flip of a descending column — is ignored rather
      // than approximated by an ordering the reader did not ask for. The header
      // keeps reporting the order the rows really are in.
      if (mapped === undefined || mapped === sort) {
        return;
      }

      setSortOverride(mapped);
      actions?.onFilterChange?.(node.id, { sort: mapped });
    },
    [actions, node.id, sort],
  );

  const handleLoadMore = useCallback((): void => {
    // The same gate that decides whether the control is rendered, re-checked
    // here so the handler can never follow a counter that repeats or rewinds
    // the current page, or page a count-only query.
    if (page === undefined || !canAdvance(status, pageLimit, position.offset, nextOffset)) {
      return;
    }

    // Exactly the offset the response reported, never one derived from the
    // length of what arrived: a clamped limit would make the arithmetic drift.
    setPaging({ identity, offset: nextOffset, frozen: [...position.frozen, ...page] });
  }, [identity, nextOffset, page, pageLimit, position.frozen, position.offset, status]);

  // The row a successful retry hands focus to: the first of the page that
  // settled. Recomputed per page, so the key is never on a row of an earlier
  // page and never present while a page is in flight or failed.
  const retrySuccessorKey = retrySuccessorKeyOf(page);

  const columns = useMemo<readonly DataTableColumn<QueryGroup>[]>(
    () => buildColumns(handleToggle, retrySuccessorKey),
    [handleToggle, retrySuccessorKey],
  );

  const renderExpandedRow = useCallback(
    (group: QueryGroup): ReactNode => renderDetail(group, selectOccurrence, selection),
    [selectOccurrence, selection],
  );

  const rowKey = useCallback((group: QueryGroup): string => group.id, []);

  /** The block, in every state, so the node keeps its geometry. */
  const shell = (content: ReactNode): ReactElement => (
    <div className={clsx(BLOCK_CLASS, className)}>{content}</div>
  );

  /**
   * The control that asks for the next page, rendered only while
   * {@link hasNextPage} holds — in the footer beneath loaded rows, or as the
   * action of an empty page that the provider says is followed by another.
   */
  const loadMoreControl = (
    <Button variant="secondary" size="sm" onClick={handleLoadMore}>
      {LOAD_MORE_LABEL}
    </Button>
  );

  // `query` is `undefined` exactly when the node names a source this view
  // cannot read (see `readableSource`), so testing it rather than the flag also
  // narrows it for every state below. The mismatch is a defect in the panel,
  // worded from the node catalog by the package's one contract for it, with the
  // node's own query and no retry: asking again cannot change the answer.
  if (query === undefined) {
    return shell(
      <ErrorState className={ERROR_CLASS} {...unsupportedQueryProps(node.type, authoredQuery)} />,
    );
  }

  // The three states, in precedence, while nothing has been loaded yet; once a
  // page is frozen the table below stays on screen and the footer carries the
  // incremental states instead. Built once and placed below, so the same state
  // can stand alone or sit inside a grid that is kept on screen.
  let inPlaceOfRows: ReactElement | undefined;

  if (rows.length === 0) {
    if (status === 'loading') {
      inPlaceOfRows = (
        <LoadingState
          className={LOADING_CLASS}
          variant="rows"
          rows={LOADING_SKELETON_ROWS}
          label={LOADING_LABEL}
        />
      );
    } else if (status === 'error') {
      // The package's one failure contract — the single error-state design every
      // failed node renders — in its view scope: nothing is on screen, so the
      // whole view is what failed.
      inPlaceOfRows = (
        <ErrorState
          className={ERROR_CLASS}
          {...queryFailureProps({ error, announcement, retry }, query)}
        />
      );
    } else {
      // A successful request with no rows on screen. What that means depends on
      // what was asked and what the provider counted — a count-only query, an
      // empty capture, a page past the end of a positive total — and only the
      // empty capture may say that nothing was captured. A page the provider
      // says is followed by another keeps its Load More, so an empty page is
      // never a dead end the service did not declare.
      const emptyCopy = describeEmptyPage({
        pageLimit,
        baseOffset,
        pageOffset: position.offset,
        total,
        hasNextPage,
      });

      inPlaceOfRows = (
        <EmptyState
          className={EMPTY_CLASS}
          title={emptyCopy.title}
          message={emptyCopy.message}
          icon={emptyCopy === NOTHING_CAPTURED_COPY ? <Database className="dg-icon" /> : undefined}
          action={hasNextPage ? loadMoreControl : undefined}
        />
      );
    }
  }

  // Where that state is drawn. Before the reader has chosen an ordering it
  // stands alone, as on first load: there are no controls yet worth keeping.
  // Once they have, a re-query empties the rows on screen — the pages of the
  // old ordering belong to a different result — and replacing the toolbar and
  // the grid then would unmount the very control they just used, the "Order
  // by" select or a sortable header, and drop their focus out of the view. So
  // from then on both stay mounted, as the same elements in the same place, and
  // the state is drawn in the grid's own empty slot — outside its rows, where
  // `DataTable` places it — with the new ordering already reported by the
  // select and the header's `aria-sort`.
  const holdGrid = sortOverride !== undefined;

  if (inPlaceOfRows !== undefined && !holdGrid) {
    return shell(inPlaceOfRows);
  }

  return shell(
    <>
      <Toolbar
        className={TOOLBAR_CLASS}
        label={TOOLBAR_LABEL}
        selects={[
          {
            id: `${node.id}-order`,
            label: ORDER_LABEL,
            value: sort,
            options: ORDER_OPTIONS,
            onValueChange: handleOrderChange,
          },
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={rowKey}
        caption={node.title ?? DEFAULT_CAPTION}
        sort={TABLE_SORT_FOR_SORT[sort]}
        onSortChange={handleHeaderSort}
        expandedRowKeys={expandedKeys}
        onRowToggle={handleToggle}
        onRowActivate={handleToggle}
        renderExpandedRow={renderExpandedRow}
        empty={inPlaceOfRows}
      />

      {/* Drawn while rows are on screen: with none, the state in the grid's
          empty slot is what speaks for the view, and a count of nothing
          beside a loading skeleton would say less than that state does. */}
      {rows.length > 0 ? (
        <Stack
          direction="horizontal"
          gap={2}
          align="center"
          justify="between"
          wrap
          className={clsx('dg-data-table__footer', FOOTER_CLASS)}
        >
          {/* A polite live region: a further page appending rows changes this
              sentence, and a reader who asked for it is told how much of the
              result is now on screen without moving focus off the control they
              used. Atomic, so the whole sentence is read rather than only the
              figure that changed. It is a live region and not `role="status"`,
              which is reserved for the first page's loading state. */}
          <Text size="xs" tone="muted" aria-live="polite" aria-atomic="true">
            {loadedText(rows.length, total)}
          </Text>

          {status === 'loading' ? (
            <Text size="xs" tone="muted">
              {LOADING_MORE_MESSAGE}
            </Text>
          ) : null}

          {hasNextPage ? loadMoreControl : null}
        </Stack>
      ) : null}

      {/*
       * A further page that failed gets the same error contract as a first page
       * that did, in its page scope: the next-page title and lead, the
       * rejection's cause, hint and code, the failing query as it was sent —
       * its `offset` is the page that failed — and a retry that re-issues
       * exactly that request, labelled for the page. It sits below the footer
       * rather than in place of the grid, so the statements already read stay
       * on screen and the reader keeps their place. With no rows on screen the
       * failure is the view's own and is drawn in the grid's empty slot above.
       */}
      {status === 'error' && rows.length > 0 ? (
        <ErrorState
          className={ERROR_CLASS}
          {...queryFailureProps({ error, announcement, retry }, query, { scope: 'page' })}
          retryLabel={RETRY_PAGE_LABEL}
        />
      ) : null}
    </>,
  );
}
