/*
 * DataTable - the tabular workhorse of @debuggen/panel-renderer.
 *
 * Library primitives replace raw `<table>` markup everywhere above the primitives layer, so every
 * grid of rows in the product resolves to this one component: the slowest-operations table, the
 * render statistics table, the request table with its duplicate groups and the redacted query
 * table of the node catalog, plus the modification list of the editor webview. Those surfaces
 * supply columns, rows, a row key and - where they need one - an expansion renderer, and they
 * re-implement nothing: sorting, virtualization, selection, expansion and keyboard operation all
 * live here.
 *
 * ## The four pillars, and how each is met
 *
 *   Generic over a row type. {@link DataTable} is a generic function - not an `FC`, which cannot
 *   carry a call-site type parameter cleanly - so `Row` is inferred from `rows` and every
 *   {@link DataTableColumn.cell} renderer receives that exact type. No `unknown`, no index
 *   signature and no cast stands between a caller's aggregate shape and its cells.
 *
 *   Sortable, and CONTROLLED. Clicking a sortable header computes the next {@link DataTableSort}
 *   (same key flips the direction, a different key takes that column's
 *   {@link DataTableColumn.defaultSortDirection}) and raises `onSortChange`. It never sorts,
 *   re-orders, slices or pages `rows`, because `POST /sessions/:id/panel-data` applies
 *   `filter`, `sort` (with a stable secondary key) and `limit`/`offset` server-side and
 *   answers with `total`/`nextOffset`, so the rows arrive already ordered and a page is a window
 *   onto a larger result. Sorting a page locally would silently re-order only the visible slice -
 *   a table that looks sorted and is not, which is worse than one that plainly is not. The current
 *   order is reported to assistive technology through `aria-sort` on the header cell.
 *
 *   The word that matters there is SILENTLY. A caller whose data layer cannot apply an order a
 *   reader asked for may arrange the rows it already holds itself - `components/SpanTable` does,
 *   for every column and direction outside the data layer's vocabulary - provided it passes the
 *   arranged rows and that order as `sort`, and says in its own copy how much of the result the
 *   order covers. The decision and the disclosure stay with the component that owns the data;
 *   this primitive still renders `rows` exactly as given and never re-orders them itself.
 *
 *   Virtualized with `@tanstack/react-virtual`. This is the only module in the package that
 *   imports it. Long lists render a window of rows inside the shared
 *   `dg-virtual-viewport`/`dg-virtual-canvas`/`dg-virtual-row` triplet, and real measured heights
 *   replace the estimate after first paint. The window always holds the active row as well,
 *   wherever it is, so the row that has focus never unmounts under a scroll and a key that moves
 *   the active row far away renders its target at once. The panel-data route caps a result at
 *   5 000 rows, which is both why virtualization here buys smoothness rather than survival and why
 *   the state before the first measurement is bounded rather than whole - see the section on it
 *   below.
 *
 *   Keyboard-navigable. A roving `tabIndex` makes the whole grid a single Tab stop - the active
 *   row - and the keyboard reaches everything else from there: Arrow keys, Home, End and
 *   PageUp/PageDown move the active row, Enter and Space activate it, Arrow Right/Left expand and
 *   collapse it, Tab walks the controls of the active row and its open detail, and the arrow keys
 *   move focus onto those controls and the header's too. A visually hidden description tells
 *   assistive technology how. See the keyboard section below for the full key map and the one
 *   obligation it places on every caller.
 *
 * ## The ARIA structure, and why it is shaped this way
 *
 *   div.dg-data-table                     the block
 *     div.dg-data-table__caption          the accessible name, visually hidden unless asked for
 *     div.dg-visually-hidden              the keyboard description, while rows exist
 *     div.dg-virtual-viewport             the SCROLL CONTAINER, and deliberately ROLE-LESS
 *       div[role=grid]                    named by the caption, described by the keyboard
 *                                         description, exact aria-rowcount/aria-colcount
 *         div[role=rowgroup].__head
 *           div[role=row]                   aria-rowindex=1
 *             div[role=columnheader]         aria-colindex, aria-sort, one per column
 *         div[role=rowgroup].dg-virtual-canvas
 *           div[role=presentation].dg-virtual-row   the POSITIONING wrapper, data-index
 *             div[role=row]                         the data row: aria-rowindex, tabIndex,
 *                                                   data-row-index - and never aria-expanded
 *               div[role=rowheader|gridcell]        aria-colindex, one per column
 *             div[role=row].__expanded              the detail row, when open: an id (what
 *                                                   the toggle's aria-controls names) and
 *                                                   data-detail-row-index (its data row)
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
 * ## Where the expanded state lives, and why it is not on the row
 *
 * `aria-expanded` is not a supported state of a `row` inside a `grid`: ARIA allows it on rows of
 * a `treegrid` only, and an accessibility audit reports every such row as a conditional-attribute
 * failure. Switching the role to `treegrid` is not the answer either. A treegrid describes a
 * HIERARCHY of rows, and a detail row here is not a child row of the same kind - it is a
 * disclosure of one row's evidence - so the role would promise a reader nesting levels,
 * `aria-level` and child rows that do not exist. The state therefore lives where the APG
 * disclosure pattern puts it: on the control that toggles it. Each cell receives a
 * {@link DataTableCellMeta}, and the caller's expand toggle carries
 * `aria-expanded={meta.expanded}` and `aria-controls={meta.detailRowId}`. `detailRowId` is the id
 * of the detail row this component renders, and it is defined only while that row is actually in
 * the DOM, so `aria-controls` never names a missing element. The row keeps the `dg-is-expanded`
 * class, which is appearance rather than semantics.
 *
 * ## The keyboard model: one Tab stop, and one row's controls behind it
 *
 * This is the APG grid pattern. Tab enters the grid on ONE element: the active row (`tabIndex={0}`,
 * every other row `-1`). From there Tab walks the controls of THAT row only - its cells, then its
 * open detail - and the Tab after its last control leaves the grid. A row's actions are therefore
 * reachable by the key a reader tries first, while passing a grid of a thousand rows still costs
 * one row's worth of stops. A grid whose cells each added Tab stops of their own would make a
 * reader press Tab through every chip, badge and toggle of every rendered row just to get past one
 * table.
 *
 * THE CALLER'S OBLIGATION: every focusable control a `cell` or `renderExpandedRow` renders carries
 * `tabIndex={-1}`. It stays focusable - by pointer, and by the keys below, Tab in the active row
 * included - and it leaves the document's Tab order, so no other row's controls become stops. The
 * header's sort controls follow the same rule, applied here: they are `tabIndex={-1}` whenever at
 * least one data row renders, because ArrowUp from the first row reaches them, and they keep their
 * default while the result is empty, when there is no row to arrive through.
 *
 * On a data row:
 *
 *   ArrowDown / ArrowUp        the next / previous row. ArrowUp on the first row moves to the
 *                              header's first control when the header has one.
 *   Home / End                 the first / last row.
 *   PageDown / PageUp          ten rows down / up.
 *   Enter / Space              activate the row (`onRowActivate`). With no `onRowActivate`, Enter
 *                              moves into the row instead and Space keeps its native meaning.
 *   F2                         move into the row: focus its first control.
 *   Tab                        move into the row the same way. A row with no control leaves Tab
 *                              to the browser, which leaves the grid.
 *   Shift+Tab                  the browser's: it leaves the grid backwards, since every row and
 *                              control before the active row is out of the Tab order.
 *   ArrowRight                 expand a collapsed expandable row; otherwise move into the row.
 *   ArrowLeft                  collapse an expanded row; otherwise nothing.
 *
 * On a control inside a row's cells or its open detail row - one scope, in document order:
 *
 *   ArrowRight / ArrowLeft     the next / previous control. ArrowLeft from the first control
 *                              returns to the row; ArrowRight on the last stays put.
 *   Home / End                 the first / last control of the scope.
 *   ArrowDown / ArrowUp        the next / previous row, or ten rows for PageDown / PageUp,
 *   PageDown / PageUp          counted from the row the control belongs to.
 *   Escape                     back to the row. A key something inside already consumed is not
 *                              answered, so the first Escape on an open `Tooltip` trigger closes
 *                              the bubble and only the second returns to the row.
 *   Tab / Shift+Tab            the next / previous control of the scope. Shift+Tab from the first
 *                              control returns to the row. Tab from the last is the browser's, and
 *                              leaves the grid: nothing after it in the grid is a Tab stop.
 *   Enter, Space, others       the control's own. A key pressed on a control never activates the
 *                              row.
 *
 *   Two kinds of control keep their keys. A text or choice widget - `input`, `textarea`, `select`,
 *   a contenteditable host, `role` textbox, combobox, slider or spinbutton - uses the arrows and
 *   Home/End itself and gets only Escape and Tab from the grid; Tab moves no caret, so a field
 *   takes its place in the row's Tab sequence like any other control. An element that actually
 *   scrolls along a key's axis - a focusable code block whose content overflows it - keeps that
 *   axis's keys, so it still scrolls. A key a control has already `preventDefault`-ed is left to
 *   that control.
 *
 * On a header control:
 *
 *   ArrowRight / ArrowLeft     the next / previous header control.
 *   Home / End                 the first / last header control.
 *   ArrowDown / Escape         back to the active row.
 *   Enter / Space              native, so a sort control still sorts.
 *
 * Tab and Shift+Tab therefore trace one path with no trap in it: in on the active row, forward
 * across its controls and out, or back across them to the row and out. Every Tab that would leave
 * the row's scope is left to the browser - never prevented - and so is a Tab with Alt, Control or
 * Meta held, a Tab an input method is composing with, and a Tab whose next stop inside the row is
 * a Tab stop of the document's own (the active row of a grid nested in a cell): this table never
 * skips past a stop the browser would visit. Focus landing on a control by any route - Tab, an
 * arrow key or a pointer click - moves the roving stop to that control's row, so Tab back into the
 * grid returns to where the reader last was.
 *
 * The key map is announced as well as documented. The grid's `aria-describedby` names a visually
 * hidden sentence - `dg-visually-hidden`, beside the caption and outside the grid, which accepts
 * only rows and rowgroups - naming the keys that move between rows, what Enter does in THIS table
 * (activate the row, or move into it), whether Right arrow expands, and how Tab, F2 and Escape
 * reach a row's controls and leave them. It is generic product copy chosen by the props, and it is
 * rendered only while rows exist, since an empty grid has no row to operate.
 *
 * A control is reachable when it matches `a[href], button, input, select, textarea, [tabindex]`,
 * is not disabled, and does not sit inside `[hidden]`, `[inert]` or `[aria-hidden="true"]`. That
 * is decided from the DOM alone and never from layout, so it holds identically in a browser and in
 * an environment that measures nothing. A grid nested inside a cell answers its own keys: this
 * table ignores every event whose nearest grid is not its own and never moves focus into another
 * grid's rows. `preventDefault` is called only for a key actually handled, so every other key
 * keeps its meaning.
 *
 * The empty content renders OUTSIDE the grid's rowgroup. A message row inside the body would be
 * announced as data ("row 2 of 2"), and the header stays mounted so column context and the sort
 * controls remain available while the result is empty.
 *
 * ## What renders before anything has been measured, and why it is bounded
 *
 * When virtualization is on but `virtualizer.getVirtualItems()` is empty while rows exist, the
 * virtualizer has measured no viewport and can produce no window, so rows render in normal flow
 * instead. Two states produce exactly that: the first paint of a real browser, before the scroll
 * element has been observed, and an environment that can measure nothing at all - happy-dom, where
 * every rect and every `offsetHeight` answer zero, which is the environment the component suites of
 * this package mount these tables in. Rows MUST render in that state: a table that showed nothing
 * until a measurement arrived would flash empty in the panel and would render empty in every such
 * suite, failing the `pnpm test` gate for reasons that have nothing to do with the components under
 * test.
 *
 * How many rows render there is the part that is bounded. The panel-data route caps a result at
 * 5 000 rows, and creating 5 000 rows with all of their cells - only to replace them with a window
 * of thirty on the next commit - is a first paint the reader waits through. So the unmeasured
 * state renders {@link DEFAULT_UNMEASURED_WINDOW_ROWS} rows, or as many as
 * {@link DataTableVirtualizeOptions.unmeasuredWindowRows} asks for, anchored on the active row
 * rather than pinned to row zero so that the roving tab stop is always one of them (see
 * `resolveFlowRowRange`), while the canvas still advertises the scroll range of the whole result
 * through `--dgc-virtual-total` so the scrollbar is right from that first paint.
 *
 * Two things ask for every row instead, and both are explicit:
 *
 *   `virtualize={false}` (or `{ enabled: false }`) turns virtualization off altogether and keeps
 *   every row in the DOM permanently - what a surface that prints, searches or text-selects the
 *   whole table needs.
 *
 *   `virtualize={{ enabled: true, unmeasuredWindowRows: 'all' }}` keeps virtualization on and lifts
 *   the bound only while nothing has been measured. It is for a suite that must assert against
 *   every row of a table it renders under happy-dom, where no measurement will ever arrive.
 *
 * A note for those suites, before either is reached for: a table of
 * {@link AUTO_VIRTUALIZE_ROW_THRESHOLD} rows or fewer with `virtualize` omitted is not virtualized
 * at all and renders whole anyway, so a fixture of that size needs neither escape hatch.
 *
 * ## Zero hardcoded CSS, and the geometry channel
 *
 * Every visual value resolves to a `--dg-*` token, so not one colour, length, radius or font
 * appears in this module. Appearance is class names, which `../styles/components.css` resolves to
 * `var(--dg-*)` tokens: surfaces from `--dg-surface-base`/`--dg-surface-elevated`, rules from
 * `--dg-border-subtle`/`--dg-border-strong`, density from `--dg-space-*`, type from
 * `--dg-text-sm`/`--dg-text-xs` and `--dg-font-mono` with tabular figures for numeric columns,
 * selection from `--dg-accent`/`--dg-accent-muted` and focus from `--dg-focus-ring`. The class
 * contract this file DECLARES, and that `components.css` must implement:
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
 * Eight component-scoped custom properties carry the values only this module can know - computed
 * geometry, which `../styles/base.css` sanctions inline for exactly this purpose - and they are
 * the only thing any `style` attribute here contains:
 *
 *   --dgc-columns         the grid track template, consumed by each row as
 *                         `grid-template-columns: var(--dgc-columns, …)`. Every track is one of
 *                         {@link DATA_TABLE_COLUMN_TRACKS}, built from `--dg-column-min-*`,
 *                         `--dg-column-share-*` and `--dg-column-yield` tokens and the three
 *                         properties below only. The header row and each data row are SEPARATE
 *                         grid containers - a positioned row cannot share a parent's tracks - so
 *                         a track only lines a header up with its column because every role
 *                         track resolves to the same width in every row; see
 *                         {@link DataTableColumn.width}.
 *   --dgc-min-inline      the sum of the tracks' guaranteed MINIMUMS
 *                         (`calc(calc(var(--dg-column-min-name) * var(--dg-column-yield)) +
 *                         var(--dg-column-min-quantity) + …)`),
 *   --dgc-readable-inline the sum of the tracks' readable FLOORS
 *                         (`calc(var(--dg-column-min-name) + var(--dg-column-min-quantity) + …)`),
 *                         written only when a truncating column makes it differ from the first,
 *   --dgc-yield-count     the number of truncating tracks, written under the same condition, and
 *   --dgc-column-count    the number of tracks. Together they give the grid its floor and each
 *                         truncating track its minimum, under one rule: a TRUNCATING column
 *                         (`name`, `text`) gives up width only when that makes the whole table
 *                         fit. A panel wide enough for every readable floor lays the table out
 *                         at those floors. A narrower panel narrows its names and free text -
 *                         each by an equal share of the shortfall, never below
 *                         `--dg-column-yield` of its floor - just far enough for the table to
 *                         fit, while every compact column (a figure, a status, a label, a row's
 *                         action control) keeps its full floor and stays in view. Below the
 *                         width at which even the yielded minimums fit, narrowing no longer
 *                         saves the scroll, so the columns take the yield back at once -
 *                         within a fraction of a pixel, `--dg-column-yield-return-scale` -
 *                         and the table SCROLLS HORIZONTALLY inside its viewport with every
 *                         column at its readable floor, exactly as a table with no truncating
 *                         column does - never squeezing tracks to nothing and painting one
 *                         cell's content over the next. `../styles/components.css`
 *                         states the grid half of the rule; {@link DATA_TABLE_COLUMN_TRACKS}
 *                         the track half.
 *   --dgc-virtual-total   the canvas height as a UNITLESS number, consumed as
 *                         `min-block-size: calc(var(--dgc-virtual-total, 0) * var(--dg-pixel-unit))`
 *   --dgc-virtual-start   a row's offset as a UNITLESS number, consumed as
 *                         `inset-block-start: calc(var(--dgc-virtual-start, 0) * var(--dg-pixel-unit))`.
 *                         An inset, not a transform: a transformed ancestor is the containing block
 *                         of every fixed-position descendant, and it would trap the `./Tooltip`
 *                         bubbles of a positioned row inside the scroll container they must escape.
 *   --dgc-align           a cell's alignment keyword, consumed as `text-align: var(--dgc-align, start)`
 *
 * The two virtualization properties are unitless on purpose: they are numbers the virtualizer
 * measured in CSS pixels, not design values, and the stylesheet gives them their unit through the
 * `--dg-pixel-unit` token, so no length unit is written anywhere outside the token table.
 *
 * A newly expanded row is scrolled into view once its detail row has rendered: the detail opens
 * BELOW the row inside a viewport capped at a fixed height, so without it a toggle on one of the
 * last visible rows would open content the reader cannot see. The scroll keeps the toggled row
 * itself below the sticky header - see {@link revealExpandedRow}.
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
 * arrives through the host's provider interface and interactions leave through `PanelActions`, so
 * no panel component touches a transport.
 *
 * ## Building on this
 *
 * A table component supplies `columns` (key, header, alignment, optional width role, cell
 * renderer), `rows` exactly as the data source ordered them (or as the caller itself arranged
 * them, under the disclosure rule above), `rowKey`, a `caption`, the controlled
 * `sort` plus `onSortChange`, and - when rows have detail - `expandedRowKeys`, `onRowToggle` and
 * `renderExpandedRow`. It renders its own expand affordance as a `Button` inside a cell, and that
 * toggle carries `aria-expanded={meta.expanded}` and `aria-controls={meta.detailRowId}` from the
 * {@link DataTableCellMeta} its cell receives - the row itself never reports the state (see the
 * section on where the expanded state lives). A click on any interactive descendant is not
 * treated as a row activation, so the two never fire together. It does not sort, page,
 * virtualize or handle keys itself.
 */

import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Range } from '@tanstack/react-virtual';
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

import { cssVar } from '../tokens/tokens';
import type { TokenKey } from '../tokens/tokens';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Text } from './Text';

/**
 * The semantic width ROLE a column is sized by - what kind of content it holds, never how wide it
 * is in some unit a caller picked.
 *
 *   ordinal    a short position number: an event sequence number, a plan version. A FIXED track:
 *              the column takes its floor and no spare width, so the figures it holds never drift
 *   count      an integer tally, with room for a compact badge beside it
 *   quantity   a formatted measurement with its unit: a duration, a time, an offset, a byte size
 *   status     a short status word or badge, a tier, or one compact action control
 *   label      a short categorical label: a kind chip, an attribute key, a system or hook name
 *   name       an identifier: a component, operation or file name, a source-location chip.
 *              TRUNCATING: it yields width first in a narrow panel (see below)
 *   text       long free text that truncates: a statement, a URL, a value preview, a caller list.
 *              TRUNCATING, like `name`
 *   standard   the role of a column declared with none: room for a short label or a figure
 *
 * Each role resolves, through {@link DATA_TABLE_COLUMN_TRACKS}, to a grid track built from the
 * `--dg-column-min-*` floor and the `--dg-column-share-*` spare-width share the token table
 * declares for it (`../tokens/tokens.ts`). That is what makes column geometry a design-system
 * decision rather than a per-component one: both extension surfaces and every visualization table
 * agree on how wide a duration or a path column is, and one token edit re-densifies all of them.
 *
 * The floor is the width at which a role's content reads in full. How a column behaves in a panel
 * narrower than the sum of its table's floors depends on whether its content survives being cut:
 *
 *   - `name` and `text` are TRUNCATING roles. Their content ellipsizes or wraps and stays
 *     identifiable, so each can give up width, down to a guaranteed minimum of
 *     `--dg-column-yield` of its floor.
 *   - Every other role is COMPACT: a figure, a status, a label or an action control does not
 *     survive being cut, so the column keeps its full floor.
 *
 * A truncating column gives up width only when that makes the table fit its panel, and only as
 * much as the fit needs: the shortfall is shared equally by the truncating columns, and one that
 * reaches its minimum leaves the rest of the shortfall to the others. A panel just too narrow for
 * every floor therefore truncates its names and free text while its figures, statuses and row
 * controls stay in view, and does not scroll. A panel so narrow that even the minimums overflow
 * gains nothing from truncating, so its columns keep their readable floors and the table
 * scrolls, exactly as a table without truncating columns does. A table with three or more
 * truncating columns of unequal floors can, in the narrowest part of the range in which it fits,
 * overflow by a fraction of one floor's yield and scroll by that much.
 */
export type DataTableColumnWidth =
  'ordinal' | 'count' | 'quantity' | 'status' | 'label' | 'name' | 'text' | 'standard';

/**
 * The grid geometry one {@link DataTableColumnWidth} role resolves to.
 */
export interface DataTableColumnTrack {
  /**
   * The CSS grid track the column takes in every row. A compact role takes
   * `minmax(<floor>, <share>)`, or the bare floor for a fixed role. A truncating role takes
   * `minmax(<applied minimum>, <share>)`, where the applied minimum is
   * `clamp(<minimum>, <floor> - <this column's part of the shortfall>, <floor>)`: the shortfall
   * is the readable floors plus the gaps between tracks less the row's own width (`100%` inside a
   * track is the row's content box), read from `--dgc-readable-inline`, `--dgc-min-inline`,
   * `--dgc-yield-count` and `--dgc-column-count`. Token and property references inside math
   * frames only - it carries no number of its own.
   */
  readonly track: string;

  /**
   * The column's readable FLOOR, `var(--dg-column-min-<role>)`: the width at which its content
   * reads in full. The table sums every floor into `--dgc-readable-inline`.
   */
  readonly floor: string;

  /**
   * The track's guaranteed MINIMUM, as token references: the narrowest it ever becomes. For a
   * compact role it is the floor itself; for a truncating role (`name`, `text`) it is that floor
   * scaled by the yield, `calc(var(--dg-column-min-<role>) * var(--dg-column-yield))`.
   *
   * The table sums every column's minimum into `--dgc-min-inline`, the width below which no
   * narrowing can make it fit - see this module's header for how the grid uses the two sums.
   */
  readonly minimum: string;

  /**
   * Whether the column is TRUNCATING - it may give up width, down to its minimum, so the table
   * fits its panel - or COMPACT, holding its floor at every width.
   */
  readonly yields: boolean;
}

/**
 * How a role's column behaves in a panel too narrow for every column's readable floor.
 *
 *   holds    the column never narrows below its readable floor: a figure, a status, a label or an
 *            action control, none of which survives being cut
 *   yields   the column may narrow to `--dg-column-yield` of its readable floor when that makes the
 *            table fit: a name or free text, which ellipsizes or wraps and stays identifiable, so
 *            it gives up width while the compact columns beside it keep theirs
 */
type FloorBehaviour = 'holds' | 'yields';

/**
 * The three sums a truncating track reads from its grid, which carries them as component-scoped
 * properties (see this module's header). Rows inherit them, so every row resolves the same track.
 */
const READABLE_INLINE = 'var(--dgc-readable-inline)';
const MINIMUM_INLINE = 'var(--dgc-min-inline)';
const YIELD_COUNT = 'var(--dgc-yield-count)';
const COLUMN_COUNT = 'var(--dgc-column-count)';

/**
 * How far the readable floors overrun the row: the floors, plus one `--dg-space-2` gap between
 * each pair of tracks (the row's `gap` in `../styles/components.css`), less the row's content box.
 * Inside a track, `100%` - `--dg-size-full` - is that content box, so the expression is negative
 * whenever every readable floor fits.
 */
const SHORTFALL = `(${READABLE_INLINE} + ${COLUMN_COUNT} * ${cssVar('space2')} - ${cssVar(
  'space2',
)} - ${cssVar('sizeFull')})`;

/**
 * What all the truncating columns together can give up: the readable floors less the minimums.
 * Compact columns contribute nothing, since their minimum is their floor.
 */
const YIELD_CAPACITY = `(${READABLE_INLINE} - ${MINIMUM_INLINE})`;

/**
 * One role's track, built from its floor token and, for a role that shares spare width, its share
 * token.
 *
 * A yielding role's minimum scales the floor by the `columnYield` token inside a `calc()`, so the
 * yielded width stays a design-system value: no factor is written here, and one token edit that
 * changes the yield changes every truncating column in the product at once.
 *
 * A yielding role's track minimum is the floor less this column's part of the shortfall, clamped
 * between its minimum and its floor. Its part is an equal share of the shortfall or, when the
 * other truncating columns cannot absorb theirs, whatever of the shortfall they leave:
 * `max(shortfall / count, shortfall - (capacity - own capacity))`. With a negative shortfall (every
 * floor fits) the clamp returns the floor, and the track is the compact form's.
 *
 * @param floorToken The `columnMin*` token that is the role's readable floor.
 * @param share The `columnShare*` token that is its share of spare width, or `undefined` for a
 *   fixed role that takes its floor and nothing more.
 * @param behaviour Whether the column keeps its full floor (`holds`) or may narrow to its yielded
 *   minimum (`yields`) when that makes the table fit.
 * @returns The role's track, floor and minimum, as token references.
 *
 * @example
 * roleTrack('columnMinStatus', 'columnShareCompact', 'holds');
 * // floor = minimum: 'var(--dg-column-min-status)'
 * // track:           'minmax(var(--dg-column-min-status), var(--dg-column-share-compact))'
 * roleTrack('columnMinName', 'columnShareWide', 'yields');
 * // minimum: 'calc(var(--dg-column-min-name) * var(--dg-column-yield))'
 * // track:   'minmax(clamp(<minimum>, <floor> - max(…), <floor>), var(--dg-column-share-wide))'
 */
function roleTrack(
  floorToken: TokenKey,
  share: TokenKey | undefined,
  behaviour: FloorBehaviour,
): DataTableColumnTrack {
  const floor = cssVar(floorToken);

  if (behaviour === 'holds') {
    return {
      track: share === undefined ? floor : `minmax(${floor}, ${cssVar(share)})`,
      floor,
      minimum: floor,
      yields: false,
    };
  }

  const minimum = `calc(${floor} * ${cssVar('columnYield')})`;
  const part = `max(${SHORTFALL} / ${YIELD_COUNT}, ${SHORTFALL} - ${YIELD_CAPACITY} + ${floor} - ${minimum})`;
  const applied = `clamp(${minimum}, ${floor} - ${part}, ${floor})`;

  return {
    track: share === undefined ? applied : `minmax(${applied}, ${cssVar(share)})`,
    floor,
    minimum,
    yields: true,
  };
}

/**
 * Every column width role and the token-built grid track it resolves to - the single table of
 * column geometry in the product.
 *
 * Figures (counts, quantities, statuses) take the compact share of spare width, labels and unsized
 * columns an equal part, names twice that and free text the most, so a wide panel spends its room
 * where content is longest. In a dock just too narrow for every floor, names and free text narrow
 * - never below their yielded minimum - exactly as far as the table needs to fit, while every
 * figure, status, label and row control keeps its readable floor. When even the minimums would
 * not fit, every column keeps its floor and the table scrolls.
 */
export const DATA_TABLE_COLUMN_TRACKS: Readonly<
  Record<DataTableColumnWidth, DataTableColumnTrack>
> = {
  ordinal: roleTrack('columnMinOrdinal', undefined, 'holds'),
  count: roleTrack('columnMinCount', 'columnShareCompact', 'holds'),
  quantity: roleTrack('columnMinQuantity', 'columnShareCompact', 'holds'),
  status: roleTrack('columnMinStatus', 'columnShareCompact', 'holds'),
  label: roleTrack('columnMinLabel', 'columnShareDefault', 'holds'),
  name: roleTrack('columnMinName', 'columnShareWide', 'yields'),
  text: roleTrack('columnMinText', 'columnShareWidest', 'yields'),
  standard: roleTrack('columnMinStandard', 'columnShareDefault', 'holds'),
};

/**
 * The two directions a column can be ordered in.
 *
 * Spelled the way the data layer spells them (`duration_desc`, `start_asc`, `count_desc` in
 * `DataQuery.sort`), so a caller translating between the two never has to remember a
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
 * What a cell renderer is told about its row beyond the row itself: the row's expansion state, and
 * the id of the detail row that state reveals.
 *
 * It exists because the expanded state cannot live on the row (see this module's header: a
 * `grid` row does not support `aria-expanded`), so it has to reach the control that toggles it -
 * and that control is the caller's, rendered inside a cell. The toggle wires it as
 *
 * ```tsx
 * <Button
 *   tabIndex={-1}
 *   aria-expanded={meta.expanded}
 *   aria-controls={meta.detailRowId}
 *   onClick={() => { toggle(row.id); }}
 * >
 *   {meta.expanded ? 'Hide detail' : 'Show detail'}
 * </Button>
 * ```
 *
 * The same object is handed to every cell of one row, and a new one is built on every render, so
 * a cell must read it rather than hold on to it.
 */
export interface DataTableCellMeta {
  /**
   * Whether the row's detail row is open. Always `false` when the table was given no
   * {@link DataTableProps.renderExpandedRow}: a table with nothing to reveal has no expanded rows,
   * whatever {@link DataTableProps.expandedRowKeys} says.
   */
  readonly expanded: boolean;

  /**
   * The `id` of the row's detail row, for the toggle's `aria-controls`.
   *
   * Defined ONLY while that detail row is actually rendered - the row is expanded and a
   * `renderExpandedRow` was supplied - and `undefined` otherwise, so `aria-controls` never names
   * an element that is not in the document. It is a single id token with no whitespace, built from
   * this table instance's `useId()` base and the row's index, so it is unique in the document and
   * two tables never collide.
   */
  readonly detailRowId: string | undefined;
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
   *
   * A focusable control inside a header node - a `Tooltip` trigger explaining the column - is
   * reached by the header's arrow keys like the sort controls are (see this module's header), and
   * follows the same Tab rule: `tabIndex={-1}` while the table has rows, so the grid stays one Tab
   * stop.
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
   * only when their last digits line up, which is why the design system pairs end alignment with
   * `--dg-font-mono` and tabular figures. The value travels to `components.css` as `--dgc-align`
   * and is a CSS alignment keyword, never a physical direction, so a right-to-left surface stays
   * correct.
   */
  align?: 'start' | 'center' | 'end' | undefined;

  /**
   * The column's semantic width ROLE (see {@link DataTableColumnWidth}), which the table resolves
   * through {@link DATA_TABLE_COLUMN_TRACKS} to a token-built grid track and joins with its
   * siblings into `--dgc-columns`. Omitted, the column takes the `standard` role: an equal share
   * of the free space that never drops below the `--dg-column-min-standard` floor.
   *
   * A role, never a CSS value: a column cannot state `minmax(12ch, 2fr)` or `9ch`, because a
   * number chosen here would be a visual value outside the token table, and every visual value
   * resolves to a `--dg-*` token. Choose the role by the column's CONTENT - the smallest role whose
   * floor keeps that content readable - and the design system decides how wide that is,
   * identically on every surface. Content that must never be cut - a figure, a status, a row's
   * action control - takes a compact role, never `name` or `text`: only those two truncating roles
   * yield width in a narrow panel.
   *
   * Every role has a non-zero floor, and the table sums the floors and the minimums into its own
   * width (`--dgc-readable-inline`, `--dgc-min-inline`, see this module's header). A surface just
   * too narrow for the readable floors narrows its `name` and `text` columns, never below
   * `--dg-column-yield` of their floor, exactly as far as the table needs to fit, while every other
   * column keeps its floor; a surface too narrow even for the minimums keeps every floor and
   * scrolls horizontally, instead of painting one cell over the next. And every role track is a
   * minimum and a ratio, which resolves identically in every row - the header row and each data
   * row are separate grid containers, so an intrinsic track sized from one row's own content would
   * stop sitting under its header.
   */
  width?: DataTableColumnWidth | undefined;

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
   * `SourceLink`, `Button`) rather than raw HTML, since library primitives replace raw markup above
   * the primitives layer. It is called during render, so it must be pure: no fetching, no state, no
   * mutation of the row.
   *
   * EVERY FOCUSABLE CONTROL A CELL RENDERS CARRIES `tabIndex={-1}` - a `Button`, a `SourceLink`
   * (through its `tabIndex` prop), a `Tooltip` trigger, a focusable `Code` block. The grid body is
   * one Tab stop, the active row, and this component's own keys are what reach the controls
   * inside it - Tab and Shift+Tab across the active row's controls, and the arrow keys (see this
   * module's header for the keys). A control left at its default is an extra Tab stop in every
   * rendered row, which is exactly the tab sequence the grid pattern exists to avoid.
   *
   * An expand toggle in a cell also carries `aria-expanded={meta.expanded}` and
   * `aria-controls={meta.detailRowId}`; see {@link DataTableCellMeta}.
   *
   * A two-parameter renderer is still a valid `cell`: a column that has no use for `meta` simply
   * does not declare it.
   *
   * @param row The row, typed exactly as the caller's `rows` element type.
   * @param rowIndex The row's index in `rows` - the caller's own ordering, unchanged by this
   *   component.
   * @param meta The row's expansion state and the id of its detail row; the same object for every
   *   cell of one row.
   */
  cell: (row: Row, rowIndex: number, meta: DataTableCellMeta) => ReactNode;
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

  /**
   * How many rows render while virtualization is ON but no viewport has been measured yet - the
   * first paint of a real browser, before the scroll element has been observed.
   *
   * A COUNT of rows, never a length and never a style value, since every visual value resolves to
   * a token: it decides how many rows exist in the DOM for one frame, and it reaches no class,
   * custom property or declaration.
   * Omitted, the table uses its own bound, which is the same count above which an unqualified
   * table virtualizes itself - so an unmeasured first paint never puts more rows in the DOM than
   * an unvirtualized table of this component would, and never fewer than the viewport can show.
   *
   * `'all'` is the explicit opt-in that keeps EVERY row in the DOM while nothing has been
   * measured, and it exists for an environment with no layout at all: under happy-dom every rect
   * and every `offsetHeight` answer zero, so the virtualizer can never measure a viewport and can
   * never produce a window, which is the state the component test suites of this package mount
   * these tables in. Pass it from a suite that must assert against every row; in a real browser it
   * is the 5 000-row first paint this bound exists to prevent (the panel-data route caps a result
   * at 5 000 rows). {@link DataTableProps.virtualize} `= false` is the other way to get every row,
   * and it is the right one whenever the rows are wanted permanently rather than only until
   * measurement.
   */
  readonly unmeasuredWindowRows?: number | 'all' | undefined;
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
   * The data layer (`POST /sessions/:id/panel-data`) has already applied `filter`, `sort` and
   * `limit`/`offset`, so this component renders the array as given: it never sorts, re-orders,
   * slices or pages it, and it never mutates it.
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
   *
   * A HOST-DRIVEN selection is brought into view: when the key changes to a row the reader did not
   * just activate in this table - a selection made in another view, or by the host surface - and
   * that row lies outside the viewport (or outside the virtualizer's window), this table's own
   * scroll container is scrolled just far enough to show it. Once per change of key, never the
   * page, and never focus: see the reveal effect in the component for the four rules.
   *
   * The selected row is filled with `--dg-accent-muted`, and the stylesheet's selected-surface rule
   * draws every cell's text on it in `--dg-text-primary`, whatever colour the cell renderer's
   * content carries elsewhere; only content that paints a fill of its own (a soft or solid badge, a
   * primary or destructive button) keeps its colours. A cell therefore needs no selected variant of
   * its own to stay above the 4.5:1 text bar.
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
   * Raised when a row's expansion is toggled from the keyboard (Arrow Right on a collapsed row
   * opens it, Arrow Left on an open row closes it). Mouse toggling belongs to the caller's own
   * affordance inside a cell, which keeps the visible control, its icon, its accessible name and
   * its `aria-expanded`/`aria-controls` (see {@link DataTableCellMeta}) in the table component
   * that owns the data.
   *
   * Only wired when `renderExpandedRow` is also supplied: a row with nothing to reveal must not
   * answer an expand key.
   */
  onRowToggle?: ((row: Row, index: number) => void) | undefined;

  /**
   * Renders the detail of an expanded row into a single full-width cell.
   *
   * Supplying it is what enables expansion at all: the detail row, the expand keys, and a
   * {@link DataTableCellMeta} whose `expanded` can be `true` and whose `detailRowId` names the
   * rendered detail row. Omitting it leaves all three off, so a table without detail never claims
   * to have any. The expanded state is NOT reported on the row - `aria-expanded` is not valid on a
   * `grid` row - so the caller's expand toggle must carry `aria-expanded={meta.expanded}` and
   * `aria-controls={meta.detailRowId}`.
   *
   * Like a cell, every focusable control the detail renders carries `tabIndex={-1}`. The detail
   * row belongs to its data row for keyboard purposes: once the row is open, the Tab and arrow keys
   * that move across the data row's controls continue into the detail's, and Escape from any of
   * them returns to the data row.
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
   *
   * While virtualization is on but no viewport has been measured yet - the first paint of a real
   * browser, and every environment with no layout - a BOUNDED window of rows renders in normal
   * flow rather than the whole result; {@link DataTableVirtualizeOptions.unmeasuredWindowRows}
   * sizes that window and `'all'` opts out of it. See this module's header for the two states
   * that reach it and which of the two opt-outs each case wants.
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
 * colour, length, radius and font lives in `../styles/components.css`, as a `--dg-*` token.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/** The `aria-rowindex` of the header row. ARIA row indices are 1-based and the header comes first. */
const HEADER_ARIA_ROW_INDEX = 1;

/** The `aria-rowindex` of the first data row, which follows the single header row. */
const FIRST_DATA_ARIA_ROW_INDEX = 2;

/**
 * The role a column without {@link DataTableColumn.width} takes: `standard`, an equal share of the
 * free space above the `--dg-column-min-standard` floor - room for a short label, a formatted
 * figure or a status chip plus the cell's padding. The floor is what makes a narrow table scroll
 * rather than squeeze: a floorless default would let every unsized column collapse to its padding
 * in a narrow dock, where one cell's content then painted over its neighbour's. A long value still
 * cannot widen the row, because the maximum stays a share of the free space rather than the
 * content's width.
 */
const DEFAULT_COLUMN_WIDTH: DataTableColumnWidth = 'standard';

/**
 * The token-built track a column's width role resolves to.
 *
 * The role is type-checked at every typed call site; the own-property check additionally keeps an
 * untyped caller's unknown string (or an inherited name such as `constructor`) from resolving to
 * something that is not a track, by falling back to the default role instead.
 *
 * @param width The column's declared role, if any.
 * @returns The role's track and minimum.
 */
function resolveColumnTrack(width: DataTableColumnWidth | undefined): DataTableColumnTrack {
  return width !== undefined && Object.hasOwn(DATA_TABLE_COLUMN_TRACKS, width)
    ? DATA_TABLE_COLUMN_TRACKS[width]
    : DATA_TABLE_COLUMN_TRACKS[DEFAULT_COLUMN_WIDTH];
}

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
 * How many rows render while virtualization is on and no viewport has been measured yet. A COUNT,
 * and deliberately the same count as {@link AUTO_VIRTUALIZE_ROW_THRESHOLD}, for two reasons that
 * both have to hold:
 *
 *   It is the largest table this component is willing to render whole. Below that threshold an
 *   unqualified table does not virtualize at all, so bounding the unmeasured first paint here
 *   means a virtualized table never puts more rows in the DOM - not for one frame - than an
 *   unvirtualized one already does. That is what makes the bound safe to apply by default: the
 *   panel-data route caps a result at 5 000 rows, and 5 000 rows with all their cells is a first
 *   paint the reader waits for.
 *
 *   It comfortably exceeds the window the virtualizer settles on, so the bound never shows the
 *   reader fewer rows than the viewport can hold. `../styles/components.css` caps this table's
 *   scroll container at `max-block-size: var(--dg-scroll-cap-lg)`, which resolves to 432 CSS
 *   pixels; at {@link DEFAULT_ESTIMATED_ROW_HEIGHT} that is about thirteen rows, and
 *   {@link DEFAULT_OVERSCAN_ROWS} beyond each edge brings the settled window to roughly thirty.
 *
 * Expressed as a row count rather than as a second pixel figure on purpose: the JSDoc on
 * {@link DEFAULT_ESTIMATED_ROW_HEIGHT} states that it is the only numeric layout hint in this
 * package, and that has to stay true. The 432-pixel cap named above lives in the token table
 * (`scrollCapLg`), under every check the token suite applies, and is read here only as the reasoning
 * behind a count.
 */
const DEFAULT_UNMEASURED_WINDOW_ROWS = AUTO_VIRTUALIZE_ROW_THRESHOLD;

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

/**
 * The attribute a DETAIL row carries its data row's index in.
 *
 * A separate name rather than a second `data-row-index`, because that attribute means "this
 * element is a data row" to the key handlers, the focus effect and every suite that counts rows by
 * it. This one links a detail row back to the row it discloses, so a key pressed or focus landing
 * on a control inside the detail resolves to the data row's index (see `resolveBodyScope`).
 */
const DETAIL_ROW_INDEX_ATTRIBUTE = 'data-detail-row-index';

/**
 * Finds the grid element of any table - this one, or one nested inside a cell. Comparing a
 * target's nearest match with this table's own grid element is how the handlers leave a nested
 * grid's keys and focus to that grid.
 */
const GRID_SELECTOR = '[role="grid"]';

/**
 * The elements the keyboard model can move focus onto inside a row, its open detail or the header.
 *
 * Everything focusable, whatever its `tabIndex`: the in-cell controls are `tabIndex={-1}` by
 * contract (see this module's header), so a Tab-order query would find none of them.
 */
const NAVIGABLE_DESCENDANT_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * Ancestors - the element itself included - that put a control out of reach: removed from
 * rendering, made inert, or hidden from assistive technology, where focusing it would land the
 * reader on something they cannot perceive.
 */
const UNREACHABLE_ANCESTOR_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

/**
 * Text and choice widgets. They answer the arrow keys and Home/End themselves - moving a caret, a
 * selection or a value - so the grid gives them only Escape. A contenteditable host is the one
 * member a selector cannot express faithfully, since the state is inherited, so
 * `isContentEditable` covers it in `isTextEntry`.
 */
const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]';

/**
 * The `overflow-x`/`overflow-y` values under which an element scrolls its own content, and so
 * under which a keyboard scroll is the arrow key's native meaning. `hidden` and `clip` are absent
 * on purpose: a truncated label clips its overflow without scrolling it, and a truncated tooltip
 * trigger must still move on with the arrow keys.
 */
const SCROLLING_OVERFLOW_VALUES: ReadonlySet<string> = new Set(['auto', 'scroll', 'overlay']);

/** The keys that move along the inline axis, which a horizontally scrolling element keeps. */
const INLINE_AXIS_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** The keys that move along the block axis, which a vertically scrolling element keeps. */
const BLOCK_AXIS_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
]);

/**
 * The fixed middle of a detail row's `id`: `<useId base><infix><row index>`.
 *
 * The base is unique per table instance and the index is unique per row within it, so the id is
 * unique in the document; neither part contains whitespace, so the id is a single token that
 * `aria-controls` can name.
 */
const DETAIL_ROW_ID_INFIX = '-detail-';

/** The generic copy an unqualified empty table shows. Names nothing from any inspected project. */
const DEFAULT_EMPTY_MESSAGE = 'No rows to display.';

/** The suffix of the keyboard description's id, after the same stem as the caption's. */
const KEYBOARD_DESCRIPTION_ID_SUFFIX = '-keys';

/**
 * The sentences of the keyboard description the grid's `aria-describedby` names - generic product
 * copy, true of every table this primitive renders. Which of them apply, and which keys the last
 * one lists, is chosen by {@link describeKeyboard} from what the table can do.
 */
const KEYBOARD_ROW_KEYS =
  'Up and Down arrows move between rows; Home and End go to the first and last row.';
const KEYBOARD_ACTIVATE = 'Enter or Space activates the row.';
const KEYBOARD_EXPAND = 'Right arrow expands the row and Left arrow collapses it.';
const KEYBOARD_CONTROLS =
  "Tab moves through the row's controls, when it has any, and then leaves the table; Escape returns to the row.";

/**
 * Joins key names into one spoken list: `F2`, `Enter or F2`, `Enter, F2 or Right arrow`.
 *
 * @param keys The key names, in the order they are spoken; never empty.
 * @returns The list.
 */
function listKeys(keys: readonly string[]): string {
  const last = keys.at(-1) ?? '';
  const rest = keys.slice(0, -1);

  return rest.length === 0 ? last : `${rest.join(', ')} or ${last}`;
}

/**
 * The keyboard description of a table: how to move between its rows, what Enter does in it, whether
 * Right arrow expands, and how a row's controls are reached and left - so a reader of assistive
 * technology hears the route to a row's actions instead of having to discover it.
 *
 * The keys it names are exactly the ones the handlers answer. Enter moves into a row only when the
 * row activates nothing, and Right arrow only when it expands nothing, so each is listed with F2 -
 * the way in that always works - only then.
 *
 * @param activates Whether Enter and Space activate a row (`onRowActivate` was supplied).
 * @param expands Whether Right and Left arrow expand and collapse a row (`renderExpandedRow` and
 *   `onRowToggle` were both supplied).
 * @returns The description, as sentences joined by spaces.
 *
 * @example
 * describeKeyboard(false, true);
 * // '… Right arrow expands the row and Left arrow collapses it. Tab moves through the row's
 * //  controls, when it has any, and then leaves the table; Escape returns to the row. Enter or F2
 * //  also moves into them.'
 */
function describeKeyboard(activates: boolean, expands: boolean): string {
  const entryKeys = [...(activates ? [] : ['Enter']), 'F2', ...(expands ? [] : ['Right arrow'])];
  const sentences = [KEYBOARD_ROW_KEYS];

  if (activates) {
    sentences.push(KEYBOARD_ACTIVATE);
  }

  if (expands) {
    sentences.push(KEYBOARD_EXPAND);
  }

  sentences.push(KEYBOARD_CONTROLS, `${listKeys(entryKeys)} also moves into them.`);

  return sentences.join(' ');
}

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

  /**
   * How many rows render while virtualization is on and nothing has been measured: a count, or
   * `'all'` for every row. Already normalised, so the render path reads it without validating it.
   */
  readonly unmeasuredWindowRows: number | 'all';
}

/**
 * Normalise a caller-supplied {@link DataTableVirtualizeOptions.unmeasuredWindowRows}.
 *
 * `'all'` passes through as the explicit opt-in. A number is accepted only when it is finite -
 * `NaN` and the infinities would otherwise reach `Math.min` and produce a window of `NaN` rows -
 * and is then floored to a whole row and raised to at least one: a window of zero rows would
 * render no rows at all while rows exist, which strands the roving tab stop and leaves the body
 * unreachable by Tab. Anything else (`undefined`, a non-finite number) takes the default bound.
 *
 * @param value The option as the caller supplied it, if at all.
 * @returns A whole row count of at least one, or `'all'`.
 */
function resolveUnmeasuredWindowRows(value: number | 'all' | undefined): number | 'all' {
  if (value === 'all') {
    return 'all';
  }

  if (value !== undefined && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }

  return DEFAULT_UNMEASURED_WINDOW_ROWS;
}

/**
 * Resolve {@link DataTableProps.virtualize} into the settings in force.
 *
 * Omitted, the table decides from the row count; `false` and `{ enabled: false }` switch it off;
 * an options object without `enabled` means on, because passing options at all expresses that
 * intent.
 *
 * The unmeasured window is resolved in every branch, including the two where virtualization is
 * off: the setting describes what happens while virtualization is ON and unmeasured, and a
 * resolved value that is always present keeps the render path free of a second `undefined` case.
 * With virtualization off the render path renders every row regardless of it.
 *
 * @param virtualize The prop as the caller supplied it, if at all.
 * @param rowCount How many rows are being rendered.
 * @returns The mode, the overscan, the height hint and the unmeasured window.
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
      unmeasuredWindowRows: DEFAULT_UNMEASURED_WINDOW_ROWS,
    };
  }

  if (typeof virtualize === 'boolean') {
    return {
      enabled: virtualize,
      overscan: DEFAULT_OVERSCAN_ROWS,
      estimateRowHeight: DEFAULT_ESTIMATED_ROW_HEIGHT,
      unmeasuredWindowRows: DEFAULT_UNMEASURED_WINDOW_ROWS,
    };
  }

  return {
    enabled: virtualize.enabled ?? true,
    overscan: virtualize.overscan ?? DEFAULT_OVERSCAN_ROWS,
    estimateRowHeight: virtualize.estimateRowHeight ?? DEFAULT_ESTIMATED_ROW_HEIGHT,
    unmeasuredWindowRows: resolveUnmeasuredWindowRows(virtualize.unmeasuredWindowRows),
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
 * It reads the attribute off the element ITSELF and never walks ancestors: `resolveBodyScope` is
 * what walks from a control up to the row it sits in, and the handlers compare the two to tell "a
 * key pressed ON a row" from "a key pressed on a control INSIDE a row", which answer different
 * key maps (see this module's header).
 *
 * @param element The element to read.
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
 * One of THIS table's data rows by index, skipping any row of a grid nested inside a cell that
 * happens to carry the same index earlier in document order.
 *
 * @param grid This table's grid element.
 * @param index The row index to find.
 * @returns The row element, or `undefined` when it is not rendered.
 */
function findDataRow(grid: Element, index: number): HTMLElement | undefined {
  for (const candidate of grid.querySelectorAll(rowSelector(index))) {
    if (candidate instanceof HTMLElement && candidate.closest(GRID_SELECTOR) === grid) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * A data row as the keyboard model sees it: the row, plus its open detail row, which belongs to it.
 *
 * `row` and `detail` together are the SCOPE the arrow keys move across once focus is inside the
 * row; see this module's header.
 */
interface BodyScope {
  /** The data row's index in `rows`, read off its `data-row-index`. */
  readonly index: number;

  /** The data row element. */
  readonly row: HTMLElement;

  /** Its detail row, while open. */
  readonly detail: HTMLElement | undefined;
}

/**
 * The data row an element belongs to: the row itself, a control in one of its cells, or a control
 * in its open detail row.
 *
 * Resolved through the DOM rather than through state, because a focus or key event names only its
 * target. The nearest element carrying either row attribute is the row or the detail row; both
 * are children of one positioning wrapper, so the wrapper's children yield the pair. An owner
 * outside `grid` is refused: when this table sits inside another table's cell, a control in this
 * table's header would otherwise resolve to the OUTER table's row.
 *
 * @param target The element a focus or key event reached.
 * @param grid This table's grid element.
 * @returns The scope, or `undefined` when `target` is not inside one of this table's data rows.
 */
function resolveBodyScope(target: Element, grid: Element): BodyScope | undefined {
  const owner = target.closest(`[${ROW_INDEX_ATTRIBUTE}], [${DETAIL_ROW_INDEX_ATTRIBUTE}]`);

  if (owner === null || !grid.contains(owner)) {
    return undefined;
  }

  const wrapper = owner.parentElement;

  if (wrapper === null) {
    return undefined;
  }

  let row: HTMLElement | undefined;
  let detail: HTMLElement | undefined;

  for (const child of wrapper.children) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }

    if (child.hasAttribute(ROW_INDEX_ATTRIBUTE)) {
      row = child;
    } else if (child.hasAttribute(DETAIL_ROW_INDEX_ATTRIBUTE)) {
      detail = child;
    }
  }

  if (row === undefined) {
    return undefined;
  }

  const index = readRowIndex(row);

  return index === undefined ? undefined : { index, row, detail };
}

/**
 * Whether the keyboard model may move focus onto an element that matched
 * {@link NAVIGABLE_DESCENDANT_SELECTOR}.
 *
 * DOM-only on purpose - no `getClientRects`, no `offsetParent` - so it answers the same in a
 * browser and in an environment with no layout at all.
 *
 * @param element The candidate.
 * @param grid This table's grid element.
 * @returns `true` when it is an enabled, perceivable control of this table rather than of a grid
 *   nested inside it.
 */
function isNavigable(element: HTMLElement, grid: Element): boolean {
  return (
    !element.matches(':disabled') &&
    element.closest(UNREACHABLE_ANCESTOR_SELECTOR) === null &&
    element.closest(GRID_SELECTOR) === grid
  );
}

/**
 * Every navigable control inside the given scope elements, in document order. The scope elements
 * themselves are never included - a row is not a control inside itself.
 *
 * @param scopes The elements to search, in document order; `undefined` entries are skipped, which
 *   is how a closed detail row is passed.
 * @param grid This table's grid element.
 * @returns The controls.
 */
function navigablesIn(scopes: readonly (Element | undefined)[], grid: Element): HTMLElement[] {
  const found: HTMLElement[] = [];

  for (const scope of scopes) {
    if (scope === undefined) {
      continue;
    }

    for (const candidate of scope.querySelectorAll(NAVIGABLE_DESCENDANT_SELECTOR)) {
      if (candidate instanceof HTMLElement && isNavigable(candidate, grid)) {
        found.push(candidate);
      }
    }
  }

  return found;
}

/**
 * The first control after `from` in document order. Positional rather than an index lookup, so it
 * also answers for a focused element that is not in the list itself (one focusable by some other
 * means than the selector).
 *
 * @param controls The scope's controls, in document order.
 * @param from The focused element.
 * @returns The next control, or `undefined` at the end of the scope.
 */
function nextControl(controls: readonly HTMLElement[], from: Element): HTMLElement | undefined {
  return controls.find(
    (control) => (from.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
}

/**
 * The last control before `from` in document order; see {@link nextControl}.
 *
 * @param controls The scope's controls, in document order.
 * @param from The focused element.
 * @returns The previous control, or `undefined` at the start of the scope.
 */
function previousControl(controls: readonly HTMLElement[], from: Element): HTMLElement | undefined {
  return controls.findLast(
    (control) => (from.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
  );
}

/**
 * Whether `later` comes after `earlier` in document order. A descendant counts as after its
 * ancestor, as it does in the browser's sequential focus order.
 *
 * @param earlier The reference node.
 * @param later The node asked about.
 * @returns `true` when `later` follows `earlier`.
 */
function follows(earlier: Node, later: Node): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Whether an element is a stop of the DOCUMENT'S Tab order: a non-negative `tabIndex`, not
 * disabled, and not inside `[hidden]`, `[inert]` or `[aria-hidden="true"]`.
 *
 * Unlike {@link isNavigable} it asks nothing about which grid the element belongs to, and that is
 * its purpose: the active row of a grid nested in a cell is such a stop, and it is the one kind a
 * row's own Tab sequence must not skip. DOM-only, like every reachability rule of this module.
 *
 * @param element The candidate.
 * @returns `true` when the browser's own Tab would stop on it.
 */
function isDocumentTabStop(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    !element.matches(':disabled') &&
    element.closest(UNREACHABLE_ANCESTOR_SELECTOR) === null
  );
}

/**
 * Whether a stop of the document's Tab order lies strictly between two elements of a row's scope.
 *
 * By contract the only such stops inside a row are the active row of a grid nested in one of its
 * cells (or its detail) and a control a caller left at its default `tabIndex`. The browser's Tab
 * would visit either before the destination this table picked, so the table leaves that Tab to the
 * browser rather than skip the stop.
 *
 * @param scopes The row and its open detail, in document order; `undefined` entries are skipped.
 * @param earlier The start of the span, exclusive.
 * @param later The end of the span, exclusive.
 * @returns `true` when a document Tab stop sits between the two.
 */
function hasTabStopBetween(
  scopes: readonly (Element | undefined)[],
  earlier: Element,
  later: Element,
): boolean {
  for (const scope of scopes) {
    if (scope === undefined) {
      continue;
    }

    for (const candidate of scope.querySelectorAll(NAVIGABLE_DESCENDANT_SELECTOR)) {
      if (
        candidate instanceof HTMLElement &&
        isDocumentTabStop(candidate) &&
        follows(earlier, candidate) &&
        follows(candidate, later)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Answers Tab and Shift+Tab pressed inside a data row's scope - on the row itself, or on a control
 * in its cells or its open detail row. See this module's header for the model: Tab from the row
 * reaches its first control and walks the rest in document order, Shift+Tab walks back to the row.
 *
 * Focus is moved, and `preventDefault` called, only for a move that stays inside the scope. Every
 * other Tab is the browser's: Tab after the last control and Shift+Tab from the row, which leave
 * the grid because nothing else in it is a Tab stop; a chord; a Tab an input method is composing
 * with; and a Tab whose next stop is one of the document's own (see {@link hasTabStopBetween}).
 * That is what keeps the sequence free of a trap. Text fields take part like any other control:
 * Tab moves no caret, so nothing is taken from them.
 *
 * Module-level rather than a hook: it reads the DOM the event names and no component state.
 *
 * @param event The key event, whose key is `Tab`.
 * @param target The element the key was pressed on: the row, or a control in its scope.
 * @param scope The data row it belongs to, with its open detail.
 * @param grid This table's grid element, so no control of a nested grid is chosen.
 */
function answerTab(
  event: ReactKeyboardEvent<HTMLDivElement>,
  target: Element,
  scope: BodyScope,
  grid: Element,
): void {
  // A chord belongs to the browser or the platform - switching tabs, windows or panes - and a Tab
  // that confirms a composition belongs to the input method.
  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
    return;
  }

  const scopes = [scope.row, scope.detail];
  const controls = navigablesIn(scopes, grid);

  // Forwards, every control follows the row in document order, so from the row this is its first
  // control and from a control the next one; after the last there is none. Backwards from a
  // control it is the previous control, or the row from the first; from the row itself it is
  // nothing, and the browser leaves the grid.
  const backwards = event.shiftKey;
  const onRow = target === scope.row;
  const destination = backwards
    ? onRow
      ? undefined
      : (previousControl(controls, target) ?? scope.row)
    : nextControl(controls, target);

  if (destination === undefined) {
    return;
  }

  const between = backwards
    ? hasTabStopBetween(scopes, destination, target)
    : hasTabStopBetween(scopes, target, destination);

  if (between) {
    return;
  }

  event.preventDefault();
  destination.focus();
}

/**
 * Whether an element is a text or choice widget, which keeps its own arrow keys and Home/End.
 *
 * @param element The focused element.
 * @returns `true` for the members of {@link TEXT_ENTRY_SELECTOR} and for a contenteditable host.
 */
function isTextEntry(element: Element): boolean {
  return (
    element.matches(TEXT_ENTRY_SELECTOR) ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/**
 * Whether an element actually scrolls along the axis a key moves on, so the key's native meaning -
 * scrolling it - has to win over grid navigation.
 *
 * Both halves are required. The overflow value says the element scrolls rather than clips (a
 * truncated label also reports `scrollWidth > clientWidth`, but pressing an arrow on it scrolls
 * nothing), and the size comparison says there is something to scroll. Under an environment with
 * no layout every size is zero, so nothing counts as scrollable there.
 *
 * @param element The focused element.
 * @param key The key pressed.
 * @returns `true` when the element scrolls along that key's axis.
 */
function scrollsAlong(element: Element, key: string): boolean {
  const inline = INLINE_AXIS_KEYS.has(key);

  if (!(element instanceof HTMLElement) || (!inline && !BLOCK_AXIS_KEYS.has(key))) {
    return false;
  }

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);

  if (style === undefined) {
    return false;
  }

  return inline
    ? SCROLLING_OVERFLOW_VALUES.has(style.overflowX) && element.scrollWidth > element.clientWidth
    : SCROLLING_OVERFLOW_VALUES.has(style.overflowY) && element.scrollHeight > element.clientHeight;
}

/**
 * The key a toggle has just opened: the LAST key of `current` that `previous` did not hold, so a
 * caller that opens a row by appending its key names the row the reader acted on.
 *
 * @param current The expanded keys after the change, in the caller's order.
 * @param previous The expanded keys before it.
 * @returns The newly expanded key, or `undefined` when the change opened nothing.
 */
function findNewlyExpandedKey(
  current: readonly string[],
  previous: ReadonlySet<string>,
): string | undefined {
  let opened: string | undefined;

  for (const key of current) {
    if (!previous.has(key)) {
      opened = key;
    }
  }

  return opened;
}

/**
 * Scrolls a just-expanded row's detail into the table viewport, keeping the row itself visible.
 *
 * The viewport is capped in height and its header is sticky, so two edges bound what a reader can
 * see: the header's lower edge above, the viewport's lower edge below. The row and its detail are
 * treated as one block, `row` from its top edge to the detail's bottom edge:
 *
 *   - a block that ends below the lower edge is scrolled up by the overflow, but never so far that
 *     the row's top edge passes under the header - a detail taller than the viewport therefore
 *     leaves the toggled row pinned just under the header with as much detail as fits below it;
 *   - a block that starts above the header (a row scrolled half out of view) is scrolled down to
 *     it.
 *
 * Then the viewport itself is brought into view in every scrolling ancestor with
 * `scrollIntoView({ block: 'nearest' })`, which moves nothing when the table is already on screen.
 * A browser API that is missing - `scrollIntoView` in a DOM that does not implement it - is simply
 * skipped: the reveal is a convenience, never a precondition for the expansion.
 *
 * @param viewport The table's scroll container.
 * @param row The toggled `role="row"` element.
 */
function revealExpandedRow(viewport: HTMLElement, row: HTMLElement): void {
  const detail = row.nextElementSibling;
  const blockEnd = detail instanceof HTMLElement ? detail : row;
  const header = viewport.querySelector('.dg-data-table__head');
  const viewportRect = viewport.getBoundingClientRect();
  const visibleTop =
    viewportRect.top +
    viewport.clientTop +
    (header instanceof HTMLElement ? header.getBoundingClientRect().height : 0);
  const visibleBottom = viewportRect.top + viewport.clientTop + viewport.clientHeight;
  const top = row.getBoundingClientRect().top;
  const bottom = blockEnd.getBoundingClientRect().bottom;

  if (top < visibleTop) {
    viewport.scrollTop -= visibleTop - top;
  } else if (bottom > visibleBottom) {
    viewport.scrollTop += Math.min(bottom - visibleBottom, top - visibleTop);
  }

  if (typeof viewport.scrollIntoView === 'function') {
    viewport.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
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

/** A half-open range of row indices, `[start, end)`, as `Array.prototype.slice` takes them. */
interface RowRange {
  /** The first row index rendered. */
  readonly start: number;

  /** One past the last row index rendered. */
  readonly end: number;
}

/**
 * The rows that render IN NORMAL FLOW - whenever the virtualizer is not the thing driving the
 * render. Two states reach it, and they want different answers.
 *
 * Virtualization off, by `virtualize={false}`, `{ enabled: false }` or a row count below
 * {@link AUTO_VIRTUALIZE_ROW_THRESHOLD}: every row, which is the documented meaning of the opt-out
 * and what a surface that prints, searches or selects the whole table depends on.
 *
 * Virtualization on but nothing measured yet - the first paint of a real browser before the scroll
 * element has been observed, and any environment that can measure nothing at all: a WINDOW of
 * {@link ResolvedVirtualization.unmeasuredWindowRows} rows, unless that setting is `'all'`, which
 * is the explicit opt-in back to every row. The panel-data route caps a result at 5 000 rows, and
 * creating 5 000 rows with all their cells for one frame is a first paint the reader waits
 * through, which is the whole reason the bound exists.
 *
 * The window is ANCHORED ON THE ACTIVE ROW rather than pinned to row zero, and that is a
 * correctness requirement rather than a nicety: a caller may arrive with `selectedRowKey` naming
 * row 4 000, that row holds the roving tab stop, and a tab stop that is not in the DOM leaves the
 * grid body unreachable by Tab. Anchoring also keeps Home, End and PageUp/PageDown working while
 * unmeasured - the window follows `activeIndex`, so the row a key moved to exists on the next
 * commit. The overscan is spent ahead of the anchor so a row reached by ArrowUp is already there,
 * and the start is clamped so the window never runs off either end of the result.
 *
 * @param virtualization The resolved settings, for the mode and the window size.
 * @param rowCount How many rows exist.
 * @param activeIndex The row holding the roving tab stop, or `-1` when there are no rows.
 * @returns The half-open range of row indices to render in flow.
 */
function resolveFlowRowRange(
  virtualization: ResolvedVirtualization,
  rowCount: number,
  activeIndex: number,
): RowRange {
  if (!virtualization.enabled || virtualization.unmeasuredWindowRows === 'all') {
    return { start: 0, end: rowCount };
  }

  const windowRows = Math.min(virtualization.unmeasuredWindowRows, rowCount);

  // The window opens `overscan` rows ahead of the anchor, so a row reached by ArrowUp is already
  // there - but never so far ahead that the anchor would fall past its end, which is what a window
  // narrower than the overscan would otherwise do (`unmeasuredWindowRows: 1` with the default
  // overscan of eight). `earliestStart` is the first start that still contains the anchor; the
  // outer clamp then keeps the window inside the result at both ends.
  const earliestStart = activeIndex - windowRows + 1;
  const anchored = Math.max(activeIndex - virtualization.overscan, earliestStart);
  const start = Math.min(Math.max(anchored, 0), rowCount - windowRows);

  return { start, end: start + windowRows };
}

/**
 * The virtualizer's window with one row guaranteed in it: `indexes` - what the default extractor
 * yields, the rows in view plus the overscan, ascending - with `row` inserted in order when it is
 * not already there.
 *
 * It is how the ACTIVE ROW stays mounted under virtualization, which the keyboard model depends
 * on twice over. A key that moves the active row (Home, End, PageUp/PageDown) renders its target in
 * the commit the key causes, before the scroll it asked for has moved the window, so the focus
 * effect hands focus from the origin row to the target directly; and a focused row the reader
 * scrolls out of view stays in the DOM, positioned at its own offset outside the visible band,
 * instead of unmounting and dropping focus to the document body. One extra row, absolutely
 * positioned like every other, costs neither the scroll range nor the measurement: the wrapper
 * carries `data-index` and the measurement ref like any row of the window.
 *
 * The result stays ascending and free of duplicates, so rows keep their document order - which is
 * row order, and what the ARIA row indices and the arrow keys' positional lookups assume.
 *
 * @param indexes The window's row indices, ascending and unique.
 * @param row The row to keep, or a negative index when there is none (no rows).
 * @returns A new array: the window, with `row` in it.
 *
 * @example
 * withRowInWindow([40, 41, 42], 3);  // [3, 40, 41, 42]
 * withRowInWindow([40, 41, 42], 41); // [40, 41, 42]
 * withRowInWindow([40, 41, 42], 90); // [40, 41, 42, 90]
 */
function withRowInWindow(indexes: readonly number[], row: number): number[] {
  if (row < 0) {
    return [...indexes];
  }

  const at = indexes.findIndex((index) => index >= row);

  if (at === -1) {
    return [...indexes, row];
  }

  if (indexes[at] === row) {
    return [...indexes];
  }

  return [...indexes.slice(0, at), row, ...indexes.slice(at)];
}

/**
 * Where one row sits against the scroll container, in the container's own scroll coordinates -
 * the input to {@link revealOffsetFor}. Every field is a measurement read off the live layout (or
 * the virtualizer's own row measurements), never a style value.
 */
interface RevealGeometry {
  /** The row's leading edge, measured from the start of the scrollable content. */
  readonly rowStart: number;

  /** The row's trailing edge, on the same axis. */
  readonly rowEnd: number;

  /** How far the container is currently scrolled. */
  readonly scrollOffset: number;

  /** The block size of the container's visible area. */
  readonly viewportSize: number;

  /**
   * The block size of the sticky header, which covers the leading edge of the visible area (see
   * `.dg-data-table__head` in `../styles/components.css`), so a row under it is not visible.
   */
  readonly headerSize: number;
}

/**
 * The scroll offset that brings a row fully into the visible area of its table's own scroll
 * container, moving it as little as possible, or `undefined` when it is already fully visible.
 *
 * "Nearest" semantics, as `scrollIntoView({ block: 'nearest' })` would give, but confined to the
 * table's viewport: a row above the visible band is brought to just under the sticky header, a row
 * below it to the trailing edge - and never so far that its leading edge slides under the header,
 * which is what a row taller than the band would otherwise do. The page itself is never scrolled,
 * because two tables revealing one selection would otherwise fight over it.
 *
 * A container with no visible band beyond its header - nothing measured yet, or an environment
 * that measures nothing - yields `undefined`: there is no position that would reveal the row.
 *
 * @param geometry The row and container measurements.
 * @returns The offset to scroll the container to, or `undefined` to leave it where it is.
 */
function revealOffsetFor(geometry: RevealGeometry): number | undefined {
  const { rowStart, rowEnd, scrollOffset, viewportSize, headerSize } = geometry;

  if (viewportSize <= headerSize) {
    return undefined;
  }

  const bandStart = scrollOffset + headerSize;
  const bandEnd = scrollOffset + viewportSize;
  const leadingTarget = Math.max(rowStart - headerSize, 0);

  if (rowStart < bandStart) {
    return leadingTarget;
  }

  if (rowEnd > bandEnd) {
    return Math.min(Math.max(rowEnd - viewportSize, 0), leadingTarget);
  }

  return undefined;
}

/**
 * The leading edge of an element in a scroll container's own scroll coordinates.
 *
 * Read from the two boxes on screen rather than from `offsetTop`, so it holds whichever ancestor
 * is positioned: the distance between the element and the container's padding edge, plus how far
 * the container is scrolled.
 *
 * @param element The element inside the container.
 * @param viewport The scroll container.
 * @returns The element's leading edge, measured from the start of the scrollable content.
 */
function scrollStartOf(element: Element, viewport: HTMLElement): number {
  return (
    element.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    viewport.clientTop +
    viewport.scrollTop
  );
}

/**
 * The generic data grid of the design system.
 *
 * See this module's header for the four pillars, the exact ARIA structure, the class and
 * custom-property contract, what renders before anything has been measured and the boundaries this
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

  // The grid element and its header row, read only from handlers and effects: the grid is where a
  // row is looked up for focus, and the header row is the scope of the header's key map.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);

  // The sticky header rowgroup and the body rowgroup, read only by the selection reveal below to
  // place a row against the visible band of the viewport.
  const headRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // The key of the row the reader activated in THIS table, written by `activateRow` and spent by
  // the reveal effect: a selection that follows the reader's own click or Enter lands on a row
  // they are already looking at, so it must not scroll the table under them.
  const activatedKeyRef = useRef<string | null>(null);

  // The selection the reveal effect last saw, and whether revealing it is still outstanding. Held
  // in a ref because it is bookkeeping about a side effect, not rendered output: a re-render for
  // any other reason - new rows, a new sort, a parent's state - finds the reveal already spent and
  // scrolls nothing.
  const revealRef = useRef<{ key: string | null | undefined; pending: boolean }>({
    key: undefined,
    pending: false,
  });

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

  // The keyboard description the grid is described by while rows exist: which keys it names
  // follows from what this table's rows can do, so it states exactly the map the handlers answer.
  const keyboardDescriptionId = `${id ?? generatedId}${KEYBOARD_DESCRIPTION_ID_SUFFIX}`;
  const keyboardDescription = describeKeyboard(onRowActivate !== undefined, canToggle);

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

  // The grid track template, inherited by every row through `--dgc-columns`, and the sums the grid
  // and its truncating tracks size themselves by: `--dgc-min-inline`, every column's guaranteed
  // minimum (the yielded floor of a `name` or `text` column, the full floor of every other), and -
  // only when a truncating column makes the two differ - `--dgc-readable-inline`, every column's
  // readable floor, with `--dgc-yield-count`, the number of truncating columns. All are token
  // references only: a column's `width` is a semantic role, never a CSS value, because every visual
  // value resolves to a `--dg-*` token.
  const { columnTemplate, minimumInlineSize, readableInlineSize, yieldCount } = useMemo(() => {
    const tracks = columns.map((column) => resolveColumnTrack(column.width));
    const yielding = tracks.filter((entry) => entry.yields).length;

    return {
      columnTemplate: tracks.map((entry) => entry.track).join(' '),
      minimumInlineSize:
        tracks.length === 0
          ? undefined
          : `calc(${tracks.map((entry) => entry.minimum).join(' + ')})`,
      readableInlineSize:
        yielding === 0 ? undefined : `calc(${tracks.map((entry) => entry.floor).join(' + ')})`,
      yieldCount: yielding,
    };
  }, [columns]);

  const virtualization = useMemo(
    () => resolveVirtualization(virtualize, rowCount),
    [virtualize, rowCount],
  );
  const virtualizationEnabled = virtualization.enabled;

  // Resolved BEFORE the virtualizer, because its window is built around this row (see the range
  // extractor below). It depends on nothing the virtualizer measures - the reader's navigation, the
  // selection and the row count - so the order costs nothing.
  const selectedIndex =
    selectedRowKey === undefined || selectedRowKey === null
      ? undefined
      : indexByKey.get(selectedRowKey);
  const activeIndex = resolveActiveIndex(navigatedIndex, selectedIndex, rowCount);

  // The virtualizer's window, with the ACTIVE ROW always in it. The default extractor yields the
  // rows in view plus the overscan; the active row - the roving tab stop, and the row that holds
  // focus whenever focus is in the body - is added wherever it is (see `withRowInWindow`). Without
  // it, two things lose the reader's focus: Home, End or PageUp/PageDown scroll the window away in
  // a later commit and unmount the focused ORIGIN row before the focus effect can reach the target,
  // and a reader who scrolls the viewport unmounts the row they are standing on for good. With it,
  // the target of a key renders in the very commit the key causes - so focus moves row to row with
  // nothing in between - and a focused row never leaves the DOM while it is the active one.
  // Memoized on the active row, so the virtualizer recomputes its indexes only when the window or
  // that row actually changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => withRowInWindow(defaultRangeExtractor(range), activeIndex),
    [activeIndex],
  );

  // Called unconditionally, whatever the mode: a hook behind a condition is a rules-of-hooks
  // violation, and an instance that exists but drives nothing costs one object.
  //
  // `react-hooks/incompatible-library` reports that this API returns functions the React Compiler
  // cannot memoize safely, so it skips auto-memoizing this component. That is suppressed rather
  // than worked around, on two grounds. Long lists in the design system virtualize through
  // `@tanstack/react-virtual`, and this is the one module in the package permitted to use it, so
  // there is no alternative API to reach for. And the consequence the rule warns about does not
  // arise here: like every other primitive in this package, this component re-renders with its
  // parent by design - the product reports on its own render behaviour rather than smoothing it
  // over - and nothing the virtualizer returns is handed to a memoized component. What leaves
  // this module is the caller's own rows, columns and callbacks.
  // eslint-disable-next-line react-hooks/incompatible-library -- the design system's virtualizer
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => virtualization.estimateRowHeight,
    overscan: virtualization.overscan,
    enabled: virtualizationEnabled,
    // REQUIRED under React 19, not a preference. The adapter's own default is `useFlushSync: true`,
    // in which case every synchronous notification it raises - a viewport measurement, a row
    // measurement, a scroll - re-renders this component through `flushSync`. Those notifications
    // originate in the layout-effect and measurement path (`observeElementRect` fires as the scroll
    // element is attached, `measureElement` fires from the row refs), so the call lands while React
    // is already rendering or committing, and React 19.3.0 answers that with a console warning and
    // a deferred update rather than a synchronous flush. `false` makes the adapter call its own
    // `rerender` instead, which React batches with the rest of the commit - the window is one
    // render behind for a single frame, which is what the overscan above exists to cover. The two
    // versions this reasoning is tied to are pinned in this package's manifest: react/react-dom
    // 19.3.0 and @tanstack/react-virtual 3.14.13.
    useFlushSync: false,
    // Measurements follow the row's identity rather than its position, so a re-sort or a re-page
    // does not attribute one row's measured height to another.
    getItemKey: (index) => models[index]?.key ?? index,
    rangeExtractor,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const viewportHeight = virtualizer.scrollRect === null ? 0 : virtualizer.scrollRect.height;

  // THE MEASUREMENT GATE - do not narrow it to the item check alone. Virtualization only drives
  // the render when the virtualizer has actually measured a viewport AND produced a window; when
  // it has not, rows render in normal flow instead, and `resolveFlowRowRange` decides how many.
  // Two real states land there: the first paint of a real browser, before the scroll element has
  // been observed, and an environment that can measure nothing at all - happy-dom, where every
  // rect and every `offsetHeight` answer zero, which is the environment the component suites of
  // this package mount these tables in. See this module's header for the two ways a caller asks
  // for every row in that state, and why neither is the default.
  const isVirtualized = virtualizationEnabled && virtualItems.length > 0 && viewportHeight > 0;

  // Resolved after `activeIndex` because the window is anchored on it, and before the tab stop
  // below because the tab stop depends on which rows this range puts in the DOM.
  const flowRange = resolveFlowRowRange(virtualization, rowCount, activeIndex);

  // Whether the flow range is a WINDOW rather than the whole result. It drives one thing: the
  // canvas's scroll range, which has to describe all the rows even while only some are rendered.
  const flowRangeIsWindowed = !isVirtualized && flowRange.end - flowRange.start < rowCount;

  // The roving tab stop has to EXIST in the DOM whenever rows are rendered, or the grid body is
  // unreachable by Tab. Both paths keep it there by construction: the range extractor adds the
  // active row to every virtual window, and the flow range is anchored on it. Should a window
  // ever arrive without it all the same, the topmost rendered row takes the tab stop instead, so
  // the body stays reachable; the key handlers read the origin row's own index, so navigation
  // continues from wherever the reader actually entered.
  //
  // ONE PREDICATE for "is the active row in the DOM?", asked of whichever path is rendering: the
  // virtual items when the virtualizer drives the render, the flow range when it does not. On
  // both paths the answer is `true` whenever rows exist; it is still computed rather than assumed,
  // because it is also what the focus effect below and `moveActiveRow` wait on, and the three must
  // agree.
  const activeIsRendered = isVirtualized
    ? virtualItems.some((item) => item.index === activeIndex)
    : activeIndex >= flowRange.start && activeIndex < flowRange.end;
  const firstRenderedIndex = isVirtualized
    ? virtualItems[0]?.index
    : rowCount === 0
      ? undefined
      : flowRange.start;
  const tabStopIndex =
    activeIsRendered || firstRenderedIndex === undefined ? activeIndex : firstRenderedIndex;

  const handleSortActivate = useCallback(
    (column: DataTableColumn<Row>): void => {
      if (onSortChange === undefined) {
        return;
      }

      // The next sort is REPORTED, never applied: the rows keep the order the data layer gave them
      // until the caller comes back with a new page from the panel-data route.
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

      // Already the active row, and rendered: nothing the focus effect depends on will change, so
      // the effect would not run again and a pending request would outlive this key - to be
      // honoured by some later, unrelated commit (a re-page, a scroll back into the window) that
      // pulls focus into the table from wherever the reader has gone. Focus the row here instead.
      // This is the path a vertical key takes from a control inside the first or last row, and an
      // ArrowUp or ArrowDown on either of those rows themselves.
      if (clamped === activeIndex && activeIsRendered) {
        focusPendingRef.current = false;
        // Still recorded, so a navigated row keeps precedence over the selection exactly as on
        // the path below; when it is already the value, React skips the render.
        setNavigatedIndex(clamped);

        const grid = gridRef.current;

        (grid === null ? undefined : findDataRow(grid, clamped))?.focus();
        return;
      }

      focusPendingRef.current = true;
      setNavigatedIndex(clamped);

      // Scroll first, focus second: under virtualization the row may not be mounted yet, and the
      // focus effect waits for the window that this scroll brings into range.
      if (isVirtualized) {
        virtualizer.scrollToIndex(clamped);
      }
    },
    [activeIndex, activeIsRendered, isVirtualized, rowCount, virtualizer],
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

      // Noted before the caller hears of it, because the caller's answer - a new `selectedRowKey`
      // - may arrive in the very commit this activation causes.
      activatedKeyRef.current = model.key;
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
  //
  // Focus on a control INSIDE a row - a chip in a cell, a control in the open detail - counts as
  // focus on that row, so the roving stop, which is the row Tab returns to, follows Tab, an arrow
  // key or a pointer click into a cell as well. The row's own `tabIndex` is left alone meanwhile,
  // so the row stays the grid's one Tab stop while a control inside it holds focus. Focus in the
  // header, or inside a grid nested in a cell, changes nothing.
  const handleFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    const target = event.target;
    const grid = event.currentTarget;

    if (!(target instanceof Element) || target.closest(GRID_SELECTOR) !== grid) {
      return;
    }

    const scope = resolveBodyScope(target, grid);

    if (scope === undefined) {
      return;
    }

    // Focus has arrived where it belongs, so any outstanding programmatic request is satisfied.
    focusPendingRef.current = false;
    setNavigatedIndex(scope.index);
  }, []);

  // Keys pressed ON a data row. See this module's header for the map; `preventDefault` is called
  // only for the keys actually handled, so every unhandled key keeps its meaning. Tab never reaches
  // this map: the dispatcher below hands it to `answerTab` first.
  const handleRowKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, scope: BodyScope, grid: Element): void => {
      const originIndex = scope.index;

      // Moves focus onto the first control of the row and its open detail - what Enter (on a row
      // with no activation), F2, and ArrowRight (on a row with nothing to expand) do. A row with
      // no control leaves the key unhandled.
      const enterRow = (): void => {
        const first = navigablesIn([scope.row, scope.detail], grid)[0];

        if (first !== undefined) {
          event.preventDefault();
          first.focus();
        }
      };

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActiveRow(originIndex + 1);
          return;
        case 'ArrowUp': {
          // Above the first row is the header, whose sort controls leave the Tab order while rows
          // exist - this key is how a keyboard reader reaches them. A header with no control keeps
          // the clamp at the first row.
          const headerRow = headerRowRef.current;
          const headerControl =
            originIndex === 0 && headerRow !== null
              ? navigablesIn([headerRow], grid)[0]
              : undefined;

          event.preventDefault();

          if (headerControl === undefined) {
            moveActiveRow(originIndex - 1);
          } else {
            headerControl.focus();
          }

          return;
        }
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
        case 'Enter': {
          // With nothing to activate, Enter is the conventional way into the row's cells.
          if (onRowActivate === undefined) {
            enterRow();
            return;
          }

          event.preventDefault();
          activateRow(originIndex);
          return;
        }
        case ' ': {
          if (onRowActivate === undefined) {
            return;
          }

          // Space would otherwise scroll the viewport out from under the row it just activated.
          event.preventDefault();
          activateRow(originIndex);
          return;
        }
        case 'F2':
          // Always a way in, including on a row where Enter activates.
          enterRow();
          return;
        case 'ArrowRight': {
          // A collapsed expandable row opens first; the next ArrowRight - or this one, on a row
          // that is open or has nothing to reveal - moves into the row.
          if (canToggle && models[originIndex]?.expanded === false) {
            event.preventDefault();
            toggleRow(originIndex);
            return;
          }

          enterRow();
          return;
        }
        case 'ArrowLeft': {
          // Left closes an open row and does nothing else: it never repeats the state the row is
          // already in, and a row has no control before itself to move to.
          if (canToggle && models[originIndex]?.expanded === true) {
            event.preventDefault();
            toggleRow(originIndex);
          }

          return;
        }
        default:
          return;
      }
    },
    [activateRow, canToggle, models, moveActiveRow, onRowActivate, rowCount, toggleRow],
  );

  // Keys pressed on a control inside a data row's cells or its open detail row - one scope, in
  // document order. See this module's header for the map and for the two kinds of control that
  // keep their own keys.
  const handleDescendantKey = useCallback(
    (
      event: ReactKeyboardEvent<HTMLDivElement>,
      target: Element,
      scope: BodyScope,
      grid: Element,
    ): void => {
      // Escape first: it is the one key every control answers to the grid, text fields included.
      // A control that consumed it - an open `Tooltip` closing its bubble - never reaches here,
      // because the dispatcher below leaves a prevented key alone.
      if (event.key === 'Escape') {
        event.preventDefault();
        scope.row.focus();
        return;
      }

      if (isTextEntry(target) || scrollsAlong(target, event.key)) {
        return;
      }

      const controls = navigablesIn([scope.row, scope.detail], grid);

      // Handled even when there is nowhere to go - ArrowRight on the last control stays put - so
      // the key does not fall through to scroll the viewport under the reader.
      const moveTo = (control: HTMLElement | undefined): void => {
        event.preventDefault();
        control?.focus();
      };

      switch (event.key) {
        case 'ArrowRight':
          moveTo(nextControl(controls, target));
          return;
        case 'ArrowLeft':
          moveTo(previousControl(controls, target) ?? scope.row);
          return;
        case 'Home':
          moveTo(controls[0]);
          return;
        case 'End':
          moveTo(controls.at(-1));
          return;
        // The vertical keys leave the control for another row, counted from the row the control
        // belongs to, through the same path - and the same virtualization scroll - as from a row.
        case 'ArrowDown':
          event.preventDefault();
          moveActiveRow(scope.index + 1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          moveActiveRow(scope.index - 1);
          return;
        case 'PageDown':
          event.preventDefault();
          moveActiveRow(scope.index + PAGE_JUMP_ROWS);
          return;
        case 'PageUp':
          event.preventDefault();
          moveActiveRow(scope.index - PAGE_JUMP_ROWS);
          return;
        // Enter, Space and every other key are the control's own: a key pressed on a control never
        // activates the row. Tab never reaches this map: the dispatcher hands it to `answerTab`.
        default:
          return;
      }
    },
    [moveActiveRow],
  );

  // Keys pressed on a control in the header row: the sort controls, and anything a column's
  // `header` node renders. Enter and Space are left native, so a sort control still sorts.
  const handleHeaderKey = useCallback(
    (
      event: ReactKeyboardEvent<HTMLDivElement>,
      target: Element,
      headerRow: Element,
      grid: Element,
    ): void => {
      // Back into the body on the row that holds the roving stop - the row Tab would enter on.
      // With no rows there is nowhere to go, and the key is left unhandled.
      const returnToBody = (): void => {
        const row = findDataRow(grid, tabStopIndex);

        if (row !== undefined) {
          event.preventDefault();
          row.focus();
        }
      };

      if (event.key === 'Escape') {
        returnToBody();
        return;
      }

      if (isTextEntry(target) || scrollsAlong(target, event.key)) {
        return;
      }

      const controls = navigablesIn([headerRow], grid);
      const moveTo = (control: HTMLElement | undefined): void => {
        event.preventDefault();
        control?.focus();
      };

      switch (event.key) {
        case 'ArrowDown':
          returnToBody();
          return;
        case 'ArrowRight':
          moveTo(nextControl(controls, target));
          return;
        case 'ArrowLeft':
          moveTo(previousControl(controls, target));
          return;
        case 'Home':
          moveTo(controls[0]);
          return;
        case 'End':
          moveTo(controls.at(-1));
          return;
        default:
          return;
      }
    },
    [tabStopIndex],
  );

  // The one key handler on the grid, dispatching on WHERE the key was pressed: on a data row, on
  // a control inside one (or inside its open detail), or in the header.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const target = event.target;
      const grid = event.currentTarget;

      // A key pressed inside a grid nested in a cell belongs to that grid. It still bubbles
      // through this handler, and is left alone here.
      if (!(target instanceof Element) || target.closest(GRID_SELECTOR) !== grid) {
        return;
      }

      const scope = resolveBodyScope(target, grid);

      // Tab first, and on the row exactly as on a control: one sequence runs across both, and a
      // text field takes part in it as well, which is why this precedes every per-target map.
      // A Tab something inside already consumed is its own; a Tab in the header is the browser's.
      if (event.key === 'Tab') {
        if (scope !== undefined && !event.defaultPrevented) {
          answerTab(event, target, scope, grid);
        }

        return;
      }

      if (scope !== undefined && target === scope.row) {
        handleRowKey(event, scope, grid);
        return;
      }

      // A control that already handled the key owns it: the first Escape an open `Tooltip`
      // consumes, an arrow a composite widget in a cell answers itself.
      if (event.defaultPrevented) {
        return;
      }

      if (scope !== undefined) {
        handleDescendantKey(event, target, scope, grid);
        return;
      }

      const headerRow = headerRowRef.current;

      if (headerRow !== null && headerRow.contains(target)) {
        handleHeaderKey(event, target, headerRow, grid);
      }
    },
    [handleDescendantKey, handleHeaderKey, handleRowKey],
  );

  // Focus follows the active row, but only when a key handler asked for it. The row is resolved
  // from the DOM rather than held in a ref because under either windowing path it may not have
  // existed when the key was pressed. `activeIsRendered` - the one predicate above, which asks the
  // path that is actually rendering - is a dependency, so the commit that brings the row into the
  // DOM runs this again; until then the pending request is deliberately LEFT SET, so it survives
  // rather than being spent on a row that is not there.
  useEffect(() => {
    if (!focusPendingRef.current || activeIndex < 0 || !activeIsRendered) {
      return;
    }

    const grid = gridRef.current;

    if (grid === null) {
      return;
    }

    // `findDataRow` rather than a bare `querySelector`, so a grid nested in an earlier row's cell
    // cannot answer for this table's row.
    const candidate = findDataRow(grid, activeIndex);

    if (candidate === undefined) {
      return;
    }

    focusPendingRef.current = false;
    candidate.focus();
  }, [activeIndex, activeIsRendered]);

  // Reveal a row the reader has just expanded. The keys seen by the previous run are held in a ref:
  // the first run - the mount, including the second mount React's StrictMode performs - only
  // records them, so a table that ARRIVES with rows expanded (a reopened session) never scrolls
  // on its own, and only a change that opens a row the table was not already showing acts. The
  // reveal waits one animation frame, until the detail row has been laid out and, on the windowed
  // path, measured; a later change cancels a frame that has not fired yet.
  const previousExpandedRef = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const current = canExpand ? (expandedRowKeys ?? []) : [];
    const previous = previousExpandedRef.current;

    previousExpandedRef.current = new Set(current);

    if (previous === null) {
      return undefined;
    }

    const opened = findNewlyExpandedKey(current, previous);
    const openedIndex = opened === undefined ? undefined : indexByKey.get(opened);

    if (openedIndex === undefined || typeof requestAnimationFrame !== 'function') {
      return undefined;
    }

    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const grid = gridRef.current;
      // `findDataRow`, so a grid nested in an earlier row's cell cannot answer for this table's row.
      const row = grid === null ? undefined : findDataRow(grid, openedIndex);

      if (viewport instanceof HTMLElement && row !== undefined) {
        revealExpandedRow(viewport, row);
      }
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [canExpand, expandedRowKeys, indexByKey]);

  // The selected row is brought into the viewport when the SELECTION moves to it from elsewhere -
  // another view, an evidence chip, a host surface driving `selectedRowKey` - so a reader who
  // selected an event somewhere else sees it here without hunting through a long table. Four
  // rules keep that from ever being a scroll the reader did not ask for:
  //
  //   Once per selection. The reveal is armed when `selectedRowKey` changes (the first commit
  //   counts, so a table that mounts with a selection opens on it) and spent when it is done;
  //   re-renders for any other reason find nothing armed.
  //
  //   Never for the reader's own activation. A row clicked or confirmed here is one the reader is
  //   already looking at, so `activateRow`'s note disarms the reveal for that key.
  //
  //   Only a loaded row. A key that names no row in `rows` stays armed and is revealed when a
  //   page that holds it arrives; under the flow path a row outside the rendered range waits the
  //   same way, for the commit that renders it.
  //
  //   Never focus, never the page. Only this table's own viewport scrolls (see
  //   `revealOffsetFor`), and focus stays wherever the reader has it; the roving tab stop is not
  //   moved either, because it follows the reader's navigation first and the selection only
  //   until then (see `resolveActiveIndex`).
  //
  // A row already fully visible is left where it is.
  useEffect(() => {
    const reveal = revealRef.current;

    if (reveal.key !== selectedRowKey) {
      const activatedHere =
        selectedRowKey !== null &&
        selectedRowKey !== undefined &&
        activatedKeyRef.current === selectedRowKey;

      reveal.key = selectedRowKey;
      reveal.pending = selectedRowKey !== null && selectedRowKey !== undefined && !activatedHere;
      activatedKeyRef.current = null;
    }

    if (!reveal.pending || selectedIndex === undefined) {
      return;
    }

    const viewport = viewportRef.current;
    const canvas = canvasRef.current;

    if (viewport === null || canvas === null) {
      return;
    }

    const headerSize = headRef.current?.getBoundingClientRect().height ?? 0;
    const scrollOffset = viewport.scrollTop;
    const viewportSize = viewport.clientHeight;

    if (isVirtualized) {
      // The row may be far outside the rendered window, so it is placed from the virtualizer's own
      // measurement of it (an estimate until it has been rendered once), offset by where the
      // canvas those measurements are relative to begins.
      const item = virtualizer.measurementsCache[selectedIndex];
      reveal.pending = false;

      if (item === undefined) {
        virtualizer.scrollToIndex(selectedIndex);
        return;
      }

      const canvasStart = scrollStartOf(canvas, viewport);
      const target = revealOffsetFor({
        rowStart: canvasStart + item.start,
        rowEnd: canvasStart + item.end,
        scrollOffset,
        viewportSize,
        headerSize,
      });

      if (target !== undefined) {
        virtualizer.scrollToOffset(target);
      }

      return;
    }

    // `findDataRow`, so a grid nested in an earlier row's cell cannot answer for this table's row.
    const grid = gridRef.current;
    const row = grid === null ? undefined : findDataRow(grid, selectedIndex);

    if (row === undefined) {
      return;
    }

    reveal.pending = false;

    const rowStart = scrollStartOf(row, viewport);
    const target = revealOffsetFor({
      rowStart,
      rowEnd: rowStart + row.getBoundingClientRect().height,
      scrollOffset,
      viewportSize,
      headerSize,
    });

    if (target !== undefined) {
      viewport.scrollTop = target;
    }
  }, [isVirtualized, selectedIndex, selectedRowKey, virtualizer]);

  // The grid carries the track template every row inherits and, when any track states a minimum,
  // the sums that decide whether a too-narrow surface truncates to fit or scrolls
  // (`../styles/components.css` adds the gaps between tracks and the row's inline-start edge to
  // them). The readable sum and the truncating count are written only when a truncating column
  // exists: without one the two sums are equal, and the stylesheet falls back to the one it has.
  const gridStyle: CssVariableStyle = {
    '--dgc-columns': columnTemplate,
    '--dgc-column-count': String(columnCount),
    ...(minimumInlineSize === undefined ? {} : { '--dgc-min-inline': minimumInlineSize }),
    ...(readableInlineSize === undefined
      ? {}
      : {
          '--dgc-readable-inline': readableInlineSize,
          '--dgc-yield-count': String(yieldCount),
        }),
  };

  // The canvas carries the scroll range of the WHOLE result, and it has to do so from the first
  // paint: while the flow range is a window, the rows in the DOM describe only their own share of
  // the height, and without a total the scrollbar would appear only once the virtualizer took
  // over. `../styles/components.css` consumes it as `min-block-size`, a MINIMUM, so a value that
  // is still an estimate can never clip the rows that are actually rendered. It stays unset on the
  // two paths that render every row, where the rows themselves are the true height.
  const canvasStyle: CssVariableStyle | undefined =
    isVirtualized || flowRangeIsWindowed
      ? { '--dgc-virtual-total': String(virtualizer.getTotalSize()) }
      : undefined;

  /**
   * One data row, its cells and - when open - its detail row, inside the positioning wrapper.
   *
   * A plain function called during this component's render, not a component: it closes over the
   * columns, handlers and flags resolved above, so the two row paths - the virtualizer's window
   * and the flow range - render byte-identical markup and the difference between them stays where
   * it belongs, in the geometry.
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

    // The detail row renders exactly when this is true, and its id exists exactly then too, so the
    // `aria-controls` a caller's toggle takes from `meta` can never name a missing element.
    const detailRendered = model.expanded && renderExpandedRow !== undefined;
    const detailRowId = detailRendered
      ? `${generatedId}${DETAIL_ROW_ID_INFIX}${String(index)}`
      : undefined;

    // One object per row, shared by all of its cells: the state lives on the caller's toggle
    // rather than on the row, which a `grid` does not allow to report it (see the module header).
    const meta: DataTableCellMeta = { expanded: model.expanded, detailRowId };

    return (
      <div
        key={model.key}
        // `presentation` removes this wrapper from the accessibility tree so its `row` children
        // are exposed under the rowgroup. It carries no other ARIA attribute, because any one of
        // them would void the role and break the grid's required structure.
        role="presentation"
        className={positioned ? 'dg-virtual-row' : undefined}
        data-index={index}
        // Measurement is attached only while the virtualizer's window is real, so the flow path
        // above does not measure rows in an environment that can measure nothing.
        ref={isVirtualized ? virtualizer.measureElement : undefined}
        style={wrapperStyle}
      >
        <div
          role="row"
          aria-rowindex={model.ariaRowIndex}
          aria-selected={selectionInUse ? isSelected : undefined}
          // No `aria-expanded` here: a `grid` row does not support it (only a `treegrid` row
          // does), so the expanded state reaches the caller's toggle through `meta` instead, and
          // the row reports it only visually, through `dg-is-expanded` below.
          //
          // The roving tab stop: one row in the body is tabbable, and it is the body's ONLY Tab
          // stop - the controls in its cells are `tabIndex={-1}` and reached by the arrow keys.
          tabIndex={isActive ? 0 : -1}
          // Written literally so the attribute is visible where the row is; ROW_INDEX_ATTRIBUTE
          // is the same name, and `readRowIndex`, `rowSelector` and `resolveBodyScope` are the
          // only readers of it.
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
                {column.cell(model.row, index, meta)}
              </div>
            );
          })}
        </div>
        {detailRendered ? (
          <div
            role="row"
            id={detailRowId}
            aria-rowindex={model.detailAriaRowIndex}
            // Links the detail back to its data row by index. A separate name from
            // `data-row-index`, which marks an element as a DATA row to the key handlers, the
            // focus effect and every suite that counts rows by it.
            data-detail-row-index={index}
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
      {/* The keyboard description: never painted - `dg-visually-hidden` takes it out of the flow
          and the layout - and outside the grid, which accepts only rows and rowgroups. An empty
          grid has no row to operate, so it is neither rendered nor referenced then. */}
      {rowCount === 0 ? null : (
        <Text as="div" id={keyboardDescriptionId} size="sm" className="dg-visually-hidden">
          {keyboardDescription}
        </Text>
      )}
      <div className="dg-virtual-viewport" ref={viewportRef}>
        {/* The grid, and nothing between it and the rowgroups: `grid` accepts only `row` and
            `rowgroup` children, which is why the scroll container above carries no role. */}
        <div
          ref={gridRef}
          role="grid"
          aria-labelledby={captionId}
          aria-describedby={rowCount === 0 ? undefined : keyboardDescriptionId}
          aria-rowcount={ariaRowCount}
          aria-colcount={columnCount}
          style={gridStyle}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
        >
          <div role="rowgroup" className="dg-data-table__head" ref={headRef}>
            <div ref={headerRowRef} role="row" aria-rowindex={HEADER_ARIA_ROW_INDEX}>
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
                        // Out of the Tab order while rows exist, so the whole grid stays one Tab
                        // stop: ArrowUp from the first row reaches it, and ArrowLeft/ArrowRight
                        // move along the header. With no rows there is no row to arrive through,
                        // so it keeps its default and stays reachable by Tab.
                        tabIndex={rowCount > 0 ? -1 : undefined}
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
            <div role="rowgroup" className="dg-virtual-canvas" style={canvasStyle} ref={canvasRef}>
              {isVirtualized
                ? virtualItems.map((item) => {
                    const model = models[item.index];

                    return model === undefined ? null : renderRow(model, item.index, item.start);
                  })
                : // The flow range, sliced - every row when virtualization is off or
                  // `unmeasuredWindowRows` is `'all'`, a window anchored on the active row
                  // otherwise. The slice offset is added back so each row keeps its TRUE index:
                  // `data-row-index`, the ARIA indices carried on the model, and the `index`
                  // argument of `cell`, `onRowActivate` and `onRowToggle` all mean the row's
                  // position in the caller's `rows`, never its position in the window.
                  models
                    .slice(flowRange.start, flowRange.end)
                    .map((model, offset) => renderRow(model, flowRange.start + offset, undefined))}
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
