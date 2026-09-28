/**
 * `components/Waterfall` — the request and dependency view of the node catalog's
 * `waterfall` type, and one of the four components the slow-interaction
 * acceptance panel is built from.
 *
 * ## What it answers, and why offset and nesting carry the answer
 *
 * A timeline answers "which tier held the time"; a waterfall answers "what was
 * waiting on what". The story it exists to tell is that a slow interaction
 * spent its time in a *dependency* — a statement that ran long, an external
 * call that ran after another instead of beside it — rather than in the
 * handler the developer clicked. Exactly two properties make that story legible,
 * and they are the two this module treats as load-bearing:
 *
 *   - **Offsets are relative to the first included call**, never wall-clock
 *     time, so a bar's distance from the left edge *is* the wait that preceded
 *     it, and sequential work reads as a staircase.
 *   - **Children nest under the call that was waiting on them**, so the row that
 *     holds the time is visibly *inside* the row that was blocked by it.
 *
 * Nesting is reconstructed from the correlated `parentSpanId` links the service
 * already resolved, and a call whose immediate parent is not itself a waterfall
 * kind attaches to its nearest *included* ancestor rather than being orphaned to
 * the top level — which is what keeps a database statement underneath the server
 * request that issued it when the function span between them is not drawn here.
 *
 * A call the correlator itself RE-ATTACHED to the top level — its parent never
 * arrived, or its parent links were malformed — is a different statement from a
 * parent that is merely off this page, and it is drawn flagged rather than as an
 * ordinary top-level row: a "Re-attached" badge, the `dg-is-orphan` state, and a
 * sentence in its description naming the parent that could not be resolved:
 * orphans are evidence, never dropped and never disguised
 * (`docs/ARCHITECTURE.md`, "Attribution, joining and orphans"). The verdict is
 * the flag the service persisted on the flat record, honoured only while the
 * parent the record names is absent from what is held, because a parent that
 * resolves proves the flag stale. A call lifted to the top level through an
 * undrawn re-attached call carries that call's verdict, stated as inherited.
 * The grouped `requests` result carries no correlation verdict, so none of its
 * rows is ever flagged.
 *
 * ## The sources it draws
 *
 * The authority is the node catalog, not this file: the catalog entry for this
 * node type (`catalogEntryFor('waterfall')`, held in
 * {@link WATERFALL_CATALOG_ENTRY}) accepts `spans` and `requests`, and states
 * that `trace` is deliberately absent — the whole tree is the timeline's and
 * the hierarchical view's shape. Validation rejects a node whose query names
 * anything else before this component is mounted, and this component checks
 * the same entry again before it builds a query, so a host that renders an
 * unvalidated node naming `events`, `trace` or any other source gets a stated
 * failure and issues NO query, rather than a branch the specification could
 * never legally select:
 *
 *   - `spans` — the flat records and their parent links. The primary path: a
 *     page of records is filtered to the kinds this view draws, nested by
 *     ancestry, and ordered by start time.
 *   - `requests` — the grouped network result. Each group becomes one row; a
 *     group with more than one occurrence becomes a parent row spanning the
 *     occurrences, expandable into them. Grouping is **not** recomputed here:
 *     duplicate detection already happened in the service, on the pre-redaction
 *     request key (`docs/SECURITY.md`, "The pre-redaction request key"), and
 *     this view only draws what it grouped.
 *
 * ## Paging a source it filters
 *
 * The kind filter is applied HERE, to the pages as they arrive, and the node's
 * query goes to the service exactly as authored. That is deliberate: the flat
 * path needs the records it does not draw — the function and route-handler
 * spans between a server request and the statement it ran — to nest the
 * statement under the request, so asking the service for drawable kinds only
 * would cut the very chain the view exists to show, and rewriting the authored
 * filter would make the query this view reports differ from the one the
 * specification states.
 *
 * The cost is that a page can hold nothing drawable while a later one holds
 * the calls, and such a page is not "nothing was captured". While the service
 * reports another page — or the next page is in flight, or failed, behind pages
 * already searched — the view says how many records it has searched and that
 * more remain, and keeps "Load more" (or the failed page's retry) in reach.
 * Only a result searched to its end states that no call was captured. A node
 * whose own kind filter shares no kind with the ones drawn here issues no query
 * at all, because no page could ever hold a row.
 *
 * ## Bounded however far it is paged
 *
 * Three costs grow with a capture, and each has its own bound:
 *
 *   - **Folding, not rebuilding.** Each settled page is folded into indexes
 *     that persist across "Load more" (see "The held flat records" below):
 *     only the page's own records, and the held rows whose ancestry a new or
 *     departing span can change, are resolved. A call drawn at the top level
 *     because its parent was not loaded still moves under that parent when a
 *     later page supplies it.
 *   - **Holding, within a budget.** At most {@link RETAINED_ITEM_BUDGET} source
 *     items are held; past it the oldest pages are released, and the footer
 *     says which positions of the result are held and how many were loaded
 *     before them. Released calls were captured, and are never presented as
 *     missing.
 *   - **Mounting, within a window.** The rows a reader can reach are flattened
 *     into one list, and the tree mounts at most {@link WATERFALL_ROW_BUDGET}
 *     of them at once; Previous and Next rows move the window, the footer
 *     states which rows are shown of how many, and the keyboard pages the
 *     window when it steps past either edge. Expansion is kept by record id, so
 *     it survives every window move.
 *
 * ## Calls still in flight
 *
 * A request that had started and not settled when the capture ended arrives as
 * an in-flight snapshot: a `requests` occurrence marked `pending` (its group
 * counting it in `pendingCount`), or a flat `fetch`/`xhr` record carrying the
 * `inFlight` marker. Its duration is the time it had been outstanding when
 * observed — a lower bound, not a measurement of a completed call — and no
 * response had arrived. So it is drawn as exactly that: a "Pending" badge, the
 * duration printed and described as "at least" that long, and no status code,
 * no failure and no transfer figure claimed for a response that never came.
 * A group row holding such a call is flagged the same way, with the count when
 * more than one was in flight, and judges its own outcome over its settled
 * calls only — the rules the request aggregate itself applies.
 *
 * A duration that is not a measurement at all — negative, `null`, `NaN` or an
 * infinity in a malformed record — is kept apart from both: its bar is drawn at
 * zero so it still marks where the call began, and its duration is printed and
 * described as {@link NOT_AVAILABLE_LABEL}, never as a measured zero.
 *
 * ## Privacy: render what arrived, and nothing more
 *
 * URLs arrive with every query-parameter *value* already replaced per key, and
 * statements arrive parameterized with their literals replaced. Both are the
 * correct display form and are rendered verbatim: nothing here re-assembles a
 * URL from parts, unescapes a value, reconstructs a statement or offers to copy
 * a raw one. Request and response bodies are never captured, so no row can show
 * one, and row contents never exist — which is exactly why `db.rowCount` is
 * shown as a count. A transferred-byte figure is genuinely unavailable for some
 * calls; it renders as {@link NOT_AVAILABLE_LABEL}, never as a zero that would
 * read as "nothing was transferred". What is redacted, and what is never
 * captured, is stated in `docs/SECURITY.md` ("Redaction", "Never captured").
 *
 * ## Constraints this module works under
 *
 *   - **Data only through the node's query.** One `useQuery` per source family,
 *     resolved by the ambient `DataProvider`. No socket, no `fetch`, no message
 *     name, no knowledge of a transport (`docs/ARCHITECTURE.md`, "The renderer
 *     contract").
 *   - **Interactions only through `PanelActions`.** Selection, source opening and
 *     disclosure are reported through the ambient actions, which may be absent —
 *     every call site chains optionally and an affordance that would lead nowhere
 *     is not rendered as a control.
 *   - **No geometry is measured.** The time scale's range is a percentage
 *     interval, so every bar, every tick position and every row is relational
 *     and correct before layout. How MANY tick labels the axis carries is
 *     decided from the data alone as well: {@link fitAxisTicks} draws the
 *     densest tick set whose labels — sized by `../utils/format`'s
 *     `estimateTextWidth`, in ems — stay clear of each other on a fixed
 *     logical design strip {@link AXIS_DESIGN_WIDTH_EM} ems wide. The
 *     stylesheet guarantees that no real strip is narrower: the row grid
 *     floors the time track at a token-derived minimum at or above the
 *     strip, the axis row shares that grid, and a panel narrower than a
 *     row's resulting minimum scrolls the axis and the rows horizontally
 *     together in `.dg-waterfall__viewport` (the footer stays outside it)
 *     rather than squeezing the track. Tick positions grow with the strip
 *     while label extents do not, so a set that is legible at that width is
 *     legible on every strip drawn. This file reads no element's size,
 *     observes no resize and consults no computed style, so the chart draws
 *     the same from the same data in a browser, in a panel of any width and
 *     in the layout-free DOM the colocated suite and `host/registry.test.ts`
 *     render it in. (The one placement this view delegates — where the shared
 *     `Tooltip` primitive opens its bubble, below — is the primitive's, and
 *     places a popover, never a bar, a tick or a row. An open bubble is fixed
 *     to the browser viewport, so the scroll viewport never clips it.)
 *   - **Zero hardcoded CSS values.** Colour comes from `../utils/color` as token
 *     references, geometry from `../utils/scale` as unitless numbers, and the
 *     inline style of a bar is the `--dgc-*` custom properties the stylesheet's
 *     naming contract reserves for "a value only the component knows" plus the
 *     two geometry declarations that consume them — which is the contract
 *     `.dg-waterfall__bar` states in `../styles/components.css` ("`inset-inline-start`
 *     and `inline-size` are the component's, computed from the time scale").
 *     Neither declaration contains a literal: both are `var()` references to the
 *     properties beside them. The row's colour, `--dgc-bar-color`, is the
 *     file's only other inline declaration: set on the row itself — a token
 *     reference and nothing else — so the bar and a failed row's edge are
 *     painted from one value. How the label column shares its width with its
 *     chips is the stylesheet's (`.dg-waterfall__name`,
 *     `.dg-waterfall__label-slot`), in tokens.
 *   - **Primitives, not raw elements.** Every non-SVG control and every piece of
 *     text is a primitive from `../primitives/**` or a container from
 *     `../layout/**`; there is no raw `button`, `input`, `select`, `table` or
 *     heading element in this file.
 *   - **Extensionless relative specifiers**, which is this workspace's
 *     `moduleResolution: "bundler"` convention — not the `.js`-suffixed
 *     convention of the Node-targeted packages.
 *
 * ## Accessibility
 *
 * The row list is the keyboard-reachable representation of the chart and is a
 * `role="tree"` of `role="treeitem"` rows: each row carries `aria-level`,
 * `aria-posinset` and `aria-setsize` — stated outright, because the mounted
 * window may hold only some of a row's siblings — and, when it has children or
 * an abbreviated label, `aria-expanded`; it owns its mounted child group
 * through `aria-owns` (the group is a DOM sibling because the row itself is the
 * three-column grid the stylesheet defines: a child group inside it would have
 * to become a grid item too, and treeitems nested inside a treeitem's own grid
 * would read as part of that one row).
 * Each row names itself with `aria-label`, so what is
 * announced is the label, what the call was, how far into the window it
 * started and how long it took, rather than the truncated label and the
 * tooltip's copy of it. The name carries the label bounded to
 * {@link NAME_LABEL_PREVIEW_LENGTH} code points, because a name is announced
 * whole on every visit and a multi-kilobyte statement would drown the rest of
 * the sentence. The bar layer is `aria-hidden`, which the guidance
 * prefers where the duration is printed as text, and the time axis is a
 * `role="img"` graphic whose label states the window it spans. A row's states
 * are never colour alone: a failed call shows its failing status code or an
 * "Error" badge beside the `dg-is-error` edge, a re-attached call a
 * "Re-attached" badge beside the `dg-is-orphan` edge, and a call still in
 * flight a "Pending" badge and the words "at least" before its duration.
 *
 * The tree is ONE composite widget, so it is ONE stop in the page's Tab order —
 * a roving tab index: exactly one mounted row carries `tabIndex={0}` and every
 * other row `-1`. The stop starts on the first top-level row, follows focus to
 * whichever row last received it, falls back to the nearest visible ancestor
 * when a collapse hides the row that held it, and to the window's first row
 * when the window moved away from it (see {@link resolveTabStop}). Tab from any
 * row therefore leaves the tree, and Tab back into it lands on the row that was
 * left. The keyboard model, in full — every move is over the whole list of
 * visible rows, and one that lands outside the mounted window moves the window
 * to it:
 *
 *   - **ArrowDown / ArrowUp** — the next and previous visible row.
 *   - **ArrowRight** — open a closed row, then step into its first child. A
 *     row opens when it has children or an abbreviated label (see "The whole
 *     of a long value" below); a leaf has no child to step into.
 *   - **ArrowLeft** — close an open row, then step out to its parent.
 *   - **Home / End** — the first and last visible row.
 *   - **Enter / Space** — select the row (`onSelectEvent`).
 *   - **Shift+Enter** — open the row's source location (`onOpenSource`), on a
 *     row that resolved to one while the host offers the action. Advertised
 *     through `aria-keyshortcuts` on exactly those rows, and never consumed
 *     anywhere else.
 *   - **Escape** — dismiss the row's revealed description until focus leaves
 *     the row; consumed only when there was a description to dismiss.
 *
 * The row's full description — the sentence its `aria-label` carries — is a
 * hover tooltip on the label for a pointer. The label is not focusable and must
 * not become a second stop, so for the KEYBOARD the same sentence is revealed
 * when the treeitem itself receives focus other than from a pointer press, by
 * the label's own `Tooltip` held open by the row (its controlled `open`), with
 * a Shift+Enter hint on a row whose source can be opened. The primitive places
 * that bubble exactly as it places a hovered one — measured against the label,
 * re-measured on scroll and resize — because an open bubble is fixed to the
 * viewport and one nobody placed is painted at its corner. It describes
 * nothing (`describesTrigger={false}`, so it is `aria-hidden`): a screen reader
 * already hears the sentence as the row's name.
 *
 * The treeitem is the sole focus target of its row. The disclosure button and
 * the source chip nested inside it stay real, pointer-activatable buttons but
 * carry `tabIndex={-1}`, because a nested control left in the Tab order is a
 * second or third stop per row that the pattern forbids; ArrowRight/ArrowLeft
 * and Shift+Enter are the keyboard routes to the same two intents.
 *
 * ## The whole of a long value
 *
 * A row shows its label cut to {@link LABEL_PREVIEW_LENGTH} code points, so a
 * long redacted URL or parameterized statement is abbreviated on the row. The
 * whole value is still one hover, one focus or one key away (WCAG 1.4.13,
 * 2.1.1):
 *
 *   - the description bubble — hovered, or revealed for keyboard focus —
 *     carries the whole label, whitespace collapsed; the `Tooltip` primitive
 *     bounds that bubble to a token block size, scrolls what does not fit and
 *     lets the pointer rest on it;
 *   - a row whose label is abbreviated is expandable even when it has no
 *     children. Expanding it — ArrowRight, or its disclosure button — shows the
 *     row's full-value detail: the whole label exactly as it arrived, wrapping,
 *     in a fourth grid item spanning every track of the row
 *     (`grid-column: full`) below the three the row always draws. It needs no
 *     scroll box of its own, so no focus stop either: it grows the row, and the
 *     panel scrolls it like any other content. While shown it describes the
 *     treeitem (`aria-describedby`), so a screen reader hears the whole value
 *     beside the bounded name. A row with children as well opens both at once:
 *     one row, one expanded state, kept by record id like every expansion.
 *
 * Nothing is un-redacted on the way: the value shown is the one the service
 * stored, whose URL query values and statement literals the capture already
 * replaced (`docs/SECURITY.md`). The 120-code-point preview bound of
 * `../utils/format` is the capture's bound on prop, state and attribute
 * previews; a redacted URL and a parameterized statement are not previews,
 * and arrive whole.
 */

import type { DataQuery, WaterfallNode } from '@debuggen/panel-schema';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { clampNonNegative, roundMs } from '@debuggen/shared';
import type {
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  RequestGroup,
  RequestOccurrence,
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChartNoAxesGantt, ChevronDown, ChevronRight, Hourglass } from 'lucide-react';
import { Fragment, useCallback, useId, useMemo, useRef, useState, useLayoutEffect } from 'react';
import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from 'react';

import { Stack } from '../layout/Stack';
import { usePanelSessionId } from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import type { UseQueryResult } from '../host/useQuery';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { Kbd } from '../primitives/Kbd';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import {
  httpStatusTone,
  isFailureOutcome,
  isHttpFailureStatus,
  kindColorVar,
  outcomeColorVar,
} from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  collapseWhitespace,
  countedNoun,
  estimateTextWidth,
  formatBytes,
  formatCount,
  formatCountOf,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatShare,
  formatStatusLabel,
  formatTierLabel,
  formatUntrustedText,
  oneLinePreview,
  pluralize,
} from '../utils/format';
import type { CountedNoun } from '../utils/format';
import {
  DEFAULT_ROW_GUTTER,
  DEFAULT_ROW_HEIGHT,
  createTimeScale,
  generateAxisTicks,
  nextWindowStart,
  placeOffsetSpan,
  previousWindowStart,
  windowContains,
  windowRows,
  windowStartFor,
} from '../utils/scale';
import type { AxisTick, RowWindow, TimeScale } from '../utils/scale';
import { SourceLink } from './SourceLink';

/* ---------------------------------------------------------------------------
 * Attribute keys
 *
 * The keys read from a record's attribute bag are declared here as constants
 * *typed against the telemetry package's own key catalogs*, which are imported
 * for their types only — no runtime import of `@debuggen/telemetry` exists in
 * this file, and none may.
 *
 * The typing is the point: renaming `http.status_code` upstream turns each line
 * below into a compile error in this file, instead of leaving a status column
 * that silently stops rendering. A bare string literal would buy nothing.
 * ------------------------------------------------------------------------- */

/** One of the keys the telemetry package declares for a `fetch` record. */
type FetchAttributeKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];

/** One of the keys the telemetry package declares for an `http.server` record. */
type HttpServerAttributeKey = (typeof HTTP_SERVER_ATTRIBUTE_KEYS)[number];

/** One of the keys the telemetry package declares for a `db.query` record. */
type DbQueryAttributeKey = (typeof DB_QUERY_ATTRIBUTE_KEYS)[number];

/** The request method, as the producer reported it. */
const HTTP_METHOD_KEY: FetchAttributeKey = 'http.method';

/** The request URL, already redacted per query-parameter key. */
const URL_KEY: FetchAttributeKey = 'url';

/** The response status code. */
const HTTP_STATUS_CODE_KEY: FetchAttributeKey = 'http.status_code';

/** Bytes transferred, where the runtime could observe them. */
const TRANSFER_SIZE_KEY: FetchAttributeKey = 'transferSize';

/**
 * The in-flight marker: written, only as the boolean `true`, on the one
 * snapshot the page's request patch emits for a request that had started and
 * not settled when the capture ended. The same key `xhr` records carry; the
 * telemetry package's request aggregate reads it — and only it — as *pending*.
 */
const IN_FLIGHT_KEY: FetchAttributeKey = 'inFlight';

/** The matched server route, which labels a server span better than its name. */
const HTTP_ROUTE_KEY: HttpServerAttributeKey = 'http.route';

/** The parameterized statement text. Literals are already replaced. */
const DB_STATEMENT_KEY: DbQueryAttributeKey = 'db.statement';

/** How many rows the statement touched. Row *contents* are never captured. */
const DB_ROW_COUNT_KEY: DbQueryAttributeKey = 'db.rowCount';

/**
 * The lineage keys, which the telemetry package declares as a plain
 * `readonly string[]` — so, unlike the catalogs above, its type carries no
 * literals to pin these against.
 */
const LINEAGE_AMBIGUOUS_KEY = 'lineageAmbiguous';
const LINEAGE_CANDIDATES_KEY = 'lineageCandidates';

/**
 * The correlation keys, likewise a plain `readonly string[]` upstream
 * (`CORRELATION_ATTRIBUTE_KEYS`): the flag the service writes onto a record it
 * had to re-attach because the parent it named could not be resolved, and the
 * id of that parent — so the repair survives in the store and is visible to a
 * flat page, not only to a tree. The telemetry package's `orphanFlagsOf` reads
 * the same two keys with the same meaning.
 */
const ORPHANED_KEY = 'orphaned';
const ORPHANED_PARENT_SPAN_ID_KEY = 'orphanedParentSpanId';

/* ---------------------------------------------------------------------------
 * Geometry and layout constants
 * ------------------------------------------------------------------------- */

/**
 * The time scale's pixel range is a *percentage* interval rather than a measured
 * width, which is what makes every bar correct without measuring anything: the
 * numbers `../utils/scale` returns are consumed as percentages of the track, the
 * track takes its width from the row's grid template, and every bar and tick
 * position is right on the first paint and after every resize with no observer
 * involved. How many tick labels are drawn is decided without a width too
 * (see {@link fitAxisTicks}).
 */
const PERCENT_RANGE = 100;

/**
 * How many axis ticks to aim for; `generateAxisTicks` rounds to a nice step.
 *
 * The densest the axis asks for. {@link fitAxisTicks} starts here and asks for
 * fewer until the labels clear each other on the design strip.
 */
const AXIS_TICK_TARGET = 6;

/**
 * The minimum spacing between ticks, expressed in the same percentage units as
 * {@link PERCENT_RANGE}. The default the scale applies is a pixel figure, which
 * in a hundred-unit range would cap the axis at two ticks.
 */
const AXIS_TICK_MIN_SPACING = PERCENT_RANGE / AXIS_TICK_TARGET;

/**
 * The font size at which `estimateTextWidth` answers in ems: one.
 *
 * The axis fit is carried out entirely in ems of the label's own font — label
 * extents, the gap between labels and the design strip alike — so it assumes
 * no pixel size for the `xs` type role the strip is set in, and stays exact
 * in every theme and at every user font scale.
 */
const EM_FONT_SIZE = 1;

/** The clear space kept between two neighbouring tick labels, in ems: one. */
const AXIS_LABEL_GAP_EM = 1;

/**
 * The width of the logical strip the tick labels are fitted to, in ems of the
 * label font: 14.
 *
 * No track the axis is drawn on is narrower, and that is guaranteed rather
 * than estimated: the stylesheet's chart grid gives the time track a minimum
 * derived from the space tokens (`.dg-waterfall__viewport` in
 * `../styles/components.css`, seven units of `--dg-space-7`: 168 pixels,
 * above the 154 pixels fourteen ems of the `xs` role come to at its size in
 * the token table), and the axis row and every call row are laid out on that
 * one grid, as subgrids. The colocated suite reads that minimum from the
 * stylesheet and holds it at or above this width in every theme.
 *
 * Nothing here reads the real width: the labels are placed against this strip
 * once, from the scale alone, and every real strip is at least this wide, so
 * it only moves the ticks further apart while the labels keep their extent —
 * a set whose labels clear each other at this width clears each other on
 * every strip actually drawn, and the same data always draws the same axis. A
 * panel narrower than the grid's minimum does not squeeze the strip: the axis
 * and the rows scroll horizontally together in `.dg-waterfall__viewport`, whose
 * tracks every row shares, so the strip lines up with their tracks while it
 * scrolls exactly as it does when nothing scrolls.
 */
const AXIS_DESIGN_WIDTH_EM = 14;

/** The axis strip's height, in the same unitless SVG geometry as the row rhythm. */
const AXIS_HEIGHT = DEFAULT_ROW_HEIGHT;

/** The length of a tick mark below the axis line. */
const AXIS_TICK_LENGTH = DEFAULT_ROW_GUTTER * 2;

/** The baseline the tick labels sit on, inside {@link AXIS_HEIGHT}. */
const AXIS_LABEL_BASELINE = AXIS_HEIGHT - DEFAULT_ROW_GUTTER;

/**
 * How deep the nesting may go before a subtree is reported as truncated.
 *
 * A correlated interaction is a handful of levels deep; a much deeper one is
 * either pathological or a cycle in the parent links, and neither should be
 * rendered as an unbounded recursion. A cut is always *reported* on the row that
 * was cut, never silently dropped.
 */
const MAX_ROW_DEPTH = 24;

/** How many parent hops to follow when looking for an included ancestor. */
const MAX_ANCESTOR_HOPS = 64;

/**
 * The most rows the tree mounts at once: 200.
 *
 * A waterfall row is not a bar. It is the stylesheet's three-column grid
 * holding a disclosure button, badges, a label with its tooltip, a source
 * chip, a track and a duration cell — some thirty to forty elements with their
 * handlers. `../utils/scale`'s absolute budget (`MAX_DRAWN_ROWS`, 2 000) is
 * sized for SVG bars and invites a view with heavier rows to pass a smaller
 * budget of its own; a tenth of it keeps the mounted tree to a few thousand
 * elements however many calls are held and however many rows are expanded,
 * and still holds a default-sized page of top-level calls in one window.
 *
 * Rows past the window are not dropped. The flattened list of every visible
 * row is kept, the window moves over it — the Previous and Next row controls,
 * or the keyboard stepping past either edge — and the footer states which rows
 * are shown of how many (see {@link windowRows}).
 */
const WATERFALL_ROW_BUDGET = 200;

/**
 * The most source items — flat records, or request groups — the view holds at
 * once: 10 000, twice the largest page a query may ask for
 * (`DATA_QUERY_MAX_LIMIT`).
 *
 * "Load more" appends pages, and without a ceiling a long capture paged to its
 * end would hold every record it ever loaded. Past this budget the OLDEST held
 * pages are released — never the page that just arrived — so the view always
 * holds the newest page and, even at the largest page size, the page before
 * it, which is where the parent of a call on the newest page usually is. What
 * was released is stated, never presented as not captured: the footer says
 * which positions of the result are held and how many were loaded before them
 * (see {@link describeRetention}), and, once pages are released, a persisted
 * re-attachment flag whose parent is not held says only that, never that the
 * parent never arrived.
 */
const RETAINED_ITEM_BUDGET = 2 * DATA_QUERY_MAX_LIMIT;

/**
 * How much of a redacted URL or statement a row shows before it is elided. A
 * label longer than this is abbreviated on the row, which is what makes the
 * row expandable into its full-value detail (see the module header, "The
 * whole of a long value").
 */
const LABEL_PREVIEW_LENGTH = 120;

/**
 * How much of the label the row's accessible name repeats. The name is
 * announced whole on every visit, so it is bounded; the description bubble and
 * the full-value detail carry the label whole.
 */
const NAME_LABEL_PREVIEW_LENGTH = 400;

/* ---------------------------------------------------------------------------
 * The catalog entry, and everything taken from it
 * ------------------------------------------------------------------------- */

/**
 * `PANEL_NODE_CATALOG.waterfall` — the single registry entry for the node type
 * this component renders. The renderer depends on the schema, never the
 * reverse (`docs/ARCHITECTURE.md`, "Workspace layout and dependency layering").
 *
 * Read once at module scope because it is frozen data. The sources a waterfall
 * node may query (see {@link narrowSpanListQuery}) and the record kinds it
 * draws (see {@link WATERFALL_KINDS}) both come from here rather than from a
 * list retyped in this file, so changing the catalog changes this component
 * instead of leaving it reading a source, or dropping a kind, that the schema
 * says otherwise about. `@debuggen/panel-schema` is a runtime dependency of
 * this package; `@debuggen/telemetry` is not, and stays a types-only import
 * here.
 */
const WATERFALL_CATALOG_ENTRY = catalogEntryFor('waterfall');

/**
 * Whether the catalog entry permits a waterfall node to read `source`.
 *
 * @param source The source named by the node's query.
 * @returns `true` while the entry's `sources` list names it.
 */
function isCataloguedSource(source: DataQuery['source']): boolean {
  return WATERFALL_CATALOG_ENTRY.sources.includes(source);
}

/* ---------------------------------------------------------------------------
 * The kinds this view draws
 * ------------------------------------------------------------------------- */

/**
 * The record kinds a waterfall draws — today the two browser-side request
 * kinds, the server request, the database statement and the outgoing
 * server-side call.
 *
 * Taken from the catalog entry's `telemetryKinds`, which is the single
 * registry of what this node type draws: the entry itself takes the list from
 * `@debuggen/telemetry`'s own `WATERFALL_KINDS` kind group, and no second
 * spelling of it exists here. A kind added there is drawn here automatically,
 * and a kind withdrawn there stops being drawn, instead of this view silently
 * disagreeing with what validation accepts for a `filter.kinds` narrowing.
 * The telemetry package itself stays a types-only import in this file: the
 * list arrives through `@debuggen/panel-schema`, which is a runtime dependency.
 *
 * Membership of this set is the ONLY thing that decides whether a record is
 * drawn. The two sets below it are presentation subsets that decide how a
 * drawn row is labelled and what it is expected to report, never whether it
 * appears.
 */
const WATERFALL_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>(
  WATERFALL_CATALOG_ENTRY.telemetryKinds,
);

/**
 * PRESENTATION ONLY: the kinds whose label is a URL or a route rather than a
 * statement or a record name — the calls that are requests.
 *
 * Used only to choose which field labels a drawn row (see {@link rowLabel}),
 * where the kind check keeps a stray `url` attribute on a non-request record
 * from hijacking its label. It decides nothing about whether a record is drawn:
 * that is {@link WATERFALL_KINDS} alone, so a kind the catalog adds later is
 * drawn at once and labelled by its own name until it is listed here. Typed as
 * a set of {@link TelemetryKind} and populated with literals on purpose, so a
 * kind renamed or removed upstream is a compile error in this file.
 */
const REQUEST_LIKE_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  'fetch',
  'xhr',
  'http.server',
  'http.client',
]);

/**
 * PRESENTATION ONLY: the kinds for which a transferred-byte figure is
 * meaningful, so that its absence can be reported as unavailable rather than
 * passed over. A server-side span has no resource timing behind it, so the
 * figure is not expected there and is not claimed to be missing either.
 *
 * The same two browser request kinds are the ones whose producer — the page's
 * patched `fetch` and `XMLHttpRequest` — writes the in-flight marker, so
 * {@link isInFlightRecord} reads the marker on these kinds only. Like
 * {@link REQUEST_LIKE_KINDS}, this set decides only what a drawn row states,
 * never whether it is drawn.
 */
const TRANSFER_BEARING_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>(['fetch', 'xhr']);

/**
 * Narrow the kinds this render will include to the intersection of what the view
 * draws and what the node's own query asked for.
 *
 * The intersection is never widened: a specification that filtered to kinds this
 * view cannot draw yields an empty set, and an empty set means no query is
 * issued at all and the view states that the node's kind filter selects no kind
 * it draws — which is the honest outcome, not a silently broadened query, and
 * not a "Load more" through pages that could never hold a row.
 */
function resolveIncludedKinds(
  filterKinds: readonly TelemetryKind[] | undefined,
): ReadonlySet<TelemetryKind> {
  if (filterKinds === undefined) {
    return WATERFALL_KINDS;
  }
  const narrowed = new Set<TelemetryKind>();
  for (const kind of filterKinds) {
    if (WATERFALL_KINDS.has(kind)) {
      narrowed.add(kind);
    }
  }
  return narrowed;
}

/* ---------------------------------------------------------------------------
 * The render-local view model
 *
 * This is a VIEW MODEL, not a schema: it exists for the duration of one render,
 * nothing outside this file constructs or consumes it, and it is not a second
 * definition of any wire or storage shape. Every cross-process shape has exactly
 * one definition in `@debuggen/telemetry`, `@debuggen/panel-schema` or
 * `@debuggen/shared` (`docs/ARCHITECTURE.md`, "Workspace layout and dependency
 * layering"), and the fields below are *derived* from those: the names mirror
 * `TimelineRow` so that the offset convention is the same one the correlated
 * timeline uses.
 * ------------------------------------------------------------------------- */

/**
 * Why a row sits at the top level although its call named a parent: the
 * correlator re-attached it — or re-attached an enclosing call this view does
 * not draw, lifting this one with it — because that parent could not be
 * resolved. Real captured work with real timings, drawn and flagged rather than
 * dropped, so the structure around it is never mistaken for the shape the
 * application had.
 *
 * The provenance is the flag the service persisted on a flat record, which
 * records only THAT the parent was unresolvable — never which of the
 * correlator's cases applied — so no reason is carried or claimed here.
 */
interface PersistedOrphan {
  /** The parent id that could not be resolved, when one was recorded. */
  readonly missingParentSpanId: string | undefined;
  /**
   * Set when the re-attached record is an undrawn call enclosing this one
   * rather than this call itself: this row was lifted to the top level along
   * with it.
   */
  readonly viaAncestor: boolean;
}

/**
 * A {@link PersistedOrphan} as a drawn row states it.
 *
 * The flag is honoured only while the parent it names is absent from the
 * records held. Before anything is released that absence is proof the parent
 * never arrived; once pages have been released to stay within
 * {@link RETAINED_ITEM_BUDGET}, the parent may have been among them, so the row
 * says only what is still known — that the parent is not held — rather than
 * claiming it never arrived.
 */
interface WaterfallOrphan extends PersistedOrphan {
  /** Set when records were released, so the parent's absence proves nothing more. */
  readonly unverified: boolean;
}

/**
 * One drawn row: a call, its measured place in the window, and how many calls
 * ran inside it. Built only for the rows the tree mounts (see
 * {@link WATERFALL_ROW_BUDGET}); the held records themselves live in the
 * indexes below.
 *
 * Every member is required and nullable rather than optional, which under
 * `exactOptionalPropertyTypes` keeps the builders free of conditional spreads
 * and keeps every reader honest about absence.
 */
interface WaterfallRow {
  /** React key and the coordinate reported to the host on selection. */
  readonly eventId: string;
  /** The span this row is, when the payload carries one. */
  readonly spanId: string | undefined;
  /** The span this row was nested under, for the details drawer's parent chain. */
  readonly parentSpanId: string | undefined;
  /** The interaction this row belongs to. */
  readonly traceId: string | undefined;
  /** The record's own name, used as the label when nothing better exists. */
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
  readonly status: TelemetryStatus;
  /** The request method, when the record reported one. */
  readonly method: string | undefined;
  /** The redacted URL, rendered exactly as it arrived. */
  readonly url: string | undefined;
  /** The matched server route, which labels a server request best. */
  readonly route: string | undefined;
  /** The response status code, when the record reported one. */
  readonly statusCode: number | undefined;
  /** The parameterized statement, rendered exactly as it arrived. */
  readonly statement: string | undefined;
  /** How many rows the statement touched. Never row contents. */
  readonly rowCount: number | undefined;
  /** Bytes transferred, where the runtime observed them. */
  readonly transferredBytes: number | undefined;
  /** Whether a transferred-byte figure is expected for this kind of call. */
  readonly expectsTransfer: boolean;
  /** How many grouped occurrences this row stands for, for a grouped payload. */
  readonly occurrenceCount: number | undefined;
  /**
   * Set when this call — or, on a group row, at least one of its calls — was
   * still in flight when the capture ended. Its duration is then the time it
   * had been outstanding when observed, a LOWER BOUND on how long it took, and
   * a pending call has no response: no status code, no transfer figure, and no
   * outcome, so it is never drawn as a failure either.
   */
  readonly pending: boolean;
  /**
   * How many calls of a group row were still in flight, when that is known and
   * above zero; `undefined` on every single-call row and on a group with none.
   */
  readonly pendingCount: number | undefined;
  /** Epoch milliseconds, kept so tooltips can state an offset from the window. */
  readonly startTime: number;
  /** Milliseconds from the window's start to this call's start. */
  readonly offsetMs: number;
  /**
   * The call's duration as DRAWN, in milliseconds: never negative and never
   * non-finite, with a duration that was not measured drawn as zero. Geometry
   * only — the bar's length and the window's extent. Every figure a reader is
   * shown comes from {@link WaterfallRow.measuredMs} instead, so a corrupt
   * duration is never printed as the fastest call of the capture.
   */
  readonly durationMs: number;
  /**
   * The call's duration as SHOWN, in milliseconds, or `undefined` when the
   * record's duration is not a measurement (see {@link measuredDuration}): the
   * duration cell then reads "n/a" and the row's description "took n/a".
   */
  readonly measuredMs: number | undefined;
  /** Where the call came from in the project, when it resolved to a location. */
  readonly source: SourceLocation | undefined;
  /** Set when the parent link was inferred from an ambiguous async continuation. */
  readonly lineageAmbiguous: boolean;
  /** The other candidate parents of an ambiguous continuation. */
  readonly lineageCandidates: readonly string[];
  /** Set when the call was re-attached to the top level; see {@link WaterfallOrphan}. */
  readonly orphan: WaterfallOrphan | undefined;
  /** Set when this row's own children were cut by the depth bound or by the payload. */
  readonly childrenTruncated: boolean;
  /**
   * How many rows are nested directly under this one and can be disclosed:
   * the calls that ran inside it, or a group's occurrences. `0` for a leaf and
   * for a row whose children the depth bound cut.
   */
  readonly childCount: number;
}

/**
 * What the held records amount to as a chart: the window every offset is
 * measured from, how many rows the whole held tree holds, and whether any of
 * it was cut. Computed once per fold, not per render, and never from the rows
 * that happen to be mounted.
 */
interface HeldSummary {
  /** The window's start, in epoch milliseconds; every offset is relative to it. */
  readonly viewStart: number;
  /** The window's end, in epoch milliseconds. */
  readonly viewEnd: number;
  /** The window's extent, in milliseconds. */
  readonly windowMs: number;
  /** How many rows the held tree holds, collapsed subtrees included. */
  readonly rowCount: number;
  /** Set when a subtree was cut, either by the depth bound or by the payload. */
  readonly truncated: boolean;
}

const EMPTY_STRINGS: readonly string[] = [];
const EMPTY_IDS: readonly string[] = [];

const EMPTY_SUMMARY: HeldSummary = {
  viewStart: 0,
  viewEnd: 0,
  windowMs: 0,
  rowCount: 0,
  truncated: false,
};

/* ---------------------------------------------------------------------------
 * Reading a record's attribute bag
 *
 * An attribute bag is `Record<string, unknown>` by schema, because a producer
 * may report anything a key allows and the service redacts values without
 * narrowing their types. Every read below therefore validates before it returns,
 * and answers `undefined` rather than coercing: a status code that arrived as a
 * malformed string must render as absent, not as `NaN`.
 * ------------------------------------------------------------------------- */

type AttributeBag = Readonly<Record<string, unknown>>;

/** A non-empty string attribute, or `undefined`. */
function stringAttribute(attributes: AttributeBag, key: string): string | undefined {
  const value = attributes[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

/**
 * A finite numeric attribute, or `undefined`.
 *
 * Numeric strings are accepted because a status code and a byte count both
 * legitimately arrive as text from some producers; anything else is absent.
 */
function numberAttribute(attributes: AttributeBag, key: string): number | undefined {
  const value = attributes[key];
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A boolean attribute, treating the string `"true"` as set. */
function booleanAttribute(attributes: AttributeBag, key: string): boolean {
  const value = attributes[key];
  return value === true || value === 'true';
}

/** A list-of-strings attribute, with non-strings and blanks dropped. */
function stringListAttribute(attributes: AttributeBag, key: string): readonly string[] {
  const value = attributes[key];
  if (!Array.isArray(value)) {
    return EMPTY_STRINGS;
  }
  const entries: string[] = [];
  for (const candidate of value as readonly unknown[]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      entries.push(candidate);
    }
  }
  return entries.length === 0 ? EMPTY_STRINGS : entries;
}

/* ---------------------------------------------------------------------------
 * Numeric helpers
 * ------------------------------------------------------------------------- */

/** The value when it is finite, and the fallback when it is not. */
function asFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A duration that can be drawn: never negative, never non-finite.
 *
 * Geometry only. A duration that was not measured is drawn as zero so the bar
 * still marks where the call began, but that zero is never printed — see
 * {@link measuredDuration} for the value a reader is shown.
 */
function drawableDuration(value: number): number {
  return Number.isFinite(value) ? clampNonNegative(value) : 0;
}

/**
 * A duration a reader may be shown as measured, or `undefined` when the
 * record's value is not a measurement.
 *
 * The display twin of {@link drawableDuration}, and the same judgement
 * `formatDuration` and `DurationCell` make: a duration cannot be negative, so a
 * negative one — or `null`, `NaN` or an infinity arriving through a malformed
 * record — is corrupt rather than fast, and is stated as unavailable. A value
 * below zero only by floating-point noise, one that rounds to zero at the
 * shared three-decimal resolution, is the zero it is.
 *
 * @param value The record's duration, in milliseconds.
 */
function measuredDuration(value: number): number | undefined {
  return Number.isFinite(value) && roundMs(value) >= 0 ? clampNonNegative(value) : undefined;
}

/**
 * The offset of a call from the window's start.
 *
 * Rounded through the shared millisecond policy and clamped at zero, which is
 * the same treatment `formatOffset` applies — so a bar's position and the
 * offset a tooltip prints can never disagree by a floating-point artefact.
 */
function offsetFrom(viewStart: number, startTime: number): number {
  return clampNonNegative(roundMs(asFiniteNumber(startTime, viewStart) - viewStart));
}

/* ---------------------------------------------------------------------------
 * Ordering
 *
 * A waterfall is time-ordered by definition, so sibling rows are drawn in start
 * order regardless of the `sort` the query carried: the query's ordering decides
 * *which* records the page holds — that selection belongs to the service and is
 * never recomputed here — while the drawing order is intrinsic to the view. The
 * tie-break is the record id, which is stable and always distinct, so two calls
 * that share a start time never swap between renders.
 * ------------------------------------------------------------------------- */

function compareByStartThenId(
  leftStart: number,
  leftId: string,
  rightStart: number,
  rightId: string,
): number {
  const byStart = asFiniteNumber(leftStart, 0) - asFiniteNumber(rightStart, 0);
  if (byStart !== 0) {
    return byStart;
  }
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

function compareEvents(left: TelemetryEvent, right: TelemetryEvent): number {
  return compareByStartThenId(left.startTime, left.id, right.startTime, right.id);
}

/**
 * Merges ids into a list already in drawing order: drops the ids leaving it,
 * sorts the ids joining it and interleaves the two, so a fold costs the list's
 * length plus the joiners' sort — never a re-sort of everything held.
 *
 * @param base The list as it was, in drawing order.
 * @param leaving Ids to drop, when any.
 * @param joining Ids to add, in any order, when any.
 * @param compare The drawing order.
 * @returns The new list, in drawing order.
 */
function mergeOrdered(
  base: readonly string[],
  leaving: ReadonlySet<string> | undefined,
  joining: readonly string[] | undefined,
  compare: (left: string, right: string) => number,
): readonly string[] {
  const kept = leaving === undefined ? base : base.filter((id) => !leaving.has(id));
  if (joining === undefined || joining.length === 0) {
    return kept;
  }
  const incoming = [...joining].sort(compare);
  const merged: string[] = [];
  let keptAt = 0;
  let incomingAt = 0;
  while (keptAt < kept.length || incomingAt < incoming.length) {
    const left = kept[keptAt];
    const right = incoming[incomingAt];
    if (right === undefined || (left !== undefined && compare(left, right) <= 0)) {
      if (left !== undefined) {
        merged.push(left);
      }
      keptAt += 1;
    } else {
      merged.push(right);
      incomingAt += 1;
    }
  }
  return merged;
}

/* ---------------------------------------------------------------------------
 * The held flat records (`spans`), folded one page at a time
 *
 * A flat page is nested by ancestry: a drawn record sits under its nearest
 * DRAWN ancestor, found by walking `parentSpanId` links through every held
 * record — drawn or not — which is what keeps a statement under the server
 * request that issued it when the function span between them is a kind this
 * view does not draw. Links are resolved within a record's own trace: a
 * `parentSpanId` names a span of the same trace, so every lookup is keyed by
 * trace and span together.
 *
 * The records are not rebuilt into a tree per page. They are FOLDED into
 * indexes that persist across "Load more": each held record by id, the records
 * holding each span key, where every drawn record was placed, the drawn
 * children of each drawn record, and the top-level rows. A fold resolves only
 * what can have changed — the page's own records, and the held records whose
 * ancestry walk looked up a span key whose holder the fold changed. That
 * second set is what keeps re-parenting exact: a call drawn at the top level
 * because its parent was not loaded moves under that parent the moment a
 * later page supplies it (or supplies the undrawn span between them), and a
 * call whose parent is released moves back to the top level. Every walk
 * records the keys it looked up, so the index knows precisely which rows a new
 * or departing key can move; nothing else is revisited, no row object is
 * built, and no attribute is read again. A fold does copy the index's
 * reference tables — it is a pure function of the previous index, which React
 * may render twice — and that copy is bounded by {@link RETAINED_ITEM_BUDGET}.
 *
 * A record another page already supplied is held once, by its id: a page
 * sequence over a capture that is still growing can repeat a record, and a
 * record drawn twice would be two rows claiming one call. The newest page that
 * supplied it is remembered, so releasing an older page never releases a
 * record a held page still carries.
 * ------------------------------------------------------------------------- */

/** A held record, and the newest held page that supplied it. */
interface HeldRecord {
  readonly event: TelemetryEvent;
  /** The {@link HeldPage.seq} of the newest page that carried this record. */
  readonly seq: number;
}

/** Where one drawn record sits, and what its placement was read from. */
interface SpanPlacement {
  /** The drawn ancestor it is nested under; `undefined` for a top-level row. */
  readonly parentId: string | undefined;
  /** The persisted re-attachment verdict that still holds; top-level rows only. */
  readonly orphan: PersistedOrphan | undefined;
  /**
   * Every span key the placement looked up: the record's own, each ancestor
   * the walk visited or failed to find, and the parents the orphan verdict
   * checked. The placement is a function of the first holders of exactly these
   * keys, so a change to any of them is what re-places the record.
   */
  readonly keys: readonly string[];
}

/** The held flat records and the tree they form. Never mutated once built. */
interface SpanIndex {
  /** Every held record, by record id. */
  readonly records: ReadonlyMap<string, HeldRecord>;
  /** The held records carrying each span key, in load order; the first one resolves it. */
  readonly holders: ReadonlyMap<string, readonly TelemetryEvent[]>;
  /** The same, restricted to the kinds this view draws. */
  readonly drawnHolders: ReadonlyMap<string, readonly TelemetryEvent[]>;
  /** Where each held drawn record is placed, by record id. */
  readonly placements: ReadonlyMap<string, SpanPlacement>;
  /** The drawn records whose placement looked up each span key. */
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>;
  /** The drawn records nested directly under each drawn record, in drawing order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** The top-level drawn records, in drawing order. */
  readonly roots: readonly string[];
  /** The earliest drawn start, or `+Infinity` while nothing is drawn. */
  readonly viewStart: number;
  /** The latest drawn end, or `-Infinity` while nothing is drawn. */
  readonly viewEnd: number;
}

const EMPTY_SPAN_INDEX: SpanIndex = {
  records: new Map(),
  holders: new Map(),
  drawnHolders: new Map(),
  placements: new Map(),
  dependents: new Map(),
  children: new Map(),
  roots: EMPTY_IDS,
  viewStart: Number.POSITIVE_INFINITY,
  viewEnd: Number.NEGATIVE_INFINITY,
};

/**
 * The lookup key of a span within its trace. The trace id is length-prefixed,
 * so the concatenation is uniquely decodable whatever the ids contain.
 */
function spanKey(traceId: string, spanId: string): string {
  return `${String(traceId.length)}:${traceId}${spanId}`;
}

/** A record's own span key. */
function spanKeyOf(event: TelemetryEvent): string {
  return spanKey(event.traceId, event.spanId);
}

/** Reads the first holder of a span key, recording that the key was looked up. */
type HolderLookup = (key: string) => TelemetryEvent | undefined;

/**
 * The orphan provenance a flat record carries in its own attribute bag, or
 * `undefined` when it carries none that still holds.
 *
 * The flag is what ONE earlier correlation pass concluded, and a capture is
 * correlated repeatedly as it streams in: a record whose parent arrived late
 * was orphaned then and is placed correctly now. So the flag is honoured only
 * while the parent the record names is NOT among the records held — a parent
 * that resolves here proves it stale, and re-flagging a correctly nested call
 * would invent evidence. A record naming itself resolves to nothing but itself,
 * which does not count as resolving.
 *
 * @param record The record whose bag is read.
 * @param holderAt Resolves a span key among the held records.
 * @param viaAncestor Whether `record` is an undrawn call the row was lifted
 * through rather than the row's own record.
 */
function persistedOrphan(
  record: TelemetryEvent,
  holderAt: HolderLookup,
  viaAncestor: boolean,
): PersistedOrphan | undefined {
  const attributes: AttributeBag = record.attributes;
  if (!booleanAttribute(attributes, ORPHANED_KEY)) {
    return undefined;
  }
  const parent =
    record.parentSpanId === undefined
      ? undefined
      : holderAt(spanKey(record.traceId, record.parentSpanId));
  if (parent !== undefined && parent.id !== record.id) {
    return undefined;
  }
  return {
    missingParentSpanId: stringAttribute(attributes, ORPHANED_PARENT_SPAN_ID_KEY),
    viaAncestor,
  };
}

/**
 * Places one drawn record: under its nearest drawn ancestor, or at the top
 * level with the re-attachment verdict that still holds for it.
 *
 * Walks the `parentSpanId` chain through every held record, not only the drawn
 * ones. Bounded by {@link MAX_ANCESTOR_HOPS} and guarded against a cycle in the
 * links, both of which leave the row at the top level — which is honest about
 * an unresolved ancestry rather than inventing one.
 *
 * A top-level row's verdict is its own record's flag, or else the flag of the
 * last undrawn record the chain passed through before it ended: the row sits
 * at the top level only because that enclosing call was re-attached, and must
 * not launder its verdict. Every other record below it on the chain has a
 * parent the held records resolve, which is what proves any flag on it stale.
 *
 * @param event The drawn record to place.
 * @param holders The held records by span key.
 * @param drawnHolders The held drawn records by span key.
 * @returns The placement, with every key it looked up.
 */
function placeRecord(
  event: TelemetryEvent,
  holders: ReadonlyMap<string, readonly TelemetryEvent[]>,
  drawnHolders: ReadonlyMap<string, readonly TelemetryEvent[]>,
): SpanPlacement {
  const looked = new Set<string>();
  const holderAt: HolderLookup = (key) => {
    looked.add(key);
    return holders.get(key)?.[0];
  };
  const drawnAt: HolderLookup = (key) => {
    looked.add(key);
    return drawnHolders.get(key)?.[0];
  };

  const ownKey = spanKeyOf(event);
  looked.add(ownKey);
  const seen = new Set<string>([ownKey]);
  let parentSpanId = event.parentSpanId;
  let liftedThrough: TelemetryEvent | undefined;
  for (let hop = 0; parentSpanId !== undefined && hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const key = spanKey(event.traceId, parentSpanId);
    if (seen.has(key)) {
      break;
    }
    seen.add(key);
    const drawn = drawnAt(key);
    if (drawn !== undefined && drawn.id !== event.id) {
      return { parentId: drawn.id, orphan: undefined, keys: Array.from(looked) };
    }
    const linked = holderAt(key);
    if (linked === undefined) {
      break;
    }
    liftedThrough = linked;
    parentSpanId = linked.parentSpanId;
  }
  const orphan =
    persistedOrphan(event, holderAt, false) ??
    (liftedThrough === undefined ? undefined : persistedOrphan(liftedThrough, holderAt, true));
  return { parentId: undefined, orphan, keys: Array.from(looked) };
}

/**
 * Appends a record to a span key's holders.
 *
 * @returns Whether the key had no holder before, so its first holder changed.
 */
function addHolder(
  holders: Map<string, readonly TelemetryEvent[]>,
  key: string,
  event: TelemetryEvent,
): boolean {
  const current = holders.get(key);
  holders.set(key, current === undefined ? [event] : [...current, event]);
  return current === undefined;
}

/**
 * Removes a record from a span key's holders.
 *
 * @returns Whether it was the first holder, so the key now resolves otherwise.
 */
function dropHolder(
  holders: Map<string, readonly TelemetryEvent[]>,
  key: string,
  event: TelemetryEvent,
): boolean {
  const current = holders.get(key);
  const at = current === undefined ? -1 : current.indexOf(event);
  if (current === undefined || at < 0) {
    return false;
  }
  const rest = current.filter((_, position) => position !== at);
  if (rest.length === 0) {
    holders.delete(key);
  } else {
    holders.set(key, rest);
  }
  return at === 0;
}

/** The extent a drawn record contributes to the window, in epoch milliseconds. */
function extentOf(event: TelemetryEvent): { readonly start: number; readonly end: number } {
  const start = asFiniteNumber(event.startTime, 0);
  return { start, end: start + drawableDuration(event.duration) };
}

/** What a fold produced: the new index, and how many drawn records it released. */
interface IndexFold<I> {
  readonly index: I;
  /** Drawn items the fold released and no held page still carries. */
  readonly releasedDrawnCount: number;
}

/**
 * Folds one settled page into the held flat records, releasing the records of
 * the pages the retention budget let go.
 *
 * Pure: the previous index is read, never written, and a new one is returned.
 * Releases are applied before additions, so a record the arriving page carries
 * again stays held; then every drawn record that can have moved is placed
 * again, and only the child lists it left or joined are rebuilt.
 *
 * @param index The index before the page.
 * @param kinds The kinds this view draws.
 * @param added The records of the page that arrived.
 * @param addedSeq That page's sequence number.
 * @param released The records of the pages being released.
 * @param releasedThroughSeq The sequence number of the newest page being
 * released; a record some newer held page supplied again is kept.
 * @returns The new index.
 */
function foldSpanPage(
  index: SpanIndex,
  kinds: ReadonlySet<TelemetryKind>,
  added: readonly TelemetryEvent[],
  addedSeq: number,
  released: readonly TelemetryEvent[],
  releasedThroughSeq: number,
): IndexFold<SpanIndex> {
  const records = new Map(index.records);
  const holders = new Map(index.holders);
  const drawnHolders = new Map(index.drawnHolders);
  const placements = new Map(index.placements);
  const dependents = new Map(index.dependents);
  const children = new Map(index.children);
  // Dependent sets are copied on first write, so the previous index keeps its own.
  const ownedDependents = new Map<string, Set<string>>();
  const writableDependents = (key: string): Set<string> => {
    const owned = ownedDependents.get(key);
    if (owned !== undefined) {
      return owned;
    }
    const copy = new Set<string>(dependents.get(key));
    ownedDependents.set(key, copy);
    dependents.set(key, copy);
    return copy;
  };
  const register = (keys: readonly string[], id: string): void => {
    for (const key of keys) {
      writableDependents(key).add(id);
    }
  };
  const unregister = (keys: readonly string[], id: string): void => {
    for (const key of keys) {
      if (!dependents.has(key)) {
        continue;
      }
      const set = writableDependents(key);
      set.delete(id);
      if (set.size === 0) {
        dependents.delete(key);
        ownedDependents.delete(key);
      }
    }
  };

  // Keys whose first holder changed, in either table: every record placed by
  // looking one of them up is placed again below.
  const changedKeys = new Set<string>();
  const releasedDrawn: TelemetryEvent[] = [];
  const toPlace = new Set<string>();

  for (const item of released) {
    const held = records.get(item.id);
    if (held === undefined || held.seq > releasedThroughSeq) {
      continue;
    }
    records.delete(item.id);
    const key = spanKeyOf(held.event);
    if (dropHolder(holders, key, held.event)) {
      changedKeys.add(key);
    }
    if (kinds.has(held.event.kind)) {
      if (dropHolder(drawnHolders, key, held.event)) {
        changedKeys.add(key);
      }
      releasedDrawn.push(held.event);
    }
  }

  const arrived: TelemetryEvent[] = [];
  for (const event of added) {
    const held = records.get(event.id);
    if (held !== undefined) {
      records.set(event.id, { event: held.event, seq: addedSeq });
      continue;
    }
    records.set(event.id, { event, seq: addedSeq });
    const key = spanKeyOf(event);
    if (addHolder(holders, key, event)) {
      changedKeys.add(key);
    }
    if (kinds.has(event.kind)) {
      if (addHolder(drawnHolders, key, event)) {
        changedKeys.add(key);
      }
      arrived.push(event);
      toPlace.add(event.id);
    }
  }

  for (const key of changedKeys) {
    for (const id of dependents.get(key) ?? []) {
      if (records.has(id)) {
        toPlace.add(id);
      }
    }
  }

  // Which child lists each move leaves and joins; `undefined` is the top level.
  const leaving = new Map<string | undefined, Set<string>>();
  const joining = new Map<string | undefined, string[]>();
  const leave = (parentId: string | undefined, id: string): void => {
    const ids = leaving.get(parentId) ?? new Set<string>();
    ids.add(id);
    leaving.set(parentId, ids);
  };
  const join = (parentId: string | undefined, id: string): void => {
    const ids = joining.get(parentId) ?? [];
    ids.push(id);
    joining.set(parentId, ids);
  };

  for (const event of releasedDrawn) {
    const old = placements.get(event.id);
    if (old === undefined) {
      continue;
    }
    placements.delete(event.id);
    unregister(old.keys, event.id);
    leave(old.parentId, event.id);
  }

  for (const id of toPlace) {
    const held = records.get(id);
    if (held === undefined) {
      continue;
    }
    const next = placeRecord(held.event, holders, drawnHolders);
    const old = placements.get(id);
    if (old !== undefined) {
      unregister(old.keys, id);
    }
    register(next.keys, id);
    placements.set(id, next);
    if (old === undefined) {
      join(next.parentId, id);
    } else if (old.parentId !== next.parentId) {
      leave(old.parentId, id);
      join(next.parentId, id);
    }
  }

  const compareIds = (left: string, right: string): number => {
    const leftEvent = records.get(left)?.event;
    const rightEvent = records.get(right)?.event;
    return leftEvent === undefined || rightEvent === undefined
      ? compareByStartThenId(0, left, 0, right)
      : compareEvents(leftEvent, rightEvent);
  };
  let roots = index.roots;
  for (const parentId of new Set([...leaving.keys(), ...joining.keys()])) {
    const merged = mergeOrdered(
      parentId === undefined ? roots : (children.get(parentId) ?? EMPTY_IDS),
      leaving.get(parentId),
      joining.get(parentId),
      compareIds,
    );
    if (parentId === undefined) {
      roots = merged;
    } else if (merged.length === 0 || !placements.has(parentId)) {
      children.delete(parentId);
    } else {
      children.set(parentId, merged);
    }
  }

  // The window grows with what arrived; it is measured again from the held
  // drawn records only when a release took away a record on its edge.
  let viewStart = index.viewStart;
  let viewEnd = index.viewEnd;
  const releasedEdge = releasedDrawn.some((event) => {
    const { start, end } = extentOf(event);
    return start <= viewStart || end >= viewEnd;
  });
  const extending = releasedEdge ? Array.from(placements.keys()) : arrived.map(({ id }) => id);
  if (releasedEdge) {
    viewStart = Number.POSITIVE_INFINITY;
    viewEnd = Number.NEGATIVE_INFINITY;
  }
  for (const id of extending) {
    const event = records.get(id)?.event;
    if (event === undefined) {
      continue;
    }
    const { start, end } = extentOf(event);
    viewStart = Math.min(viewStart, start);
    viewEnd = Math.max(viewEnd, end);
  }

  return {
    index: {
      records,
      holders,
      drawnHolders,
      placements,
      dependents,
      children,
      roots,
      viewStart,
      viewEnd,
    },
    releasedDrawnCount: releasedDrawn.filter(({ id }) => !records.has(id)).length,
  };
}

/**
 * The summary of the held flat records: their window, and how many rows the
 * held tree holds within the depth bound — the figure the footer counts as
 * calls. A row whose children the bound would cut is counted, its children
 * are not, and the cut is reported.
 */
function summariseSpans(index: SpanIndex): HeldSummary {
  if (index.placements.size === 0 || !Number.isFinite(index.viewStart)) {
    return EMPTY_SUMMARY;
  }
  let rowCount = 0;
  let truncated = false;
  const pending: { readonly id: string; readonly depth: number }[] = index.roots.map((id) => ({
    id,
    depth: 0,
  }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    rowCount += 1;
    const nested = index.children.get(next.id);
    if (nested === undefined || nested.length === 0) {
      continue;
    }
    if (next.depth + 1 >= MAX_ROW_DEPTH) {
      truncated = true;
      continue;
    }
    for (const id of nested) {
      pending.push({ id, depth: next.depth + 1 });
    }
  }
  const viewEnd = Math.max(index.viewEnd, index.viewStart);
  return {
    viewStart: index.viewStart,
    viewEnd,
    windowMs: clampNonNegative(roundMs(viewEnd - index.viewStart)),
    rowCount,
    truncated,
  };
}

/**
 * Whether an in-flight snapshot: a browser request whose {@link IN_FLIGHT_KEY}
 * marker is the boolean `true`.
 *
 * Strictly the boolean, exactly as the request aggregate reads it: the string
 * `"true"`, a `1` and `false` all read as settled, and a missing status code
 * never makes a request pending — a network error, an abort and a refused
 * cross-origin response all settle without one. The kind check keeps a stray
 * marker on a record the request patch never writes it on from turning that
 * record into a request that has not answered.
 */
function isInFlightRecord(event: TelemetryEvent): boolean {
  const attributes: AttributeBag = event.attributes;
  return TRANSFER_BEARING_KINDS.has(event.kind) && attributes[IN_FLIGHT_KEY] === true;
}

/**
 * One row from one record.
 *
 * An in-flight snapshot ({@link isInFlightRecord}) is drawn as the request it
 * is — started, and not yet answered: its status code and transfer size are
 * not read even when present, because no response had arrived for them to
 * describe, and its outcome is `unset`, because nothing had failed or
 * succeeded when it was observed. The same rules the request aggregate applies
 * to a pending occurrence, so the two sources draw one request the same way.
 */
function rowFromEvent(
  event: TelemetryEvent,
  viewStart: number,
  childCount: number,
  childrenTruncated: boolean,
  orphan: WaterfallOrphan | undefined,
): WaterfallRow {
  const attributes: AttributeBag = event.attributes;
  const isQuery = event.kind === 'db.query';
  const pending = isInFlightRecord(event);
  return {
    eventId: event.id,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    kind: event.kind,
    tier: event.tier,
    status: pending ? 'unset' : event.status,
    method: stringAttribute(attributes, HTTP_METHOD_KEY),
    url: stringAttribute(attributes, URL_KEY),
    route: stringAttribute(attributes, HTTP_ROUTE_KEY),
    statusCode: pending ? undefined : numberAttribute(attributes, HTTP_STATUS_CODE_KEY),
    statement: isQuery ? stringAttribute(attributes, DB_STATEMENT_KEY) : undefined,
    rowCount: isQuery ? numberAttribute(attributes, DB_ROW_COUNT_KEY) : undefined,
    transferredBytes: pending ? undefined : numberAttribute(attributes, TRANSFER_SIZE_KEY),
    expectsTransfer: !pending && TRANSFER_BEARING_KINDS.has(event.kind),
    occurrenceCount: undefined,
    pending,
    pendingCount: undefined,
    startTime: asFiniteNumber(event.startTime, viewStart),
    offsetMs: offsetFrom(viewStart, event.startTime),
    durationMs: drawableDuration(event.duration),
    measuredMs: measuredDuration(event.duration),
    source: event.source,
    lineageAmbiguous: booleanAttribute(attributes, LINEAGE_AMBIGUOUS_KEY),
    lineageCandidates: stringListAttribute(attributes, LINEAGE_CANDIDATES_KEY),
    orphan,
    childrenTruncated,
    childCount,
  };
}

/* ---------------------------------------------------------------------------
 * The held grouped network calls (`requests`), folded one page at a time
 *
 * The grouped result keeps each occurrence's own start and duration, so the same
 * bars can be drawn for calls the service grouped for duplicate detection. What
 * is NOT done here: any grouping, matching or comparison of requests. That
 * happened in the service, on the pre-redaction request key, and a second
 * attempt over the redacted URLs on this side would answer differently and be
 * wrong (`docs/SECURITY.md`, "The pre-redaction request key").
 *
 * Groups do not nest under one another, so a fold only files the page's
 * drawable groups into drawing order and drops the released ones. A group
 * another held page already supplied is held once, by its id, as a record is.
 * ------------------------------------------------------------------------- */

/** One held group: the occurrences this view draws, in start order, and its place. */
interface HeldGroup {
  readonly group: RequestGroup;
  /** The occurrences of an included kind, in start order; never empty. */
  readonly occurrences: readonly RequestOccurrence[];
  /** The id its row reports: the first occurrence's event id. */
  readonly rowId: string;
  /** The first occurrence's start, which orders the group among its peers. */
  readonly start: number;
  /** The last occurrence's end. */
  readonly end: number;
  /** The {@link HeldPage.seq} of the newest page that carried this group. */
  readonly seq: number;
}

/** The held groups, in drawing order. Never mutated once built. */
interface RequestIndex {
  /** Every held group, by group id. */
  readonly groups: ReadonlyMap<string, HeldGroup>;
  /** The held group ids, in drawing order. */
  readonly order: readonly string[];
  /** Each held group's id, by the id its row reports. */
  readonly byRowId: ReadonlyMap<string, string>;
  /** The earliest drawn start, or `+Infinity` while nothing is drawn. */
  readonly viewStart: number;
  /** The latest drawn end, or `-Infinity` while nothing is drawn. */
  readonly viewEnd: number;
}

const EMPTY_REQUEST_INDEX: RequestIndex = {
  groups: new Map(),
  order: EMPTY_IDS,
  byRowId: new Map(),
  viewStart: Number.POSITIVE_INFINITY,
  viewEnd: Number.NEGATIVE_INFINITY,
};

/**
 * A group as this view holds it, or `undefined` when it has no occurrence of a
 * kind this view draws.
 */
function holdGroup(
  group: RequestGroup,
  kinds: ReadonlySet<TelemetryKind>,
  seq: number,
): HeldGroup | undefined {
  const occurrences = group.occurrences
    .filter((occurrence) => kinds.has(occurrence.kind))
    .sort((left, right) =>
      compareByStartThenId(left.startTime, left.eventId, right.startTime, right.eventId),
    );
  const [first] = occurrences;
  if (first === undefined) {
    return undefined;
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const occurrence of occurrences) {
    const begins = asFiniteNumber(occurrence.startTime, 0);
    start = Math.min(start, begins);
    end = Math.max(end, begins + drawableDuration(occurrence.durationMs));
  }
  return { group, occurrences, rowId: first.eventId, start, end, seq };
}

/**
 * Folds one settled page into the held groups, releasing the groups of the
 * pages the retention budget let go. Pure, like {@link foldSpanPage}.
 *
 * @param index The index before the page.
 * @param kinds The kinds this view draws.
 * @param added The groups of the page that arrived.
 * @param addedSeq That page's sequence number.
 * @param released The groups of the pages being released.
 * @param releasedThroughSeq The sequence number of the newest page being released.
 * @returns The new index.
 */
function foldRequestPage(
  index: RequestIndex,
  kinds: ReadonlySet<TelemetryKind>,
  added: readonly RequestGroup[],
  addedSeq: number,
  released: readonly RequestGroup[],
  releasedThroughSeq: number,
): IndexFold<RequestIndex> {
  const groups = new Map(index.groups);
  const byRowId = new Map(index.byRowId);
  const leaving = new Set<string>();
  let releasedEdge = false;
  for (const group of released) {
    const held = groups.get(group.id);
    if (held === undefined || held.seq > releasedThroughSeq) {
      continue;
    }
    groups.delete(group.id);
    if (byRowId.get(held.rowId) === group.id) {
      byRowId.delete(held.rowId);
    }
    leaving.add(group.id);
    releasedEdge ||= held.start <= index.viewStart || held.end >= index.viewEnd;
  }

  const joining: string[] = [];
  for (const group of added) {
    const held = groups.get(group.id);
    if (held !== undefined) {
      groups.set(group.id, { ...held, seq: addedSeq });
      continue;
    }
    const fresh = holdGroup(group, kinds, addedSeq);
    if (fresh === undefined) {
      continue;
    }
    groups.set(group.id, fresh);
    if (!byRowId.has(fresh.rowId)) {
      byRowId.set(fresh.rowId, group.id);
    }
    joining.push(group.id);
  }

  const compareIds = (left: string, right: string): number => {
    const leftGroup = groups.get(left);
    const rightGroup = groups.get(right);
    return leftGroup === undefined || rightGroup === undefined
      ? compareByStartThenId(0, left, 0, right)
      : compareByStartThenId(leftGroup.start, leftGroup.rowId, rightGroup.start, rightGroup.rowId);
  };
  const order =
    leaving.size === 0 && joining.length === 0
      ? index.order
      : mergeOrdered(index.order, leaving, joining, compareIds);

  let viewStart = releasedEdge ? Number.POSITIVE_INFINITY : index.viewStart;
  let viewEnd = releasedEdge ? Number.NEGATIVE_INFINITY : index.viewEnd;
  for (const id of releasedEdge ? order : joining) {
    const held = groups.get(id);
    if (held !== undefined) {
      viewStart = Math.min(viewStart, held.start);
      viewEnd = Math.max(viewEnd, held.end);
    }
  }

  return {
    index: { groups, order, byRowId, viewStart, viewEnd },
    releasedDrawnCount: Array.from(leaving).filter((id) => !groups.has(id)).length,
  };
}

/**
 * The summary of the held groups: a group of one occurrence is one row, and a
 * larger group is its own row plus one per occurrence. A group whose
 * occurrence list the service truncated is the payload's cut, and reported.
 */
function summariseRequests(index: RequestIndex): HeldSummary {
  if (index.order.length === 0 || !Number.isFinite(index.viewStart)) {
    return EMPTY_SUMMARY;
  }
  let rowCount = 0;
  let truncated = false;
  for (const id of index.order) {
    const held = index.groups.get(id);
    if (held === undefined) {
      continue;
    }
    if (held.occurrences.length === 1) {
      rowCount += 1;
      continue;
    }
    rowCount += held.occurrences.length + 1;
    truncated ||= held.group.occurrencesTruncated;
  }
  const viewEnd = Math.max(index.viewEnd, index.viewStart);
  return {
    viewStart: index.viewStart,
    viewEnd,
    windowMs: clampNonNegative(roundMs(viewEnd - index.viewStart)),
    rowCount,
    truncated,
  };
}

/**
 * One row from one occurrence, labelled from the group it belongs to.
 *
 * A pending occurrence (`RequestOccurrence.pending`) is drawn as the request
 * it is — started, and not yet answered. The aggregate already publishes it
 * without a status code or a transfer figure, and neither is read here even if
 * one were present; its outcome is `unset`, because the aggregate never counts
 * a pending occurrence as a failure, whatever span status its producer
 * reported.
 */
function rowFromOccurrence(
  group: RequestGroup,
  occurrence: RequestOccurrence,
  viewStart: number,
): WaterfallRow {
  const pending = occurrence.pending === true;
  return {
    eventId: occurrence.eventId,
    spanId: occurrence.spanId,
    parentSpanId: occurrence.parentSpanId,
    traceId: occurrence.traceId,
    name: group.path,
    kind: occurrence.kind,
    tier: occurrence.tier,
    status: pending ? 'unset' : occurrence.status,
    method: group.method,
    url: group.url,
    route: undefined,
    statusCode: pending ? undefined : occurrence.statusCode,
    statement: undefined,
    rowCount: undefined,
    transferredBytes: pending ? undefined : occurrence.transferredBytes,
    expectsTransfer: !pending && TRANSFER_BEARING_KINDS.has(occurrence.kind),
    occurrenceCount: undefined,
    pending,
    pendingCount: undefined,
    startTime: asFiniteNumber(occurrence.startTime, viewStart),
    offsetMs: offsetFrom(viewStart, occurrence.startTime),
    durationMs: drawableDuration(occurrence.durationMs),
    measuredMs: measuredDuration(occurrence.durationMs),
    source: occurrence.source,
    lineageAmbiguous: false,
    lineageCandidates: EMPTY_STRINGS,
    // The grouped network result carries no correlation verdict.
    orphan: undefined,
    childrenTruncated: false,
    childCount: 0,
  };
}

/**
 * How many calls of a group were still in flight when the capture ended, or
 * `undefined` when none was.
 *
 * The service's own `pendingCount` wins when it is a positive whole number: it
 * counts every occurrence, including any the group's occurrence list was
 * truncated past. Absent — which is how the aggregate says "none" — or
 * unusable, the pending occurrences drawn here are counted instead, so a group
 * never loses the flag of a call it visibly holds.
 */
function groupPendingCount(
  group: RequestGroup,
  occurrences: readonly RequestOccurrence[],
): number | undefined {
  const reported = group.pendingCount;
  if (reported !== undefined && Number.isInteger(reported) && reported > 0) {
    return reported;
  }
  const counted = occurrences.filter((occurrence) => occurrence.pending === true).length;
  return counted > 0 ? counted : undefined;
}

/**
 * The row for a group that holds more than one occurrence.
 *
 * Its bar spans from the first occurrence's start to the last one's end, and its
 * duration cell prints that same extent — bar length and printed duration are
 * the same measured quantity, never two different ones — while the per-call
 * timings stay exact on the occurrence rows nested beneath it.
 *
 * A group holding a call that was still in flight is flagged pending, and its
 * extent is then a lower bound like that call's own duration. Its outcome is
 * judged over the SETTLED occurrences only, as the aggregate judges
 * `errorCount`: a call that had not answered neither failed nor succeeded.
 *
 * A group holding a call whose duration was not measured still draws its bar
 * over the known extent, but prints that extent as unavailable: the call's end
 * is unknown, so the last end among the others is not the group's end, and a
 * printed figure would state a measurement nobody took.
 */
function rowFromGroup(
  group: RequestGroup,
  occurrences: readonly RequestOccurrence[],
  viewStart: number,
  childCount: number,
): WaterfallRow {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let worstStatus: TelemetryStatus = 'unset';
  let everyEndMeasured = true;
  for (const occurrence of occurrences) {
    const start = asFiniteNumber(occurrence.startTime, viewStart);
    first = Math.min(first, start);
    last = Math.max(last, start + drawableDuration(occurrence.durationMs));
    if (measuredDuration(occurrence.durationMs) === undefined) {
      everyEndMeasured = false;
    }
    if (occurrence.pending === true) {
      continue;
    }
    if (occurrence.status === 'error') {
      worstStatus = 'error';
    } else if (worstStatus === 'unset' && occurrence.status === 'ok') {
      worstStatus = 'ok';
    }
  }
  const start = Number.isFinite(first) ? first : viewStart;
  const end = Number.isFinite(last) ? Math.max(last, start) : start;
  // A subtraction of two drawn instants, which floors at zero on its own.
  const extentMs = clampNonNegative(roundMs(end - start));
  const [firstOccurrence] = occurrences;
  const pendingCount = groupPendingCount(group, occurrences);
  return {
    eventId: firstOccurrence === undefined ? group.id : firstOccurrence.eventId,
    spanId: firstOccurrence?.spanId,
    parentSpanId: undefined,
    traceId: firstOccurrence?.traceId,
    name: group.path,
    kind: firstOccurrence === undefined ? 'fetch' : firstOccurrence.kind,
    tier: firstOccurrence === undefined ? 'browser' : firstOccurrence.tier,
    status: worstStatus,
    method: group.method,
    url: group.url,
    route: undefined,
    statusCode: undefined,
    statement: undefined,
    rowCount: undefined,
    transferredBytes: group.transferredBytes,
    // Only a settled call could have reported a transfer figure, so only one
    // makes the figure's absence worth stating.
    expectsTransfer: occurrences.some(
      (occurrence) => occurrence.pending !== true && TRANSFER_BEARING_KINDS.has(occurrence.kind),
    ),
    occurrenceCount: occurrences.length,
    pending: pendingCount !== undefined,
    pendingCount,
    startTime: start,
    offsetMs: offsetFrom(viewStart, start),
    durationMs: extentMs,
    measuredMs: everyEndMeasured ? extentMs : undefined,
    source: firstOccurrence?.source,
    lineageAmbiguous: false,
    lineageCandidates: EMPTY_STRINGS,
    orphan: undefined,
    childrenTruncated: group.occurrencesTruncated,
    childCount,
  };
}

/* ---------------------------------------------------------------------------
 * Resolving the node's query
 *
 * `useQuery` reports a status, a payload and the paging counters — it does not
 * echo the source back, so the payload's shape is decided by the discriminant
 * this component already holds: `node.query.source`. Narrowing happens *before*
 * the hook, by building a query whose static type carries its own source, which
 * is what lets each payload be read as the one shape it is with no assertion and
 * no inspection of the data. Duck-typing the payload is what this avoids: two
 * sources can answer with structurally similar data, and a branch that sniffed
 * it would draw the wrong thing without ever failing.
 *
 * Two hooks are called unconditionally, and at most one of them is handed a
 * query: the other receives `undefined`, which `useQuery` treats as "nothing to
 * resolve" — no request is made and no provider is touched. A node naming a
 * source the catalog entry does not list hands neither of them one, so the
 * unsupported-source state is the whole answer and the provider is never asked.
 *
 * Each narrowing makes two checks, deliberately, as `./SpanTable` does: the
 * catalog entry decides which sources the node type is permitted to read, and
 * the literal comparison is what lets TypeScript see which result shape the
 * query resolves to (`DataResultFor<'spans'>`, `DataResultFor<'requests'>`).
 * The two agree today and the catalog is the one a reviewer should change; the
 * literals exist because a type cannot be narrowed by a runtime array lookup.
 * ------------------------------------------------------------------------- */

type SpanListSource = 'spans';
type SpanListQuery = DataQuery & { source: SpanListSource };
type RequestsQuery = DataQuery & { source: 'requests' };

/** The flat-record query, at the offset this render is paged to. */
function narrowSpanListQuery(query: DataQuery, offset: number): SpanListQuery | undefined {
  const source = query.source;
  if (!isCataloguedSource(source)) {
    return undefined;
  }
  return source === 'spans' ? { ...query, source, offset } : undefined;
}

/** The grouped-network query, at the offset this render is paged to. */
function narrowRequestsQuery(query: DataQuery, offset: number): RequestsQuery | undefined {
  const source = query.source;
  if (!isCataloguedSource(source)) {
    return undefined;
  }
  return source === 'requests' ? { ...query, source, offset } : undefined;
}

/**
 * The offset the node's first page starts at: the one its query AUTHORED, or
 * the schema's default base when it authored none.
 *
 * @param query The node's query as authored.
 * @returns The offset of the first page of the node's page sequence.
 */
function authoredBaseOffset(query: DataQuery): number {
  return query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
}

/**
 * A stable identity for the page sequence the accumulated pages belong to: the
 * session they were read from, and everything about the node's query as it was
 * AUTHORED — the offset it starts from included.
 *
 * Two offsets are in play, and only one of them is identity:
 *
 *   - The **authored** base offset ({@link authoredBaseOffset}) says which
 *     slice of the result this node draws. A node whose query is otherwise
 *     identical but starts elsewhere is a different sequence, and must neither
 *     inherit the pages another slice accumulated nor carry on from where that
 *     slice had paged to.
 *   - The **advanced** offset — the `nextOffset` "Load more" copied into
 *     {@link PagingState.offset} — is how far the sequence has got. It stays
 *     OUT of the identity, or every page turn would discard the very pages it
 *     was meant to append to.
 *
 * The session is identity too. The same query addressed to another session is
 * another capture's evidence, and `useQuery` re-issues it on a session change;
 * without the session here, the re-issued first page would be drawn beneath
 * pages the previous session answered, at an offset that session had advanced
 * to.
 *
 * An absent authored offset is spelled as the schema's default base, so
 * `offset: 0` and no offset — the same first page — are the same sequence.
 * Written field by field rather than with a generic serializer so that a new
 * query field cannot silently join the identity — or silently stay out of it —
 * when the schema grows.
 *
 * @param query The node's query as authored.
 * @param sessionId The session the panel is drawing, from `PanelSessionContext`.
 * @returns The identity, as a string compared by value.
 */
function queryIdentity(query: DataQuery, sessionId: string | undefined): string {
  const filter = query.filter;
  return JSON.stringify([
    sessionId ?? null,
    query.source,
    query.sort ?? null,
    query.limit ?? null,
    authoredBaseOffset(query),
    filter === undefined
      ? null
      : [
          filter.traceId ?? null,
          filter.kinds ?? null,
          filter.component ?? null,
          filter.tier ?? null,
          filter.minDuration ?? null,
        ],
  ]);
}

/* ---------------------------------------------------------------------------
 * Paging
 *
 * The provider resolves ONE page. "Load more" therefore keeps the pages already
 * resolved in state and advances the offset to the `nextOffset` the response
 * reported — never to a figure computed from the length of what arrived, which
 * would drift the moment the service clamped a limit.
 *
 * The accumulated pages are held beside the identity of the page sequence they
 * came from — the session and the query as authored, its base offset included
 * (see {@link queryIdentity}) — and a render whose identity no longer matches
 * simply derives the initial page, at the new node's authored offset, instead
 * of using them. That is deliberate: resetting the state would mean either
 * setting state during a render or setting it from an effect, and both are
 * errors under this repository's React rules — while a derivation is correct on
 * the very first render after the change, with no intermediate frame showing
 * another query's, another slice's or another session's rows.
 *
 * A page is folded into the held indexes once, in the render it arrives in
 * ({@link holdPage}), and "Load more" carries that folded result forward as it
 * is: nothing already held is resolved again when the next page is asked for.
 * The fold also applies {@link RETAINED_ITEM_BUDGET}, releasing the oldest held
 * pages, and keeps the counts the footer needs to say so truthfully.
 * ------------------------------------------------------------------------- */

/** One settled page the view holds. */
interface HeldPage<T> {
  /** Its place in the page sequence: 0 for the first page, and so on. */
  readonly seq: number;
  /** The offset it was requested at. */
  readonly offset: number;
  /** What it carried, exactly as the provider resolved it. */
  readonly items: readonly T[];
}

/** The pages a view holds, the index folded from them, and what was released. */
interface Holding<T, I> {
  /** The held pages, oldest first; never more items than the budget, bar the newest page. */
  readonly pages: readonly HeldPage<T>[];
  /** The index every held page has been folded into. */
  readonly index: I;
  /** The sequence number the next page will take. */
  readonly nextSeq: number;
  /** Source items every resolved page carried, released pages included. */
  readonly loadedItemCount: number;
  /** Source items the held pages carry. */
  readonly heldItemCount: number;
  /** Source items the released pages carried. */
  readonly releasedItemCount: number;
  /** Drawn items released, which the view no longer draws. */
  readonly releasedDrawnCount: number;
}

/**
 * Folds one page into an index. `released` holds the items of the pages the
 * budget let go, and `releasedThroughSeq` the newest of their sequence numbers.
 */
type PageFold<T, I> = (
  index: I,
  added: readonly T[],
  addedSeq: number,
  released: readonly T[],
  releasedThroughSeq: number,
) => IndexFold<I>;

/**
 * Adds a settled page to what is held, releasing the oldest held pages while
 * the total exceeds {@link RETAINED_ITEM_BUDGET}.
 *
 * The arriving page is never released, so a single page larger than the
 * budget — which the schema's `limit` ceiling prevents from a conforming
 * service — is held whole rather than drawn in part.
 *
 * @param holding What was held before the page, or `undefined` for the first.
 * @param empty The index a page sequence starts from.
 * @param offset The offset the page was requested at.
 * @param items What the page carried.
 * @param fold Folds a page into the index.
 * @returns What is held now.
 */
function holdPage<T, I>(
  holding: Holding<T, I> | undefined,
  empty: I,
  offset: number,
  items: readonly T[],
  fold: PageFold<T, I>,
): Holding<T, I> {
  const previous = holding?.pages ?? [];
  const seq = holding?.nextSeq ?? 0;
  let heldItemCount = (holding?.heldItemCount ?? 0) + items.length;
  let kept = 0;
  for (
    let oldest = previous[kept];
    oldest !== undefined && heldItemCount > RETAINED_ITEM_BUDGET;
    oldest = previous[kept]
  ) {
    heldItemCount -= oldest.items.length;
    kept += 1;
  }
  const releasedPages = previous.slice(0, kept);
  const released = releasedPages.flatMap((page) => page.items);
  const releasedThroughSeq = releasedPages[releasedPages.length - 1]?.seq ?? -1;
  const folded = fold(holding?.index ?? empty, items, seq, released, releasedThroughSeq);
  return {
    pages: [...previous.slice(kept), { seq, offset, items }],
    index: folded.index,
    nextSeq: seq + 1,
    loadedItemCount: (holding?.loadedItemCount ?? 0) + items.length,
    heldItemCount,
    releasedItemCount: (holding?.releasedItemCount ?? 0) + released.length,
    releasedDrawnCount: (holding?.releasedDrawnCount ?? 0) + folded.releasedDrawnCount,
  };
}

/** The flat records a `spans` node holds. */
type SpanHolding = Holding<TelemetryEvent, SpanIndex>;

/** The groups a `requests` node holds. */
type RequestHolding = Holding<RequestGroup, RequestIndex>;

type LoadedPages =
  | { readonly kind: 'none' }
  | { readonly kind: 'spans'; readonly holding: SpanHolding }
  | { readonly kind: 'requests'; readonly holding: RequestHolding };

const NO_PAGES: LoadedPages = { kind: 'none' };

/** The holding a loaded state carries, whichever source it holds. */
function holdingOf(loaded: LoadedPages): SpanHolding | RequestHolding | undefined {
  return loaded.kind === 'none' ? undefined : loaded.holding;
}

/** What the held records amount to as a chart; see {@link HeldSummary}. */
function summariseLoaded(loaded: LoadedPages): HeldSummary {
  switch (loaded.kind) {
    case 'spans':
      return summariseSpans(loaded.holding.index);
    case 'requests':
      return summariseRequests(loaded.holding.index);
    default:
      return EMPTY_SUMMARY;
  }
}

interface PagingState {
  /** The {@link queryIdentity} the accumulated pages belong to. */
  readonly identity: string;
  /**
   * The offset the current request is made at: the authored base offset on
   * the first page, and the service's `nextOffset` after each "Load more".
   * Never part of {@link identity}.
   */
  readonly offset: number;
  /** Every page resolved before the current one, already folded. */
  readonly loaded: LoadedPages;
}

/**
 * The paging state a page sequence starts in: nothing carried, and the first
 * request made at the sequence's authored base offset.
 */
function initialPaging(identity: string, baseOffset: number): PagingState {
  return { identity, offset: baseOffset, loaded: NO_PAGES };
}

/* ---------------------------------------------------------------------------
 * Presentation
 * ------------------------------------------------------------------------- */

/** How many decimals a percentage coordinate keeps. */
const PERCENT_DECIMALS = 3;

/** A scale coordinate as a CSS percentage of the track. */
function percent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(PERCENT_DECIMALS)}%`;
}

/** An inline style that may carry custom properties alongside declarations. */
type CustomPropertyStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * Whether a row's call failed, by the shared outcome rule of `../utils/color`:
 * a failing response code (client or server error) whatever the span reported,
 * or a span that reported `error` whatever its code said.
 *
 * Both signals count because they can disagree: an older browser producer
 * reports `ok` beside a 500, and an aborted call reports `error` with no code.
 * The request table, the timeline and this view read the same rule, so one
 * call is never a failure in one of them and a success in the next.
 */
function rowFailed(row: WaterfallRow): boolean {
  return isFailureOutcome(row.status, row.statusCode);
}

/**
 * Whether a row needs the word "Error" to say that its call failed.
 *
 * A failure the telemetry reported is otherwise only a state class and a tint,
 * and colour is never the only signal. A failing response code already says it
 * in its chip — client-error or server-error toned, exactly as the request
 * table draws it — so the word is added only where no such code does: a failed
 * statement or outgoing call that carries no HTTP status at all, or a request
 * whose code does not read as a failure although the call itself did.
 */
function showsErrorBadge(row: WaterfallRow): boolean {
  return row.status === 'error' && !isHttpFailureStatus(row.statusCode);
}

/**
 * The colour a row's bar is drawn in, as a token reference.
 *
 * A call that failed is drawn in its outcome colour — the client-error or
 * server-error token its status chip and its row edge carry — so a failure is
 * visible on the bar a reader scans, not only in the chip beside it. Any other
 * call keeps its kind's colour, which is what lets the rows of one waterfall
 * be told apart by what they are. Both answers come from `../utils/color`,
 * which returns token references only.
 */
function barColorOf(row: WaterfallRow): string {
  return rowFailed(row) ? outcomeColorVar(row.status, row.statusCode) : kindColorVar(row.kind);
}

/**
 * The full text a row is labelled with, exactly as it arrived.
 *
 * A statement wins for a database call, then — for a call that is actually a
 * request — the redacted URL and then the matched route, and otherwise the
 * record's own name. The kind check is what keeps a stray `url` attribute on a
 * non-request record from hijacking its label. Nothing is assembled, decoded or
 * rebuilt: a URL whose query values are already replaced per key is the correct
 * display form.
 */
function rowLabel(row: WaterfallRow): string {
  if (row.statement !== undefined) {
    return row.statement;
  }
  if (REQUEST_LIKE_KINDS.has(row.kind)) {
    return row.url ?? row.route ?? row.name;
  }
  return row.name;
}

/** Which of a row's fields {@link rowLabel} reads its label from. */
type RowLabelField = 'statement' | 'url' | 'route' | 'name';

/**
 * The words a row's label is named by in its full-value detail and in the
 * detail's disclosure: the heading printed over the whole value, and the noun
 * the disclosure button's name uses ("Show the full URL of …").
 */
const LABEL_FIELD_WORDS: Readonly<
  Record<RowLabelField, { readonly heading: string; readonly noun: string }>
> = Object.freeze({
  statement: Object.freeze({ heading: 'Statement', noun: 'statement' }),
  url: Object.freeze({ heading: 'URL', noun: 'URL' }),
  route: Object.freeze({ heading: 'Route', noun: 'route' }),
  name: Object.freeze({ heading: 'Name', noun: 'name' }),
});

/**
 * The field {@link rowLabel} takes a row's label from, by the same precedence:
 * a statement, then — for a request-like kind — the URL and then the route,
 * and otherwise the name. Kept beside `rowLabel` so the two cannot drift: the
 * detail must never head a URL "Name".
 */
function rowLabelField(row: WaterfallRow): RowLabelField {
  if (row.statement !== undefined) {
    return 'statement';
  }
  if (REQUEST_LIKE_KINDS.has(row.kind)) {
    if (row.url !== undefined) {
      return 'url';
    }
    if (row.route !== undefined) {
      return 'route';
    }
  }
  return 'name';
}

/**
 * Whether the row abbreviates its label: the one-line preview it shows drops
 * part of the text, rather than only folding its whitespace onto one line.
 *
 * That is what makes a row expandable into its full-value detail, so a label
 * the row already shows whole — a short statement laid out over several lines
 * included — offers no disclosure that would only repeat it.
 *
 * @param label The row's label, as {@link rowLabel} returns it.
 * @returns `true` when the row's preview ends in an elision.
 */
function isAbbreviatedLabel(label: string): boolean {
  return oneLinePreview(label, LABEL_PREVIEW_LENGTH) !== collapseWhitespace(label);
}

/**
 * Why the parent of `subject` could not be resolved. A persisted flag records
 * no reason of the correlator's, and is the missing-parent case by what the
 * service writes it for: the parent it names never arrived — named by id when
 * the service recorded the id, and without one otherwise.
 *
 * Once records have been released ({@link WaterfallOrphan.unverified}), the
 * parent's absence no longer proves that, so the sentence states only what is
 * known: the parent is not among the records held, and may have been released.
 */
function orphanCause(orphan: WaterfallOrphan, subject: string): string {
  const parent =
    orphan.missingParentSpanId === undefined
      ? `the parent ${subject} names`
      : `the parent ${orphan.missingParentSpanId} of ${subject}`;
  return orphan.unverified
    ? `${parent} is not among the records held here, and may have been released`
    : `${parent} never arrived`;
}

/**
 * The sentence a re-attached row adds to its description: that it was lifted
 * to the top level, whether itself or with an enclosing call this view does not
 * draw, and the parent that could not be resolved.
 */
function describeOrphan(orphan: WaterfallOrphan): string {
  return orphan.viaAncestor
    ? `re-attached to the top level with an enclosing call not drawn here: ${orphanCause(orphan, 'that call')}`
    : `re-attached to the top level: ${orphanCause(orphan, 'this call')}`;
}

/*
 * The nouns a row's copy counts in. Every figure a row prints beside a word —
 * its badges, its description, its disclosure's name — goes through
 * `formatCountOf`/`pluralize` from `../utils/format` with one of these, so a
 * single call reads "1 call" and a single row "1 row", never "1 calls" or
 * "1 rows".
 */

/** A captured call: a request, a server request, a statement. */
const CALL_NOUN: CountedNoun = countedNoun('call');

/** A call nested inside the row that was waiting on it. */
const NESTED_CALL_NOUN: CountedNoun = countedNoun('nested call');

/** A database row a statement touched — counted, never shown. */
const ROW_NOUN: CountedNoun = countedNoun('row');

/**
 * How much of a row's label its disclosure button repeats in its name: the
 * same bound the visible label uses, so the control names the call exactly as
 * the row shows it.
 */
const DISCLOSURE_LABEL_PREVIEW_LENGTH = LABEL_PREVIEW_LENGTH;

/**
 * The accessible name of a row's disclosure button, in the state it would
 * toggle to: what it opens or closes, how many, and which call they belong to.
 *
 * A generic "Expand nested calls" names neither the call nor the count, so in a
 * list of such buttons a screen reader user hears the same name on every row.
 * The phrasing is `FlameChart`'s ("Expand the 2 nested calls inside …") so the
 * two nested views announce disclosure alike, and the call is named as the row
 * shows it — its method chip, when it has one, then its label — followed by its
 * kind ("… inside GET /example/resource (Fetch)"). The kind is what tells two
 * disclosures apart when a browser request and the server request answering it
 * share one method and URL, which is the ordinary shape of a correlated trace.
 * A group row's children are the occurrences of one grouped request, not calls
 * it waited on, so it says so.
 *
 * @param row The row the button belongs to.
 * @param expanded Whether the row is expanded now.
 * @returns The button's name.
 */
function disclosureName(row: WaterfallRow, expanded: boolean): string {
  const verb = expanded ? 'Collapse' : 'Expand';
  const call = disclosedCallName(row);
  const count = row.childCount;
  return row.occurrenceCount === undefined
    ? `${verb} the ${formatCountOf(count, NESTED_CALL_NOUN)} inside ${call}`
    : `${verb} the ${formatCountOf(count, CALL_NOUN)} grouped under ${call}`;
}

/**
 * The call a disclosure button names, as the row shows it: its method chip,
 * when it has one, then its label cut to the row's own preview, then its kind
 * ("GET /example/resource (Fetch)").
 */
function disclosedCallName(row: WaterfallRow): string {
  const label = oneLinePreview(rowLabel(row), DISCLOSURE_LABEL_PREVIEW_LENGTH);
  const named = row.method === undefined ? label : `${row.method} ${label}`;
  return `${named} (${formatKindLabel(row.kind)})`;
}

/**
 * The accessible name of the disclosure button of a row that has no children
 * but abbreviates its label, in the state it would toggle to: it shows or
 * hides the row's full-value detail, and names which value of which call —
 * "Show the full statement of SELECT … (Database)".
 *
 * Worded apart from {@link disclosureName} on purpose: "Expand the N nested
 * calls" on a row that has none would promise rows that never appear.
 *
 * @param row The row the button belongs to.
 * @param expanded Whether the detail is shown now.
 * @returns The button's name.
 */
function fullValueDisclosureName(row: WaterfallRow, expanded: boolean): string {
  const verb = expanded ? 'Hide' : 'Show';
  return `${verb} the full ${LABEL_FIELD_WORDS[rowLabelField(row)].noun} of ${disclosedCallName(row)}`;
}

/**
 * The word a pending row's badge carries — the word the request table uses
 * for the same state, so one request reads the same in both views.
 */
const PENDING_LABEL = 'Pending';

/** The words that mark a pending row's duration as a lower bound. */
const LOWER_BOUND_LABEL = 'at least';

/**
 * The Pending badge's text: the word alone on a single call, and the word with
 * the count on a group row holding more than one call still in flight.
 */
function pendingBadgeLabel(row: WaterfallRow): string {
  return row.pendingCount !== undefined && row.pendingCount > 1
    ? `${PENDING_LABEL} ${formatCount(row.pendingCount)}`
    : PENDING_LABEL;
}

/**
 * The sentence a pending row adds to its description: for a single call, that
 * it was still in flight and nothing had come back; for a group row, how many
 * of its calls were.
 */
function describePending(row: WaterfallRow): string {
  if (row.pendingCount === undefined) {
    return 'still in flight when the capture ended; no response had arrived';
  }
  return `${formatCountOf(row.pendingCount, CALL_NOUN)} still in flight when the capture ended`;
}

/**
 * The timing bar's accessible name: what its position and its length say to
 * the eye, in words — where in the window the call began, and how much of the
 * window it spans.
 *
 * The row is named by {@link rowDescription}, which states the same offset and
 * duration as figures; the bar adds the one thing only its geometry shows, the
 * share of the window the call occupied. A duration that was not measured is
 * said to be so rather than given the zero its bar is drawn at, and a call
 * still in flight when the capture ended spans a lower bound, said as one.
 *
 * @param row The row the bar draws.
 * @param windowMs The length of the window every bar is placed in.
 */
function barDescription(row: WaterfallRow, windowMs: number): string {
  const opening = `Timing bar starting ${formatDuration(row.offsetMs)} into the ${formatDuration(
    clampNonNegative(windowMs),
  )} window`;

  if (row.measuredMs === undefined) {
    return `${opening}; its duration was not measured (${NOT_AVAILABLE_LABEL})`;
  }

  const extent = row.pending
    ? `${LOWER_BOUND_LABEL} ${formatDuration(row.measuredMs)}`
    : formatDuration(row.measuredMs);

  return `${opening}, spanning ${extent}, ${formatShare(row.measuredMs, windowMs)} of it`;
}

/**
 * Everything about a row that does not fit on it, as one line of text, opening
 * with the given form of its label.
 *
 * Reached by pointer as a tooltip, by keyboard focus of the row as the same
 * bubble held open, and by assistive technology as the row's accessible name.
 * The row builds it twice from one label: whole (whitespace collapsed) for the
 * bubble, which the `Tooltip` primitive bounds and scrolls, and cut to
 * {@link NAME_LABEL_PREVIEW_LENGTH} for the name, which is announced whole on
 * every visit. For a label within that bound the two are the same string.
 * A byte figure that the runtime could not observe for a call that
 * would normally carry one is stated as unavailable rather than omitted or
 * shown as a zero. A call still in flight when the capture ended states its
 * duration as the lower bound it is ("took at least …") and says that no
 * response had arrived, rather than reading as a request that completed. A
 * duration that was not measured is stated the same way a missing byte figure
 * is — "took n/a" — never as the zero its bar is drawn at, and without the
 * lower-bound words, which qualify a figure there is none of.
 *
 * The sentence carries captured text beyond the label — the other lineage
 * candidates and the unresolved parent's span id — and its short form is the
 * treeitem's own `aria-label`, which no primitive reveals. So every Unicode
 * direction control in it is returned as its visible escape
 * (`formatUntrustedText`): the name a screen reader hears and the bubble a
 * pointer opens read in logical order, while the row itself stays raw.
 *
 * @param row The row described.
 * @param labelText The label as this form of the sentence carries it.
 * @returns The sentence, its parts joined with ` · `.
 */
function rowDescription(row: WaterfallRow, labelText: string): string {
  const parts: string[] = [labelText];
  parts.push(`${formatKindLabel(row.kind)} · ${formatTierLabel(row.tier)}`);
  const took =
    row.measuredMs === undefined
      ? `took ${NOT_AVAILABLE_LABEL}`
      : row.pending
        ? `took ${LOWER_BOUND_LABEL} ${formatDuration(row.measuredMs)}`
        : `took ${formatDuration(row.measuredMs)}`;
  parts.push(`starts ${formatDuration(row.offsetMs)} into the window · ${took}`);
  if (row.pending) {
    parts.push(describePending(row));
  }
  if (row.statusCode !== undefined) {
    parts.push(`status ${String(row.statusCode)}`);
  } else if (row.status !== 'unset') {
    parts.push(`status ${formatStatusLabel(row.status)}`);
  }
  if (row.rowCount !== undefined) {
    parts.push(`${formatCountOf(row.rowCount, ROW_NOUN)} touched`);
  }
  if (row.transferredBytes !== undefined) {
    parts.push(`transferred ${formatBytes(row.transferredBytes)}`);
  } else if (row.expectsTransfer) {
    parts.push(`transferred ${NOT_AVAILABLE_LABEL}`);
  }
  if (row.occurrenceCount !== undefined) {
    parts.push(`${formatCountOf(row.occurrenceCount, CALL_NOUN)} in this group`);
  }
  if (row.lineageAmbiguous) {
    const candidates =
      row.lineageCandidates.length === 0
        ? ''
        : ` · other candidates: ${row.lineageCandidates.join(', ')}`;
    parts.push(`parent inferred from an async continuation${candidates}`);
  }
  if (row.orphan !== undefined) {
    parts.push(describeOrphan(row.orphan));
  }
  if (row.childrenTruncated) {
    parts.push('nested calls below this row were not drawn');
  }
  return formatUntrustedText(parts.join(' · '));
}

/** The selector for the controls nested inside a row, which own their own clicks. */
const NESTED_CONTROL_SELECTOR = 'button, a[href], input, select, textarea';

/**
 * Whether an event came from a control nested inside a row.
 *
 * A row is activatable and holds controls of its own — the disclosure button and
 * the source chip — so row activation has to distinguish the two. Asking the DOM
 * which control the event came from covers every nested control, including the
 * one the source chip renders for itself, without each of them having to
 * remember to stop propagation.
 */
function isNestedControlEvent(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(NESTED_CONTROL_SELECTOR) !== null;
}

/* ---------------------------------------------------------------------------
 * The visible rows, and the window of them the tree mounts
 *
 * Every row a reader can reach — each top-level row, and the rows under every
 * expanded one — is flattened into one list in reading order. The list is
 * plain data (a path key, a depth, a parent position and a reference to the
 * held record), so it costs a few fields per row however many rows are held;
 * the tree then mounts only a window of it ({@link WATERFALL_ROW_BUDGET}) and
 * builds a {@link WaterfallRow} for exactly those rows. Expansion is keyed by
 * record id, so it survives the window moving, a new page arriving, and a row
 * moving under a parent a later page supplied.
 *
 * The keyboard works over the list rather than over the document: the next
 * row, the parent and the first child are list positions, and a move to a row
 * outside the window moves the window to it first, so ArrowDown past the last
 * mounted row pages on rather than stopping.
 *
 * The tree is one composite widget and so one stop in the page's Tab order:
 * exactly one mounted row carries `tabIndex={0}`, every other row `-1`, and the
 * arrow keys — not Tab — move between rows. The row that receives focus reports
 * itself from its `onFocus`, which is what moves the stop. The stop is STATE
 * rather than a DOM query because it has to be right on renders where nothing
 * inside the tree holds focus — the first paint, a collapse, a newly appended
 * page, a window the Next control moved.
 *
 * Rows are identified by their PATH — the chain of record ids from the top level
 * down — and not by `eventId` alone, because `eventId` is not unique among drawn
 * rows: a grouped request's parent row reports its first occurrence's id, and
 * that occurrence is drawn beneath it under the same id. Keyed by `eventId`,
 * expanding such a group would put two rows in the Tab order.
 * ------------------------------------------------------------------------- */

/** What one visible row draws from: a flat record, a group, or one of its occurrences. */
type RowSource =
  | {
      readonly kind: 'event';
      readonly event: TelemetryEvent;
      readonly orphan: PersistedOrphan | undefined;
    }
  | { readonly kind: 'group'; readonly held: HeldGroup }
  | {
      readonly kind: 'occurrence';
      readonly held: HeldGroup;
      readonly occurrence: RequestOccurrence;
    };

/** One row of the flattened visible list. */
interface VisibleRow {
  /** The row's path key; see {@link rowKeyFor}. */
  readonly key: string;
  /** The record id the row reports, and what `expandedIds` is keyed by. */
  readonly eventId: string;
  /** Zero-based nesting depth, reported to assistive technology as the level. */
  readonly depth: number;
  /** The list position of the row this one is nested under; `-1` at the top level. */
  readonly parentIndex: number;
  /** One-based position among its siblings, for `aria-posinset`. */
  readonly position: number;
  /** How many siblings it has, itself included, for `aria-setsize`. */
  readonly setSize: number;
  /** How many rows it can disclose; `0` for a leaf and for a row the depth bound cut. */
  readonly childCount: number;
  /** Set when the depth bound, or the payload, cut its children. */
  readonly childrenTruncated: boolean;
  /** Whether its children follow it in the list. */
  readonly expanded: boolean;
  /**
   * Whether the reader expanded the row: `expandedIds` holds its record id.
   * Wider than {@link VisibleRow.expanded}, which also needs children to show:
   * a leaf with an abbreviated label is expanded to show its full-value detail
   * alone, and a row the depth bound cut keeps its nested records undrawn
   * however it is expanded.
   */
  readonly open: boolean;
  /**
   * Whether the row may be expanded into a full-value detail of its own when
   * it abbreviates its label. `false` only for the occurrence rows under a
   * group row: they carry the group's URL, which the group row's own detail
   * shows whenever they are visible, and the first of them shares the group
   * row's record id (`HeldGroup.rowId`), so expanding it would collapse the
   * group it sits in.
   */
  readonly detailable: boolean;
  /** The held data the row is built from. */
  readonly source: RowSource;
}

/** The flattened visible list, and each row's position in it by path key. */
interface VisibleRows {
  readonly rows: readonly VisibleRow[];
  readonly indexByKey: ReadonlyMap<string, number>;
}

/**
 * The path key of a row: its parent's key followed by its own record id.
 *
 * Each id is length-prefixed, which makes the concatenation uniquely decodable
 * ({@link decodeRowKey}), so two different chains can never produce the same
 * key whatever characters the ids contain.
 */
function rowKeyFor(parentKey: string | undefined, eventId: string): string {
  return `${parentKey ?? ''}${String(eventId.length)}:${eventId}`;
}

/**
 * The record ids a path key is made of, top level first.
 *
 * @param key A key {@link rowKeyFor} produced.
 * @returns The ids, or `undefined` for a key it could not have produced.
 */
function decodeRowKey(key: string): readonly string[] | undefined {
  const ids: string[] = [];
  let at = 0;
  while (at < key.length) {
    const colon = key.indexOf(':', at);
    const length = colon < 0 ? Number.NaN : Number(key.slice(at, colon));
    if (!Number.isSafeInteger(length) || length < 0 || colon + 1 + length > key.length) {
      return undefined;
    }
    ids.push(key.slice(colon + 1, colon + 1 + length));
    at = colon + 1 + length;
  }
  return ids.length === 0 ? undefined : ids;
}

/** One level of the flattening walk: a sibling list and how far into it the walk is. */
interface FlattenFrame {
  readonly ids: readonly string[];
  next: number;
  readonly depth: number;
  readonly parentIndex: number;
  readonly parentKey: string | undefined;
}

/**
 * Flattens the held flat records: each top-level row in drawing order, and —
 * while a row is expanded — its subtree directly after it. A row at the depth
 * bound discloses nothing and reports the cut.
 */
function flattenSpans(index: SpanIndex, expandedIds: ReadonlySet<string>): VisibleRows {
  const rows: VisibleRow[] = [];
  const indexByKey = new Map<string, number>();
  const frames: FlattenFrame[] = [
    { ids: index.roots, next: 0, depth: 0, parentIndex: -1, parentKey: undefined },
  ];
  for (
    let frame = frames[frames.length - 1];
    frame !== undefined;
    frame = frames[frames.length - 1]
  ) {
    const id = frame.ids[frame.next];
    if (id === undefined) {
      frames.pop();
      continue;
    }
    frame.next += 1;
    const held = index.records.get(id);
    const placement = index.placements.get(id);
    if (held === undefined || placement === undefined) {
      continue;
    }
    const nested = index.children.get(id) ?? EMPTY_IDS;
    const cut = nested.length > 0 && frame.depth + 1 >= MAX_ROW_DEPTH;
    const childCount = cut ? 0 : nested.length;
    const open = expandedIds.has(id);
    const expanded = childCount > 0 && open;
    const key = rowKeyFor(frame.parentKey, id);
    const at = rows.length;
    rows.push({
      key,
      eventId: id,
      depth: frame.depth,
      parentIndex: frame.parentIndex,
      position: frame.next,
      setSize: frame.ids.length,
      childCount,
      childrenTruncated: cut,
      expanded,
      open,
      detailable: true,
      source: { kind: 'event', event: held.event, orphan: placement.orphan },
    });
    indexByKey.set(key, at);
    if (expanded) {
      frames.push({
        ids: nested,
        next: 0,
        depth: frame.depth + 1,
        parentIndex: at,
        parentKey: key,
      });
    }
  }
  return { rows, indexByKey };
}

/**
 * Flattens the held groups: a group of one occurrence is that occurrence's
 * row, and a larger group is a row of its own, followed — while it is expanded
 * — by one row per occurrence.
 */
function flattenRequests(index: RequestIndex, expandedIds: ReadonlySet<string>): VisibleRows {
  const rows: VisibleRow[] = [];
  const indexByKey = new Map<string, number>();
  const setSize = index.order.length;
  let position = 0;
  const push = (row: VisibleRow): number => {
    const at = rows.length;
    rows.push(row);
    indexByKey.set(row.key, at);
    return at;
  };
  for (const groupId of index.order) {
    const held = index.groups.get(groupId);
    if (held === undefined) {
      continue;
    }
    position += 1;
    const [single] = held.occurrences;
    if (held.occurrences.length === 1 && single !== undefined) {
      push({
        key: rowKeyFor(undefined, single.eventId),
        eventId: single.eventId,
        depth: 0,
        parentIndex: -1,
        position,
        setSize,
        childCount: 0,
        childrenTruncated: false,
        expanded: false,
        open: expandedIds.has(single.eventId),
        detailable: true,
        source: { kind: 'occurrence', held, occurrence: single },
      });
      continue;
    }
    const key = rowKeyFor(undefined, held.rowId);
    const expanded = expandedIds.has(held.rowId);
    const at = push({
      key,
      eventId: held.rowId,
      depth: 0,
      parentIndex: -1,
      position,
      setSize,
      childCount: held.occurrences.length,
      childrenTruncated: held.group.occurrencesTruncated,
      expanded,
      open: expanded,
      detailable: true,
      source: { kind: 'group', held },
    });
    if (!expanded) {
      continue;
    }
    held.occurrences.forEach((occurrence, occurrenceAt) => {
      push({
        key: rowKeyFor(key, occurrence.eventId),
        eventId: occurrence.eventId,
        depth: 1,
        parentIndex: at,
        position: occurrenceAt + 1,
        setSize: held.occurrences.length,
        childCount: 0,
        childrenTruncated: false,
        expanded: false,
        open: false,
        detailable: false,
        source: { kind: 'occurrence', held, occurrence },
      });
    });
  }
  return { rows, indexByKey };
}

const NO_VISIBLE_ROWS: VisibleRows = { rows: [], indexByKey: new Map() };

/** The flattened visible list of whatever is held. */
function flattenLoaded(loaded: LoadedPages, expandedIds: ReadonlySet<string>): VisibleRows {
  switch (loaded.kind) {
    case 'spans':
      return flattenSpans(loaded.holding.index, expandedIds);
    case 'requests':
      return flattenRequests(loaded.holding.index, expandedIds);
    default:
      return NO_VISIBLE_ROWS;
  }
}

/**
 * Whether a chain of record ids is a row of the held tree, collapsed or not —
 * what tells a row a collapse hid from a row the data no longer holds.
 */
function rowPathExists(loaded: LoadedPages, ids: readonly string[]): boolean {
  if (loaded.kind === 'spans') {
    if (ids.length === 0 || ids.length > MAX_ROW_DEPTH) {
      return false;
    }
    let parentId: string | undefined;
    for (const id of ids) {
      const placement = loaded.holding.index.placements.get(id);
      if (placement === undefined || placement.parentId !== parentId) {
        return false;
      }
      parentId = id;
    }
    return true;
  }
  if (loaded.kind === 'requests') {
    const [rowId, occurrenceId, ...rest] = ids;
    const groupId = rowId === undefined ? undefined : loaded.holding.index.byRowId.get(rowId);
    const held = groupId === undefined ? undefined : loaded.holding.index.groups.get(groupId);
    if (held === undefined || rest.length > 0) {
      return false;
    }
    return (
      occurrenceId === undefined ||
      (held.occurrences.length > 1 &&
        held.occurrences.some((occurrence) => occurrence.eventId === occurrenceId))
    );
  }
  return false;
}

/**
 * The row object for one visible row: built only for the rows the tree mounts,
 * with offsets measured from the window's start.
 *
 * @param entry The visible row.
 * @param viewStart The window's start, in epoch milliseconds.
 * @param unverified Whether records were released, so a re-attachment flag's
 * missing parent may have been among them (see {@link WaterfallOrphan}).
 */
function buildRow(entry: VisibleRow, viewStart: number, unverified: boolean): WaterfallRow {
  const { source } = entry;
  switch (source.kind) {
    case 'event':
      return rowFromEvent(
        source.event,
        viewStart,
        entry.childCount,
        entry.childrenTruncated,
        source.orphan === undefined ? undefined : { ...source.orphan, unverified },
      );
    case 'group':
      return rowFromGroup(source.held.group, source.held.occurrences, viewStart, entry.childCount);
    default:
      return rowFromOccurrence(source.held.group, source.occurrence, viewStart);
  }
}

/**
 * The list position of the row that holds the tree's single tab stop — always
 * a row the window mounts.
 *
 * The requested row — the one that last received focus — when it is mounted;
 * otherwise the nearest ancestor of it that is visible (a collapse hid it),
 * when that ancestor is mounted; otherwise the window's first row, which is
 * the first top-level row while the window is at the start. An ancestor chain
 * is walked from the top down, and the first ancestor that is not open is the
 * nearest visible one, because everything beneath a closed row is out of the
 * list.
 *
 * @returns The position, or `undefined` when no row is mounted.
 */
function resolveTabStop(
  loaded: LoadedPages,
  visible: VisibleRows,
  mounted: RowWindow,
  requestedKey: string | undefined,
): number | undefined {
  if (mounted.count === 0) {
    return undefined;
  }
  const fallback = mounted.start;
  const mountedOr = (at: number): number => (windowContains(mounted, at) ? at : fallback);
  if (requestedKey === undefined) {
    return fallback;
  }
  const direct = visible.indexByKey.get(requestedKey);
  if (direct !== undefined) {
    return mountedOr(direct);
  }
  const ids = decodeRowKey(requestedKey);
  if (ids === undefined || !rowPathExists(loaded, ids)) {
    return fallback;
  }
  let key: string | undefined;
  for (const id of ids) {
    key = rowKeyFor(key, id);
    const at = visible.indexByKey.get(key);
    const row = at === undefined ? undefined : visible.rows[at];
    if (at === undefined || row === undefined) {
      return fallback;
    }
    if (!row.expanded) {
      return mountedOr(at);
    }
  }
  return fallback;
}

/** One mounted row: its place in the list, and the row object built for it. */
interface WindowItem {
  readonly entry: VisibleRow;
  readonly row: WaterfallRow;
  /** Its position in the flattened visible list. */
  readonly index: number;
}

/** A mounted row, and the mounted rows nested under it. */
interface WindowRowBlock {
  readonly kind: 'row';
  readonly item: WindowItem;
  readonly children: WindowBlock[];
}

/**
 * The mounted rows nested under an ancestor the window does not mount — the
 * rows at the top of a window that starts inside an expanded subtree. Drawn as
 * the same indented group a mounted ancestor's children are, so the nesting
 * reads the same on either side of a window edge.
 */
interface WindowContinuation {
  readonly kind: 'continuation';
  /** The depth of the rows it holds. */
  readonly depth: number;
  readonly children: WindowBlock[];
}

type WindowBlock = WindowRowBlock | WindowContinuation;

/**
 * Nests the mounted slice of the visible list back into groups, so each row's
 * children sit in the indented child group of the stylesheet, and rows whose
 * ancestors lie before the window sit in continuation groups at their depth.
 *
 * @param items The mounted rows, in list order.
 * @returns The top-level blocks.
 */
function nestWindow(items: readonly WindowItem[]): readonly WindowBlock[] {
  const top: WindowBlock[] = [];
  // `levels[d]` is the block list the next row at depth `d` joins.
  const levels: WindowBlock[][] = [top];
  for (const item of items) {
    const depth = item.entry.depth;
    if (levels.length > depth + 1) {
      levels.length = depth + 1;
    }
    for (
      let open = levels[levels.length - 1];
      open !== undefined && levels.length < depth + 1;
      open = levels[levels.length - 1]
    ) {
      const continuation: WindowContinuation = {
        kind: 'continuation',
        depth: levels.length,
        children: [],
      };
      open.push(continuation);
      levels.push(continuation.children);
    }
    const block: WindowRowBlock = { kind: 'row', item, children: [] };
    levels[depth]?.push(block);
    levels.push(block.children);
  }
  return top;
}

/** A keyboard move between rows, resolved over the visible list. */
type RowMove = 'next' | 'previous' | 'first' | 'last' | 'parent' | 'firstChild';

/**
 * Where a move from the row at `from` lands.
 *
 * @returns The target's list position, or `undefined` when the move leads
 * nowhere: past either end, above a top-level row, or into a closed row.
 */
function moveTarget(visible: VisibleRows, from: number, move: RowMove): number | undefined {
  const origin = visible.rows[from];
  if (origin === undefined) {
    return undefined;
  }
  const target = ((): number => {
    switch (move) {
      case 'next':
        return from + 1;
      case 'previous':
        return from - 1;
      case 'first':
        return 0;
      case 'last':
        return visible.rows.length - 1;
      case 'parent':
        return origin.parentIndex;
      default:
        // The first child directly follows an open row in reading order.
        return origin.expanded && origin.childCount > 0 ? from + 1 : -1;
    }
  })();
  return target >= 0 && target < visible.rows.length ? target : undefined;
}

/** The attribute a mounted row carries its list position in, for focusing it. */
const ROW_POSITION_ATTRIBUTE = 'data-dg-row';

/** Focuses the mounted row at a list position, if it is mounted. */
function focusTreeRow(tree: HTMLElement | null, index: number): void {
  tree?.querySelector<HTMLElement>(`[${ROW_POSITION_ATTRIBUTE}="${String(index)}"]`)?.focus();
}

/**
 * The shortcut a row advertises through `aria-keyshortcuts` when Shift+Enter
 * opens its source — the `aria-keyshortcuts` spelling of the chord.
 */
const OPEN_SOURCE_SHORTCUT = 'Shift+Enter';

/** The same chord as the printed keys of the hint the revealed description shows. */
const OPEN_SOURCE_KEYS: readonly string[] = ['Shift', 'Enter'];

/* ---------------------------------------------------------------------------
 * The time axis
 * ------------------------------------------------------------------------- */

/** Where a tick's label sits against its tick: the SVG `text-anchor` values. */
type TickAnchor = 'start' | 'middle' | 'end';

/** One tick to draw, and where its label is anchored. */
interface PlacedTick {
  readonly tick: AxisTick;
  readonly anchor: TickAnchor;
}

/**
 * The estimated inline extent of a tick label, in ems of the label font.
 *
 * `../utils/format`'s deterministic advance estimate, which errs towards
 * "wider": a tick label is a compact duration — digits, a decimal point, a
 * space and a unit (`0 ms`, `470 µs`, `1.2 s`) — and the estimate's narrow
 * advance is an upper bound on those characters in the UI face. Erring wide
 * can drop a tick that would just have fitted, never draw two labels into
 * each other.
 */
function labelExtentEm(label: string): number {
  return estimateTextWidth(label, EM_FONT_SIZE);
}

/**
 * Places a tick set on the design strip, or reports that it does not fit.
 *
 * Each label is centred under its tick, and anchored to its tick's start or
 * end only when a centred label would cross the strip's own edge — so a label
 * inside the strip sits under the tick it names. The set fits when every
 * estimated label box lies inside `[0, AXIS_DESIGN_WIDTH_EM]` and each is at
 * least {@link AXIS_LABEL_GAP_EM} ems clear of the one before it; ticks arrive
 * in ascending order, so neighbours are the only pairs that can collide.
 *
 * An anchor chosen here stays right on every wider strip: a centred label
 * that clears an edge at this width clears it by more on a wider one, and a
 * label anchored to its tick never leaves the strip its tick is inside.
 *
 * @param ticks The candidate ticks, ascending.
 * @returns The placed ticks, or `undefined` when two labels would touch or one
 * cannot fit inside the strip at all.
 */
function placeOnDesignStrip(ticks: readonly AxisTick[]): readonly PlacedTick[] | undefined {
  const width = AXIS_DESIGN_WIDTH_EM;
  const placed: PlacedTick[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;

  for (const tick of ticks) {
    const extent = labelExtentEm(tick.label);
    const x = (tick.offset / PERCENT_RANGE) * width;
    let anchor: TickAnchor = 'middle';
    let start = x - extent / 2;
    if (start < 0) {
      anchor = 'start';
      start = x;
    } else if (start + extent > width) {
      anchor = 'end';
      start = x - extent;
    }
    const end = start + extent;
    if (start < 0 || end > width || start - previousEnd < AXIS_LABEL_GAP_EM) {
      return undefined;
    }
    placed.push({ tick, anchor });
    previousEnd = end;
  }

  return placed;
}

/**
 * The ticks the axis draws, and how each label is anchored: a pure function of
 * the scale and the window's start.
 *
 * Asks `generateAxisTicks` for {@link AXIS_TICK_TARGET} ticks and then for one
 * fewer at a time — each request rounding to the scale's next "nice" step —
 * and draws the first set whose labels fit the design strip (see
 * {@link placeOnDesignStrip}). That also keeps two ticks from sharing one
 * label: a step finer than the compact label's precision prints the same text
 * twice, and two such labels cannot both fit. If not even a single-tick
 * request fits, the window's first tick is drawn alone: an axis with no label
 * at all would carry no scale.
 *
 * Every position is the scale's percentage, so the ticks stay in register with
 * the bars beneath them at every width, and nothing here depends on the
 * rendered strip: the same window always draws the same ticks.
 *
 * @param scale The shared time scale, over the percentage range.
 * @param origin The instant offsets are measured from: the first drawn call.
 * @returns The ticks to draw, ascending, with their anchors.
 */
function fitAxisTicks(scale: TimeScale, origin: number): readonly PlacedTick[] {
  const ticksFor = (targetCount: number): readonly AxisTick[] =>
    generateAxisTicks(scale, {
      origin,
      targetCount,
      minSpacing: AXIS_TICK_MIN_SPACING,
    }).ticks;

  for (let target = AXIS_TICK_TARGET; target >= 1; target -= 1) {
    const placed = placeOnDesignStrip(ticksFor(target));
    if (placed !== undefined) {
      return placed;
    }
  }

  const [first] = ticksFor(1);
  return first === undefined ? [] : [{ tick: first, anchor: 'start' }];
}

interface WaterfallAxisProps {
  /** The shared time scale every bar is placed in, over the percentage range. */
  readonly scale: TimeScale;
  /** The instant tick offsets are measured from: the window's start. */
  readonly origin: number;
  /** The window's extent, in milliseconds. */
  readonly windowMs: number;
}

/**
 * The axis strip above the rows, laid out on the same three-column grid as a row
 * so its ticks line up with the bars beneath them.
 *
 * Drawn as an SVG because a tick sits at a fraction of the track and text is the
 * only thing there is to place; the percentages come from the same scale the
 * bars use, so no position here is measured either. How many labels it carries
 * is not measured either: the tick set is the densest whose labels clear each
 * other on the fixed design strip ({@link fitAxisTicks}) — which no drawn
 * strip is narrower than, because the row grid this strip shares floors its
 * track there — computed from the scale alone and memoised on it, so the
 * graphic holds no reference to its own element and reads nothing back from
 * the DOM. The graphic is a single
 * `role="img"` with a label that states the window it spans — its tick text is
 * a scale, not content to be read one label at a time — and its colours are
 * `currentColor`, inherited from the muted type role around it, so the axis
 * carries no colour of its own.
 *
 * The window's extent is printed through the same `DurationCell` at the same
 * size a row uses, rather than as plain text, so it reads as the column's
 * heading figure. The strip and every row are subgrids of ONE grid, the scroll
 * viewport's (`.dg-waterfall__viewport` in `../styles/components.css`), so
 * the duration column is as wide as the widest figure in the whole chart and
 * the time track starts and ends in the same place in the strip and in every
 * row, at every nesting depth: a child group's indent insets only the label
 * column's content. A bar is therefore exact against this strip and against
 * every other bar, and the exact figures never depend on the pixels at all:
 * every row prints its own duration, and its tooltip states how far into the
 * window it started.
 */
function WaterfallAxis(props: WaterfallAxisProps): ReactElement {
  const { scale, origin, windowMs } = props;
  const ticks = useMemo(() => fitAxisTicks(scale, origin), [scale, origin]);
  return (
    <div className="dg-waterfall__row dg-waterfall__axis">
      <Text as="span" size="xs" tone="muted">
        Offset from the first call
      </Text>
      <Text as="div" size="xs" tone="muted" className="dg-waterfall__axis-strip">
        <svg
          width="100%"
          height={AXIS_HEIGHT}
          role="img"
          aria-label={`Time axis spanning ${formatDurationCompact(windowMs)} from the first call`}
          focusable="false"
        >
          <line
            x1={0}
            y1={0}
            x2="100%"
            y2={0}
            stroke="currentColor"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {ticks.map(({ tick, anchor }) => (
            <g key={`${String(tick.value)}-${String(tick.offset)}`}>
              <line
                x1={percent(tick.offset)}
                y1={0}
                x2={percent(tick.offset)}
                y2={AXIS_TICK_LENGTH}
                stroke="currentColor"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={percent(tick.offset)}
                y={AXIS_LABEL_BASELINE}
                textAnchor={anchor}
                fill="currentColor"
              >
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </Text>
      <DurationCell ms={windowMs} severity="none" size="sm" className="dg-waterfall__duration" />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * One row, and the mounted rows nested under it
 * ------------------------------------------------------------------------- */

/** What every mounted row shares: the scale, the selection and the handlers. */
interface RowContext {
  /** The shared time scale; every bar is placed in it. */
  readonly scale: TimeScale;
  /** The window's start, which every offset is measured from. */
  readonly viewStart: number;
  /** Prefix for child group ids, unique per mounted component. */
  readonly groupIdPrefix: string;
  /**
   * The panel's shared selection. A row is marked when it stands for the
   * selected event — by id, or by the trace and span it draws
   * ({@link matchesPanelSelection}), so a selection made in a view that keys
   * the span differently still lands here.
   */
  readonly selection: PanelSelection | undefined;
  /** The list position of the row holding the tree's single tab stop. */
  readonly tabStopIndex: number | undefined;
  /** Reports that focus entered a row, which moves the tab stop to it. */
  readonly onRowFocus: (rowKey: string) => void;
  readonly onToggle: (row: WaterfallRow) => void;
  readonly onSelect: (row: WaterfallRow) => void;
  /** Moves focus from the row at a list position, paging the window when needed. */
  readonly onNavigate: (from: number, move: RowMove) => void;
  /**
   * The host's open-source action, or `undefined` when there is no host. Passed
   * down rather than read per row so the Shift+Enter command and its
   * `aria-keyshortcuts` advertisement are decided by one value.
   */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

interface WaterfallRowItemProps {
  readonly item: WindowItem;
  /**
   * The id of the child group mounted after this row, or `undefined` when none
   * is: the row is closed, or its children lie past the window's end.
   */
  readonly groupId: string | undefined;
  readonly context: RowContext;
}

/**
 * One row of the tree.
 *
 * The row element is the three-column grid the stylesheet defines — label,
 * track, duration — so it draws those three children, and its child group is a
 * DOM sibling ({@link WaterfallBlocks}), owned by the row through `aria-owns`
 * while it is mounted: treeitems inside the row's own grid would read as part
 * of this one row. The only other child is the full-value detail of an
 * abbreviated label while the row is expanded, which the stylesheet places
 * below the three across every track (`grid-column: full`). Its level, and its
 * place among its siblings, are stated outright (`aria-level`,
 * `aria-posinset`, `aria-setsize`), because the window may mount only some of
 * its siblings.
 *
 * The row element is the treeitem and the row's only focus target: it holds the
 * tree's roving tab stop when `tabStopIndex` names it, and its nested controls
 * are out of the Tab order (see the module header's keyboard model).
 */
function WaterfallRowItem(props: WaterfallRowItemProps): ReactElement {
  const { item, groupId, context } = props;
  const { entry, row, index } = item;
  const {
    scale,
    viewStart,
    selection,
    tabStopIndex,
    onRowFocus,
    onToggle,
    onSelect,
    onNavigate,
    onOpenSource,
  } = context;

  const hasChildren = row.childCount > 0;
  const selected = matchesPanelSelection(selection, row);
  const rowKey = entry.key;
  const label = rowLabel(row);
  // A row that cuts its label short can be expanded into the whole of it, with
  // or without children (see the module header, "The whole of a long value").
  // One expanded state serves both: expanding a row shows its children, when it
  // has any, and its full-value detail, when it abbreviates its label.
  const abbreviated = entry.detailable && isAbbreviatedLabel(label);
  const expandable = hasChildren || abbreviated;
  const expanded = expandable && entry.open;
  const detailShown = abbreviated && expanded;
  const detailId = useId();
  // The sentence twice from one label: bounded for the name a screen reader
  // announces on every visit, whole for the bubble, which the `Tooltip`
  // primitive bounds and scrolls. Within the name's bound the two are one.
  const accessibleName = rowDescription(row, oneLinePreview(label, NAME_LABEL_PREVIEW_LENGTH));
  const description = rowDescription(row, collapseWhitespace(label));
  // What the disclosure opens right now, for its `aria-controls`: the child
  // group while it is mounted and the detail while it is shown — a control may
  // not point at an id that is not in the document.
  const controlledIds = [expanded ? groupId : undefined, detailShown ? detailId : undefined]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  // The row's source location, read once so the Shift+Enter command hands the
  // host the very object the row holds — by reference, as the chip does.
  const source = row.source;
  const canOpenSource = source !== undefined && onOpenSource !== undefined;

  // Whether the row's description is revealed for KEYBOARD focus. The label's
  // `Tooltip` opens on hover and on focus of its own trigger, and its trigger —
  // a truncated label — is not focusable and must not become a second stop in
  // the row; so while the treeitem itself holds keyboard focus the row holds
  // that same `Tooltip` open instead. Set by a keyboard focus of the row
  // element, cleared by Escape and by the row losing focus.
  const [descriptionRevealed, setDescriptionRevealed] = useState(false);

  // Set by a pointer press on the row and consumed by the focus it causes, so
  // that a click — which focuses the row too — does not pop a bubble the hover
  // tooltip already offers. A ref, not state: it changes nothing on screen.
  const pointerFocusRef = useRef(false);

  // Bar geometry, in the scale's percentage range: `x` is how far into the
  // window the call started, `width` its extent with the scale's minimum
  // visible width applied so a sub-millisecond call is still a bar.
  const geometry = placeOffsetSpan(row.offsetMs, row.durationMs, viewStart, scale);

  // A call too short to draw is given the scale's minimum visible width, and one
  // that would then run past the end of the window is pulled back to the
  // window's edge: a sliver at the right-hand edge reads as "at the very end"
  // rather than as a measurement, and the exact figures are in the row's
  // duration cell and in its name. That is `../utils/scale`'s behaviour, not a
  // judgement made here.
  //
  // The row's colour: one `--dgc-bar-color` token reference from
  // `../utils/color` (see `barColorOf`), set on the row rather than on the bar
  // so the two things the stylesheet paints from it — the bar, and the edge of
  // a failed row — can never disagree. Custom properties inherit, and the child
  // group is the row's sibling, so a nested row never inherits its parent's.
  const rowStyle: CustomPropertyStyle = { '--dgc-bar-color': barColorOf(row) };

  // The bar's geometry. The values live in `--dgc-*` custom properties — two
  // coordinates, percentages from `../utils/scale` — and the two declarations
  // beside them are `var()` references that contain no value of their own. This
  // is the contract `.dg-waterfall__bar` states in `../styles/components.css`:
  // "`inset-inline-start` and `inline-size` are the component's, computed from
  // the time scale".
  const barStyle: CustomPropertyStyle = {
    '--dgc-bar-offset': percent(geometry.x),
    '--dgc-bar-extent': percent(geometry.width),
    insetInlineStart: 'var(--dgc-bar-offset)',
    inlineSize: 'var(--dgc-bar-extent)',
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (isNestedControlEvent(event.target)) {
      return;
    }
    onSelect(row);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Focus can sit on the disclosure button or the source chip after a
    // pointer pressed one — neither is in the Tab order. Enter and Space, with
    // or without Shift, then belong to that control's own activation, which the
    // browser performs; the arrow keys, Home and End still navigate from the
    // row that holds it, so a pointer press never strands the keyboard.
    if ((event.key === 'Enter' || event.key === ' ') && isNestedControlEvent(event.target)) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        // Dismisses the revealed description until the row loses focus, and is
        // consumed only when there was one to dismiss: a dialog or a picking
        // mode above the tree needs Escape too.
        if (descriptionRevealed) {
          event.preventDefault();
          event.stopPropagation();
          setDescriptionRevealed(false);
        }
        return;
      case 'Enter':
        if (event.shiftKey) {
          // The row's command for its source chip, which is out of the Tab
          // order. Consumed only when it does something — the exact chord, on a
          // row that resolved to a location, with a host to hand it to — so a
          // Shift+Enter anywhere else still reaches whatever is above the tree.
          // Never a selection: opening a file is not choosing a record.
          if (
            source !== undefined &&
            onOpenSource !== undefined &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            onOpenSource(source);
          }
          return;
        }
        // Enter would submit an enclosing form in a host that has one.
        event.preventDefault();
        onSelect(row);
        return;
      case ' ':
        // Space scrolls the panel otherwise.
        event.preventDefault();
        onSelect(row);
        return;
      // Every move below is a position in the visible list, and one outside
      // the mounted window moves the window to it before focusing it.
      case 'ArrowDown':
        event.preventDefault();
        onNavigate(index, 'next');
        return;
      case 'ArrowUp':
        event.preventDefault();
        onNavigate(index, 'previous');
        return;
      case 'ArrowRight':
        // Open a closed row, then step into it: the two presses the tree
        // pattern asks for, in that order. A leaf that abbreviates its label
        // opens too — into its full-value detail — and has no child to step
        // into, so the second press moves nothing.
        event.preventDefault();
        if (expandable && !expanded) {
          onToggle(row);
          return;
        }
        onNavigate(index, 'firstChild');
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (expanded) {
          onToggle(row);
          return;
        }
        onNavigate(index, 'parent');
        return;
      case 'Home':
        event.preventDefault();
        onNavigate(index, 'first');
        return;
      case 'End':
        event.preventDefault();
        onNavigate(index, 'last');
        return;
      default:
        return;
    }
  };

  const handleToggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onToggle(row);
  };

  const handlePointerDown = (): void => {
    pointerFocusRef.current = true;
  };

  // Any focus inside the row — the row itself from the keyboard or a click, or
  // a nested control a pointer landed on — moves the tree's single tab stop
  // here. React's `onFocus` bubbles, and the child group is a DOM sibling of the
  // row, so focus in a nested row never reaches this handler. The description
  // is revealed only for focus of the row element itself that no pointer press
  // caused: Tab, Shift+Tab and the tree's arrow keys.
  const handleFocus = (event: FocusEvent<HTMLDivElement>): void => {
    onRowFocus(rowKey);
    const fromPointer = pointerFocusRef.current;
    pointerFocusRef.current = false;
    if (event.target === event.currentTarget && !fromPointer) {
      setDescriptionRevealed(true);
    }
  };

  // Focus leaving the row element — to another row, to a nested control, or out
  // of the tree — ends the reveal and re-arms Escape for the next visit. A
  // nested control's own blur is not the row's and changes nothing.
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    pointerFocusRef.current = false;
    if (event.target === event.currentTarget) {
      setDescriptionRevealed(false);
    }
  };

  // The label, in the type role its content calls for: the trigger of the
  // row's one description `Tooltip` below, in both of its forms.
  const labelElement =
    row.statement === undefined ? (
      <Text as="span" size="sm" truncate className="dg-waterfall__label">
        {oneLinePreview(label, LABEL_PREVIEW_LENGTH)}
      </Text>
    ) : (
      // A statement is monospace, and `dg-waterfall__label` carries the UI type
      // role, which would override that role for the whole string. The
      // truncation utility is composed directly instead, so the statement keeps
      // both its font and its single line.
      <Code size="sm" className="dg-truncate">
        {oneLinePreview(label, LABEL_PREVIEW_LENGTH)}
      </Code>
    );

  return (
    <div
      className={clsx(
        'dg-waterfall__row',
        expanded && 'dg-is-expanded',
        selected && 'dg-is-selected',
        rowFailed(row) && 'dg-is-error',
        row.lineageAmbiguous && 'dg-is-ambiguous',
        row.orphan !== undefined && 'dg-is-orphan',
      )}
      style={rowStyle}
      role="treeitem"
      aria-level={entry.depth + 1}
      aria-posinset={entry.position}
      aria-setsize={entry.setSize}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      aria-owns={expanded ? groupId : undefined}
      // The row's position in the visible list, which is how the keyboard
      // finds it again after a move (see `focusTreeRow`).
      data-dg-row={index}
      // The same sentence the tooltip carries, and for the same reason: the
      // row's visible text is a truncated label beside a handful of chips,
      // and the figure a reader most needs — how far into the window the call
      // started — is in neither. Naming the row explicitly also settles what
      // it is called: the tooltip's bubble is a descendant of the row, so a
      // name computed from the row's contents would read the label once as
      // itself and once again inside the description. Its label is bounded
      // (`NAME_LABEL_PREVIEW_LENGTH`); the whole of it is the description
      // below while the detail is shown.
      aria-label={accessibleName}
      aria-describedby={detailShown ? detailId : undefined}
      aria-keyshortcuts={canOpenSource ? OPEN_SOURCE_SHORTCUT : undefined}
      // The roving tab index: one row of the whole tree is in the Tab order.
      tabIndex={index === tabStopIndex ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {/* The identity column wraps: the label keeps its floor on its line and
          the chips after it move onto further lines, the source chip first,
          when the column cannot hold them all (`.dg-waterfall__name` and
          `.dg-waterfall__label-slot` in `../styles/components.css`), so the
          label never collapses and no chip reaches the time track. */}
      <Stack direction="horizontal" gap={1} align="center" wrap className="dg-waterfall__name">
        {expandable ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={
              expanded ? (
                <ChevronDown aria-hidden="true" className="dg-icon" />
              ) : (
                <ChevronRight aria-hidden="true" className="dg-icon" />
              )
            }
            // Named by what it opens: the nested calls, when there are any —
            // the detail then opens with them — and otherwise the full value.
            aria-label={
              hasChildren ? disclosureName(row, expanded) : fullValueDisclosureName(row, expanded)
            }
            aria-expanded={expanded}
            {...(controlledIds === '' ? {} : { 'aria-controls': controlledIds })}
            // Out of the Tab order: the treeitem is the row's only stop, and
            // ArrowRight/ArrowLeft on it are the keyboard route to the same
            // disclosure. Still a real button for the pointer.
            tabIndex={-1}
            onClick={handleToggle}
          />
        ) : null}
        {row.method === undefined ? null : (
          <Badge variant="outline" tone="neutral">
            {row.method}
          </Badge>
        )}
        <span className="dg-waterfall__label-slot">
          {/* One `Tooltip` in two forms, so the label has exactly one
                `role="tooltip"` at all times and is never remounted by the
                switch. For a pointer it is the primitive's own: hover opens
                it above the label. For the keyboard — the treeitem itself
                focused — this row holds it open (`open`), below the label,
                with the Shift+Enter hint where it applies; the primitive
                measures and places it like the hovered form, so it opens at
                the label and not at the viewport's corner, while the row's
                own handler keeps Escape. It describes nothing then
                (`describesTrigger`), because the treeitem's `aria-label`
                already carries the sentence and a reader must not hear it
                twice. While the row's full-value detail is shown below the
                label, the held bubble opens above it instead, so it never
                covers the value the reader expanded the row to see. */}
          <Tooltip
            className="dg-waterfall__tooltip"
            open={descriptionRevealed ? true : undefined}
            describesTrigger={!descriptionRevealed}
            placement={descriptionRevealed && !detailShown ? 'bottom' : 'top'}
            content={
              descriptionRevealed ? (
                <>
                  {description}
                  {canOpenSource ? (
                    <>
                      {' · '}
                      <Kbd keys={OPEN_SOURCE_KEYS} /> opens the source
                    </>
                  ) : null}
                </>
              ) : (
                description
              )
            }
          >
            {labelElement}
          </Tooltip>
        </span>
        {row.occurrenceCount === undefined ? null : (
          <Badge tone="info" variant="outline">
            {formatCountOf(row.occurrenceCount, CALL_NOUN)}
          </Badge>
        )}
        {row.statusCode === undefined ? null : (
          <Badge tone={httpStatusTone(row.statusCode)} className="dg-waterfall__status">
            {String(row.statusCode)}
          </Badge>
        )}
        {showsErrorBadge(row) ? (
          <Badge tone="danger" className="dg-waterfall__status">
            {formatStatusLabel('error')}
          </Badge>
        ) : null}
        {row.pending ? (
          // The state in a word, never in the icon or the tone alone — the
          // request table's own Pending chip, whose icon `Badge` hides from
          // assistive technology. Not a tooltip trigger: the row is the tree's
          // only stop, and the lower bound and the missing response are in the
          // row's description.
          <Badge
            tone="info"
            variant="outline"
            icon={<Hourglass className="dg-icon" />}
            className="dg-waterfall__status"
          >
            {pendingBadgeLabel(row)}
          </Badge>
        ) : null}
        {row.rowCount === undefined ? null : (
          <Badge tone="neutral" variant="outline">
            {formatCountOf(row.rowCount, ROW_NOUN)}
          </Badge>
        )}
        {row.orphan === undefined ? null : (
          // The word Timeline uses for the same verdict; the unresolved parent
          // is named in the row's description.
          <Badge tone="warning" variant="outline">
            Re-attached
          </Badge>
        )}
        {row.lineageAmbiguous ? (
          <Badge tone="warning" variant="outline">
            Inferred parent
          </Badge>
        ) : null}
        {row.childrenTruncated ? (
          <Badge tone="warning" variant="outline">
            Nested calls not drawn
          </Badge>
        ) : null}
        {/* Out of the Tab order for the same reason as the disclosure button;
              Shift+Enter on the row is its keyboard route. */}
        {source === undefined ? null : <SourceLink location={source} compact tabIndex={-1} />}
      </Stack>
      <div className="dg-waterfall__track">
        {/* A named picture of the call's timing: where in the window it
              began and how much of the window it spans, in words
              ({@link barDescription}) — or that its duration was not measured,
              where the bar marks only where the call began. The duration cell
              beside it prints the figure itself. */}
        <div
          className="dg-waterfall__bar dg-waterfall__bar--active"
          style={barStyle}
          role="img"
          aria-label={barDescription(row, scale.domainSpan)}
        />
      </div>
      {row.pending && row.measuredMs !== undefined ? (
        // A lower bound, said in words beside the figure: the call had been
        // outstanding this long when the capture ended, and was still going.
        // The pair is the row's third grid cell, so it takes the duration
        // column's class and placement.
        <Stack direction="horizontal" gap={1} align="center" className="dg-waterfall__duration">
          <Text as="span" size="xs" tone="muted">
            {LOWER_BOUND_LABEL}
          </Text>
          <DurationCell ms={row.measuredMs} severity="auto" size="sm" />
        </Stack>
      ) : (
        // The shown value, never the drawn one: an unmeasured duration reads
        // "n/a", with no severity colour and no lower-bound words to qualify it.
        <DurationCell
          ms={row.measuredMs}
          severity="auto"
          size="sm"
          className="dg-waterfall__duration"
        />
      )}
      {detailShown ? (
        // The whole label, exactly as it arrived — no collapsing, no second
        // cut — wrapping across the row's full width below its three cells.
        // Text only: nothing in it is focusable, so the treeitem stays the
        // row's one stop, and it describes the treeitem while it is shown.
        <div id={detailId} className="dg-waterfall__detail">
          <Text as="span" size="xs" tone="muted">
            {LABEL_FIELD_WORDS[rowLabelField(row)].heading}
          </Text>
          <Code size="sm" wrap>
            {label}
          </Code>
        </div>
      ) : null}
    </div>
  );
}

interface WaterfallBlocksProps {
  readonly blocks: readonly WindowBlock[];
  readonly context: RowContext;
}

/**
 * The mounted rows, nested: each row followed by the group of its mounted
 * children, and each continuation as the same indented group without a row
 * above it.
 *
 * A row's group is a `role="group"` its row owns; a continuation holds rows
 * whose owning row is before the window, so it is a plain container — its rows
 * still state their own level, position and set size, and belong to the tree.
 */
function WaterfallBlocks(props: WaterfallBlocksProps): ReactElement {
  const { blocks, context } = props;
  return (
    <>
      {blocks.map((block) => {
        if (block.kind === 'continuation') {
          return (
            <div
              key={`continuation-${String(block.depth)}`}
              className="dg-waterfall__children dg-waterfall__child-rows"
            >
              <WaterfallBlocks blocks={block.children} context={context} />
            </div>
          );
        }
        const { item, children } = block;
        const groupId =
          item.entry.expanded && children.length > 0
            ? `${context.groupIdPrefix}-${item.row.eventId}`
            : undefined;
        return (
          <Fragment key={item.entry.key}>
            <WaterfallRowItem item={item} groupId={groupId} context={context} />
            {groupId === undefined ? null : (
              <div
                id={groupId}
                role="group"
                className="dg-waterfall__children dg-waterfall__child-rows"
              >
                <WaterfallBlocks blocks={children} context={context} />
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The states that are not a chart
 *
 * Product vocabulary only: the kinds are named through the shared formatter,
 * and nothing below names anything from an inspected project.
 * ------------------------------------------------------------------------- */

/**
 * The message for a node whose kind filter shares no kind with the ones this
 * view draws: why nothing was requested, and which kinds a waterfall does draw,
 * listed from {@link WATERFALL_KINDS} so the sentence follows the catalog.
 *
 * @returns The message, as one plain-text sentence pair.
 */
function describeDisjointKindFilter(): string {
  const drawable = Array.from(WATERFALL_KINDS, formatKindLabel).join(', ');
  return `This node's kind filter selects no kind this view draws, so no captured records were requested. A waterfall draws these kinds: ${drawable}.`;
}

/** A captured record of any kind, drawn here or not. */
const CAPTURED_RECORD_NOUN: CountedNoun = countedNoun('captured record');

/**
 * The verdict on loaded items that hold nothing this view draws, in the form
 * that agrees with how many were loaded: one item is "it", several are "none
 * of them".
 */
const UNDRAWN_VERDICT: CountedNoun = countedNoun(
  'it is not a network or database call',
  'none of them is a network or database call',
);

/** The verb of "… is loaded" / "… are loaded", agreeing with the loaded count. */
const LOADED_VERB: CountedNoun = countedNoun('is', 'are');

/**
 * The message for pages that were searched, held nothing this view draws, and
 * are not the end of the result: how much was searched, stated against the
 * total when the service reported one, and that more remains.
 *
 * The count is of the SOURCE records resolved so far — the figure the footer's
 * "loaded … of …" uses — never of drawn rows, of which there are none. With a
 * total, the noun agrees with the total it follows ("1 of 30 captured
 * records"); without one, with the loaded count.
 *
 * @param loaded How many records the pages resolved so far hold.
 * @param total The total the service reported for the query, if it reported one.
 * @returns The message.
 */
function describeUndrawnPages(loaded: number, total: number | undefined): string {
  const counted =
    total === undefined
      ? formatCountOf(loaded, CAPTURED_RECORD_NOUN)
      : `${formatCount(loaded)} of ${formatCountOf(total, CAPTURED_RECORD_NOUN)}`;
  const verdict = pluralize(loaded, UNDRAWN_VERDICT);
  return `Loaded ${counted} so far, and ${verdict}. More records remain to be searched.`;
}

/* ---------------------------------------------------------------------------
 * Released pages, stated
 *
 * Pages released to stay within {@link RETAINED_ITEM_BUDGET} were loaded: the
 * calls on them were captured, and this view drew them. So they are stated as
 * released — with the positions of the result still held, and how many were
 * loaded before those — and never as absent from the capture. The copy is
 * chosen by pure functions of the held pages, so every branch is a plain
 * value a test can name.
 * ------------------------------------------------------------------------- */

/** What the footer and the no-rows state say about released pages. */
interface RetentionFacts {
  /** The noun the source's items are counted in. */
  readonly noun: CountedNoun;
  /** The zero-based position of the first held item. */
  readonly heldFrom: number;
  /** One past the position of the last held item. */
  readonly heldTo: number;
  /** How many items the held pages carry. */
  readonly heldCount: number;
  /** How many items the released pages carried. */
  readonly releasedCount: number;
  /** How many drawn items were released and are no longer drawn. */
  readonly releasedDrawnCount: number;
  /** The total the service reported, when it reported one. */
  readonly total: number | undefined;
  /** Whether rows nest across pages, so a release can lift the rows under it. */
  readonly nestsAcrossPages: boolean;
}

/** The verb of "… was released" / "… were released". */
const RELEASED_VERB: CountedNoun = countedNoun('was', 'were');

/** The verb of "… includes" / "… include". */
const INCLUDE_VERB: CountedNoun = countedNoun('includes', 'include');

/** The pronoun for the held items: "it" for one, "them" for several. */
const HELD_PRONOUN: CountedNoun = countedNoun('it', 'them');

/**
 * The facts about released pages, or `undefined` while nothing was released.
 *
 * @param holding What the view holds.
 * @param noun The noun the source's items are counted in.
 * @param total The total the service reported, when it reported one.
 * @param nestsAcrossPages Whether rows nest across pages (the flat path).
 */
function retentionFacts(
  holding: SpanHolding | RequestHolding | undefined,
  noun: CountedNoun,
  total: number | undefined,
  nestsAcrossPages: boolean,
): RetentionFacts | undefined {
  if (holding === undefined || holding.releasedItemCount === 0) {
    return undefined;
  }
  let heldFrom = Number.POSITIVE_INFINITY;
  let heldTo = Number.NEGATIVE_INFINITY;
  for (const page of holding.pages) {
    heldFrom = Math.min(heldFrom, page.offset);
    heldTo = Math.max(heldTo, page.offset + page.items.length);
  }
  if (!Number.isFinite(heldFrom) || !Number.isFinite(heldTo)) {
    return undefined;
  }
  return {
    noun,
    heldFrom,
    heldTo: Math.max(heldTo, heldFrom),
    heldCount: holding.heldItemCount,
    releasedCount: holding.releasedItemCount,
    releasedDrawnCount: holding.releasedDrawnCount,
    total: total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined,
    nestsAcrossPages,
  };
}

/** Which positions of the result are held: "positions 5,001–15,000 of 20,000". */
function describeHeldRange(facts: RetentionFacts): string {
  const first = facts.heldFrom + 1;
  const last = facts.heldTo;
  const range =
    last > first
      ? `positions ${formatCount(first)}–${formatCount(last)}`
      : `position ${formatCount(first)}`;
  return facts.total === undefined ? range : `${range} of ${formatCount(facts.total)}`;
}

/**
 * The footer's statement about released pages: what is held, how much was
 * loaded before it and released, and why.
 *
 * @example
 * // "Holding 10,000 spans (positions 5,001–15,000 of 20,000); the 5,000 spans
 * //  loaded before them were released to keep this view within 10,000 spans.
 * //  A call whose parent was released is drawn at the top level."
 */
function describeRetention(facts: RetentionFacts): string {
  const lifted = facts.nestsAcrossPages
    ? ' A call whose parent was released is drawn at the top level.'
    : '';
  return `Holding ${formatCountOf(facts.heldCount, facts.noun)} (${describeHeldRange(facts)}); the ${formatCountOf(facts.releasedCount, facts.noun)} loaded before ${pluralize(facts.heldCount, HELD_PRONOUN)} ${pluralize(facts.releasedCount, RELEASED_VERB)} released to keep this view within ${formatCountOf(RETAINED_ITEM_BUDGET, facts.noun)}.${lifted}`;
}

/** The title of the state for held pages with no call after calls were released. */
const RELEASED_WITHOUT_ROWS_TITLE = 'No calls held';

/**
 * The message for held pages that draw nothing after pages holding calls were
 * released: the calls were loaded and released, not missing.
 */
function describeReleasedWithoutRows(facts: RetentionFacts): string {
  return `The ${formatCountOf(facts.heldCount, facts.noun)} held (${describeHeldRange(facts)}) ${pluralize(facts.heldCount, INCLUDE_VERB)} no network or database call. The ${formatCountOf(facts.releasedCount, facts.noun)} loaded before ${pluralize(facts.heldCount, HELD_PRONOUN)} included calls, and ${pluralize(facts.releasedCount, RELEASED_VERB)} released to keep this view within ${formatCountOf(RETAINED_ITEM_BUDGET, facts.noun)}.`;
}

/** The statement of which rows the window mounts: "Rows 201–400 of 1,234". */
function describeRowWindow(mounted: RowWindow): string {
  return `Rows ${formatCount(mounted.start + 1)}–${formatCount(mounted.end)} of ${formatCount(mounted.total)}`;
}

/* ---------------------------------------------------------------------------
 * The empty state
 *
 * A successful result with no row to draw is not one situation but several,
 * and only one of them means "the capture holds no calls". An explicit
 * `limit: 0` is a count-only request (`nodes/query.ts`), an authored offset past
 * the end is an empty page rather than an error, and a page whose records were
 * all removed by this view's kind filter still holds captured evidence. Each is
 * stated as what it is, with the total the service reported, so an empty page
 * never reads as an empty capture. The copy is chosen by a pure function of
 * the paging counters, outside the component, so every branch is a plain value
 * a test can name.
 * ------------------------------------------------------------------------- */

/** The empty-capture sentence: nothing matched the query at all. */
const EMPTY_CAPTURE_MESSAGE = 'No network or database calls were captured for this interaction.';

/** The heading of the state for an explicit `limit: 0` request. */
const COUNT_ONLY_TITLE = 'Count only';

/** The heading of the state for a page that is empty while its query is not. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/*
 * The nouns each paged source counts its items in, agreed with their count
 * through `../utils/format` like every other counted word in this view.
 */
const SPAN_NOUN: CountedNoun = countedNoun('span');
const EVENT_NOUN: CountedNoun = countedNoun('event');
const REQUEST_GROUP_NOUN: CountedNoun = countedNoun('request group');

/** That the matched items are absent from this page: "it is not" for one, "none are" for more. */
const NOT_SHOWN_ON_PAGE: CountedNoun = countedNoun('it is not shown', 'none are shown');

/** What the empty state says: an optional heading and the sentence under it. */
interface EmptyPageCopy {
  readonly title: string | undefined;
  readonly message: string;
}

/** The heading of the empty-capture state: the short label above its sentence. */
const EMPTY_CAPTURE_TITLE = 'No calls';

/**
 * The copy for a query that matched nothing, and for the unpaged tree. The one
 * state whose absence is the capture's, so the one that carries the view's
 * glyph — identified by reference where the state is drawn.
 */
const EMPTY_CAPTURE_COPY: EmptyPageCopy = Object.freeze({
  title: EMPTY_CAPTURE_TITLE,
  message: EMPTY_CAPTURE_MESSAGE,
});

/** The paging facts the empty state is chosen from. */
interface EmptyPageFacts {
  /** The source the node's query reads. */
  readonly source: DataQuery['source'];
  /** The total the service reported for the whole query, or `undefined` for none. */
  readonly total: number | undefined;
  /** The offset the resolved page was requested at. */
  readonly offset: number;
  /** The page size in force: the node's own limit, or the default for an omitted one. */
  readonly limit: number;
  /** How many source items every loaded page holds together, before the kind filter. */
  readonly loadedItemCount: number;
}

/**
 * The noun a paged source counts its items in, or `undefined` for a source that
 * is not paged — the `trace` tree carries no total, so there is nothing to count.
 */
function pagedNounFor(source: DataQuery['source']): CountedNoun | undefined {
  switch (source) {
    case 'spans':
      return SPAN_NOUN;
    case 'events':
      return EVENT_NOUN;
    case 'requests':
      return REQUEST_GROUP_NOUN;
    default:
      return undefined;
  }
}

/**
 * The sentence for loaded items that the kind filter removed in full, with the
 * reported total when there is one. The verb and the verdict agree with the
 * loaded count; the noun with the figure it follows.
 */
function filteredPageMessage(
  noun: CountedNoun,
  loadedItemCount: number,
  total: number | undefined,
): string {
  const verb = pluralize(loadedItemCount, LOADED_VERB);
  const outcome = pluralize(loadedItemCount, UNDRAWN_VERDICT);
  if (total === undefined) {
    return `${formatCountOf(loadedItemCount, noun)} ${verb} loaded, and ${outcome}; no total was reported for this query.`;
  }
  return `${formatCount(loadedItemCount)} of the ${formatCountOf(total, noun)} that matched this query ${verb} loaded, and ${outcome}.`;
}

/**
 * The empty state for a successful result that drew no row.
 *
 * In order: a count-only request (`limit: 0`) is named as one, with its total
 * when reported; a total of zero — or no total at all, at the first offset,
 * with nothing loaded — is the empty capture. With no total reported, loaded
 * items the kind filter removed are counted, and otherwise the state says where
 * the page starts. With a positive total, a page starting at or past it says
 * where it starts and how many items matched; inside it, loaded items the kind
 * filter removed are counted against the total, and a page with nothing on it
 * says how many items matched. A reported total that is not a whole,
 * non-negative number is treated as not reported, so a malformed counter can
 * never produce a figure.
 *
 * @example
 * describeEmptyPage({ source: 'spans', total: 42, offset: 0, limit: 0, loadedItemCount: 0 });
 * // → { title: 'Count only',
 * //     message: 'This view requests a count without rows: 42 spans matched its query.' }
 *
 * @param facts The result's source, total, offset, page size and loaded item count.
 * @returns The heading, when the state has one, and the message.
 */
function describeEmptyPage(facts: EmptyPageFacts): EmptyPageCopy {
  const noun = pagedNounFor(facts.source);
  if (noun === undefined) {
    return EMPTY_CAPTURE_COPY;
  }
  const { offset, limit, loadedItemCount } = facts;
  const total =
    facts.total !== undefined && Number.isSafeInteger(facts.total) && facts.total >= 0
      ? facts.total
      : undefined;

  if (limit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        total === undefined
          ? 'This view requests a count without rows, and no total was reported for its query.'
          : `This view requests a count without rows: ${formatCountOf(total, noun)} matched its query.`,
    };
  }
  if (total === 0 || (total === undefined && offset === 0 && loadedItemCount === 0)) {
    return EMPTY_CAPTURE_COPY;
  }
  if (total === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message:
        loadedItemCount > 0
          ? filteredPageMessage(noun, loadedItemCount, undefined)
          : `This page starts at position ${formatCount(offset + 1)} and holds no ${noun.other}; no total was reported for this query.`,
    };
  }
  if (offset >= total) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCountOf(total, noun)} that matched this query.`,
    };
  }
  return {
    title: EMPTY_PAGE_TITLE,
    message:
      loadedItemCount > 0
        ? filteredPageMessage(noun, loadedItemCount, total)
        : `${formatCountOf(total, noun)} matched this query, but ${pluralize(total, NOT_SHOWN_ON_PAGE)} on this page.`,
  };
}

/* ---------------------------------------------------------------------------
 * The component
 * ------------------------------------------------------------------------- */

/** What the panel host hands a `waterfall` node. */
export interface WaterfallProps {
  /**
   * The validated panel node this component renders. Its `query` decides what
   * is drawn and its `id` is the identity reported to
   * the `onExpand` report of the ambient `PanelActions`.
   */
  node: WaterfallNode;
  /** Appended to the block's class list, last, so a host can place the view. */
  className?: string | undefined;
}

/** No row expanded — the state every render starts from. */
const NO_EXPANDED_IDS: ReadonlySet<string> = new Set<string>();

/** Any resolved query, read for its status and paging counters alone. */
type AnyQueryResult = UseQueryResult<unknown>;

/**
 * The request and dependency waterfall of one interaction.
 *
 * Resolves the node's query through the ambient `DataProvider`, folds each
 * page into rows nested by ancestry and positioned by their offset from the
 * first call — holding at most {@link RETAINED_ITEM_BUDGET} source items and
 * mounting at most {@link WATERFALL_ROW_BUDGET} rows — and renders its states
 * in this precedence: an unsupported source (no query issued), a kind filter
 * that selects nothing drawable (no query issued), loading and error while
 * nothing has been loaded yet, held pages with nothing drawable after pages
 * holding calls were released, pages searched with nothing drawable while more
 * remain (with "Load more"), the empty result, and the chart. A page that
 * arrived while rows are already on screen degrades to a footer notice rather
 * than replacing the view, so paging never blanks a chart the developer is
 * reading — and a failure is still reported as a failure, with a retry, never
 * as a successful empty result.
 *
 * @param props The node to draw and an optional class name.
 */
export function Waterfall(props: WaterfallProps): ReactElement {
  const { node, className } = props;
  const actions = usePanelActions();
  const nodeId = node.id;
  const baseQuery = node.query;
  const domIdSeed = useId();

  // The session is part of the page sequence's identity: pages another session
  // answered are another capture's evidence (see `queryIdentity`).
  const sessionId = usePanelSessionId();
  const identity = useMemo(() => queryIdentity(baseQuery, sessionId), [baseQuery, sessionId]);
  const [paging, setPaging] = useState<PagingState>(() =>
    initialPaging(identity, authoredBaseOffset(baseQuery)),
  );
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(NO_EXPANDED_IDS);
  // The panel's one shared selection (the host's under a panel, this view's
  // own outside one): the row standing for the selected event is marked, so
  // this chart agrees with every other view of the same trace.
  const { selection, markSelected } = useViewSelection();
  // The row that last received focus, by path key. What actually holds the tab
  // stop is derived from it on every render (`resolveTabStop`), so a collapse,
  // a new page or a moved window can never leave the tree without one.
  const [activeRowKey, setActiveRowKey] = useState<string | undefined>(undefined);
  // Where the mounted window of rows starts, for one page-sequence identity:
  // a different query or session starts over at the first row, derived below
  // rather than reset in an effect, exactly as the pages are.
  const [rowWindowState, setRowWindowState] = useState<{
    readonly identity: string;
    readonly start: number;
  }>(() => ({ identity, start: 0 }));
  // The tree element, which the keyboard focuses rows inside, and the row a
  // keyboard move is waiting to focus once the window it moved has mounted it.
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocusKeyRef = useRef<string | undefined>(undefined);

  // Accumulated pages belong to one page-sequence identity. When the node's
  // query — its authored offset included — or the panel's session changes, the
  // pages held in state are simply not used and the request returns to the
  // authored base offset: derived here rather than reset in an effect, so the
  // first render after the change already asks for the new sequence's first
  // page and draws nothing the old one accumulated.
  const paged =
    paging.identity === identity ? paging : initialPaging(identity, authoredBaseOffset(baseQuery));
  const carried = paged.loaded;
  const offset = paged.offset;

  const filterKinds = baseQuery.filter?.kinds;
  const includedKinds = useMemo(() => resolveIncludedKinds(filterKinds), [filterKinds]);

  const spanQuery = useMemo(() => narrowSpanListQuery(baseQuery, offset), [baseQuery, offset]);
  const requestsQuery = useMemo(() => narrowRequestsQuery(baseQuery, offset), [baseQuery, offset]);

  // A kind filter that shares no kind with what this view draws can never
  // yield a row — not on this page and not on any later one — so the query is
  // held back rather than issued and paged through to an empty answer; the
  // body states why instead (see `resolveIncludedKinds`).
  const kindsSelectable = includedKinds.size > 0;

  // At most one of the two carries a query; the other resolves nothing, and a
  // source the catalog entry does not list leaves both without one.
  const spanResult = useQuery(spanQuery, { enabled: kindsSelectable });
  const requestsResult = useQuery(requestsQuery, { enabled: kindsSelectable });

  const spanPage = spanResult.data;
  const requestsPage = requestsResult.data;

  // What is held: the carried pages, with the page this render resolved folded
  // in (see `holdPage`). Only the new page and the rows it can move are
  // resolved; "Load more" carries this result forward as it is.
  const loaded = useMemo<LoadedPages>(() => {
    if (spanQuery !== undefined) {
      const holding = carried.kind === 'spans' ? carried.holding : undefined;
      if (spanPage === undefined) {
        return holding === undefined ? NO_PAGES : { kind: 'spans', holding };
      }
      return {
        kind: 'spans',
        holding: holdPage(
          holding,
          EMPTY_SPAN_INDEX,
          offset,
          spanPage,
          (index, added, addedSeq, released, releasedThroughSeq) =>
            foldSpanPage(index, includedKinds, added, addedSeq, released, releasedThroughSeq),
        ),
      };
    }
    if (requestsQuery !== undefined) {
      const holding = carried.kind === 'requests' ? carried.holding : undefined;
      if (requestsPage === undefined) {
        return holding === undefined ? NO_PAGES : { kind: 'requests', holding };
      }
      return {
        kind: 'requests',
        holding: holdPage(
          holding,
          EMPTY_REQUEST_INDEX,
          offset,
          requestsPage,
          (index, added, addedSeq, released, releasedThroughSeq) =>
            foldRequestPage(index, includedKinds, added, addedSeq, released, releasedThroughSeq),
        ),
      };
    }
    return NO_PAGES;
  }, [spanQuery, spanPage, requestsQuery, requestsPage, carried, offset, includedKinds]);

  const holding = holdingOf(loaded);
  const summary = useMemo(() => summariseLoaded(loaded), [loaded]);
  // How many source items have been resolved so far, released pages included,
  // which is what "loaded of total" compares against — the drawn row count is
  // a different figure, because records of other kinds are filtered out and
  // groups expand into occurrences.
  const loadedItemCount = holding?.loadedItemCount ?? 0;
  const unverifiedOrphans = (holding?.releasedItemCount ?? 0) > 0;

  // Every row a reader can reach, in reading order, and the window of it the
  // tree mounts.
  const visible = useMemo(() => flattenLoaded(loaded, expandedIds), [loaded, expandedIds]);
  const requestedStart = rowWindowState.identity === identity ? rowWindowState.start : 0;
  const mounted = windowRows(visible.rows.length, requestedStart, WATERFALL_ROW_BUDGET);

  const result: AnyQueryResult | undefined =
    spanQuery !== undefined ? spanResult : requestsQuery !== undefined ? requestsResult : undefined;
  // Only a cursor past the page it answered is a next page, and a count-only
  // request (`limit: 0`) never has one — the rule every paged view follows. A
  // count-only or stalled answer therefore reaches the empty-page copy below,
  // never a "Load more" that would re-request the page already searched.
  const reportedNextOffset = result?.nextOffset;
  const nextOffset =
    reportedNextOffset !== undefined && reportedNextOffset > offset && baseQuery.limit !== 0
      ? reportedNextOffset
      : undefined;

  // One scale for the bars and the axis, over the held window. The axis
  // chooses its ticks from this scale alone (see `WaterfallAxis`).
  const scale = useMemo(
    () => createTimeScale([summary.viewStart, summary.viewEnd], [0, PERCENT_RANGE]),
    [summary.viewStart, summary.viewEnd],
  );

  // A row object for each mounted row, and the mounted rows nested back into
  // their groups.
  const blocks = useMemo(() => {
    const items: WindowItem[] = [];
    for (let index = mounted.start; index < mounted.end; index += 1) {
      const entry = visible.rows[index];
      if (entry !== undefined) {
        items.push({ entry, row: buildRow(entry, summary.viewStart, unverifiedOrphans), index });
      }
    }
    return nestWindow(items);
  }, [visible, mounted.start, mounted.end, summary.viewStart, unverifiedOrphans]);

  const tabStopIndex = resolveTabStop(loaded, visible, mounted, activeRowKey);
  const openSource = actions?.onOpenSource;

  // A row a keyboard move paged to is focused once the moved window has
  // mounted it; the move is spent either way, so it can never steal focus
  // from a later render.
  useLayoutEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (key === undefined) {
      return;
    }
    pendingFocusKeyRef.current = undefined;
    const index = visible.indexByKey.get(key);
    if (index !== undefined && windowContains(mounted, index)) {
      focusTreeRow(treeRef.current, index);
    }
  });

  const handleSelect = useCallback(
    (row: WaterfallRow): void => {
      const ref = { eventId: row.eventId, spanId: row.spanId, traceId: row.traceId };
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  const handleToggle = useCallback(
    (row: WaterfallRow): void => {
      const willExpand = !expandedIds.has(row.eventId);
      const next = new Set(expandedIds);
      if (willExpand) {
        next.add(row.eventId);
      } else {
        next.delete(row.eventId);
      }
      setExpandedIds(next);
      actions?.onExpand?.(nodeId, row.eventId, willExpand);
    },
    [actions, expandedIds, nodeId],
  );

  const handleNavigate = useCallback(
    (from: number, move: RowMove): void => {
      const target = moveTarget(visible, from, move);
      const entry = target === undefined ? undefined : visible.rows[target];
      if (target === undefined || entry === undefined) {
        return;
      }
      if (windowContains(mounted, target)) {
        focusTreeRow(treeRef.current, target);
        return;
      }
      // Past the window's edge: move the window to the aligned window holding
      // the target — the one Previous/Next would reach — and focus it there.
      pendingFocusKeyRef.current = entry.key;
      setActiveRowKey(entry.key);
      setRowWindowState({ identity, start: windowStartFor(target, WATERFALL_ROW_BUDGET) });
    },
    [identity, mounted, visible],
  );

  const handleShowPreviousRows = useCallback((): void => {
    setRowWindowState({ identity, start: previousWindowStart(mounted) });
  }, [identity, mounted]);

  const handleShowNextRows = useCallback((): void => {
    setRowWindowState({ identity, start: nextWindowStart(mounted) });
  }, [identity, mounted]);

  const handleLoadMore = useCallback((): void => {
    if (nextOffset === undefined) {
      return;
    }
    // The page on screen is already folded into `loaded`; carry that forward
    // rather than folding it again.
    setPaging({ identity, offset: nextOffset, loaded });
  }, [identity, loaded, nextOffset]);

  const rowContext = useMemo<RowContext>(
    () => ({
      scale,
      viewStart: summary.viewStart,
      groupIdPrefix: domIdSeed,
      selection,
      tabStopIndex,
      onRowFocus: setActiveRowKey,
      onToggle: handleToggle,
      onSelect: handleSelect,
      onNavigate: handleNavigate,
      onOpenSource: openSource,
    }),
    [
      scale,
      summary.viewStart,
      domIdSeed,
      selection,
      tabStopIndex,
      handleToggle,
      handleSelect,
      handleNavigate,
      openSource,
    ],
  );

  // The query the active hook was handed — the node's query at the offset this
  // render requested — which is exactly what a failure reports as the failing
  // query and what its retry asks again. The authored query stands in only when
  // neither hook was handed one, which is the unsupported source, and that
  // branch reports the authored query itself.
  const activeQuery: DataQuery = spanQuery ?? requestsQuery ?? baseQuery;
  const hasRows = summary.rowCount > 0;
  // Whether earlier pages of this sequence were resolved and are held in
  // state. The full-view loading and error states describe a sequence that
  // has produced nothing yet; once a page is carried, a page in flight or a
  // page that failed is the NEXT page, and is reported as such.
  const hasCarried = carried.kind !== 'none';
  const itemNoun = pagedNounFor(baseQuery.source) ?? CAPTURED_RECORD_NOUN;
  const retention = retentionFacts(holding, itemNoun, result?.total, loaded.kind === 'spans');

  let body: ReactNode;
  if (result === undefined) {
    // A validated specification cannot reach this state: the node catalog
    // constrains a waterfall node to the sources handled above, and the same
    // entry was consulted before any query was built, so none was issued. A
    // host that rendered an unvalidated node — one naming `events`, `trace` or
    // any other source — still gets a stated failure rather than an empty
    // chart that would read as "nothing was captured". Nothing was asked, so
    // the authored query is what is shown and no retry is offered; the wording
    // is the shared contract's, composed from this node type's catalog entry.
    body = (
      <div className="dg-waterfall__error">
        <ErrorState {...unsupportedQueryProps(node.type, baseQuery)} />
      </div>
    );
  } else if (!kindsSelectable) {
    // The node's own kind filter excludes every kind this view draws, so no
    // page could ever hold a row: nothing was requested, and no "Load more" is
    // offered for a search that cannot find anything.
    body = (
      <div className="dg-waterfall__empty">
        <EmptyState title="No call kind selected" message={describeDisjointKindFilter()} />
      </div>
    );
  } else if (result.status === 'loading' && !hasRows && !hasCarried) {
    body = (
      <div className="dg-waterfall__loading">
        <LoadingState variant="chart" label="Loading captured calls…" />
      </div>
    );
  } else if (result.status === 'error' && !hasRows && !hasCarried) {
    // Nothing is on screen yet, so the failure is the view's: the shared
    // contract supplies the title, the generic lead with the provider's cause,
    // the hint, the code, the failing query in the one format every node
    // prints, the technical details, the announcement and the retry.
    body = (
      <div className="dg-waterfall__error">
        <ErrorState {...queryFailureProps(result, activeQuery)} />
      </div>
    );
  } else if (!hasRows && retention !== undefined && retention.releasedDrawnCount > 0) {
    // The pages held now draw nothing, but pages released before them did:
    // those calls were captured and loaded, so neither "nothing was captured"
    // nor "none of them is a call" may be said. The statement names what is
    // held and what was released, and the way on stays in reach.
    const loadingMore = result.status === 'loading';
    const failedMore = result.status === 'error';
    body = (
      <>
        <div className="dg-waterfall__empty">
          <EmptyState
            title={RELEASED_WITHOUT_ROWS_TITLE}
            message={describeReleasedWithoutRows(retention)}
            action={
              nextOffset === undefined && !loadingMore ? undefined : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              )
            }
          />
        </div>
        {failedMore ? (
          <div className="dg-waterfall__error">
            <ErrorState {...queryFailureProps(result, activeQuery)} />
          </div>
        ) : null}
      </>
    );
  } else if (
    !hasRows &&
    (nextOffset !== undefined || (hasCarried && result.status !== 'success'))
  ) {
    // Every record loaded so far is of a kind this view does not draw, and
    // the search is not over: the service reported another page, or the next
    // page is in flight or failed behind pages already searched (`useQuery`
    // reports no `nextOffset` while a page is loading). Saying "nothing was
    // captured" here would be a conclusion the evidence does not support, and
    // withholding "Load more" would hide the page that holds the calls.
    const loadingMore = result.status === 'loading';
    const failedMore = result.status === 'error';
    body = (
      <>
        <div className="dg-waterfall__empty">
          <EmptyState
            title="No network or database calls loaded yet"
            message={describeUndrawnPages(loadedItemCount, result.total)}
            action={
              failedMore ? undefined : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              )
            }
          />
        </div>
        {failedMore ? (
          // The view scope, deliberately: no row is drawn above this failure,
          // so the page scope's "the rows already shown are unaffected" would
          // describe rows that are not there. The statement above says what
          // was searched, and the query shown is the page that failed, at the
          // offset it was requested at.
          <div className="dg-waterfall__error">
            <ErrorState {...queryFailureProps(result, activeQuery)} />
          </div>
        ) : null}
      </>
    );
  } else if (!hasRows) {
    const emptyCopy = describeEmptyPage({
      source: baseQuery.source,
      total: result.total,
      offset,
      limit: baseQuery.limit ?? DATA_QUERY_DEFAULT_LIMIT,
      loadedItemCount,
    });
    body = (
      <div className="dg-waterfall__empty">
        <EmptyState
          title={emptyCopy.title}
          message={emptyCopy.message}
          icon={
            emptyCopy === EMPTY_CAPTURE_COPY ? <ChartNoAxesGantt className="dg-icon" /> : undefined
          }
        />
      </div>
    );
  } else {
    const loadingMore = result.status === 'loading';
    const failedMore = result.status === 'error';
    const total = result.total;
    // Two different figures in two different units: the calls drawn, and the
    // source items resolved against the service's total. Each names its own
    // noun — "4 calls · loaded 9 of 9 spans" — so the second is never read as
    // a count of calls.
    const drawnText = formatCountOf(summary.rowCount, CALL_NOUN);
    const countText =
      total === undefined
        ? drawnText
        : `${drawnText} · loaded ${formatCount(loadedItemCount)} of ${formatCountOf(
            total,
            itemNoun,
          )}`;
    // More visible rows than one window mounts: say which are mounted, and
    // offer the windows either side of it.
    const windowed = mounted.total > mounted.budget;
    body = (
      <>
        {/* The axis and the tree scroll together in one viewport: the
            stylesheet floors every time track at the design strip, so a panel
            narrower than a row's minimum scrolls here horizontally, and both
            children share one inline size, so the strip lines up with the
            tracks while scrolled as it does unscrolled. The viewport carries
            no role and no tab stop — the tree stays the one composite widget —
            and the footer below stays outside it, so the counts and the paging
            controls never scroll away. */}
        <div className="dg-waterfall__viewport">
          <WaterfallAxis scale={scale} origin={summary.viewStart} windowMs={summary.windowMs} />
          <div
            ref={treeRef}
            className="dg-waterfall__rows"
            role="tree"
            aria-label="Captured calls, nested under the call that was waiting on them"
          >
            <WaterfallBlocks blocks={blocks} context={rowContext} />
          </div>
        </div>
        <Stack
          direction="horizontal"
          gap={2}
          align="center"
          justify="between"
          wrap
          className="dg-waterfall__footer"
        >
          <Text size="xs" tone="muted">
            {summary.truncated ? `${countText} · some nested calls were not drawn` : countText}
          </Text>
          {windowed ? (
            <Stack direction="horizontal" gap={2} align="center" wrap>
              <Text size="xs" tone="muted">
                {describeRowWindow(mounted)}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                disabled={mounted.before === 0}
                onClick={handleShowPreviousRows}
              >
                Previous rows
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={mounted.after === 0}
                onClick={handleShowNextRows}
              >
                Next rows
              </Button>
            </Stack>
          ) : null}
          {retention === undefined ? null : (
            <Text size="xs" tone="muted">
              {describeRetention(retention)}
            </Text>
          )}
          {/* Kept on screen while the next page is in flight, disabled and
              saying so: `useQuery` reports no `nextOffset` while a page loads,
              and rows on screen with a page loading can only mean that page is
              the NEXT one — so the control must not vanish mid-request. */}
          {nextOffset === undefined && !loadingMore ? null : (
            <Button variant="secondary" size="sm" disabled={loadingMore} onClick={handleLoadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </Stack>
        {failedMore ? (
          // The next page failed, the rows above it did not: the page scope
          // says so in its title and lead, and its retry re-requests that
          // same page, at the offset it failed at.
          <div className="dg-waterfall__error">
            <ErrorState {...queryFailureProps(result, activeQuery, { scope: 'page' })} />
          </div>
        ) : null}
      </>
    );
  }

  return <div className={clsx('dg-waterfall', className)}>{body}</div>;
}
