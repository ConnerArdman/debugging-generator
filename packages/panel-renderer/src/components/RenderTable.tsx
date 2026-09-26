/**
 * `RenderTable` — per-component render statistics: how often each component
 * rendered, how much time that took, what triggered those renders and which of
 * its inputs changed.
 *
 * This module is the component behind the node catalog's `renderTable` type and
 * the anchor of the re-render panel: a panel built around "why is this rendering
 * so often" is materially different from a latency panel because of this view
 * and its two neighbours, and the render-count acceptance flow of the end-to-end
 * suite is read off it — render counts and timing per component, trigger
 * attribution (context/props/state) where determinable, and component names
 * that link to their declarations.
 *
 * ## THE TRIGGER VOCABULARY IS THE POINT, AND `unchanged` ≠ `unknown`
 *
 * A render count on its own proves nothing: a component that renders often
 * because its inputs changed often is working exactly as asked. What makes this
 * table evidence is the attribution beside the count, and that attribution has
 * one distinction it must never blur — the one the metric definitions in
 * `docs/ARCHITECTURE.md` ("Computed metrics") draw between the two counts:
 *
 *   - `unchanged` — all three inputs were **evaluated** and none had changed:
 *     props were shallow-equal, own hook state was unchanged, and no consumed
 *     context value changed. A render caused by an ancestor rendering, and the
 *     actionable case the `unchanged_render_count` metric counts.
 *   - `unknown` — at least one of those three inputs could **not** be
 *     evaluated, so nothing is claimed. Counted separately as
 *     `render_trigger_unknown_count`.
 *
 * "We checked and nothing changed" and "we could not check" support opposite
 * conclusions, so this file keeps them apart in three independent ways: the two
 * figures are separate columns with separate headers and separate explanatory
 * tooltips; the trigger histogram prints all five vocabulary members including
 * the zeros, each with its own word and its own tone; and **no expression in
 * this file adds, merges, defaults or substitutes one for the other**. Reporting
 * an unclassifiable render as a stable-input render would be exactly the
 * unevidenced assertion an analysis may never contain, arrived at through the
 * renderer instead of through the model.
 *
 * ## PROP NAMES ONLY — VALUES NEVER REACH THIS COMPONENT
 *
 * The producer's fiber diffing sends key **names** plus change counts, bounded
 * by its own per-render key cap, and never a prop value, which
 * `docs/SECURITY.md` ("Never captured") lists among the data the product never
 * captures. So this view renders names and counts and nothing else: there is
 * no value column, no value preview, no expand-to-value affordance and no "show
 * full value" control (opt-in full values are explicitly not implemented in
 * v1). Every name is additionally put through `../utils/format`'s shared
 * truncation budget before it is drawn, so a pathological key cannot stretch a
 * row, and the cell's "+N more" indicator counts only the names that actually
 * arrived — the cap is upstream, so nothing here may imply the list is
 * complete.
 *
 * ## DATA ARRIVES THROUGH THE NODE'S QUERY, INTERACTIONS LEAVE THROUGH ACTIONS
 *
 * The only data path is `../host/useQuery` resolving this node's own
 * `DataQuery` against the ambient `DataProvider`; the only interaction path is
 * `../host/PanelActions`. No socket, no `fetch`, no transport knowledge of any
 * kind — and no runtime import of `@debuggen/telemetry` either: the aggregate
 * shapes are consumed as types, so the page bundle carries the renderer and not
 * the capture pipeline.
 *
 * Three actions are raised, and one deliberately is not:
 *
 *   - `onOpenSource` — through the component's name itself, which is drawn as a
 *     `./SourceLink` captioned with that name whenever the row resolved to a
 *     location, and through the chip beside an individual render that carried
 *     one. A row offers its location once: the name is the control, with no
 *     second chip beside it. The link forwards the `SourceLocation` it was
 *     given **by reference**, unmodified.
 *   - `onExpand` — whenever a row's per-render list is opened or closed, with
 *     this node's `id` and the row's own `id`.
 *   - `onSelectEvent` — from an individual render inside an expanded row, which
 *     is the only item in this view that IS one captured event. The render that
 *     is the panel's selection — reported from here or from any other view — is
 *     marked, read through `useViewSelection` rather than kept in local state.
 *   - **Not** `onRowActivate`. An aggregate row stands for many events and has
 *     no single event id, so activating one selects nothing: inventing a
 *     representative id would open a details drawer on evidence the reader did
 *     not point at (see `../host/PanelActions` on why a fabricated coordinate is
 *     worse than an absent one).
 *
 * ## PAGING IS HONEST ABOUT WHAT IT HAS
 *
 * Two bounds apply and the reader is told about both. The result is paged —
 * every request carries the node's `limit`, which defaults to 200 and is clamped
 * to the contract's 5 000 ceiling — so the footer states how many rows are
 * loaded against the reported total and offers "load more" only while the
 * provider's `nextOffset` says another page exists. An explicit `limit: 0` is
 * sent as zero: the schema's request for a total without rows. It never pages,
 * and it resolves to a count-only state that reports that total. Separately,
 * each row's per-render list is bounded by the producer, and a row that says so
 * (`occurrencesTruncated`) renders an explicit note instead of letting the
 * expansion read as complete.
 *
 * "Load more" **advances the page sequence**; it never grows one request. The
 * next query keeps the source, filter, order and `limit` of the first and moves
 * its `offset` to exactly the `nextOffset` the provider returned — never to a
 * position derived from the page length or the total — so the sequence reaches
 * as far as the provider says it goes, past the 5 000-row page ceiling included.
 * The pages that already arrived are frozen in a local accumulator and the new
 * page is appended beneath them in provider order, de-duplicated by row id, so
 * nothing is fetched or rebuilt twice. An absent `nextOffset`, or one that does
 * not move past the page it answered, ends the sequence.
 *
 * Three consequences, all deliberate. The accumulator is written only by the
 * "load more" gesture and is discarded — during render, with no effect — the
 * moment the sequence's identity (node, source, filter, order, limit) changes, so
 * a re-ordered table can never draw rows of the previous order. While the next
 * page is in flight the loaded rows stay on screen under a busy footer, and a
 * failed next page keeps them and reports the failure with its own retry below
 * the footer line; only the first page resolves through the block's loading and
 * error states. And the view is keyed on the **node's** query rather than the
 * resolved one, so loading pages keeps the reader's open rows and chosen order,
 * while a node pointed at different evidence starts over.
 *
 * ## ORDERING BELONGS TO THE DATA LAYER
 *
 * Nothing here sorts, filters, slices or pages the array it received — the
 * service already did, and re-ordering a page locally would order that page
 * against a total it is only part of. A sort change is therefore a **re-query**
 * mapped onto the node's own `DataQuerySort` vocabulary, and the order the grid
 * reports through `aria-sort` is always the order that was applied: the
 * vocabulary offers one direction per key, so the header of an already-sorted
 * column re-requests the same order rather than reversing into a sort that does
 * not exist, and no direction is ever displayed that the data does not have.
 *
 * ## STATES: ALL THREE, IN PRECEDENCE
 *
 * Loading (a row silhouette), error (the shared error-state contract of
 * `../host/useQuery`: its title, a generic lead followed by the provider's own
 * cause, the failing query as `formatDataQuery` prints it and a working retry)
 * and empty (a node-specific sentence in generic product vocabulary) — never a
 * blank area, and never a failure dressed as a result. The node's empty
 * sentence is reserved for an empty result. A count-only query, a page at or
 * past the end of a counted result, an empty page below a positive total and a
 * later page with no total each get their own sentence, stating the total when
 * one was reported. None of them says the capture holds nothing.
 *
 * Where a state is drawn depends on whether the reader has chosen an order.
 * The first answer resolves as the block's own state, alone. Once the reader
 * has re-ordered — from the toolbar or from a sortable header — the toolbar
 * and the grid's header stay mounted through every state of the re-query, and
 * the state is drawn in the grid's empty slot beneath the header: unmounting
 * them would destroy the very control the reader is operating and drop focus
 * to the document after every change, which full keyboard navigation cannot
 * survive. The rows of the previous order are released by the same gesture, so
 * the header never stands over rows ranked by an order it does not report.
 *
 * ## APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE
 *
 * This file declares class names and nothing else: no inline style object, no
 * colour, no length, no literal CSS value. Every declaration behind the names
 * below lives in `../styles/components.css` against `--dg-*` tokens, every
 * colour decision comes from `../utils/color`, and all spacing comes from
 * `Stack` and `Toolbar`:
 *
 *   `dg-render-table`                  the block: a column that may shrink
 *   `dg-render-table__toolbar`         the sort row, which never stretches
 *   `dg-render-table__loading`         the row silhouette box
 *   `dg-render-table__error`           the failure box, for the first page or
 *                                      for a next page beneath loaded rows
 *   `dg-render-table__empty`           the empty box
 *   `dg-render-table__component-cell`  the component name — as text, or as the
 *                                      source link it is — truncating, mono
 *   `dg-render-table__count-cell`      a figure column, mono and tabular
 *   `dg-is-outlier`                    a count far above the loaded median
 *   `dg-render-table__trigger`         one histogram chip, with its five
 *   `dg-render-table__trigger--*`      per-trigger variants
 *   `dg-render-table__changed-props`   the wrapping key list
 *   `dg-render-table__detail`          the per-render list of an expanded row
 *   `dg-render-table__occurrence`      one render in that list, with
 *                                      `dg-is-selected` while it is the
 *                                      panel's selected event
 *   `dg-data-table__footer`            the paging line below the grid
 *
 * `dg-icon` from `../styles/base.css` is reused and never redefined, and the
 * caller's `className` is composed last. A grid row's `dg-is-expanded`,
 * `dg-is-selected` and every ARIA grid attribute belong to
 * `../primitives/DataTable`, which owns the grid roles, the roving tab stop and
 * the keyboard model — this file configures that primitive rather than
 * competing with it. The one piece of disclosure state this file writes is the
 * one the primitive hands it: a `grid` row may not carry `aria-expanded`, so
 * the row's expand toggle carries it, with `aria-controls` naming the detail
 * row, both read off the cell's `DataTableCellMeta`. The one selected state
 * this file draws itself is an individual render's, inside a detail row the
 * primitive does not structure.
 *
 * ## NOTHING HERE KNOWS ANY PROJECT
 *
 * Every component name, prop name, file path and count on screen comes from the
 * data. No column header, empty sentence, tooltip or comment in this file names
 * a symbol, route or file of any inspected application, which is what lets the
 * same component carry the generalization test against an app it has never
 * seen.
 *
 * @see ../host/useQuery for the three states and the paging counters.
 * @see ../host/PanelActions for the interaction contract.
 * @see ../primitives/DataTable for the grid, its keyboard model and its ARIA.
 * @see @debuggen/panel-schema `catalogEntryFor('renderTable')` — the catalog
 *      entry whose single permitted source (`renders`) and whose `reads` field
 *      list this component draws from.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type {
  DataQuery,
  DataQuerySort,
  DataQuerySource,
  RenderTableNode,
} from '@debuggen/panel-schema';
import { DATA_QUERY_SORTS, isDataQuerySort } from '@debuggen/panel-schema';
import type { RenderOccurrence, RenderPhase, RenderStat, RenderTrigger } from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Layers, TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  useDataProvider,
} from '../host/DataProvider';
import type { DataProvider } from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef } from '../host/PanelActions';
import { queryFailureProps, useQuery } from '../host/useQuery';
import type { UseQueryResult } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarSelect } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import type { BadgeTone } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
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
import type { SelectOption } from '../primitives/Select';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { renderTriggerColorVar } from '../utils/color';
import { formatCount, formatOffset, formatRenderTriggerLabel, truncate } from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The one source this component draws
 * ---------------------------------------------------------------------------
 */

/**
 * The only query source this view can read, which is also the only one its
 * catalog entry permits (`catalogEntryFor('renderTable').sources`).
 *
 * Written as a literal here and forced onto the resolved query below, rather
 * than read off the node: `DataQuery['source']` is the whole open vocabulary at
 * type level, while a node that reached a renderer has already been validated
 * against the catalog — so the literal costs a valid panel nothing and stops a
 * malformed one from asking the provider for a shape this component could not
 * draw.
 */
const RENDERS_SOURCE = 'renders' satisfies DataQuerySource;

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Every string a reader sees, declared once, and all of it generic product
 * vocabulary: nothing below names a component, a prop, a file or a route of any
 * inspected application. The one exception is the failure copy, which is not
 * declared here at all: it comes from the shared error-state contract in
 * `../host/useQuery`, whose `queryFailureProps` gives both failure boxes their
 * title, lead and query block, so a failed page of render statistics reads
 * exactly like every other failed node.
 * ---------------------------------------------------------------------------
 */

/** The grid's accessible name. Required by `DataTable`, and never a heading. */
const TABLE_CAPTION = 'Render statistics per component';

/** Announced while the page is resolving; never painted. */
const LOADING_LABEL = 'Loading render statistics…';

/** The node's fixed empty sentence, said only for an empty result. */
const EMPTY_MESSAGE = 'No renders were captured for this interaction.';

/** The first line above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No renders';

/**
 * The sentence for a resolved page that held no rows while the provider still
 * named a next page. It speaks only of this page: saying the capture holds no
 * renders would contradict the offset the provider just returned.
 */
const EMPTY_PAGE_MESSAGE =
  'This page of render statistics held no components. More of the result remains to be loaded.';

/**
 * The first line of the empty state of a count-only query — one whose node
 * authored `limit: 0`, which the query schema defines as a request for a total
 * without rows. Its sentence is built by {@link emptyStateCopy}, around the total.
 */
const COUNT_ONLY_TITLE = 'Count only';

/** The count-only sentence when the provider reported no total to state. */
const COUNT_ONLY_NO_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';

/**
 * The first line of the empty state of a page that held no rows while the
 * result itself is not known to be empty: a page at or past the end of a
 * counted result, a page the provider left empty below its total, or a later
 * page of a result it did not count. Its sentence is built by
 * {@link emptyStateCopy}, so it can state the position and the total it knows.
 */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The row-level note when the producer bounded a component's per-render list. */
const OCCURRENCES_TRUNCATED_NOTE =
  'Not every render is listed: the per-render list is bounded by the producer.';

/** The expanded row's heading for the list of individual renders. */
const OCCURRENCES_TITLE = 'Individual renders';

/** What the per-render offsets in an expanded row are measured from. */
const OFFSET_NOTE = 'Offsets are measured from this component’s first observed render.';

/** Said when a row carries counts but no per-render list at all. */
const NO_OCCURRENCES_LABEL = 'No individual renders were reported for this component.';

/** The expanded row's heading for the per-key change counts. */
const CHANGED_PROPS_TITLE = 'Changed props';

/**
 * Prefixes a per-name change count in the expanded row, so `key ×4` cannot be
 * misread as part of the prop's name.
 */
const CHANGE_COUNT_PREFIX = '×';

/** What an empty changed-prop list means: nothing was reported, not "nothing changed". */
const NO_CHANGED_PROPS_LABEL = 'No prop changes reported';

/** Stated wherever prop names are shown, so no reader infers that values exist. */
const PROP_VALUES_NOTE = 'Names and change counts only — prop values are never captured.';

/**
 * The disclosure control's name while a row is collapsed — the stem
 * {@link disclosureLabel} completes with the row's component name, so each
 * row's toggle says which component it opens.
 */
const EXPAND_LABEL = 'Show individual renders';

/** The disclosure control's name while a row is open; completed the same way. */
const COLLAPSE_LABEL = 'Hide individual renders';

/**
 * The verb of the control that selects one render as the panel's current
 * evidence. {@link selectOccurrenceLabel} completes it with the component name
 * and the offset the control shows, so the name contains the visible text.
 */
const SELECT_OCCURRENCE_VERB = 'Select';

/** The paging control. */
const LOAD_MORE_LABEL = 'Load more';

/** The paging control's name while the next page is in flight behind the loaded rows. */
const LOADING_MORE_LABEL = 'Loading more…';

/**
 * The sort control's accessible name in the toolbar. Its label is visually
 * hidden, and the name says what it orders, because a panel can hold several
 * tables whose order controls would otherwise all be announced as one word.
 */
const SORT_LABEL = 'Order renders';

/** The toolbar's own accessible name. */
const TOOLBAR_LABEL = 'Render table order';

/*
 * ---------------------------------------------------------------------------
 * Columns
 *
 * The keys are this file's own identifiers for its columns. They double as the
 * `DataTableSort.key` the grid reports back, which is why they are constants
 * rather than inline strings: the sort bindings below and the reverse lookup
 * that maps a header activation onto the query vocabulary both name them, and a
 * typo in one place would silently stop a header from sorting.
 * ---------------------------------------------------------------------------
 */

/** Every column key of this table, in display order. */
const COLUMN_KEYS = Object.freeze({
  component: 'component',
  renderCount: 'renderCount',
  totalDuration: 'totalDurationMs',
  averageDuration: 'averageDurationMs',
  maxDuration: 'maxDurationMs',
  triggers: 'triggers',
  unchanged: 'unchangedRenderCount',
  unknown: 'unknownTriggerCount',
  changedProps: 'changedPropKeys',
  phases: 'phaseCounts',
});

/** The visible header of each column. Generic vocabulary throughout. */
const COLUMN_HEADERS = Object.freeze({
  component: 'Component',
  renderCount: 'Renders',
  totalDuration: 'Total',
  averageDuration: 'Average',
  maxDuration: 'Longest',
  triggers: 'Triggers',
  unchanged: 'Stable inputs',
  unknown: 'Unclassified',
  changedProps: 'Changed props',
  phases: 'Phases',
});

/**
 * The explanation behind each header that needs one.
 *
 * The two that matter most are `unchanged` and `unknown`: they are adjacent
 * columns of similar-looking figures that mean opposite things, so each states
 * its own definition in full rather than relying on the reader inferring the
 * difference from two words.
 */
const COLUMN_TOOLTIPS = Object.freeze({
  triggers: `Renders by trigger, over the whole vocabulary and including the zeros. "${formatRenderTriggerLabel(
    'props',
  )}", "${formatRenderTriggerLabel('state')}" and "${formatRenderTriggerLabel(
    'context',
  )}" name the input that changed; "${formatRenderTriggerLabel(
    'unchanged',
  )}" means all three were evaluated and none changed; "${formatRenderTriggerLabel(
    'unknown',
  )}" means at least one could not be evaluated, so nothing is claimed.`,
  unchanged:
    'Renders where the props, the component’s own hook state and every consumed context value were all evaluated and none of them had changed — work caused by an ancestor rendering.',
  unknown:
    'Renders where at least one of those three inputs could not be evaluated, so nothing is claimed about them. Counted separately and never as a stable-input render.',
  changedProps: `Names of the props observed to change, with a per-name count in the expanded row. ${PROP_VALUES_NOTE}`,
  phases:
    'Renders by commit phase. A phase that was not recorded is in neither bucket, so these may total less than the render count.',
});

/**
 * The width ROLE of each column, keyed like {@link COLUMN_KEYS}.
 *
 * A role names what a column holds, never how wide it is: the primitive
 * resolves each one through `DATA_TABLE_COLUMN_TRACKS` (see
 * `../primitives/DataTable`) to a grid track built from the
 * `--dg-column-min-*` floor and `--dg-column-share-*` share tokens, so this
 * table agrees with every other table on both extension surfaces about how wide
 * a count or a duration is, and no length is chosen here. Each column takes the
 * smallest role whose floor keeps its content readable, in the vocabulary every
 * table shares:
 *
 *   component     text      the identity column: the disclosure toggle, the
 *                           source glyph and the component name, which
 *                           ellipsizes inside the column and never past it. It
 *                           takes `text` rather than the smaller `name` role so
 *                           that it is never narrower than the trigger and
 *                           changed-prop lists: it is what names the row and
 *                           links it to its declaration
 *   renderCount   count     an integer tally with its outlier glyph, sortable
 *   durations     quantity  a formatted duration with its unit (`999.99 ms`)
 *   triggers      text      the trigger histogram: five chips that wrap onto
 *                           as many lines as the column's width needs
 *   unchanged     count     an integer tally
 *   unknown       count     an integer tally — the same role as `unchanged`,
 *                           so the two figure columns read as a pair
 *   changedProps  text      the changed-prop names, which wrap, so the list is
 *                           as tall as the histogram beside it
 *   phases        label     one short phase chip per line
 *
 * Every role has a non-zero floor, and the primitive sums the floors into the
 * grid's own minimum width (`--dgc-min-inline`), so a panel narrower than the
 * sum scrolls the table horizontally with every column still readable, instead
 * of squeezing a column to its padding and painting one cell's content over the
 * next. Once every floor is met, spare width goes mostly to the name, the
 * histogram and the prop list, and barely to a figure column. A token floor and
 * a ratio resolve identically in the header row and in every data row, which is
 * what keeps each column under its own heading (see `../primitives/DataTable`
 * on why an intrinsic track does not).
 */
const COLUMN_WIDTHS = Object.freeze({
  component: 'text',
  renderCount: 'count',
  totalDuration: 'quantity',
  averageDuration: 'quantity',
  maxDuration: 'quantity',
  triggers: 'text',
  unchanged: 'count',
  unknown: 'count',
  changedProps: 'text',
  phases: 'label',
} satisfies Record<keyof typeof COLUMN_KEYS, DataTableColumnWidth>);

/*
 * ---------------------------------------------------------------------------
 * The histograms
 *
 * Both are drawn over their whole vocabulary, zeros included, because an absent
 * chip cannot say which of two things it means — "nothing fell into this
 * bucket" or "this bucket is not shown" — and for the trigger vocabulary those
 * two readings support opposite conclusions.
 *
 * Every list below is therefore accompanied by a compile-time proof that it
 * names the vocabulary in full. The device is the one `../host/PanelActions`
 * uses for its own assignability proof: a type alias whose instantiation fails
 * when the premise stops holding, exported so the compiler keeps it rather than
 * reporting it as unused. A member added to a vocabulary is then a build error
 * in this file — beside the list that has to grow — instead of a bucket that
 * silently stops being drawn.
 * ---------------------------------------------------------------------------
 */

/**
 * Accepts its argument only while it is `never`, which is what turns "this
 * union has no member left over" into a constraint the compiler checks.
 */
type AssertNever<T extends never> = T;

/** The order the five trigger buckets are drawn in: the determinate causes, then the two answers about absence. */
const TRIGGER_DISPLAY_ORDER = Object.freeze([
  'props',
  'state',
  'context',
  'unchanged',
  'unknown',
] as const) satisfies readonly RenderTrigger[];

/**
 * Compile-time proof that {@link TRIGGER_DISPLAY_ORDER} names every member of
 * the trigger vocabulary — the guarantee behind "the histogram prints all five
 * buckets", stated where the list is rather than trusted to review.
 */
export type TriggerDisplayOrderIsTotal = AssertNever<
  Exclude<RenderTrigger, (typeof TRIGGER_DISPLAY_ORDER)[number]>
>;

/**
 * The order the commit phases are drawn in: a first render, then the re-renders
 * that followed it.
 *
 * The phase counts may legitimately total less than the render count — a render
 * whose phase was not recorded belongs to neither bucket — which is what the
 * column's tooltip states rather than papering over.
 */
const PHASE_DISPLAY_ORDER = Object.freeze([
  'mount',
  'update',
] as const) satisfies readonly RenderPhase[];

/** Compile-time proof that {@link PHASE_DISPLAY_ORDER} names every commit phase. */
export type PhaseDisplayOrderIsTotal = AssertNever<
  Exclude<RenderPhase, (typeof PHASE_DISPLAY_ORDER)[number]>
>;

/**
 * The text tone of each bucket's chip, mirroring `RENDER_TRIGGER_TOKEN_KEYS` in
 * `../utils/color`: a changed input is informational, a stable-input render is
 * the actionable warning, and an unclassified render is neutral because it makes
 * no claim. The chip's hairline is taken from that module directly (see
 * {@link TriggerChip}), so the colour decision itself lives in one place and
 * this table only chooses the primitive's tone that matches it.
 */
const TRIGGER_TONES: Readonly<Record<RenderTrigger, BadgeTone>> = Object.freeze({
  props: 'info',
  state: 'info',
  context: 'info',
  unchanged: 'warning',
  unknown: 'neutral',
});

/**
 * The per-bucket variant class. `--unknown` is the one that carries a second,
 * non-colour signal (a dashed hairline), because its distinction from
 * `--unchanged` has to survive a monochrome surface.
 */
const TRIGGER_CLASSES: Readonly<Record<RenderTrigger, string>> = Object.freeze({
  props: 'dg-render-table__trigger--props',
  state: 'dg-render-table__trigger--state',
  context: 'dg-render-table__trigger--context',
  unchanged: 'dg-render-table__trigger--unchanged',
  unknown: 'dg-render-table__trigger--unknown',
});

/*
 * ---------------------------------------------------------------------------
 * Sort
 *
 * One binding per member of the query's sort vocabulary, total by construction
 * so that a change to `DATA_QUERY_SORTS` fails to compile here rather than
 * leaving an order this table cannot request or cannot explain.
 * ---------------------------------------------------------------------------
 */

/** How one member of the sort vocabulary appears in this table. */
interface SortBinding {
  /**
   * The column this order ranks by, or `undefined` when no column of this table
   * shows that quantity.
   *
   * `undefined` is honest rather than a gap: the grid is then told the rows are
   * in the data layer's own order and reports `aria-sort` on no column, while the
   * toolbar's own control still names the order that is applied. Claiming a
   * column the reader cannot see would be worse than claiming none.
   */
  readonly columnKey: string | undefined;

  /** The direction this order actually applies, for the grid's `aria-sort`. */
  readonly direction: DataTableSortDirection;

  /** The order's name in the toolbar control. */
  readonly label: string;
}

/** The sort vocabulary as this table offers it. */
const SORT_BINDINGS: Readonly<Record<DataQuerySort, SortBinding>> = Object.freeze({
  count_desc: {
    columnKey: COLUMN_KEYS.renderCount,
    direction: 'desc',
    label: 'Most renders first',
  },
  duration_desc: {
    columnKey: COLUMN_KEYS.totalDuration,
    direction: 'desc',
    label: 'Longest total time first',
  },
  start_asc: {
    columnKey: undefined,
    direction: 'asc',
    label: 'Earliest first render',
  },
});

/**
 * The order a render table opens in.
 *
 * Counts first, because the question this node answers is "how often", and
 * because the catalog's own description of this node type says to order it by
 * count. An authored `sort` on the node overrides it; so does the toolbar.
 */
const DEFAULT_SORT: DataQuerySort = 'count_desc';

/*
 * ---------------------------------------------------------------------------
 * Presentation bounds
 *
 * Counts, never lengths: nothing below reaches a class, a custom property or a
 * declaration.
 * ---------------------------------------------------------------------------
 */

/**
 * How far above the median of the loaded rows a render count has to be before it
 * is marked as standing out.
 *
 * A multiple of the median rather than an absolute count, because what counts as
 * a lot of renders depends entirely on the interaction: sixty renders is
 * unremarkable in a capture whose median is fifty and is the finding in one whose
 * median is two. The multiple is stated to the reader in the column's tooltip
 * alongside the resolved threshold, so the highlight is an explained heuristic
 * rather than a verdict.
 */
const OUTLIER_MEDIAN_MULTIPLE = 3;

/**
 * The fewest loaded rows a median is computed from.
 *
 * Below it there is no distribution to stand out from — with two rows, one of
 * them is always "above the median" — so no row is marked at all.
 */
const MIN_ROWS_FOR_OUTLIERS = 4;

/** How many prop names a cell shows before the rest are summarised as "+N more". */
const MAX_PROP_KEYS_IN_CELL = 4;

/** How many skeleton rows the loading silhouette draws. A count. */
const LOADING_ROWS = 6;

/** The expansion set of a freshly mounted view: stable, so no render churns on it. */
const NO_EXPANDED_KEYS: readonly string[] = Object.freeze([]);

/**
 * The rows carried before any page has been appended, and the page a resolved
 * empty answer stands for: one frozen empty array, so the rendered row list is a
 * stable value rather than a new array per render.
 */
const NO_ROWS: readonly RenderStat[] = Object.freeze([]);

/*
 * ---------------------------------------------------------------------------
 * Pure helpers
 *
 * All of them total over their inputs, including inputs a schema would have
 * rejected: a fixture, a stored row read back by an older build or a value cast
 * in a consumer can reach a renderer, and a view that threw or printed `NaN` on
 * one would take a panel down or state a number nobody measured.
 * ---------------------------------------------------------------------------
 */

/**
 * The size of every page this view requests — the first and each one "load
 * more" appends. It never changes within a page sequence: paging moves the
 * `offset`, never the `limit`.
 *
 * An omitted or non-finite `limit` takes the contract's default page size. Any
 * other value is floored to whole rows and clamped into
 * `[0, DATA_QUERY_MAX_LIMIT]`.
 *
 * Zero is preserved exactly and sent as `limit: 0`. The query schema accepts it
 * as an explicit request for a total without rows, so raising it to one row
 * would fetch evidence the node never asked for and would turn a count into a
 * one-row table. A count-only sequence never pages (see {@link RenderTableView})
 * and resolves to its own empty state, which reports the total. That state is
 * never the "nothing was captured" sentence. The upper bound is the contract's
 * per-request ceiling and nothing more: it bounds one page, not how far the
 * sequence may reach.
 *
 * @param limit The node's authored limit, if any.
 * @returns A whole row count from zero to the contract's maximum.
 *
 * @example
 * ```ts
 * resolvePageLimit(undefined); // 200 — DATA_QUERY_DEFAULT_LIMIT
 * resolvePageLimit(0); // 0 — count only
 * resolvePageLimit(9_000); // 5000 — DATA_QUERY_MAX_LIMIT
 * ```
 */
function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 0), DATA_QUERY_MAX_LIMIT);
}

/**
 * The position the first page of the sequence starts at.
 *
 * The node's authored `offset` when it is a usable position, the contract's
 * default otherwise. Used only as the reference the first page's `nextOffset` is
 * compared against: the first request itself carries the authored `offset`
 * through untouched — or none at all, so the side that resolves the query applies
 * the default and this view invents nothing on the wire.
 *
 * @param offset The node's authored offset, if any.
 * @returns A whole, non-negative row position.
 */
function resolveBaseOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return DATA_QUERY_DEFAULT_OFFSET;
  }

  return Math.max(Math.floor(offset), DATA_QUERY_DEFAULT_OFFSET);
}

/**
 * The offset "load more" advances to, or `undefined` when the sequence has ended.
 *
 * Only the provider's own `nextOffset` is ever followed. It is never inferred
 * from the length of the page that arrived or from the reported total — either
 * would drift the moment the provider clamped a page, filtered a row or grew the
 * result underneath the reader — and no ceiling of this view's own applies to
 * it, so an offset beyond the 5 000-row page ceiling is requested like any other.
 *
 * `null` and `undefined` both mean "no further page" (a JSON transport can
 * deliver either). A value that is not a whole position, or that does not move
 * past the page it answered, is treated as the end too: following it would
 * re-request a page already on screen, or loop on it.
 *
 * @param nextOffset The provider's reported next offset for the current page.
 * @param currentOffset The offset the current page was requested at.
 * @returns The next page's offset, or `undefined` when there is none.
 */
function advanceOffset(
  nextOffset: number | null | undefined,
  currentOffset: number,
): number | undefined {
  if (nextOffset == null || !Number.isSafeInteger(nextOffset) || nextOffset <= currentOffset) {
    return undefined;
  }

  return nextOffset;
}

/** What an empty state says: an optional first line, then its sentence. */
interface EmptyCopy {
  /** The first line above the sentence, or `undefined` when the sentence stands alone. */
  readonly title: string | undefined;

  /** The sentence itself. */
  readonly message: string;
}

/**
 * The copy of the empty capture — an empty result, the one case that says no
 * renders were captured — as one frozen value, so the empty state recognises
 * it by reference and gives it the view's glyph.
 */
const NOTHING_CAPTURED_COPY: EmptyCopy = Object.freeze({
  title: EMPTY_TITLE,
  message: EMPTY_MESSAGE,
});

/**
 * The noun a count of rows takes in an empty-state sentence.
 *
 * @param count The number of components the sentence states.
 * @returns `component` for exactly one, `components` otherwise — zero included.
 */
function componentNoun(count: number): string {
  return count === 1 ? 'component' : 'components';
}

/**
 * What the empty state says for a resolved sequence that holds no rows at all
 * — nothing carried from an earlier page, nothing on this one — and names no
 * further page to load.
 *
 * An empty page and an empty capture are different answers. The "nothing was
 * captured" sentence is only true when the provider counted the result as empty,
 * or when it reported no count at all for the sequence's first position. In
 * every other case something did match the query. Saying the capture holds
 * nothing would then contradict the total on the same response. So the choice
 * is made in this order, and every branch that knows a positive total states
 * it:
 *
 *   1. `limit: 0` — a count-only query. No rows were requested, so none are
 *      missing. The sentence reports the total, or says no total was reported.
 *   2. A total of zero, or no total with the page at position zero — the result
 *      really is empty, and the node's own sentence says so unchanged.
 *   3. A total, with the page at or past its end — the authored offset (or a
 *      followed one) skipped every row there is.
 *   4. A total, with the page inside it — the provider counted rows it did not
 *      put on this page.
 *   5. No total, with the page past position zero — nothing is known about the
 *      result beyond this page, so only the page is described.
 *
 * A total the contract would reject (negative, fractional or non-finite) is
 * treated as unreported rather than printed, so no branch states a count that
 * nothing measured. Positions are shown 1-based: offset 200 is position 201.
 *
 * @param limit The page size every request of the sequence carries.
 * @param offset The offset the empty page was requested at — the node's
 *        authored base offset for the first page.
 * @param total The provider's reported total, or `undefined` when it gave none.
 * @returns The first line and the sentence to hand `EmptyState`.
 *
 * @example
 * ```ts
 * emptyStateCopy(0, 0, 42).message;
 * // 'This view requests a count without rows: 42 components matched its query.'
 * emptyStateCopy(200, 300, 120).message;
 * // 'This page starts at position 301, past the end of the 120 components that matched this query.'
 * ```
 */
function emptyStateCopy(limit: number, offset: number, total: number | undefined): EmptyCopy {
  const known =
    total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined;

  if (limit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        known === undefined
          ? COUNT_ONLY_NO_TOTAL_MESSAGE
          : `This view requests a count without rows: ${formatCount(known)} ${componentNoun(known)} matched its query.`,
    };
  }

  if (known === 0 || (known === undefined && offset <= 0)) {
    return NOTHING_CAPTURED_COPY;
  }

  if (known === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(offset + 1)} and holds no ${componentNoun(0)}; no total was reported for this query.`,
    };
  }

  if (offset >= known) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCount(known)} ${componentNoun(known)} that matched this query.`,
    };
  }

  return {
    title: EMPTY_PAGE_TITLE,
    message: `${formatCount(known)} ${componentNoun(known)} matched this query, but none are shown on this page.`,
  };
}

/**
 * The rows on screen: every row already loaded, then the page that just
 * resolved, in provider order and de-duplicated by row id.
 *
 * The loaded rows are a frozen earlier answer and are kept exactly as they are —
 * the first row seen for an id wins — so a row that reappears on a later page
 * (the result grew or shifted between two requests) neither moves nor renders
 * twice under one grid key. Nothing is sorted, re-ranked or recomputed: the
 * service ordered both pages, and appending is the whole of the operation.
 *
 * @param loaded The rows accumulated before the current page, already unique.
 * @param page The current page, or `undefined` while it is in flight or failed.
 * @returns The combined rows; `loaded` itself when there is nothing to append.
 */
function appendPage(
  loaded: readonly RenderStat[],
  page: readonly RenderStat[] | undefined,
): readonly RenderStat[] {
  if (page === undefined || page.length === 0) {
    return loaded;
  }

  const seen = new Set<string>(loaded.map((stat) => stat.id));
  const combined: RenderStat[] = [...loaded];

  for (const stat of page) {
    if (seen.has(stat.id)) {
      continue;
    }

    seen.add(stat.id);
    combined.push(stat);
  }

  return combined;
}

/**
 * A stable identity for a query, field by field.
 *
 * Two uses, both of which need the *contents* rather than the object: it keys
 * the view below, so a node pointed at different evidence starts with fresh
 * paging, ordering and expansion instead of carrying the previous query's state
 * onto the new one; and it makes that reset independent of how the query object
 * was built, since a spread, a parse and a literal all produce the same string.
 *
 * Written out rather than serialised wholesale so the result cannot depend on
 * key insertion order, and so a field added to the query vocabulary shows up
 * here as a deliberate decision.
 *
 * @param query The query as the node carries it.
 * @returns A string equal for two queries that request the same page.
 */
function queryIdentity(query: DataQuery): string {
  const filter = query.filter;

  return JSON.stringify([
    query.source,
    query.sort ?? null,
    query.limit ?? null,
    query.offset ?? null,
    filter?.traceId ?? null,
    filter?.kinds ?? null,
    filter?.component ?? null,
    filter?.tier ?? null,
    filter?.minDuration ?? null,
  ]);
}

/**
 * The identity of one page sequence: which node is paging, and the first-page
 * query every later page continues — the node's own query with the source this
 * view forces, the order that is applied and the page size every request
 * carries.
 *
 * Built from the **first** page's query, so the offset of the page in flight is
 * excluded by construction and advancing through the sequence never changes it,
 * while a different node, source, filter, applied order or page size does. The
 * accumulated pages are kept only while this string is unchanged — compared
 * during render, so a re-ordered or re-filtered table discards them in the same
 * render that changed the query rather than one frame later.
 *
 * Takes the node's query and the two applied values rather than the query in
 * flight, so the signature itself names everything a sequence is defined by and
 * no caller can hand it a query that already carries a next page's offset.
 *
 * @param nodeId The id of the node whose pages these are.
 * @param nodeQuery The query as the node carries it.
 * @param sort The order applied to the sequence.
 * @param limit The page size of every request in the sequence.
 * @returns A string equal for two page sequences that continue the same query.
 */
function sequenceIdentity(
  nodeId: string,
  nodeQuery: DataQuery,
  sort: DataQuerySort,
  limit: number,
): string {
  return JSON.stringify([
    nodeId,
    queryIdentity({ ...nodeQuery, source: RENDERS_SOURCE, sort, limit }),
  ]);
}

/**
 * One bucket of a trigger histogram.
 *
 * The aggregate zero-fills every member of the vocabulary, so a missing bucket
 * cannot occur in a validated result — and this returns `0` rather than a
 * not-available label when it does anyway, because a count of zero renders is an
 * observation while "unavailable" would be a claim about the capture.
 *
 * @param histogram The row's trigger histogram.
 * @param trigger The bucket to read.
 * @returns A finite, non-negative count.
 */
function triggerCount(
  histogram: Readonly<Record<RenderTrigger, number>>,
  trigger: RenderTrigger,
): number {
  const value: number | undefined = histogram[trigger];

  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

/**
 * One bucket of a phase histogram, on the same terms as {@link triggerCount}.
 *
 * @param counts The row's phase counts.
 * @param phase The bucket to read.
 * @returns A finite, non-negative count.
 */
function phaseCount(counts: Readonly<Record<RenderPhase, number>>, phase: RenderPhase): number {
  const value: number | undefined = counts[phase];

  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

/**
 * How many renders a prop name was observed to change at.
 *
 * `changedPropCounts` is keyed by exactly the names in `changedPropKeys`, so a
 * miss means the row disagrees with itself; `undefined` is returned rather than
 * `0` so the caller can omit the count instead of printing a zero beside a name
 * that is listed *because* it changed.
 *
 * @param counts The row's per-name counts.
 * @param key The prop name.
 * @returns The count, or `undefined` when the row did not report one.
 */
function changedPropCount(
  counts: Readonly<Record<string, number>>,
  key: string,
): number | undefined {
  const value: number | undefined = counts[key];

  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : undefined;
}

/**
 * The median of a list of counts.
 *
 * @param values The counts, in any order; the input is not mutated.
 * @returns The median, or `undefined` for an empty list.
 */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper: number | undefined = sorted[middle];

  if (upper === undefined) {
    return undefined;
  }

  if (sorted.length % 2 === 1) {
    return upper;
  }

  const lower: number | undefined = sorted[middle - 1];

  return lower === undefined ? upper : (lower + upper) / 2;
}

/**
 * The render count above which a row is marked as standing out, derived from the
 * rows that are actually loaded.
 *
 * `undefined` — no row is marked — whenever the heuristic would be meaningless:
 * too few rows to have a distribution, or a median of zero, where every non-zero
 * count would qualify and the mark would say nothing.
 *
 * @param stats Every row loaded so far — all accumulated pages, not only the
 *        latest one — so the mark describes what the reader has on screen.
 * @returns The threshold, or `undefined` when no row should be marked.
 */
function outlierThreshold(stats: readonly RenderStat[]): number | undefined {
  if (stats.length < MIN_ROWS_FOR_OUTLIERS) {
    return undefined;
  }

  const counts = stats.map((stat) =>
    Number.isFinite(stat.renderCount) ? Math.max(stat.renderCount, 0) : 0,
  );
  const middle = median(counts);

  if (middle === undefined || middle <= 0) {
    return undefined;
  }

  return middle * OUTLIER_MEDIAN_MULTIPLE;
}

/**
 * The query-vocabulary order a grid header activation asks for.
 *
 * The grid reports the column it wants sorted and the direction it would flip
 * to; this maps the column back onto the vocabulary, which offers exactly one
 * direction per key. A column the vocabulary cannot express answers `undefined`
 * and the request is dropped, so the order on screen never disagrees with the
 * order that was applied.
 *
 * @param columnKey The key of the activated column.
 * @returns The matching sort, or `undefined` when no member ranks by it.
 */
function querySortForColumn(columnKey: string): DataQuerySort | undefined {
  return DATA_QUERY_SORTS.find((sort) => SORT_BINDINGS[sort].columnKey === columnKey);
}

/**
 * The sort the grid should report, or `null` for "the data layer's own order".
 *
 * @param sort The order that was applied.
 * @returns The grid's controlled sort state.
 */
function gridSortFor(sort: DataQuerySort): DataTableSort | null {
  const binding = SORT_BINDINGS[sort];

  return binding.columnKey === undefined
    ? null
    : { key: binding.columnKey, direction: binding.direction };
}

/** The toolbar's order options, in the vocabulary's own order. */
function sortOptions(): readonly SelectOption[] {
  return DATA_QUERY_SORTS.map((sort) => ({ value: sort, label: SORT_BINDINGS[sort].label }));
}

/**
 * The name a row's controls identify it by: its component name, exactly as
 * the row's name cell draws it — through the same shared truncation budget —
 * so a reader hears the name a sighted reader sees beside the control.
 *
 * `undefined` for a row whose component name is blank: a name ending in "of"
 * with nothing after it would be worse than the generic stem alone.
 *
 * @param stat The row.
 * @returns The component name as drawn, or `undefined` when there is none.
 */
function rowIdentity(stat: RenderStat): string | undefined {
  return stat.component.trim().length === 0 ? undefined : truncate(stat.component);
}

/**
 * The accessible name of a row's disclosure toggle, which names the row it
 * belongs to: a toggle announced as "Show individual renders" in every row of
 * the grid would not say which component it opens.
 *
 * The toggle is icon-only, so there is no visible label the name must contain;
 * its open state is announced separately, through `aria-expanded`.
 *
 * @param stat The row.
 * @param expanded Whether the row's per-render list is open.
 * @returns The name, built from the row's own data.
 *
 * @example
 * ```ts
 * disclosureLabel(stat, false); // 'Show individual renders of <component>'
 * ```
 */
function disclosureLabel(stat: RenderStat, expanded: boolean): string {
  const stem = expanded ? COLLAPSE_LABEL : EXPAND_LABEL;
  const identity = rowIdentity(stat);

  return identity === undefined ? stem : `${stem} of ${identity}`;
}

/**
 * The accessible name of the control that selects one individual render.
 *
 * It CONTAINS the control's visible text — the offset, verbatim (WCAG 2.5.3,
 * label in name), so a speech-input user can activate the control by saying
 * what it shows — and it names the component the render belongs to, because
 * offsets are measured per component and two open rows can each list a render
 * at the same offset.
 *
 * @param component The component the render belongs to, or `undefined` when
 *        its name is blank (see {@link rowIdentity}).
 * @param offset The offset text the control shows.
 * @returns The name.
 *
 * @example
 * ```ts
 * selectOccurrenceLabel('<component>', '320 ms'); // 'Select <component> render at 320 ms'
 * ```
 */
function selectOccurrenceLabel(component: string | undefined, offset: string): string {
  return component === undefined
    ? `${SELECT_OCCURRENCE_VERB} render at ${offset}`
    : `${SELECT_OCCURRENCE_VERB} ${component} render at ${offset}`;
}

/*
 * ---------------------------------------------------------------------------
 * Parts
 *
 * Declared at module scope, never inside the view: a component created during a
 * render is a new type on every render, so React remounts its subtree and loses
 * its state — which for this file would throw away an open disclosure on every
 * page change. It is also what `react-hooks/static-components` enforces.
 * ---------------------------------------------------------------------------
 */

/** Props of {@link TriggerChip}. */
interface TriggerChipProps {
  /** Which bucket of the trigger vocabulary this chip stands for. */
  readonly trigger: RenderTrigger;

  /**
   * How many renders fell into it, for the histogram form — omitted for the
   * single-render form, where the chip states the trigger of one render and a
   * count of one would be noise.
   */
  readonly count?: number | undefined;

  /**
   * A description to attach through `Tooltip`, for the form that has no column
   * header above it to carry the vocabulary's definitions. Supplying one also
   * makes the chip focusable (`tabIndex={-1}`), because focus is how a keyboard
   * reader opens it: the grid's arrow keys land on it, and it stays out of the
   * Tab order.
   */
  readonly description?: string | undefined;
}

/**
 * One chip of the trigger vocabulary: the bucket's own word, optionally with its
 * count.
 *
 * The word is the vocabulary member verbatim rather than a paraphrase, because
 * the five words are what the metric ids, the analysis and this table all use —
 * and because `unchanged` and `unknown` must read as two different answers at a
 * glance. Three signals carry that difference: the word itself, the tone (the
 * actionable warning against a neutral non-claim) and, for `unknown` alone, a
 * dashed hairline that survives a monochrome surface. The hairline colour comes
 * from `../utils/color`, so this file states no colour of its own.
 *
 * A chip that carries a description is focusable, and never a Tab stop
 * (`tabIndex={-1}`). `Tooltip` opens on focus arriving inside it, so a chip
 * nothing can focus would make its description hover-only; and the chip sits
 * inside the grid, which is one Tab stop whose arrow keys move focus onto the
 * controls of a row and its open detail (`../primitives/DataTable`). An arrow
 * key landing on the chip opens its description exactly as a Tab would, and
 * the first Escape closes the bubble before the second returns to the row.
 * Only the single-render form inside an expanded row carries a description,
 * while the histogram form in every grid row is explained by its column header
 * and is not focusable at all.
 *
 * @param props See {@link TriggerChipProps}.
 * @returns The chip, wrapped in a tooltip when a description was supplied.
 */
function TriggerChip(props: TriggerChipProps): ReactElement {
  const { trigger, count, description } = props;

  const chip = (
    <Badge
      tone={TRIGGER_TONES[trigger]}
      variant="outline"
      color={renderTriggerColorVar(trigger)}
      className={clsx('dg-render-table__trigger', TRIGGER_CLASSES[trigger])}
      data-trigger={trigger}
      tabIndex={description === undefined ? undefined : -1}
    >
      {count === undefined ? trigger : `${trigger} ${formatCount(count)}`}
    </Badge>
  );

  return description === undefined ? chip : <Tooltip content={description}>{chip}</Tooltip>;
}

/** Props of {@link DescribedHeader}. */
interface DescribedHeaderProps {
  /** The column's visible header. */
  readonly label: string;

  /** The definition the header's tooltip carries. */
  readonly description: string;

  /**
   * The header text's place in the Tab order: `-1` while the grid has data
   * rows, `0` while it has none. See {@link DescribedHeader}.
   */
  readonly tabIndex: 0 | -1;
}

/**
 * The header of a column that carries a definition: the header text, as the
 * trigger of a tooltip holding that definition.
 *
 * The text is focusable, because `Tooltip` opens on focus arriving inside it
 * and a trigger nothing can focus is a definition only a pointer can reach —
 * and two of these definitions are what keep `Stable inputs` and
 * `Unclassified` from being read as one figure. It follows the header rule of
 * `../primitives/DataTable`, the same one the grid applies to its own sort
 * buttons: while at least one data row renders, it is
 * `tabIndex={-1}` — the grid is one Tab stop, and ArrowUp from the first row
 * moves onto the header's controls, where ArrowLeft/ArrowRight walk them and
 * the definition opens as focus lands — and while the grid has no row to
 * arrive through, it keeps `tabIndex={0}` so the definition stays reachable.
 *
 * Used only for columns that are **not** sortable. `DataTable` renders a
 * sortable column's header inside its sort `Button`, so a tooltip there would be
 * a focus target nested inside another — focus lands on the button and never on
 * the trigger — and its bubble text would join the button's accessible name.
 *
 * @param props See {@link DescribedHeaderProps}.
 * @returns The focusable header text inside its tooltip.
 */
function DescribedHeader(props: DescribedHeaderProps): ReactElement {
  const { label, description, tabIndex } = props;

  return (
    <Tooltip content={description}>
      <Text as="span" size="sm" weight="medium" tabIndex={tabIndex}>
        {label}
      </Text>
    </Tooltip>
  );
}

/** Props of {@link OccurrenceRow}. */
interface OccurrenceRowProps {
  /** The one render this row stands for. */
  readonly occurrence: RenderOccurrence;

  /** The component's first observed render, which every offset is measured from. */
  readonly originEpochMs: number;

  /**
   * The component this render belongs to, as its row draws it, for the select
   * control's name — or `undefined` when the row's name is blank (see
   * {@link rowIdentity}).
   */
  readonly component: string | undefined;

  /**
   * Selects this render as the panel's current evidence, or `undefined` when no
   * host would handle a selection — in which case the row renders its offset as
   * text rather than as a control that does nothing.
   */
  readonly onSelect?: ((occurrence: RenderOccurrence) => void) | undefined;

  /**
   * Whether this render is the panel's selected event — the shared selection
   * under a panel host, this view's own last selection outside one.
   */
  readonly selected: boolean;
}

/**
 * One observed render inside an expanded row: when it happened, how long it
 * took, which commit phase it was in, what triggered it and where it was
 * declared.
 *
 * The offset is relative to the component's own first observed render rather
 * than a wall-clock time: epoch milliseconds are the product's canonical time
 * base and their text would be noise beside the renders it is being compared
 * with (`../utils/format` makes the same choice for every other view).
 *
 * This is the only item in this view that is one captured event, so it is the
 * only one that offers selection — the aggregate row above it stands for many.
 * The render that is the panel's selected event is marked with the design
 * system's one selected-state class, `dg-is-selected`, on the whole line, and
 * its select control reports `aria-pressed="true"` — so the render a reader
 * picked here, or picked as the same event in any other view, stays marked, and
 * the state is carried by an attribute as well as by a colour.
 *
 * It renders inside the grid's detail row, so every control in it — the select
 * button, the trigger chip and the source chip — is `tabIndex={-1}`: the grid is
 * one Tab stop, and its arrow keys walk the controls of a row and its open
 * detail in document order (`../primitives/DataTable`).
 *
 * @param props See {@link OccurrenceRowProps}.
 * @returns The row.
 */
function OccurrenceRow(props: OccurrenceRowProps): ReactElement {
  const { occurrence, originEpochMs, component, onSelect, selected } = props;

  const offset = formatOffset(occurrence.startTime, originEpochMs);

  return (
    <Stack
      direction="horizontal"
      gap={2}
      align="center"
      wrap
      className={clsx('dg-render-table__occurrence', selected && 'dg-is-selected')}
    >
      {onSelect === undefined ? (
        <Code size="sm" numeric>
          {offset}
        </Code>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          // Built around the very `offset` string the button shows, so the
          // name always contains the visible text.
          aria-label={selectOccurrenceLabel(component, offset)}
          aria-pressed={selected}
          onClick={() => {
            onSelect(occurrence);
          }}
        >
          <Code size="sm" numeric>
            {offset}
          </Code>
        </Button>
      )}
      <DurationCell ms={occurrence.durationMs} severity="auto" size="sm" />
      {occurrence.phase === undefined ? null : (
        <Badge tone="neutral" variant="soft">
          {occurrence.phase}
        </Badge>
      )}
      <TriggerChip
        trigger={occurrence.trigger}
        description={formatRenderTriggerLabel(occurrence.trigger)}
      />
      {occurrence.source === undefined ? null : (
        <SourceLink location={occurrence.source} compact tabIndex={-1} />
      )}
    </Stack>
  );
}

/** Props of {@link RenderDetail}. */
interface RenderDetailProps {
  /** The row being expanded. */
  readonly stat: RenderStat;

  /** Passed through to each {@link OccurrenceRow}; see that component's prop. */
  readonly onSelect?: ((occurrence: RenderOccurrence) => void) | undefined;

  /** Whether one render is the panel's selected event; see {@link OccurrenceRowProps.selected}. */
  readonly isSelected: (occurrence: RenderOccurrence) => boolean;
}

/**
 * The detail of an expanded row: the individual renders behind the count, and
 * the per-name changed-prop counts behind the summary cell.
 *
 * Both lists say what they are bounded by. The render list states how many of
 * the component's renders it holds and, when the producer said its list is
 * incomplete, says so outright — an expansion that silently showed a prefix
 * would invite the reader to count renders that are not there. The prop list
 * states that names and counts are all that exist, so its length is never read
 * as the width of a props object.
 *
 * @param props See {@link RenderDetailProps}.
 * @returns The detail block.
 */
function RenderDetail(props: RenderDetailProps): ReactElement {
  const { stat, onSelect, isSelected } = props;

  const occurrences = stat.occurrences;
  const keys = stat.changedPropKeys;
  const component = rowIdentity(stat);

  return (
    <Stack gap={3} className="dg-render-table__detail">
      <Stack gap={1}>
        <Text as="p" size="sm" weight="medium">
          {OCCURRENCES_TITLE}
        </Text>
        <Text as="p" size="xs" tone="muted">
          {`Listing ${formatCount(occurrences.length)} of ${formatCount(stat.renderCount)} renders. ${OFFSET_NOTE}`}
        </Text>
        {stat.occurrencesTruncated ? (
          <Text as="p" size="xs" tone="warning">
            {OCCURRENCES_TRUNCATED_NOTE}
          </Text>
        ) : null}
        {occurrences.length === 0 ? (
          <Text as="p" size="xs" tone="muted">
            {NO_OCCURRENCES_LABEL}
          </Text>
        ) : (
          occurrences.map((occurrence) => (
            <OccurrenceRow
              key={occurrence.id}
              occurrence={occurrence}
              originEpochMs={stat.firstStartTime}
              component={component}
              onSelect={onSelect}
              selected={isSelected(occurrence)}
            />
          ))
        )}
      </Stack>

      <Stack gap={1}>
        <Text as="p" size="sm" weight="medium">
          {CHANGED_PROPS_TITLE}
        </Text>
        <Text as="p" size="xs" tone="muted">
          {PROP_VALUES_NOTE}
        </Text>
        {keys.length === 0 ? (
          <Text as="p" size="xs" tone="muted">
            {NO_CHANGED_PROPS_LABEL}
          </Text>
        ) : (
          <Stack
            direction="horizontal"
            gap={1}
            align="center"
            wrap
            className="dg-render-table__changed-props"
          >
            {keys.map((key) => {
              const count = changedPropCount(stat.changedPropCounts, key);

              return (
                <Code key={key} size="sm">
                  {count === undefined
                    ? truncate(key)
                    : `${truncate(key)} ${CHANGE_COUNT_PREFIX}${formatCount(count)}`}
                </Code>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

/** Props of {@link RenderTableShell}. */
interface RenderTableShellProps {
  /** The caller's extra classes, composed after this component's own. */
  readonly className?: string | undefined;

  /** The state or the table this block holds. */
  readonly children: ReactNode;
}

/**
 * The block every state of this view renders inside: one column whose spacing
 * comes from `Stack` and whose behaviour comes from the `dg-render-table` rule,
 * so a loading silhouette, a failure, an empty sentence and the table all sit in
 * the same box and the caller's `className` applies to all four.
 *
 * @param props See {@link RenderTableShellProps}.
 * @returns The block element.
 */
function RenderTableShell(props: RenderTableShellProps): ReactElement {
  const { className, children } = props;

  return (
    <Stack gap={2} className={clsx('dg-render-table', className)}>
      {children}
    </Stack>
  );
}

/** Props of {@link RenderTableZeroRows}. */
interface RenderTableZeroRowsProps {
  /** The status of the page in flight, as `../host/useQuery` reports it. */
  readonly status: 'loading' | 'error' | 'success';

  /**
   * The three members of the hook's result that describe a failure — the
   * error, the politeness it settled with and the retry that re-requests
   * exactly {@link RenderTableZeroRowsProps.query} — handed as they are to
   * `queryFailureProps`, the one failure contract every query-backed node
   * shares. Read only while `status` is `"error"`.
   */
  readonly failure: Pick<UseQueryResult<unknown>, 'error' | 'announcement' | 'retry'>;

  /** The query of the page in flight, which the failure state shows as it was asked. */
  readonly query: DataQuery;

  /**
   * Whether the resolved page, although it held no rows, named a next page past
   * the offset it was requested at. Only that page is then described, because
   * the rows after it are still reachable.
   */
  readonly pageContinues: boolean;

  /** What a resolved sequence with no rows and no next page says it is. */
  readonly emptyCopy: EmptyCopy;
}

/**
 * What stands in for the rows while none are on screen, in precedence: the
 * page still resolving (a row silhouette), the page failing (the shared
 * failure contract of `../host/useQuery`: its title, the generic lead and the
 * provider's cause, the failing query and a working retry), an empty page that
 * names a next page (a sentence about that page alone) and a resolved sequence
 * with no rows at all (the copy {@link emptyStateCopy} chose, with the view's
 * glyph only for the empty capture). Never a blank area, and never a failure
 * dressed as a result.
 *
 * One definition serves both places the state is drawn — alone in the block
 * for the first answer, and in the grid's empty slot beneath a header that
 * stays mounted once the reader has chosen an order (see
 * {@link RenderTableView}) — so the two can never word, class or retry a state
 * differently.
 *
 * @param props See {@link RenderTableZeroRowsProps}.
 * @returns The state element.
 */
function RenderTableZeroRows(props: RenderTableZeroRowsProps): ReactElement {
  const { status, failure, query, pageContinues, emptyCopy } = props;

  if (status === 'loading') {
    return (
      <LoadingState
        variant="rows"
        rows={LOADING_ROWS}
        label={LOADING_LABEL}
        className="dg-render-table__loading"
      />
    );
  }

  if (status === 'error') {
    // The first page of the sequence failed — a failed next page keeps the
    // loaded rows and is reported beneath them instead (see the end of
    // {@link RenderTableView}). Both go through the shared contract, with the
    // query exactly as it was asked.
    return <ErrorState {...queryFailureProps(failure, query)} className="dg-render-table__error" />;
  }

  if (pageContinues) {
    return <EmptyState message={EMPTY_PAGE_MESSAGE} className="dg-render-table__empty" />;
  }

  // Only the empty capture carries the view's glyph: every other empty answer
  // is a statement about a page or a count, not about what was captured.
  return (
    <EmptyState
      title={emptyCopy.title}
      message={emptyCopy.message}
      icon={emptyCopy === NOTHING_CAPTURED_COPY ? <Layers className="dg-icon" /> : undefined}
      className="dg-render-table__empty"
    />
  );
}

/*
 * ---------------------------------------------------------------------------
 * Columns
 * ---------------------------------------------------------------------------
 */

/** What the column definitions need from the view that renders them. */
interface ColumnContext {
  /**
   * The render count above which a row is marked, or `undefined` when no row is
   * marked. Derived from every accumulated page, so it moves as more rows load —
   * which is why the mark states the resolved threshold rather than implying a
   * standing rule.
   */
  readonly markAbove: number | undefined;

  /**
   * Whether the grid renders at least one data row, which decides the Tab index
   * of the header's own definition triggers: `-1` while rows exist, when ArrowUp
   * from the first row reaches them, and `0` while there is no row to arrive
   * through (see {@link DescribedHeader}).
   */
  readonly hasRows: boolean;

  /** Opens or closes a row's per-render list. */
  readonly onToggle: (stat: RenderStat) => void;
}

/**
 * The columns of this table, left to right.
 *
 * Every field read below is one the node catalog declares for this node type
 * (`catalogEntryFor('renderTable').reads`: span identity, timing and taxonomy
 * fields, `parentSpanId` and `source` when present, and six render attribute
 * keys — `component`, `phase`, `renderCount`, `changedProps`, `trigger` and
 * `actualDuration`), and the
 * aggregate that answers the `renders` source is where those fields are already
 * folded into per-component rows.
 *
 * Two of the ten columns exist for one reason, and it is the reason this whole
 * view is evidence rather than a chart: `Stable inputs` and `Unclassified` are
 * separate columns, with separate headers and separate definitions, because the
 * counts behind them mean opposite things. Nothing in this function combines
 * them, and the histogram beside them prints all five buckets — zeros included —
 * so a bucket can never be inferred from the absence of a chip.
 *
 * Every column's width is its role in {@link COLUMN_WIDTHS}, which the
 * primitive resolves to a token-built track: a floor that keeps the column's
 * content readable, and a ratio for the spare width. No column can be squeezed
 * below its floor, so a narrow panel scrolls the table horizontally rather than
 * collapsing a column and overprinting its neighbour.
 *
 * The component name IS the row's link to its declaration, and so the row's
 * `onOpenSource` control: when the row resolved to a location the name is
 * drawn as a `./SourceLink` captioned with the name and handed that very
 * location, so there is one source control per row and the reader clicks the
 * name itself. A row that resolved to no location draws the name as text.
 * Either way the name ellipsizes inside its column rather than overprinting the
 * next one, and a tooltip keeps it readable: an unlinked name's tooltip is the
 * whole name, and a linked name's is the link's own — the declared symbol and
 * the full location.
 *
 * Every description and every control is reachable from the keyboard, and
 * none of them adds a Tab stop: the grid is ONE stop, its active row, and
 * `../primitives/DataTable`'s arrow keys move focus onto everything else. So
 * every focusable element a cell renders — the disclosure toggle, the source
 * chip, the full name of a component with no location, a marked count figure —
 * is `tabIndex={-1}`, and so are the header's
 * definition triggers while rows exist ({@link DescribedHeader}), which
 * ArrowUp from the first row reaches as it does the grid's own sort buttons.
 * A header definition only ever sits on a column that is not sortable, so no
 * tooltip is nested inside a sort button; the two sortable columns carry
 * plain-text headers. `Tooltip` opens on any focus, so each description opens
 * the moment an arrow key lands on its trigger.
 *
 * @param context See {@link ColumnContext}.
 * @returns The column definitions.
 */
function buildColumns(context: ColumnContext): readonly DataTableColumn<RenderStat>[] {
  const { markAbove, hasRows, onToggle } = context;

  // The header's definition triggers follow the grid's own rule for its sort
  // buttons: out of the Tab order while the body has a row to arrive through.
  const headerTabIndex = hasRows ? -1 : 0;

  return [
    {
      key: COLUMN_KEYS.component,
      header: COLUMN_HEADERS.component,
      rowHeader: true,
      width: COLUMN_WIDTHS.component,
      cell: (stat, _rowIndex, meta) => {
        // The grid's own record of this row's disclosure, rather than a second
        // lookup of the expansion set: `meta.expanded` is the state the grid
        // rendered the detail row from, and `meta.detailRowId` is that detail
        // row's id, defined only while it is in the document. The disclosure
        // pattern puts both on the toggle, because a `grid` row may not carry
        // `aria-expanded` (see `../primitives/DataTable`).
        const expanded = meta.expanded;

        // The name as every surface of this cell shows it — the caption, the
        // unlinked name's tooltip, the row header's escort: bounded by the
        // shared preview budget, which no real component name reaches, and
        // otherwise whole. The column's width clips it visually only, with an
        // ellipsis; no layout concern shortens the text itself.
        const name = truncate(stat.component);

        return (
          <Stack direction="horizontal" gap={1} align="center">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tabIndex={-1}
              aria-label={disclosureLabel(stat, expanded)}
              aria-expanded={expanded}
              aria-controls={meta.detailRowId}
              icon={
                expanded ? (
                  <ChevronDown className="dg-icon" />
                ) : (
                  <ChevronRight className="dg-icon" />
                )
              }
              onClick={() => {
                onToggle(stat);
              }}
            />
            {stat.source === undefined ? (
              // No location: the name is a label, and its tooltip is what makes
              // an ellipsized name readable. The text is the tooltip's trigger,
              // so it takes focus — as `tabIndex={-1}` in every row, never a Tab
              // stop, exactly like the outlier figure: the grid's arrow keys
              // land on it and open the tooltip.
              <Tooltip content={name}>
                <Text
                  as="span"
                  size="sm"
                  truncate
                  className="dg-render-table__component-cell"
                  tabIndex={-1}
                >
                  {name}
                </Text>
              </Tooltip>
            ) : (
              // The name itself is the control. `stat.source` is handed over by
              // reference, and the chip's own tooltip names the symbol and the
              // full location whenever the caption stands in for them. Its
              // accessible name leads with the name it shows and ends with the
              // location it opens (`sourceLinkAccessibleName`), so the row
              // header a screen reader announces for every cell carries the
              // component without a second, hidden copy of it.
              <SourceLink
                location={stat.source}
                label={name}
                compact
                tabIndex={-1}
                className="dg-render-table__component-cell"
              />
            )}
          </Stack>
        );
      },
    },
    {
      key: COLUMN_KEYS.renderCount,
      header: COLUMN_HEADERS.renderCount,
      align: 'end',
      width: COLUMN_WIDTHS.renderCount,
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (stat) => {
        // A mark is only ever applied against a threshold that exists, and the
        // threshold is stated where the mark is: the glyph and the tooltip are
        // what keep the highlight from being carried by colour alone, and from
        // reading as a verdict rather than as the explained heuristic it is.
        const marked = markAbove !== undefined && stat.renderCount > markAbove;

        // A marked figure is its tooltip's trigger, so it must take focus for
        // the explanation to reach a keyboard reader — as `tabIndex={-1}`, never
        // a Tab stop: the grid's arrow keys land on it and open the explanation,
        // and a pointer click that focuses it moves the grid's roving stop to
        // its row, where the grid answers the arrow keys on the figure too. An
        // unmarked figure explains nothing and takes no focus at all, so the
        // body never grows a stop per row.
        const figure = (
          <Text
            as="span"
            size="sm"
            numeric
            className={clsx('dg-render-table__count-cell', marked && 'dg-is-outlier')}
            tabIndex={marked ? -1 : undefined}
          >
            {formatCount(stat.renderCount)}
            {marked ? <TriangleAlert aria-hidden="true" className="dg-icon" /> : null}
          </Text>
        );

        return marked && markAbove !== undefined ? (
          <Tooltip
            content={`More than ${formatCount(markAbove)} renders — over ${String(
              OUTLIER_MEDIAN_MULTIPLE,
            )}× the median of the loaded rows.`}
          >
            {figure}
          </Tooltip>
        ) : (
          figure
        );
      },
    },
    {
      key: COLUMN_KEYS.totalDuration,
      header: COLUMN_HEADERS.totalDuration,
      align: 'end',
      width: COLUMN_WIDTHS.totalDuration,
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (stat) => <DurationCell ms={stat.totalDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.averageDuration,
      header: COLUMN_HEADERS.averageDuration,
      align: 'end',
      width: COLUMN_WIDTHS.averageDuration,
      cell: (stat) => <DurationCell ms={stat.averageDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.maxDuration,
      header: COLUMN_HEADERS.maxDuration,
      align: 'end',
      width: COLUMN_WIDTHS.maxDuration,
      cell: (stat) => <DurationCell ms={stat.maxDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.triggers,
      header: (
        <DescribedHeader
          label={COLUMN_HEADERS.triggers}
          description={COLUMN_TOOLTIPS.triggers}
          tabIndex={headerTabIndex}
        />
      ),
      headerLabel: COLUMN_HEADERS.triggers,
      width: COLUMN_WIDTHS.triggers,
      cell: (stat) => (
        <Stack direction="horizontal" gap={1} align="center" wrap>
          {TRIGGER_DISPLAY_ORDER.map((trigger) => (
            <TriggerChip
              key={trigger}
              trigger={trigger}
              count={triggerCount(stat.triggers, trigger)}
            />
          ))}
        </Stack>
      ),
    },
    {
      key: COLUMN_KEYS.unchanged,
      header: (
        <DescribedHeader
          label={COLUMN_HEADERS.unchanged}
          description={COLUMN_TOOLTIPS.unchanged}
          tabIndex={headerTabIndex}
        />
      ),
      headerLabel: COLUMN_HEADERS.unchanged,
      align: 'end',
      width: COLUMN_WIDTHS.unchanged,
      cell: (stat) => (
        <Text as="span" size="sm" numeric className="dg-render-table__count-cell">
          {formatCount(stat.unchangedRenderCount)}
        </Text>
      ),
    },
    {
      key: COLUMN_KEYS.unknown,
      header: (
        <DescribedHeader
          label={COLUMN_HEADERS.unknown}
          description={COLUMN_TOOLTIPS.unknown}
          tabIndex={headerTabIndex}
        />
      ),
      headerLabel: COLUMN_HEADERS.unknown,
      align: 'end',
      width: COLUMN_WIDTHS.unknown,
      cell: (stat) => (
        <Text as="span" size="sm" numeric className="dg-render-table__count-cell">
          {formatCount(stat.unknownTriggerCount)}
        </Text>
      ),
    },
    {
      key: COLUMN_KEYS.changedProps,
      header: (
        <DescribedHeader
          label={COLUMN_HEADERS.changedProps}
          description={COLUMN_TOOLTIPS.changedProps}
          tabIndex={headerTabIndex}
        />
      ),
      headerLabel: COLUMN_HEADERS.changedProps,
      width: COLUMN_WIDTHS.changedProps,
      cell: (stat) => {
        const keys = stat.changedPropKeys;

        if (keys.length === 0) {
          return (
            <Text as="span" size="xs" tone="muted">
              {NO_CHANGED_PROPS_LABEL}
            </Text>
          );
        }

        // The producer caps how many names it tracks, so this cell caps only how
        // many of the names that ARRIVED it draws: the remainder is counted, not
        // hidden, and the expanded row lists every one of them with its count.
        const shown = keys.slice(0, MAX_PROP_KEYS_IN_CELL);
        const remaining = keys.length - shown.length;

        return (
          <Stack
            direction="horizontal"
            gap={1}
            align="center"
            wrap
            className="dg-render-table__changed-props"
          >
            {shown.map((key) => (
              <Code key={key} size="sm">
                {truncate(key)}
              </Code>
            ))}
            {remaining > 0 ? (
              <Badge tone="neutral" variant="soft">
                {`+${formatCount(remaining)} more`}
              </Badge>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: COLUMN_KEYS.phases,
      header: (
        <DescribedHeader
          label={COLUMN_HEADERS.phases}
          description={COLUMN_TOOLTIPS.phases}
          tabIndex={headerTabIndex}
        />
      ),
      headerLabel: COLUMN_HEADERS.phases,
      width: COLUMN_WIDTHS.phases,
      cell: (stat) => (
        <Stack direction="horizontal" gap={1} align="center" wrap>
          {PHASE_DISPLAY_ORDER.map((phase) => (
            <Badge key={phase} tone="neutral" variant="soft">
              {`${phase} ${formatCount(phaseCount(stat.phaseCounts, phase))}`}
            </Badge>
          ))}
        </Stack>
      ),
    },
  ];
}

/*
 * ---------------------------------------------------------------------------
 * Paging state
 * ---------------------------------------------------------------------------
 */

/**
 * The pages already loaded for one page sequence, and the page being loaded
 * next.
 *
 * Written **only** by the "load more" handler and cleared only by a sort change,
 * which is what keeps this view free of state written from an effect: at the
 * moment of the click the rows on screen, the provider's `nextOffset` and the
 * total it last reported are all in hand, so the accumulator is complete before
 * the next page is even requested. Nothing here is derived after the fact.
 *
 * `identity` is {@link sequenceIdentity} of the sequence these pages belong to.
 * Comparing it during render is how a stale accumulator is ignored — again with
 * no effect, and no chance of one render drawing rows from two different queries.
 */
interface PageAccumulator {
  /** The sequence these pages belong to; the in-flight offset is not part of it. */
  readonly identity: string;

  /** Every row loaded before the page in flight, in provider order, unique by id. */
  readonly rows: readonly RenderStat[];

  /** The offset of the page in flight: the `nextOffset` the previous page reported. */
  readonly offset: number;

  /**
   * The total the provider last reported, carried across the request so the
   * footer does not lose it while the next page is in flight and momentarily
   * claim the total was never reported.
   */
  readonly total: number | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * The props of {@link RenderTable}.
 *
 * Two, and no more: the node carries everything this view draws — its identity
 * for the interaction callbacks, its optional labels for the surface above it,
 * and the query that resolves its evidence — so there is no data prop, no
 * provider prop and no callback prop. The host mounts a `DataProvider` and a
 * `PanelActions` once, around the whole panel.
 *
 * `className` spells `| undefined` because `exactOptionalPropertyTypes` is in
 * force repository-wide and the node renderer forwards a value it may not have.
 */
export interface RenderTableProps {
  /** The validated `renderTable` node this component renders. */
  readonly node: RenderTableNode;

  /** Extra classes, composed after this component's own. */
  readonly className?: string | undefined;
}

/**
 * Per-component render statistics for one capture.
 *
 * ## Why this is two components
 *
 * Everything this view holds locally — which pages it has loaded, which order
 * the reader chose, which rows are open — belongs to **one** query. When
 * the node's query changes, all three have to go back to their initial values,
 * and the way to do that without writing state from an effect (which
 * `eslint-plugin-react-hooks` rejects, and rightly: it is a second render pass
 * that paints stale rows first) or resetting each field by hand is to let React
 * discard the state with the instance. So the exported component computes the
 * query's identity and renders the view under it as a `key`; the view below
 * holds the state and knows nothing about resets.
 *
 * The identity is the query's *contents*, so a node re-parsed, re-spread or
 * rebuilt into a fresh object with the same fields keeps its pages and its open
 * rows — only a genuinely different request starts over.
 *
 * The key also carries the generation of the ambient `DataProvider` (see
 * {@link useProviderGeneration}). A host that rebinds a mounted panel to
 * another session swaps the provider without remounting the node, and the
 * same layout path and query can recur in that session's panel; the pages,
 * the next offset and the open rows loaded from the previous provider must
 * not survive into it, so a new provider is a new instance that paints none
 * of them and starts from the authored first page.
 *
 * @param props See {@link RenderTableProps}.
 * @returns The block, in whichever of its four states applies.
 *
 * @example The whole of a node renderer's call.
 * ```tsx
 * <RenderTable node={node} />
 * ```
 */
export function RenderTable(props: RenderTableProps): ReactElement {
  const { node, className } = props;
  const providerGeneration = useProviderGeneration();

  return (
    <RenderTableView
      key={`${String(providerGeneration)}|${queryIdentity(node.query)}`}
      node={node}
      className={className}
    />
  );
}

/** The provider a view was last rendered under, and how many it has seen. */
interface ProviderBinding {
  /** The ambient `DataProvider` of the latest render. */
  readonly provider: DataProvider | undefined;

  /** Incremented each time that provider is replaced by a different one. */
  readonly generation: number;
}

/**
 * A number that changes exactly when the ambient `DataProvider` is replaced.
 *
 * Used as part of the stateful view's `key`, so the state that belongs to one
 * provider's data — accumulated pages, the next offset, the open rows —
 * is discarded with the instance instead of being carried into another's. The
 * binding is adjusted during render, React's documented pattern for state that
 * follows a changed input: the replaced render is discarded before commit, so
 * nothing loaded from the previous provider is ever painted under the new one.
 * Compared by reference, which is what a provider's identity is: a host
 * creates one per session.
 *
 * @returns The current provider's generation.
 */
function useProviderGeneration(): number {
  const provider = useDataProvider();
  const [binding, setBinding] = useState<ProviderBinding>(() => ({ provider, generation: 0 }));

  if (binding.provider !== provider) {
    const next: ProviderBinding = { provider, generation: binding.generation + 1 };
    setBinding(next);
    return next.generation;
  }

  return binding.generation;
}

/**
 * The stateful half of {@link RenderTable}: resolves the pages, draws them, and
 * owns the paging, ordering and disclosure of one query.
 *
 * ## One Tab stop, and the grid's keys for everything inside it
 *
 * The keyboard model is `../primitives/DataTable`'s, taken whole: the grid is a
 * single Tab stop — its active row — and every control this view renders into
 * a cell, into an open detail row or into the header is `tabIndex={-1}` (see
 * {@link buildColumns} and {@link OccurrenceRow}). From the row, ArrowRight
 * opens a collapsed row's per-render list and the next ArrowRight moves onto
 * the row's first control; ArrowLeft/ArrowRight, Home and End walk the
 * controls of the row and its open detail; ArrowUp from the first row reaches
 * the header's sort buttons and definition triggers; Escape returns to the row
 * (after first closing an open description). Focus landing on a control, by
 * key or by pointer, moves the roving stop to that control's row, so Tab back
 * into the grid returns where the reader last was. This view keeps no focus
 * state of its own: every one of those behaviours is the primitive's.
 *
 * ## The controls the reader is using stay mounted
 *
 * A new order is a new page sequence, so choosing one releases every loaded
 * row and the next render has none to draw while the new first page resolves.
 * Before the reader has chosen an order, that zero-row moment is the block's
 * own state, alone. After it, the same state is handed to the grid's `empty`
 * slot, which `../primitives/DataTable` renders outside the grid with the
 * header still mounted, and the toolbar keeps its place above it. Both
 * elements therefore keep their DOM identity — the `<select>` the reader just
 * changed, or the header button they just activated, is still the focused
 * element while the re-query loads, if it fails, and after its rows arrive. The
 * outer `key` does not take part: the reader's order is state of this instance,
 * never part of the node's query identity.
 *
 * @param props The same props as {@link RenderTable}.
 * @returns The block, in whichever of its four states applies.
 */
function RenderTableView(props: RenderTableProps): ReactElement {
  const { node, className } = props;

  // Absent outside a host, by that module's documented contract — which is why
  // every use below is optional-chained and why a missing host degrades to a
  // view that draws everything and reports nothing.
  const actions = usePanelActions();

  // The event the panel has selected: the host's shared selection, or this
  // view's own last one when no host is mounted. An individual render is the
  // only item here that can stand for it, so it is the only item marked.
  const { selection, markSelected } = useViewSelection();

  const [chosenSort, setChosenSort] = useState<DataQuerySort | undefined>(undefined);
  const [pages, setPages] = useState<PageAccumulator | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<readonly string[]>(NO_EXPANDED_KEYS);

  // The size of every page in the sequence, and where its first page starts.
  // Neither moves while the reader pages: "load more" advances the offset only.
  // Declared after the state hooks on purpose: the React Compiler cannot see
  // that these helpers return plain numbers, and a value it must treat as
  // mutable across a `useState` call costs every memoized callback below.
  const pageLimit = resolvePageLimit(node.query.limit);
  const baseOffset = resolveBaseOffset(node.query.offset);

  // The reader's choice wins over the authored order, which wins over this
  // view's default. Only one of the three is ever applied, and it is the one the
  // grid and the toolbar both report.
  const appliedSort: DataQuerySort = chosenSort ?? node.query.sort ?? DEFAULT_SORT;

  // Rebuilt every render on purpose: `useQuery` compares a query by content, so
  // a stable identity buys nothing and memoizing it would only add a way for the
  // resolved page and the requested page to disagree. The authored filter and
  // offset pass through untouched; the source is forced to the one source this
  // component can draw (see RENDERS_SOURCE).
  const firstPageQuery: DataQuery & { source: typeof RENDERS_SOURCE } = {
    ...node.query,
    source: RENDERS_SOURCE,
    sort: appliedSort,
    limit: pageLimit,
  };

  // Accumulated pages count only while they belong to the sequence being drawn.
  // Compared during render, so a changed order or filter can never show the
  // previous sequence's rows, not even for one frame.
  const identity = sequenceIdentity(node.id, node.query, appliedSort, pageLimit);
  const activePages = pages !== undefined && pages.identity === identity ? pages : undefined;
  const currentOffset = activePages?.offset ?? baseOffset;

  // The page in flight: the first page, or the same query moved to the offset
  // the previous page reported. Nothing else about the query ever changes.
  const query: DataQuery & { source: typeof RENDERS_SOURCE } =
    activePages === undefined ? firstPageQuery : { ...firstPageQuery, offset: activePages.offset };

  const { status, data, error, announcement, total, nextOffset, retry } = useQuery(query);

  // The page that resolved, or `undefined` while it is in flight or has failed.
  const pageRows = status === 'success' ? (data ?? NO_ROWS) : undefined;
  const carriedRows = activePages?.rows ?? NO_ROWS;

  // Frozen earlier pages first, then the page that just arrived, unique by the
  // grid's row key. Memoized so the grid receives one stable array per answer
  // rather than a fresh copy of every loaded row on every render.
  const rows = useMemo(() => appendPage(carriedRows, pageRows), [carriedRows, pageRows]);

  // The provider's total, or the one it reported last while the next page is
  // in flight — so the footer never drops a total it was already told.
  const knownTotal = total ?? activePages?.total;

  // Where "load more" would go, read off the provider's `nextOffset` alone and
  // only once the current page has resolved. `undefined` is the end of the data.
  // A count-only sequence (`limit: 0`) never advances: every page of it holds
  // no rows by request, so a next page could only repeat the count, and a
  // provider that echoes the offset it was asked at would otherwise offer a
  // control that re-requests the same empty page forever.
  const followingOffset =
    status === 'success' && pageLimit > 0 ? advanceOffset(nextOffset, currentOffset) : undefined;

  // What the empty state would say, drawn only when the sequence resolves with
  // no rows and no next page (see the end of this function). Computed here,
  // before the memoized callbacks, on purpose: the React Compiler cannot see
  // that the helper only reads its arguments, and a call placed after them
  // would extend the mutable range of the page size — and of the sequence
  // identity built from it — past the callbacks that depend on them, costing
  // those callbacks their memoization.
  const emptyCopy = emptyStateCopy(pageLimit, currentOffset, knownTotal);

  const handleGridSort = useCallback(
    (next: DataTableSort): void => {
      // The grid asks by column; the vocabulary answers by order. A column no
      // member ranks by is dropped rather than approximated, so the order shown
      // is always the order applied.
      const mapped = querySortForColumn(next.key);

      if (mapped === undefined) {
        return;
      }

      // A new order is a new page sequence: rows accumulated under the old one
      // describe a different ranking and are released here. Re-activating the
      // order already applied keeps the pages the reader has loaded.
      if (mapped !== appliedSort) {
        setPages(undefined);
      }

      setChosenSort(mapped);
      actions?.onFilterChange?.(node.id, { sort: mapped });
    },
    [actions, appliedSort, node.id],
  );

  const handleSortSelect = useCallback(
    (value: string): void => {
      // The control's options come from the vocabulary, so this only rejects a
      // value that never belonged to it — a stale option in a host that kept one.
      if (!isDataQuerySort(value)) {
        return;
      }

      // The same release as a header activation: the toolbar is the second way
      // to express one intent, and it starts the same new sequence.
      if (value !== appliedSort) {
        setPages(undefined);
      }

      setChosenSort(value);
      actions?.onFilterChange?.(node.id, { sort: value });
    },
    [actions, appliedSort, node.id],
  );

  const handleLoadMore = useCallback((): void => {
    // Only a resolved page with a provider-reported next offset can be advanced
    // from. The rows on screen — every earlier page plus this one — are frozen
    // into the accumulator, and the next request starts exactly where the
    // provider said the next page begins.
    if (followingOffset === undefined) {
      return;
    }

    setPages({ identity, rows, offset: followingOffset, total: knownTotal });
  }, [followingOffset, identity, knownTotal, rows]);

  const handleToggle = useCallback(
    (stat: RenderStat): void => {
      // The next state is computed here rather than inside the updater: an
      // updater must be pure, and the host has to be told the state the gesture
      // produced — exactly once, whatever React does with the render.
      const opening = !expandedKeys.includes(stat.id);

      setExpandedKeys(
        opening ? [...expandedKeys, stat.id] : expandedKeys.filter((key) => key !== stat.id),
      );
      actions?.onExpand?.(node.id, stat.id, opening);
    },
    [actions, expandedKeys, node.id],
  );

  const handleSelectOccurrence = useCallback(
    (occurrence: RenderOccurrence): void => {
      // Every coordinate here is the occurrence's own. Nothing is synthesised:
      // the aggregate row above it has no event id, which is why the row itself
      // raises no selection at all.
      const ref: PanelEventRef = {
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      };

      // Recorded here only when no host is mounted (a no-op under one, whose
      // own record of the report below is what every view then marks).
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  // Whether an individual render stands for the selected event. The occurrence
  // carries its own id, trace and span, so it is matched as it is, with no
  // pointer built per row.
  const isOccurrenceSelected = useCallback(
    (occurrence: RenderOccurrence): boolean => matchesPanelSelection(selection, occurrence),
    [selection],
  );

  // Over every accumulated row, so the mark describes what the reader has on
  // screen; memoized because it sorts the counts, and the rows only change when
  // a page arrives.
  const markAbove = useMemo(() => outlierThreshold(rows), [rows]);

  // Nothing is on screen: the page in flight is the first of its sequence, or
  // it failed, or it resolved with no rows. A next page in flight or failed
  // behind loaded rows never reaches this — the rows stay where the reader is
  // reading and the footer reports the request instead. `followingOffset` is
  // never set for a count-only sequence or for a `nextOffset` that does not
  // move forward, so an empty page that names one keeps the rows after it
  // reachable: it is reported as an empty page — never an empty capture — and
  // the paging control is offered exactly as under a full page.
  const zeroRowState =
    rows.length === 0 ? (
      <RenderTableZeroRows
        status={status}
        failure={{ error, announcement, retry }}
        query={query}
        pageContinues={followingOffset !== undefined}
        emptyCopy={emptyCopy}
      />
    ) : undefined;

  // A next page behind rows already on screen, in flight or failed. Both are
  // reported where the paging control is, never by replacing what the reader is
  // reading. With no row on screen the page in flight is a first page, whose
  // loading and failure are the zero-row state above rather than the footer's.
  const appending = status === 'loading' && rows.length > 0;
  const pageFailed = status === 'error' && rows.length > 0;

  // `followingOffset` is the provider's own answer about whether more rows
  // exist; it is never inferred from the length of what arrived or from the
  // total, which would drift the moment a limit was clamped. While the next page
  // is in flight the control stays in place, disabled and saying so.
  const showLoadMore = followingOffset !== undefined || appending;

  // The paging line belongs to rows on screen, and to an empty page that names
  // a next page; a first page that is loading, failed or empty has nothing to
  // count and nothing to follow.
  const showFooter = rows.length > 0 || followingOffset !== undefined;

  const loadedText =
    knownTotal === undefined
      ? `${formatCount(rows.length)} components loaded.`
      : `Showing ${formatCount(rows.length)} of ${formatCount(knownTotal)} components.`;

  const footer = showFooter ? (
    <Stack
      direction="horizontal"
      gap={2}
      align="center"
      justify="between"
      wrap
      className="dg-data-table__footer"
    >
      {/* A polite live region, read whole: a page appended by "load more"
          changes the count, and a reader who pressed the control hears how
          much of the result is now on screen without leaving it. */}
      <Text as="p" size="xs" tone="muted" aria-live="polite" aria-atomic="true">
        {loadedText}
      </Text>
      {showLoadMore ? (
        <Button variant="secondary" size="sm" disabled={appending} onClick={handleLoadMore}>
          {appending ? LOADING_MORE_LABEL : LOAD_MORE_LABEL}
        </Button>
      ) : null}
    </Stack>
  ) : null;

  // The first answer, before the reader has chosen an order: the block is the
  // state alone. There is no order control to keep yet, and a result that
  // turned out empty offers none, because reordering nothing is a control that
  // cannot act.
  if (zeroRowState !== undefined && chosenSort === undefined) {
    return (
      <RenderTableShell className={className}>
        {zeroRowState}
        {footer}
      </RenderTableShell>
    );
  }

  const columns = buildColumns({
    markAbove,
    hasRows: rows.length > 0,
    onToggle: handleToggle,
  });

  return (
    <RenderTableShell className={className}>
      <Toolbar
        label={TOOLBAR_LABEL}
        compact
        className="dg-render-table__toolbar"
        selects={[
          {
            id: `${node.id}:sort`,
            label: SORT_LABEL,
            labelHidden: true,
            value: appliedSort,
            options: sortOptions(),
            onValueChange: handleSortSelect,
          } satisfies ToolbarSelect,
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(stat) => stat.id}
        caption={TABLE_CAPTION}
        sort={gridSortFor(appliedSort)}
        onSortChange={handleGridSort}
        expandedRowKeys={expandedKeys}
        onRowToggle={handleToggle}
        renderExpandedRow={(stat) => (
          <RenderDetail
            stat={stat}
            onSelect={actions === undefined ? undefined : handleSelectOccurrence}
            isSelected={isOccurrenceSelected}
          />
        )}
        // Reached only once the reader has chosen an order: the re-queried
        // sequence has no row on screen yet (or resolved without one), and
        // its state is drawn where the rows will be, outside the grid, while
        // the header and the toolbar above keep their elements — and the
        // reader's focus. Never a row of the previous order: those were
        // released by the gesture that chose this one.
        empty={zeroRowState}
      />

      {footer}

      {pageFailed ? (
        // The next page's own failure, with the query that failed — at the
        // offset the provider reported — and a retry that re-requests exactly
        // that page. The rows above it are the earlier answers, untouched,
        // which is what the page scope's title and lead tell the reader.
        <ErrorState
          {...queryFailureProps({ error, announcement, retry }, query, { scope: 'page' })}
          className="dg-render-table__error"
        />
      ) : null}
    </RenderTableShell>
  );
}
