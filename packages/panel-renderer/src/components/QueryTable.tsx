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
 * thing recorded about a result is a row *count* (AAP 0.5.2). Nothing in this
 * file transforms that text: it is not re-formatted, not pretty-printed, not
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
 * interface, never a transport (AAP 0.1.2): no socket, no `fetch`, no message
 * port, no knowledge of which host surface it is rendering inside. Ordering,
 * filtering and paging belong to the side that holds the whole capture, so a
 * sort change here is a *re-query*, never a local re-ordering, and a page is
 * appended by asking for the next `offset` rather than by slicing what arrived
 * (AAP 0.4.2). Every field read below comes from the `reads` list of this node
 * type's catalog entry — `catalogEntryFor('queryTable').reads` in
 * `packages/panel-schema/src/catalog.ts`, which is also what the semantic
 * validator checks a generated panel against — resolved into the `queries`
 * result shape by `packages/telemetry/src/aggregate/queries.ts`:
 * span identity, timing, taxonomy, label, status and source, plus the
 * `db.system` / `db.statement` / `db.rowCount` attributes and the function and
 * route-handler keys the caller walk resolves a call site through.
 *
 * ## The click that ends the acceptance flow
 *
 * Acceptance test 1 (AAP 0.8.4) finishes in this table: the caller chip of a
 * statement opens the editor at the call site. That chip is a `SourceLink`
 * handed the caller's own `SourceLocation` **by reference** — this file neither
 * rebuilds, adjusts nor re-validates a location — so what the host receives
 * through `PanelActions.onOpenSource` is exactly what the resolver produced.
 * A caller the resolver could not place renders as plain text rather than as a
 * control that leads nowhere.
 *
 * ## Composition
 *
 * Every visible element is a primitive or a layout primitive of this package:
 * no raw `<table>`, `<button>`, `<input>`, `<select>` or heading element, no
 * inline `style`, and no CSS value of its own (AAP 0.6.4). `DataTable` owns the
 * grid roles, the header sort reporting, the roving tab stop, the expansion
 * keys and the row state classes (`dg-is-selected`, `dg-is-expanded`), which is
 * why none of them appears here; spacing comes from `Stack`, the ordering
 * control from `Toolbar`, colour only ever from `../utils/color`.
 *
 * The only focus stops this file adds of its own sit on the triggers of its
 * tooltips — an abbreviated statement, a row count, a caller's execution count
 * — each carrying `tabIndex={0}`, because a description a pointer reaches by
 * hovering a keyboard reaches by focusing. Such a trigger is described, never
 * operated: it gains no role, no handler and no name of its own (its visible
 * text is what is read, the bubble its description), so the set of controls on
 * screen is unchanged, and its focus ring is the global `:focus-visible` rule
 * of `../styles/base.css`. `DataTable` answers only keys pressed on a row
 * itself, so these stops leave the row navigation intact and let Escape reach
 * the tooltip first.
 *
 * ## States
 *
 * All three, in precedence, for the first page: loading → an `EmptyState` for a
 * capture that legitimately holds no statements → an `ErrorState` with the
 * serialised query and a working retry. Once a page has been loaded and frozen,
 * a further page resolves *underneath* the rows already on screen: blanking a
 * table the reader is using in order to re-show a spinner would lose their
 * place, so the incremental loading and failure states live in the footer beside
 * the control that asked for them.
 *
 * @see packages/panel-schema/src/catalog.ts — the `queryTable` catalog entry
 * @see packages/telemetry/src/aggregate/queries.ts — the `queries` result shape
 */

import type { DataQuery, DataQuerySort, QueryTableNode } from '@debuggen/panel-schema';
import { isDataQuerySort } from '@debuggen/panel-schema';
import type { DebuggenError } from '@debuggen/shared';
import type { QueryCaller, QueryGroup, QueryOccurrence } from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '../host/DataProvider';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn, DataTableSort } from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
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
 * inspected project appears in this file, in its markup or in its comments
 * (AAP 0.5.4), and no example statement is written down anywhere — every
 * statement on screen came from the capture.
 * ---------------------------------------------------------------------------
 */

/** The grid's accessible name when the node carried no title of its own. */
const DEFAULT_CAPTION = 'Database statements captured during this interaction';

/** Shown for a capture that genuinely holds no database statements. */
const EMPTY_MESSAGE = 'No database queries were captured for this interaction.';

/** The accessible name of the busy region while the first page resolves. */
const LOADING_LABEL = 'Loading captured database queries';

/** Message of last resort when a rejection carried no readable text. */
const LOAD_FAILED_MESSAGE = 'The captured database queries could not be loaded.';

/** Title of the error state raised for a node whose query this view cannot read. */
const WRONG_SOURCE_TITLE = 'This view cannot draw the requested data';

/** Message of that same error state. It names the source it can read, and no more. */
const WRONG_SOURCE_MESSAGE = `This view draws grouped database statements and can only read the "${QUERIES_SOURCE}" source. The node asked for another one, so nothing was requested.`;

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

/** The accessible name of the expand affordance while the row is collapsed. */
const EXPAND_ROW_LABEL = 'Show the executions of this statement';

/** The accessible name of the same control while the row is open. */
const COLLAPSE_ROW_LABEL = 'Hide the executions of this statement';

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
   * in `../styles/components.css` against `--dg-*` tokens (AAP 0.6.4).
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
 * de-duplicates them: each page is appended in the order the data layer paged
 * it (AAP 0.4.2).
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
 * The page size a query is resolved with: the authored `limit`, the contract's
 * default when none was authored, and never outside `[1, DATA_QUERY_MAX_LIMIT]`.
 *
 * The schema admits a `limit` of `0` as an explicit request for no items, which
 * is meaningful for a node that wants a total without rows; a *table* has
 * nothing to draw and no way to page with a page size of zero, so this view
 * raises it to one row rather than rendering an empty grid that can never
 * advance. A malformed value — fractional, negative, non-finite — is treated as
 * unauthored rather than trusted.
 *
 * @param limit The node's authored `limit`, if any.
 * @returns A page size in `[1, DATA_QUERY_MAX_LIMIT]`.
 */
function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 0) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(limit, 1), DATA_QUERY_MAX_LIMIT);
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
 * The query as text, for the error state's diagnostic block.
 *
 * Shown to a developer debugging their own project, and safe to show: a query
 * carries a source, a trace id, kinds, a component name, a tier, a duration
 * threshold and paging numbers — never captured data.
 *
 * @param query The query that failed.
 * @returns Its JSON form.
 */
function serializeQuery(query: DataQuery): string {
  return JSON.stringify(query);
}

/**
 * What the error state says: the rejection's own message and hint when it
 * carried them, and generic copy when it did not.
 *
 * The provider's obligation is to reject with a `DebuggenError`, so the common
 * case has a code (rendered separately by `ErrorState`), a message and often an
 * actionable hint. A rejection that carried nothing readable must still produce
 * a sentence rather than an empty banner.
 *
 * @param error The failure, if the hook reported one.
 * @returns One sentence for the reader.
 */
function describeError(error: DebuggenError | undefined): string {
  if (error === undefined) {
    return LOAD_FAILED_MESSAGE;
  }

  const parts = [error.message, error.hint ?? ''].map((part) => part.trim()).filter(hasText);

  return parts.length === 0 ? LOAD_FAILED_MESSAGE : parts.join(' ');
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
 * turn "never measured" into the observation "returned no rows" (AAP 0.5.2).
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
 * trigger — the preview — takes keyboard focus, so the full text opens without
 * a pointer. A preview that already is the whole statement has nothing to
 * disclose, so it carries neither a tooltip nor a focus stop. Nothing
 * re-formats, re-cases, highlights or completes a placeholder, here or anywhere
 * below.
 *
 * A group whose statement is the aggregate's "no readable statement" key is the
 * one case rendered as prose rather than as code: it is the data layer's word
 * for an absence, and dressing it as a statement would invent one.
 *
 * @param group The row.
 * @param expanded Whether this row's detail is open.
 * @param onToggle Called with the row when the affordance is activated.
 * @returns The cell's content.
 */
function renderStatementCell(
  group: QueryGroup,
  expanded: boolean,
  onToggle: (group: QueryGroup) => void,
): ReactNode {
  const unknown = group.statement === UNKNOWN_STATEMENT;
  const preview = oneLinePreview(group.statement);
  const abbreviated = !unknown && preview !== group.statement;

  // Deliberately left to inference rather than annotated as `ReactElement`: the
  // tooltip below takes a child whose props carry `aria-describedby`, which it
  // clones the description onto, and a widened element type does not satisfy
  // that. Both primitives accept the attribute; the element type says so.
  //
  // An abbreviated preview is a focus stop because its tooltip is the only
  // place the whole statement appears in a collapsed row, and focus is how a
  // keyboard reader opens one. It stays a plain `<code>` — no role, no handler,
  // no name — so the preview is what is read and the bubble describes it. A
  // preview that is the whole statement has no tooltip, and so no stop.
  const statement = unknown ? (
    <Text size="sm" tone="muted">
      {group.statement}
    </Text>
  ) : (
    <Code size="sm" wrap className={STATEMENT_CLASS} tabIndex={abbreviated ? 0 : undefined}>
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
        aria-expanded={expanded}
        aria-label={expanded ? COLLAPSE_ROW_LABEL : EXPAND_ROW_LABEL}
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
 * product: nothing about a result is captured beyond its size (AAP 0.5.2),
 * which the cell's tooltip states in as many words. The figure takes keyboard
 * focus so that note is reachable without a pointer.
 *
 * @param group The row.
 * @returns The cell's content.
 */
function renderRowCountCell(group: QueryGroup): ReactNode {
  return (
    <Tooltip content={ROW_COUNT_TOOLTIP}>
      {/* Focusable on purpose: focus is how a keyboard reader opens the
          tooltip. The figure is read and the bubble describes it, so the
          `<code>` gains no role, handler or name of its own. */}
      <Code size="sm" numeric className={ROWS_CLASS} tabIndex={0}>
        {countOrUnavailable(group.totalRowCount)}
      </Code>
    </Tooltip>
  );
}

/**
 * One chip per code location that ran the statement, busiest first as the
 * aggregate ordered them.
 *
 * This is the last hop of the product's headline click (AAP 0.8.4): the chip is
 * a `SourceLink` handed the caller's `SourceLocation` by reference, so the
 * location the host opens is field-for-field the one the resolver produced. A
 * caller the resolver could not place renders as its name in plain text — never
 * as a control that would do nothing — and a group whose executions could not
 * be attributed to anybody says `n/a` rather than naming a caller it does not
 * have.
 *
 * The chip carries the caller's span name and, beside it, that caller's share of
 * the group's executions; the count's meaning is in its tooltip, because a bare
 * number next to a location is ambiguous, and the count takes keyboard focus so
 * that meaning is reachable without a pointer.
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
    <Stack gap={1} className={CALLERS_CLASS}>
      {group.callers.map((caller) => renderCaller(caller))}
    </Stack>
  );
}

/**
 * One caller: its name (as a chip when it resolved to a location), and its share
 * of the executions.
 *
 * @param caller The caller, exactly as the aggregate produced it.
 * @returns The chip group.
 */
function renderCaller(caller: QueryCaller): ReactElement {
  const source = caller.source;

  return (
    <Stack key={caller.id} direction="horizontal" gap={1} align="center" className={CALLER_CLASS}>
      {source === undefined ? (
        <Text size="xs" tone="secondary" truncate>
          {caller.name}
        </Text>
      ) : (
        // `location` is passed straight through: no rebuilding, no adjusting,
        // no re-validating. The chip reads the host's `onOpenSource` from the
        // panel actions context itself.
        <SourceLink location={source} label={caller.name} />
      )}
      <Tooltip content={CALLER_COUNT_TOOLTIP}>
        {/* Focusable on purpose, and still a label rather than a control: no
            role, handler or name, so the source chip, where there is one,
            stays the only thing here that acts, and the bubble describes the
            figure that is read. */}
        <Badge tone="neutral" variant="soft" tabIndex={0}>
          {formatCount(caller.executionCount)}
        </Badge>
      </Tooltip>
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
 * fill the gap.
 *
 * @param occurrence The execution.
 * @param originEpochMs The group's first `startTime`, the offsets' origin.
 * @param onSelect Called with the execution when it is activated, when a host
 * offered somewhere to send it.
 * @returns The occurrence row.
 */
function renderOccurrenceRow(
  occurrence: QueryOccurrence,
  originEpochMs: number,
  onSelect: ((occurrence: QueryOccurrence) => void) | undefined,
): ReactElement {
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
      className={OCCURRENCE_ROW_CLASS}
    >
      {onSelect === undefined ? (
        offset
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${SELECT_OCCURRENCE_PREFIX} ${offsetText}`}
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
            keyboard reader opens the privacy note that explains this figure. */}
        <Code size="sm" numeric className={ROWS_CLASS} tabIndex={0}>
          {countOrUnavailable(occurrence.rowCount)}
        </Code>
      </Tooltip>
      <Badge tone="neutral" variant="soft" color={statusColorVar(occurrence.status)}>
        {formatStatusLabel(occurrence.status)}
      </Badge>
      {occurrence.source === undefined ? null : <SourceLink location={occurrence.source} compact />}
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
 * @param group The expanded row.
 * @param onSelect Called when one of the executions is activated.
 * @returns The detail content.
 */
function renderDetail(
  group: QueryGroup,
  onSelect: ((occurrence: QueryOccurrence) => void) | undefined,
): ReactNode {
  const showsBasis = group.normalizedStatement !== group.statement;

  return (
    <Stack gap={2}>
      <Code block wrap size="sm" className={STATEMENT_CLASS}>
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
          <Code block wrap size="sm" className={STATEMENT_CLASS}>
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
            renderOccurrenceRow(occurrence, group.firstStartTime, onSelect),
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
 * Tracks are ratios and nothing else: a `px` or `rem` track would be a
 * hardcoded value (AAP 0.6.4), and an intrinsic track would size itself from one
 * row's content and stop sitting under its own header, because the header row
 * and each data row are separate grid containers. Numeric columns align to the
 * end so their last digits line up down the column.
 *
 * Only the two columns the closed sort vocabulary can actually order are
 * sortable, and each declares the one direction its ordering runs in.
 *
 * @param expandedKeys The keys of the rows whose detail is open.
 * @param onToggle Called with a row when its expand affordance is activated.
 * @returns The column definitions.
 */
function buildColumns(
  expandedKeys: readonly string[],
  onToggle: (group: QueryGroup) => void,
): readonly DataTableColumn<QueryGroup>[] {
  return [
    {
      key: COLUMN_KEY.statement,
      header: HEADER.statement,
      width: 'minmax(0, 3fr)',
      rowHeader: true,
      cell: (group) => renderStatementCell(group, expandedKeys.includes(group.id), onToggle),
    },
    {
      key: COLUMN_KEY.system,
      header: HEADER.system,
      width: 'minmax(0, 0.9fr)',
      cell: (group) => renderSystemCell(group),
    },
    {
      key: COLUMN_KEY.executions,
      header: HEADER.executions,
      width: 'minmax(0, 0.7fr)',
      align: 'end',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (group) => renderExecutionsCell(group),
    },
    {
      key: COLUMN_KEY.totalDuration,
      header: HEADER.totalDuration,
      width: 'minmax(0, 0.8fr)',
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
      width: 'minmax(0, 0.8fr)',
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
      width: 'minmax(0, 0.8fr)',
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
      width: 'minmax(0, 0.7fr)',
      align: 'end',
      cell: (group) => renderRowCountCell(group),
    },
    {
      key: COLUMN_KEY.callers,
      header: HEADER.callers,
      width: 'minmax(0, 2fr)',
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

  const { status, data, error, total, nextOffset, retry } = useQuery(query);

  /** The page the provider resolved, present only on success. */
  const page = status === 'success' ? data : undefined;

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

  const handleSelectOccurrence = useCallback(
    (occurrence: QueryOccurrence): void => {
      actions?.onSelectEvent({
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      });
    },
    [actions],
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
    if (nextOffset === undefined || page === undefined) {
      return;
    }

    // The offset comes from the response, never from the length of what
    // arrived: a clamped limit would make the arithmetic drift.
    setPaging({ identity, offset: nextOffset, frozen: [...position.frozen, ...page] });
  }, [identity, nextOffset, page, position.frozen]);

  const columns = useMemo<readonly DataTableColumn<QueryGroup>[]>(
    () => buildColumns(expandedKeys, handleToggle),
    [expandedKeys, handleToggle],
  );

  const renderExpandedRow = useCallback(
    (group: QueryGroup): ReactNode => renderDetail(group, selectOccurrence),
    [selectOccurrence],
  );

  const rowKey = useCallback((group: QueryGroup): string => group.id, []);

  /** The block, in every state, so the node keeps its geometry. */
  const shell = (content: ReactNode): ReactElement => (
    <div className={clsx(BLOCK_CLASS, className)}>{content}</div>
  );

  if (!readableSource) {
    return shell(
      <ErrorState
        className={ERROR_CLASS}
        title={WRONG_SOURCE_TITLE}
        message={WRONG_SOURCE_MESSAGE}
        query={serializeQuery(authoredQuery)}
      />,
    );
  }

  // The three states, in precedence, while nothing has been loaded yet. Once a
  // page is frozen the table below stays on screen and the footer carries the
  // incremental states instead.
  if (rows.length === 0) {
    if (status === 'loading') {
      return shell(
        <LoadingState
          className={LOADING_CLASS}
          variant="rows"
          rows={LOADING_SKELETON_ROWS}
          label={LOADING_LABEL}
        />,
      );
    }

    if (status === 'error') {
      return shell(
        <ErrorState
          className={ERROR_CLASS}
          message={describeError(error)}
          code={error?.code}
          query={query === undefined ? undefined : serializeQuery(query)}
          onRetry={retry}
        />,
      );
    }

    return shell(<EmptyState className={EMPTY_CLASS} message={EMPTY_MESSAGE} />);
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
      />

      <Stack
        direction="horizontal"
        gap={2}
        align="center"
        justify="between"
        wrap
        className={clsx('dg-data-table__footer', FOOTER_CLASS)}
      >
        <Text size="xs" tone="muted">
          {loadedText(rows.length, total)}
        </Text>

        {status === 'error' ? (
          <Stack direction="horizontal" gap={2} align="center">
            <Text size="xs" tone="danger">
              {describeError(error)}
            </Text>
            <Button variant="secondary" size="sm" onClick={retry}>
              {RETRY_PAGE_LABEL}
            </Button>
          </Stack>
        ) : null}

        {status === 'loading' ? (
          <Text size="xs" tone="muted">
            {LOADING_MORE_MESSAGE}
          </Text>
        ) : null}

        {status === 'success' && nextOffset !== undefined ? (
          <Button variant="secondary" size="sm" onClick={handleLoadMore}>
            {LOAD_MORE_LABEL}
          </Button>
        ) : null}
      </Stack>
    </>,
  );
}
