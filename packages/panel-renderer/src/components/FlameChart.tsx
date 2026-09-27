/**
 * `FlameChart` — nested SPAN TIMING drawn as an icicle, plus the readable list
 * that carries the same hierarchy in text (node catalog type `flame`).
 *
 * ## WHAT THIS VIEW IS, AND WHAT IT IS NOT
 *
 * This component is the product's stated equivalent of a flame graph, not a
 * flame graph: the product has no profiler, samples no call stacks and measures
 * no CPU time, so what a reader sees here is the **recorded nesting of
 * measured spans** — a bar per captured operation, its width its measured
 * duration, its children beneath it. Nothing in this file, its labels, its
 * descriptions or its comments claims otherwise, and the note the component
 * renders above the chart says so on screen, because a view named after a
 * sampling visualization owes its reader that sentence.
 *
 * The question it answers is the one a duration alone cannot: whether a slow
 * operation was slow *itself* or was waiting on something nested inside it.
 * That is what the second number on every frame is for — the frame's own time,
 * its measured duration minus the time its children occupied — and it is why
 * depth and relative width, rather than any visual flourish, are the whole
 * message.
 *
 * ## ORIENTATION: ICICLE, NOT A BOTTOM-UP FLAME
 *
 * The trace root is the top row and its children hang below it, which is the
 * icicle orientation. Depth decides the row (`../utils/scale`'s `rowY`), time
 * is the horizontal axis (`timeScaleForTrace` over the trace's own window), so
 * a parent always sits above the children it contains and a reader follows
 * causality downward. Siblings of one depth whose drawn bars overlap — parallel
 * calls, a record re-attached to the root inside another child's window, or
 * short operations widened to the minimum visible width — are packed into
 * extra sub-rows of that depth rather than painted over one another, and every
 * sub-row of a depth still sits above the next depth.
 *
 * A depth takes at most `MAX_DEPTH_ROWS` (3) rows. A depth crowded past that —
 * hundreds of near-simultaneous renders of one commit — keeps its longest
 * operations as bars on `MAX_DEPTH_SUB_ROWS` (2) sub-rows and gathers the rest
 * into outlined "+N" marks on ONE row beneath them, so a crowded browser side
 * can never push the deeper levels (the request's server work, its queries)
 * hundreds of rows out of the viewport. A note says how many operations were
 * gathered, and every one of them is still a row of the tree beneath the
 * chart.
 *
 * ## A FIXED LOGICAL CANVAS, SIZED BY CSS
 *
 * The icicle is drawn in one fixed coordinate space: a `viewBox`
 * `CHART_VIEWBOX_WIDTH` (1 000) user units wide — `../utils/scale`'s constant,
 * shared with the timeline — and exactly as tall as the rows it draws. The
 * `<svg>` declares `width="100%"` and its logical height, and
 * `preserveAspectRatio="xMinYMin meet"`, so the stylesheet sizes it
 * relationally to its container and the drawing scales uniformly — a glyph is
 * never stretched sideways — anchored at its top-left corner. Nothing here
 * reads the size of any element: every frame's `x` and width are its share of
 * the trace's window in per-mille of the canvas, every row is at the scale's
 * own pitch, and the whole drawing is a pure function of the data, identical in
 * a browser and in a test DOM that lays nothing out. Row packing (above) reads
 * the bars at those logical widths.
 *
 * A frame's label is fitted to its frame in the same logical units
 * (`../utils/format`'s `fitTextToWidth`), by the deterministic advance
 * estimate of the label's type role — `.dg-flame__frame-label` is set in
 * `monoSm`, eleven units tall — which errs towards "does not fit": the longest
 * grapheme prefix that fits, ending in an ellipsis, or no label at all. The
 * label and its frame scale together, so a fit decided once holds at every
 * panel width. A character budget cannot do this — glyph advances differ, an
 * emoji is about two columns wide — and a budget that is wrong by one glyph
 * paints the ellipsis past the frame, where nobody sees it.
 *
 * ## THE CHART IS A FIGURE; THE LIST IS THE INTERFACE
 *
 * The `<svg>` is `role="figure"` with a text alternative summarising the trace,
 * and each frame and "+N" mark in it is a `role="img"` named by its full
 * description — the sentence its tree row is named by — so the information a
 * pointer gets on hover is also in the accessibility tree for a screen reader
 * browsing the picture. The axis and the visible labels, which repeat those
 * names, are hidden from assistive technology. The frames are not focusable.
 * Beneath the canvas, **every frame** is a row
 * of an indented `role="tree"`: its name on a real `Button`, its kind, its
 * tier, its measured duration, its own time, a source chip where the span
 * resolved to a place in the project, and a disclosure control where its
 * subtree can fold. That tree is the keyboard path, the screen-reader path and
 * the path a test asserts against (accessibility takes precedence over visual
 * fidelity), and it is complete: a frame the chart draws is a row the tree
 * carries, and a frame neither shows is named in a note rather than dropped.
 *
 * The tree is ONE tab stop with a roving tab index, as the waterfall's is —
 * the arrow keys move between rows, open and fold subtrees, Enter selects and
 * Shift+Enter opens the source — and it is BOUNDED and PAGED: of the drawn
 * window's rows, one page of at most `TREE_ROW_BUDGET` (60) is in the
 * document, the page that holds the tab stop. "Previous rows" and "Next rows"
 * beneath the tree turn that page by pointer or keyboard, a polite statement
 * beside them says which rows are shown — "Rows 61–120 of 2,000 in this list
 * are shown." — and a key that steps past either edge of the page turns it
 * too, so every row of the drawn window, and every source chip on one, is
 * reachable without the keyboard. Each row still states its level and its
 * position among all of its siblings. Nothing about it is measured. See
 * `FlameFrameTree` for both.
 *
 * ## EVIDENCE IS NEVER DROPPED, AND NEVER QUIETLY
 *
 * The `trace` source answers with a whole {@link TraceTree}, not a page, so
 * there is no server page to load and no honest way to show part of a trace
 * silently. Every reduction is reported above the chart.
 *
 * ## THE DRAWN-ROW BUDGET IS ABSOLUTE
 *
 * A capture can hold far more operations than one SVG can carry: a hundred
 * thousand frames is a hundred thousand bars, labels and handlers, and a
 * DevTools panel that mounts them freezes. So the walk covers the whole trace,
 * but the icicle — and the tree beneath it — never holds more than
 * `../utils/scale`'s `MAX_DRAWN_ROWS` operations at once, however often the
 * reader asks for more. Asking for more MOVES a window of at most that many
 * operations over the ordered walk (`windowRows`) instead of growing it:
 * "Previous operations" and "Next operations" page it, the tree's arrow keys,
 * Home and End cross into the neighbouring window when they step past an edge,
 * and a selection made in another view pages to the window holding its frame.
 * The window is stated beside its controls — "Operations 2,001–4,000 of 9,500
 * are drawn; 2,000 before and 5,500 after are not." — in a polite live region,
 * so every page is announced, and it returns to the first window whenever the
 * node's query changes. Folding a subtree shortens the walk the window pages
 * over; it never un-draws anything silently.
 *
 * The tree pages the drawn window's rows the same way, one level down: its
 * page is a `windowRows` window of `TREE_ROW_BUDGET` rows over the drawn
 * window's frames, and a newly drawn window or a changed query opens it on
 * the first page again (or on the page of the tab stop a key or a selection
 * carried there).
 *
 * ## EVERY PAGE SAYS WHERE IT SITS
 *
 * A window or a page of rows that opens below the root holds operations whose
 * parents an earlier page shows, and on their own they read as rows with no
 * place in the hierarchy. So every such page carries its CONTEXT — every
 * ancestor of its first operation, which (the walk being pre-order) is every
 * operation before the page that any of its operations hangs from — marked as
 * context and never as page content:
 *
 *   - the icicle draws the drawn window's context as a band of its own at the
 *     top of the canvas, one row per ancestor, outermost first, each bar
 *     labelled "Context: …", titled as context and filled from outside the
 *     span-kind scale (`data-flame-context` marks it); a polite statement
 *     beside the window's controls and the canvas's text alternative name the
 *     chain; activating a context bar selects it, which pages to the window
 *     that draws it;
 *   - the tree names the context of its page of rows in a captioned list
 *     above its scroll container — outside the tree, so it is no row of the
 *     page, holds no tab stop and changes no level or position the tree
 *     states — laid out as tree rows are, indented by depth.
 *
 * The band holds at most one bar per level the layout draws, so the drawing
 * stays bounded: at most `MAX_DRAWN_ROWS` window frames and `MAX_ICICLE_DEPTH`
 * context bars.
 *
 * Two reductions are PARTIAL RESULTS — part of the trace is not held here at
 * all — and share one notice with the "Partial result" badge the timeline
 * uses. A trace the correlator itself bounded says so and gives the refine
 * route — narrowing the query or capturing a shorter interaction — because
 * nothing more of it is held in memory to show. A trace that holds more
 * operations than its own node count declares is walked only as far as that
 * count (and never less than one window), and the notice says the rest is not
 * listed, rather than walking a malformed tree without limit.
 *
 * The rest are notes: a subtree past the depth this layout draws, a subtree
 * folded for legibility, a record re-attached to the root because its parent
 * never arrived (marked `dg-is-orphan` on its row), a span id the correlator
 * saw twice, and a trace that arrived with more than one root.
 *
 * ## DATA IN, INTENT OUT
 *
 * Data arrives only through the node's `DataQuery`, resolved by `../host/useQuery`
 * against the host's `DataProvider`; interactions leave only through
 * `../host/PanelActions`. This component opens no socket, calls no `fetch` and
 * knows no URL (`docs/ARCHITECTURE.md`, "The renderer contract"). Selecting a
 * frame reports a `PanelEventRef`; a source chip, and Shift+Enter on its row,
 * forward its location field for field; folding a subtree reports `onExpand`
 * with this node's id.
 *
 * The selected frame is not this view's to keep. It is the panel host's one
 * shared selection, read through `useViewSelection` and matched with
 * `matchesPanelSelection` (by event id, or by the same trace and span), so the
 * frame and the timeline bar of one span are always marked together and a
 * selection made in either moves both. Outside a host the view falls back to
 * its own last activation.
 *
 * ## APPEARANCE IS A CLASS CONTRACT
 *
 * Every colour, length, font and radius lives in `../styles/components.css` and
 * resolves to a `--dg-*` token. This file contributes two kinds of inline value
 * and no others: the `--dgc-*` custom properties the stylesheet consumes with a
 * token fallback, and unitless SVG geometry, which is the permitted structural
 * form. The classes:
 *
 *   `dg-flame`                    the block
 *   `dg-flame__note`              a provenance or honesty note above the chart
 *   `dg-flame__viewport`          the scroll container the canvas sits in,
 *                                 which caps a tall drawing's block size
 *   `dg-flame__canvas`            the `<svg>`, sized relationally to its
 *                                 container over its fixed `viewBox`
 *   `dg-flame__axis`              the time axis group
 *   `dg-flame__axis-tick`         one tick rule
 *   `dg-flame__axis-label`        one tick label
 *   `dg-flame__row`               one drawn row of the icicle: a depth, one
 *                                 sub-row of a depth whose siblings overlap,
 *                                 or the overflow row beneath a crowded depth
 *   `dg-flame__frame`             one frame, filled from `--dgc-frame-color`
 *   `dg-flame__frame-label`       the label drawn inside a frame, inked from
 *                                 `--dgc-frame-ink` (the ink paired with the
 *                                 frame's fill, so the label clears 4.5:1)
 *   `dg-flame__overflow`          one "+N" mark on an overflow row: the
 *                                 operations of a crowded depth its sub-rows
 *                                 could not hold, gathered over their extent
 *   `dg-flame__overflow-label`    the "+N" count drawn inside a mark, when it
 *                                 fits whole
 *   `dg-flame__equivalent`        the text equivalent: a paged tree in the
 *                                 shared scroll viewport (`dg-virtual-viewport`,
 *                                 whose block size the stylesheet caps) and
 *                                 list canvas (`dg-virtual-canvas`), with its
 *                                 row pager beneath it, both laid out by
 *                                 `Stack`
 *   `dg-flame__equivalent-row`    one frame's treeitem, indented by
 *                                 `--dgc-depth`
 *   `dg-flame__toggle`            a row's disclosure control, or the empty box
 *                                 a leaf holds in its place so names align
 *   `dg-flame__tooltip`           the slot a row's tooltip is positioned in
 *   `dg-is-selected`              the selected frame and its row
 *   `dg-is-hovered`               the row of the frame under the pointer
 *   `dg-is-orphan`                a re-attached record (the canonical state name)
 *
 * The context band reuses `dg-flame__row`, `dg-flame__frame` and
 * `dg-flame__frame-label` with the neutral fill and its paired ink through the
 * same `--dgc-*` properties, and the tree's context rows reuse
 * `dg-flame__equivalent-row` and `dg-flame__toggle`; neither adds a class.
 *
 * ## HOVER DETAIL IS AUTHOR-DRAWN AND DISMISSIBLE (WCAG 1.4.13)
 *
 * A frame's SVG `<title>` is the user agent's tooltip: this view cannot show
 * it on focus, keep it while the pointer moves, or dismiss it. So hovering a
 * frame also marks that frame's row in the tree (`dg-is-hovered`), where every
 * figure of the title is readable and the row's name opens the full
 * description in the `Tooltip` primitive on hover. The keyboard path to the
 * same facts is the row itself: its accessible name carries them, and keyboard
 * focus on the row reveals them by holding the name's own `Tooltip` open.
 * Escape dismisses the row mark without moving the pointer, dismisses a
 * revealed detail without moving focus (the row's handler, since the primitive
 * leaves a bubble its owner holds open to that owner), and the primitive closes
 * its own hovered or focused bubble on Escape.
 *
 * Both marks are keyed by frame id, not by rendered row, because the tree
 * renders one page of its rows and the marked row may be on another: the mark
 * lands the moment the row renders. The hovered row is never scrolled to — the
 * list would jump under a pointer sweeping the canvas — while a selection made
 * anywhere but the tree itself takes the tree's tab stop, and with it the
 * page, to its row and asks the browser to scroll that row into the tree's own
 * viewport once, by the least distance (`scrollIntoView`, `block: 'nearest'`,
 * confined to the nearest scroll container where the platform supports it),
 * so no offset is ever computed here. A page turned by its row controls asks
 * the same of its first row, so the new page opens at its top.
 *
 * @see ../utils/scale for every coordinate: the fixed canvas width, the time
 * scale, the depth layout, the bounded traversal, the drawn-row window and the
 * axis ticks.
 * @see ../utils/format for the label fit and its advance estimate.
 * @see ../host/PanelActions for the interaction contract.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type { DataQuery, FlameNode } from '@debuggen/panel-schema';
import { PANEL_NODE_CATALOG } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { DebuggenError, clampNonNegative, roundMs } from '@debuggen/shared';
import type {
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Flame } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';

import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { REFUSED_RESPONSE_HINT, unreadableDataMessage } from '../host/DataProvider';
import { Stack } from '../layout/Stack';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { Kbd } from '../primitives/Kbd';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { cssVar } from '../tokens/tokens';
import {
  KIND_FILL_INK_TOKEN_KEYS,
  UNCLASSIFIED_TOKEN_KEY,
  kindColorVar,
  kindInkColorVar,
} from '../utils/color';
import {
  DEFAULT_LABEL_FONT_SIZE,
  ELLIPSIS,
  NOT_AVAILABLE_LABEL,
  countedNoun,
  createEstimateMeasure,
  fitTextToWidth,
  formatCount,
  formatCountOf,
  formatDuration,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
  formatTierLabel,
  pluralize,
  truncate,
} from '../utils/format';
import type { CountedNoun, TextMeasure } from '../utils/format';
import {
  CHART_VIEWBOX_WIDTH,
  MAX_DRAWN_ROWS,
  alignHairline,
  flattenTraceRows,
  generateAxisTicks,
  layoutHeight,
  nextWindowStart,
  placeSpanDuration,
  previousWindowStart,
  rowY,
  timeScaleForTrace,
  windowContains,
  windowRows,
  windowStartFor,
} from '../utils/scale';
import type { FlatTraceRow, RowWindow } from '../utils/scale';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * Every constant below is in SVG user units of the fixed logical canvas, the
 * structural form of value the design system permits — not a CSS length and
 * not a design token. The stylesheet scales the whole drawing uniformly to its
 * container, so these keep their proportions to the frames and the text at
 * every panel width. The canvas width is not restated here: it is
 * `../utils/scale`'s `CHART_VIEWBOX_WIDTH`, which the timeline shares. Neither
 * is the vertical rhythm: row height and row gutter come from `../utils/scale`,
 * so this view shares one pitch with the timeline and the waterfall.
 * ---------------------------------------------------------------------------
 */

/**
 * Measures a frame label in logical units: the deterministic advance estimate
 * of the labels' type role (`.dg-flame__frame-label` is set in `monoSm`, whose
 * size is `DEFAULT_LABEL_FONT_SIZE` units). One instance for the module,
 * because it depends on nothing a render can change.
 */
const LABEL_MEASURE: TextMeasure = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);

/** The band the time axis occupies above the first depth row, in user units. */
const AXIS_BAND_HEIGHT = 16;

/** How far a tick rule rises from the axis baseline, in user units. */
const AXIS_TICK_LENGTH = 4;

/** The baseline a tick label sits on, in user units. */
const AXIS_LABEL_BASELINE = AXIS_BAND_HEIGHT - AXIS_TICK_LENGTH - 2;

/**
 * The inset between a frame's edge and its label, in user units — kept on both
 * sides, so a label fitted to the frame's width less twice this never touches
 * either edge.
 */
const LABEL_INSET = 4;

/** The narrowest frame that carries a label at all, in user units. */
const MIN_LABEL_WIDTH = 32;

/**
 * The fewest graphemes of a name a truncated label keeps before its ellipsis:
 * a frame that cannot hold that many carries no label rather than a fragment
 * that identifies nothing.
 */
const MIN_LABEL_CHARS = 3;

/**
 * How far one bar may run past the next one's left edge and still count as
 * merely touching it, in user units: one millionth of a unit.
 *
 * Two siblings where one ends exactly as the next begins share an edge and
 * belong on one row. Their edges are computed through the scale separately —
 * the first as `x + width`, the second as a mapped instant — so a shared edge
 * can differ by a rounding step of floating-point arithmetic, and without this
 * slack such a pair would be split onto two rows for no visible reason. The
 * tolerance is far below anything a display can resolve, so a real overlap is
 * never mistaken for a touch.
 */
const TOUCH_TOLERANCE = 1e-6;

/**
 * The most sub-rows one crowded depth draws its overlapping frames on: 2. A
 * depth whose frames need more rows than these and one more (see
 * {@link MAX_DEPTH_ROWS}) keeps its most significant frames in these rows and
 * gathers every other one into "+N" marks on one overflow row beneath them
 * (see {@link packCrowdedDepth}), so a depth never takes more than three rows.
 *
 * ## Why a bound at all
 *
 * The packing is optimal — a depth takes as many sub-rows as bars stack over
 * any one point — and that is only legible while the stack is shallow. One
 * React commit re-renders hundreds of components inside a millisecond; widened
 * to the minimum visible width, every one of those bars overlaps the others,
 * and an unbounded packing gives that one depth hundreds of rows. The canvas
 * scrolls inside a capped viewport (`--dg-scroll-cap-sm`, 336 px), so the
 * levels beneath — the request's server work and its queries, usually what
 * the reader came for — would sit thousands of pixels down, under a band of
 * slivers.
 *
 * ## Why two
 *
 * - Two keeps the ordinary overlaps drawn exactly as the optimal packing draws
 *   them: a request beside its own resource timing, a few parallel calls, a
 *   record re-attached inside two overlapping siblings, or a run of short
 *   operations widened into their neighbours stack at most three deep, which
 *   {@link MAX_DEPTH_ROWS} rows hold without gathering anything. One would
 *   start gathering at the first stack of three.
 * - Two bounds a crowded depth at three rows. A slow submission — commits and
 *   their renders crowding two browser depths above a five-level server chain
 *   (request, route handler, handler function, service function, query) —
 *   then draws in twelve rows, and every level of that chain starts inside the
 *   first 336 px of a wide panel (a row pitch of about 27 px at 1 400 px).
 *   Three sub-rows would push the last two levels, the service's call and its
 *   query, below the viewport's edge.
 */
const MAX_DEPTH_SUB_ROWS = 2;

/**
 * The most rows one depth ever takes: its {@link MAX_DEPTH_SUB_ROWS} sub-rows
 * and the overflow row beneath them.
 *
 * It is also the threshold for gathering at all. A depth whose optimal packing
 * fits in this many rows is drawn exactly as that packing lays it out, every
 * frame a bar: gathering its last row into marks would take the same number of
 * rows and only hide the frames on it, such as a record re-attached inside two
 * overlapping siblings. Only a depth that needs more is packed into the
 * sub-rows and one row of marks.
 */
const MAX_DEPTH_ROWS = MAX_DEPTH_SUB_ROWS + 1;

/**
 * The deepest row this layout draws: 32.
 *
 * A legibility bound, not a product limit. A correlated interaction is a
 * handful of levels; a tree deeper than this is either pathological or
 * recursive, and drawing 32 rows and saying so is more useful than drawing a
 * thousand. `../utils/scale`'s traversal reports the clamp through its
 * `truncated` flag, which becomes a visible note.
 */
const MAX_ICICLE_DEPTH = 32;

/**
 * The depth at which a subtree arrives folded: 12.
 *
 * Graceful degradation for a very large trace. A frame at or below this depth
 * that has children starts folded behind its own disclosure control, so a deep
 * trace opens as something a reader can take in and every folded frame is one
 * activation away from its detail. The fold is always announced
 * (`aria-expanded`), always reversible, and always counted in a note.
 */
const AUTO_FOLD_DEPTH = 12;

/**
 * How many of a frame's nearest ancestors its detail names. A frame nested
 * deeper than this names only these, and its breadcrumb opens with an
 * ellipsis so the reader can see the chain was cut (see
 * {@link ancestryBreadcrumb}).
 */
const MAX_ANCESTRY_NAMES = 3;

/** The code-point budget for a frame's name in the text equivalent. */
const ROW_NAME_BUDGET = 96;

/**
 * This node type's catalog entry — the single registry of what a `flame` node
 * may read.
 *
 * Two things come from it rather than from a literal in this file: the view's
 * own label, and the source vocabulary the query guard below enforces. Its
 * `reads` list is the contract this component honours field for field — span
 * identity (`id`, `spanId`, `traceId`, `parentSpanId`), timing (`startTime`,
 * `duration`), taxonomy (`kind`, `tier`), label (`name`), status (`status`) and
 * source (`source`) — and nothing outside that list is read from an event here,
 * which is what keeps the validator's view of this node true.
 */
const CATALOG_ENTRY = PANEL_NODE_CATALOG.flame;

/** The one source this node draws, as the catalog declares it. */
const TRACE_SOURCE = 'trace';

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Every string a reader sees, in one place, so none of it can drift into
 * naming a framework, a route or a component of any particular project and
 * none of it can imply a sampling profile.
 * ---------------------------------------------------------------------------
 */

/** The on-screen honesty note: what a bar is, so the view never reads as a profile. */
const MEASURE_NOTE =
  'Each bar is one recorded operation: its width is the duration that was measured and its children are the operations it made.';

/** The empty state's message: a successful query that found no trace. */
const EMPTY_MESSAGE = 'No trace was captured for this interaction.';

/** The empty state's title: the short label above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No trace';

/*
 * The error states take their title, lead, query block and layout from the one
 * contract in `../host/useQuery` (`queryFailureProps`, `unsupportedQueryProps`,
 * `formatDataQuery`): the panel has one error-state design, so this view words a
 * failure exactly as every other node does. The host's response check
 * (`../host/DataProvider`) already refuses a trace missing any member this view
 * reads, so that refusal reaches this view as an ordinary failed query. The
 * shape guard below stays as defence in depth — a member present but of the
 * wrong type still passes the host's presence check — and words its refusal
 * with the host's own sentence and hint (`unreadableDataMessage`,
 * `REFUSED_RESPONSE_HINT`), so a reader meets one fault in one form whichever
 * check caught it. The one string of its own is the shape it requires, for the
 * diagnostics.
 */

/** The shape the guard requires, for the closed "Technical details" disclosure. */
const MALFORMED_TRACE_EXPECTED =
  'a correlated trace: an object with a string traceId, an array of roots and a numeric nodeCount';

/**
 * The badge a partial result carries — the same words, tone and variant the
 * timeline's summary strip and the dependency graph use, so the three charts
 * mark a subset identically.
 */
const PARTIAL_RESULT_LABEL = 'Partial result';

/** The control that moves the drawn window to the operations before it. */
const PREVIOUS_WINDOW_LABEL = 'Previous operations';

/** The control that moves the drawn window to the operations after it. */
const NEXT_WINDOW_LABEL = 'Next operations';

/**
 * The word a context bar's label opens with and its title closes on, so a bar
 * drawn only to show where a page sits never reads as one of the page's own
 * operations — in text, not by its neutral fill alone (WCAG 1.4.1).
 */
const CONTEXT_WORD = 'Context';

/** The last line of a context bar's title: what the bar is, and where it is drawn in full. */
const CONTEXT_BAR_NOTE =
  'Drawn for context: an operation this window’s operations are nested inside, listed with its own operations in an earlier window.';

/**
 * The caption above the tree's context rows, which is also their list's
 * accessible name: which rows it describes, and that none of them is a row of
 * this page.
 */
const TREE_CONTEXT_CAPTION =
  'Context from an earlier page, not rows of this one: the rows below are nested inside';

/**
 * The fill a context bar is painted in: the muted text colour, deliberately
 * outside the span-kind scale every operation of the page is filled from, so
 * the context band reads apart from the page at a glance.
 */
const CONTEXT_FILL_VAR = cssVar(UNCLASSIFIED_TOKEN_KEY);

/**
 * The ink of a context bar's label: the ink `../utils/color` pairs with that
 * fill, which the token test holds to 4.5:1 on it in every theme.
 */
const CONTEXT_INK_VAR = cssVar(KIND_FILL_INK_TOKEN_KEYS[UNCLASSIFIED_TOKEN_KEY] ?? 'surfaceBase');

/**
 * The partial-result sentence for a trace the correlator itself bounded, with
 * the refine route: nothing more of it is in memory, so no control could show
 * more, and only a narrower query or a shorter capture reaches the rest.
 */
const TRUNCATED_TRACE_NOTE =
  'This trace arrived incomplete: the correlator bounded it before including everything, so no more of it is held here. Narrow the query or capture a shorter interaction to see the rest.';

/** The note for nesting past the depth this layout draws, which no control lifts. */
const DEPTH_BOUND_NOTE = `Nested calls deeper than ${String(MAX_ICICLE_DEPTH)} levels are not drawn; each row they hang from says so.`;

/*
 * ---------------------------------------------------------------------------
 * Props and the frame model
 * ---------------------------------------------------------------------------
 */

/**
 * The props of {@link FlameChart}.
 *
 * Two members, and no callbacks: the node carries the query, and every
 * interaction leaves through the host's `PanelActions`, which the component
 * reads from context. Every optional prop spells `| undefined`, as the
 * primitives in this package do, because `exactOptionalPropertyTypes` is in
 * force repository-wide and a caller forwarding a value it may not have has to
 * remain legal.
 */
export interface FlameChartProps {
  /** The validated `flame` node this component renders. */
  node: FlameNode;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;
}

/**
 * One frame: a captured span, positioned in the hierarchy and summarised.
 *
 * Derived once per resolved trace and shared by both representations, so the
 * picture and the list can never describe the same span differently.
 *
 * `ancestry` is the reason this is a derived record rather than a borrowed
 * node: a {@link TraceNode} has no parent pointer — a cycle is not JSON, and
 * the tree crosses a process boundary — so the context a detail needs is
 * collected on the way *down* the traversal and carried here.
 */
interface FlameFrame {
  /** This frame's identity within the view: its span id, made unique. */
  readonly frameId: string;
  /**
   * The frame's position among every SHOWN operation of the whole walk — the
   * index the drawn window pages over, whether or not this frame's window is
   * the one on screen.
   */
  readonly shownIndex: number;
  /** The parent's {@link shownIndex}; absent at a root. */
  readonly parentShownIndex: number | undefined;
  /**
   * The frame's 1-based position among the shown operations that share its
   * parent, across the whole walk: its `aria-posinset`.
   */
  readonly posInSet: number;
  /** How many shown operations share its parent, across the whole walk: its `aria-setsize`. */
  readonly setSize: number;
  /** The captured event's own id — what a selection names. */
  readonly eventId: string;
  /** The span id. */
  readonly spanId: string;
  /** The trace every frame here belongs to. */
  readonly traceId: string;
  /** The operation's name, exactly as the producer recorded it. */
  readonly name: string;
  /** The kind of work. */
  readonly kind: TelemetryKind;
  /** The tier that produced it. */
  readonly tier: TelemetryTier;
  /** Whether the operation succeeded, failed, or said nothing. */
  readonly status: TelemetryStatus;
  /** Distance from the trace root, as the traversal measured it. */
  readonly depth: number;
  /**
   * The frame this one is nested in, by frame id; absent at a root. A shown
   * frame's parent is always shown — a fold hides whole subtrees — so the id
   * always names a frame of the same model.
   */
  readonly parentFrameId: string | undefined;
  /** The operation's start, in epoch milliseconds. */
  readonly startTime: number;
  /**
   * The duration as DRAWN, in milliseconds: never negative and never
   * non-finite, with a duration that was not measured drawn as zero. Geometry
   * and ordering only — every figure a reader is shown comes from
   * {@link FlameFrame.measuredDurationMs}.
   */
  readonly durationMs: number;
  /** The duration minus the interval union of the children, in milliseconds, as drawn. */
  readonly selfTimeMs: number;
  /**
   * The duration as SHOWN, in milliseconds, or `undefined` when the record's
   * duration is not a measurement (see {@link measuredDurationMs}), which every
   * label, tooltip and cell then states as "n/a" rather than as a zero.
   */
  readonly measuredDurationMs: number | undefined;
  /**
   * The own time as SHOWN, or `undefined` when the frame's own duration is not
   * a measurement: an own time computed from a duration nobody measured is not
   * a measurement either.
   */
  readonly measuredSelfTimeMs: number | undefined;
  /** How many operations this one made directly. */
  readonly childCount: number;
  /** Whether the correlator had to re-attach this record. */
  readonly orphaned: boolean;
  /** Why it was re-attached, when it was. */
  readonly orphanReason?: string | undefined;
  /** How it joined the trace, when it crossed an asynchronous boundary. */
  readonly lineage?: string | undefined;
  /** Whether more than one parent was open when it was attributed. */
  readonly lineageAmbiguous: boolean;
  /** Where in the project it came from, when a resolver could say. */
  readonly source?: SourceLocation | undefined;
  /** The nearest ancestors' names, outermost first. */
  readonly ancestry: readonly string[];
  /**
   * Whether the frame has more ancestors than {@link ancestry} names — the
   * outermost ones were left out by {@link MAX_ANCESTRY_NAMES} — so its
   * breadcrumb must say it is partial.
   */
  readonly ancestryTruncated: boolean;
  /** Whether this frame's subtree can be folded — it has children to fold. */
  readonly foldable: boolean;
  /** Whether this frame's subtree is folded away right now. */
  readonly folded: boolean;
  /** Whether the depth bound, rather than a fold, hid its children. */
  readonly childrenBeyondDepth: boolean;
}

/**
 * One frame's bar before its row is known: the horizontal extent it is DRAWN
 * at, which is what row packing reads.
 */
interface UnrowedFrame {
  /** The frame this bar draws. */
  readonly frame: FlameFrame;
  /** The frame's position in the traversal, the packing's tie-break. */
  readonly order: number;
  /** The bar's left edge, in user units, after the minimum-width clamp. */
  readonly x: number;
  /** The bar's width, in user units, after the minimum-width clamp. */
  readonly width: number;
  /** The bar's height, in user units. */
  readonly height: number;
  /** The label to draw inside it, or `undefined` when none fits. */
  readonly label: string | undefined;
}

/** One frame with the geometry of its bar. */
interface PlacedFrame {
  /** The frame this bar draws. */
  readonly frame: FlameFrame;
  /** The bar's left edge, in user units. */
  readonly x: number;
  /** The bar's width, in user units. */
  readonly width: number;
  /** The bar's top edge, in user units. */
  readonly y: number;
  /** The bar's height, in user units. */
  readonly height: number;
  /** The label to draw inside it, or `undefined` when none fits. */
  readonly label: string | undefined;
}

/**
 * One "+N" mark: a run of a crowded depth's frames that none of its
 * {@link MAX_DEPTH_SUB_ROWS} sub-rows could hold, gathered into one outlined
 * band over the extent their bars cover together.
 */
interface OverflowMark {
  /** The mark's identity: the id of the first frame it gathers, left to right. */
  readonly key: string;
  /** How many frames it gathers; at least one. */
  readonly count: number;
  /** The band's left edge, in user units: the leftmost gathered bar's. */
  readonly x: number;
  /** The band's width, in user units: to the rightmost gathered bar's right edge. */
  readonly width: number;
  /** The band's top edge, in user units: the overflow row's. */
  readonly y: number;
  /** The band's height, in user units. */
  readonly height: number;
  /** The "+N" count to draw inside it, or `undefined` when it does not fit whole. */
  readonly label: string | undefined;
  /** Its native tooltip: how many it gathers, and that each is listed in the tree. */
  readonly title: string;
}

/**
 * A frame an overflow mark gathered, with the bar it would be drawn as on the
 * overflow row — drawn only while it is the panel's selection, so the shared
 * selection is always marked on the canvas.
 */
interface GatheredFrame {
  /** The frame's bar, at its own drawn extent on the overflow row. */
  readonly bar: PlacedFrame;
  /** The {@link OverflowMark.key} of the mark that gathered it. */
  readonly markKey: string;
}

/**
 * One drawn row of the icicle: a depth, a sub-row of a depth whose siblings
 * overlap, or the overflow row of a crowded depth, which holds only marks.
 */
interface IcicleRow {
  /** The frames drawn as bars on this row, left to right, never overlapping. */
  readonly frames: readonly PlacedFrame[];
  /** The "+N" marks on this row, left to right; empty except on an overflow row. */
  readonly marks: readonly OverflowMark[];
}

/**
 * The counts every note and notice is worded from. Facts about the whole walk,
 * never about the drawn window alone, so a statement about the trace reads the
 * same on every page of it.
 */
interface TraceFacts {
  /** How many operations a fold is hiding. */
  readonly foldedAway: number;
  /** How many subtrees are folded. */
  readonly foldCount: number;
  /** How many operations the walk visited within its bounds, shown or folded away. */
  readonly walkedCount: number;
  /**
   * Whether the walk stopped at the trace's own declared node count with more
   * of the tree unvisited — a tree that holds more than it says it does.
   */
  readonly walkBounded: boolean;
  /** Whether the depth bound left the children of some frame undrawn. */
  readonly depthClamped: boolean;
  /** Whether the correlator itself truncated the trace. */
  readonly treeTruncated: boolean;
  /** How many records the correlator re-attached. */
  readonly orphanCount: number;
  /** How many roots the trace arrived with. */
  readonly rootCount: number;
  /** How many span ids the correlator saw more than once. */
  readonly duplicateCount: number;
  /** The whole trace's duration, in milliseconds. */
  readonly totalDurationMs: number;
  /** How many nodes the trace declares it holds, at every depth. */
  readonly nodeCount: number;
}

/**
 * One operation the walk SHOWS — visited within the depth bound and not hidden
 * by a folded ancestor — with the identity and the place in the hierarchy that
 * drawing it needs, and none of its geometry.
 *
 * The walk yields one of these per shown operation of the whole trace: data,
 * and no DOM. Only the drawn window's become {@link FlameFrame}s and bars.
 */
interface ShownRow {
  /** The traversal's row, borrowing its trace node read-only. */
  readonly row: FlatTraceRow;
  /** The frame id the operation is known by: its span id, made unique. */
  readonly frameId: string;
  /** The parent's index among the shown operations; absent at a root. */
  readonly parentShownIndex: number | undefined;
  /** Its 1-based position among the shown operations that share its parent. */
  readonly posInSet: number;
  /** Whether its subtree can be folded — it has children the depth bound kept. */
  readonly foldable: boolean;
  /** Whether its subtree is folded away right now. */
  readonly folded: boolean;
}

/**
 * The walk of one resolved trace under the reader's folds: every shown
 * operation, in order, and the facts the notes state. The drawn window is cut
 * from it by {@link drawWindow}, so paging never walks the trace again.
 */
interface FlameWalk extends TraceFacts {
  /** The trace walked; absent for an unresolved, empty or unusable one. */
  readonly tree: TraceTree | undefined;
  /** Every shown operation, in the traversal's order: what the window pages over. */
  readonly shown: readonly ShownRow[];
  /**
   * How many shown operations share each parent, keyed by the parent's shown
   * index — {@link ROOT_PARENT_KEY} for the roots — so a drawn row states its
   * place among ALL of its siblings, not among the ones its window holds.
   */
  readonly setSizes: ReadonlyMap<number, number>;
}

/** What one render draws: the window's frames in both representations, and the facts. */
interface FlameModel extends TraceFacts {
  /** The drawn window's frames, in the traversal's order — the list's rows. */
  readonly frames: readonly FlameFrame[];
  /**
   * The window's CONTEXT: every operation its frames are nested inside that an
   * earlier window draws, outermost first — the ancestors of its first frame
   * (see {@link contextIndexesOf}). Empty for a window that opens at a root.
   * Never page content: these are not rows of the list, and they are not
   * counted by the window.
   */
  readonly context: readonly FlameFrame[];
  /**
   * The context band: one bar per {@link context} operation, each on a row of
   * its own at the top of the canvas, outermost first, above every row of the
   * window itself.
   */
  readonly contextBars: readonly PlacedFrame[];
  /**
   * The icicle's drawn rows, top to bottom, each holding frames that never
   * overlap one another. A depth whose frames overlap in time — or only once
   * the minimum visible width widened them — occupies several consecutive
   * rows — at most {@link MAX_DEPTH_ROWS}, the last of a crowded depth's an
   * overflow row of marks — and every row of depth `d` sits above every row of
   * depth `d + 1` (see {@link packIcicleRows}). They start below the context
   * band.
   */
  readonly icicleRows: readonly IcicleRow[];
  /**
   * Every frame of the window an overflow mark gathered, by frame id — what
   * lets the canvas draw a gathered frame when the panel selects it.
   */
  readonly gathered: ReadonlyMap<string, GatheredFrame>;
  /** How many overflow marks the canvas draws; `0` when no depth was crowded. */
  readonly overflowMarkCount: number;
  /** The canvas height the rows and the axis occupy, in user units. */
  readonly canvasHeight: number;
  /** The axis ticks, with their positions and labels. */
  readonly ticks: readonly {
    readonly value: number;
    readonly offset: number;
    readonly label: string;
  }[];
  /** The greatest depth drawn. */
  readonly shownDepth: number;
  /**
   * The drawn window over the walk's shown operations: which are drawn, and
   * how many precede and follow them undrawn. Never more than
   * {@link MAX_DRAWN_ROWS}.
   */
  readonly window: RowWindow;
}

/**
 * The key the roots are counted under when shown operations are grouped by
 * their parent's shown index, which is never negative.
 */
const ROOT_PARENT_KEY = -1;

/** The facts of an unresolved, empty or unusable trace. */
const EMPTY_FACTS: TraceFacts = {
  foldedAway: 0,
  foldCount: 0,
  walkedCount: 0,
  walkBounded: false,
  depthClamped: false,
  treeTruncated: false,
  orphanCount: 0,
  rootCount: 0,
  duplicateCount: 0,
  totalDurationMs: 0,
  nodeCount: 0,
};

/** The walk an unresolved, empty or unusable trace yields. */
const EMPTY_WALK: FlameWalk = {
  ...EMPTY_FACTS,
  tree: undefined,
  shown: [],
  setSizes: new Map(),
};

/** The model an unresolved, empty or unusable trace yields. */
const EMPTY_MODEL: FlameModel = {
  ...EMPTY_FACTS,
  frames: [],
  context: [],
  contextBars: [],
  icicleRows: [],
  gathered: new Map(),
  overflowMarkCount: 0,
  canvasHeight: AXIS_BAND_HEIGHT,
  ticks: [],
  shownDepth: 0,
  window: windowRows(0),
};

/**
 * The drawn window a reader has paged to, tagged with the query it was paged
 * for and with the selection it had already accounted for.
 *
 * Tagged rather than reset by an effect: a window whose identity no longer
 * matches the node's query is simply not read, so a changed query starts at
 * the first window on the very render that shows it. The selection key is
 * what lets a reader page AWAY from a selected frame: the window is moved to a
 * selection only when the selection is newer than the window (see
 * `FlameChart`).
 */
interface WindowState {
  /** The node and query the window was paged for. */
  readonly identity: string;
  /** The first drawn operation's index among the shown operations. */
  readonly start: number;
  /** The selected frame's id when the window was set; `undefined` for none. */
  readonly selectionKey: string | undefined;
}

/**
 * An inline style object that may carry `--dgc-*` custom properties.
 *
 * React's `CSSProperties` is an interface, so TypeScript infers no index
 * signature for it and a literal holding a custom property is not assignable to
 * it. Nothing but a `--dgc-*` value may appear in an object of this type: a
 * colour, a length or a radius here would be a hardcoded CSS value, which the
 * design system forbids, and a value the stylesheet can compute itself belongs
 * in `../styles/components.css`.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/*
 * ---------------------------------------------------------------------------
 * Guards
 *
 * Two of them, both for conditions a validated panel cannot produce and a
 * misassembled one can. Neither guesses: a node that cannot be drawn says so.
 * ---------------------------------------------------------------------------
 */

/**
 * Narrows a node's query to the one source this view reads.
 *
 * The catalog restricts a `flame` node to `trace` and the validator enforces
 * it, so this is the compile-time half of a rule that already holds at
 * validation: it is what types the resolved page as a {@link TraceTree} without
 * a cast, and what keeps a wrongly-sourced node out of the provider entirely
 * rather than asking for data this component cannot read.
 */
function isTraceQuery(query: DataQuery): query is DataQuery & { source: typeof TRACE_SOURCE } {
  return query.source === TRACE_SOURCE;
}

/**
 * Whether a resolved page is shaped like a correlated trace.
 *
 * This view dereferences `traceId`, `roots` and `nodeCount` before it can draw
 * anything, and no check upstream of it promises all three: whatever the host
 * verifies before handing a page over, a provider that decoded something else
 * could still hand this component a payload typed as a trace and shaped like
 * something else. Reading it would then throw inside a render and take down the
 * panel, a silent failure where every failure must be stated — so the shape is
 * checked once, here, and a payload that fails becomes an error state.
 *
 * `null` fails this check and is not a failure: it is the service's own answer
 * for a capture in which no trace matched the query, which the caller renders
 * as the empty state before it consults this guard.
 */
function looksLikeTraceTree(value: unknown): value is TraceTree {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { traceId?: unknown; roots?: unknown; nodeCount?: unknown };
  return (
    typeof candidate.traceId === 'string' &&
    Array.isArray(candidate.roots) &&
    typeof candidate.nodeCount === 'number'
  );
}

/**
 * The failure a payload that fails {@link looksLikeTraceTree} is reported as.
 *
 * `PROTOCOL_INVALID_MESSAGE`, the code the host's response check gives a
 * payload it refuses: both are an answer that broke the panel-data contract,
 * so a reader sees one fault worded one way whichever check caught it, and it
 * reaches the error state through the same `queryFailureProps` call as a
 * rejected query. The details name the source and the shape that was required
 * — nothing read out of the payload itself, which may hold anything.
 *
 * A fresh error per call, so no two error states share one instance; it is
 * only ever built in the error branch, which renders rarely.
 *
 * @returns The error to compose the error state from.
 */
function malformedTraceError(): DebuggenError {
  return new DebuggenError('PROTOCOL_INVALID_MESSAGE', unreadableDataMessage(TRACE_SOURCE), {
    hint: REFUSED_RESPONSE_HINT,
    details: { source: TRACE_SOURCE, field: 'data', expected: MALFORMED_TRACE_EXPECTED },
  });
}

/*
 * ---------------------------------------------------------------------------
 * Text
 * ---------------------------------------------------------------------------
 */

/*
 * The words this view counts in, agreed with their count by the package's one
 * rule in `../utils/format` rather than by an inline `count === 1` per
 * sentence — which is how a note ends up reading "1 operation were …".
 */
const OPERATION_NOUN: CountedNoun = countedNoun('operation');
const NESTED_CALL_NOUN: CountedNoun = countedNoun('nested call');
const SUBTREE_NOUN: CountedNoun = countedNoun('subtree');
const SPAN_ID_NOUN: CountedNoun = countedNoun('span id');
const LEVEL_NOUN: CountedNoun = countedNoun('level');
const IS_VERB: CountedNoun = countedNoun('is', 'are');
const WAS_VERB: CountedNoun = countedNoun('was', 'were');
const OBJECT_PRONOUN: CountedNoun = countedNoun('it', 'them');
const ROW_NOUN: CountedNoun = countedNoun('row');
const MARK_NOUN: CountedNoun = countedNoun('mark');

/**
 * Where a gathered operation can still be read: "it is listed" for one,
 * "every one is listed" for several.
 */
const LISTED_IN_TREE: CountedNoun = countedNoun('it is listed', 'every one is listed');

/**
 * Why a re-attached operation was re-attached: its own parent never arrived —
 * and, for several, each its own parent, so the plural names parents rather
 * than one parent they shared.
 */
const ORPHAN_CAUSE: CountedNoun = countedNoun(
  'its parent never arrived',
  'their parents never arrived',
);

/** Where a re-attached operation is marked: "it is" for one, "each is" for several. */
const ORPHAN_MARKING: CountedNoun = countedNoun(
  'it is marked on its row',
  'each is marked on its row',
);

/** "1 operation" / "4 operations", with the package's own number formatting. */
function pluralOperations(count: number): string {
  return formatCountOf(count, OPERATION_NOUN);
}

/** "1 nested call" / "7 nested calls". */
function pluralNestedCalls(count: number): string {
  return formatCountOf(count, NESTED_CALL_NOUN);
}

/**
 * A frame's ancestors as a breadcrumb, outermost first: "A › B › C", or
 * "… › A › B › C" when older ancestors were left out, so a cut chain never
 * reads as the whole path from the root.
 */
function ancestryBreadcrumb(frame: FlameFrame): string {
  const names = frame.ancestryTruncated ? [ELLIPSIS, ...frame.ancestry] : frame.ancestry;
  return names.join(' › ');
}

/**
 * A frame's provenance, when the correlator had anything to say about how it
 * joined the trace.
 *
 * Kept separate from the frame's measurements because it is a statement about
 * the *structure* rather than about the work: an inferred relationship must
 * never read as a measured one.
 */
function provenanceOf(frame: FlameFrame): string | undefined {
  const notes: string[] = [];

  if (frame.orphaned) {
    notes.push(
      frame.orphanReason === undefined
        ? 'Re-attached to the trace root: its parent never arrived.'
        : `Re-attached to the trace root (${frame.orphanReason}).`,
    );
  }
  if (frame.lineage !== undefined) {
    notes.push(`Joined the trace as ${frame.lineage}.`);
  }
  if (frame.lineageAmbiguous) {
    notes.push('More than one parent was open when it was attributed.');
  }

  return notes.length === 0 ? undefined : notes.join(' ');
}

/**
 * A frame's whole detail as one block of plain text, for the native tooltip the
 * canvas shows on hover.
 *
 * This text is a convenience for a pointer user; the same facts reach a screen
 * reader through the frame's accessible name ({@link frameDescription}), and a
 * keyboard user through the row's own tooltip and cells in the text
 * equivalent, which is the representation that must be complete.
 */
function frameTooltipText(frame: FlameFrame): string {
  const lines: string[] = [frame.name];

  lines.push(`${formatKindLabel(frame.kind)} · ${formatTierLabel(frame.tier)}`);
  lines.push(`Duration ${formatShownDuration(frame.measuredDurationMs)}`);
  lines.push(`Own time ${formatShownDuration(frame.measuredSelfTimeMs)}`);
  lines.push(pluralNestedCalls(frame.childCount));

  if (frame.status === 'error') {
    lines.push(formatStatusLabel(frame.status));
  }
  if (frame.ancestry.length > 0) {
    lines.push(`Inside ${ancestryBreadcrumb(frame)}`);
  }

  const provenance = provenanceOf(frame);
  if (provenance !== undefined) {
    lines.push(provenance);
  }

  return lines.join('\n');
}

/**
 * An overflow mark's native tooltip and accessible name: how many operations
 * it gathers, the stretch of the trace they cover, why they are gathered, and
 * where each of them can still be read — "8 operations from 0.00 ms to
 * 90.00 ms gathered here, where this level overlaps more deeply than its 2
 * rows can draw; every one is listed in the tree below."
 *
 * The stretch is what tells one mark from another: a crowded level of a large
 * trace gathers into many marks, and a reader moving through the canvas's
 * images by name hears where each one sits rather than a list of identical
 * counts. It is measured from the chart's own origin — the axis's zero — and
 * is omitted when either end is not a finite time, so a malformed record never
 * prints a made-up offset.
 *
 * @param count How many operations the mark gathers.
 * @param stretch Where the gathered operations start and end, as epoch
 * milliseconds, and the origin the axis measures them from; omitted when
 * unknown.
 * @returns The tooltip text.
 */
function overflowMarkTitle(count: number, stretch?: MarkStretch): string {
  const during =
    stretch !== undefined &&
    Number.isFinite(stretch.startTime) &&
    Number.isFinite(stretch.endTime) &&
    Number.isFinite(stretch.origin)
      ? ` from ${formatOffset(stretch.startTime, stretch.origin)} to ${formatOffset(
          stretch.endTime,
          stretch.origin,
        )}`
      : '';

  return `${pluralOperations(count)}${during} gathered here, where this level overlaps more deeply than its ${formatCountOf(
    MAX_DEPTH_SUB_ROWS,
    ROW_NOUN,
  )} can draw; ${pluralize(count, LISTED_IN_TREE)} in the tree below.`;
}

/**
 * The stretch of the trace one overflow mark covers: from the earliest start
 * of the operations it gathers to the latest end, both as epoch milliseconds,
 * with the origin the chart's axis measures offsets from.
 */
interface MarkStretch {
  /** The earliest start of a gathered operation, in epoch milliseconds. */
  readonly startTime: number;
  /** The latest drawn end of a gathered operation, in epoch milliseconds. */
  readonly endTime: number;
  /** The axis's zero, in epoch milliseconds. */
  readonly origin: number;
}

/**
 * Where a run of gathered bars sits in the trace: the earliest start and the
 * latest end of the frames it holds. The end reads each frame's DRAWN duration
 * (a record whose duration is not a measurement contributes its start only),
 * which is the extent the mark itself is drawn over.
 *
 * @param bars The run's bars; at least one.
 * @param origin The axis's zero, in epoch milliseconds.
 * @returns The run's stretch.
 */
function stretchOf(bars: readonly UnrowedFrame[], origin: number): MarkStretch {
  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;

  // A loop rather than a spread into Math.min/Math.max: one mark can gather
  // every frame of a drawn window, and a spread of that many arguments is not
  // a bound this view should depend on.
  for (const bar of bars) {
    const { startTime: start, durationMs } = bar.frame;
    if (!Number.isFinite(start)) {
      continue;
    }
    startTime = Math.min(startTime, start);
    endTime = Math.max(endTime, start + durationMs);
  }

  return { startTime, endTime, origin };
}

/**
 * What the row bound on a crowded depth did to the drawing, as the note above
 * the canvas and its text alternative both state it — or `undefined` when no
 * depth of the drawn window needed more than {@link MAX_DEPTH_ROWS} rows, so a
 * trace the bound never touched carries no note about it.
 *
 * A statement about the drawn window, not the whole walk: it counts the
 * operations this window gathered, so it is re-worded as the reader pages.
 *
 * @param model The drawn window.
 * @returns The sentence, when anything was gathered.
 */
function compactionSentence(model: FlameModel): string | undefined {
  const gathered = model.gathered.size;
  if (gathered === 0) {
    return undefined;
  }

  return `Where more operations of one level overlap than its ${formatCountOf(
    MAX_DEPTH_SUB_ROWS,
    ROW_NOUN,
  )} can hold, those rows keep the longest, and the ${pluralOperations(
    gathered,
  )} that did not fit ${pluralize(gathered, IS_VERB)} gathered into ${formatCountOf(
    model.overflowMarkCount,
    MARK_NOUN,
  )} on a row beneath them; ${pluralize(gathered, LISTED_IN_TREE)} in the tree below.`;
}

/**
 * The canvas's text alternative: what the picture shows, in one sentence.
 *
 * It describes recorded operations and measured durations, and it never
 * describes samples, stacks or a profile — see the note at the top of this
 * module. A drawing in which a crowded depth gathered operations into marks
 * says so in the words of the note above it ({@link compactionSentence}).
 */
function canvasTextAlternative(model: FlameModel, title: string | undefined): string {
  const heading = title === undefined ? CATALOG_ENTRY.label : title;
  const levels = model.shownDepth + 1;
  const shape = `${heading}: ${pluralOperations(model.frames.length)} nested ${formatCountOf(
    levels,
    LEVEL_NOUN,
  )} deep, ${formatDuration(model.totalDurationMs)} from the first to the last.`;
  const compaction = compactionSentence(model);
  const described = compaction === undefined ? shape : `${shape} ${compaction}`;

  // A partial picture says so in the same words the notices beside it use,
  // and a picture with a context band says which of its rows are context.
  const partial: string[] = [];
  if (isWindowed(model.window)) {
    partial.push(windowSentence(model.window));
  }
  const contextStatement = contextSentence(model.context);
  if (contextStatement !== undefined) {
    partial.push(contextStatement);
  }
  if (model.walkBounded) {
    partial.push(walkBoundSentence(model));
  }
  if (model.treeTruncated) {
    partial.push('The trace itself arrived incomplete.');
  }

  return partial.length === 0 ? described : `${described} ${partial.join(' ')}`;
}

/*
 * ---------------------------------------------------------------------------
 * Arithmetic
 * ---------------------------------------------------------------------------
 */

/** A duration made usable: non-finite becomes `0`, negative becomes `0`. */
function usableDurationMs(value: number): number {
  return clampNonNegative(Number.isFinite(value) ? value : 0);
}

/**
 * A duration a reader may be shown as measured, or `undefined` when the
 * record's value is not a measurement.
 *
 * The display twin of {@link usableDurationMs}, and the judgement
 * `formatDuration` and `DurationCell` make: a duration cannot be negative, so a
 * negative one — or a `null`, `NaN` or infinity arriving in a malformed record
 * — is corrupt rather than fast. A value below zero only by floating-point
 * noise, one that rounds to zero at the shared resolution, is the zero it is.
 *
 * @param value The record's duration, in milliseconds.
 */
function measuredDurationMs(value: number): number | undefined {
  return Number.isFinite(value) && roundMs(value) >= 0 ? clampNonNegative(value) : undefined;
}

/**
 * A shown duration as text: the formatter's text for a measured value, and the
 * not-available label for one that was not measured.
 */
function formatShownDuration(ms: number | undefined): string {
  return ms === undefined ? NOT_AVAILABLE_LABEL : formatDuration(ms);
}

/**
 * A node's own time: its measured duration minus the **interval union** of its
 * direct children, clipped to its own window.
 *
 * ## Why a union and not a sum
 *
 * Children overlap as a matter of routine — one interaction can issue several
 * requests in parallel — and two 400 ms calls that ran side by side account for
 * 400 ms of their parent's time, not 800 ms. Subtracting a sum would report a
 * negative own time for such a parent, and a negative width is either clipped
 * to nothing or drawn inverted: either way the reader is shown something false
 * about where the time went. So the children's intervals are merged and the
 * length of the merge is what is subtracted.
 *
 * ## Why each child is clipped to the parent's window first
 *
 * A child can legitimately fall partly outside its parent's window: the browser
 * agent and the dev-server preload read their clocks independently, and a call
 * the parent did not await can outlive it. Time outside the parent's window is
 * not the parent's to account for. A child that clips to nothing is dropped,
 * which also excludes a non-finite bound, since every comparison against one is
 * false.
 *
 * ## Why this lives here
 *
 * `@debuggen/telemetry` is a type-only dependency of this package, so none of
 * its runtime helpers may be imported — the arithmetic is the renderer's to do,
 * and the rounding policy (`roundMs`) and duration clamp (`clampNonNegative`)
 * are taken from `@debuggen/shared` rather than reinvented so that this number
 * agrees with the same number computed anywhere else in the product.
 *
 * Only **direct** children are considered: a grandchild's time already lies
 * inside its parent's interval, so counting it again would subtract it twice.
 *
 * @param node Any node of a correlated trace, read and never mutated.
 * @returns The own time in milliseconds, never negative, never non-finite, and
 * equal to the measured duration for a leaf.
 */
function selfTimeMsOf(node: TraceNode): number {
  const total = usableDurationMs(node.event.duration);

  if (node.children.length === 0) {
    return roundMs(total);
  }

  const windowStart = node.event.startTime;
  const windowEnd = windowStart + total;
  const intervals: { readonly start: number; readonly end: number }[] = [];

  for (const child of node.children) {
    const start = Math.max(child.event.startTime, windowStart);
    const end = Math.min(child.event.startTime + usableDurationMs(child.event.duration), windowEnd);
    if (!(end > start)) {
      continue;
    }
    intervals.push({ start, end });
  }

  intervals.sort((left, right) => left.start - right.start);

  let covered = 0;
  let openStart: number | undefined;
  let openEnd = 0;

  for (const interval of intervals) {
    if (openStart === undefined) {
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }
    if (interval.start > openEnd) {
      covered += openEnd - openStart;
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }
    if (interval.end > openEnd) {
      openEnd = interval.end;
    }
  }

  if (openStart !== undefined) {
    covered += openEnd - openStart;
  }

  return roundMs(clampNonNegative(total - covered));
}

/**
 * The label to draw inside a bar of `width` user units, or `undefined` when
 * none fits.
 *
 * The name is fitted by its estimated advance in the label's type role, in the
 * same logical units as the bar ({@link LABEL_MEASURE}), never by a character
 * count: `fitTextToWidth` keeps the whole name when it fits the bar less
 * {@link LABEL_INSET} on each side, and otherwise the longest grapheme prefix
 * that fits with an ellipsis appended. So a label never extends past its bar, a
 * truncated label's ellipsis is always inside the bar where a reader can see
 * it, and a cut never splits an emoji, a flag or a combining sequence. A
 * character budget could promise none of that: glyph advances differ (an emoji
 * is about two columns wide), and a budget wrong by one glyph paints the
 * ellipsis past the edge. The bar and its label scale together with the
 * canvas, so the fit holds at every panel width.
 *
 * A bar too narrow for a legible fragment carries no label at all — one
 * narrower than {@link MIN_LABEL_WIDTH}, or one that cannot hold
 * {@link MIN_LABEL_CHARS} graphemes and the ellipsis — because a sliver of a
 * name identifies nothing, and text painted past a bar's edge reads as
 * belonging to its neighbour.
 *
 * @param name The operation's recorded name.
 * @param width The bar's width, in the canvas's user units.
 * @returns The text to draw, or `undefined` for no label.
 */
function frameLabelText(name: string, width: number): string | undefined {
  if (!(width >= MIN_LABEL_WIDTH)) {
    return undefined;
  }

  return fitTextToWidth(name, width - LABEL_INSET * 2, LABEL_MEASURE, {
    minGraphemes: MIN_LABEL_CHARS,
  })?.text;
}

/**
 * The "+N" count to draw inside an overflow mark `width` user units wide, or
 * `undefined` when it does not fit whole.
 *
 * Fitted exactly as a frame's label is ({@link frameLabelText}): by the
 * estimate of the label's type role, in the same logical units, between the
 * insets, and never inside a mark narrower than {@link MIN_LABEL_WIDTH}. With
 * one difference: a count is never cut. "+1…" of "+1,234" would state a number
 * the mark does not hold, so a count that does not fit whole draws nothing,
 * and the mark's title still carries it.
 *
 * @param count How many operations the mark gathers.
 * @param width The mark's width, in the canvas's user units.
 * @returns The text to draw, or `undefined` for no label.
 */
function overflowLabelText(count: number, width: number): string | undefined {
  if (!(width >= MIN_LABEL_WIDTH)) {
    return undefined;
  }

  const fit = fitTextToWidth(`+${formatCount(count)}`, width - LABEL_INSET * 2, LABEL_MEASURE);
  return fit === undefined || fit.truncated ? undefined : fit.text;
}

/*
 * ---------------------------------------------------------------------------
 * Derivation
 * ---------------------------------------------------------------------------
 */

/**
 * Packs one depth's bars into the fewest sub-rows in which no two bars overlap.
 *
 * ## Why a depth can need more than one row
 *
 * An icicle puts every node of a depth on one row, which is only legible while
 * the siblings on that row are disjoint in time. They are not always: a record
 * the correlator re-attached to the root lands on the root's child row while
 * it ran inside another child's window, parallel calls under one parent
 * overlap by construction, and a run of short operations that each had to be
 * widened to the minimum visible width can overlap once drawn even though
 * their measured windows did not. Drawn on one row, the later bar paints over
 * the earlier one and a reader sees one frame inside another — a nesting the
 * capture never recorded.
 *
 * ## The packing
 *
 * Greedy interval partitioning over the DRAWN extent — the offset and width
 * after the scale's minimum-width clamp, because that is what paints. Bars are
 * taken in a deterministic order, left edge first and traversal order second,
 * and each goes into the first sub-row whose last bar ends at or before its
 * left edge; a bar that fits nowhere opens a new sub-row. Bars that only touch
 * share a row (see {@link TOUCH_TOLERANCE}). Taking bars by left edge makes the
 * first-fit choice optimal: the number of sub-rows equals the greatest number
 * of bars stacked over any one point, so a depth never grows a row it did not
 * need.
 *
 * @param bars One depth's bars, in traversal order.
 * @returns The sub-rows, each holding its bars left to right.
 */
function packDepthBars(bars: readonly UnrowedFrame[]): readonly (readonly UnrowedFrame[])[] {
  const ordered = [...bars].sort((left, right) => left.x - right.x || left.order - right.order);
  const lanes: UnrowedFrame[][] = [];
  const laneEnds: number[] = [];

  for (const bar of ordered) {
    const end = bar.x + bar.width;
    const target = laneEnds.findIndex((laneEnd) => laneEnd - bar.x <= TOUCH_TOLERANCE);
    const lane = target < 0 ? undefined : lanes[target];

    if (lane === undefined) {
      lanes.push([bar]);
      laneEnds.push(end);
      continue;
    }

    lane.push(bar);
    laneEnds[target] = end;
  }

  return lanes;
}

/**
 * Orders a crowded depth's bars by how much the reader needs each one drawn:
 * the longest measured duration first, then the earliest drawn start, then
 * traversal order, so the order is total and the same trace always keeps the
 * same bars.
 *
 * Duration first because a long operation is what a reader of a timing view
 * came to see, and it is also the bar a mark would hide the most of; the drawn
 * start follows the measured start (the scale only clamps it into the canvas),
 * and traversal order settles bars that agree on both.
 */
function bySignificance(left: UnrowedFrame, right: UnrowedFrame): number {
  return (
    right.frame.durationMs - left.frame.durationMs || left.x - right.x || left.order - right.order
  );
}

/**
 * Where `bar` fits on a sub-row whose bars are disjoint and sorted by left
 * edge: the index to insert it at to keep them so, or `-1` when it would
 * overlap a bar already there.
 *
 * The row's bars are disjoint and sorted by left edge, so their right edges
 * are sorted too, and only the two neighbours of the insertion point can
 * overlap the new bar: the one before must end at or before its left edge, and
 * the one after must begin at or after its right edge, each within
 * {@link TOUCH_TOLERANCE} so bars that only touch share the row. A binary
 * search finds the insertion point, so a row is never scanned end to end.
 *
 * @param lane One sub-row's bars, disjoint and sorted by left edge.
 * @param bar The bar to place.
 * @returns The insertion index, or `-1` when the bar does not fit.
 */
function laneInsertionIndex(lane: readonly UnrowedFrame[], bar: UnrowedFrame): number {
  let low = 0;
  let high = lane.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = lane[middle];
    if (candidate !== undefined && candidate.x <= bar.x) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const before = lane[low - 1];
  if (before !== undefined && before.x + before.width - bar.x > TOUCH_TOLERANCE) {
    return -1;
  }
  const after = lane[low];
  if (after !== undefined && bar.x + bar.width - after.x > TOUCH_TOLERANCE) {
    return -1;
  }

  return low;
}

/** A run of gathered bars whose drawn extents overlap, and the extent they cover together. */
interface OverflowCluster {
  /** The bars, left to right. */
  readonly bars: readonly UnrowedFrame[];
  /** The leftmost bar's left edge, in user units. */
  readonly x: number;
  /** The rightmost right edge among the bars, in user units. */
  readonly end: number;
}

/** A crowded depth, packed: its bounded sub-rows and what they could not hold. */
interface CrowdedDepth {
  /** At most {@link MAX_DEPTH_SUB_ROWS} sub-rows, each with its bars left to right. */
  readonly lanes: readonly (readonly UnrowedFrame[])[];
  /** Every bar no sub-row could hold, gathered into runs left to right. */
  readonly clusters: readonly OverflowCluster[];
}

/**
 * Packs a depth that needs more than {@link MAX_DEPTH_ROWS} rows into
 * {@link MAX_DEPTH_SUB_ROWS} sub-rows, and gathers the bars that fit in none of
 * them.
 *
 * ## Which bars keep a row
 *
 * The bars are taken by significance ({@link bySignificance}: the longest
 * measured duration, then the earliest start, then traversal order) and each
 * goes into the first sub-row it overlaps nothing on ({@link laneInsertionIndex})
 * — first fit, over the same DRAWN extents and with the same touch tolerance
 * as the optimal packing, so no row ever paints one bar over another. The
 * {@link MAX_DEPTH_SUB_ROWS} longest operations of the depth are therefore
 * always bars — each finds fewer bars placed before it than there are
 * sub-rows — and a shorter one keeps a row wherever the longer ones leave room
 * for it. A bar is gathered only
 * when every sub-row is already taken where it would be drawn, so every
 * sub-row holds at least one bar.
 *
 * ## How the rest are gathered
 *
 * The gathered bars, left to right, are merged into runs wherever their drawn
 * extents overlap (bars that only touch start a new run). Each run becomes one
 * "+N" mark over the extent it covers, on the overflow row beneath the
 * sub-rows, so the mark sits where the operations it stands for were drawn.
 *
 * @param bars One crowded depth's bars, in traversal order.
 * @returns The bounded sub-rows and the runs of gathered bars.
 */
function packCrowdedDepth(bars: readonly UnrowedFrame[]): CrowdedDepth {
  const lanes: UnrowedFrame[][] = Array.from({ length: MAX_DEPTH_SUB_ROWS }, () => []);
  const overflow: UnrowedFrame[] = [];

  for (const bar of [...bars].sort(bySignificance)) {
    let placed = false;
    for (const lane of lanes) {
      const index = laneInsertionIndex(lane, bar);
      if (index >= 0) {
        lane.splice(index, 0, bar);
        placed = true;
        break;
      }
    }
    if (!placed) {
      overflow.push(bar);
    }
  }

  overflow.sort((left, right) => left.x - right.x || left.order - right.order);

  const clusters: OverflowCluster[] = [];
  let run: UnrowedFrame[] = [];
  let clusterStart = 0;
  let clusterEnd = 0;

  for (const bar of overflow) {
    const barEnd = bar.x + bar.width;
    if (run.length > 0 && clusterEnd - bar.x > TOUCH_TOLERANCE) {
      run.push(bar);
      clusterEnd = Math.max(clusterEnd, barEnd);
      continue;
    }
    if (run.length > 0) {
      clusters.push({ bars: run, x: clusterStart, end: clusterEnd });
    }
    run = [bar];
    clusterStart = bar.x;
    clusterEnd = barEnd;
  }
  if (run.length > 0) {
    clusters.push({ bars: run, x: clusterStart, end: clusterEnd });
  }

  // Every sub-row holds a bar whenever anything was gathered (see above), so
  // the filter only guards a depth that was never crowded to begin with.
  return { lanes: lanes.filter((lane) => lane.length > 0), clusters };
}

/**
 * One sub-row's bars, placed at the row's top edge.
 *
 * @param lane The sub-row's bars, left to right.
 * @param y The row's top edge, in user units.
 * @returns The bars with their full geometry.
 */
function placeLane(lane: readonly UnrowedFrame[], y: number): PlacedFrame[] {
  return lane.map((bar) => ({
    frame: bar.frame,
    x: bar.x,
    width: bar.width,
    y,
    height: bar.height,
    label: bar.label,
  }));
}

/** The icicle's drawn rows and what its overflow rows gathered. */
interface PackedIcicle {
  /** The drawn rows, top to bottom. */
  readonly rows: readonly IcicleRow[];
  /** Every gathered frame, by frame id, with the bar it would be drawn as. */
  readonly gathered: ReadonlyMap<string, GatheredFrame>;
  /** How many "+N" marks the overflow rows hold in all. */
  readonly markCount: number;
}

/**
 * Assigns every bar its drawn row: each depth packed into sub-rows, and the
 * sub-rows numbered in depth-major order.
 *
 * Depth-major is what keeps the icicle an icicle: every sub-row of depth `d`
 * sits above every sub-row of depth `d + 1`, so a parent is always drawn above
 * each of its children and a reader still follows causality downward. A depth
 * with no overlaps keeps exactly one row, so a trace whose siblings never
 * overlap draws precisely as a one-row-per-depth icicle would.
 *
 * A depth whose optimal packing ({@link packDepthBars}) fits in
 * {@link MAX_DEPTH_ROWS} rows is drawn exactly as that packing lays it out,
 * every frame a bar. A crowded depth — one that needs more — is packed into
 * {@link MAX_DEPTH_SUB_ROWS} sub-rows by {@link packCrowdedDepth}, and ONE
 * overflow row directly beneath them carries a "+N" mark per run of the bars
 * they could not hold. So a depth never takes more than `MAX_DEPTH_ROWS` rows,
 * however many of its operations overlap, and the depths below it stay within
 * reach of the top of the canvas.
 *
 * The vertical rhythm is `../utils/scale`'s: row `n` of the result sits at
 * `rowY(firstRow + n)` below the axis band, so the rows open beneath the
 * `firstRow` rows above them — the context band's.
 *
 * @param barsByDepth The shown bars grouped by depth, dense from the root.
 * @param origin The axis's zero, in epoch milliseconds, which each mark's
 * title measures the stretch it covers from.
 * @param firstRow How many drawn rows sit above these on the canvas.
 * @returns The drawn rows, top to bottom, each with its bars left to right,
 * and every frame the overflow rows gathered.
 */
function packIcicleRows(
  barsByDepth: readonly (readonly UnrowedFrame[])[],
  origin: number,
  firstRow: number,
): PackedIcicle {
  const rows: IcicleRow[] = [];
  const gathered = new Map<string, GatheredFrame>();
  let markCount = 0;

  const pushLane = (lane: readonly UnrowedFrame[]): void => {
    rows.push({
      frames: placeLane(lane, AXIS_BAND_HEIGHT + rowY(firstRow + rows.length)),
      marks: [],
    });
  };

  for (const bars of barsByDepth) {
    const optimal = packDepthBars(bars);
    if (optimal.length <= MAX_DEPTH_ROWS) {
      optimal.forEach(pushLane);
      continue;
    }

    const crowded = packCrowdedDepth(bars);
    crowded.lanes.forEach(pushLane);

    const y = AXIS_BAND_HEIGHT + rowY(firstRow + rows.length);
    const marks: OverflowMark[] = [];
    for (const cluster of crowded.clusters) {
      const [first] = cluster.bars;
      if (first === undefined) {
        continue;
      }
      const count = cluster.bars.length;
      const width = cluster.end - cluster.x;
      const key = first.frame.frameId;
      marks.push({
        key,
        count,
        x: cluster.x,
        width,
        y,
        height: Math.max(...cluster.bars.map((bar) => bar.height)),
        label: overflowLabelText(count, width),
        title: overflowMarkTitle(count, stretchOf(cluster.bars, origin)),
      });
      for (const bar of placeLane(cluster.bars, y)) {
        gathered.set(bar.frame.frameId, { bar, markKey: key });
      }
    }
    markCount += marks.length;
    rows.push({ frames: [], marks });
  }

  return { rows, gathered, markCount };
}

/**
 * The count a trace declares for itself, made usable as a bound: a finite,
 * positive count rounded down, and `0` for anything else.
 */
function declaredCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Walks a resolved trace under the reader's folds: every operation the depth
 * bound reaches, in order, reduced to the ones no folded ancestor hides.
 *
 * ## One traversal, top-down, bounded, and not recursive
 *
 * `../utils/scale`'s `flattenTraceRows` performs the walk over an explicit
 * stack, so a malformed or deeply recursive tree cannot overflow the
 * JavaScript call stack of a DevTools panel, and it preserves the canonical
 * sibling order the correlator settled — parent before child, then start time,
 * then the producer's sequence, then the store's arrival number. Nothing here
 * re-sorts it: an order that differs between two views of one capture is
 * unreadable.
 *
 * ## The walk covers the whole trace; drawing does not
 *
 * The window a reader pages over, the place a row states among its siblings
 * and the counts the notes give are all facts about the WHOLE trace, so the
 * walk visits every node the depth bound reaches. What it yields is data — one
 * small record per shown operation, borrowing the trace node — with no
 * geometry and no DOM: {@link drawWindow} turns at most {@link MAX_DRAWN_ROWS}
 * of those records into frames and bars, and paging re-cuts the window from
 * this same walk rather than walking again.
 *
 * ## The walk is bounded by what the trace says it holds
 *
 * The traversal takes a bound, and the trace declares its own node count,
 * which a well-formed tree meets exactly. So the walk stops at that count —
 * never below one drawn window, so a count that cannot be believed still draws
 * what fits — and visits ONE operation of lookahead past it. Producing that
 * extra operation is the exact answer to "does this tree hold more than it
 * says" (`walkBounded`), which the layout's `truncated` flag cannot give,
 * because the depth bound sets it too; it costs one node rather than a second
 * walk, and it keeps a malformed tree from being walked without limit while
 * its excess is still stated rather than dropped silently.
 *
 * ## Folding is a filter over the full walk, never a shorter walk
 *
 * The traversal always visits the whole tree (within its depth and size
 * bounds), and a fold hides rows *afterwards* by ancestry. That is what keeps
 * every frame's identity — and therefore a host's persisted disclosure state —
 * stable while subtrees open and close: a row's index is a property of the
 * trace, not of what happens to be unfolded.
 *
 * ## Siblings are counted across the whole walk
 *
 * Each shown operation's position among the shown operations that share its
 * parent is numbered here in one forward pass — a parent precedes its children
 * in a pre-order walk — so a drawn row's `aria-posinset` of `aria-setsize` is
 * its place among ALL of its siblings, on whichever page each of them is drawn.
 *
 * @param tree The resolved trace, read and never mutated.
 * @param folds Which frames the developer has explicitly opened or closed, by
 * frame id; a frame absent from the map takes the default for its depth.
 * @returns Every shown operation, in order, and the facts the notes are
 * worded from.
 */
function walkTrace(tree: TraceTree | undefined, folds: ReadonlyMap<string, boolean>): FlameWalk {
  if (tree === undefined || tree.nodeCount === 0 || tree.roots.length === 0) {
    return EMPTY_WALK;
  }

  const walkBound = Math.max(declaredCount(tree.nodeCount), MAX_DRAWN_ROWS);
  const layout = flattenTraceRows(tree, {
    maxDepth: MAX_ICICLE_DEPTH,
    maxRows: walkBound + 1,
  });
  // The lookahead operation exists only when the tree holds more than the
  // bound; it is counted, never shown.
  const walkBounded = layout.totalRowCount > walkBound;
  const visited = Math.min(layout.rows.length, walkBound);

  const shown: ShownRow[] = [];
  const setSizes = new Map<number, number>();

  /** Every shown row's index among the shown operations, by row index. */
  const shownIndexByRow: (number | undefined)[] = [];

  /** Rows whose descendants are hidden: hidden themselves, or folded. */
  const closedRows = new Set<number>();

  /** Span ids already used as a frame id, so a duplicate cannot collide. */
  const usedSpanIds = new Set<string>();

  let foldedAway = 0;
  let foldCount = 0;
  let depthClamped = false;

  for (let index = 0; index < visited; index += 1) {
    const row = layout.rows[index];
    if (row === undefined) {
      continue;
    }
    const parentRow = row.parentRowIndex;

    // Read before the fold check: a clamp inside a folded subtree is still a
    // clamp, and the note about it must not depend on what is open.
    if (row.childrenTruncated) {
      depthClamped = true;
    }

    if (parentRow !== undefined && closedRows.has(parentRow)) {
      // An ancestor is folded, so this row is not shown — and neither is
      // anything below it, which the next iterations resolve through this set.
      closedRows.add(row.rowIndex);
      foldedAway += 1;
      continue;
    }

    const spanId = row.node.event.spanId;
    const frameId = usedSpanIds.has(spanId) ? `${spanId}#${String(row.rowIndex)}` : spanId;
    usedSpanIds.add(spanId);

    // A frame whose children the depth bound already dropped has nothing left
    // to fold, so it offers no control: the note about the bound is the honest
    // statement there, not a toggle that would reveal nothing.
    const foldable = row.hasChildren && !row.childrenTruncated;
    const opened = folds.get(frameId);
    const folded = foldable && (opened === undefined ? row.depth >= AUTO_FOLD_DEPTH : !opened);

    if (folded) {
      closedRows.add(row.rowIndex);
      foldCount += 1;
    }

    const parentShownIndex = parentRow === undefined ? undefined : shownIndexByRow[parentRow];
    const siblingKey = parentShownIndex ?? ROOT_PARENT_KEY;
    const posInSet = (setSizes.get(siblingKey) ?? 0) + 1;
    setSizes.set(siblingKey, posInSet);

    shownIndexByRow[row.rowIndex] = shown.length;
    shown.push({ row, frameId, parentShownIndex, posInSet, foldable, folded });
  }

  return {
    tree,
    shown,
    setSizes,
    foldedAway,
    foldCount,
    walkedCount: visited,
    walkBounded,
    depthClamped,
    treeTruncated: tree.truncated,
    orphanCount: tree.orphanCount,
    rootCount: tree.roots.length,
    duplicateCount: tree.duplicateSpanIds.length,
    totalDurationMs: tree.totalDuration,
    nodeCount: tree.nodeCount,
  };
}

/** The facts of a walk, without the walk itself: what a drawn model carries. */
function factsOf(walk: FlameWalk): TraceFacts {
  return {
    foldedAway: walk.foldedAway,
    foldCount: walk.foldCount,
    walkedCount: walk.walkedCount,
    walkBounded: walk.walkBounded,
    depthClamped: walk.depthClamped,
    treeTruncated: walk.treeTruncated,
    orphanCount: walk.orphanCount,
    rootCount: walk.rootCount,
    duplicateCount: walk.duplicateCount,
    totalDurationMs: walk.totalDurationMs,
    nodeCount: walk.nodeCount,
  };
}

/**
 * A shown operation's nearest ancestors' names, outermost first: at most
 * {@link MAX_ANCESTRY_NAMES} of them.
 *
 * Read UP the walk's parent links rather than carried down the walk, because
 * only a drawn frame needs its breadcrumb: the chain is at most that many
 * steps, so the cost is paid per drawn frame, not per walked operation. Every
 * ancestor of a shown operation is itself shown — a fold hides whole subtrees
 * — so every link resolves.
 *
 * @param shown The walk's shown operations.
 * @param entry The operation whose ancestry is wanted.
 * @returns The names, outermost first.
 */
function ancestryOf(shown: readonly ShownRow[], entry: ShownRow): readonly string[] {
  const names: string[] = [];
  let parentIndex = entry.parentShownIndex;

  while (parentIndex !== undefined && names.length < MAX_ANCESTRY_NAMES) {
    const ancestor = shown[parentIndex];
    if (ancestor === undefined) {
      break;
    }
    names.push(ancestor.row.node.event.name);
    parentIndex = ancestor.parentShownIndex;
  }

  return names.reverse();
}

/**
 * The CONTEXT of a page that opens at the shown operation `firstIndex`: the
 * shown indexes of every one of that operation's ancestors, outermost first.
 *
 * ## Why the first operation's ancestors are the whole context
 *
 * The walk is pre-order and a fold removes whole subtrees, so every operation's
 * subtree is one contiguous run of the shown operations, starting at the
 * operation itself. An operation of the page `[firstIndex, end)` whose parent
 * lies BEFORE the page therefore has that parent's run covering `firstIndex`
 * too — the parent is an ancestor of the page's first operation — and so is
 * every ancestor of that parent. The ancestors of the first operation are
 * thus exactly the operations before the page that any of its operations,
 * top-level or nested, hangs from; each of them precedes the page, and none
 * of them is page content.
 *
 * Bounded by the walk's depth bound ({@link MAX_ICICLE_DEPTH}), since every
 * shown operation has one shown ancestor per level above it.
 *
 * @param shown The walk's shown operations.
 * @param firstIndex The page's first operation among them.
 * @returns The ancestors' shown indexes, outermost first; empty at a root.
 */
function contextIndexesOf(shown: readonly ShownRow[], firstIndex: number): readonly number[] {
  const indexes: number[] = [];
  let parentIndex = shown[firstIndex]?.parentShownIndex;

  while (parentIndex !== undefined && indexes.length <= MAX_ICICLE_DEPTH) {
    const ancestor = shown[parentIndex];
    if (ancestor === undefined) {
      break;
    }
    indexes.push(parentIndex);
    parentIndex = ancestor.parentShownIndex;
  }

  return indexes.reverse();
}

/**
 * The frame one shown operation of a walk is drawn and listed as — the single
 * construction both the drawn window and its context use, so an operation
 * reads the same whether it is drawn as page content or as context.
 *
 * @param walk The walk the operation belongs to.
 * @param shownIndex Its index among the walk's shown operations.
 * @returns Its frame, or `undefined` for an index the walk does not hold.
 */
function frameAt(walk: FlameWalk, shownIndex: number): FlameFrame | undefined {
  const entry = walk.shown[shownIndex];
  if (entry === undefined) {
    return undefined;
  }

  const { row, parentShownIndex } = entry;
  const { event } = row.node;
  const ancestry = ancestryOf(walk.shown, entry);
  const measured = measuredDurationMs(event.duration);

  return {
    frameId: entry.frameId,
    shownIndex,
    parentShownIndex,
    posInSet: entry.posInSet,
    setSize: walk.setSizes.get(parentShownIndex ?? ROOT_PARENT_KEY) ?? entry.posInSet,
    eventId: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    name: event.name,
    kind: event.kind,
    tier: event.tier,
    status: event.status,
    depth: row.depth,
    parentFrameId:
      parentShownIndex === undefined ? undefined : walk.shown[parentShownIndex]?.frameId,
    startTime: event.startTime,
    durationMs: usableDurationMs(event.duration),
    selfTimeMs: selfTimeMsOf(row.node),
    measuredDurationMs: measured,
    measuredSelfTimeMs: measured === undefined ? undefined : selfTimeMsOf(row.node),
    childCount: row.node.children.length,
    orphaned: row.orphaned,
    orphanReason: row.node.orphanReason,
    lineage: row.lineage,
    lineageAmbiguous: row.lineageAmbiguous,
    source: event.source,
    ancestry,
    // A shown frame has one shown ancestor per level above it, so its depth
    // is how many ancestors it has in all.
    ancestryTruncated: row.depth > ancestry.length,
    foldable: entry.foldable,
    folded: entry.folded,
    childrenBeyondDepth: row.childrenTruncated,
  };
}

/**
 * The frames of a page's context: {@link contextIndexesOf} made frames.
 *
 * @param walk The walk the page is cut from.
 * @param firstIndex The page's first operation among the walk's shown ones.
 * @returns The context frames, outermost first; empty at a root.
 */
function contextFramesOf(walk: FlameWalk, firstIndex: number): readonly FlameFrame[] {
  return contextIndexesOf(walk.shown, firstIndex).flatMap((index) => {
    const frame = frameAt(walk, index);
    return frame === undefined ? [] : [frame];
  });
}

/**
 * The label a context bar carries: {@link CONTEXT_WORD} before the operation's
 * name, fitted to the bar like any frame label — so what survives a narrow bar
 * is the marker first.
 *
 * @param name The operation's recorded name.
 * @param width The bar's drawn width, in user units.
 * @returns The fitted label, or `undefined` when none fits.
 */
function contextLabelText(name: string, width: number): string | undefined {
  return frameLabelText(`${CONTEXT_WORD}: ${name}`, width);
}

/**
 * The native tooltip of a context bar: the frame's own detail, then what the
 * bar is ({@link CONTEXT_BAR_NOTE}). The first line stays the operation's
 * name, as on every bar.
 *
 * @param frame The context frame.
 * @returns The tooltip text.
 */
function contextTooltipText(frame: FlameFrame): string {
  return `${frameTooltipText(frame)}\n${CONTEXT_BAR_NOTE}`;
}

/**
 * What the context band shows, as the canvas's text alternative and the
 * statement beside the paging controls say it: which rows of the chart are
 * context, and the chain they draw.
 *
 * @param context The window's context frames, outermost first.
 * @returns The sentence, or `undefined` for a window with no context.
 */
function contextSentence(context: readonly FlameFrame[]): string | undefined {
  if (context.length === 0) {
    return undefined;
  }

  const chain = context.map((frame) => truncate(frame.name, ROW_NAME_BUDGET)).join(' › ');
  return context.length === 1
    ? `The top row of the chart is drawn for context: ${chain}, the operation the drawn operations are nested inside, from an earlier window.`
    : `The top ${formatCount(context.length)} rows of the chart are drawn for context: ${chain}, the operations the drawn operations are nested inside, from an earlier window.`;
}

/**
 * Draws one window of a walk: at most {@link MAX_DRAWN_ROWS} of its shown
 * operations as frames, their bars packed into rows, and the axis.
 *
 * ## The budget is absolute
 *
 * The window is `windowRows` over the walk's shown operations at the budget,
 * so however large the trace and whichever page the reader is on, the icicle
 * and the tree beneath it are built from at most that many frames. The frames
 * of every other page are not built at all.
 *
 * ## Geometry is in the fixed logical canvas
 *
 * The time scale maps the WHOLE trace's window onto
 * `[0, CHART_VIEWBOX_WIDTH]` on every page, so a frame keeps its horizontal
 * place whichever window draws it, and the axis ticks are spaced over that
 * same range. Each frame's label is fitted to that frame's width in the same
 * units ({@link frameLabelText}). Nothing is read from the page, so the
 * drawing is a pure function of the walk and the window.
 *
 * ## Rows are packed, not assigned by depth alone
 *
 * Each depth's bars are packed into as many sub-rows as their drawn extents
 * need so that no two bars on one row overlap (see {@link packIcicleRows}); a
 * depth whose siblings are disjoint keeps a single row, and a depth crowded
 * past {@link MAX_DEPTH_ROWS} rows gathers what its sub-rows cannot hold into
 * "+N" marks on one overflow row. The extents are read in the same logical
 * units, after the scale's minimum-width clamp, so the packing answers for the
 * bars as they are painted. A window that opens below the root holds no frame
 * at the shallower depths, and those depths draw no row of the window's own.
 *
 * ## A window that opens below the root keeps its context
 *
 * Such a window's frames hang from operations an earlier window draws, and
 * without them a reader would not know where those frames sit. So the window's
 * context — every ancestor of its first frame, which is every operation before
 * the window that any of its frames is nested inside ({@link contextIndexesOf})
 * — is drawn as a band above the window's rows: one row per ancestor,
 * outermost first, each bar at its own place on the time scale, labelled with
 * {@link CONTEXT_WORD} and filled from outside the span-kind scale, so it
 * reads as context and not as the window's content. The band is bounded by the
 * depth bound, it is never counted by the window, and its frames are not rows
 * of the list: the budget above still bounds what the window itself draws.
 *
 * @param walk The walk to draw a window of.
 * @param start The first shown operation to draw; sanitised by `windowRows`.
 * @returns The window's frames, their bars packed into drawn rows, the axis
 * and every fact a note is rendered from.
 */
function drawWindow(walk: FlameWalk, start: number): FlameModel {
  const window = windowRows(walk.shown.length, start, MAX_DRAWN_ROWS);
  const { tree } = walk;

  if (tree === undefined || window.count === 0) {
    return EMPTY_MODEL;
  }

  const scale = timeScaleForTrace(tree, [0, CHART_VIEWBOX_WIDTH]);
  const axis = generateAxisTicks(scale);

  const frames: FlameFrame[] = [];
  const barsByDepth: UnrowedFrame[][] = [];
  let shownDepth = 0;

  // The context band first: one row per operation the window's frames are
  // nested inside that an earlier window draws, outermost at the top, each
  // bar at its own place on the trace's time scale — which spans the window's
  // frames, since an ancestor's interval contains its descendants'.
  const contextIndexes = contextIndexesOf(walk.shown, window.start);
  const context: FlameFrame[] = [];
  const contextBars: PlacedFrame[] = [];

  for (const shownIndex of contextIndexes) {
    const entry = walk.shown[shownIndex];
    const frame = frameAt(walk, shownIndex);
    if (entry === undefined || frame === undefined) {
      continue;
    }

    const { event } = entry.row.node;
    const geometry = placeSpanDuration(event.startTime, event.duration, scale);
    contextBars.push({
      frame,
      x: geometry.x,
      width: geometry.width,
      y: AXIS_BAND_HEIGHT + rowY(context.length),
      height: entry.row.height,
      label: contextLabelText(event.name, geometry.width),
    });
    context.push(frame);
  }

  for (let shownIndex = window.start; shownIndex < window.end; shownIndex += 1) {
    const entry = walk.shown[shownIndex];
    const frame = frameAt(walk, shownIndex);
    if (entry === undefined || frame === undefined) {
      continue;
    }

    const { row } = entry;
    const { event } = row.node;

    const order = frames.length;
    frames.push(frame);
    shownDepth = Math.max(shownDepth, row.depth);

    // The drawn extent — after the minimum-width clamp — is what row packing
    // reads, because a widened bar is what would paint over its neighbour.
    const geometry = placeSpanDuration(event.startTime, event.duration, scale);
    const unrowed: UnrowedFrame = {
      frame,
      order,
      x: geometry.x,
      width: geometry.width,
      height: row.height,
      label: frameLabelText(event.name, geometry.width),
    };

    const bucket = barsByDepth[row.depth];
    if (bucket === undefined) {
      barsByDepth[row.depth] = [unrowed];
    } else {
      bucket.push(unrowed);
    }
  }

  // Built through a defaulted read so a depth the window holds no frame at —
  // above a window that opens below the root — is an empty bucket, which packs
  // into no row, and never a hole in the array.
  const depthBars: readonly (readonly UnrowedFrame[])[] = Array.from(
    { length: shownDepth + 1 },
    (_unused, depth) => barsByDepth[depth] ?? [],
  );
  const packed = packIcicleRows(depthBars, scale.domainStart, contextBars.length);

  return {
    ...factsOf(walk),
    frames,
    context,
    contextBars,
    icicleRows: packed.rows,
    gathered: packed.gathered,
    overflowMarkCount: packed.markCount,
    // Sized by the rows actually drawn — the context band's and the window's —
    // which is the depth count only when no depth needed a second row.
    canvasHeight: AXIS_BAND_HEIGHT + layoutHeight(contextBars.length + packed.rows.length),
    ticks: axis.ticks,
    shownDepth,
    window,
  };
}

/**
 * Every note this view owes its reader, in the order they are shown.
 *
 * The honesty note comes first because it frames everything under it; the
 * reductions follow, each naming what is not on screen. A reduction with
 * nothing to report produces no note rather than a reassuring one.
 */
function notesFor(model: FlameModel): readonly string[] {
  const notes: string[] = [MEASURE_NOTE];

  // The row bound and the correlator's own truncation are partial results and
  // are stated in the partial-result notice instead (see `partialSentencesFor`);
  // the depth bound is a note, because showing more rows does not lift it.
  if (model.depthClamped) {
    notes.push(DEPTH_BOUND_NOTE);
  }
  // The row bound on a crowded depth draws marks in place of bars, so it is
  // stated whenever it gathered anything — and never otherwise.
  const compaction = compactionSentence(model);
  if (compaction !== undefined) {
    notes.push(compaction);
  }
  if (model.foldCount > 0) {
    notes.push(
      `${formatCountOf(model.foldCount, SUBTREE_NOUN)} ${pluralize(
        model.foldCount,
        IS_VERB,
      )} folded, hiding ${pluralOperations(model.foldedAway)}. Expand a row to see ${pluralize(
        model.foldedAway,
        OBJECT_PRONOUN,
      )}.`,
    );
  }
  if (model.rootCount > 1) {
    notes.push(
      `This trace has ${formatCount(model.rootCount)} roots, so part of it was captured without the work that started it.`,
    );
  }
  if (model.orphanCount > 0) {
    notes.push(
      `${pluralOperations(model.orphanCount)} ${pluralize(
        model.orphanCount,
        WAS_VERB,
      )} re-attached to the trace root because ${pluralize(
        model.orphanCount,
        ORPHAN_CAUSE,
      )}; ${pluralize(model.orphanCount, ORPHAN_MARKING)}.`,
    );
  }
  if (model.duplicateCount > 0) {
    notes.push(
      `${formatCountOf(model.duplicateCount, SPAN_ID_NOUN)} ${pluralize(
        model.duplicateCount,
        WAS_VERB,
      )} recorded more than once in this trace.`,
    );
  }

  return notes;
}

/** Whether a window leaves part of its walk undrawn, so its statement and controls are owed. */
function isWindowed(window: RowWindow): boolean {
  return window.count < window.total;
}

/**
 * Which operations the drawn window holds, as the sentence beside its controls
 * and the canvas's text alternative both state it: "Operations 2,001–4,000 of
 * 9,500 are drawn; 2,000 before and 5,500 after are not." — counted among the
 * shown operations, which is what the controls page over. Only the sides that
 * hold undrawn operations are named, and a one-operation window names its one
 * operation.
 *
 * @param window The drawn window.
 * @returns The sentence.
 */
function windowSentence(window: RowWindow): string {
  const total = formatCount(window.total);
  const drawn =
    window.count === 1
      ? `Operation ${formatCount(window.start + 1)} of ${total} is drawn`
      : `Operations ${formatCount(window.start + 1)}–${formatCount(window.end)} of ${total} are drawn`;

  const undrawn: string[] = [];
  if (window.before > 0) {
    undrawn.push(`${formatCount(window.before)} before`);
  }
  if (window.after > 0) {
    undrawn.push(`${formatCount(window.after)} after`);
  }

  return undrawn.length === 0
    ? `${drawn}.`
    : `${drawn}; ${undrawn.join(' and ')} ${pluralize(window.before + window.after, IS_VERB)} not.`;
}

/**
 * What a walk bounded at the trace's own declared count left out, as the
 * partial-result notice and the canvas's text alternative both state it. The
 * declared count is not repeated, because it is the number that was wrong.
 */
function walkBoundSentence(model: FlameModel): string {
  return `This trace holds more operations than it reports, so only the first ${pluralOperations(
    model.walkedCount,
  )} of it are listed.`;
}

/**
 * The partial-result notice's sentences, or none when every operation of the
 * trace is held here: a walk the trace's own count bounded, then the
 * correlator's own truncation, which only a narrower query or capture can
 * lift. The drawn window is not among them — every operation it leaves out is
 * one page away — and is stated beside its own controls instead.
 */
function partialSentencesFor(model: FlameModel): readonly string[] {
  const sentences: string[] = [];

  if (model.walkBounded) {
    sentences.push(walkBoundSentence(model));
  }
  if (model.treeTruncated) {
    sentences.push(TRUNCATED_TRACE_NOTE);
  }

  return sentences;
}

/** Where a tick's label sits relative to its rule, so no label overhangs. */
function tickAnchor(index: number, count: number): 'start' | 'middle' | 'end' {
  if (index === 0) {
    return 'start';
  }
  if (index === count - 1) {
    return 'end';
  }
  return 'middle';
}

/**
 * The index, among a walk's shown operations, of the one the panel's
 * selection stands for, or `undefined` when nothing is selected or the
 * selected event is not shown (a folded subtree, a frame past the depth bound,
 * another trace).
 *
 * Searched over the whole walk, not the drawn window, so a selection made in
 * another view is found on whichever page draws it. The operation carrying the
 * selected event id wins. Failing that, the first that names the same trace
 * **and** the same span — the other pairing `matchesPanelSelection` accepts —
 * so a selection reported by a view that drew the span under another record's
 * id still lands here. At most one operation is returned, so the picture and
 * the list mark the same single frame even for a span id the correlator saw
 * twice.
 *
 * @param shown The walk's shown operations, in order.
 * @param selection The panel's selection, as `useViewSelection` returns it.
 * @returns The selected operation's shown index, if it is shown.
 */
function shownIndexOfSelection(
  shown: readonly ShownRow[],
  selection: PanelSelection | undefined,
): number | undefined {
  if (selection === undefined) {
    return undefined;
  }

  const byEventId = shown.findIndex((entry) => entry.row.node.event.id === selection.eventId);
  if (byEventId >= 0) {
    return byEventId;
  }

  // Without both hints the pairing can only match by event id, already tried.
  if (selection.traceId === undefined || selection.spanId === undefined) {
    return undefined;
  }

  const bySpan = shown.findIndex((entry) => {
    const { event } = entry.row.node;
    return matchesPanelSelection(selection, {
      eventId: event.id,
      spanId: event.spanId,
      traceId: event.traceId,
    });
  });

  return bySpan >= 0 ? bySpan : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * The text equivalent: a bounded, paged tree
 *
 * The rows beneath the canvas are a `role="tree"` of flat `role="treeitem"`
 * rows. Flat rather than nested groups, because only one page of them is in
 * the document: each row states its place in the hierarchy itself — its level
 * (`aria-level`), its position among ALL the shown operations that share its
 * parent, on whichever page they are drawn (`aria-posinset` of
 * `aria-setsize`), whether its subtree is open (`aria-expanded`, on a row that
 * can fold) and whether it is the selected frame (`aria-selected`) — so a
 * reader is told the same structure whichever rows happen to be rendered.
 *
 * ## One tab stop
 *
 * The tree is ONE composite widget and so ONE stop in the page's Tab order —
 * a roving tab index: exactly one rendered row carries `tabIndex={0}`, the
 * active row, which starts on the selected frame or else the first row and
 * follows focus. The disclosure control, the name and the source chip inside
 * a row stay real pointer-activatable buttons but carry `tabIndex={-1}`; the
 * keyboard reaches their intents from the row:
 *
 *   - **ArrowDown / ArrowUp** — the next and previous operation, turning the
 *     tree's page when the step leaves it and paging the drawn window when
 *     the step leaves that.
 *   - **Home / End** — the trace's first and last operation, likewise.
 *   - **ArrowRight** — open a folded row, then step into its first child.
 *   - **ArrowLeft** — fold an open row, then step out to its parent, on
 *     whichever page the parent is drawn.
 *   - **Enter / Space** — select the frame (`onSelectEvent`).
 *   - **Shift+Enter** — open the frame's source (`onOpenSource`), on a row
 *     that resolved to one while the host offers the action; advertised
 *     through `aria-keyshortcuts` on exactly those rows.
 *   - **Escape** — dismiss the row's revealed detail until focus leaves it.
 *
 * The row's full detail — ancestry and provenance included — is its
 * accessible name, a pointer tooltip on its name, and, for the keyboard, the
 * same detail revealed by that name's own `Tooltip`, held open by the row
 * (its controlled `open`) while the row itself holds focus that no pointer
 * press caused. The primitive places that bubble exactly as it places a
 * hovered one, so it opens at the name and follows a scroll of the list,
 * rather than painting at the viewport's corner as an unplaced fixed bubble
 * would. It describes nothing then (`describesTrigger={false}`, so it is
 * `aria-hidden`): a screen reader already hears the detail as the row's name.
 *
 * ## Pages of rows, turned explicitly
 *
 * The drawn window can hold thousands of frames, and one list row per frame is
 * tens of thousands of elements. So the tree renders, in normal flow, ONE PAGE
 * of at most {@link TREE_ROW_BUDGET} of those rows: `../utils/scale`'s
 * `windowRows` over the drawn window's frames — the shown operations, so a
 * fold shortens what is paged — at an aligned start, `windowStartFor` of the
 * row holding the tab stop. The page therefore always holds the tab stop, and
 * the tab stop is always a rendered row. Three things turn it:
 *
 *   - **The row controls.** "Previous rows" and "Next rows" beneath the tree
 *     move the tab stop to the first row of the page before or after
 *     (`previousWindowStart`, `nextWindowStart`) without moving focus, so a
 *     pointer reaches every row — and every source chip — of the drawn
 *     window. Each is disabled at its end, and a control disabled by its own
 *     activation hands its focus to the other one (or, were neither left, to
 *     the tab stop), exactly as the operations controls do. A polite
 *     statement beside them names the page: "Rows 61–120 of 2,000 in this
 *     list are shown."
 *   - **The keys.** A key that moves the tab stop past either edge of the page
 *     turns it to the page holding the row it reached.
 *   - **A selection made elsewhere.** It takes the tab stop to its row, and so
 *     the page to the page holding it.
 *
 * The tab stop — and so the page — belongs to one drawn window of one query
 * (the `identity` prop): a newly drawn window or a changed query opens on its
 * first page, unless the key or the selection that caused the change carried
 * the tab stop to a row of it. Paging is a count, not a measurement — nothing
 * about the list's viewport or its rows is read — so it renders identically in
 * a browser and in a test DOM. The rows sit inside the package's shared scroll
 * viewport (`dg-virtual-viewport`, whose block size the stylesheet caps) and
 * list canvas (`dg-virtual-canvas`), which is the tree itself. `DataTable` is
 * not composed here because it is a flat grid: it has no levels and no
 * folding, which are the whole of this view's structure.
 * ---------------------------------------------------------------------------
 */

/**
 * The text-row budget: the most rows of the tree one page mounts, 60.
 *
 * The count `../primitives/DataTable` renders whole, and several times what
 * this list's scroll cap in `../styles/components.css` shows at once — about a
 * dozen rows — so a page can be scrolled through before a control or a key
 * turns it, while a drawn window of thousands of frames never mounts more
 * than this many rows of controls at once.
 */
const TREE_ROW_BUDGET = 60;

/** The control that turns the tree to the page of rows before its own. */
const PREVIOUS_ROWS_LABEL = 'Previous rows';

/** The control that turns the tree to the page of rows after its own. */
const NEXT_ROWS_LABEL = 'Next rows';

/** The chord that opens a row's source, as `aria-keyshortcuts` spells it. */
const OPEN_SOURCE_SHORTCUT = 'Shift+Enter';

/** The same chord, as the keys `Kbd` draws. */
const OPEN_SOURCE_KEYS: readonly string[] = ['Shift', 'Enter'];

/** The controls nested inside a row, which own their own clicks and keys. */
const NESTED_CONTROL_SELECTOR = 'button, a[href], input, select, textarea';

/** The attribute a treeitem carries its index among the drawn window's rows in. */
const FRAME_INDEX_ATTRIBUTE = 'data-frame-index';

/** What a row says when the depth bound, rather than a fold, hid its children. */
const DEPTH_BOUND_ROW_NOTE = `nested calls below ${String(MAX_ICICLE_DEPTH)} levels are not shown`;

/**
 * One row of the tree: a drawn frame and its accessible name. Its place in the
 * hierarchy — level, parent, position among ALL of its siblings — is the
 * frame's own, counted over the whole walk (see {@link walkTrace}).
 */
interface FlameTreeItem {
  /** The frame the row lists. */
  readonly frame: FlameFrame;
  /** Its accessible name: every fact the row and its detail carry. */
  readonly description: string;
}

/** The tree's rows and a frame-id lookup into them, from one pass. */
interface FlameTreeIndex {
  /** The rows, one per drawn frame, in the order the canvas draws them. */
  readonly items: readonly FlameTreeItem[];
  /** Frame id to row index. */
  readonly indexById: ReadonlyMap<string, number>;
}

/**
 * The row the reader last moved the tab stop to in the tree — by a key, a
 * click, focus or a row control — the selection that was in force when they
 * did, and the tree it was moved in.
 *
 * The selection is recorded so a NEWER selection — one made on the canvas or
 * in another view after the reader navigated — takes the tab stop back to its
 * own row, while the reader's position wins for as long as the selection has
 * not changed since (see `FlameFrameTree`'s `activeIndex`). The identity is
 * recorded so a move belongs to one drawn window of one query: under any other
 * it is not read, and it is discarded, so the tree opens on its first page
 * there and does not jump back to an old position when the reader pages the
 * drawn window back to it.
 */
interface TreeNavigation {
  /** The frame the reader moved to. */
  readonly frameId: string;
  /** The selected frame's id when they did; `undefined` for none. */
  readonly selectionKey: string | undefined;
  /** The tree the move was made in: {@link treeIdentityFor} of its drawn window. */
  readonly identity: string;
}

/**
 * Where a step past the drawn window's edge landed: the operation's frame id,
 * and the identity of the drawn window that holds it — the window the step
 * pages to, so the tab stop the step sets is read there.
 */
interface TreeReach {
  /** The frame id of the operation stepped to. */
  readonly frameId: string;
  /** {@link treeIdentityFor} of the drawn window holding it. */
  readonly identity: string;
}

/** Which of the tree's row controls turned its page, for the focus handoff. */
type RowControlSide = 'previous' | 'next';

/** The one reveal a selection is owed, as `FlameFrameTree` tracks it. */
interface SelectionReveal {
  /** The selected frame the reveal was armed for, or `undefined` for none. */
  frameId: string | undefined;
  /** Whether that frame's row still has to be scrolled into view. */
  pending: boolean;
}

/** The treeitem an event landed in, and its index. */
interface TreeItemHit {
  /** The row's index among the drawn window's rows. */
  readonly index: number;
  /** The treeitem element itself. */
  readonly element: HTMLElement;
}

/**
 * A frame's accessible name: the facts its row shows and the ones only its
 * detail shows, in one sentence.
 *
 * It names recorded operations and measured durations only — see the note at
 * the top of this module.
 */
function frameDescription(frame: FlameFrame): string {
  const parts: string[] = [
    frame.name,
    `${formatKindLabel(frame.kind)}, ${formatTierLabel(frame.tier)}`,
    `duration ${formatShownDuration(frame.measuredDurationMs)}`,
    `own time ${formatShownDuration(frame.measuredSelfTimeMs)}`,
    pluralNestedCalls(frame.childCount),
  ];

  if (frame.status === 'error') {
    parts.push(formatStatusLabel(frame.status));
  }
  if (frame.ancestry.length > 0) {
    parts.push(`inside ${ancestryBreadcrumb(frame)}`);
  }
  if (frame.childrenBeyondDepth) {
    parts.push(DEPTH_BOUND_ROW_NOTE);
  }

  const provenance = provenanceOf(frame);
  const facts = parts.join(' · ');
  return provenance === undefined ? facts : `${facts}. ${provenance}`;
}

/**
 * Indexes the drawn frames once: one row each, with its accessible name, and
 * the frame-id lookup the marks and the tab stop resolve through.
 *
 * @param frames The drawn frames, in traversal order.
 * @returns The rows and the frame-id lookup.
 */
function buildTreeIndex(frames: readonly FlameFrame[]): FlameTreeIndex {
  const indexById = new Map<string, number>();
  const items = frames.map((frame, index): FlameTreeItem => {
    indexById.set(frame.frameId, index);
    return { frame, description: frameDescription(frame) };
  });

  return { items, indexById };
}

/**
 * The identity of the tree one drawn window of one query lists: what a
 * {@link TreeNavigation} is tagged with, so the tab stop — and the page it
 * holds — belongs to exactly one such tree.
 *
 * @param queryIdentity The node and query the drawn window was paged for.
 * @param windowStart The drawn window's first operation among the shown ones.
 * @returns The identity.
 */
function treeIdentityFor(queryIdentity: string, windowStart: number): string {
  return `${queryIdentity}@${String(windowStart)}`;
}

/**
 * The page of the tree's rows that renders in the document: the aligned page
 * of at most {@link TREE_ROW_BUDGET} rows that holds the tab stop.
 *
 * Holding the tab stop is a correctness requirement: a tab stop that is not in
 * the document leaves the tree unreachable by Tab. The page is aligned
 * (`windowStartFor`), so it is the very page the row controls reach by
 * `nextWindowStart` and `previousWindowStart` from the first one, and
 * `windowRows` keeps it inside the list — a list that a fold shortened under
 * the page shows its last page rather than nothing. A list of at most one
 * budget is one page and renders whole. Pure arithmetic over counts: nothing
 * about the list is measured.
 *
 * @param rowCount How many rows the drawn window holds.
 * @param activeIndex The row holding the tab stop, or `-1` with no rows.
 * @returns The page of rows to render.
 */
function treePageOf(rowCount: number, activeIndex: number): RowWindow {
  return windowRows(
    rowCount,
    windowStartFor(Math.max(activeIndex, 0), TREE_ROW_BUDGET),
    TREE_ROW_BUDGET,
  );
}

/**
 * Which rows of the tree a page holds, as the statement beside its row
 * controls says it: "Rows 61–120 of 2,000 in this list are shown." — counted
 * among the drawn window's rows, which is what the tree lists and what the
 * controls page over. A one-row page names its one row.
 *
 * @param page The rendered page, from {@link treePageOf}.
 * @returns The sentence.
 */
function treePageSentence(page: RowWindow): string {
  const total = formatCount(page.total);

  return page.count === 1
    ? `Row ${formatCount(page.start + 1)} of ${total} in this list is shown.`
    : `Rows ${formatCount(page.start + 1)}–${formatCount(page.end)} of ${total} in this list are shown.`;
}

/**
 * The treeitem of this tree an event landed in, if any.
 *
 * Read off the DOM rather than held per row: the target is already inside the
 * row it belongs to, and the row carries its own index.
 *
 * @param target The event's target.
 * @param tree The tree element the handler is attached to.
 * @returns The row and its index, or `undefined` outside every row.
 */
function treeItemAt(target: EventTarget, tree: Element): TreeItemHit | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const element = target.closest('[role="treeitem"]');
  if (!(element instanceof HTMLElement) || !tree.contains(element)) {
    return undefined;
  }

  const raw = element.getAttribute(FRAME_INDEX_ATTRIBUTE);
  const index = raw === null ? Number.NaN : Number(raw);

  return Number.isInteger(index) && index >= 0 ? { index, element } : undefined;
}

/**
 * The rendered treeitem at a row index, if that row is in the document.
 *
 * @param viewport The tree's scroll container, or `null` before it mounts.
 * @param index The row's index among the drawn window's rows.
 * @returns The treeitem element, or `undefined` when it is not rendered.
 */
function treeRowIn(viewport: Element | null, index: number): HTMLElement | undefined {
  const candidate = viewport?.querySelector(`[${FRAME_INDEX_ATTRIBUTE}="${String(index)}"]`);
  return candidate instanceof HTMLElement ? candidate : undefined;
}

/**
 * The options a row reveal hands the browser's own `scrollIntoView`.
 *
 * `container: 'nearest'` (CSSOM View) confines the scroll to the row's nearest
 * scroll container — the tree's own viewport — so the page never moves. It is
 * newer than the DOM library's `ScrollIntoViewOptions`, hence the widened type;
 * a browser that predates it ignores the member and scrolls by the least
 * distance in every ancestor instead, which still reveals the row.
 */
type RowRevealOptions = ScrollIntoViewOptions & {
  readonly container?: 'all' | 'nearest';
};

/**
 * Least-distance reveal: a row already in view stays put; one above or below
 * the visible band is brought just to its near edge.
 */
const ROW_REVEAL_OPTIONS: RowRevealOptions = {
  block: 'nearest',
  inline: 'nearest',
  container: 'nearest',
};

/**
 * Asks the browser to scroll a rendered row into its tree's viewport, moving
 * it as little as possible.
 *
 * The browser does the arithmetic from its own layout, so nothing here reads a
 * size, an offset or a scroll position. An environment whose elements have no
 * `scrollIntoView` (some test DOMs) is left as it is: there is no viewport to
 * scroll there, and the row is already in the document.
 *
 * @param row The rendered treeitem to reveal.
 */
function revealTreeRow(row: HTMLElement): void {
  if (typeof row.scrollIntoView !== 'function') {
    return;
  }

  row.scrollIntoView(ROW_REVEAL_OPTIONS);
}

/**
 * Whether an event came from a control nested inside a row rather than from
 * the row itself.
 *
 * Such a control — the disclosure button, the name, the source chip — owns its
 * own click and its own Enter and Space, so the row must not also act on them.
 */
function isNestedControlEvent(target: EventTarget, row: HTMLElement): boolean {
  if (!(target instanceof Element) || target === row) {
    return false;
  }

  const control = target.closest(NESTED_CONTROL_SELECTOR);
  return control !== null && control !== row && row.contains(control);
}

/**
 * A frame's detail, as the tooltip on its name shows it: name, kind, tier,
 * both durations, the nested-call count, its ancestry and its provenance.
 */
function frameDetail(frame: FlameFrame): ReactElement {
  const provenance = provenanceOf(frame);

  return (
    <>
      <Text as="span" size="sm" weight="medium">
        {frame.name}
      </Text>{' '}
      <Badge color={kindColorVar(frame.kind)}>{formatKindLabel(frame.kind)}</Badge>{' '}
      <Text as="span" size="xs" tone="muted">
        {formatTierLabel(frame.tier)}
      </Text>{' '}
      <Text as="span" size="xs" tone="muted">
        duration
      </Text>{' '}
      <DurationCell ms={frame.measuredDurationMs} size="sm" />{' '}
      <Text as="span" size="xs" tone="muted">
        own time
      </Text>{' '}
      <DurationCell ms={frame.measuredSelfTimeMs} size="sm" />{' '}
      <Text as="span" size="xs" tone="muted">
        {pluralNestedCalls(frame.childCount)}
      </Text>
      {frame.ancestry.length === 0 ? null : (
        <>
          {' '}
          <Text as="span" size="xs" tone="muted">
            {`inside ${ancestryBreadcrumb(frame)}`}
          </Text>
        </>
      )}
      {provenance === undefined ? null : (
        <>
          {' '}
          <Text as="span" size="xs" tone="muted">
            {provenance}
          </Text>
        </>
      )}
    </>
  );
}

/**
 * One row of a page's context, above the tree: an operation the page's rows
 * are nested inside, listed on an earlier page.
 *
 * A `listitem`, not a `treeitem`: it is not a row of this page, so it is kept
 * out of the tree — its level, its position and the tree's one tab stop all
 * belong to the page — and it holds no control. It is laid out as a tree row
 * is, indented by its own depth with the toggle's empty box in front, so the
 * chain reads as the path down to the page's first row; its name, kind, tier
 * and duration are in the muted tone, and the caption above the list says
 * what it is.
 *
 * @param frame The context frame.
 * @returns The list item.
 */
function contextRow(frame: FlameFrame): ReactElement {
  const depthStyle: CssVariableStyle = { '--dgc-depth': String(frame.depth) };

  return (
    <div
      key={frame.frameId}
      role="listitem"
      className="dg-flame__equivalent-row"
      style={depthStyle}
    >
      <span className="dg-flame__toggle" aria-hidden="true" />
      <Text as="span" size="sm" tone="muted">
        {truncate(frame.name, ROW_NAME_BUDGET)}
      </Text>
      <Badge color={kindColorVar(frame.kind)}>{formatKindLabel(frame.kind)}</Badge>
      <Text as="span" size="xs" tone="muted">
        {formatTierLabel(frame.tier)}
      </Text>
      <Text as="span" className="dg-visually-hidden">
        duration
      </Text>
      <DurationCell ms={frame.durationMs} size="sm" />
    </div>
  );
}

/** The props of {@link FlameFrameTree}. */
interface FlameFrameTreeProps {
  /** The drawn window's frames, in traversal order: one row each. */
  readonly frames: readonly FlameFrame[];
  /**
   * The drawn window over the walk's shown operations: where `frames` sit in
   * the whole walk, so a key that steps past either end of them knows which
   * operation it is stepping to.
   */
  readonly rowWindow: RowWindow;
  /**
   * The identity of the tree these frames make: {@link treeIdentityFor} of
   * the node's query and the drawn window's start. The tab stop, and with it
   * the page of rows, is kept only while it does not change.
   */
  readonly identity: string;
  /** The tree's accessible name. */
  readonly label: string;
  /**
   * The drawn frame the panel's shared selection stands for, if any — chosen
   * here, on the canvas or in another view. Its row carries the selected state
   * whenever it is rendered, and a selection that did not come from this tree
   * is scrolled into the tree's viewport once (see the section above).
   */
  readonly selectedFrameId: string | undefined;
  /**
   * The frame id of the operation the panel's selection stands for anywhere in
   * the walk, drawn or not — the selection's identity, which paging does not
   * change. A selection newer than the reader's last move in the tree takes
   * the tab stop to its row.
   */
  readonly selectionKey: string | undefined;
  /**
   * Moves the drawn window to the one holding the operation at `shownIndex`
   * among the walk's shown operations, and returns that operation's frame id
   * and the identity of the tree that window makes — or `undefined` when no
   * such operation exists. What a key that steps past the drawn window calls,
   * so the step lands on the operation it named.
   */
  readonly onReach: (shownIndex: number) => TreeReach | undefined;
  /**
   * The context of a page of rows that opens at the operation `shownIndex`
   * among the walk's shown operations: every operation its rows are nested
   * inside that an earlier page lists, outermost first
   * ({@link contextFramesOf}). Stable for one walk, so the context of a page
   * is computed once per page turn, not once per render.
   */
  readonly contextOf: (shownIndex: number) => readonly FlameFrame[];
  /**
   * The frame under the pointer on the canvas, if any. Its row carries
   * `dg-is-hovered` whenever it is rendered; the tree is not scrolled to it.
   */
  readonly hoveredFrameId: string | undefined;
  /** Selects a frame: the row's Enter, Space, click or name activation. */
  readonly onSelect: (frame: FlameFrame) => void;
  /** Folds or opens a frame's subtree: its disclosure control, ArrowRight or ArrowLeft. */
  readonly onToggle: (frame: FlameFrame) => void;
  /** Opens a location in the editor, when the host offers it: Shift+Enter. */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

/**
 * The keyboard-reachable text equivalent of the icicle: a paged tree with a
 * single roving tab stop. See the section above for its structure, its keys
 * and the page of rows it renders: the page that holds that stop.
 *
 * @param props The props, as documented on {@link FlameFrameTreeProps}.
 * @returns The scroll viewport holding the tree and, when the tree holds more
 * rows than one page, the row controls and statement beneath it.
 */
function FlameFrameTree(props: FlameFrameTreeProps): ReactElement {
  const {
    frames,
    rowWindow,
    identity,
    label,
    selectedFrameId,
    selectionKey,
    hoveredFrameId,
    onSelect: reportSelect,
    onToggle,
    onOpenSource,
    onReach,
    contextOf,
  } = props;

  const viewportRef = useRef<HTMLDivElement>(null);

  /** The id the context list's caption carries, which names the list. */
  const contextCaptionId = useId();

  /** Set by a key that moved the active row; spent when that row takes focus. */
  const focusPendingRef = useRef(false);

  /** Set by a pointer press, so the focus it causes reveals no detail. */
  const pointerFocusRef = useRef(false);

  /**
   * The row the keyboard, a click, focus or a row control last made active,
   * the selection it was made under and the tree it was made in.
   */
  const [navigation, setNavigation] = useState<TreeNavigation | undefined>(undefined);

  /** The two row controls, for the focus handoff when one is spent. */
  const previousRowsRef = useRef<HTMLButtonElement | null>(null);
  const nextRowsRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Which row control turned the page, read once the page it asked for has
   * rendered: that page's first row is revealed, and a control the page
   * disabled hands its focus on rather than dropping it to the document.
   */
  const rowsPagedFromRef = useRef<RowControlSide | undefined>(undefined);

  /** The row whose detail is revealed for the keyboard, by frame id. */
  const [revealedFrameId, setRevealedFrameId] = useState<string | undefined>(undefined);

  /**
   * The frame a row of this tree last selected, noted before the selection is
   * reported: the selection that comes back for it is one the reader made on a
   * row they are looking at, so it is never scrolled to. A ref, not state: it
   * changes nothing on screen.
   */
  const activatedFrameIdRef = useRef<string | undefined>(undefined);

  /**
   * The selection the reveal effect last armed for, and whether that reveal is
   * still owed. Mutated by the effect alone.
   */
  const selectionRevealRef = useRef<SelectionReveal>({ frameId: undefined, pending: false });

  /** Selects a frame from one of this tree's rows. */
  const onSelect = (frame: FlameFrame): void => {
    activatedFrameIdRef.current = frame.frameId;
    reportSelect(frame);
  };

  const { items, indexById } = useMemo(() => buildTreeIndex(frames), [frames]);
  const rowCount = items.length;

  // A move made in another tree — another drawn window, another query — is
  // not read here, and it is discarded, so the page opens at the top of this
  // tree and a reader who pages the drawn window back later finds its first
  // page rather than an old position. Discarded during this render (React's
  // documented way to adjust state from what a render observes): the next
  // pass finds no stale move and stores nothing. A move a key made INTO this
  // tree across the drawn window's edge carries this tree's identity already
  // (`onReach`), so it is kept.
  const storedNavigation =
    navigation !== undefined && navigation.identity === identity ? navigation : undefined;
  if (navigation !== undefined && storedNavigation === undefined) {
    setNavigation(undefined);
  }

  const navigatedIndex =
    storedNavigation === undefined ? undefined : indexById.get(storedNavigation.frameId);
  const selectedIndex = selectedFrameId === undefined ? undefined : indexById.get(selectedFrameId);

  // The tab stop: the reader's own last move while the selection is the one
  // they moved under; the selected row once a NEWER selection arrives — from
  // the canvas, another view or this tree's own activation — which is the row
  // a tree hands focus to on entry; the reader's row again while the selection
  // is not drawn; and the first row when neither is. A window paged by a key
  // or a control does not change the selection's identity, so it never takes
  // the stop from the row the reader stepped to.
  const navigationIsCurrent =
    storedNavigation !== undefined && storedNavigation.selectionKey === selectionKey;
  const activeIndex =
    rowCount === 0
      ? -1
      : ((navigationIsCurrent ? navigatedIndex : undefined) ??
        selectedIndex ??
        navigatedIndex ??
        0);
  const activeFrameId = items[activeIndex]?.frame.frameId;

  // The rendered rows: the page that holds the tab stop, so the stop is always
  // one of them, every key that moves it past an edge turns the page, and the
  // row controls turn it by moving the stop.
  const page = treePageOf(rowCount, activeIndex);
  const paged = isWindowed(page);

  // Where this page sits: the operations its rows are nested inside that an
  // earlier page lists — of this tree, or of an earlier drawn window. Read off
  // the page's first row alone, which is enough (see `contextIndexesOf`), and
  // recomputed only when the page opens at another operation.
  const firstShownIndex = items[page.start]?.frame.shownIndex;
  const pageContext = useMemo(
    () => (firstShownIndex === undefined ? [] : contextOf(firstShownIndex)),
    [contextOf, firstShownIndex],
  );

  /**
   * Makes the operation at `target` — an index among the WALK's shown
   * operations, not among the drawn rows — the active row, and asks for it to
   * take focus once it is rendered. A row of the drawn window on another page
   * of the tree turns the page to it, since the page is the one holding the
   * tab stop. An operation outside the drawn window is reached by paging the
   * window to it first (`onReach`), so ArrowDown past the last drawn row lands
   * on the first row of the next window, End on the trace's last operation,
   * and ArrowLeft on a parent drawn in an earlier window; the move is tagged
   * with the identity of the tree that window makes, so it is read there. The
   * target is clamped to the walk, so a key at either end stays put.
   */
  const moveActive = (target: number): void => {
    if (rowWindow.total === 0) {
      return;
    }

    const clamped = Math.min(Math.max(target, 0), rowWindow.total - 1);
    const local = clamped - rowWindow.start;
    const item = windowContains(rowWindow, clamped) ? items[local] : undefined;

    if (item !== undefined && local === activeIndex) {
      // Already the active row — a key pressed at an end of the trace, or from
      // a control inside the row: focus returns to the row itself, and there
      // is nothing to re-render or to leave pending.
      treeRowIn(viewportRef.current, local)?.focus();
      return;
    }

    const reached: TreeReach | undefined =
      item === undefined ? onReach(clamped) : { frameId: item.frame.frameId, identity };
    if (reached === undefined) {
      return;
    }

    focusPendingRef.current = true;
    setNavigation({ frameId: reached.frameId, selectionKey, identity: reached.identity });
  };

  /**
   * Turns the page to the one starting at row `start` — a row control's
   * activation — by moving the tab stop to that row. Focus stays on the
   * control, so the reader can keep turning; the effect below reveals the new
   * page's first row and hands the focus of a control the page disabled on.
   *
   * @param start The first row of the page to show, among the drawn rows.
   * @param side The control that asked for it.
   */
  const showRowsFrom = (start: number, side: RowControlSide): void => {
    const item = items[start];
    if (item === undefined || start === page.start) {
      return;
    }

    rowsPagedFromRef.current = side;
    focusPendingRef.current = false;
    setNavigation({ frameId: item.frame.frameId, selectionKey, identity });
  };

  const handlePreviousRows = (): void => {
    showRowsFrom(previousWindowStart(page), 'previous');
  };

  const handleNextRows = (): void => {
    showRowsFrom(nextWindowStart(page), 'next');
  };

  // Focus follows the active row, but only when a key asked for it, and only
  // in the commit that renders it: a step that turns the page or pages the
  // drawn window renders the row after the key was pressed, so the request
  // survives until then. Focusing the row is also what brings it into the
  // tree's viewport — the browser's own focus scrolling, not an offset
  // computed here.
  useEffect(() => {
    if (!focusPendingRef.current || activeIndex < 0) {
      return;
    }

    const candidate = treeRowIn(viewportRef.current, activeIndex);

    if (candidate === undefined) {
      return;
    }

    focusPendingRef.current = false;
    candidate.focus();
    // Keyed by the active FRAME as well as its index: a step into another
    // window can land on the same row index of a different page.
  }, [activeFrameId, activeIndex]);

  // A page turned by a row control, once it has rendered. Its first row — the
  // tab stop the control moved — is asked into the tree's viewport by the
  // least distance, so the new page opens at its top however far the reader
  // had scrolled the old one (the browser's arithmetic, not an offset computed
  // here). Then the focus handoff the operations controls make: a control
  // that can still turn keeps its focus, a reader who has moved elsewhere is
  // left there, and only the focus of a control this very page disabled is
  // handed on — to the other control, or, were neither left, to the tab stop.
  // Turning a page never changes how many rows there are, so it cannot remove
  // the controls; the tab stop takes the focus only if neither control can.
  useEffect(() => {
    const pagedFrom = rowsPagedFromRef.current;
    if (pagedFrom === undefined) {
      return;
    }
    rowsPagedFromRef.current = undefined;

    const stop = activeIndex < 0 ? undefined : treeRowIn(viewportRef.current, activeIndex);
    if (stop !== undefined) {
      revealTreeRow(stop);
    }

    const activated = pagedFrom === 'previous' ? previousRowsRef.current : nextRowsRef.current;
    const counterpart = pagedFrom === 'previous' ? nextRowsRef.current : previousRowsRef.current;
    if (activated !== null && !activated.disabled) {
      return;
    }

    const ownerDocument = viewportRef.current?.ownerDocument;
    const active = ownerDocument?.activeElement ?? null;
    if (active !== null && active !== activated && active !== ownerDocument?.body) {
      return;
    }

    if (counterpart !== null && !counterpart.disabled) {
      counterpart.focus();
      return;
    }
    stop?.focus();
  }, [activeFrameId, activeIndex]);

  // The selected row is brought into the tree's viewport when the SELECTION
  // moves to it from elsewhere — the canvas, another view, an evidence chip —
  // so a reader who picked a span somewhere else finds its row here without
  // hunting through a long list. The rules are `../primitives/DataTable`'s:
  //
  //   Once per selection: armed when the selected frame changes (the first
  //   commit counts) and spent when done.
  //   Never for this tree's own activation: that row is already in view.
  //   Only a rendered row, in the commit that renders it. A newer selection
  //   takes the tab stop, and the rendered page is the one holding the tab
  //   stop, so the selected row is rendered by the time this runs.
  //   By the browser, by the least distance (`revealTreeRow`): nothing here
  //   reads a size, an offset or a scroll position.
  //   Never focus, never the tab stop: the roving stop follows the reader's
  //   navigation first and the selection only until then (see `activeIndex`),
  //   and focus stays wherever the reader left it.
  useEffect(() => {
    const reveal = selectionRevealRef.current;

    if (reveal.frameId !== selectedFrameId) {
      const activatedHere =
        selectedFrameId !== undefined && activatedFrameIdRef.current === selectedFrameId;
      reveal.frameId = selectedFrameId;
      reveal.pending = selectedFrameId !== undefined && !activatedHere;
      activatedFrameIdRef.current = undefined;
    }

    if (!reveal.pending || selectedIndex === undefined) {
      return;
    }

    const row = treeRowIn(viewportRef.current, selectedIndex);
    if (row === undefined) {
      return;
    }

    reveal.pending = false;
    revealTreeRow(row);
  }, [selectedFrameId, selectedIndex]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const hit = treeItemAt(event.target, event.currentTarget);
    const item = hit === undefined ? undefined : items[hit.index];

    if (hit === undefined || item === undefined) {
      return;
    }

    const { frame } = item;
    const fromControl = isNestedControlEvent(event.target, hit.element);

    switch (event.key) {
      case 'Escape':
        // Consumed only when there was a revealed detail to dismiss: a dialog
        // or a picking mode above the tree needs Escape too.
        if (revealedFrameId === frame.frameId) {
          event.preventDefault();
          event.stopPropagation();
          setRevealedFrameId(undefined);
        }
        return;
      case 'Enter':
        // A control a pointer left focus on activates itself.
        if (fromControl) {
          return;
        }
        if (event.shiftKey) {
          // Consumed only when it does something — the exact chord, on a row
          // that resolved to a location, with a host to hand it to — and never
          // a selection: opening a file is not choosing a record.
          if (
            frame.source !== undefined &&
            onOpenSource !== undefined &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            onOpenSource(frame.source);
          }
          return;
        }
        event.preventDefault();
        onSelect(frame);
        return;
      case ' ':
        if (fromControl) {
          return;
        }
        // Space scrolls the viewport otherwise.
        event.preventDefault();
        onSelect(frame);
        return;
      // Every step is addressed in the WALK's shown operations (the frame's
      // `shownIndex`), so it reaches across the drawn window's edges.
      case 'ArrowDown':
        event.preventDefault();
        moveActive(frame.shownIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(frame.shownIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveActive(0);
        return;
      case 'End':
        event.preventDefault();
        moveActive(rowWindow.total - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (frame.foldable && frame.folded) {
          onToggle(frame);
          return;
        }
        // An open, foldable frame has children the walk showed, and in a
        // pre-order walk its first child is the very next shown operation.
        if (frame.foldable) {
          moveActive(frame.shownIndex + 1);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (frame.foldable && !frame.folded) {
          onToggle(frame);
          return;
        }
        if (frame.parentShownIndex !== undefined) {
          moveActive(frame.parentShownIndex);
        }
        return;
      default:
        return;
    }
  };

  // Any focus inside a row — the row itself from the keyboard or a click, or a
  // nested control a pointer landed on — makes that row active, so the tab
  // stop and the next arrow key follow it. The detail is revealed only for
  // focus of the row element itself that no pointer press caused.
  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>): void => {
    const fromPointer = pointerFocusRef.current;
    pointerFocusRef.current = false;

    const hit = treeItemAt(event.target, event.currentTarget);
    const item = hit === undefined ? undefined : items[hit.index];

    if (hit === undefined || item === undefined) {
      return;
    }

    focusPendingRef.current = false;
    setNavigation({ frameId: item.frame.frameId, selectionKey, identity });
    setRevealedFrameId(
      event.target === hit.element && !fromPointer ? item.frame.frameId : undefined,
    );
  };

  // Focus leaving a row element ends its reveal; the next row's focus, which
  // follows immediately when the arrow keys moved it, reveals that row's.
  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    pointerFocusRef.current = false;

    const hit = treeItemAt(event.target, event.currentTarget);
    if (hit !== undefined && event.target === hit.element) {
      setRevealedFrameId(undefined);
    }
  };

  const handlePointerDown = (): void => {
    pointerFocusRef.current = true;
  };

  // A click anywhere on a row that is not one of its controls selects it; the
  // name, the disclosure control and the source chip each do their own job.
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const hit = treeItemAt(event.target, event.currentTarget);
    const item = hit === undefined ? undefined : items[hit.index];

    if (
      hit === undefined ||
      item === undefined ||
      isNestedControlEvent(event.target, hit.element)
    ) {
      return;
    }

    onSelect(item.frame);
  };

  /**
   * One row, a treeitem owned by the tree directly. A plain function called
   * during this render.
   *
   * @param item The row.
   * @param index Its index among the drawn window's rows.
   */
  const renderItem = (item: FlameTreeItem, index: number): ReactElement => {
    const { frame } = item;
    const selected = frame.frameId === selectedFrameId;
    const revealed = frame.frameId === revealedFrameId;
    const canOpenSource = frame.source !== undefined && onOpenSource !== undefined;
    const depthStyle: CssVariableStyle = { '--dgc-depth': String(frame.depth) };

    // Out of the Tab order, as every control inside a row is: the row is the
    // tree's only stop, and Enter on it selects the same frame.
    const nameControl = (
      <Button
        variant="ghost"
        size="sm"
        tabIndex={-1}
        onClick={() => {
          onSelect(frame);
        }}
      >
        {truncate(frame.name, ROW_NAME_BUDGET)}
      </Button>
    );

    return (
      <div
        key={frame.frameId}
        role="treeitem"
        className={clsx(
          'dg-flame__equivalent-row',
          frame.frameId === hoveredFrameId && 'dg-is-hovered',
          selected && 'dg-is-selected',
          frame.orphaned && 'dg-is-orphan',
        )}
        style={depthStyle}
        aria-level={frame.depth + 1}
        aria-setsize={frame.setSize}
        aria-posinset={frame.posInSet}
        aria-expanded={frame.foldable ? !frame.folded : undefined}
        aria-selected={selected}
        aria-current={selected ? 'true' : undefined}
        aria-label={item.description}
        aria-keyshortcuts={canOpenSource ? OPEN_SOURCE_SHORTCUT : undefined}
        // The roving tab index: one row of the whole tree is in the Tab order,
        // and the rendered page is the one holding it, so it is always one of
        // them.
        tabIndex={index === activeIndex ? 0 : -1}
        data-frame-index={index}
      >
        {frame.foldable ? (
          <Button
            className="dg-flame__toggle"
            variant="ghost"
            size="sm"
            iconOnly
            aria-expanded={!frame.folded}
            // The kind follows the name, as in the waterfall's own
            // disclosures, so a browser request and the server request
            // answering it — one name, two frames — read apart.
            aria-label={
              frame.folded
                ? `Expand the ${pluralNestedCalls(frame.childCount)} inside ${frame.name} (${formatKindLabel(frame.kind)})`
                : `Collapse the ${pluralNestedCalls(frame.childCount)} inside ${frame.name} (${formatKindLabel(frame.kind)})`
            }
            icon={
              frame.folded ? (
                <ChevronRight aria-hidden="true" className="dg-icon" />
              ) : (
                <ChevronDown aria-hidden="true" className="dg-icon" />
              )
            }
            // Out of the Tab order: ArrowRight and ArrowLeft on the row are
            // the keyboard route to the same disclosure.
            tabIndex={-1}
            onClick={() => {
              onToggle(frame);
            }}
          />
        ) : (
          // An empty box in the toggle's place, which is what keeps a leaf's
          // name aligned with the foldable rows at its depth.
          <span className="dg-flame__toggle" aria-hidden="true" />
        )}

        {/* One `Tooltip` in two forms, so the name has exactly one
            `role="tooltip"` at all times and its button is never remounted
            — nor its focus lost — by the switch. For a pointer, or focus on
            the name itself, it is the primitive's own. For the keyboard —
            the treeitem itself focused — this row holds it open (`open`),
            with the Shift+Enter hint where it applies; the primitive places
            it like the hovered form, so it opens at the name and follows the
            list's scroll instead of painting at the viewport's corner, while
            the tree's own handler keeps Escape. It
            describes nothing then (`describesTrigger`), because the
            treeitem's name already carries the same facts and a reader must
            not hear them twice. Below the name in both forms, so a row's
            detail covers the rows after it rather than the ones above. */}
        <Tooltip
          className="dg-flame__tooltip"
          placement="bottom"
          open={revealed ? true : undefined}
          describesTrigger={!revealed}
          content={
            revealed ? (
              <>
                {frameDetail(frame)}
                {canOpenSource ? (
                  <>
                    {' · '}
                    <Kbd keys={OPEN_SOURCE_KEYS} /> opens the source
                  </>
                ) : null}
              </>
            ) : (
              frameDetail(frame)
            )
          }
        >
          {nameControl}
        </Tooltip>

        <Badge color={kindColorVar(frame.kind)}>{formatKindLabel(frame.kind)}</Badge>

        <Text as="span" size="xs" tone="muted">
          {formatTierLabel(frame.tier)}
        </Text>

        {frame.status === 'error' ? (
          <Badge tone="danger">{formatStatusLabel(frame.status)}</Badge>
        ) : null}

        {/* Both numbers are durations, so the one that is not labelled on
            screen is labelled for a reader: "own time" carries its own
            visible caption because it is the number a developer is least
            likely to guess the meaning of. */}
        <Text as="span" className="dg-visually-hidden">
          duration
        </Text>
        <DurationCell ms={frame.measuredDurationMs} size="sm" />

        <Text as="span" size="xs" tone="muted">
          own
        </Text>
        <DurationCell ms={frame.measuredSelfTimeMs} size="sm" />

        {frame.childrenBeyondDepth ? (
          <Text as="span" size="xs" tone="muted">
            {DEPTH_BOUND_ROW_NOTE}
          </Text>
        ) : null}

        {frame.source === undefined ? null : (
          <SourceLink location={frame.source} compact tabIndex={-1} />
        )}
      </div>
    );
  };

  return (
    <div className="dg-flame__equivalent">
      {/* The tree, then its row controls: the spacing between them is the
          layout primitive's, and the controls follow the tree in the Tab
          order, so the tree stays the next stop after the operations
          controls above the canvas. */}
      <Stack direction="vertical" gap={1}>
        {pageContext.length === 0 ? null : (
          // The page's context, outside the tree and above its scroll
          // container, so it stays in view while the page scrolls and no
          // reader — pointer or assistive technology — takes it for a row of
          // this page: a captioned list, named by its caption, of rows with
          // no control and no tab stop.
          <div>
            <Text as="p" size="xs" tone="muted" id={contextCaptionId}>
              {TREE_CONTEXT_CAPTION}
            </Text>
            <div role="list" aria-labelledby={contextCaptionId}>
              {pageContext.map(contextRow)}
            </div>
          </div>
        )}

        {/* The scroll container, deliberately role-less: the tree inside it
            owns the treeitems, and a role here would insert a foreign node
            between them. The stylesheet caps its height, so a page of rows
            scrolls inside it rather than lengthening the page. */}
        <div className="dg-virtual-viewport" ref={viewportRef}>
          <div
            role="tree"
            aria-label={label}
            className="dg-virtual-canvas"
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPointerDown={handlePointerDown}
            onClick={handleClick}
          >
            {/* The rendered page, sliced; its start is added back so each row
                keeps its TRUE index among the drawn window's rows. */}
            {items
              .slice(page.start, page.end)
              .map((item, offset) => renderItem(item, page.start + offset))}
          </div>
        </div>

        {paged ? (
          // The page and the controls that turn it, offered only while the
          // drawn window holds more rows than one page. The statement is
          // polite and live, so each page is announced — never
          // `role="status"`, which is the loading placeholder's — and it
          // keeps its element while the reader pages, because both controls
          // stay mounted: a control at the end of its side is disabled rather
          // than removed, and its focus is handed to the other one (see the
          // effect above). Real buttons, so a pointer and the keyboard turn
          // the page alike.
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Text as="p" size="xs" tone="muted" aria-live="polite">
              {treePageSentence(page)}
            </Text>
            <Button
              ref={previousRowsRef}
              variant="secondary"
              size="sm"
              disabled={page.before === 0}
              onClick={handlePreviousRows}
            >
              {PREVIOUS_ROWS_LABEL}
            </Button>
            <Button
              ref={nextRowsRef}
              variant="secondary"
              size="sm"
              disabled={page.after === 0}
              onClick={handleNextRows}
            >
              {NEXT_ROWS_LABEL}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </div>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * Nested span timing, drawn as an icicle and listed as text.
 *
 * @param props The props, as documented on {@link FlameChartProps}.
 * @returns The chart with its notes and its text equivalent, or the loading,
 * empty or error state the query's outcome calls for.
 *
 * @example A validated `flame` node inside a panel host.
 * ```tsx
 * <FlameChart node={node} />
 * ```
 */
export function FlameChart(props: FlameChartProps): ReactElement {
  const { node, className } = props;

  // Absent outside a host by documented contract, which is an ordinary value
  // here: every handler below chains through it.
  const actions = usePanelActions();

  const query = node.query;

  // A node whose source this view cannot read resolves nothing at all: passing
  // `undefined` to the hook keeps the call unconditional, as the rules of hooks
  // require, while the provider is never asked for a page that would be
  // undrawable. The error state below says so.
  const traceQuery = isTraceQuery(query) ? query : undefined;
  const { status, data, error, announcement, retry } = useQuery(traceQuery);

  /**
   * The event the `dg-is-selected` state marks: the panel's one shared
   * selection under a host — so a frame is marked when the timeline, a table
   * row or an evidence chip selected its span, and a frame activated here moves
   * their marks too — and this view's own last activation outside one.
   */
  const { selection, markSelected } = useViewSelection();

  /**
   * The frame under the pointer on the canvas, whose tree row carries
   * `dg-is-hovered` — the author-drawn hover detail a pointer user can dismiss,
   * where the frame's SVG title is the user agent's and cannot be. Kept by
   * frame id, so the mark lands whenever the bounded tree renders the row.
   */
  const [hoveredFrameId, setHoveredFrameId] = useState<string | undefined>(undefined);
  const hovering = hoveredFrameId !== undefined;

  /** The block: the document the hover's Escape listener is attached to. */
  const blockRef = useRef<HTMLDivElement | null>(null);

  /**
   * The subtrees the developer has explicitly opened or closed, by frame id.
   *
   * Explicit decisions only — a frame absent from the map takes the default for
   * its depth — so opening a deep subtree cannot be undone by a re-render, and
   * a host that persists disclosure through `onExpand` sees exactly the
   * decisions a developer made.
   */
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  // The shape check is what separates "the provider answered for another
  // source" from "the trace is empty": both would otherwise read as a blank
  // chart, and one of them is a bug in the host rather than a fact about the
  // capture. A `null` payload is the service's own answer for a capture in
  // which no trace matched the query — an empty capture, never a malformed one
  // — so it is told apart from a failed shape check before either is drawn.
  const emptyCapture = status === 'success' && data === null;
  const tree = looksLikeTraceTree(data) ? data : undefined;

  /**
   * The drawn window the reader has paged to, tagged with the query it was
   * paged for and the selection it had accounted for (see {@link WindowState}).
   */
  const [windowState, setWindowState] = useState<WindowState | undefined>(undefined);
  const queryIdentity = `${node.id}|${JSON.stringify(query)}`;
  const storedWindow =
    windowState !== undefined && windowState.identity === queryIdentity ? windowState : undefined;

  // The whole walk under the reader's folds: data and no geometry, rebuilt
  // only when the trace or a fold changes — never by paging.
  const walk = useMemo(() => walkTrace(tree, folds), [tree, folds]);

  // The selected operation anywhere in the walk, drawn or not, and its frame
  // id: the selection's identity, which paging does not change.
  const selectedShownIndex = useMemo(
    () => shownIndexOfSelection(walk.shown, selection),
    [walk, selection],
  );
  const selectionKey =
    selectedShownIndex === undefined ? undefined : walk.shown[selectedShownIndex]?.frameId;

  // A selection NEWER than the window — made on another view, or the one a
  // host starts with — whose operation the window does not draw moves the
  // window to the one holding it, so the frame and its row carry the mark the
  // reader asked for. Newer is what keeps a reader free to page away from a
  // selection: paging records the selection it was done under, and only a
  // different one moves the window again. The move is stored during this
  // render (React's documented way to adjust state from what a render
  // observes; the next pass finds the selection accounted for and stores
  // nothing), so it sticks when the selection is later cleared.
  const requestedWindow = windowRows(walk.shown.length, storedWindow?.start ?? 0, MAX_DRAWN_ROWS);
  const revealStart =
    selectedShownIndex !== undefined &&
    selectionKey !== storedWindow?.selectionKey &&
    !windowContains(requestedWindow, selectedShownIndex)
      ? windowStartFor(selectedShownIndex, MAX_DRAWN_ROWS)
      : undefined;
  if (revealStart !== undefined) {
    setWindowState({ identity: queryIdentity, start: revealStart, selectionKey });
  }
  const windowStart = revealStart ?? requestedWindow.start;

  // One model for both representations, cut from the walk at the window: the
  // canvas lays the frames out in its fixed logical space and fits their
  // labels there, so it is a pure function of the walk and the window. At most
  // `MAX_DRAWN_ROWS` frames.
  const model = useMemo(() => drawWindow(walk, windowStart), [walk, windowStart]);
  const rowWindow = model.window;
  const selectedFrameId =
    selectedShownIndex !== undefined && windowContains(rowWindow, selectedShownIndex)
      ? selectionKey
      : undefined;

  /** The two paging controls, for the focus handoff below. */
  const previousControlRef = useRef<HTMLButtonElement | null>(null);
  const nextControlRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Which paging control was activated, read once the window it asked for has
   * rendered: a control that paged to the last window on its side is disabled
   * by that very page, and the focus it held moves to the other control rather
   * than falling back to the document.
   */
  const pagedFromRef = useRef<'previous' | 'next' | undefined>(undefined);

  /** Moves the drawn window to `start`, under the selection in force. */
  const pageTo = useCallback(
    (start: number): void => {
      setWindowState({ identity: queryIdentity, start, selectionKey });
    },
    [queryIdentity, selectionKey],
  );

  const handlePrevious = useCallback((): void => {
    pagedFromRef.current = 'previous';
    pageTo(previousWindowStart(rowWindow));
  }, [pageTo, rowWindow]);

  const handleNext = useCallback((): void => {
    pagedFromRef.current = 'next';
    pageTo(nextWindowStart(rowWindow));
  }, [pageTo, rowWindow]);

  // The tree's way past the drawn window's edges: the operation a key stepped
  // to is paged into view, and its frame id is handed back — with the
  // identity of the tree the window it lands in makes — so the tree can put
  // the tab stop, its page and focus on it once it renders.
  const handleReach = useCallback(
    (shownIndex: number): TreeReach | undefined => {
      const target = walk.shown[shownIndex];
      if (target === undefined) {
        return undefined;
      }
      const start = windowContains(rowWindow, shownIndex)
        ? rowWindow.start
        : windowStartFor(shownIndex, MAX_DRAWN_ROWS);
      if (start !== rowWindow.start) {
        pageTo(start);
      }
      return { frameId: target.frameId, identity: treeIdentityFor(queryIdentity, start) };
    },
    [pageTo, queryIdentity, rowWindow, walk],
  );

  // The context of a page of the tree, read off the same walk the window is
  // cut from, so a page of rows and the drawn window it belongs to name their
  // context identically. Stable for one walk.
  const contextOfPage = useCallback(
    (shownIndex: number): readonly FlameFrame[] => contextFramesOf(walk, shownIndex),
    [walk],
  );

  useEffect(() => {
    const pagedFrom = pagedFromRef.current;
    if (pagedFrom === undefined) {
      return;
    }
    pagedFromRef.current = undefined;

    const activated =
      pagedFrom === 'previous' ? previousControlRef.current : nextControlRef.current;
    const counterpart =
      pagedFrom === 'previous' ? nextControlRef.current : previousControlRef.current;
    // A control that can still page keeps its focus, and a reader who has
    // moved elsewhere is left where they are: only the focus of a control this
    // page disabled is handed on.
    if (activated === null || !activated.disabled) {
      return;
    }
    const active = activated.ownerDocument.activeElement;
    if (active !== null && active !== activated && active !== activated.ownerDocument.body) {
      return;
    }
    counterpart?.focus();
  }, [model]);

  const handleSelect = useCallback(
    (frame: FlameFrame): void => {
      // Both hints are supplied because this view holds both: the receiver is
      // spared a lookup and can scope a trace-filtered view immediately.
      const ref: PanelEventRef = {
        eventId: frame.eventId,
        spanId: frame.spanId,
        traceId: frame.traceId,
      };
      // A no-op under a host, which records the report itself; this view's own
      // selection outside one.
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  const handleFrameEnter = useCallback((frameId: string): void => {
    setHoveredFrameId(frameId);
  }, []);

  // Only the frame that started the hover ends it, so a leave that arrives
  // after the pointer already entered a neighbouring frame changes nothing.
  const handleFrameLeave = useCallback((frameId: string): void => {
    setHoveredFrameId((current) => (current === frameId ? undefined : current));
  }, []);

  // Escape dismisses the hover detail (WCAG 1.4.13). The pointer does not move
  // focus, so the key goes to whatever holds focus — often the page body — and
  // the listener therefore lives on the view's own document, for exactly as
  // long as a frame is hovered. It consumes nothing, so a dialog or a shortcut
  // above the panel still sees the key, and it leaves alone an Escape that
  // something else already handled. The detail stays dismissed until the
  // pointer enters a frame again.
  useEffect(() => {
    if (!hovering) {
      return undefined;
    }

    const ownerDocument = blockRef.current?.ownerDocument ?? document;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setHoveredFrameId(undefined);
      }
    };

    ownerDocument.addEventListener('keydown', dismiss);
    return () => {
      ownerDocument.removeEventListener('keydown', dismiss);
    };
  }, [hovering]);

  const handleToggle = useCallback(
    (frame: FlameFrame): void => {
      // `expanded` is the state AFTER the gesture, which is what the host's
      // contract asks for: the report is idempotent and carries no parity to
      // track.
      const expanded = frame.folded;
      setFolds((previous) => {
        const next = new Map(previous);
        next.set(frame.frameId, expanded);
        return next;
      });
      actions?.onExpand?.(node.id, frame.frameId, expanded);
    },
    [actions, node.id],
  );

  // A node that validated cannot reach this branch: the catalog admits only
  // `trace` here. It is a defect in the panel rather than a failed request, so
  // the contract's unsupported-query copy states what this view reads next to
  // what it was asked for, and no retry is offered — asking again cannot
  // change the answer.
  if (traceQuery === undefined) {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__error">
          <ErrorState {...unsupportedQueryProps(node.type, query)} />
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__loading">
          <LoadingState variant="chart" label="Loading nested timing…" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__error">
          <ErrorState {...queryFailureProps({ error, announcement, retry }, traceQuery)} />
        </div>
      </div>
    );
  }

  // Only a non-null payload can be malformed; the service's `null` falls
  // through to the empty state below. The query succeeded, so there is no
  // provider error to compose from and no announcement was claimed: the
  // failure is built here, and it alerts as a lone failure does. It keeps the
  // retry, as a payload the host's check refused does — a provider that
  // answered in the wrong form once may answer in the right form next time.
  if (tree === undefined && !emptyCapture) {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__error">
          <ErrorState
            {...queryFailureProps(
              { error: malformedTraceError(), announcement: undefined, retry },
              traceQuery,
            )}
          />
        </div>
      </div>
    );
  }

  // One empty state for both ways a capture can hold nothing to draw: no trace
  // matched (`null`), or the trace that matched holds no frames.
  if (emptyCapture || model.frames.length === 0) {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__empty">
          <EmptyState
            title={EMPTY_TITLE}
            message={EMPTY_MESSAGE}
            icon={<Flame className="dg-icon" />}
          />
        </div>
      </div>
    );
  }

  const notes = notesFor(model);
  const partialSentences = partialSentencesFor(model);
  const windowed = isWindowed(rowWindow);
  const contextStatement = contextSentence(model.context);
  const listLabel = `${node.title ?? CATALOG_ENTRY.label}: ${pluralOperations(
    model.frames.length,
  )}, innermost last`;

  // The selected frame when an overflow mark gathered it instead of a sub-row
  // drawing it. Its bar is drawn on the overflow row, over its mark, so the
  // panel's shared selection is marked in the picture wherever it lands; the
  // rows themselves do not move, because the layout never depends on the
  // selection.
  const selectedGathered =
    selectedFrameId === undefined ? undefined : model.gathered.get(selectedFrameId);

  /** One frame's bar, its native tooltip and its label, as every row draws a frame. */
  const renderFrame = (bar: PlacedFrame): ReactElement => {
    const frameColor: CssVariableStyle = {
      '--dgc-frame-color': kindColorVar(bar.frame.kind),
    };
    // The label is text on the frame's fill, so it takes the ink paired with
    // that fill rather than one colour for every frame: no single ink clears
    // 4.5:1 on the whole kind scale.
    const frameInk: CssVariableStyle = {
      '--dgc-frame-ink': kindInkColorVar(bar.frame.kind),
    };
    // A fragment rather than a group per frame: a large trace draws thousands
    // of frames, and a wrapper element per bar would add as many nodes to the
    // document while styling nothing.
    return (
      <Fragment key={bar.frame.frameId}>
        <rect
          className={clsx(
            'dg-flame__frame',
            bar.frame.frameId === selectedFrameId && 'dg-is-selected',
            bar.frame.orphaned && 'dg-is-orphan',
          )}
          style={frameColor}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          // A named picture of one operation: the sentence its tree row is
          // named by, so a screen reader browsing the icicle hears what a
          // pointer hovering it sees. Not focusable — the tree is the keyboard
          // path.
          role="img"
          aria-label={frameDescription(bar.frame)}
          onClick={() => {
            handleSelect(bar.frame);
          }}
          onPointerEnter={() => {
            handleFrameEnter(bar.frame.frameId);
          }}
          onPointerLeave={() => {
            handleFrameLeave(bar.frame.frameId);
          }}
        >
          {/* The user agent's own tooltip, kept for the pointer. The
              author-drawn detail is the frame's tree row, which hovering the
              frame marks and Escape dismisses, whose name opens the full
              description on hover, and whose keyboard focus reveals it. */}
          <title>{frameTooltipText(bar.frame)}</title>
        </rect>
        {bar.label === undefined ? null : (
          <text
            className="dg-flame__frame-label"
            // The visible label repeats the start of the frame's name.
            aria-hidden="true"
            style={frameInk}
            x={bar.x + LABEL_INSET}
            y={bar.y + bar.height / 2}
          >
            {bar.label}
          </text>
        )}
      </Fragment>
    );
  };

  return (
    <div ref={blockRef} className={clsx('dg-flame', className)}>
      {notes.map((note) => (
        <Text key={note} as="p" size="xs" tone="muted" className="dg-flame__note">
          {note}
        </Text>
      ))}

      {partialSentences.length === 0 ? null : (
        // Beside the canvas it qualifies, in the shape the timeline and the
        // dependency graph share: the badge and what is not held here, with
        // the refine route. No control, because nothing more is in memory.
        <Stack direction="horizontal" gap={2} align="center" wrap>
          <Badge tone="warning" variant="outline">
            {PARTIAL_RESULT_LABEL}
          </Badge>
          <Text as="p" size="xs" tone="muted">
            {partialSentences.join(' ')}
          </Text>
        </Stack>
      )}

      {windowed ? (
        // The drawn window and the controls that page it. The statement is
        // polite and live, so each page is announced — never `role="status"`,
        // which is the loading placeholder's — and it keeps its element while
        // the reader pages, because both controls stay mounted: a control at
        // the end of its side is disabled rather than removed, and its focus is
        // handed to the other one (see the effect above).
        <Stack direction="horizontal" gap={2} align="center" wrap>
          <Text as="p" size="xs" tone="muted" aria-live="polite">
            {windowSentence(rowWindow)}
          </Text>
          <Button
            ref={previousControlRef}
            variant="secondary"
            size="sm"
            disabled={rowWindow.before === 0}
            onClick={handlePrevious}
          >
            {PREVIOUS_WINDOW_LABEL}
          </Button>
          <Button
            ref={nextControlRef}
            variant="secondary"
            size="sm"
            disabled={rowWindow.after === 0}
            onClick={handleNext}
          >
            {NEXT_WINDOW_LABEL}
          </Button>
        </Stack>
      ) : null}

      {windowed ? (
        // What the context band at the top of the chart is, beside the window
        // it belongs to. Mounted for as long as the window is, and polite and
        // live like the window's statement, so paging into a window that opens
        // below the root announces the chain it sits in; empty — and visually
        // hidden — on a window that opens at a root and so has none.
        <Text
          as="p"
          size="xs"
          tone="muted"
          aria-live="polite"
          className={contextStatement === undefined ? 'dg-visually-hidden' : undefined}
        >
          {contextStatement ?? ''}
        </Text>
      ) : null}

      <div className="dg-flame__viewport">
        {/* A figure with a text alternative, whose every frame and "+N" mark
            is a named image: a screen reader browsing the picture hears each
            operation's full description, the same sentence its tree row and
            its native tooltip carry. The frames are not focusable — the tree
            beneath is the keyboard path — and the axis and the visible labels,
            which repeat what the names say, are hidden from assistive
            technology.

            One fixed logical space, whatever the container: the `viewBox` is
            `CHART_VIEWBOX_WIDTH` units wide and exactly as tall as the drawn
            rows, the element takes its container's width (`width="100%"`)
            and declares the drawing's logical height, and
            `xMinYMin meet` scales it uniformly from its top-left corner —
            never stretching a bar or a label out of proportion. Nothing reads
            the element's size; see the module note. */}
        <svg
          className="dg-flame__canvas"
          role="figure"
          aria-label={canvasTextAlternative(model, node.title)}
          viewBox={`0 0 ${String(CHART_VIEWBOX_WIDTH)} ${String(model.canvasHeight)}`}
          width="100%"
          height={model.canvasHeight}
          preserveAspectRatio="xMinYMin meet"
        >
          <g className="dg-flame__axis" aria-hidden="true">
            {model.ticks.map((tick, index) => {
              const x = alignHairline(tick.offset);
              return (
                <g key={tick.value}>
                  <line
                    className="dg-flame__axis-tick"
                    x1={x}
                    y1={AXIS_BAND_HEIGHT - AXIS_TICK_LENGTH}
                    x2={x}
                    y2={AXIS_BAND_HEIGHT}
                  />
                  <text
                    className="dg-flame__axis-label"
                    x={x}
                    y={AXIS_LABEL_BASELINE}
                    textAnchor={tickAnchor(index, model.ticks.length)}
                  >
                    {tick.label}
                  </text>
                </g>
              );
            })}
          </g>

          {model.contextBars.map((bar, contextIndex) => {
            // The context band: the operations this window's frames are
            // nested inside, one row each above the window's own rows. Filled
            // from outside the span-kind scale, labelled "Context: …" and
            // titled as context, and marked `data-flame-context` so the
            // picture's one class contract stays unchanged. Activating one
            // selects it, which pages the window to the one that draws it.
            const contextColor: CssVariableStyle = { '--dgc-frame-color': CONTEXT_FILL_VAR };
            const contextInk: CssVariableStyle = { '--dgc-frame-ink': CONTEXT_INK_VAR };
            return (
              <g className="dg-flame__row" key={`context-${String(contextIndex)}`}>
                <rect
                  className="dg-flame__frame"
                  data-flame-context="true"
                  style={contextColor}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  // A named picture like every frame of the window: the
                  // frame's description, then that it is drawn for context.
                  role="img"
                  aria-label={`${frameDescription(bar.frame)} ${CONTEXT_BAR_NOTE}`}
                  onClick={() => {
                    handleSelect(bar.frame);
                  }}
                >
                  <title>{contextTooltipText(bar.frame)}</title>
                </rect>
                {bar.label === undefined ? null : (
                  <text
                    className="dg-flame__frame-label"
                    aria-hidden="true"
                    style={contextInk}
                    x={bar.x + LABEL_INSET}
                    y={bar.y + bar.height / 2}
                  >
                    {bar.label}
                  </text>
                )}
              </g>
            );
          })}

          {model.icicleRows.map((row, rowIndex) => (
            // The drawn row's position is its identity, so it is also the
            // key: a fold changes which frames a row holds, and rows are
            // numbered top to bottom whatever they hold.
            <g className="dg-flame__row" key={rowIndex}>
              {row.frames.map(renderFrame)}
              {row.marks.map((mark) => {
                // The selected frame, when this mark gathered it: drawn over
                // the mark at its own extent, in place of the mark's count,
                // which the two would otherwise both claim the band for.
                const selectedHere =
                  selectedGathered?.markKey === mark.key ? selectedGathered.bar : undefined;
                return (
                  <Fragment key={mark.key}>
                    <rect
                      className="dg-flame__overflow"
                      x={mark.x}
                      y={mark.y}
                      width={mark.width}
                      height={mark.height}
                      role="img"
                      aria-label={mark.title}
                    >
                      {/* How many operations the band stands for, and where
                          each of them is still listed one by one. */}
                      <title>{mark.title}</title>
                    </rect>
                    {mark.label === undefined || selectedHere !== undefined ? null : (
                      <text
                        className="dg-flame__overflow-label"
                        aria-hidden="true"
                        x={mark.x + LABEL_INSET}
                        y={mark.y + mark.height / 2}
                      >
                        {mark.label}
                      </text>
                    )}
                    {selectedHere === undefined ? null : renderFrame(selectedHere)}
                  </Fragment>
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      {/* The text equivalent: every drawn frame as a treeitem, indented by its
          depth, in the same order the canvas draws them. It is the keyboard
          path and the screen-reader path, and it carries every frame the
          canvas draws — anything neither shows is named in a note above. It
          is ONE tab stop and renders one page of rows, the page holding that
          stop, with the row controls that turn it by pointer or keyboard (see
          `FlameFrameTree`); the shared selection and the frame under the
          pointer are handed to it by frame id, so a row carries its marks
          whenever it is rendered, and its identity names this drawn window of
          this query, so a new one opens on its first page. */}
      <FlameFrameTree
        frames={model.frames}
        rowWindow={rowWindow}
        identity={treeIdentityFor(queryIdentity, rowWindow.start)}
        label={listLabel}
        selectedFrameId={selectedFrameId}
        selectionKey={selectionKey}
        hoveredFrameId={hoveredFrameId}
        onSelect={handleSelect}
        onToggle={handleToggle}
        onOpenSource={actions?.onOpenSource}
        onReach={handleReach}
        contextOf={contextOfPage}
      />
    </div>
  );
}
