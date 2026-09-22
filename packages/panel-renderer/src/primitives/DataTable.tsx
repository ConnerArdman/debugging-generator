/*
 * DataTable - the tabular workhorse of @debuggen/panel-renderer (AAP 0.6.2).
 *
 * AAP 0.6.4 permits no raw `<table>` above the primitives layer, so every grid of rows in the
 * product resolves to this one component: the slowest-operations table, the render statistics
 * table, the request table with its duplicate groups and the redacted query table of the node
 * catalog, plus the modification list of the editor webview. Those surfaces supply columns, rows,
 * a row key and - where they need one - an expansion renderer, and they re-implement nothing:
 * sorting, virtualization, selection, expansion and keyboard operation all live here.
 *
 * ## The four pillars of AAP 0.6.2, and how each is met
 *
 *   Generic over a row type. {@link DataTable} is a generic function - not an `FC`, which cannot
 *   carry a call-site type parameter cleanly - so `Row` is inferred from `rows` and every
 *   {@link DataTableColumn.cell} renderer receives that exact type. No `unknown`, no index
 *   signature and no cast stands between a caller's aggregate shape and its cells.
 *
 *   Sortable, and CONTROLLED. Clicking a sortable header computes the next {@link DataTableSort}
 *   (same key flips the direction, a different key takes that column's
 *   {@link DataTableColumn.defaultSortDirection}) and raises `onSortChange`. It never sorts,
 *   re-orders, slices or pages `rows`. AAP 0.4.2 is the reason: `POST /sessions/:id/panel-data`
 *   applies `filter`, `sort` (with a stable secondary key) and `limit`/`offset` server-side and
 *   answers with `total`/`nextOffset`, so the rows arrive already ordered and a page is a window
 *   onto a larger result. Sorting a page locally would silently re-order only the visible slice -
 *   a table that looks sorted and is not, which is worse than one that plainly is not. The current
 *   order is reported to assistive technology through `aria-sort` on the header cell.
 *
 *   Virtualized with `@tanstack/react-virtual`. This is the only module in the package that
 *   imports it. Long lists render a window of rows inside the shared
 *   `dg-virtual-viewport`/`dg-virtual-canvas`/`dg-virtual-row` triplet, and real measured heights
 *   replace the estimate after first paint. A result is capped at 5 000 rows by AAP 0.4.2, so
 *   virtualization here buys smoothness rather than survival - which is what makes the
 *   measurement-unavailable fallback below safe.
 *
 *   Keyboard-navigable. A roving `tabIndex` makes the body a single tab stop; Arrow keys, Home,
 *   End, PageUp/PageDown move the active row, Enter and Space activate it, and Arrow Right/Left
 *   expand and collapse it when the caller supplied both an expansion renderer and a toggle
 *   handler. The header's sort controls stay ordinary tab stops, because a reader must be able to
 *   reach them without entering the body.
 *
 * ## The ARIA structure, and why it is shaped this way
 *
 *   div.dg-data-table                     the block
 *     div.dg-data-table__caption          the accessible name, visually hidden unless asked for
 *     div.dg-virtual-viewport             the SCROLL CONTAINER, and deliberately ROLE-LESS
 *       div[role=grid]                    named by the caption, exact aria-rowcount/aria-colcount
 *         div[role=rowgroup].__head
 *           div[role=row]                   aria-rowindex=1
 *             div[role=columnheader]         aria-colindex, aria-sort, one per column
 *         div[role=rowgroup].dg-virtual-canvas
 *           div[role=presentation].dg-virtual-row   the POSITIONING wrapper, data-index
 *             div[role=row]                         the data row, aria-rowindex, tabIndex
 *               div[role=rowheader|gridcell]        aria-colindex, one per column
 *             div[role=row].__expanded              the detail row, when open
 *               div[role=gridcell]                  aria-colspan = column count
 *       (the empty content, when there are no rows, OUTSIDE the grid)
 *
 * The scroll container carries no role because `grid` accepts only `row` and `rowgroup` children:
 * a role on the scroller would insert a foreign node into that structure and invalidate it. The
 * positioning wrapper carries `role="presentation"`, which removes it from the accessibility tree
 * so its `role="row"` children are exposed under the rowgroup - the standard arrangement that lets
 * a virtualized list keep a valid `grid > rowgroup > row > gridcell` tree. Any other ARIA
 * attribute on that wrapper voids the presentation role, so it carries none.
 *
 * Row indices are exact rather than `-1`: one `useMemo` walks the rows once, assigning each data
 * row `aria-rowindex = 2 + index + (expanded rows before it)`, giving its detail row the next
 * index, and summing `aria-rowcount = 1 + rows.length + expandedCount`. An expanded detail row
 * occupies a row index of its own, so the count a reader is told matches the rows a reader can
 * reach.
 *
 * The empty content renders OUTSIDE the grid's rowgroup. A message row inside the body would be
 * announced as data ("row 2 of 2"), and the header stays mounted so column context and the sort
 * controls remain available while the result is empty.
 *
 * ## The measurement-unavailable fallback, which must not be removed
 *
 * When virtualization is on but `virtualizer.getVirtualItems()` is empty while rows exist, every
 * row renders unvirtualized. Two environments produce exactly that state: happy-dom, where
 * `getBoundingClientRect()` answers zeroes so the virtualizer can measure no viewport - which is
 * the environment every `src/components/*.test.tsx` suite mounts these tables in - and the first
 * paint of a real browser, before the scroll element has been observed. Without the fallback those
 * suites would render an empty table and the `pnpm test` gate would fail for a reason that has
 * nothing to do with the components under test.
 *
 * ## Zero hardcoded CSS, and the geometry channel
 *
 * Not one colour, length, radius or font appears in this module. Appearance is class names, which
 * `../styles/components.css` resolves to `var(--dg-*)` tokens (AAP 0.6.3): surfaces from
 * `--dg-surface-base`/`--dg-surface-elevated`, rules from `--dg-border-subtle`/`--dg-border-strong`,
 * density from `--dg-space-*`, type from `--dg-text-sm`/`--dg-text-xs` and `--dg-font-mono` with
 * tabular figures for numeric columns, selection from `--dg-accent`/`--dg-accent-muted` and focus
 * from `--dg-focus-ring`. The class contract this file DECLARES, and that `components.css` must
 * implement:
 *
 *   dg-data-table               the block
 *   dg-data-table--compact      the dense modifier
 *   dg-data-table__caption      the caption line (coupled with `dg-visually-hidden` when hidden)
 *   dg-data-table__head         the header rowgroup
 *   dg-data-table__header-cell  a `role="columnheader"` cell
 *   dg-data-table__sort-button  the ghost `Button` inside a sortable header cell
 *   dg-data-table__row          a data row
 *   dg-data-table__cell         a `role="rowheader"` or `role="gridcell"` cell
 *   dg-data-table__expanded     the detail row a caller's `renderExpandedRow` fills
 *   dg-is-selected              the selected state of a row
 *   dg-is-active                the roving-focus state of a row
 *   dg-is-expanded              the expanded state of a row
 *   dg-virtual-viewport         the scroll container - SHARED with `components/EventLog`
 *   dg-virtual-canvas           the total-height spacer - SHARED with `components/EventLog`
 *   dg-virtual-row              the positioned item wrapper - SHARED with `components/EventLog`
 *
 * The grid element itself carries no class: the contract above names none for it, so
 * `components.css` addresses it as `.dg-data-table [role='grid']`. `dg-visually-hidden` is reused
 * from `../styles/base.css` and never redefined.
 *
 * One further obligation rides on the header cell's own attribute rather than on a class: the
 * sorted column must be VISIBLE, not reported to assistive technology alone, so `components.css`
 * renders the indicator from `.dg-data-table__header-cell[aria-sort='ascending']` and
 * `[aria-sort='descending']` - placed at the cell's inline end, beside the control rather than
 * wrapped under it, since a sortable header's control fills the cell. That is also why this module
 * writes `aria-sort` on the cell and nothing about sorting into a class: the state has exactly one
 * representation.
 *
 * Four component-scoped custom properties carry the values only this module can know - computed
 * geometry, which `../styles/base.css` sanctions inline for exactly this purpose - and they are
 * the only thing any `style` attribute here contains:
 *
 *   --dgc-columns         the grid track template, consumed by each row as
 *                         `grid-template-columns: var(--dgc-columns, minmax(0, 1fr))`. The header
 *                         row and each data row are SEPARATE grid containers - a positioned row
 *                         cannot share a parent's tracks - so a track only lines a header up with
 *                         its column if it resolves to the same width in every row; see
 *                         {@link DataTableColumn.width}.
 *   --dgc-virtual-total   the canvas height as a UNITLESS number, consumed as
 *                         `block-size: calc(var(--dgc-virtual-total, 0) * 1px)`
 *   --dgc-virtual-start   a row's offset as a UNITLESS number, consumed as
 *                         `transform: translateY(calc(var(--dgc-virtual-start, 0) * 1px))`
 *   --dgc-align           a cell's alignment keyword, consumed as `text-align: var(--dgc-align, start)`
 *
 * The two virtualization properties are unitless on purpose: a bare number is the same kind of
 * value as the unitless SVG geometry base.css permits, and it keeps every length unit in the
 * stylesheet where the token system can see it.
 *
 * ## Boundaries
 *
 * Schema-agnostic. This primitive knows nothing of `DataQuery`, panel node types, telemetry kinds,
 * tiers or spans: it imports `@debuggen/panel-schema` and `@debuggen/telemetry` not at all, which
 * is what lets the four table components and the editor webview - three different data shapes -
 * share it.
 *
 * Presentational. It raises `onSortChange`, `onRowActivate` and `onRowToggle` and renders what it
 * is given. It never fetches, never reaches a `DataProvider` and never opens a socket: data
 * arrives through the host's provider interface and interactions leave through `PanelActions`
 * (AAP 0.4.2).
 *
 * ## Building on this
 *
 * A table component supplies `columns` (key, header, alignment, optional grid track, cell
 * renderer), `rows` exactly as the data source ordered them, `rowKey`, a `caption`, the controlled
 * `sort` plus `onSortChange`, and - when rows have detail - `expandedRowKeys`, `onRowToggle` and
 * `renderExpandedRow`. It renders its own expand affordance as a `Button` inside a cell; a click
 * on any interactive descendant is not treated as a row activation, so the two never fire
 * together. It does not sort, page, virtualize or handle keys itself.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from 'react';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Text } from './Text';

/**
 * The two directions a column can be ordered in.
 *
 * Spelled the way the data layer spells them (`duration_desc`, `start_asc`, `count_desc` in
 * AAP 0.4.2's `DataQuery.sort`), so a caller translating between the two never has to remember a
 * second vocabulary. `aria-sort` receives the ARIA spelling (`ascending`/`descending`), which this
 * module derives.
 */
export type DataTableSortDirection = 'asc' | 'desc';

/**
 * The sort the table currently reflects: one column key and one direction.
 *
 * Readonly because it is state the caller owns. The table reads it to decide which header reports
 * `aria-sort` and what the next click should ask for; it never writes it.
 */
export interface DataTableSort {
  /** The {@link DataTableColumn.key} of the column the rows are ordered by. */
  readonly key: string;

  /** The direction that ordering runs in. */
  readonly direction: DataTableSortDirection;
}

/**
 * One column: its identity, its header, its geometry and how it renders a cell.
 *
 * @typeParam Row The row type, inferred at the call site from {@link DataTableProps.rows}.
 */
export interface DataTableColumn<Row> {
  /**
   * A stable identifier, unique within `columns`, and the key reported upward by
   * `onSortChange` - so it is the same string the data layer's `sort` understands.
   *
   * It is the React key of the header and of each cell, so it must not change between renders for
   * the same column.
   */
  key: string;

  /**
   * The header content. A node, so a column can head itself with a badge, a glyph or a unit
   * beside its label.
   *
   * When it is not plain text, name the column with {@link DataTableColumn.headerLabel} as well:
   * that string, not the node, becomes the accessible name of the sort control.
   */
  header: ReactNode;

  /**
   * The accessible name of the sort control, for a `header` whose text a screen reader could not
   * read out of the node (a glyph, a chart legend swatch, an abbreviation).
   *
   * Supplied, it becomes the control's `aria-label` and therefore its name; omitted, the header
   * node's own text is the name.
   */
  headerLabel?: string | undefined;

  /**
   * How the column's content aligns within its track. Defaults to `"start"`.
   *
   * Use `"end"` for every numeric, duration, count and size column: figures compare down a column
   * only when their last digits line up (AAP 0.6.3, which pairs end alignment with
   * `--dg-font-mono` and tabular figures). The value travels to `components.css` as `--dgc-align`
   * and is a CSS alignment keyword, never a physical direction, so a right-to-left surface stays
   * correct.
   */
  align?: 'start' | 'center' | 'end' | undefined;

  /**
   * The column's CSS **grid track**, joined with its siblings into `--dgc-columns`.
   *
   * Relational and intrinsic forms only - `minmax(0, 1fr)`, `2fr`, `max-content`, `min-content`,
   * `fit-content(30ch)`, `auto`, a `var(--dg-space-*)`-based length, a `ch` measure tied to the
   * content. A literal `px` or `rem` track is a hardcoded value and AAP 0.6.4 forbids it; review
   * rejects one. Omitted, the column takes `minmax(0, 1fr)`, which shares the free space and
   * allows its content to shrink rather than forcing the row wider.
   *
   * PREFER A TRACK THAT RESOLVES IDENTICALLY IN EVERY ROW - a ratio (`minmax(0, 1fr)`, `2fr`), a
   * `ch` measure, or a token-based length. The header row and each data row are separate grid
   * containers (see this module's header), so an INTRINSIC track sizes itself from one row's own
   * content: a `max-content` column whose values vary in width lands at a different offset in
   * every row and stops sitting under its own header. Reserve the intrinsic forms for columns
   * whose content is uniformly wide - a two-letter kind chip, a fixed-width badge, an icon.
   */
  width?: string | undefined;

  /**
   * Whether this column offers sorting. Defaults to `false`.
   *
   * A sortable column reports `aria-sort` (`ascending`, `descending`, or `none` when another
   * column holds the sort) and renders its header inside a ghost `Button`. A column that is not
   * sortable omits the attribute entirely rather than reporting `none`, which would claim it could
   * be sorted. A sortable column in a table with no `onSortChange` renders as plain text: a
   * control that cannot act is worse than no control.
   */
  sortable?: boolean | undefined;

  /**
   * The direction taken when this column FIRST becomes the sort key. Defaults to `"asc"`.
   *
   * Set `"desc"` on durations, counts, sizes and anything else whose interesting end is the large
   * one - the first click should show the reader the slowest operation, not the fastest. Once the
   * column holds the sort, a further click flips whatever direction is current.
   */
  defaultSortDirection?: DataTableSortDirection | undefined;

  /**
   * Marks the identity column - the one whose value names the row (a span name, a component name,
   * a request path, a file). It renders as `role="rowheader"` instead of `role="gridcell"`, so a
   * screen reader announces the row by that value as the reader moves across it.
   *
   * At most one column should set it; the first identity column is conventionally the leftmost.
   */
  rowHeader?: boolean | undefined;

  /**
   * Renders the cell for one row.
   *
   * Return a node built from this package's primitives (`Text`, `Code`, `Badge`, `DurationCell`,
   * `SourceLink`, `Button`) rather than raw HTML (AAP 0.6.4). It is called during render, so it
   * must be pure: no fetching, no state, no mutation of the row.
   *
   * @param row The row, typed exactly as the caller's `rows` element type.
   * @param rowIndex The row's index in `rows` - the caller's own ordering, unchanged by this
   *   component.
   */
  cell: (row: Row, rowIndex: number) => ReactNode;
}

/**
 * How the table virtualizes, when a caller wants to say more than yes or no.
 *
 * Every field is a COUNT or a measurement hint, never a style value: nothing here reaches a class,
 * a declaration or the token system.
 */
export interface DataTableVirtualizeOptions {
  /**
   * Turn virtualization on or off explicitly. Omitted, it is on: passing an options object at all
   * expresses the intent, and `enabled: false` is the way to keep the options while suspending
   * them.
   */
  readonly enabled?: boolean | undefined;

  /**
   * How many rows to render beyond each edge of the viewport, so a scroll does not expose blank
   * space before React commits. A count, not a length.
   */
  readonly overscan?: number | undefined;

  /**
   * The starting guess for a row's height, in CSS pixels, used only until the row is measured.
   *
   * It is a MEASUREMENT HINT, not a style value: it is never written into a class, a custom
   * property or a declaration, and `measureElement` replaces it with the real CSS-driven height
   * after first paint. Raise it for tables whose rows wrap or carry detail, so the initial scroll
   * range is closer to the truth.
   */
  readonly estimateRowHeight?: number | undefined;
}

/**
 * The props of {@link DataTable}.
 *
 * @typeParam Row The row type. Inferred from `rows`, so no call site names it.
 */
export interface DataTableProps<Row> {
  /**
   * The rows to render, **in the order they are to be displayed**.
   *
   * The data layer has already applied `filter`, `sort` and `limit`/`offset` (AAP 0.4.2), so this
   * component renders the array as given: it never sorts, re-orders, slices or pages it, and it
   * never mutates it.
   */
  rows: readonly Row[];

  /** The columns, left to right. Their order is the column order and the `aria-colindex` order. */
  columns: readonly DataTableColumn<Row>[];

  /**
   * The stable identity of a row: its React key, its selection and expansion identity, and the
   * measurement key of the virtualizer.
   *
   * Return something derived from the row's own data (an event id, a span id, a request key, a
   * file path) and not the index - an index-keyed row loses its measured height and its expansion
   * state the moment the result is re-sorted or re-paged.
   *
   * @param row The row.
   * @param index Its index in `rows`.
   */
  rowKey: (row: Row, index: number) => string;

  /**
   * The table's accessible name, and REQUIRED: a grid with no name is announced as "grid" and
   * nothing else. One short phrase naming what the rows are.
   *
   * It is rendered in the accessibility tree either way; `captionVisible` decides whether sighted
   * readers see it too.
   */
  caption: string;

  /**
   * Show the caption on the surface as well. Defaults to `false`, because a panel section
   * ordinarily carries the visible heading and a second line would duplicate it. Hidden, the
   * caption is still the grid's name - it is carried by `dg-visually-hidden`, never by
   * `display: none`, which would remove it from the accessibility tree too.
   */
  captionVisible?: boolean | undefined;

  /**
   * The sort the rows currently reflect, or `null` when they are in the data layer's natural
   * order. Controlled state: see this module's header for why the table delegates rather than
   * sorts.
   */
  sort?: DataTableSort | null | undefined;

  /**
   * Raised when a sortable header is activated, with the sort the caller should now request:
   * the same key with the direction flipped, or a new key with that column's
   * {@link DataTableColumn.defaultSortDirection}.
   *
   * Omitted, sortable columns render as plain headers (they still report `aria-sort`, because the
   * order they describe is real).
   */
  onSortChange?: ((sort: DataTableSort) => void) | undefined;

  /**
   * The {@link DataTableProps.rowKey} of the selected row, or `null` for none.
   *
   * Passing the prop at all - including `null` - puts the table in selection mode, which is what
   * makes `aria-selected` appear on the rows. Omitting it leaves the attribute off every row,
   * because a grid whose rows all report `aria-selected="false"` tells a reader that selection
   * exists when it does not. The selected row is also where the roving tab stop starts, until the
   * reader navigates.
   */
  selectedRowKey?: string | null | undefined;

  /**
   * Raised when a row is activated: clicked, or focused and confirmed with Enter or Space.
   *
   * A click that originated inside an interactive descendant - a link, a button, a field, a
   * `role="button"` chip - is NOT an activation, so a `SourceLink` chip or an expand toggle in a
   * cell does its own job without also selecting the row.
   */
  onRowActivate?: ((row: Row, index: number) => void) | undefined;

  /**
   * The keys of the rows whose detail is open. Controlled, like the sort and the selection.
   *
   * Keys that match no row are ignored, so a caller may keep an expansion set across a re-page or
   * a re-sort without pruning it.
   */
  expandedRowKeys?: readonly string[] | undefined;

  /**
   * Raised when a row's expansion is toggled from the keyboard (Arrow Right opens, Arrow Left
   * closes). Mouse toggling belongs to the caller's own affordance inside a cell, which keeps the
   * visible control, its icon and its accessible name in the table component that owns the data.
   *
   * Only wired when `renderExpandedRow` is also supplied: a row with nothing to reveal must not
   * answer an expand key.
   */
  onRowToggle?: ((row: Row, index: number) => void) | undefined;

  /**
   * Renders the detail of an expanded row into a single full-width cell.
   *
   * Supplying it is what gives the rows `aria-expanded` and what enables the expand keys; omitting
   * it leaves both off, so a table without detail never claims to have any.
   *
   * @param row The expanded row.
   * @param index Its index in `rows`.
   */
  renderExpandedRow?: ((row: Row, index: number) => ReactNode) | undefined;

  /**
   * Whether to virtualize, or how.
   *
   * Omitted, the table decides for itself and virtualizes once the row count passes an internal
   * threshold - a short table pays nothing, a long one stays smooth. `false` (or
   * `{ enabled: false }`) keeps every row in the DOM, which is what a caller wants when an
   * enclosing surface prints or searches the whole table.
   */
  virtualize?: boolean | DataTableVirtualizeOptions | undefined;

  /**
   * What to render in place of rows when `rows` is empty.
   *
   * Omitted, a generic `EmptyState` explains the absence. Pass an `EmptyState` of your own to name
   * the evidence the node draws in the caller's vocabulary, or `null` to show nothing at all when
   * the surrounding section already says it.
   *
   * It is rendered as ordinary content, not as a live region: the node may contain a control (a
   * retry action), and a live region that re-announces a control every time a result changes is
   * worse than none. Announcing that a query returned nothing belongs to the surface that ran it.
   */
  empty?: ReactNode | undefined;

  /**
   * Tighten the row density for a table inside a drawer, a sidebar or a summary strip. Defaults to
   * `false`. The dense values come from `--dg-space-*` like every other spacing in the package.
   */
  compact?: boolean | undefined;

  /**
   * Extra classes composed after `dg-data-table`, for the layout the surrounding node owns. It is
   * composition, never an escape hatch: any class named here is defined in
   * `../styles/components.css` against `--dg-*` tokens.
   */
  className?: string | undefined;

  /**
   * An id for the block element. Also the stem of the caption's id, so a stable id makes the
   * grid's `aria-labelledby` stable across renders; omitted, a generated id is used for the
   * caption and the block carries none.
   */
  id?: string | undefined;
}

/**
 * A `style` object that may carry component-scoped custom properties.
 *
 * React's `CSSProperties` has no index signature, so a literal holding `--dgc-*` keys does not
 * satisfy it and the usual workaround is a cast - which this package does not allow. Intersecting
 * it with a pattern-keyed `Record` yields the index signature instead, so the objects below are
 * type-checked, assignable to `style`, and written without an `as`.
 *
 * File-local and never exported: it is a spelling detail of this module, not vocabulary the design
 * system offers. Nothing but a `--dgc-*` value may appear in any object of this type - every
 * colour, length, radius and font lives in `../styles/components.css` (AAP 0.6.4).
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/** The `aria-rowindex` of the header row. ARIA row indices are 1-based and the header comes first. */
const HEADER_ARIA_ROW_INDEX = 1;

/** The `aria-rowindex` of the first data row, which follows the single header row. */
const FIRST_DATA_ARIA_ROW_INDEX = 2;

/**
 * The grid track a column without {@link DataTableColumn.width} takes: an equal share of the free
 * space that is still allowed to shrink below its content, so one long value cannot widen the row
 * past the viewport and force a horizontal scroll on every other column.
 */
const DEFAULT_COLUMN_TRACK = 'minmax(0, 1fr)';

/** The alignment a column without {@link DataTableColumn.align} takes. */
const DEFAULT_COLUMN_ALIGN = 'start';

/** The direction a column without {@link DataTableColumn.defaultSortDirection} first sorts in. */
const DEFAULT_SORT_DIRECTION: DataTableSortDirection = 'asc';

/**
 * The row COUNT above which an unqualified table virtualizes itself.
 *
 * A count, not a measurement: it decides how many rows justify a windowing pass, and it is read
 * nowhere near a style. Below it, every row stays in the DOM, which keeps the browser's own find
 * and the surrounding surface's text selection working on the whole table.
 */
const AUTO_VIRTUALIZE_ROW_THRESHOLD = 60;

/** How many rows beyond each viewport edge are rendered by default. A count. */
const DEFAULT_OVERSCAN_ROWS = 8;

/**
 * The default starting guess for a row's height, in CSS pixels.
 *
 * THE SINGLE NUMERIC LAYOUT HINT PERMITTED IN THIS PACKAGE, and it is a measurement hint rather
 * than a style value: it never reaches a class, a declaration or a custom property, it only seeds
 * the virtualizer's scroll range, and `measureElement` replaces it with the row's real CSS-driven
 * height after first paint. It is sized for one line of `--dg-text-sm` between two `--dg-space-*`
 * paddings, which is what a dense row of this design system is; being wrong only costs a scrollbar
 * that settles as rows are measured.
 */
const DEFAULT_ESTIMATED_ROW_HEIGHT = 32;

/** How many rows PageDown and PageUp move. A count, chosen to be a screenful of a dense table. */
const PAGE_JUMP_ROWS = 10;

/**
 * The descendants whose clicks belong to themselves rather than to the row.
 *
 * Cells routinely carry a source-location chip, an expand toggle or a filter control; a click on
 * one of those must do its own job and must not also activate the row, which would open a detail
 * the reader did not ask for. `[role="button"]` covers the chips that are not `<button>` elements.
 */
const INTERACTIVE_DESCENDANT_SELECTOR = 'a, button, input, select, textarea, [role="button"]';

/**
 * The attribute a data row carries its own index in.
 *
 * Distinct from the `data-index` the virtualizer reads off the positioning wrapper, and
 * deliberately so: keyboard handling must be able to tell "the event target IS a row" from "the
 * event target is something inside a row", and two attributes on two elements answer that with a
 * single `getAttribute` rather than a tree walk.
 */
const ROW_INDEX_ATTRIBUTE = 'data-row-index';

/** The generic copy an unqualified empty table shows. Names nothing from any inspected project. */
const DEFAULT_EMPTY_MESSAGE = 'No rows to display.';

/** One data row, with every index and flag the render needs already resolved. */
interface DataTableRowModel<Row> {
  /** The row's identity from {@link DataTableProps.rowKey}: React key, selection and measurement key. */
  readonly key: string;

  /** The row itself. */
  readonly row: Row;

  /** Whether its detail row is open - always `false` when no expansion renderer was supplied. */
  readonly expanded: boolean;

  /** Its `aria-rowindex`: `2 + index + (expanded rows before it)`. */
  readonly ariaRowIndex: number;

  /** The `aria-rowindex` of its detail row, which is the next index after its own. */
  readonly detailAriaRowIndex: number;
}

/** Everything one pass over `rows` yields: the row models, a key lookup and the exact row count. */
interface DataTableRowIndex<Row> {
  /** The rows in display order, each carrying its resolved indices. */
  readonly models: readonly DataTableRowModel<Row>[];

  /** Row key to index, for resolving a selected key to a position without a second scan. */
  readonly indexByKey: ReadonlyMap<string, number>;

  /** The grid's `aria-rowcount`: `1 + rows.length + expandedCount`. */
  readonly ariaRowCount: number;
}

/** The virtualization settings actually in force, with every default already applied. */
interface ResolvedVirtualization {
  /** Whether a window of rows is rendered rather than all of them. */
  readonly enabled: boolean;

  /** Rows rendered beyond each viewport edge. */
  readonly overscan: number;

  /** The pre-measurement height guess, in CSS pixels. */
  readonly estimateRowHeight: number;
}

/**
 * Resolve {@link DataTableProps.virtualize} into the settings in force.
 *
 * Omitted, the table decides from the row count; `false` and `{ enabled: false }` switch it off;
 * an options object without `enabled` means on, because passing options at all expresses that
 * intent.
 *
 * @param virtualize The prop as the caller supplied it, if at all.
 * @param rowCount How many rows are being rendered.
 * @returns The mode, the overscan and the height hint.
 */
function resolveVirtualization(
  virtualize: boolean | DataTableVirtualizeOptions | undefined,
  rowCount: number,
): ResolvedVirtualization {
  const auto = rowCount > AUTO_VIRTUALIZE_ROW_THRESHOLD;

  if (virtualize === undefined) {
    return {
      enabled: auto,
      overscan: DEFAULT_OVERSCAN_ROWS,
      estimateRowHeight: DEFAULT_ESTIMATED_ROW_HEIGHT,
    };
  }

  if (typeof virtualize === 'boolean') {
    return {
      enabled: virtualize,
      overscan: DEFAULT_OVERSCAN_ROWS,
      estimateRowHeight: DEFAULT_ESTIMATED_ROW_HEIGHT,
    };
  }

  return {
    enabled: virtualize.enabled ?? true,
    overscan: virtualize.overscan ?? DEFAULT_OVERSCAN_ROWS,
    estimateRowHeight: virtualize.estimateRowHeight ?? DEFAULT_ESTIMATED_ROW_HEIGHT,
  };
}

/**
 * What a column's header cell reports as `aria-sort`.
 *
 * At most one column ever reports an ordering: the one whose key the controlled sort names. Other
 * sortable columns report `none`, and a column that is not sortable reports nothing at all -
 * `aria-sort="none"` on an unsortable column tells a reader it could be sorted.
 *
 * @param column The column being headed.
 * @param sort The controlled sort, or `null` for the data layer's natural order.
 * @returns The ARIA value, or `undefined` to omit the attribute.
 */
function resolveAriaSort<Row>(
  column: DataTableColumn<Row>,
  sort: DataTableSort | null,
): 'ascending' | 'descending' | 'none' | undefined {
  if (column.sortable !== true) {
    return undefined;
  }

  if (sort === null || sort.key !== column.key) {
    return 'none';
  }

  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/**
 * The sort a click on this column's header asks for.
 *
 * Flipping the direction when the column already holds the sort is what makes a second click
 * reverse the order; taking {@link DataTableColumn.defaultSortDirection} when it does not is what
 * makes the first click on a duration column show the slowest row rather than the fastest.
 *
 * @param column The column whose header was activated.
 * @param sort The sort currently in force, or `null`.
 * @returns The next sort, to be raised through `onSortChange` - never applied here.
 */
function nextSortFor<Row>(column: DataTableColumn<Row>, sort: DataTableSort | null): DataTableSort {
  if (sort !== null && sort.key === column.key) {
    return { key: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
  }

  return { key: column.key, direction: column.defaultSortDirection ?? DEFAULT_SORT_DIRECTION };
}

/**
 * The index a row element carries, or `undefined` when the element is not a data row.
 *
 * Reading the attribute off the element ITSELF rather than walking ancestors is the guard that
 * keeps keyboard handling honest: a key pressed on a sort control in the header, or on a button
 * inside a cell, reaches the grid's handler by bubbling, and neither of those elements carries the
 * attribute, so neither is mistaken for a row.
 *
 * @param element The event target.
 * @returns The row index, or `undefined`.
 */
function readRowIndex(element: Element): number | undefined {
  const raw = element.getAttribute(ROW_INDEX_ATTRIBUTE);

  if (raw === null) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * The selector that finds one data row inside the viewport.
 *
 * @param index The row index to find.
 * @returns An attribute selector for that row.
 */
function rowSelector(index: number): string {
  return `[${ROW_INDEX_ATTRIBUTE}="${String(index)}"]`;
}

/**
 * Where the roving tab stop sits, clamped to the rows that exist.
 *
 * Clamping is a PURE DERIVATION during render rather than a `setState` inside an effect. Two
 * reasons: the React Compiler lint set enabled for this package (`react-hooks/set-state-in-effect`)
 * rejects state synchronised from an effect, and an effect would render one frame with an index
 * past the end - exactly the frame in which a reader's focus would be lost. A shrinking result (a
 * new capture, a narrower filter, a smaller page) therefore cannot leave the tab stop dangling.
 *
 * Precedence: where the reader navigated, else the selected row, else the first row. The selection
 * fallback is what puts the tab stop on the row a caller arrived with selected, so tabbing into
 * the body lands on it instead of on row one.
 *
 * @param navigated The index the reader last moved to, or `null` if they have not.
 * @param selected The index of the selected row, if selection is in use and the key matched.
 * @param rowCount How many rows exist.
 * @returns The active index, or `-1` when there are no rows.
 */
function resolveActiveIndex(
  navigated: number | null,
  selected: number | undefined,
  rowCount: number,
): number {
  if (rowCount === 0) {
    return -1;
  }

  const preferred = navigated ?? selected ?? 0;

  return Math.min(Math.max(preferred, 0), rowCount - 1);
}

/**
 * The generic data grid of the design system.
 *
 * See this module's header for the four pillars of AAP 0.6.2, the exact ARIA structure, the class
 * and custom-property contract, the measurement-unavailable fallback and the boundaries this
 * primitive keeps; see {@link DataTableProps} and {@link DataTableColumn} for the props.
 *
 * Written as a generic function rather than an `FC`, so `Row` is inferred from `rows` at every
 * call site and each {@link DataTableColumn.cell} receives the caller's own row type.
 *
 * @typeParam Row The row type.
 * @param props The props documented on {@link DataTableProps}.
 * @returns The rendered grid.
 *
 * @example
 * // A sortable, expandable table. The caller owns the sort, the selection and the expansion set;
 * // the data layer owns the order.
 * <DataTable
 *   caption={captionText}
 *   rows={page.items}
 *   rowKey={(item) => item.id}
 *   columns={columns}
 *   sort={sort}
 *   onSortChange={setSort}
 *   selectedRowKey={selectedId}
 *   onRowActivate={(item) => { setSelectedId(item.id); }}
 *   expandedRowKeys={expandedIds}
 *   onRowToggle={(item) => { toggleExpanded(item.id); }}
 *   renderExpandedRow={(item) => <ItemDetail item={item} />}
 * />
 */
export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  const {
    rows,
    columns,
    rowKey,
    caption,
    captionVisible = false,
    sort = null,
    onSortChange,
    selectedRowKey,
    onRowActivate,
    expandedRowKeys,
    onRowToggle,
    renderExpandedRow,
    virtualize,
    empty,
    compact = false,
    className,
    id,
  } = props;

  const generatedId = useId();
  const captionId = `${id ?? generatedId}-caption`;

  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Whether the reader has asked for focus to follow the active row. Held in a ref rather than in
  // state because it is intent, not rendered output: it is written by the key handlers and cleared
  // by the focus effect, so mounting a table - or re-rendering one for any other reason - never
  // steals focus from wherever the reader actually is.
  const focusPendingRef = useRef(false);

  // `null` until the reader navigates, which is what lets an externally selected row own the tab
  // stop until then. See `resolveActiveIndex` for the precedence and the clamping.
  const [navigatedIndex, setNavigatedIndex] = useState<number | null>(null);

  const rowCount = rows.length;
  const columnCount = columns.length;
  const canExpand = renderExpandedRow !== undefined;
  const canToggle = canExpand && onRowToggle !== undefined;
  const selectionInUse = selectedRowKey !== undefined;

  // One pass over the rows produces every derived structure the render needs: the row models with
  // their exact ARIA indices, the key lookup, and the grid's row count. Expanded detail rows
  // occupy row indices of their own, so the running total of expanded rows before a given row is
  // what shifts that row's index - which is why this is one ordered walk rather than three
  // independent lookups.
  const { models, indexByKey, ariaRowCount } = useMemo<DataTableRowIndex<Row>>(() => {
    const expandedKeys = new Set<string>(expandedRowKeys ?? []);
    const nextModels: DataTableRowModel<Row>[] = [];
    const nextIndexByKey = new Map<string, number>();
    let expandedBefore = 0;

    // `rows.entries()` rather than an index loop: it yields the element as `Row`, where
    // `rows[index]` would yield `Row | undefined` under `noUncheckedIndexedAccess` and force a
    // guard that can never fail.
    for (const [index, row] of rows.entries()) {
      const key = rowKey(row, index);
      const expanded = canExpand && expandedKeys.has(key);
      const ariaRowIndex = FIRST_DATA_ARIA_ROW_INDEX + index + expandedBefore;

      nextModels.push({
        key,
        row,
        expanded,
        ariaRowIndex,
        detailAriaRowIndex: ariaRowIndex + 1,
      });
      nextIndexByKey.set(key, index);

      if (expanded) {
        expandedBefore += 1;
      }
    }

    return {
      models: nextModels,
      indexByKey: nextIndexByKey,
      ariaRowCount: HEADER_ARIA_ROW_INDEX + rows.length + expandedBefore,
    };
  }, [rows, rowKey, expandedRowKeys, canExpand]);

  // The grid track template, inherited by every row through `--dgc-columns`. Relational tracks
  // only: a column's `width` is a grid track, never a literal length (AAP 0.6.4).
  const columnTemplate = useMemo(
    () => columns.map((column) => column.width ?? DEFAULT_COLUMN_TRACK).join(' '),
    [columns],
  );

  const virtualization = useMemo(
    () => resolveVirtualization(virtualize, rowCount),
    [virtualize, rowCount],
  );
  const virtualizationEnabled = virtualization.enabled;

  // Called unconditionally, whatever the mode: a hook behind a condition is a rules-of-hooks
  // violation, and an instance that exists but drives nothing costs one object.
  //
  // `react-hooks/incompatible-library` reports that this API returns functions the React Compiler
  // cannot memoize safely, so it skips auto-memoizing this component. That is suppressed rather
  // than worked around, on two grounds. AAP 0.6.2 names `@tanstack/react-virtual` as the
  // virtualization mechanism and this is the one module in the package permitted to use it, so
  // there is no alternative API to reach for. And the consequence the rule warns about does not
  // arise here: like every other primitive in this package, this component re-renders with its
  // parent by design - the product reports on its own render behaviour rather than smoothing it
  // over - and nothing the virtualizer returns is handed to a memoized component. What leaves
  // this module is the caller's own rows, columns and callbacks.
  // eslint-disable-next-line react-hooks/incompatible-library -- AAP 0.6.2 mandates this API here
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => virtualization.estimateRowHeight,
    overscan: virtualization.overscan,
    enabled: virtualizationEnabled,
    // Measurements follow the row's identity rather than its position, so a re-sort or a re-page
    // does not attribute one row's measured height to another.
    getItemKey: (index) => models[index]?.key ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const viewportHeight = virtualizer.scrollRect === null ? 0 : virtualizer.scrollRect.height;
  const firstRenderedIndex = virtualItems[0]?.index;

  // THE MEASUREMENT-UNAVAILABLE FALLBACK - do not remove it, and do not narrow it to the item
  // check alone. Virtualization only drives the render when the virtualizer has actually measured
  // a viewport and produced a window; when it has not, every row renders in normal flow. Two real
  // environments land here: happy-dom, where `getBoundingClientRect()` answers zeroes so no
  // viewport can be measured - the environment every `src/components/*.test.tsx` suite mounts
  // these tables in, which without this fallback would see an empty table and fail the `pnpm test`
  // gate for reasons unrelated to the components under test - and the first paint of a real
  // browser, before the scroll element has been observed. AAP 0.4.2 caps a result at 5 000 rows,
  // so the fallback renders a bounded table rather than an unbounded one.
  const isVirtualized = virtualizationEnabled && virtualItems.length > 0 && viewportHeight > 0;

  const selectedIndex =
    selectedRowKey === undefined || selectedRowKey === null
      ? undefined
      : indexByKey.get(selectedRowKey);
  const activeIndex = resolveActiveIndex(navigatedIndex, selectedIndex, rowCount);

  // The roving tab stop has to EXIST in the DOM whenever rows are rendered, and under
  // virtualization the active row can sit far outside the rendered window - scroll a long table
  // away from row one and every rendered row would carry `tabIndex={-1}`, leaving the body
  // unreachable by Tab. While the active row is outside the window, the topmost rendered row
  // takes the tab stop instead; the key handlers read the origin row's own index, so navigation
  // continues from wherever the reader actually entered.
  const activeIsRendered =
    !isVirtualized || virtualItems.some((item) => item.index === activeIndex);
  const tabStopIndex =
    activeIsRendered || firstRenderedIndex === undefined ? activeIndex : firstRenderedIndex;

  const handleSortActivate = useCallback(
    (column: DataTableColumn<Row>): void => {
      if (onSortChange === undefined) {
        return;
      }

      // The next sort is REPORTED, never applied: the rows keep the order the data layer gave them
      // until the caller comes back with a new page (AAP 0.4.2).
      onSortChange(nextSortFor(column, sort));
    },
    [onSortChange, sort],
  );

  const moveActiveRow = useCallback(
    (target: number): void => {
      if (rowCount === 0) {
        return;
      }

      const clamped = Math.min(Math.max(target, 0), rowCount - 1);

      focusPendingRef.current = true;
      setNavigatedIndex(clamped);

      // Scroll first, focus second: under virtualization the row may not be mounted yet, and the
      // focus effect waits for the window that this scroll brings into range.
      if (isVirtualized) {
        virtualizer.scrollToIndex(clamped);
      }
    },
    [isVirtualized, rowCount, virtualizer],
  );

  const activateRow = useCallback(
    (index: number): void => {
      if (onRowActivate === undefined) {
        return;
      }

      const model = models[index];

      if (model === undefined) {
        return;
      }

      onRowActivate(model.row, index);
    },
    [models, onRowActivate],
  );

  const toggleRow = useCallback(
    (index: number): void => {
      if (onRowToggle === undefined) {
        return;
      }

      const model = models[index];

      if (model === undefined) {
        return;
      }

      onRowToggle(model.row, index);
    },
    [models, onRowToggle],
  );

  const handleRowClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, index: number): void => {
      const target = event.target;

      // Narrowed rather than cast: a synthetic event's target is an `EventTarget`, and only an
      // `Element` can be asked what it sits inside.
      if (!(target instanceof Element)) {
        return;
      }

      // A chip, link, field or toggle inside a cell owns its own click (see
      // INTERACTIVE_DESCENDANT_SELECTOR), so the row is not activated as well.
      if (target.closest(INTERACTIVE_DESCENDANT_SELECTOR) !== null) {
        return;
      }

      // The pointer has already moved focus to the row, so no programmatic focus is wanted - but
      // the roving tab stop follows the click, so the next Arrow key moves from here.
      focusPendingRef.current = false;
      setNavigatedIndex(index);
      activateRow(index);
    },
    [activateRow],
  );

  // The active row follows real DOM focus, wherever that focus came from - a Tab into the body, a
  // click, a `scrollIntoView` that landed on a different row than the one this component last
  // nominated. Without this, the row a reader is standing on can lose the active state (and with
  // it the design system's focus ring, which `components.css` couples to `dg-is-active`) to
  // whichever row the roving fallback above happens to name after a scroll.
  const handleFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const originIndex = readRowIndex(target);

    if (originIndex === undefined) {
      return;
    }

    // Focus has arrived where it belongs, so any outstanding programmatic request is satisfied.
    focusPendingRef.current = false;
    setNavigatedIndex(originIndex);
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      // Only keys pressed on a data row itself are the table's to handle. A header sort control
      // and a control inside a cell both bubble through this handler, and neither carries the row
      // index attribute, so Enter on a sort button sorts without also activating a row.
      const originIndex = readRowIndex(target);

      if (originIndex === undefined) {
        return;
      }

      // `preventDefault` is called only for the keys actually handled below, so Escape still
      // closes a `Tooltip`, Tab still leaves the body and every unhandled key keeps its meaning.
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActiveRow(originIndex + 1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          moveActiveRow(originIndex - 1);
          return;
        case 'Home':
          event.preventDefault();
          moveActiveRow(0);
          return;
        case 'End':
          event.preventDefault();
          moveActiveRow(rowCount - 1);
          return;
        case 'PageDown':
          event.preventDefault();
          moveActiveRow(originIndex + PAGE_JUMP_ROWS);
          return;
        case 'PageUp':
          event.preventDefault();
          moveActiveRow(originIndex - PAGE_JUMP_ROWS);
          return;
        case 'Enter':
        case ' ': {
          if (onRowActivate === undefined) {
            return;
          }

          // Space would otherwise scroll the viewport out from under the row it just activated.
          event.preventDefault();
          activateRow(originIndex);
          return;
        }
        case 'ArrowRight':
        case 'ArrowLeft': {
          if (!canToggle) {
            return;
          }

          const model = models[originIndex];

          if (model === undefined) {
            return;
          }

          // Right opens, Left closes, and neither repeats the state the row is already in - an
          // Arrow Right on an open row keeps its default meaning instead of collapsing it.
          if (model.expanded === (event.key === 'ArrowRight')) {
            return;
          }

          event.preventDefault();
          toggleRow(originIndex);
          return;
        }
        default:
          return;
      }
    },
    [activateRow, canToggle, models, moveActiveRow, onRowActivate, rowCount, toggleRow],
  );

  // Focus follows the active row, but only when a key handler asked for it. The row is resolved
  // from the DOM rather than held in a ref because under virtualization it may not have existed
  // when the key was pressed: `virtualItems` is a dependency, so a scroll that brings the row into
  // the window runs this again and the pending request survives until the row is there.
  useEffect(() => {
    if (!focusPendingRef.current || activeIndex < 0) {
      return;
    }

    const viewport = viewportRef.current;

    if (viewport === null) {
      return;
    }

    const windowed = virtualItems.length > 0;

    if (windowed && !virtualItems.some((item) => item.index === activeIndex)) {
      return;
    }

    const candidate = viewport.querySelector(rowSelector(activeIndex));

    if (!(candidate instanceof HTMLElement)) {
      return;
    }

    focusPendingRef.current = false;
    candidate.focus();
  }, [activeIndex, virtualItems]);

  const gridStyle: CssVariableStyle = { '--dgc-columns': columnTemplate };
  const canvasStyle: CssVariableStyle | undefined = isVirtualized
    ? { '--dgc-virtual-total': String(virtualizer.getTotalSize()) }
    : undefined;

  /**
   * One data row, its cells and - when open - its detail row, inside the positioning wrapper.
   *
   * A plain function called during this component's render, not a component: it closes over the
   * columns, handlers and flags resolved above, so the two row paths (windowed and whole) render
   * byte-identical markup and the difference between them stays where it belongs - in the
   * geometry.
   *
   * @param model The row model from the single index pass above.
   * @param index The row's index in `rows`.
   * @param offset Its offset in CSS pixels when the window is positioning rows, else `undefined`.
   * @returns The wrapper element.
   */
  const renderRow = (
    model: DataTableRowModel<Row>,
    index: number,
    offset: number | undefined,
  ): ReactElement => {
    const positioned = offset !== undefined;
    const isSelected = selectionInUse && model.key === selectedRowKey;
    const isActive = index === tabStopIndex;
    const wrapperStyle: CssVariableStyle | undefined = positioned
      ? { '--dgc-virtual-start': String(offset) }
      : undefined;

    return (
      <div
        key={model.key}
        // `presentation` removes this wrapper from the accessibility tree so its `row` children
        // are exposed under the rowgroup. It carries no other ARIA attribute, because any one of
        // them would void the role and break the grid's required structure.
        role="presentation"
        className={positioned ? 'dg-virtual-row' : undefined}
        data-index={index}
        // Measurement is attached only while the window is real, so the fallback path above does
        // not measure rows whose environment cannot measure anything.
        ref={isVirtualized ? virtualizer.measureElement : undefined}
        style={wrapperStyle}
      >
        <div
          role="row"
          aria-rowindex={model.ariaRowIndex}
          aria-selected={selectionInUse ? isSelected : undefined}
          aria-expanded={canExpand ? model.expanded : undefined}
          // The roving tab stop: one row in the body is tabbable, and the header's sort controls
          // stay reachable in their own right.
          tabIndex={isActive ? 0 : -1}
          // Written literally so the attribute is visible where the row is; ROW_INDEX_ATTRIBUTE
          // is the same name, and `readRowIndex`/`rowSelector` are the only readers of it.
          data-row-index={index}
          className={clsx(
            'dg-data-table__row',
            isSelected && 'dg-is-selected',
            isActive && 'dg-is-active',
            model.expanded && 'dg-is-expanded',
          )}
          onClick={(event) => {
            handleRowClick(event, index);
          }}
        >
          {columns.map((column, columnIndex) => {
            const cellStyle: CssVariableStyle = {
              '--dgc-align': column.align ?? DEFAULT_COLUMN_ALIGN,
            };

            return (
              <div
                key={column.key}
                // The identity column is the row's header, so a reader hears the row named as
                // they move across it.
                role={column.rowHeader === true ? 'rowheader' : 'gridcell'}
                aria-colindex={columnIndex + 1}
                className="dg-data-table__cell"
                style={cellStyle}
              >
                {column.cell(model.row, index)}
              </div>
            );
          })}
        </div>
        {model.expanded && renderExpandedRow !== undefined ? (
          <div
            role="row"
            aria-rowindex={model.detailAriaRowIndex}
            className="dg-data-table__expanded"
          >
            <div role="gridcell" aria-colindex={1} aria-colspan={columnCount}>
              {renderExpandedRow(model.row, index)}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div id={id} className={clsx('dg-data-table', compact && 'dg-data-table--compact', className)}>
      <Text
        as="div"
        id={captionId}
        size="sm"
        weight="medium"
        className={clsx('dg-data-table__caption', !captionVisible && 'dg-visually-hidden')}
      >
        {caption}
      </Text>
      <div className="dg-virtual-viewport" ref={viewportRef}>
        {/* The grid, and nothing between it and the rowgroups: `grid` accepts only `row` and
            `rowgroup` children, which is why the scroll container above carries no role. */}
        <div
          role="grid"
          aria-labelledby={captionId}
          aria-rowcount={ariaRowCount}
          aria-colcount={columnCount}
          style={gridStyle}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
        >
          <div role="rowgroup" className="dg-data-table__head">
            <div role="row" aria-rowindex={HEADER_ARIA_ROW_INDEX}>
              {columns.map((column, columnIndex) => {
                const headerStyle: CssVariableStyle = {
                  '--dgc-align': column.align ?? DEFAULT_COLUMN_ALIGN,
                };
                const sortable = column.sortable === true && onSortChange !== undefined;

                return (
                  <div
                    key={column.key}
                    role="columnheader"
                    aria-colindex={columnIndex + 1}
                    // The ordering is reported by the CELL, never by the control inside it: a
                    // reader asks the column how it is sorted, not the button.
                    aria-sort={resolveAriaSort(column, sort)}
                    className="dg-data-table__header-cell"
                    style={headerStyle}
                  >
                    {sortable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="dg-data-table__sort-button"
                        // The header node names the control; `headerLabel` overrides it when that
                        // node is a glyph or an abbreviation a reader could not read out.
                        aria-label={column.headerLabel}
                        onClick={() => {
                          handleSortActivate(column);
                        }}
                      >
                        {column.header}
                      </Button>
                    ) : (
                      <Text size="sm" weight="medium">
                        {column.header}
                      </Text>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {rowCount === 0 ? null : (
            <div role="rowgroup" className="dg-virtual-canvas" style={canvasStyle}>
              {isVirtualized
                ? virtualItems.map((item) => {
                    const model = models[item.index];

                    return model === undefined ? null : renderRow(model, item.index, item.start);
                  })
                : models.map((model, index) => renderRow(model, index, undefined))}
            </div>
          )}
        </div>
        {/* Outside the grid on purpose: a message row inside the body would be announced as data.
            The header stays mounted, so column context and the sort controls survive an empty
            result. */}
        {rowCount === 0 ? (
          empty === undefined ? (
            <EmptyState message={DEFAULT_EMPTY_MESSAGE} />
          ) : (
            empty
          )
        ) : null}
      </div>
    </div>
  );
}
