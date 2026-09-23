/**
 * `RenderTable` — per-component render statistics: how often each component
 * rendered, how much time that took, what triggered those renders and which of
 * its inputs changed (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `renderTable` type and
 * the anchor of the re-render panel (AAP 0.6.5): a panel built around "why is
 * this rendering so often" is materially different from a latency panel because
 * of this view and its two neighbours, and acceptance test 2 (AAP 0.8.4) is
 * read off it — "render counts and timing per component; trigger attribution
 * (context/props/state) where determinable; component names link to
 * declarations".
 *
 * ## THE TRIGGER VOCABULARY IS THE POINT, AND `unchanged` ≠ `unknown`
 *
 * A render count on its own proves nothing: a component that renders often
 * because its inputs changed often is working exactly as asked. What makes this
 * table evidence is the attribution beside the count, and that attribution has
 * one distinction it must never blur (AAP 0.2.3):
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
 * unevidenced assertion AAP 0.8.4 forbids in an analysis, arrived at through the
 * renderer instead of through the model.
 *
 * ## PROP NAMES ONLY — VALUES NEVER REACH THIS COMPONENT (AAP 0.5.2)
 *
 * The producer's fiber diffing sends key **names** plus change counts, bounded
 * by its own per-render key cap, and never a prop value. So this view renders
 * names and counts and nothing else: there is no value column, no value preview,
 * no expand-to-value affordance and no "show full value" control (opt-in full
 * values are explicitly not implemented in v1). Every name is additionally put
 * through `../utils/format`'s shared truncation budget before it is drawn, so a
 * pathological key cannot stretch a row, and the cell's "+N more" indicator
 * counts only the names that actually arrived — the cap is upstream, so nothing
 * here may imply the list is complete.
 *
 * ## DATA ARRIVES THROUGH THE NODE'S QUERY, INTERACTIONS LEAVE THROUGH ACTIONS
 *
 * The only data path is `../host/useQuery` resolving this node's own
 * `DataQuery` against the ambient `DataProvider`; the only interaction path is
 * `../host/PanelActions`. No socket, no `fetch`, no transport knowledge of any
 * kind (AAP 0.1.2) — and no runtime import of `@debuggen/telemetry` either: the
 * aggregate shapes are consumed as types, so the page bundle carries the
 * renderer and not the capture pipeline.
 *
 * Three actions are raised, and one deliberately is not:
 *
 *   - `onOpenSource` — through the `./SourceLink` chip beside a component's
 *     name and beside an individual render that carried a location. The chip
 *     forwards the `SourceLocation` it was given **by reference**, unmodified.
 *   - `onExpand` — whenever a row's per-render list is opened or closed, with
 *     this node's `id` and the row's own `id`.
 *   - `onSelectEvent` — from an individual render inside an expanded row, which
 *     is the only item in this view that IS one captured event.
 *   - **Not** `onRowActivate`. An aggregate row stands for many events and has
 *     no single event id, so activating one selects nothing: inventing a
 *     representative id would open a details drawer on evidence the reader did
 *     not point at (see `../host/PanelActions` on why a fabricated coordinate is
 *     worse than an absent one).
 *
 * ## PAGING IS HONEST ABOUT WHAT IT HAS (AAP 0.4.2)
 *
 * Two bounds apply and the reader is told about both. The result is paged —
 * `limit` defaults to 200 and is capped at 5 000 — so the footer states how many
 * rows are loaded against the reported total and offers "load more" only while
 * the response says more exist. Separately, each row's per-render list is
 * bounded by the producer, and a row that says so (`occurrencesTruncated`)
 * renders an explicit note instead of letting the expansion read as complete.
 *
 * "Load more" **grows the page** rather than accumulating pages in component
 * state: the query is re-resolved with a larger `limit`, so the rows on screen
 * are always exactly one provider answer — no evidence is held in a local
 * buffer, and there is no way for this view to draw a page of one query beneath
 * the total of another. `useQuery` compares a query by content, so rebuilding it
 * each render is free.
 *
 * Two consequences of that choice, both deliberate. The larger page resolves
 * through the ordinary loading state, so the block shows its silhouette while it
 * is in flight — the host contract holds no page while another request is
 * outstanding, and a table that kept drawing the previous rows would be showing
 * one query's page under another query's footer. And the view is keyed on the
 * **node's** query rather than the resolved one, so growing the page keeps the
 * reader's open rows and chosen order, while a node pointed at different
 * evidence starts over.
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
 * Loading (a row silhouette), error (generic copy, the failing query verbatim
 * and a working retry) and empty (a node-specific sentence in generic product
 * vocabulary) — never a blank area, and never a failure dressed as a result
 * (AAP 0.5.5).
 *
 * ## APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
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
 *   `dg-render-table__error`           the failure box
 *   `dg-render-table__empty`           the empty box
 *   `dg-render-table__component-cell`  the component name, truncating, mono
 *   `dg-render-table__count-cell`      a figure column, mono and tabular
 *   `dg-is-outlier`                    a count far above the loaded median
 *   `dg-render-table__trigger`         one histogram chip, with its five
 *   `dg-render-table__trigger--*`      per-trigger variants
 *   `dg-render-table__changed-props`   the wrapping key list
 *   `dg-render-table__detail`          the per-render list of an expanded row
 *   `dg-data-table__footer`            the paging line below the grid
 *
 * `dg-icon` from `../styles/base.css` is reused and never redefined, and the
 * caller's `className` is composed last. `dg-is-expanded`, `dg-is-selected` and
 * every ARIA grid attribute belong to `../primitives/DataTable`, which owns the
 * grid roles, the roving tab stop and the keyboard model — this file configures
 * that primitive rather than competing with it.
 *
 * ## NOTHING HERE KNOWS ANY PROJECT (AAP 0.5.4)
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
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '../host/DataProvider';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
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
 * inspected application (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

/** The grid's accessible name. Required by `DataTable`, and never a heading. */
const TABLE_CAPTION = 'Render statistics per component';

/** Announced while the page is resolving; never painted. */
const LOADING_LABEL = 'Loading render statistics…';

/** The failure line. States what failed, never what it might mean (AAP 0.5.5). */
const ERROR_MESSAGE = 'The render statistics for this panel could not be loaded.';

/** The empty sentence for this node — the wording AAP 0.6.2 gives this component. */
const EMPTY_MESSAGE = 'No renders were captured for this interaction.';

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

/** The disclosure control's name while a row is collapsed. */
const EXPAND_LABEL = 'Show individual renders';

/** The disclosure control's name while a row is open. */
const COLLAPSE_LABEL = 'Hide individual renders';

/** The control that selects one render as the panel's current evidence. */
const SELECT_OCCURRENCE_LABEL = 'Select this render';

/** The paging control. */
const LOAD_MORE_LABEL = 'Load more';

/** Stated instead of a paging control once the contract's page cap is reached. */
const PAGE_CAP_NOTE = 'The largest page this view can request is already loaded.';

/** The sort control's accessible name in the toolbar. */
const SORT_LABEL = 'Order';

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
 * difference from two words (AAP 0.2.3).
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

/*
 * ---------------------------------------------------------------------------
 * The histograms
 *
 * Both are drawn over their whole vocabulary, zeros included, because an absent
 * chip cannot say which of two things it means — "nothing fell into this
 * bucket" or "this bucket is not shown" — and for the trigger vocabulary those
 * two readings support opposite conclusions (AAP 0.2.3).
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
 * declaration (AAP 0.6.4).
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
 * The page a not-yet-resolved query stands in for: one frozen empty array, so
 * the rendered row list is a stable value rather than a new array per render.
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
 * The page this view asks for first, and the step it grows by.
 *
 * The node's authored `limit` when it is usable, the contract's default
 * otherwise, clamped into `[1, DATA_QUERY_MAX_LIMIT]` and floored to whole rows.
 * The lower bound is deliberate: `limit: 0` is a legal query meaning "no items",
 * but a table drawn from it is indistinguishable from a capture that observed no
 * renders, so the smallest page this view requests is one row — the empty state
 * then means what it says.
 *
 * @param limit The node's authored limit, if any.
 * @returns A whole row count between one and the contract's maximum.
 */
function resolvePageStep(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 1), DATA_QUERY_MAX_LIMIT);
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
 * The failing query as the text an error state shows.
 *
 * Pretty-printed JSON, which is the form `../primitives/ErrorState` documents:
 * a reader who is told a request failed can only act on it if they can see what
 * was requested. Nothing is redacted here because nothing sensitive is in a
 * query — it names a source, a trace, a kind list and a page.
 *
 * @param query The query that failed.
 * @returns The serialised query, or an empty string if it cannot be serialised.
 */
function serializeQuery(query: DataQuery): string {
  try {
    return JSON.stringify(query, undefined, 2);
  } catch {
    // Unreachable for a validated query, which holds only JSON primitives. An
    // error state is the wrong place to fail a second time, so an unserialisable
    // query costs the block and not the panel.
    return '';
  }
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
 * @param stats The loaded page.
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
   * header above it to carry the vocabulary's definitions.
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
    >
      {count === undefined ? trigger : `${trigger} ${formatCount(count)}`}
    </Badge>
  );

  return description === undefined ? chip : <Tooltip content={description}>{chip}</Tooltip>;
}

/** Props of {@link OccurrenceRow}. */
interface OccurrenceRowProps {
  /** The one render this row stands for. */
  readonly occurrence: RenderOccurrence;

  /** The component's first observed render, which every offset is measured from. */
  readonly originEpochMs: number;

  /**
   * Selects this render as the panel's current evidence, or `undefined` when no
   * host would handle a selection — in which case the row renders its offset as
   * text rather than as a control that does nothing.
   */
  readonly onSelect?: ((occurrence: RenderOccurrence) => void) | undefined;
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
 *
 * @param props See {@link OccurrenceRowProps}.
 * @returns The row.
 */
function OccurrenceRow(props: OccurrenceRowProps): ReactElement {
  const { occurrence, originEpochMs, onSelect } = props;

  const offset = formatOffset(occurrence.startTime, originEpochMs);

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap>
      {onSelect === undefined ? (
        <Code size="sm" numeric>
          {offset}
        </Code>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={SELECT_OCCURRENCE_LABEL}
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
      {occurrence.source === undefined ? null : <SourceLink location={occurrence.source} compact />}
    </Stack>
  );
}

/** Props of {@link RenderDetail}. */
interface RenderDetailProps {
  /** The row being expanded. */
  readonly stat: RenderStat;

  /** Passed through to each {@link OccurrenceRow}; see that component's prop. */
  readonly onSelect?: ((occurrence: RenderOccurrence) => void) | undefined;
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
 * as the width of a props object (AAP 0.5.2).
 *
 * @param props See {@link RenderDetailProps}.
 * @returns The detail block.
 */
function RenderDetail(props: RenderDetailProps): ReactElement {
  const { stat, onSelect } = props;

  const occurrences = stat.occurrences;
  const keys = stat.changedPropKeys;

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
              onSelect={onSelect}
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

/*
 * ---------------------------------------------------------------------------
 * Columns
 * ---------------------------------------------------------------------------
 */

/** What the column definitions need from the view that renders them. */
interface ColumnContext {
  /**
   * The render count above which a row is marked, or `undefined` when no row is
   * marked. Derived from the loaded page, so it moves as more rows load — which
   * is why the mark states the resolved threshold rather than implying a
   * standing rule.
   */
  readonly markAbove: number | undefined;

  /** Whether a given row's per-render list is open. */
  readonly isExpanded: (stat: RenderStat) => boolean;

  /** Opens or closes a row's per-render list. */
  readonly onToggle: (stat: RenderStat) => void;
}

/**
 * The columns of this table, left to right.
 *
 * Every field read below is one the node catalog declares for this node type
 * (`catalogEntryFor('renderTable').reads`, which composes span identity, timing,
 * taxonomy and source fields with the render kinds' own attribute keys), and the
 * aggregate that answers the `renders` source is where those fields are already
 * folded into per-component rows.
 *
 * Two of the ten columns exist for one reason, and it is the reason this whole
 * view is evidence rather than a chart: `Stable inputs` and `Unclassified` are
 * separate columns, with separate headers and separate definitions, because the
 * counts behind them mean opposite things (AAP 0.2.3). Nothing in this function
 * combines them, and the histogram beside them prints all five buckets — zeros
 * included — so a bucket can never be inferred from the absence of a chip.
 *
 * Tracks are ratios and `ch` measures only: they resolve identically in the
 * header row and in every data row, which is what keeps a column sitting under
 * its own heading (see `../primitives/DataTable` on why an intrinsic track does
 * not), and neither form is a hardcoded length.
 *
 * @param context See {@link ColumnContext}.
 * @returns The column definitions.
 */
function buildColumns(context: ColumnContext): readonly DataTableColumn<RenderStat>[] {
  const { markAbove, isExpanded, onToggle } = context;

  return [
    {
      key: COLUMN_KEYS.component,
      header: COLUMN_HEADERS.component,
      rowHeader: true,
      width: 'minmax(0, 3fr)',
      cell: (stat) => {
        const expanded = isExpanded(stat);

        return (
          <Stack direction="horizontal" gap={1} align="center">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={expanded ? COLLAPSE_LABEL : EXPAND_LABEL}
              aria-expanded={expanded}
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
            <Text as="span" size="sm" truncate className="dg-render-table__component-cell">
              {truncate(stat.component)}
            </Text>
            {stat.source === undefined ? null : <SourceLink location={stat.source} compact />}
          </Stack>
        );
      },
    },
    {
      key: COLUMN_KEYS.renderCount,
      header: COLUMN_HEADERS.renderCount,
      align: 'end',
      width: 'minmax(0, 9ch)',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (stat) => {
        // A mark is only ever applied against a threshold that exists, and the
        // threshold is stated where the mark is: the glyph and the tooltip are
        // what keep the highlight from being carried by colour alone, and from
        // reading as a verdict rather than as the explained heuristic it is.
        const marked = markAbove !== undefined && stat.renderCount > markAbove;

        const figure = (
          <Text
            as="span"
            size="sm"
            numeric
            className={clsx('dg-render-table__count-cell', marked && 'dg-is-outlier')}
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
      width: 'minmax(0, 11ch)',
      sortable: true,
      defaultSortDirection: 'desc',
      cell: (stat) => <DurationCell ms={stat.totalDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.averageDuration,
      header: COLUMN_HEADERS.averageDuration,
      align: 'end',
      width: 'minmax(0, 11ch)',
      cell: (stat) => <DurationCell ms={stat.averageDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.maxDuration,
      header: COLUMN_HEADERS.maxDuration,
      align: 'end',
      width: 'minmax(0, 11ch)',
      cell: (stat) => <DurationCell ms={stat.maxDurationMs} severity="auto" size="sm" />,
    },
    {
      key: COLUMN_KEYS.triggers,
      header: (
        <Tooltip content={COLUMN_TOOLTIPS.triggers}>
          <Text as="span" size="sm" weight="medium">
            {COLUMN_HEADERS.triggers}
          </Text>
        </Tooltip>
      ),
      headerLabel: COLUMN_HEADERS.triggers,
      width: 'minmax(0, 4fr)',
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
        <Tooltip content={COLUMN_TOOLTIPS.unchanged}>
          <Text as="span" size="sm" weight="medium">
            {COLUMN_HEADERS.unchanged}
          </Text>
        </Tooltip>
      ),
      headerLabel: COLUMN_HEADERS.unchanged,
      align: 'end',
      width: 'minmax(0, 13ch)',
      cell: (stat) => (
        <Text as="span" size="sm" numeric className="dg-render-table__count-cell">
          {formatCount(stat.unchangedRenderCount)}
        </Text>
      ),
    },
    {
      key: COLUMN_KEYS.unknown,
      header: (
        <Tooltip content={COLUMN_TOOLTIPS.unknown}>
          <Text as="span" size="sm" weight="medium">
            {COLUMN_HEADERS.unknown}
          </Text>
        </Tooltip>
      ),
      headerLabel: COLUMN_HEADERS.unknown,
      align: 'end',
      width: 'minmax(0, 13ch)',
      cell: (stat) => (
        <Text as="span" size="sm" numeric className="dg-render-table__count-cell">
          {formatCount(stat.unknownTriggerCount)}
        </Text>
      ),
    },
    {
      key: COLUMN_KEYS.changedProps,
      header: (
        <Tooltip content={COLUMN_TOOLTIPS.changedProps}>
          <Text as="span" size="sm" weight="medium">
            {COLUMN_HEADERS.changedProps}
          </Text>
        </Tooltip>
      ),
      headerLabel: COLUMN_HEADERS.changedProps,
      width: 'minmax(0, 3fr)',
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
        <Tooltip content={COLUMN_TOOLTIPS.phases}>
          <Text as="span" size="sm" weight="medium">
            {COLUMN_HEADERS.phases}
          </Text>
        </Tooltip>
      ),
      headerLabel: COLUMN_HEADERS.phases,
      width: 'minmax(0, 2fr)',
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
 * Everything this view holds locally — how large a page it has asked for, which
 * order the reader chose, which rows are open — belongs to **one** query. When
 * the node's query changes, all three have to go back to their initial values,
 * and the way to do that without writing state from an effect or during a render
 * (both of which `eslint-plugin-react-hooks` rejects, and rightly: the first is
 * a second render pass, the second is a render that depends on its own output)
 * is to let React discard the state with the instance. So the exported component
 * computes the query's identity and renders the view under it as a `key`; the
 * view below holds the state and knows nothing about resets.
 *
 * The identity is the query's *contents*, so a node re-parsed, re-spread or
 * rebuilt into a fresh object with the same fields keeps its page and its open
 * rows — only a genuinely different request starts over.
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

  return <RenderTableView key={queryIdentity(node.query)} node={node} className={className} />;
}

/**
 * The stateful half of {@link RenderTable}: resolves the page, draws it, and
 * owns the paging, ordering and disclosure of one query.
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

  // The page the node asked for, and the step "load more" grows by.
  const pageStep = resolvePageStep(node.query.limit);

  const [pageLimit, setPageLimit] = useState(pageStep);
  const [chosenSort, setChosenSort] = useState<DataQuerySort | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<readonly string[]>(NO_EXPANDED_KEYS);

  // The reader's choice wins over the authored order, which wins over this
  // view's default. Only one of the three is ever applied, and it is the one the
  // grid and the toolbar both report.
  const appliedSort: DataQuerySort = chosenSort ?? node.query.sort ?? DEFAULT_SORT;

  // Rebuilt every render on purpose: `useQuery` compares a query by content, so
  // a stable identity buys nothing and memoizing it would only add a way for the
  // resolved page and the requested page to disagree. The authored filter and
  // offset pass through untouched; the source is forced to the one source this
  // component can draw (see RENDERS_SOURCE).
  const query: DataQuery & { source: typeof RENDERS_SOURCE } = {
    ...node.query,
    source: RENDERS_SOURCE,
    sort: appliedSort,
    limit: pageLimit,
  };

  const { status, data, error, total, nextOffset, retry } = useQuery(query);

  const rows: readonly RenderStat[] = data ?? NO_ROWS;

  const handleGridSort = useCallback(
    (next: DataTableSort): void => {
      // The grid asks by column; the vocabulary answers by order. A column no
      // member ranks by is dropped rather than approximated, so the order shown
      // is always the order applied.
      const mapped = querySortForColumn(next.key);

      if (mapped === undefined) {
        return;
      }

      setChosenSort(mapped);
      actions?.onFilterChange?.(node.id, { sort: mapped });
    },
    [actions, node.id],
  );

  const handleSortSelect = useCallback(
    (value: string): void => {
      // The control's options come from the vocabulary, so this only rejects a
      // value that never belonged to it — a stale option in a host that kept one.
      if (!isDataQuerySort(value)) {
        return;
      }

      setChosenSort(value);
      actions?.onFilterChange?.(node.id, { sort: value });
    },
    [actions, node.id],
  );

  const handleLoadMore = useCallback((): void => {
    setPageLimit((current) => Math.min(current + pageStep, DATA_QUERY_MAX_LIMIT));
  }, [pageStep]);

  const isExpanded = useCallback(
    (stat: RenderStat): boolean => expandedKeys.includes(stat.id),
    [expandedKeys],
  );

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
      actions?.onSelectEvent({
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      });
    },
    [actions],
  );

  if (status === 'loading') {
    return (
      <RenderTableShell className={className}>
        <LoadingState
          variant="rows"
          rows={LOADING_ROWS}
          label={LOADING_LABEL}
          className="dg-render-table__loading"
        />
      </RenderTableShell>
    );
  }

  if (status === 'error') {
    return (
      <RenderTableShell className={className}>
        <ErrorState
          message={ERROR_MESSAGE}
          code={error?.code}
          query={serializeQuery(query)}
          onRetry={retry}
          className="dg-render-table__error"
        />
      </RenderTableShell>
    );
  }

  if (rows.length === 0) {
    // A resolved page with no rows. The sentence names the class of evidence
    // this node draws and says the capture holds none of it; the order control
    // is not rendered, because reordering nothing is a control that cannot act.
    return (
      <RenderTableShell className={className}>
        <EmptyState message={EMPTY_MESSAGE} className="dg-render-table__empty" />
      </RenderTableShell>
    );
  }

  const columns = buildColumns({
    markAbove: outlierThreshold(rows),
    isExpanded,
    onToggle: handleToggle,
  });

  // `nextOffset` is the provider's own answer about whether more rows exist; it
  // is never inferred from the length of what arrived, which would drift the
  // moment a limit was clamped.
  const moreExist = nextOffset !== undefined;
  const atPageCap = pageLimit >= DATA_QUERY_MAX_LIMIT;

  const loadedText =
    total === undefined
      ? `${formatCount(rows.length)} components loaded.`
      : `Showing ${formatCount(rows.length)} of ${formatCount(total)} components.`;

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
          />
        )}
      />

      <Stack
        direction="horizontal"
        gap={2}
        align="center"
        justify="between"
        wrap
        className="dg-data-table__footer"
      >
        <Text as="p" size="xs" tone="muted">
          {loadedText}
        </Text>
        {moreExist ? (
          atPageCap ? (
            <Text as="p" size="xs" tone="muted">
              {PAGE_CAP_NOTE}
            </Text>
          ) : (
            <Button variant="secondary" size="sm" onClick={handleLoadMore}>
              {LOAD_MORE_LABEL}
            </Button>
          )
        ) : null}
      </Stack>
    </RenderTableShell>
  );
}
