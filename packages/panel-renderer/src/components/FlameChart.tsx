/**
 * `FlameChart` — nested SPAN TIMING drawn as an icicle, plus the readable list
 * that carries the same hierarchy in text (AAP 0.6.2, node catalog type
 * `flame`).
 *
 * ## WHAT THIS VIEW IS, AND WHAT IT IS NOT
 *
 * AAP 0.6.6 records this component as a deliberate gap with a stated
 * resolution: the product has no profiler, samples no call stacks and measures
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
 * ## THE CANVAS IS LAID OUT IN CSS PIXELS
 *
 * `../utils/measure`'s `useChartCanvas` reports the inner width of the scroll
 * viewport, and the canvas is drawn exactly that wide with a `viewBox` of the
 * same size (`resolveCanvasWidth` in `../utils/scale`), so one user unit is one
 * CSS pixel. A frame's `x` and width are its share of the trace's window in
 * real pixels, and the text is never scaled: the 11 px label role renders at
 * 11 px, with square glyphs, at every panel width. A viewport narrower than
 * `MIN_CANVAS_WIDTH` scrolls the canvas horizontally instead of squeezing it.
 * The measurement is taken while the viewport's ref attaches, before the first
 * paint, and is kept current by a `ResizeObserver` inside the hook. Row packing
 * (above) reads the bars at those widths, so a resize that widens or narrows
 * the minimum-width bars re-packs the rows it changes.
 *
 * A frame's label is fitted to its frame by measuring it in the label font
 * (`fitTextToWidth`): the longest grapheme prefix that fits, ending in an
 * ellipsis, or no label at all. A character budget cannot do this — glyph
 * advances differ, an emoji is about two columns wide — and a budget that is
 * wrong by one glyph paints the ellipsis past the frame, where nobody sees it.
 *
 * The only other measurement is the text equivalent's rows, taken by
 * `@tanstack/react-virtual` after they have painted: the tree renders a bounded
 * window of rows before any measurement arrives, so it too is complete on its
 * first paint and under a test DOM.
 *
 * ## WITHOUT LAYOUT, A FIXED COORDINATE SPACE
 *
 * Where no width can be measured — a test DOM without layout reports zero —
 * the canvas lays out at `DEFAULT_CANVAS_WIDTH` user units, declares
 * `width="100%"` and stretches that drawing across its container
 * (`preserveAspectRatio="none"`, so the frames still span the container and
 * the rows keep their pitch). Labels are fitted by the measure's deterministic
 * estimate, which errs towards "does not fit". Every coordinate in that mode is
 * a round per-mille of the trace's window, which is what the layout-free suite
 * asserts against. A browser that lays the panel out leaves the mode in the
 * commit that mounts the viewport.
 *
 * ## THE CHART IS AN IMAGE; THE LIST IS THE INTERFACE
 *
 * The `<svg>` is `role="img"` with a text alternative summarising the trace, so
 * assistive technology is told what the picture shows rather than being walked
 * through hundreds of `<rect>` elements. Beneath it, **every frame** is a row
 * of an indented `role="tree"`: its name on a real `Button`, its kind, its
 * tier, its measured duration, its own time, a source chip where the span
 * resolved to a place in the project, and a disclosure control where its
 * subtree can fold. That tree is the keyboard path, the screen-reader path and
 * the path a test asserts against (AAP 0.6.4 puts accessibility above visual
 * fidelity), and it is complete: a frame the chart draws is a row the tree
 * carries, and a frame neither shows is named in a note rather than dropped.
 *
 * The tree is ONE tab stop with a roving tab index, as the waterfall's is —
 * the arrow keys move between rows, open and fold subtrees, Enter selects and
 * Shift+Enter opens the source — and it is VIRTUALIZED (AAP 0.6.1: long lists
 * virtualize through `@tanstack/react-virtual`): only the rows in its scroll
 * viewport are in the document, plus the active row, which stays rendered when
 * scrolled away so it keeps focus and the tab stop, while each row still
 * states its level and its position among its siblings. See `FlameFrameTree`
 * for both.
 *
 * ## EVIDENCE IS NEVER DROPPED, AND NEVER QUIETLY
 *
 * The `trace` source answers with a whole {@link TraceTree}, not a page, so
 * there is no server page to load and no honest way to show part of a trace
 * silently. Every reduction is reported above the chart.
 *
 * Two reductions are PARTIAL RESULTS and share one notice — the "Partial
 * result" badge the timeline uses, a sentence saying what is shown and a way to
 * see more. The layout's own row bound (`../utils/scale`'s
 * `DEFAULT_MAX_TRACE_ROWS`) is stated as "Showing N of M operations", where M
 * is the trace's own node count, with a "Show more operations" control that
 * raises the bound by the same step for as long as the trace holds more (once
 * a step shows everything, the notice goes and focus moves from its control to
 * the tree's tab stop); the bound returns to its default whenever the node's
 * query changes. A walk the depth bound ended is never reported as row-bounded,
 * since no larger bound would show more of it. A trace the
 * correlator itself bounded says so and gives the refine route instead —
 * narrowing the query or capturing a shorter interaction — because nothing
 * more of it is held in memory to show.
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
 * knows no URL (AAP 0.1.2, 0.4.2). Selecting a frame reports a
 * `PanelEventRef`; a source chip, and Shift+Enter on its row, forward its
 * location field for field; folding a subtree reports `onExpand` with this
 * node's id.
 *
 * The selected frame is not this view's to keep. It is the panel host's one
 * shared selection, read through `useViewSelection` and matched with
 * `matchesPanelSelection` (by event id, or by the same trace and span), so the
 * frame and the timeline bar of one span are always marked together and a
 * selection made in either moves both. Outside a host the view falls back to
 * its own last activation.
 *
 * ## APPEARANCE IS A CLASS CONTRACT (AAP 0.6.4)
 *
 * Every colour, length, font and radius lives in `../styles/components.css` and
 * resolves to a `--dg-*` token. This file contributes two kinds of inline value
 * and no others: the `--dgc-*` custom properties the stylesheet consumes with a
 * token fallback, and unitless SVG geometry, which is the permitted structural
 * form. The classes:
 *
 *   `dg-flame`                    the block
 *   `dg-flame__note`              a provenance or honesty note above the chart
 *   `dg-flame__viewport`          the scroll container the canvas sits in
 *   `dg-flame__canvas`            the `<svg>`
 *   `dg-flame__axis`              the time axis group
 *   `dg-flame__axis-tick`         one tick rule
 *   `dg-flame__axis-label`        one tick label
 *   `dg-flame__row`               one drawn row of the icicle: a depth, or one
 *                                 sub-row of a depth whose siblings overlap
 *   `dg-flame__frame`             one frame, filled from `--dgc-frame-color`
 *   `dg-flame__frame-label`       the label drawn inside a frame, inked from
 *                                 `--dgc-frame-ink` (the ink paired with the
 *                                 frame's fill, so the label clears 4.5:1)
 *   `dg-flame__equivalent`        the text equivalent: a virtualized tree in
 *                                 the shared `dg-virtual-viewport`,
 *                                 `dg-virtual-canvas` and `dg-virtual-row`
 *   `dg-flame__equivalent-row`    one frame's treeitem, indented by
 *                                 `--dgc-depth`
 *   `dg-flame__toggle`            a row's disclosure control, or the empty box
 *                                 a leaf holds in its place so names align
 *   `dg-flame__tooltip`           the slot a row's tooltip is positioned in
 *   `dg-is-selected`              the selected frame and its row
 *   `dg-is-hovered`               the row of the frame under the pointer
 *   `dg-is-orphan`                a re-attached record (the canonical state name)
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
 * Both marks are keyed by frame id, not by rendered row, because the tree is
 * virtualized and the marked row may be outside its window: the mark lands the
 * moment the row renders. The hovered row is never scrolled to — the list
 * would jump under a pointer sweeping the canvas — while a selection made
 * anywhere but the tree itself scrolls its row into the tree's viewport once.
 *
 * @see ../utils/scale for every coordinate: the canvas width, the time scale,
 * the depth layout, the bounded traversal and the axis ticks.
 * @see ../utils/measure for the viewport width and the label measure.
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
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Flame } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { kindColorVar, kindInkColorVar } from '../utils/color';
import {
  ELLIPSIS,
  countedNoun,
  formatCount,
  formatCountOf,
  formatDuration,
  formatKindLabel,
  formatStatusLabel,
  formatTierLabel,
  pluralize,
  truncate,
} from '../utils/format';
import { fitTextToWidth, useChartCanvas } from '../utils/measure';
import type { TextMeasure } from '../utils/measure';
import type { CountedNoun } from '../utils/format';
import {
  DEFAULT_MAX_TRACE_ROWS,
  alignHairline,
  flattenTraceRows,
  generateAxisTicks,
  isMeasuredWidth,
  layoutHeight,
  placeSpanDuration,
  resolveCanvasWidth,
  rowY,
  timeScaleForTrace,
} from '../utils/scale';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * Every constant below is in SVG user units, the permitted structural form of
 * AAP 0.6.4 — not a CSS length and not a design token. A measured canvas maps
 * one user unit to one CSS pixel, so these are pixel distances on screen; the
 * unmeasured fallback stretches them horizontally with the rest of its
 * drawing. The canvas width is not a constant at all: it is the viewport's
 * measured width, resolved per render by `resolveCanvasWidth`. The vertical
 * rhythm is NOT restated here either: row height and row gutter come from
 * `../utils/scale`, so this view shares one pitch with the timeline and the
 * waterfall.
 * ---------------------------------------------------------------------------
 */

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
 * The graceful degradation AAP asks of a very large trace. A frame at or below
 * this depth that has children starts folded behind its own disclosure
 * control, so a deep trace opens as something a reader can take in and every
 * folded frame is one activation away from its detail. The fold is always
 * announced (`aria-expanded`), always reversible, and always counted in a note.
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
 * may read (AAP 0.6.2).
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
 * naming a framework, a route or a component of any particular project (AAP
 * 0.5.2, 0.5.4) and none of it can imply a sampling profile (AAP 0.6.6).
 * ---------------------------------------------------------------------------
 */

/** The honesty note AAP 0.6.6 requires on screen. */
const MEASURE_NOTE =
  'Each bar is one recorded operation: its width is the duration that was measured and its children are the operations it made.';

/** The empty state's message: a successful query that found no trace. */
const EMPTY_MESSAGE = 'No trace was captured for this interaction.';

/** The empty state's title: the short label above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No trace';

/*
 * The error states take their title, lead, query block and layout from the one
 * contract in `../host/useQuery` (`queryFailureProps`, `unsupportedQueryProps`,
 * `formatDataQuery`), so this view words a failure exactly as every other node
 * does (B1-F16, B2-F14). The host's response check (`../host/DataProvider`)
 * already refuses a trace missing any member this view reads, so that refusal
 * reaches this view as an ordinary failed query. The shape guard below stays
 * as defence in depth — a member present but of the wrong type still passes
 * the host's presence check — and words its refusal with the host's own
 * sentence and hint (`unreadableDataMessage`, `REFUSED_RESPONSE_HINT`), so a
 * reader meets one fault in one form whichever check caught it. The one string
 * of its own is the shape it requires, for the diagnostics.
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

/** The control that raises the traversal's row bound by one step. */
const SHOW_MORE_LABEL = 'Show more operations';

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
  /** The measured duration, in milliseconds. */
  readonly durationMs: number;
  /** The duration minus the interval union of the children, in milliseconds. */
  readonly selfTimeMs: number;
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

/** Everything one resolved trace yields: both representations and their notes. */
interface FlameModel {
  /** Every shown frame, in the traversal's order — the list's rows. */
  readonly frames: readonly FlameFrame[];
  /**
   * The icicle's drawn rows, top to bottom, each holding frames that never
   * overlap one another. A depth whose frames overlap in time — or only once
   * the minimum visible width widened them — occupies several consecutive
   * rows, and every row of depth `d` sits above every row of depth `d + 1`
   * (see {@link packIcicleRows}).
   */
  readonly icicleRows: readonly (readonly PlacedFrame[])[];
  /** The canvas height the rows and the axis occupy, in user units. */
  readonly canvasHeight: number;
  /** The axis ticks, with their positions and labels. */
  readonly ticks: readonly {
    readonly value: number;
    readonly offset: number;
    readonly label: string;
  }[];
  /** How many frames a fold is hiding. */
  readonly foldedAway: number;
  /** How many subtrees are folded. */
  readonly foldCount: number;
  /**
   * How many operations this view holds: every frame the traversal visited
   * within its bounds, shown or folded away. The `N` of "Showing N of M".
   */
  readonly walkedCount: number;
  /**
   * Whether the traversal stopped at its row bound with more of the trace in
   * memory — the reduction "Show more operations" lifts.
   */
  readonly rowBounded: boolean;
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
  /** How many nodes the trace holds, at every depth. */
  readonly nodeCount: number;
  /** The greatest depth shown. */
  readonly shownDepth: number;
}

/** The model an unresolved, empty or unusable trace yields. */
const EMPTY_MODEL: FlameModel = {
  frames: [],
  icicleRows: [],
  canvasHeight: AXIS_BAND_HEIGHT,
  ticks: [],
  foldedAway: 0,
  foldCount: 0,
  walkedCount: 0,
  rowBounded: false,
  depthClamped: false,
  treeTruncated: false,
  orphanCount: 0,
  rootCount: 0,
  duplicateCount: 0,
  totalDurationMs: 0,
  nodeCount: 0,
  shownDepth: 0,
};

/**
 * The coordinate system one render lays the icicle out in.
 *
 * Resolved by the component from its viewport's measurement on every render,
 * and a dependency of the model's memo, so a resize re-lays the frames and a
 * render that changes nothing reuses them.
 */
interface FlameCanvas {
  /**
   * The canvas width in user units: the viewport's inner width in CSS pixels
   * when it has been measured, else `DEFAULT_CANVAS_WIDTH`.
   */
  readonly width: number;
  /**
   * Measures a string in the frame labels' font, in user units: the rendered
   * font's canvas metrics where the platform has them, else the deterministic
   * estimate. Stable until the font changes, so it is a sound memo dependency.
   */
  readonly measureText: TextMeasure;
}

/**
 * An inline style object that may carry `--dgc-*` custom properties.
 *
 * React's `CSSProperties` is an interface, so TypeScript infers no index
 * signature for it and a literal holding a custom property is not assignable to
 * it. Nothing but a `--dgc-*` value may appear in an object of this type: a
 * colour, a length or a radius here would be the hardcoded CSS value AAP 0.6.4
 * forbids, and a value the stylesheet can compute itself belongs in
 * `../styles/components.css`.
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
 * panel, which is exactly the silent failure AAP 0.5.5 rules out — so the shape
 * is checked once, here, and a payload that fails becomes an error state.
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
 * never read as a measured one (AAP 0.4.2).
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
 * The chart is `role="img"`, so this text is a convenience for a pointer user;
 * the same facts reach a keyboard or screen-reader user through the row's own
 * tooltip and cells in the text equivalent, which is the representation that
 * must be complete.
 */
function frameTooltipText(frame: FlameFrame): string {
  const lines: string[] = [frame.name];

  lines.push(`${formatKindLabel(frame.kind)} · ${formatTierLabel(frame.tier)}`);
  lines.push(`Duration ${formatDuration(frame.durationMs)}`);
  lines.push(`Own time ${formatDuration(frame.selfTimeMs)}`);
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
 * The canvas's text alternative: what the picture shows, in one sentence.
 *
 * It describes recorded operations and measured durations, and it never
 * describes samples, stacks or a profile — see the note at the top of this
 * module.
 */
function canvasTextAlternative(model: FlameModel, title: string | undefined): string {
  const heading = title === undefined ? CATALOG_ENTRY.label : title;
  const levels = model.shownDepth + 1;
  const shape = `${heading}: ${pluralOperations(model.frames.length)} nested ${formatCountOf(
    levels,
    LEVEL_NOUN,
  )} deep, ${formatDuration(model.totalDurationMs)} from the first to the last.`;

  // A partial picture says so in the same words the notice beside it uses.
  const partial: string[] = [];
  if (model.rowBounded) {
    partial.push(rowBoundSentence(model));
  }
  if (model.treeTruncated) {
    partial.push('The trace itself arrived incomplete.');
  }

  return partial.length === 0 ? shape : `${shape} ${partial.join(' ')}`;
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
 * A node's own time: its measured duration minus the **interval union** of its
 * direct children, clipped to its own window.
 *
 * ## Why a union and not a sum
 *
 * Children overlap as a matter of routine — one interaction can issue several
 * requests in parallel (AAP 0.4.2) — and two 400 ms calls that ran side by side
 * account for 400 ms of their parent's time, not 800 ms. Subtracting a sum
 * would report a negative own time for such a parent, and a negative width is
 * either clipped to nothing or drawn inverted: either way the reader is shown
 * something false about where the time went. So the children's intervals are
 * merged and the length of the merge is what is subtracted.
 *
 * ## Why each child is clipped to the parent's window first
 *
 * A child can legitimately fall partly outside its parent's window: the browser
 * agent and the dev-server preload read their clocks independently (AAP 0.2.3),
 * and a call the parent did not await can outlive it. Time outside the parent's
 * window is not the parent's to account for. A child that clips to nothing is
 * dropped, which also excludes a non-finite bound, since every comparison
 * against one is false.
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
 * The name is fitted by its measured advance in the label font, never by a
 * character count: `fitTextToWidth` keeps the whole name when it fits the bar
 * less {@link LABEL_INSET} on each side, and otherwise the longest grapheme
 * prefix that fits with an ellipsis appended. So a label never extends past its
 * bar, a truncated label's ellipsis is always inside the bar where a reader can
 * see it, and a cut never splits an emoji, a flag or a combining sequence. A
 * character budget could promise none of that: glyph advances differ (an emoji
 * is about two columns wide), and a budget wrong by one glyph paints the
 * ellipsis past the edge.
 *
 * A bar too narrow for a legible fragment carries no label at all — one
 * narrower than {@link MIN_LABEL_WIDTH}, or one that cannot hold
 * {@link MIN_LABEL_CHARS} graphemes and the ellipsis — because a sliver of a
 * name identifies nothing, and text painted past a bar's edge reads as
 * belonging to its neighbour.
 *
 * @param name The operation's recorded name.
 * @param width The bar's width, in the canvas's user units.
 * @param measureText Measures a string in the label font, in the same units.
 * @returns The text to draw, or `undefined` for no label.
 */
function frameLabelText(name: string, width: number, measureText: TextMeasure): string | undefined {
  if (!(width >= MIN_LABEL_WIDTH)) {
    return undefined;
  }

  return fitTextToWidth(name, width - LABEL_INSET * 2, measureText, {
    minGraphemes: MIN_LABEL_CHARS,
  })?.text;
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
 * overlap by construction (AAP 0.4.2), and a run of short operations that each
 * had to be widened to the minimum visible width can overlap once drawn even
 * though their measured windows did not. Drawn on one row, the later bar
 * paints over the earlier one and a reader sees one frame inside another — a
 * nesting the capture never recorded.
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
 * Assigns every bar its drawn row: each depth packed into sub-rows, and the
 * sub-rows numbered in depth-major order.
 *
 * Depth-major is what keeps the icicle an icicle: every sub-row of depth `d`
 * sits above every sub-row of depth `d + 1`, so a parent is always drawn above
 * each of its children and a reader still follows causality downward. A depth
 * with no overlaps keeps exactly one row, so a trace whose siblings never
 * overlap draws precisely as a one-row-per-depth icicle would.
 *
 * The vertical rhythm is `../utils/scale`'s: row `n` of the result sits at
 * `rowY(n)` below the axis band.
 *
 * @param barsByDepth The shown bars grouped by depth, dense from the root.
 * @returns The drawn rows, top to bottom, each with its bars left to right.
 */
function packIcicleRows(
  barsByDepth: readonly (readonly UnrowedFrame[])[],
): readonly (readonly PlacedFrame[])[] {
  const rows: PlacedFrame[][] = [];

  for (const bars of barsByDepth) {
    for (const lane of packDepthBars(bars)) {
      const y = AXIS_BAND_HEIGHT + rowY(rows.length);
      rows.push(
        lane.map((bar) => ({
          frame: bar.frame,
          x: bar.x,
          width: bar.width,
          y,
          height: bar.height,
          label: bar.label,
        })),
      );
    }
  }

  return rows;
}

/**
 * Turns a resolved trace into the two representations this component renders.
 *
 * ## One traversal, top-down, bounded, and not recursive
 *
 * `../utils/scale`'s `flattenTraceRows` performs the walk over an explicit
 * stack, so a malformed or deeply recursive tree cannot overflow the
 * JavaScript call stack of a DevTools panel, and it preserves the canonical
 * sibling order the
 * correlator settled — parent before child, then start time, then the
 * producer's sequence, then the store's arrival number. Nothing here re-sorts
 * it: an order that differs between two views of one capture is unreadable.
 *
 * ## Folding is a filter over the full walk, never a shorter walk
 *
 * The traversal always visits the whole tree (within its depth and size
 * bounds), and a fold hides rows *afterwards* by ancestry. That is what keeps
 * every frame's identity — and therefore a host's persisted disclosure state —
 * stable while subtrees open and close: a row's index is a property of the
 * trace, not of what happens to be unfolded.
 *
 * ## Ancestry is collected on the way down
 *
 * A trace node has no parent pointer, so the walk's `parentRowIndex` is used to
 * extend the parent's own chain as each row is produced. A parent always
 * precedes its children in a pre-order walk, so the chain is always available
 * by the time a child needs it, and no row is ever searched for upward.
 *
 * ## Geometry is in the canvas's own units
 *
 * The time scale maps the trace's window onto `[0, canvas.width]`, and the axis
 * ticks are spaced over that same range, so a measured canvas places every
 * frame and tick in CSS pixels and a narrow one carries fewer ticks rather
 * than overlapping labels. Each frame's label is fitted to that frame's width
 * with `canvas.measureText`, which measures in the same units.
 *
 * ## Rows are packed, not assigned by depth alone
 *
 * Each depth's bars are packed into as many sub-rows as their drawn extents
 * need so that no two bars on one row overlap (see {@link packIcicleRows}); a
 * depth whose siblings are disjoint keeps a single row. The extents are read
 * in the same canvas units, after the scale's minimum-width clamp, so the
 * packing answers for the bars as they are painted at this width: a narrower
 * canvas widens more short bars to the minimum and may need more sub-rows.
 *
 * ## The row bound is the caller's, and it is reported exactly
 *
 * The traversal walks ONE operation past `maxRows` and keeps only the first
 * `maxRows` rows (its `visibleRows` window). Whether it produced that extra
 * operation is the exact answer to "does the trace hold more than this view
 * shows" — which the layout's `truncated` flag cannot give, because the depth
 * bound sets it too — and it costs one node rather than a second walk. The
 * model says so (`rowBounded`) and carries the count it holds and the trace's
 * own node count, which is what the partial-result notice states. The depth
 * bound is reported separately (`depthClamped`), because raising the row bound
 * does not lift it.
 *
 * @param tree The resolved trace, read and never mutated.
 * @param folds Which frames the developer has explicitly opened or closed, by
 * frame id; a frame absent from the map takes the default for its depth.
 * @param canvas The coordinate system to lay the icicle out in, and the
 * measure its labels are fitted with.
 * @param maxRows The most operations this view shows.
 * @returns The frames, their bars packed into drawn rows, the axis and every
 * count a note is rendered from.
 */
function buildModel(
  tree: TraceTree | undefined,
  folds: ReadonlyMap<string, boolean>,
  canvas: FlameCanvas,
  maxRows: number,
): FlameModel {
  if (tree === undefined || tree.nodeCount === 0 || tree.roots.length === 0) {
    return EMPTY_MODEL;
  }

  const layout = flattenTraceRows(tree, {
    maxDepth: MAX_ICICLE_DEPTH,
    maxRows: maxRows + 1,
    visibleRows: maxRows,
  });
  const scale = timeScaleForTrace(tree, [0, canvas.width]);
  const axis = generateAxisTicks(scale);

  const frames: FlameFrame[] = [];
  const barsByDepth: UnrowedFrame[][] = [];

  /**
   * Every visited row's name, its named ancestor chain and how many ancestors
   * it has in all, by row index — the last so a chain cut to
   * {@link MAX_ANCESTRY_NAMES} can say that it was.
   */
  const nameByRow: string[] = [];
  const ancestryByRow: (readonly string[])[] = [];
  const ancestorCountByRow: number[] = [];

  /** Rows hidden because an ancestor is folded, and rows that are folded. */
  const hiddenRows = new Set<number>();
  const foldedRows = new Set<number>();

  /** Span ids already used as a frame id, so a duplicate cannot collide. */
  const usedSpanIds = new Set<string>();

  /** Every shown row's frame id, by row index, so a child can name its parent. */
  const frameIdByRow: (string | undefined)[] = [];

  let foldedAway = 0;
  let shownDepth = 0;
  let depthClamped = false;

  for (const row of layout.rows) {
    const { event } = row.node;
    const parentIndex = row.parentRowIndex;
    const parentName = parentIndex === undefined ? undefined : nameByRow[parentIndex];
    const parentAncestry = parentIndex === undefined ? undefined : ancestryByRow[parentIndex];
    const ancestry =
      parentName === undefined
        ? []
        : [...(parentAncestry ?? []), parentName].slice(-MAX_ANCESTRY_NAMES);
    const ancestorCount =
      parentIndex === undefined || parentName === undefined
        ? 0
        : (ancestorCountByRow[parentIndex] ?? 0) + 1;

    nameByRow[row.rowIndex] = event.name;
    ancestryByRow[row.rowIndex] = ancestry;
    ancestorCountByRow[row.rowIndex] = ancestorCount;

    // Read before the fold check: a clamp inside a folded subtree is still a
    // clamp, and the note about it must not depend on what is open.
    if (row.childrenTruncated) {
      depthClamped = true;
    }

    if (parentIndex !== undefined && (hiddenRows.has(parentIndex) || foldedRows.has(parentIndex))) {
      // An ancestor is folded, so this row is not shown — and neither is
      // anything below it, which the next iterations resolve through this set.
      hiddenRows.add(row.rowIndex);
      foldedAway += 1;
      continue;
    }

    const frameId = usedSpanIds.has(event.spanId)
      ? `${event.spanId}#${String(row.rowIndex)}`
      : event.spanId;
    usedSpanIds.add(event.spanId);
    frameIdByRow[row.rowIndex] = frameId;

    // A frame whose children the depth bound already dropped has nothing left
    // to fold, so it offers no control: the note about the bound is the honest
    // statement there, not a toggle that would reveal nothing.
    const foldable = row.hasChildren && !row.childrenTruncated;
    const opened = folds.get(frameId);
    const folded = foldable && (opened === undefined ? row.depth >= AUTO_FOLD_DEPTH : !opened);

    if (folded) {
      foldedRows.add(row.rowIndex);
    }

    const frame: FlameFrame = {
      frameId,
      eventId: event.id,
      spanId: event.spanId,
      traceId: event.traceId,
      name: event.name,
      kind: event.kind,
      tier: event.tier,
      status: event.status,
      depth: row.depth,
      parentFrameId: parentIndex === undefined ? undefined : frameIdByRow[parentIndex],
      startTime: event.startTime,
      durationMs: usableDurationMs(event.duration),
      selfTimeMs: selfTimeMsOf(row.node),
      childCount: row.node.children.length,
      orphaned: row.orphaned,
      orphanReason: row.node.orphanReason,
      lineage: row.lineage,
      lineageAmbiguous: row.lineageAmbiguous,
      source: event.source,
      ancestry,
      ancestryTruncated: ancestorCount > ancestry.length,
      foldable,
      folded,
      childrenBeyondDepth: row.childrenTruncated,
    };

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
      label: frameLabelText(event.name, geometry.width, canvas.measureText),
    };

    const bucket = barsByDepth[row.depth];
    if (bucket === undefined) {
      barsByDepth[row.depth] = [unrowed];
    } else {
      bucket.push(unrowed);
    }
  }

  // Dense by construction — a shown frame's ancestors are all shown, so no
  // depth between the root and the deepest shown row can be empty — and built
  // through a defaulted read so a gap could never become a hole in the array.
  const depthBars: readonly (readonly UnrowedFrame[])[] =
    frames.length === 0
      ? []
      : Array.from({ length: shownDepth + 1 }, (_unused, depth) => barsByDepth[depth] ?? []);
  const icicleRows = packIcicleRows(depthBars);

  // The lookahead operation was produced only when the trace holds more than
  // the bound shows within the depth this layout draws — so a walk the depth
  // bound ended on exactly `maxRows` rows is not row-bounded, and "Show more
  // operations" is offered only when it would reveal something.
  const rowBounded = layout.totalRowCount > maxRows;

  return {
    frames,
    icicleRows,
    // Sized by the rows actually drawn, which is the depth count only when no
    // depth needed a second row.
    canvasHeight: AXIS_BAND_HEIGHT + layoutHeight(icicleRows.length),
    ticks: axis.ticks,
    foldedAway,
    foldCount: foldedRows.size,
    // What the window kept, never the lookahead operation past it.
    walkedCount: layout.rows.length,
    rowBounded,
    depthClamped,
    treeTruncated: tree.truncated,
    orphanCount: tree.orphanCount,
    rootCount: tree.roots.length,
    duplicateCount: tree.duplicateSpanIds.length,
    totalDurationMs: tree.totalDuration,
    nodeCount: tree.nodeCount,
    shownDepth,
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

/**
 * What the traversal's row bound left out, as the sentence the notice and the
 * canvas's text alternative both state: "Showing N of M operations." — where M
 * is the trace's own node count.
 *
 * A trace that reports no more nodes than the walk produced cannot be believed
 * about its total, so its sentence names only what is shown, never an M that
 * would read as "everything".
 */
function rowBoundSentence(model: FlameModel): string {
  return model.nodeCount > model.walkedCount
    ? `Showing ${formatCount(model.walkedCount)} of ${pluralOperations(model.nodeCount)}.`
    : `Showing the first ${pluralOperations(model.walkedCount)} of this trace.`;
}

/**
 * The partial-result notice's sentences, or none when the view draws all it
 * was given: the row bound it can lift, then the correlator's own truncation,
 * which only a narrower query or capture can.
 */
function partialSentencesFor(model: FlameModel): readonly string[] {
  const sentences: string[] = [];

  if (model.rowBounded) {
    sentences.push(rowBoundSentence(model));
  }
  if (model.treeTruncated) {
    sentences.push(TRUNCATED_TRACE_NOTE);
  }

  return sentences;
}

/**
 * The row bound after one "Show more operations": one default step higher,
 * capped at the trace's own node count when that count is larger than the
 * bound in force. A trace whose count cannot be believed still moves by one
 * step, so the control always reveals something the walk left out.
 *
 * @param maxRows The row bound in force.
 * @param nodeCount The trace's own node count.
 * @returns The next row bound.
 */
function nextRowBound(maxRows: number, nodeCount: number): number {
  const stepped = maxRows + DEFAULT_MAX_TRACE_ROWS;
  return nodeCount > maxRows ? Math.min(stepped, nodeCount) : stepped;
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
 * The id of the drawn frame the panel's selection stands for, or `undefined`
 * when nothing is selected or the selected event is not among the drawn frames
 * (a folded subtree, a frame past the depth bound, another trace).
 *
 * The frame carrying the selected event id wins. Failing that, the first frame
 * that names the same trace **and** the same span — the other pairing
 * `matchesPanelSelection` accepts — so a selection reported by a view that drew
 * the span under another record's id still lands here. At most one frame is
 * returned, so the picture and the list mark the same single frame even for a
 * span id the correlator saw twice.
 *
 * @param frames The drawn frames, in the order both representations draw them.
 * @param selection The panel's selection, as `useViewSelection` returns it.
 * @returns The selected frame's id, if that frame is drawn.
 */
function selectedFrameIdOf(
  frames: readonly FlameFrame[],
  selection: PanelSelection | undefined,
): string | undefined {
  if (selection === undefined) {
    return undefined;
  }

  const frame =
    frames.find((candidate) => candidate.eventId === selection.eventId) ??
    frames.find((candidate) => matchesPanelSelection(selection, candidate));

  return frame?.frameId;
}

/*
 * ---------------------------------------------------------------------------
 * The text equivalent: a virtualized tree
 *
 * The rows beneath the canvas are a `role="tree"` of flat `role="treeitem"`
 * rows. Flat rather than nested groups, because only a window of them is in
 * the document: each row states its place in the hierarchy itself — its level
 * (`aria-level`), its position among the visible rows that share its parent
 * (`aria-posinset` of `aria-setsize`), whether its subtree is open
 * (`aria-expanded`, on a row that can fold) and whether it is the selected
 * frame (`aria-selected`) — so a reader is told the same structure whichever
 * rows happen to be rendered.
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
 *   - **ArrowDown / ArrowUp** — the next and previous row.
 *   - **Home / End** — the first and last row.
 *   - **ArrowRight** — open a folded row, then step into its first child.
 *   - **ArrowLeft** — fold an open row, then step out to its parent.
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
 * press caused. The primitive measures and places that bubble exactly as it
 * places a hovered one, so it opens at the name and follows a scroll of the
 * list, rather than painting at the viewport's corner as an unplaced fixed
 * bubble would. It describes nothing then (`describesTrigger={false}`, so it
 * is `aria-hidden`): a screen reader already hears the detail as the row's
 * name.
 *
 * ## Only the rows in view are rendered
 *
 * A large trace draws thousands of frames, and one list row per frame is tens
 * of thousands of elements and a page tens of thousands of pixels tall (AAP
 * 0.6.1: long lists virtualize through `@tanstack/react-virtual`). The rows
 * render inside the package's shared `dg-virtual-viewport` / `dg-virtual-canvas`
 * / `dg-virtual-row` triplet, exactly as `../primitives/DataTable` renders its
 * rows: the viewport is the role-less scroll container the stylesheet caps,
 * the canvas is the tree itself and advertises the whole list's height through
 * `--dgc-virtual-total`, and each row sits in a `role="presentation"`
 * positioning wrapper offset by `--dgc-virtual-start`. `DataTable` itself is
 * not composed here because it is a flat grid: it has no levels and no folding,
 * which are the whole of this view's structure.
 *
 * Before any viewport has been measured — the first paint of a real browser,
 * and every test DOM, which measures nothing — the rows render in normal flow,
 * bounded to a window of {@link TREE_WINDOW_ROWS} anchored on the active row so
 * the tab stop is always one of them. These rows are measured by the
 * virtualizer after they paint; nothing the canvas draws depends on them.
 * ---------------------------------------------------------------------------
 */

/**
 * The frame COUNT above which the text equivalent renders a window of rows
 * rather than all of them, and the size of the window it renders while no
 * viewport has been measured: 60.
 *
 * The count `../primitives/DataTable` uses for both, for the same two reasons:
 * sixty rows is the largest list this package renders whole, and it exceeds
 * the window the virtualizer settles on inside this list's scroll cap in
 * `../styles/components.css` — about a dozen rows, plus the overscan on each
 * side — so the bound never shows fewer rows than the viewport holds.
 */
const TREE_WINDOW_ROWS = 60;

/** How many rows beyond each edge of the viewport are rendered. A count. */
const TREE_OVERSCAN_ROWS = 8;

/**
 * The starting guess for one row's height, in CSS pixels.
 *
 * A measurement hint rather than a style value: it never reaches a class, a
 * declaration or a custom property. It seeds the virtualizer's scroll range
 * until each rendered row has been measured at its real, CSS-driven height,
 * and it is the hint `../primitives/DataTable` seeds its rows with — one dense
 * line of the small type role between two spacing steps — so being wrong only
 * costs a scrollbar that settles as rows are measured.
 */
const TREE_ESTIMATED_ROW_HEIGHT = 32;

/** The key a root is counted under when rows are grouped by their parent. */
const ROOT_PARENT_KEY = -1;

/** The chord that opens a row's source, as `aria-keyshortcuts` spells it. */
const OPEN_SOURCE_SHORTCUT = 'Shift+Enter';

/** The same chord, as the keys `Kbd` draws. */
const OPEN_SOURCE_KEYS: readonly string[] = ['Shift', 'Enter'];

/** The controls nested inside a row, which own their own clicks and keys. */
const NESTED_CONTROL_SELECTOR = 'button, a[href], input, select, textarea';

/** The attribute a treeitem carries its index among the visible rows in. */
const FRAME_INDEX_ATTRIBUTE = 'data-frame-index';

/** What a row says when the depth bound, rather than a fold, hid its children. */
const DEPTH_BOUND_ROW_NOTE = `nested calls below ${String(MAX_ICICLE_DEPTH)} levels are not shown`;

/** One visible row of the tree, with its place among its siblings. */
interface FlameTreeItem {
  /** The frame the row lists. */
  readonly frame: FlameFrame;
  /** The index of the row it is nested in, among the visible rows; absent at a root. */
  readonly parentIndex: number | undefined;
  /** How many visible rows share its parent: its `aria-setsize`. */
  readonly setSize: number;
  /** Its 1-based position among them: its `aria-posinset`. */
  readonly posInSet: number;
  /** Its accessible name: every fact the row and its detail carry. */
  readonly description: string;
}

/** The tree's rows and a frame-id lookup into them, from one pass. */
interface FlameTreeIndex {
  /** The visible rows, in the order the canvas draws them. */
  readonly items: readonly FlameTreeItem[];
  /** Frame id to row index. */
  readonly indexById: ReadonlyMap<string, number>;
}

/** A half-open range of row indices. */
interface RowRange {
  /** The first index in the range. */
  readonly start: number;
  /** One past the last index in the range. */
  readonly end: number;
}

/** The one reveal a selection is owed, as `FlameFrameTree` tracks it. */
interface SelectionReveal {
  /** The selected frame the reveal was armed for, or `undefined` for none. */
  frameId: string | undefined;
  /** Whether that frame's row still has to be scrolled into view. */
  pending: boolean;
}

/** The treeitem an event landed in, and its index. */
interface TreeItemHit {
  /** The row's index among the visible rows. */
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
    `duration ${formatDuration(frame.durationMs)}`,
    `own time ${formatDuration(frame.selfTimeMs)}`,
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
 * Indexes the visible rows once: each row's parent row and its position among
 * the visible rows that share that parent.
 *
 * The frames arrive in pre-order, so a parent always precedes its children and
 * one forward pass numbers every sibling set.
 *
 * @param frames The shown frames, in traversal order.
 * @returns The rows and the frame-id lookup.
 */
function buildTreeIndex(frames: readonly FlameFrame[]): FlameTreeIndex {
  const indexById = new Map<string, number>();
  for (const [index, frame] of frames.entries()) {
    indexById.set(frame.frameId, index);
  }

  const parentIndexes = frames.map((frame) =>
    frame.parentFrameId === undefined ? undefined : indexById.get(frame.parentFrameId),
  );

  const setSizes = new Map<number, number>();
  const positions: number[] = [];
  for (const parentIndex of parentIndexes) {
    const key = parentIndex ?? ROOT_PARENT_KEY;
    const position = (setSizes.get(key) ?? 0) + 1;
    setSizes.set(key, position);
    positions.push(position);
  }

  const items = frames.map((frame, index): FlameTreeItem => {
    const parentIndex = parentIndexes[index];
    return {
      frame,
      parentIndex,
      setSize: setSizes.get(parentIndex ?? ROOT_PARENT_KEY) ?? 1,
      posInSet: positions[index] ?? 1,
      description: frameDescription(frame),
    };
  });

  return { items, indexById };
}

/**
 * The rows that render in normal flow, whenever the virtualizer is not the
 * thing driving the render.
 *
 * A short list renders whole. A long one that nothing has measured yet renders
 * a window of {@link TREE_WINDOW_ROWS} rows ANCHORED ON THE ACTIVE ROW, which
 * is a correctness requirement: the active row holds the tab stop, and a tab
 * stop that is not in the document leaves the tree unreachable by Tab. The
 * window opens {@link TREE_OVERSCAN_ROWS} rows ahead of the anchor, so a row
 * reached by ArrowUp is already there, and is clamped inside the list at both
 * ends — the same arithmetic `../primitives/DataTable` applies.
 *
 * @param windowed Whether the list is long enough to be windowed at all.
 * @param rowCount How many rows exist.
 * @param activeIndex The row holding the tab stop, or `-1` with no rows.
 * @returns The half-open range of row indices to render in flow.
 */
function flowRowRange(windowed: boolean, rowCount: number, activeIndex: number): RowRange {
  if (!windowed) {
    return { start: 0, end: rowCount };
  }

  const windowRows = Math.min(TREE_WINDOW_ROWS, rowCount);
  const earliestStart = activeIndex - windowRows + 1;
  const anchored = Math.max(activeIndex - TREE_OVERSCAN_ROWS, earliestStart);
  const start = Math.min(Math.max(anchored, 0), rowCount - windowRows);

  return { start, end: start + windowRows };
}

/**
 * The virtualizer's window with the active row added to it, when scrolling
 * has taken the viewport away from that row.
 *
 * The active row is the tree's one tab stop and may hold focus. Kept in the
 * document at its own offset — outside the viewport, so nothing on screen
 * changes — it keeps that focus through a scroll and keeps Tab entering the
 * tree where the reader left it, rather than at whichever row is on screen.
 *
 * @param indexes The window the default extractor chose, in ascending order.
 * @param activeIndex The row holding the tab stop, or `-1` with no rows.
 * @returns The indexes to render, in ascending order.
 */
function withActiveIndex(indexes: readonly number[], activeIndex: number): number[] {
  if (activeIndex < 0 || indexes.includes(activeIndex)) {
    return [...indexes];
  }

  return [...indexes, activeIndex].sort((left, right) => left - right);
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
 * @param index The row's index among the visible rows.
 * @returns The treeitem element, or `undefined` when it is not rendered.
 */
function treeRowIn(viewport: Element | null, index: number): HTMLElement | undefined {
  const candidate = viewport?.querySelector(`[${FRAME_INDEX_ATTRIBUTE}="${String(index)}"]`);
  return candidate instanceof HTMLElement ? candidate : undefined;
}

/**
 * The scroll offset that brings a rendered row fully into its tree's viewport,
 * moving it as little as possible, or `undefined` when it is already fully
 * visible.
 *
 * "Nearest" semantics, as `scrollIntoView({ block: 'nearest' })` gives, but
 * confined to the tree's own scroll container so the page never moves: a row
 * above the visible band is brought to its top, a row below it to its bottom
 * edge — and a row taller than the band keeps its top edge in view. A viewport
 * with no visible band (nothing laid out yet, or a DOM without layout) yields
 * `undefined`, because no offset would reveal anything.
 *
 * @param viewport The tree's scroll container.
 * @param row The rendered treeitem to reveal.
 * @returns The offset to scroll the viewport to, or `undefined` to leave it.
 */
function revealScrollTop(viewport: HTMLElement, row: HTMLElement): number | undefined {
  const viewportSize = viewport.clientHeight;

  if (!(viewportSize > 0)) {
    return undefined;
  }

  const scrollOffset = viewport.scrollTop;
  const box = row.getBoundingClientRect();
  const rowStart =
    box.top - viewport.getBoundingClientRect().top - viewport.clientTop + scrollOffset;
  const rowEnd = rowStart + box.height;

  if (rowStart < scrollOffset) {
    return Math.max(rowStart, 0);
  }

  if (rowEnd > scrollOffset + viewportSize) {
    return Math.max(Math.min(rowEnd - viewportSize, rowStart), 0);
  }

  return undefined;
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
      <DurationCell ms={frame.durationMs} size="sm" />{' '}
      <Text as="span" size="xs" tone="muted">
        own time
      </Text>{' '}
      <DurationCell ms={frame.selfTimeMs} size="sm" />{' '}
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

/** The props of {@link FlameFrameTree}. */
interface FlameFrameTreeProps {
  /** The shown frames, in traversal order: one row each. */
  readonly frames: readonly FlameFrame[];
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
 * The keyboard-reachable text equivalent of the icicle: a virtualized tree
 * with a single roving tab stop. See the section above for its structure, its
 * keys and what renders before anything has been measured.
 *
 * @param props The props, as documented on {@link FlameFrameTreeProps}.
 * @returns The scroll viewport holding the tree.
 */
function FlameFrameTree(props: FlameFrameTreeProps): ReactElement {
  const {
    frames,
    label,
    selectedFrameId,
    hoveredFrameId,
    onSelect: reportSelect,
    onToggle,
    onOpenSource,
  } = props;

  const viewportRef = useRef<HTMLDivElement>(null);

  /** Set by a key that moved the active row; spent when that row takes focus. */
  const focusPendingRef = useRef(false);

  /** Set by a pointer press, so the focus it causes reveals no detail. */
  const pointerFocusRef = useRef(false);

  /** The row the keyboard or a click last made active, by frame id. */
  const [navigatedFrameId, setNavigatedFrameId] = useState<string | undefined>(undefined);

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
  const windowed = rowCount > TREE_WINDOW_ROWS;

  const navigatedIndex =
    navigatedFrameId === undefined ? undefined : indexById.get(navigatedFrameId);
  const selectedIndex = selectedFrameId === undefined ? undefined : indexById.get(selectedFrameId);
  const activeIndex = rowCount === 0 ? -1 : (navigatedIndex ?? selectedIndex ?? 0);

  // Called unconditionally, as a hook must be; it drives nothing while the
  // list is short enough to render whole. `react-hooks/incompatible-library`
  // reports that this API returns functions the React Compiler cannot memoize,
  // so it skips auto-memoizing this component; that is accepted rather than
  // worked around, because AAP 0.6.1 names this library as the mechanism for
  // long lists and nothing the virtualizer returns is handed to a memoized
  // component.
  // eslint-disable-next-line react-hooks/incompatible-library -- AAP 0.6.1 mandates this API for long lists
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => TREE_ESTIMATED_ROW_HEIGHT,
    overscan: TREE_OVERSCAN_ROWS,
    enabled: windowed,
    // Required under React 19.3, as `../primitives/DataTable` records: the
    // adapter's default flushes every measurement and scroll notification
    // synchronously, which lands while React is rendering or committing. The
    // adapter's own batched re-render is what `false` selects.
    useFlushSync: false,
    // Measurements follow the frame, not the position, so a fold that shifts
    // the rows below it does not hand one row's height to another.
    getItemKey: (index) => items[index]?.frame.frameId ?? index,
    // The active row is always rendered, at its own offset, even when the
    // viewport is scrolled away from it: it is the tree's one tab stop and may
    // hold focus, and a row unmounted by a scroll would drop that focus to the
    // document and move the stop to whatever row happens to be on screen.
    rangeExtractor: (range) => withActiveIndex(defaultRangeExtractor(range), activeIndex),
  });

  const virtualItems = virtualizer.getVirtualItems();
  const viewportHeight = virtualizer.scrollRect === null ? 0 : virtualizer.scrollRect.height;

  // THE MEASUREMENT GATE: the virtualizer drives the render only once it has
  // measured a viewport AND produced a window. Until then the rows render in
  // normal flow, bounded by `flowRowRange`.
  const isVirtualized = windowed && virtualItems.length > 0 && viewportHeight > 0;

  const flowRange = flowRowRange(windowed, rowCount, activeIndex);
  const flowRangeIsWindowed = !isVirtualized && flowRange.end - flowRange.start < rowCount;

  // The tab stop has to exist in the document whenever rows render. Under the
  // virtualizer the range extractor keeps the active row rendered however far
  // the viewport scrolls; should a window ever arrive without it all the same,
  // the topmost rendered row takes the stop, so Tab still enters the tree, and
  // the key handlers read the origin row's own index, so navigation continues
  // from wherever the reader actually entered.
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

  /**
   * Makes a row active and asks for it to take focus once it is rendered:
   * scrolled into the window first, focused by the effect below second.
   */
  const moveActive = (target: number): void => {
    const clamped = Math.min(Math.max(target, 0), rowCount - 1);
    const item = items[clamped];

    if (item === undefined) {
      return;
    }

    if (clamped === activeIndex && activeIsRendered) {
      // Already the active row — a key pressed at an end of the list, or from
      // a control inside the row: focus returns to the row itself, and there
      // is nothing to re-render or to leave pending.
      treeRowIn(viewportRef.current, clamped)?.focus();
      return;
    }

    focusPendingRef.current = true;
    setNavigatedFrameId(item.frame.frameId);
    if (isVirtualized) {
      virtualizer.scrollToIndex(clamped);
    }
  };

  // Focus follows the active row, but only when a key asked for it, and only
  // once the row is in the document: under the virtualizer it may not have
  // been when the key was pressed, so the request survives until the commit
  // that renders it.
  useEffect(() => {
    if (!focusPendingRef.current || activeIndex < 0 || !activeIsRendered) {
      return;
    }

    const candidate = treeRowIn(viewportRef.current, activeIndex);

    if (candidate === undefined) {
      return;
    }

    focusPendingRef.current = false;
    candidate.focus();
  }, [activeIndex, activeIsRendered]);

  // The selected row is brought into the tree's viewport when the SELECTION
  // moves to it from elsewhere — the canvas, another view, an evidence chip —
  // so a reader who picked a span somewhere else finds its row here without
  // hunting through a long list. The rules are `../primitives/DataTable`'s:
  //
  //   Once per selection: armed when the selected frame changes (the first
  //   commit counts) and spent when done.
  //   Never for this tree's own activation: that row is already in view.
  //   Only a rendered row, placed the way the render is driven: under the
  //   virtualizer by `scrollToIndex`, which reaches a row outside the window
  //   and leaves a row already in view where it is; in normal flow by the
  //   row's own box, once the commit that renders it — and only while the
  //   flow is the whole list, since a flow window does not sit at its true
  //   offset and the virtualizer takes over from it.
  //   Never focus, never the page, never the tab stop: only the tree's own
  //   viewport scrolls, and the roving stop is not moved here — it follows
  //   the reader's navigation first and the selection only until then (see
  //   `activeIndex`).
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

    if (isVirtualized) {
      reveal.pending = false;
      virtualizer.scrollToIndex(selectedIndex);
      return;
    }

    const viewport = viewportRef.current;
    const row = treeRowIn(viewport, selectedIndex);

    if (flowRangeIsWindowed || viewport === null || row === undefined) {
      return;
    }

    reveal.pending = false;
    const target = revealScrollTop(viewport, row);
    if (target !== undefined) {
      viewport.scrollTop = target;
    }
  }, [flowRangeIsWindowed, isVirtualized, selectedFrameId, selectedIndex, virtualizer]);

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
      case 'ArrowDown':
        event.preventDefault();
        moveActive(hit.index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(hit.index - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveActive(0);
        return;
      case 'End':
        event.preventDefault();
        moveActive(rowCount - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (frame.foldable && frame.folded) {
          onToggle(frame);
          return;
        }
        // The first child immediately follows its parent in a pre-order walk.
        if (items[hit.index + 1]?.parentIndex === hit.index) {
          moveActive(hit.index + 1);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (frame.foldable && !frame.folded) {
          onToggle(frame);
          return;
        }
        if (item.parentIndex !== undefined) {
          moveActive(item.parentIndex);
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
    setNavigatedFrameId(item.frame.frameId);
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

  // The canvas advertises the whole list's height from the first paint while a
  // window is rendered, so the scrollbar is right before anything is measured.
  // The stylesheet reads it as a MINIMUM, so an estimate never clips a row.
  const canvasStyle: CssVariableStyle | undefined =
    isVirtualized || flowRangeIsWindowed
      ? { '--dgc-virtual-total': String(virtualizer.getTotalSize()) }
      : undefined;

  /**
   * One row inside its positioning wrapper. A plain function called during
   * this render, so the virtualized and the in-flow paths render identical
   * markup and differ only in geometry.
   *
   * @param item The row.
   * @param index Its index among the visible rows.
   * @param offset Its offset in CSS pixels while the virtualizer positions rows.
   */
  const renderItem = (
    item: FlameTreeItem,
    index: number,
    offset: number | undefined,
  ): ReactElement => {
    const { frame } = item;
    const positioned = offset !== undefined;
    const selected = frame.frameId === selectedFrameId;
    const revealed = frame.frameId === revealedFrameId;
    const canOpenSource = frame.source !== undefined && onOpenSource !== undefined;
    const wrapperStyle: CssVariableStyle | undefined = positioned
      ? { '--dgc-virtual-start': String(offset) }
      : undefined;
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
        // Removes the wrapper from the accessibility tree, so the treeitem is
        // owned by the tree directly. It carries no other ARIA attribute,
        // because any one would void the role.
        role="presentation"
        className={positioned ? 'dg-virtual-row' : undefined}
        data-index={index}
        // Measured only while the virtualizer's window is real.
        ref={isVirtualized ? virtualizer.measureElement : undefined}
        style={wrapperStyle}
      >
        <div
          role="treeitem"
          className={clsx(
            'dg-flame__equivalent-row',
            frame.frameId === hoveredFrameId && 'dg-is-hovered',
            selected && 'dg-is-selected',
            frame.orphaned && 'dg-is-orphan',
          )}
          style={depthStyle}
          aria-level={frame.depth + 1}
          aria-setsize={item.setSize}
          aria-posinset={item.posInSet}
          aria-expanded={frame.foldable ? !frame.folded : undefined}
          aria-selected={selected}
          aria-current={selected ? 'true' : undefined}
          aria-label={item.description}
          aria-keyshortcuts={canOpenSource ? OPEN_SOURCE_SHORTCUT : undefined}
          // The roving tab index: one row of the whole tree is in the Tab order.
          tabIndex={index === tabStopIndex ? 0 : -1}
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
              with the Shift+Enter hint where it applies; the primitive
              measures and places it like the hovered form, so it opens at the
              name and follows the list's scroll instead of painting at the
              viewport's corner, while the tree's own handler keeps Escape. It
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
          <DurationCell ms={frame.durationMs} size="sm" />

          <Text as="span" size="xs" tone="muted">
            own
          </Text>
          <DurationCell ms={frame.selfTimeMs} size="sm" />

          {frame.childrenBeyondDepth ? (
            <Text as="span" size="xs" tone="muted">
              {DEPTH_BOUND_ROW_NOTE}
            </Text>
          ) : null}

          {frame.source === undefined ? null : (
            <SourceLink location={frame.source} compact tabIndex={-1} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="dg-flame__equivalent">
      {/* The scroll container, deliberately role-less: the tree inside it owns
          the treeitems, and a role here would insert a foreign node between
          them. The stylesheet caps its height, which is what gives the
          virtualizer a viewport to window against. */}
      <div className="dg-virtual-viewport" ref={viewportRef}>
        <div
          role="tree"
          aria-label={label}
          className="dg-virtual-canvas"
          style={canvasStyle}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPointerDown={handlePointerDown}
          onClick={handleClick}
        >
          {isVirtualized
            ? virtualItems.map((virtualItem) => {
                const item = items[virtualItem.index];
                return item === undefined
                  ? null
                  : renderItem(item, virtualItem.index, virtualItem.start);
              })
            : // The flow range, sliced; the slice offset is added back so each
              // row keeps its TRUE index among the visible rows.
              items
                .slice(flowRange.start, flowRange.end)
                .map((item, offset) => renderItem(item, flowRange.start + offset, undefined))}
        </div>
      </div>
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
   * frame id, so the mark lands whenever the virtualized tree renders the row.
   */
  const [hoveredFrameId, setHoveredFrameId] = useState<string | undefined>(undefined);
  const hovering = hoveredFrameId !== undefined;

  /**
   * The block: the document the hover's Escape listener is attached to, and
   * the subtree a focus handoff after "Show more operations" finds the tree's
   * tab stop in.
   */
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

  // The viewport's inner width, measured while its ref attaches and kept
  // current on resize, and a measure in the frame labels' font
  // (`.dg-flame__frame-label` is set in `monoSm`). Called before any early
  // return, as the rules of hooks require; the ref only attaches once the
  // chart itself renders.
  const {
    ref: viewportRef,
    width: viewportWidth,
    measureText,
  } = useChartCanvas<HTMLDivElement>({ font: 'monoSm' });
  const measured = isMeasuredWidth(viewportWidth);
  const canvasWidth = resolveCanvasWidth(viewportWidth);

  /**
   * The traversal's row bound, as raised by "Show more operations", tagged
   * with the query it was raised for.
   *
   * Tagged rather than reset by an effect: a bound whose identity no longer
   * matches the node's query is simply not read, so a changed query starts
   * from the default bound on the very render that shows it, with no frame
   * drawn against a bound meant for another trace.
   */
  const [raisedBound, setRaisedBound] = useState<
    { readonly identity: string; readonly maxRows: number } | undefined
  >(undefined);
  const queryIdentity = `${node.id}|${JSON.stringify(query)}`;
  const boundRaised = raisedBound !== undefined && raisedBound.identity === queryIdentity;
  const maxRows = boundRaised ? raisedBound.maxRows : DEFAULT_MAX_TRACE_ROWS;

  // One model for both representations: the measured canvas lays the frames
  // out and fits their labels, the row bound decides how much of the trace is
  // walked, and the packing is done at the width the bars are painted at.
  const model = useMemo(
    () => buildModel(tree, folds, { width: canvasWidth, measureText }, maxRows),
    [tree, folds, canvasWidth, measureText, maxRows],
  );
  const selectedFrameId = selectedFrameIdOf(model.frames, selection);

  /**
   * Set when "Show more operations" was activated, and read once the rows it
   * asked for have rendered: when the bound now covers the whole trace, the
   * control that held focus has gone, and focus moves to the tree's tab stop
   * rather than falling back to the document.
   */
  const focusAfterShowMore = useRef(false);

  const handleShowMore = useCallback((): void => {
    focusAfterShowMore.current = true;
    setRaisedBound({ identity: queryIdentity, maxRows: nextRowBound(maxRows, model.nodeCount) });
  }, [maxRows, model.nodeCount, queryIdentity]);

  useEffect(() => {
    if (!focusAfterShowMore.current) {
      return;
    }
    focusAfterShowMore.current = false;
    const block = blockRef.current;
    const active = block?.ownerDocument.activeElement;
    // Only a focus that was lost is handed on: while the control remains, it
    // keeps focus, and a reader who has moved elsewhere is left where they are.
    if (
      block === null ||
      (active !== null && active !== undefined && active !== block.ownerDocument.body)
    ) {
      return;
    }
    block.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
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
  const partial = partialSentences.length > 0;
  // Once the reader has raised the bound, the notice stays mounted: a live
  // region that is removed announces nothing, so the step that reveals the last
  // operations must update it instead — to the count now shown in full.
  const noticeText = partial
    ? partialSentences.join(' ')
    : boundRaised
      ? `Showing all ${pluralOperations(model.walkedCount)}.`
      : undefined;
  const listLabel = `${node.title ?? CATALOG_ENTRY.label}: ${pluralOperations(
    model.frames.length,
  )}, innermost last`;

  return (
    <div ref={blockRef} className={clsx('dg-flame', className)}>
      {notes.map((note) => (
        <Text key={note} as="p" size="xs" tone="muted" className="dg-flame__note">
          {note}
        </Text>
      ))}

      {noticeText === undefined ? null : (
        // Beside the canvas it qualifies, in the shape the timeline and the
        // dependency graph share: the badge, what is shown of what exists, and
        // the way to see more — a control while more is in memory, the refine
        // route when it is not. Polite and live, so the count a step reveals is
        // announced; never `role="status"`, which is the loading placeholder's.
        // The badge and the control hold fixed slots, so the live text keeps
        // its element when either goes.
        <Stack direction="horizontal" gap={2} align="center" wrap>
          {partial ? (
            <Badge tone="warning" variant="outline">
              {PARTIAL_RESULT_LABEL}
            </Badge>
          ) : null}
          <Text as="p" size="xs" tone="muted" aria-live="polite">
            {noticeText}
          </Text>
          {model.rowBounded ? (
            <Button variant="secondary" size="sm" onClick={handleShowMore}>
              {SHOW_MORE_LABEL}
            </Button>
          ) : null}
        </Stack>
      )}

      <div className="dg-flame__viewport" ref={viewportRef}>
        {/* A picture with a text alternative, deliberately: the rows beneath it
            are the representation a keyboard and a screen reader use, so the
            canvas announces what it shows instead of exposing one node per
            bar (AAP 0.6.4).

            Measured, the canvas is `canvasWidth` CSS pixels wide with a
            `viewBox` of the same size, so one user unit is one pixel and
            nothing is scaled; the default `preserveAspectRatio` then has no
            ratio to reconcile. Unmeasured (no layout), the fallback coordinate
            space is stretched across the container instead — see the module
            note. */}
        <svg
          className="dg-flame__canvas"
          role="img"
          aria-label={canvasTextAlternative(model, node.title)}
          viewBox={`0 0 ${String(canvasWidth)} ${String(model.canvasHeight)}`}
          width={measured ? canvasWidth : '100%'}
          height={model.canvasHeight}
          preserveAspectRatio={measured ? undefined : 'none'}
        >
          <g className="dg-flame__axis">
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

          {model.icicleRows.map((bars, rowIndex) => (
            // The drawn row's position is its identity, so it is also the
            // key: a fold changes which frames a row holds, and rows are
            // numbered top to bottom whatever they hold.
            <g className="dg-flame__row" key={rowIndex}>
              {bars.map((bar) => {
                const frameColor: CssVariableStyle = {
                  '--dgc-frame-color': kindColorVar(bar.frame.kind),
                };
                // The label is text on the frame's fill, so it takes the ink
                // paired with that fill rather than one colour for every frame:
                // no single ink clears 4.5:1 on the whole kind scale.
                const frameInk: CssVariableStyle = {
                  '--dgc-frame-ink': kindInkColorVar(bar.frame.kind),
                };
                // A fragment rather than a group per frame: a large trace draws
                // thousands of frames, and a wrapper element per bar would add
                // as many nodes to the document while styling nothing.
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
                      {/* The user agent's own tooltip, kept for the pointer.
                          The author-drawn detail is the frame's tree row, which
                          hovering the frame marks and Escape dismisses, whose
                          name opens the full description on hover, and whose
                          keyboard focus reveals it. */}
                      <title>{frameTooltipText(bar.frame)}</title>
                    </rect>
                    {bar.label === undefined ? null : (
                      <text
                        className="dg-flame__frame-label"
                        style={frameInk}
                        x={bar.x + LABEL_INSET}
                        y={bar.y + bar.height / 2}
                      >
                        {bar.label}
                      </text>
                    )}
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
          is ONE tab stop and renders only the rows in view (see
          `FlameFrameTree`); the shared selection and the frame under the
          pointer are handed to it by frame id, so a row carries its marks
          whenever it is rendered. */}
      <FlameFrameTree
        frames={model.frames}
        label={listLabel}
        selectedFrameId={selectedFrameId}
        hoveredFrameId={hoveredFrameId}
        onSelect={handleSelect}
        onToggle={handleToggle}
        onOpenSource={actions?.onOpenSource}
      />
    </div>
  );
}
