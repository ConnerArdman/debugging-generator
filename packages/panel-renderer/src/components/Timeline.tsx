/**
 * `Timeline` — the cross-tier correlated view of one interaction: every
 * captured span placed on a shared time axis, grouped into lanes by the tier
 * that produced it.
 *
 * This module is the component behind the node catalog's `timeline` type, and
 * it is the node a "where did the time go" panel opens with. It has to be able
 * to show the whole shape of one interaction at once — the click, the handler,
 * the state update, the request, the server span that answered it, the route
 * handler, the service functions nested inside it, the datastore call at the
 * bottom, the outgoing call beside it, the response and the render that
 * followed — as one ordered tree with a duration on every row.
 *
 * ## Data arrives through the node's query, and only through it
 *
 * The node carries a `DataQuery` whose source the catalog restricts to `trace`
 * or `spans`; this file resolves it with `../host/useQuery` and touches no
 * socket, no `fetch` and no service internals. The two payload shapes are
 * normalised into ONE render-local model ({@link TimelineBar}) and the branch
 * is taken on the QUERY'S OWN SOURCE — the discriminant the panel was authored
 * with — never by inspecting the data's shape:
 *
 * - `trace` resolves to a correlated `TraceTree`, whose nesting is already
 *   decided. It is walked children-only, from the roots, by
 *   `../utils/scale`'s `flattenTraceRows` — a trace node carries no parent
 *   pointer by design (a cycle is not JSON, and the tree crosses an HTTP
 *   response), so every algorithm here works top-down. It resolves to `null`
 *   when no trace in the capture matched the query, which is an empty capture
 *   and renders the empty state rather than an error.
 * - `spans` resolves to a flat event list, one PAGE per request, and every
 *   page loaded so far is drawn together (see "Paging" below). The loaded
 *   rows are linked into a parent/child forest through the `parentSpanId`
 *   each one names — looked up inside the row's own trace, since a span id is
 *   unique only within its trace and an unfiltered page can hold several —
 *   and the forest is flattened depth-first, so a parent is
 *   always drawn before its children and a subtree stays contiguous — the
 *   canonical parent-before-child order, which a child whose clock reads
 *   earlier than its parent's cannot reorder. Siblings, and the roots, follow
 *   the canonical keys: `startTime`, then `producerId`, then the producer's
 *   own `seq`, then the store's `ingestSeq` as the final tie-break. Depth is
 *   the walk's depth. The forest is rebuilt from every loaded row whenever a
 *   page settles, so when a later page brings a parent, the children already
 *   on screen move beneath it. A span whose parent is not among the loaded
 *   rows is drawn at the top level and marked "Parent not loaded"; it is
 *   **not** called an orphan: the correlator's `orphaned` flag means "the
 *   parent never arrived at all", which is a different statement, and
 *   conflating the two would invent evidence.
 *
 * ## The canvas is drawn one user unit to a CSS pixel
 *
 * The canvas is laid out at its own rendered width. The element declares
 * `width="100%"`, so the stylesheet alone decides how wide it is — as wide as
 * its scroll viewport, down to the chart minimum below which the viewport
 * scrolls instead — and {@link useCanvasWidth} observes that width and lays the
 * drawing out in a `viewBox` exactly as wide, and as tall as the lanes it
 * draws. One user unit is therefore one CSS pixel at every panel width: a
 * label set in `--dg-mono-sm` renders at the role's 11 px whether the panel is
 * narrow or a full-screen window, a lane is as tall as its rows and no taller,
 * and a wider panel gives the time axis more room rather than magnifying the
 * whole drawing. The measurement cannot feed back into itself: the element's
 * width comes from its container, never from its `viewBox`, and the drawing's
 * height depends on its rows alone.
 *
 * Until a width has been measured — the first layout of a host that cannot
 * report one, or the layout-free DOM every component suite runs under, where
 * nothing has a size and `ResizeObserver` observes nothing — the drawing is
 * laid out in `../utils/scale`'s fixed logical width, `CHART_VIEWBOX_WIDTH`
 * (1 000) units, and `preserveAspectRatio="xMinYMin meet"` scales it uniformly
 * into the element from its top-left corner, so a glyph is never stretched
 * sideways. Either way the drawing is a pure function of the data and one
 * width: the same model at the same width always draws the same picture, and
 * the fallback width makes an unmeasured render deterministic.
 *
 * A bar's label is fitted in the same user units before it is placed, with
 * `../utils/format`'s deterministic advance estimate at the label role's size
 * (`fitTextToWidth` over `createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE)`; the
 * label is set in `--dg-mono-sm`, 11 px, which is 11 user units once the
 * drawing is laid out at its rendered width), so it is drawn only where it
 * fits — after the bar, before it, inside it, or shortened to an ellipsis —
 * and never across the lane labels, past the canvas edge or over another bar
 * or label (see "Bar labels" below). The estimate errs towards "does not fit",
 * so a label it places is not clipped by the face the stylesheet renders it
 * in.
 *
 * Every coordinate comes from `../utils/scale` and every colour from
 * `../utils/color`; this file performs no interval arithmetic of its own and
 * writes no colour, length or spacing literal. A bar's kind colour travels to
 * the stylesheet as `--dgc-bar-color` and a lane's tier accent as
 * `--dgc-lane-color`, which are the only inline values written anywhere below.
 *
 * ## Overlapping spans are stacked, never painted over one another
 *
 * A lane places a span by its depth, and spans of one depth routinely overlap
 * in time — parallel requests, the renders of one commit, the queries of one
 * handler. Each depth is therefore packed into the sub-rows its overlapping
 * spans need, by their drawn extent, so every bar stays visible beside the
 * others instead of hidden under a longer one. A depth that would need more
 * than `MAX_SUB_ROWS_PER_DEPTH` keeps its longest spans as bars and gathers the
 * rest into "+N" marks on one row beneath it, so one crowded depth cannot push
 * the other lanes out of view; the canvas's text alternative and the footer
 * state how many spans were gathered, and the table lists every one of them
 * (see "Packing a depth" in the geometry below). The panel's selection is never
 * among them: a selected span a crowded depth would gather is drawn as a bar.
 *
 * ## An SVG alone is not a representation
 *
 * The canvas is a `role="figure"` with a text alternative, and each bar and
 * "+N" mark in it is a `role="img"` carrying its full description as its
 * accessible name, so a screen reader browsing the picture hears what a pointer
 * hovering it sees. Its bars are not focusable, though, so the
 * keyboard-reachable representation is mandatory rather than a
 * convenience: the same rows render below the canvas through `DataTable` —
 * name, kind, tier, offset, duration and a `SourceLink` chip wherever a row
 * resolved to a location — with row activation raising the same selection the
 * bars raise. Clicking a chip is not a row activation; the table primitive
 * already excludes clicks that originate inside an interactive descendant, so
 * opening a file never also selects a span.
 *
 * A row's full description — the sentence a bar carries as its SVG title — is
 * keyboard-reachable too, and reaching it adds no tab stop: the table body stays
 * the single roving stop the table primitive makes it. While a row itself holds
 * KEYBOARD focus — Tab, Shift+Tab or the table's arrow keys, never the focus a
 * pointer press causes — its Operation cell shows the description by holding
 * the name's own `Tooltip` open (its controlled `open`): the same bubble a
 * pointer opens on hover, measured and placed against the name by the
 * primitive exactly as a hovered one is, and Escape dismisses it until focus
 * moves to another row (the Waterfall and flame-chart rows reveal theirs the
 * same way). No row's name is ever a tab stop, and neither is a row's source
 * chip: like every control a `DataTable` cell renders it is `tabIndex={-1}`,
 * reached by the table's own arrow keys. The row that holds focus also drives
 * the detail strip below the canvas; the strip's name is that same
 * description's trigger for a pointer, and neither it nor the strip's source
 * chip is a tab stop, so Tab passes through the whole view on the table's one
 * stop. Escape peels one layer per press: the row's revealed description
 * first, then the strip's preview of that row.
 *
 * ## The selection is the panel's, not this chart's
 *
 * Every chart of one panel draws the same captured spans, so a selection kept
 * here would let this chart mark one span while the flame chart beside it marks
 * another. The selected bar, the selected table row and the strip's
 * "Selected" line therefore follow the panel host's one shared selection, read
 * through `useViewSelection` and matched with `matchesPanelSelection` — by
 * event id, or by the same trace and span. Activating a bar or a row reports
 * the span through `onSelectEvent`, which is where the host records it, and
 * every view of the panel moves its mark together. Outside a host — a surface
 * that embeds this view alone, or a suite that mounts it — there is nothing to
 * share a selection with, and the view marks its own last activation.
 *
 * ## Evidence is rendered as it arrives
 *
 * - An **ambiguous** async continuation — more than one settled request had an
 *   open continuation window when the event landed — is drawn with the dashed
 *   warning edge the stylesheet implements and a dashed warning outline on its
 *   bar, and its alternative candidates are named in the row's description: by
 *   the operation each recorded and its span id, where the candidate is a span
 *   of the same trace among the rows on screen, and by its span id alone
 *   otherwise. A guessed relationship must never read as a measured one.
 * - An async continuation attributed with a **single** candidate is inferred
 *   rather than measured, but not in doubt: its edge is solid, in the info
 *   tone, and the description names the mechanism. The dependency graph draws
 *   its relationships' two lineage states the same way.
 * - An **orphan** — a span whose parent never arrived, re-attached to the
 *   trace root — is marked and kept. Dropping it would silently remove real
 *   work from the picture.
 * - A **partial** result says so: a `spans` result reports how much of it is
 *   on screen and, for as long as the service names a next offset, offers the
 *   next page — appended after the rows already drawn, which stay on screen
 *   while it loads and if it fails. A `trace` arrives whole. A trace the
 *   correlator itself bounded says so and gives the refine route — narrowing
 *   the query or capturing a shorter interaction — since nothing more of it is
 *   in memory.
 * - **The canvas draws at most `MAX_DRAWN_ROWS` bars, absolutely.** A walk —
 *   a trace's, or every span page loaded so far — longer than that budget is
 *   drawn one window at a time (see "The drawn-row window" below): the footer
 *   states which rows are drawn and how many precede and follow them undrawn,
 *   and "Previous spans" and "Next spans" MOVE the window over the walk without
 *   asking the provider for anything; nothing the reader does grows it. The
 *   table below the canvas lists exactly the rows the window draws, a span
 *   selected elsewhere in the panel pages the window to it, and the window
 *   returns to the walk's first row when the node's query changes.
 * - URLs, statements and attribute values arrive redacted and truncated. They
 *   are rendered exactly as given: nothing here reconstructs a URL, expands a
 *   statement or dumps an attribute bag.
 *
 * ## The styling contract this file declares for `../styles/components.css`
 *
 *   dg-timeline                the block: a column of toolbar, canvas, detail,
 *                              table and footer
 *   dg-timeline__toolbar       the summary strip above the canvas
 *   dg-timeline__viewport      the scroll container around the canvas
 *   dg-timeline__canvas        the SVG itself
 *   dg-timeline__axis          the time axis group, its ticks, gridlines and
 *   dg-timeline__axis-tick     labels
 *   dg-timeline__gridline
 *   dg-timeline__axis-label
 *   dg-timeline__lanes         the lane bands, their accents and their labels
 *   dg-timeline__lane
 *   dg-timeline__lane-label
 *   dg-timeline__row           one span: its bar and its label — beside the
 *   dg-timeline__bar           bar on a backdrop, or inside it (`--inside`)
 *   dg-timeline__bar-label
 *   dg-timeline__bar-label--inside
 *   dg-timeline__bar-label-backdrop
 *   dg-timeline__edge          a parent → child connector
 *   dg-timeline__overflow      a "+N" mark: the spans of one lane depth that
 *   dg-timeline__overflow-label  overlap more deeply than it draws sub-rows
 *                              for, gathered on the depth's overflow row, and
 *                              the mark's count
 *   dg-timeline__detail        the reserved, never-wrapping line between the
 *                              canvas and the table: the selected span, or a
 *                              hovered or focused one previewed in its place
 *   dg-timeline__detail-rest   that line's trailing run, clipped rather than
 *                              wrapped on a narrow panel
 *   dg-timeline__detail-note   the lineage note in that run: the one item that
 *                              gives way, cut with a visible ellipsis
 *   dg-timeline__tooltip       the slot the shown row's description sits in,
 *                              and the slot of the note's flag beside it
 *   dg-timeline__equivalent    the keyboard-reachable table of the same rows
 *   dg-timeline__empty         the three states
 *   dg-timeline__loading
 *   dg-timeline__error
 *   dg-is-selected             states, composed onto a bar or an edge
 *   dg-is-ambiguous
 *   dg-is-inferred             (an edge only)
 *   dg-is-orphan / dg-is-orphaned
 *
 * `dg-is-orphan` is what the stylesheet paints; `dg-is-orphaned` is the name
 * the component contract uses for the same state. Both are written, so the
 * rendered mark and the contract agree and neither has to be guessed at.
 *
 * @see ../utils/scale for the time scale, the placement of a bar, the lane and
 * depth rhythm, the children-only trace walk and the axis ticks.
 * @see ../utils/color for the kind and tier scales this file hands to CSS.
 * @see ./SourceLink for hop 1 of the click-to-source chain.
 */

import type { DataQuery, TimelineNode } from '@debuggen/panel-schema';
import { PANEL_NODE_CATALOG } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { clampNonNegative } from '@debuggen/shared';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceTree,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { ChartGantt } from 'lucide-react';

import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import type { BadgeTone } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn } from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  useDataProvider,
} from '../host/DataProvider';
import type { DataProvider } from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import { kindColorVar, statusTone, tierColorVar } from '../utils/color';
import {
  DEFAULT_LABEL_FONT_SIZE,
  NOT_AVAILABLE_LABEL,
  collapseWhitespace,
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
  formatUntrustedText,
  pluralize,
} from '../utils/format';
import type { CountedNoun, TextMeasure } from '../utils/format';
import {
  CHART_VIEWBOX_WIDTH,
  DEFAULT_MAX_TRACE_ROWS,
  DEFAULT_ROW_HEIGHT,
  MAX_DRAWN_ROWS,
  alignHairline,
  clamp,
  createTimeScale,
  flattenTraceRows,
  generateAxisTicks,
  layoutDepth,
  layoutLaneStack,
  nextWindowStart,
  placeSpanDuration,
  previousWindowStart,
  rankLaneDepths,
  windowContains,
  windowRows,
  windowStartFor,
} from '../utils/scale';
import type {
  AxisTick,
  FlatTraceRow,
  RowWindow,
  SpanGeometry,
  TimeScale,
  TraceLayoutOptions,
} from '../utils/scale';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The catalog entry, and the vocabulary taken from it
 *
 * The node catalog is the single registry of node types: which sources this
 * node may read and which telemetry fields it reads are declared there and
 * imported here, never restated. A source the catalog does not allow is
 * reported as a failure rather than drawn from, because a panel that asked for
 * an aggregate has asked for something this view cannot place on an axis.
 * ---------------------------------------------------------------------------
 */

/** This node type's catalog entry: its label and the sources it may read. */
const CATALOG_ENTRY = PANEL_NODE_CATALOG.timeline;

/**
 * The lanes, in the fixed order the product reads a stack in: the browser
 * where an interaction starts, the server it reached, the datastore under it.
 *
 * A tier with no rows keeps its place in the order and occupies no height, so
 * a missing tier cannot open a gap a reader would take for empty time. A tier
 * this build does not know — telemetry crosses three process boundaries and is
 * read back from a store an older build may not share a vocabulary with — is
 * appended after these three rather than dropped.
 */
const TIER_LANE_ORDER: readonly TelemetryTier[] = Object.freeze([
  'browser',
  'server',
  'db',
] as const);

/*
 * ---------------------------------------------------------------------------
 * Canvas structure
 *
 * Unitless SVG user units, which is what `../utils/scale` speaks and what the
 * stylesheet deliberately does not: every rule there sets paint and text only,
 * so a coordinate has exactly one owner. Once the canvas's width has been
 * measured a user unit is one CSS pixel (see this module's header), so each of
 * these is the same pixel extent at every panel width — a gutter or a row does
 * not grow with the panel — and only the time axis between the two gutters
 * takes up the panel's width. Before a measurement they are units of the
 * fallback frame, `CHART_VIEWBOX_WIDTH` wide, and scale with it. None of these
 * is a CSS value — no `px`, no `rem`, no colour.
 * ---------------------------------------------------------------------------
 */

/**
 * The measure every bar label is fitted with: `../utils/format`'s
 * deterministic advance estimate at the label role's size — `--dg-mono-sm`,
 * 11 units, which is `DEFAULT_LABEL_FONT_SIZE`. Created once, since it depends
 * on nothing but that size, so the geometry below is a pure function of the
 * model and the canvas width.
 */
const BAR_LABEL_MEASURE: TextMeasure = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);

/**
 * The frame a model is drawn on before its canvas has been measured: the fixed
 * logical width `CHART_VIEWBOX_WIDTH` and the label measure. One frozen value,
 * so every unmeasured render — a host's first layout, or a layout-free test DOM
 * — lays a model out exactly as every other does (see {@link canvasFrameFor}).
 */
const FALLBACK_CANVAS_FRAME: CanvasFrame = Object.freeze({
  width: CHART_VIEWBOX_WIDTH,
  measureText: BAR_LABEL_MEASURE,
});

/**
 * The leading gutter the tier labels occupy, before the time axis begins.
 *
 * Nothing but a lane label is drawn in it: a bar starts at its right edge at
 * the earliest, and a bar's label never extends left of it.
 */
const LANE_LABEL_WIDTH = 108;

/** The trailing gutter, so a bar that reaches the window's end still has an edge. */
const CANVAS_RIGHT_GUTTER = 12;

/** The accent stripe at a lane's leading edge, carrying the tier colour. */
const LANE_ACCENT_WIDTH = 3;

/** The band above the lanes that holds the axis ticks and their labels. */
const AXIS_BAND_HEIGHT = 20;

/** How far a tick mark reaches up from the foot of the axis band. */
const AXIS_TICK_LENGTH = 4;

/** The baseline the axis labels sit on, inside the axis band. */
const AXIS_LABEL_BASELINE = 11;

/** The gap between a row's bar and the label beside it. */
const BAR_LABEL_GAP = 6;

/** The vertical inset of a bar inside its row, which is what separates two rows. */
const BAR_INSET = 3;

/** Space below the last lane, so the deepest bar is not flush with the edge. */
const CANVAS_BOTTOM_PADDING = 6;

/**
 * The inset between a bar's edges and a label drawn inside it: the bar's own
 * vertical inset, so the text sits in an even margin on the kind fill.
 */
const BAR_LABEL_INSET = BAR_INSET;

/**
 * The fewest graphemes of a span's name a shortened bar label keeps before its
 * ellipsis.
 *
 * Below this a label names nothing a reader could recognise — "c…" identifies
 * no span — so the bar is left unlabelled instead. Nothing is lost by that:
 * the full name is in the bar's description, the detail strip and the table
 * below the canvas.
 */
const MIN_BAR_LABEL_GRAPHEMES = 4;

/**
 * The separator between a bar label's name and its duration.
 *
 * Text, not punctuation with a meaning: the label reads "name · duration".
 */
const BAR_LABEL_SEPARATOR = ' · ';

/*
 * ---------------------------------------------------------------------------
 * The render-local model
 *
 * THIS IS NOT A SCHEMA. The shapes that cross a process boundary are defined
 * exactly once, in `@debuggen/telemetry`, and this package imports them as
 * types only. What follows is the flat, already-positioned view of them that
 * this one component draws — one row per span, whichever payload it came
 * from — so that the two payload shapes are reconciled in ONE place instead of
 * in every branch of the render. Its field names deliberately echo the
 * telemetry timeline row (`depth`, `offsetMs`'s origin, `durationMs`), so a
 * reader moving between the two is reading the same vocabulary.
 * ---------------------------------------------------------------------------
 */

/**
 * One span as its payload's walk produced it: its identity, its place in the
 * tree and its flags — everything a drawn row carries except where it is drawn.
 */
interface SpanBar {
  /** The event's own id — what a selection and an evidence citation name. */
  readonly eventId: string;
  /** The span id, which is what a parent → child edge is resolved through. */
  readonly spanId: string;
  /** The parent span, absent at a root of the drawn tree. */
  readonly parentSpanId?: string | undefined;
  /** The trace this span belongs to. */
  readonly traceId: string;
  /** The operation's name, exactly as captured and redacted. */
  readonly name: string;
  /** The kind, which decides the bar's colour through `../utils/color`. */
  readonly kind: TelemetryKind;
  /** The tier, which decides the lane. */
  readonly tier: TelemetryTier;
  /** The start, in epoch milliseconds as a double (the product's time base). */
  readonly startTime: number;
  /** The inclusive duration, in milliseconds. */
  readonly durationMs: number;
  /** Distance from the drawn tree's root; `0` at a root. */
  readonly depth: number;
  /** The reported status: unset, ok or error. */
  readonly status: TelemetryStatus;
  /** Where in the project this span resolved to, when it resolved at all. */
  readonly source?: SourceLocation | undefined;
  /** The attribution mechanism, when the span joined its trace asynchronously. */
  readonly lineage?: string | undefined;
  /** Whether more than one candidate parent was open at attribution time. */
  readonly lineageAmbiguous: boolean;
  /** The other candidate parents, when the attribution was ambiguous. */
  readonly lineageCandidates: readonly string[];
  /** Whether the correlator had to re-attach this span rather than place it. */
  readonly orphaned: boolean;
  /** Why it had to, when the correlator recorded a reason. */
  readonly orphanReason?: string | undefined;
  /**
   * Whether this span names a parent that no loaded row carries, which is why
   * it is drawn at the top level.
   *
   * A statement about THIS VIEW'S rows and never about the capture: the parent
   * may sit on a page not loaded yet or outside the query, so this is not the
   * correlator's {@link orphaned} flag and never sets it. Only a `spans` page
   * can raise it — a trace's structure is the correlator's, and its orphans are
   * already marked as such.
   */
  readonly parentNotLoaded: boolean;
}

/**
 * One drawn span: the span itself, the lane it is drawn in, and where it sits
 * in the whole walk the drawn window was cut from (see "The drawn-row window"
 * below).
 */
interface TimelineBar extends SpanBar {
  /** Which lane this row belongs to, as an index into the model's `tiers`. */
  readonly laneIndex: number;
  /** The row's position in the whole walk, counting from `0`. */
  readonly walkIndex: number;
  /**
   * The walk position of the row its connector joins: the first row of the
   * whole walk carrying the span this row names as its parent, inside its own
   * trace. `undefined` when it names none, or when no row of the walk carries
   * it (a flat page's "Parent not loaded").
   */
  readonly parentWalkIndex: number | undefined;
  /**
   * Whether that row is drawn in the same window as this one. A connector is
   * drawn only then: a parent outside the window has no bar to join, and a
   * line to another row would assert a relationship that is not there.
   */
  readonly parentDrawn: boolean;
}

/** The rows of one payload, the window they occupy and what was left out. */
interface TimelineModel {
  /** The drawn rows — the window's, never more than `MAX_DRAWN_ROWS` — in walk order. */
  readonly rows: readonly TimelineBar[];
  /** The tiers the drawn rows occupy, in lane order — the index `TimelineBar.laneIndex` names. */
  readonly tiers: readonly TelemetryTier[];
  /** Which rows of the whole walk are drawn, and how many precede and follow them. */
  readonly window: RowWindow;
  /**
   * The start of the WHOLE walk's time window, in epoch milliseconds: the
   * origin every offset reads from. Every window of one walk shares it, so an
   * offset means the same thing on every page of the walk.
   */
  readonly startTime: number;
  /** The end of the whole walk's time window, in epoch milliseconds. */
  readonly endTime: number;
  /**
   * Whether the walk itself left rows out, for any reason: its row ceiling,
   * its depth bound, or the correlator's own truncation. Rows the walk holds
   * but the window does not draw are {@link window}'s to state, not this flag's.
   */
  readonly truncated: boolean;
  /**
   * Whether the trace walk stopped at its row ceiling — the trace's own node
   * count — with more of the tree still unvisited: a tree that holds more
   * nodes than it reports. Only a trace sets it.
   */
  readonly walkBounded: boolean;
  /**
   * Whether the correlator itself bounded the trace before this view saw it.
   * Nothing more of it is in memory, so no control can show more: only a
   * narrower query or a shorter capture reaches the rest. Only a trace sets it.
   */
  readonly correlatorTruncated: boolean;
  /**
   * Whether the walk's DEPTH bound left children out. Paging the window does
   * not reach them, so the footer states it apart from the window.
   */
  readonly depthClamped: boolean;
  /**
   * The trace's own node count, or `undefined` for span pages, whose total
   * the service reports instead.
   */
  readonly nodeCount: number | undefined;
}

/**
 * A row before its lane is known.
 *
 * The lane index is an index into the model's own ordered tier list, which can
 * only be computed once every row has been seen, so the two passes are two
 * types rather than one type with a field that is briefly a lie.
 */
type UnassignedBar = Omit<TimelineBar, 'laneIndex'>;

/*
 * ---------------------------------------------------------------------------
 * Reading the pipeline's own attributes
 *
 * Lineage and correlation are recorded on an event's open attribute bag rather
 * than as schema fields, and the bag's values are `unknown` by construction —
 * an attribute may carry anything JSON-shaped, from any producer, including one
 * newer than this build. Each key is therefore read through a narrowing reader
 * below, and each key's NAME is written here as a string literal: the telemetry
 * package publishes those names as runtime constants, and this package depends
 * on it for types only, so importing the constant would add a runtime edge the
 * layering forbids. The names are the ones
 * `packages/telemetry/src/schema/attributes.ts` declares.
 * ---------------------------------------------------------------------------
 */

/** `attributes.lineage` — how an event was attributed across an async boundary. */
const LINEAGE_ATTRIBUTE = 'lineage';

/** `attributes.lineageAmbiguous` — more than one candidate parent was open. */
const LINEAGE_AMBIGUOUS_ATTRIBUTE = 'lineageAmbiguous';

/** `attributes.lineageCandidates` — the span ids of the other candidates. */
const LINEAGE_CANDIDATES_ATTRIBUTE = 'lineageCandidates';

/** `attributes.orphaned` — the correlator re-attached this span to the root. */
const ORPHANED_ATTRIBUTE = 'orphaned';

/** A non-empty string attribute, or `undefined` for anything else. */
function readStringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = attributes[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A boolean attribute, read as a flag.
 *
 * Only a real `true` counts. A string `"true"` is deliberately not accepted:
 * this flag decides whether the view states that an attribution is uncertain,
 * and coercing a value of the wrong type into that statement would be inventing
 * evidence rather than reading it.
 */
function readBooleanAttribute(attributes: Readonly<Record<string, unknown>>, key: string): boolean {
  return attributes[key] === true;
}

/** A list of non-empty strings, or an empty list for anything else. */
function readStringListAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = attributes[key];
  if (!Array.isArray(value)) {
    return [];
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      items.push(item);
    }
  }

  return items;
}

/*
 * ---------------------------------------------------------------------------
 * Normalising the two payloads
 * ---------------------------------------------------------------------------
 */

/** Whether an instant is usable as a window bound: finite and after the epoch. */
function isUsableInstant(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** A time window, in epoch milliseconds. */
interface TimeBounds {
  readonly start: number;
  readonly end: number;
}

/**
 * The window a run of spans occupies: the earliest start to the latest end,
 * or `0`–`0` when no span has a finite start.
 *
 * Generic over the row type, so the whole trace walk is bounded straight off
 * the borrowed events without building a bar for every row first.
 *
 * @param items The spans, in any order.
 * @param startOf Reads a span's start, in epoch milliseconds.
 * @param durationOf Reads a span's duration, in milliseconds; a non-finite or
 *   negative one counts as `0`.
 */
function boundsOfSpans<T>(
  items: readonly T[],
  startOf: (item: T) => number,
  durationOf: (item: T) => number,
): TimeBounds {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const itemStart = startOf(item);
    if (!Number.isFinite(itemStart)) {
      continue;
    }
    const duration = durationOf(item);
    const itemEnd = itemStart + (Number.isFinite(duration) ? Math.max(duration, 0) : 0);
    start = Math.min(start, itemStart);
    end = Math.max(end, itemEnd);
  }

  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : { start: 0, end: 0 };
}

/**
 * Orders the rows into lanes and stamps each row with its lane.
 *
 * The three known tiers keep {@link TIER_LANE_ORDER} and appear only when they
 * hold a row; a tier outside that vocabulary is appended in first-seen order,
 * so an event from a producer newer than this build gets a lane of its own
 * instead of being folded into somebody else's or dropped.
 */
function assignLanes(bars: readonly UnassignedBar[]): {
  rows: readonly TimelineBar[];
  tiers: readonly TelemetryTier[];
} {
  const tiers: TelemetryTier[] = [];

  for (const tier of TIER_LANE_ORDER) {
    if (bars.some((bar) => bar.tier === tier)) {
      tiers.push(tier);
    }
  }
  for (const bar of bars) {
    if (!tiers.includes(bar.tier)) {
      tiers.push(bar.tier);
    }
  }

  const rows = bars.map((bar) => ({
    ...bar,
    // `indexOf` is total here — every row's tier was just added — and the floor
    // is the compiler's reassurance rather than a case that can occur.
    laneIndex: Math.max(tiers.indexOf(bar.tier), 0),
  }));

  return { rows, tiers };
}

/** One trace-walk row, borrowed read-only, as a bar. */
function barFromTraceRow(row: FlatTraceRow): SpanBar {
  const { event } = row.node;
  const attributes = event.attributes;

  return {
    eventId: event.id,
    spanId: event.spanId,
    // The walk's parent, not the event's: the correlator re-attaches an orphan
    // to the trace root, and the edge this view draws must be the edge the tree
    // actually has.
    parentSpanId: row.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    kind: event.kind,
    tier: event.tier,
    startTime: event.startTime,
    durationMs: event.duration,
    depth: row.depth,
    status: event.status,
    source: event.source,
    lineage: row.lineage ?? readStringAttribute(attributes, LINEAGE_ATTRIBUTE),
    lineageAmbiguous:
      row.lineageAmbiguous || readBooleanAttribute(attributes, LINEAGE_AMBIGUOUS_ATTRIBUTE),
    lineageCandidates:
      row.node.lineage?.candidateSpanIds ??
      readStringListAttribute(attributes, LINEAGE_CANDIDATES_ATTRIBUTE),
    orphaned: row.orphaned,
    orphanReason: row.node.orphanReason,
    // A trace's nesting is the correlator's, drawn as it stands: a parent it
    // could not resolve is already stated through `orphaned` above.
    parentNotLoaded: false,
  };
}

/**
 * One flat event as a bar, at the depth the parent-first walk drew it at.
 *
 * @param event The loaded record.
 * @param depth Its depth in the walk of the loaded forest; `0` at a root.
 * @param parentNotLoaded Whether it names a parent no loaded row carries.
 */
function barFromEvent(event: TelemetryEvent, depth: number, parentNotLoaded: boolean): SpanBar {
  const attributes = event.attributes;

  return {
    eventId: event.id,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    kind: event.kind,
    tier: event.tier,
    startTime: event.startTime,
    durationMs: event.duration,
    depth,
    status: event.status,
    source: event.source,
    lineage: readStringAttribute(attributes, LINEAGE_ATTRIBUTE),
    lineageAmbiguous: readBooleanAttribute(attributes, LINEAGE_AMBIGUOUS_ATTRIBUTE),
    lineageCandidates: readStringListAttribute(attributes, LINEAGE_CANDIDATES_ATTRIBUTE),
    // The correlator's own flag, and nothing else. A parent that is merely
    // absent from THE LOADED ROWS is not an orphan (see this module's header).
    orphaned: readBooleanAttribute(attributes, ORPHANED_ATTRIBUTE),
    orphanReason: undefined,
    parentNotLoaded,
  };
}

/**
 * Orders two strings by UTF-16 code unit, with no locale.
 *
 * `localeCompare` would make the order depend on the host's locale data, so two
 * machines could draw one capture in two orders; plain `<`/`>` is the whole of
 * the comparison.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * The SIBLING order of a flat page: the canonical keys (`docs/ARCHITECTURE.md`,
 * "Ordering"), each reached only when every earlier key ties — `startTime`,
 * then `producerId`, then the producer's own `seq`, then the store's
 * `ingestSeq` — with the event id as defence in depth.
 *
 * It orders siblings, and the roots of the loaded forest, and nothing else.
 * Parent-before-child outranks every one of these keys and is established by
 * the walk in {@link flattenParentFirst}, never by a timestamp: the browser and
 * the server read two clocks and no alignment is applied, so a child's start
 * can legitimately read earlier than its parent's.
 *
 * A local mirror of `@debuggen/telemetry`'s `compareEventsCanonical`, key for
 * key and comparison for comparison. It is mirrored rather than imported
 * because this package depends on telemetry for types only, and importing the
 * function would add a runtime edge the layering forbids. Like that function
 * it compares with `<`/`>` alone, so a non-finite number — which the event
 * schema rejects, but which a store an older build wrote could still hand
 * over — falls through to the next key instead of returning `NaN` into the
 * sort. `ingestSeq` is distinct for every stored row, which is what makes the
 * order total; the id only separates hand-built or replayed records that reuse
 * an arrival number, so the order still never depends on the sort algorithm.
 *
 * @param left The first record.
 * @param right The second record.
 * @returns Negative when `left` sorts first, positive when `right` does, and `0`
 * only for two records that tie on every key.
 */
function compareSpans(left: TelemetryEvent, right: TelemetryEvent): number {
  if (left.startTime < right.startTime) {
    return -1;
  }
  if (left.startTime > right.startTime) {
    return 1;
  }
  if (left.producerId !== right.producerId) {
    return compareCodeUnits(left.producerId, right.producerId);
  }
  if (left.seq < right.seq) {
    return -1;
  }
  if (left.seq > right.seq) {
    return 1;
  }
  if (left.ingestSeq < right.ingestSeq) {
    return -1;
  }
  if (left.ingestSeq > right.ingestSeq) {
    return 1;
  }

  return compareCodeUnits(left.id, right.id);
}

/**
 * The identity a parent lookup resolves: a span id WITHIN its trace.
 *
 * W3C Trace Context makes a span id unique only inside the trace that carries
 * it, and a `spans` query with no `traceId` filter returns rows from several
 * traces at once. Keying a lookup by the bare span id would let a colliding id
 * in another trace pose as a row's parent — suppressing the "Parent not
 * loaded" mark and drawing a connector across two traces — so every parent,
 * carrier, child, claim and connector lookup in this file goes through this
 * key. The trace id is length-prefixed, which keeps the key unambiguous
 * whatever characters a stored id holds.
 *
 * @param traceId The trace the span belongs to.
 * @param spanId The span id, inside that trace.
 * @returns A key equal for two spans exactly when both ids are.
 */
function traceSpanKey(traceId: string, spanId: string): string {
  return `${String(traceId.length)}:${traceId}:${spanId}`;
}

/** One pending step of the parent-first walk: a record and the depth it is drawn at. */
interface SpanWalkStep {
  /** The record to emit. */
  readonly event: TelemetryEvent;
  /** Its distance from the root the walk started at. */
  readonly depth: number;
}

/**
 * The loaded rows of a flat span list, linked into a parent/child forest and
 * flattened parent-first.
 *
 * The rows are sorted by {@link compareSpans} and every row is then filed under
 * the span id it names as its parent, in that order, so each span's children
 * are already its siblings in canonical order. A row is a ROOT when it names no
 * parent, or when no loaded record other than itself carries the span id it
 * names. A record naming its own span id with no duplicate is therefore a root;
 * one naming a span id that no loaded record carries at all is a root marked
 * {@link TimelineBar.parentNotLoaded}, because its parent may sit on a page not
 * loaded yet or outside the query. Neither is the correlator's `orphaned`.
 *
 * A parent is always looked for in the row's OWN trace: every carrier, child,
 * claim and climb below is keyed by {@link traceSpanKey}, never by the bare
 * span id, so on a page holding several traces a colliding span id in another
 * trace can neither supply a missing parent nor draw a connector, and each
 * trace keeps its own parent-before-child order.
 *
 * The roots are walked in canonical order, depth-first and pre-order, and a
 * row's depth is the walk's depth. The walk is iterative, on an explicit stack,
 * because a result is paged at up to `DATA_QUERY_MAX_LIMIT` rows per page with
 * no bound on the number of pages, and a parent chain that long would overflow
 * the call stack of a recursive walk.
 *
 * Two records of one trace can carry one span id (a trace reports them as
 * `duplicateSpanIds`). That span's children expand under the FIRST-VISITED
 * record carrying it — it claims the span, and a later record of the same span
 * expands nothing — which is exactly the record the walk's first-row-per-span
 * lookup (`TimelineWalk.firstRowBySpan`) resolves, so every connector joins the
 * record its child is drawn beneath. A set of visited event ids — the identity the pages
 * were de-duplicated on — emits each record once.
 *
 * A parent cycle among the loaded rows (`A` names `B`, `B` names `A`), which a
 * well-formed capture cannot contain but a corrupted store could, leaves rows
 * that no root reaches: the cycle's members and every row hanging beneath
 * them. Once the roots are exhausted, each such component is entered at a row
 * ON its cycle — found by climbing the named parents from the canonically
 * first unreached row until the climb returns to a row it already passed — and
 * walked the same way, until every row has been emitted. A row hanging beneath
 * a cycle is therefore still drawn after its parent; only the one connector
 * that closes the cycle points backwards, since no order can place every
 * member of a cycle after its own parent. Nothing is dropped and nothing
 * throws.
 *
 * @param events Every row loaded so far, de-duplicated by event id, in any order.
 * @returns One bar per row, parents before their children.
 */
function flattenParentFirst(events: readonly TelemetryEvent[]): readonly SpanBar[] {
  const ordered = [...events].sort(compareSpans);

  // The key of the span a row names as its parent, inside the row's own trace,
  // or `undefined` for a row that names none.
  const parentKeyOf = (event: TelemetryEvent): string | undefined =>
    event.parentSpanId === undefined ? undefined : traceSpanKey(event.traceId, event.parentSpanId);

  // How many loaded records carry each span (trace and span id): the question
  // "is this parent loaded?" and, with the row itself subtracted, "is it loaded
  // as anything other than this row?".
  const carriers = new Map<string, number>();
  // The canonically first record carrying each span: the parent a climb toward
  // a cycle follows (see `cycleEntryFrom` below).
  const firstCarrierByKey = new Map<string, TelemetryEvent>();
  for (const event of ordered) {
    const key = traceSpanKey(event.traceId, event.spanId);
    carriers.set(key, (carriers.get(key) ?? 0) + 1);
    if (!firstCarrierByKey.has(key)) {
      firstCarrierByKey.set(key, event);
    }
  }

  const roots: TelemetryEvent[] = [];
  const childrenByParentKey = new Map<string, TelemetryEvent[]>();
  for (const event of ordered) {
    const parentKey = parentKeyOf(event);
    const otherCarriers =
      parentKey === undefined
        ? 0
        : (carriers.get(parentKey) ?? 0) - (event.parentSpanId === event.spanId ? 1 : 0);

    if (parentKey === undefined || otherCarriers <= 0) {
      roots.push(event);
      continue;
    }

    const siblings = childrenByParentKey.get(parentKey);
    if (siblings === undefined) {
      childrenByParentKey.set(parentKey, [event]);
    } else {
      siblings.push(event);
    }
  }

  const bars: SpanBar[] = [];
  const visitedEventIds = new Set<string>();
  const claimedKeys = new Set<string>();
  const stack: SpanWalkStep[] = [];

  const walkFrom = (start: TelemetryEvent): void => {
    stack.push({ event: start, depth: 0 });

    while (stack.length > 0) {
      const step = stack.pop();
      if (step === undefined || visitedEventIds.has(step.event.id)) {
        continue;
      }

      const { event, depth } = step;
      visitedEventIds.add(event.id);
      const parentKey = parentKeyOf(event);
      bars.push(barFromEvent(event, depth, parentKey !== undefined && !carriers.has(parentKey)));

      const key = traceSpanKey(event.traceId, event.spanId);
      if (claimedKeys.has(key)) {
        continue;
      }
      claimedKeys.add(key);

      // Pushed last-first, so the canonically first child is popped — and
      // emitted, with its whole subtree — before its next sibling.
      const children = childrenByParentKey.get(key) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined && !visitedEventIds.has(child.id)) {
          stack.push({ event: child, depth: depth + 1 });
        }
      }
    }
  };

  // The row a component no root reached is entered at: climb the named parents
  // from `from` until the climb returns to a row it already passed, which is a
  // row on the component's cycle. Every row a root did not reach names a parent
  // that no reached record carries (a reached carrier would have claimed that
  // span and expanded the row), so the climb stays among unreached rows of the
  // same trace; the visited check only makes that explicit. Each climb is
  // bounded by the rows it passes, and the walk that follows reaches every one
  // of them.
  const cycleEntryFrom = (from: TelemetryEvent): TelemetryEvent => {
    const climbed = new Set<string>();
    let cursor = from;

    while (!climbed.has(cursor.id)) {
      climbed.add(cursor.id);

      const parentKey = parentKeyOf(cursor);
      const parent = parentKey === undefined ? undefined : firstCarrierByKey.get(parentKey);
      if (parent === undefined || visitedEventIds.has(parent.id)) {
        return cursor;
      }
      cursor = parent;
    }

    return cursor;
  };

  for (const root of roots) {
    if (!visitedEventIds.has(root.id)) {
      walkFrom(root);
    }
  }
  for (const event of ordered) {
    if (!visitedEventIds.has(event.id)) {
      walkFrom(cycleEntryFrom(event));
    }
  }

  return bars;
}

/*
 * ---------------------------------------------------------------------------
 * The drawn-row window
 *
 * A capture can hold far more spans than one SVG can carry: a correlated trace
 * of tens of thousands of nodes is as many bars, labels and pointer handlers,
 * and a DevTools panel that mounts them freezes. So this view never draws more
 * than `MAX_DRAWN_ROWS` rows at once, however often the reader asks for more.
 *
 * Each payload is first WALKED whole — a trace children-only by
 * `flattenTraceRows`, a span forest parent-first by `flattenParentFirst` — into
 * a {@link TimelineWalk}: every row in walk order, the time window the whole
 * walk occupies, and the walk position of the first row carrying each span. A
 * walk is plain data and costs no DOM, and it is computed once per payload.
 * The MODEL is then one window of at most `MAX_DRAWN_ROWS` rows cut from it
 * (`windowRows` in `../utils/scale`); only those rows become bars, lanes,
 * labels, connectors and table rows. "Previous spans" and "Next spans" move
 * the window over the walk rather than growing it, and what lies before and
 * after the window is counted and stated in the footer, never silently dropped.
 *
 * The whole walk is kept, not only the window's rows, because three questions
 * need all of it: which window holds a span selected in another view of the
 * panel (so the window can be paged to it), which row a connector's parent is
 * (a parent may sit in another window, where drawing a connector to anything
 * on screen would join the wrong row), and what time window every page of the
 * walk shares (so an offset reads from one origin on every page). Holding the
 * walk costs one borrowed row per span, bounded by the trace's own node count;
 * holding its geometry would cost a bar, a label and a handler per span, which
 * is what the budget exists to prevent.
 * ---------------------------------------------------------------------------
 */

/**
 * One payload's rows, in walk order, exactly as its walk produced them: the
 * trace walk's rows are BORROWED (see `FlatTraceRow`) and become bars only when
 * a window draws them, while a span forest arrives as bars already, since
 * linking a flat page into a forest builds them anyway.
 */
type WalkRows =
  | { readonly source: 'trace'; readonly rows: readonly FlatTraceRow[] }
  | { readonly source: 'spans'; readonly bars: readonly SpanBar[] };

/** Every row one payload walks to, before a window is cut from it. */
interface TimelineWalk {
  /** The rows, in walk order. */
  readonly rows: WalkRows;
  /** How many rows the walk holds. */
  readonly total: number;
  /**
   * For each span — a span id inside its own trace, the key `traceSpanKey`
   * builds — the walk position of the first row carrying it: the row a
   * connector naming that span as its parent joins (see `flattenParentFirst`
   * on the first-claim rule this mirrors).
   */
  readonly firstRowBySpan: ReadonlyMap<string, number>;
  /** The whole walk's window start, in epoch milliseconds. */
  readonly startTime: number;
  /** The whole walk's window end, in epoch milliseconds. */
  readonly endTime: number;
  /** See {@link TimelineModel.walkBounded}. */
  readonly walkBounded: boolean;
  /** See {@link TimelineModel.correlatorTruncated}. */
  readonly correlatorTruncated: boolean;
  /** See {@link TimelineModel.depthClamped}. */
  readonly depthClamped: boolean;
  /** See {@link TimelineModel.nodeCount}. */
  readonly nodeCount: number | undefined;
}

/**
 * The most rows a trace walk visits: the trace's own node count, or
 * `DEFAULT_MAX_TRACE_ROWS` when that count is smaller or unusable.
 *
 * Every node the correlator reports is reachable by paging, so the ceiling is
 * never below the count; it exists only so that a tree which holds more nodes
 * than it reports — a store round-trip gone wrong, or an object graph that
 * shares a node — still ends its walk.
 */
function traceWalkCeiling(tree: TraceTree): number {
  const count = tree.nodeCount;

  return Number.isSafeInteger(count) && count > DEFAULT_MAX_TRACE_ROWS
    ? count
    : DEFAULT_MAX_TRACE_ROWS;
}

/**
 * The bounds the trace walk runs under.
 *
 * The walk visits ONE span past `ceiling` and keeps only the first `ceiling`
 * rows (its `visibleRows` window): whether it produced that extra span is the
 * exact answer to "does the tree hold more than this walk visited", which the
 * layout's `truncated` flag cannot give because the depth bound sets it too.
 *
 * @param tree The resolved trace.
 * @param ceiling The most spans the walk keeps.
 * @returns The layout options.
 */
function traceWalkOptions(tree: TraceTree, ceiling: number): TraceLayoutOptions {
  // The tree's own greatest depth bounds the walk. It is honoured only when it
  // is a usable positive integer: a stored tree reporting `0` while its roots
  // carry children would otherwise have every child left unvisited, and hiding
  // captured work is the one thing this walk may not do. Absent, the walk uses
  // the layout module's own bound.
  const rows = { maxRows: ceiling + 1, visibleRows: ceiling };
  return Number.isInteger(tree.maxDepth) && tree.maxDepth > 0
    ? { ...rows, maxDepth: tree.maxDepth }
    : rows;
}

/**
 * Records, for each span of a walk, the position of the first row carrying it.
 *
 * @param count How many rows the walk holds.
 * @param keyAt The span key of row `index`.
 */
function indexFirstRows(count: number, keyAt: (index: number) => string): Map<string, number> {
  const firstRowBySpan = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const key = keyAt(index);
    if (!firstRowBySpan.has(key)) {
      firstRowBySpan.set(key, index);
    }
  }

  return firstRowBySpan;
}

/**
 * A correlated trace, walked whole: the children-only walk, in tree order.
 *
 * @param tree The resolved trace.
 * @returns The walk, with what it and the correlator left out.
 */
function walkFromTrace(tree: TraceTree): TimelineWalk {
  const ceiling = traceWalkCeiling(tree);
  const layout = flattenTraceRows(tree, traceWalkOptions(tree, ceiling));
  const rows = layout.rows;

  // The tree publishes its own window, and the rows' own bounds WIDEN it rather
  // than replace it: an async continuation that settled after the root closed is
  // real captured work, and an axis that ended at the root's end would clip it.
  // Every row of the walk is counted, not only a window's, so each window of
  // the walk is drawn on the same axis.
  const derived = boundsOfSpans(
    rows,
    (row) => row.node.event.startTime,
    (row) => row.node.event.duration,
  );
  const startTime =
    rows.length === 0
      ? isUsableInstant(tree.startTime)
        ? tree.startTime
        : 0
      : isUsableInstant(tree.startTime)
        ? Math.min(tree.startTime, derived.start)
        : derived.start;
  const endTime =
    rows.length === 0
      ? isUsableInstant(tree.endTime)
        ? tree.endTime
        : 0
      : isUsableInstant(tree.endTime)
        ? Math.max(tree.endTime, derived.end)
        : derived.end;

  return {
    rows: { source: 'trace', rows },
    total: rows.length,
    firstRowBySpan: indexFirstRows(rows.length, (index) => {
      const event = rows[index]?.node.event;
      return event === undefined ? '' : traceSpanKey(event.traceId, event.spanId);
    }),
    startTime,
    endTime,
    // The lookahead span was produced only when the tree holds more within the
    // depth bound than the ceiling let the walk keep.
    walkBounded: layout.totalRowCount > ceiling,
    correlatorTruncated: tree.truncated,
    depthClamped: rows.some((row) => row.childrenTruncated),
    nodeCount: tree.nodeCount,
  };
}

/**
 * The loaded rows of a flat span list — every page loaded so far, already
 * de-duplicated — walked parent before child.
 *
 * The order is {@link flattenParentFirst}'s: the loaded rows linked into a
 * parent/child forest and walked depth-first, with {@link compareSpans}
 * ordering siblings. It is recomputed from every loaded row each time a page
 * settles, so a page that brings a parent re-links the children already on
 * screen beneath it, and clears their "Parent not loaded" mark.
 */
function walkFromSpans(events: readonly TelemetryEvent[]): TimelineWalk {
  const bars = flattenParentFirst(events);
  const window = boundsOfSpans(
    bars,
    (bar) => bar.startTime,
    (bar) => bar.durationMs,
  );

  return {
    rows: { source: 'spans', bars },
    total: bars.length,
    firstRowBySpan: indexFirstRows(bars.length, (index) => {
      const bar = bars[index];
      return bar === undefined ? '' : traceSpanKey(bar.traceId, bar.spanId);
    }),
    startTime: window.start,
    endTime: window.end,
    // A page is not a truncated result: how much of the result it holds is what
    // `total` reports, and the footer states it exactly rather than as a flag.
    walkBounded: false,
    correlatorTruncated: false,
    depthClamped: false,
    nodeCount: undefined,
  };
}

/** Row `index` of a walk as a span bar, or `undefined` past its end. */
function walkBarAt(walk: TimelineWalk, index: number): SpanBar | undefined {
  const { rows } = walk;
  if (rows.source === 'spans') {
    return rows.bars[index];
  }

  const row = rows.rows[index];
  return row === undefined ? undefined : barFromTraceRow(row);
}

/**
 * The walk position of the row the panel's selection stands for, or
 * `undefined` when no row of the walk does.
 *
 * The same precedence as the drawn rows' own lookup (`rowForSelection`): the
 * row carrying the selected event id wins, and failing that the first row
 * naming the same trace **and** the same span. One pass over the walk, run
 * only when the selection or the walk changes.
 *
 * @param walk The whole walk.
 * @param selection The panel's selection.
 */
function walkIndexOfSelection(walk: TimelineWalk, selection: PanelSelection): number | undefined {
  const { rows } = walk;
  let spanMatch: number | undefined;

  for (let index = 0; index < walk.total; index += 1) {
    const ref = walkRefAt(rows, index);
    if (ref === undefined) {
      continue;
    }
    if (ref.eventId === selection.eventId) {
      return index;
    }
    if (spanMatch === undefined && matchesPanelSelection(selection, ref)) {
      spanMatch = index;
    }
  }

  return spanMatch;
}

/**
 * Row `index` of a walk as the pointer a selection is matched against: a span
 * bar already is one, and a borrowed trace row names its event's three
 * coordinates.
 */
function walkRefAt(rows: WalkRows, index: number): PanelEventRef | undefined {
  if (rows.source === 'spans') {
    return rows.bars[index];
  }

  const event = rows.rows[index]?.node.event;
  return event === undefined
    ? undefined
    : { eventId: event.id, traceId: event.traceId, spanId: event.spanId };
}

/**
 * The model one window of a walk draws: at most `MAX_DRAWN_ROWS` rows from
 * `start`, laid out in lanes of their own, on the whole walk's time window.
 *
 * Only the window's rows become bars; a start at or past the end of the walk
 * shows its last window (see `windowRows`). Each drawn row carries where its
 * connector's parent sits in the whole walk, and whether that parent is drawn
 * in this window too.
 *
 * @param walk The whole walk.
 * @param start The first row to draw.
 * @returns The model of that window.
 */
function modelFromWalk(walk: TimelineWalk, start: number): TimelineModel {
  const window = windowRows(walk.total, start, MAX_DRAWN_ROWS);
  const bars: UnassignedBar[] = [];

  for (let index = window.start; index < window.end; index += 1) {
    const bar = walkBarAt(walk, index);
    if (bar === undefined) {
      continue;
    }
    const parentWalkIndex =
      bar.parentSpanId === undefined
        ? undefined
        : walk.firstRowBySpan.get(traceSpanKey(bar.traceId, bar.parentSpanId));
    bars.push({
      ...bar,
      walkIndex: index,
      parentWalkIndex,
      parentDrawn: parentWalkIndex !== undefined && windowContains(window, parentWalkIndex),
    });
  }

  const { rows, tiers } = assignLanes(bars);

  return {
    rows,
    tiers,
    window,
    startTime: walk.startTime,
    endTime: walk.endTime,
    // Every truncation matters and they are different statements: the
    // correlator may have dropped nodes before this view saw the tree, and the
    // walk may have stopped at its ceiling or its depth bound.
    truncated: walk.correlatorTruncated || walk.walkBounded || walk.depthClamped,
    walkBounded: walk.walkBounded,
    correlatorTruncated: walk.correlatorTruncated,
    depthClamped: walk.depthClamped,
    nodeCount: walk.nodeCount,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * One pure function of the model and the frame it is drawn on — the canvas's
 * width and the label estimate of {@link CanvasFrame} — so the same model at
 * the same width always draws the same picture, and no layout is read here:
 * the width is measured once, by the view, and handed in. Every number
 * below comes out of `../utils/scale`: the time-to-coordinate map, a bar's
 * offset and width with its minimum visible width and its edge clipping, the
 * lane stack, the depth rhythm and the axis ticks. Re-deriving any of that
 * here would give the product two timelines that disagree slightly.
 * ---------------------------------------------------------------------------
 */

/** A floor on a bar's height, so a row rhythm change can never erase a bar. */
const MIN_BAR_HEIGHT = 4;

/**
 * The most sub-rows one depth of one lane is packed into: 6.
 *
 * Spans of one depth that overlap once drawn are stacked into sub-rows (see
 * "Packing a depth" below) rather than painted over one another. Stacking
 * without a bound would let one crowded depth — a commit that re-rendered two
 * thousand components inside a few milliseconds — push every other lane out
 * of the viewport, which is the failure the bound exists to prevent. Six rows
 * keep the longest overlapping operations of a depth legible side by side;
 * beyond that, the depth's remaining spans are gathered into "+N" marks on one
 * extra row beneath it, and every one of them is still a row of the table
 * below the canvas.
 */
const MAX_SUB_ROWS_PER_DEPTH = 6;

/**
 * How far one bar may run past the next one's left edge and still count as
 * merely touching it, in user units: one millionth of a unit.
 *
 * Two spans where one ends exactly as the next begins share an edge and belong
 * on one sub-row. Their edges are computed through the scale separately — the
 * first as `x + width`, the second as a mapped instant — so a shared edge can
 * differ by a rounding step of floating-point arithmetic, and without this
 * slack such a pair would be split onto two sub-rows for no visible reason.
 * The tolerance is far below anything a display can resolve, so a real overlap
 * is never mistaken for a touch. It is the flame chart's value for the same
 * judgement, so the two views pack one capture alike.
 */
const TOUCH_TOLERANCE = 1e-6;

/** One lane band: where it sits, how tall it is and which accent it carries. */
interface LaneGeometry {
  /** The tier this lane holds. */
  readonly tier: TelemetryTier;
  /** The tier's readable name, from the one table that spells the three words. */
  readonly label: string;
  /** The tier accent, as a token reference for `--dgc-lane-color`. */
  readonly accent: string;
  /** The band's top edge. */
  readonly y: number;
  /** The band's height: its depth rows and the gutters between them. */
  readonly height: number;
  /**
   * How many rows the lane holds. Each distinct depth among its spans takes
   * the sub-rows its overlapping spans pack into — one where none overlap, at
   * most {@link MAX_SUB_ROWS_PER_DEPTH} — plus one overflow row where more
   * overlapped than that (see "Packing a depth" below).
   */
  readonly rowCount: number;
}

/**
 * Where a bar's label sits: beside the bar on the lane surface (after its end
 * or before its start), or inside it on the kind fill.
 */
type BarLabelPlacement = 'after' | 'before' | 'inside';

/** A bar's label, fitted and placed (see "Bar labels" below). */
interface BarLabelGeometry {
  /**
   * The text drawn: the span's name and precise duration, or — where that does
   * not fit anywhere — a shortened form: the name cut to an ellipsis with the
   * duration kept, or the name alone.
   */
  readonly text: string;
  /** Where the text starts, or ends when it is anchored at its end. */
  readonly x: number;
  /** Which side of {@link x} the text occupies. */
  readonly anchor: 'start' | 'end';
  /** Beside the bar or inside it, which decides the label's paint. */
  readonly placement: BarLabelPlacement;
  /** The text's left edge, whichever way it is anchored. */
  readonly start: number;
  /** The text's estimated advance width, in user units. */
  readonly width: number;
}

/** One span's bar, its label and the paint it carries. */
interface BarGeometry {
  /** The row this bar draws. */
  readonly row: TimelineBar;
  /** The row of its lane the bar sits in, counting from `0`. */
  readonly laneRow: number;
  /** The bar's left edge. */
  readonly x: number;
  /** The bar's width, never below the scale's minimum visible width. */
  readonly width: number;
  /** The bar's right edge. */
  readonly end: number;
  /** The bar's top edge. */
  readonly y: number;
  /** The bar's height. */
  readonly height: number;
  /** The bar's vertical centre — where a connector meets it. */
  readonly centerY: number;
  /** The kind colour, as a token reference for `--dgc-bar-color`. */
  readonly color: string;
  /**
   * The bar's label, or `undefined` where no recognisable form of it fits
   * anywhere near the bar. The span's name is still in the bar's description,
   * the detail strip and the table.
   */
  readonly label: BarLabelGeometry | undefined;
  /** Whether the bar was widened to stay visible — a sub-millisecond operation. */
  readonly minWidthApplied: boolean;
}

/** One parent → child connector. */
interface EdgeGeometry {
  /** The child row's event id, which is what makes the connector's key unique. */
  readonly id: string;
  /** The elbow path: down from the parent's leading edge, then across to the child's. */
  readonly path: string;
  /** Whether the attribution had more than one candidate parent. */
  readonly ambiguous: boolean;
  /**
   * Whether the child joined its parent through a lineage attribution with a
   * single candidate: inferred rather than measured, and not ambiguous.
   */
  readonly inferred: boolean;
  /** Whether the child was re-attached rather than placed. */
  readonly orphaned: boolean;
}

/** A "+N" mark's count label, placed where it fits (see `labelOverflowRow`). */
interface OverflowLabelGeometry {
  /** The text drawn: `+` and the count. */
  readonly text: string;
  /** Where the text starts, or ends when it is anchored at its end. */
  readonly x: number;
  /** Which side of {@link x} the text occupies. */
  readonly anchor: 'start' | 'end';
}

/**
 * One "+N" mark: a run of overlapping spans of one lane depth that the depth's
 * sub-rows could not hold, gathered into one outlined band on the depth's
 * overflow row instead of being painted over one another.
 */
interface OverflowGeometry {
  /** A stable key: the event id of the first span the mark gathers. */
  readonly id: string;
  /** The band's left edge: the leftmost drawn extent it gathers. */
  readonly x: number;
  /** The band's width, from that edge to the rightmost drawn end it gathers. */
  readonly width: number;
  /** The band's top edge. */
  readonly y: number;
  /** The band's height: a bar's height on its row. */
  readonly height: number;
  /** The band's vertical centre, where its count label sits. */
  readonly centerY: number;
  /** How many spans the mark gathers. */
  readonly count: number;
  /** The earliest start among them, in epoch milliseconds. */
  readonly startTime: number;
  /** The latest end among them, in epoch milliseconds. */
  readonly endTime: number;
  /** The count label, or `undefined` where it fits nowhere beside the band. */
  readonly label: OverflowLabelGeometry | undefined;
}

/** Everything the canvas needs, computed once per model. */
interface TimelineGeometry {
  /** The time-to-coordinate map the bars and the axis share, in user units. */
  readonly scale: TimeScale;
  /** The lane bands, in lane order. */
  readonly lanes: readonly LaneGeometry[];
  /**
   * One bar per row the lanes draw a bar for, in the model's order. A row
   * gathered into a "+N" mark has no bar; it is counted by its mark and listed
   * in the table like every other row.
   */
  readonly bars: readonly BarGeometry[];
  /** The "+N" marks, lane by lane and left to right on each overflow row. */
  readonly overflow: readonly OverflowGeometry[];
  /** The event ids of every row gathered into a "+N" mark. */
  readonly gatheredEventIds: ReadonlySet<string>;
  /** The connectors, drawn before the bars so none crosses a label. */
  readonly edges: readonly EdgeGeometry[];
  /** The axis ticks, already positioned and labelled. */
  readonly ticks: readonly AxisTick[];
  /** The canvas's width in user units: the lane bands span it. */
  readonly width: number;
  /** The canvas's height in user units. */
  readonly height: number;
}

/** A depth read defensively: a value that is not a non-negative integer is a root. */
function usableDepth(depth: number): number {
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * The canvas a model is drawn on: what {@link buildGeometry} needs beyond the
 * data. It holds a width and nothing else about the page — the view resolves
 * it from the canvas's measured width with {@link canvasFrameFor}.
 */
interface CanvasFrame {
  /**
   * The canvas's width in user units, which is also its `viewBox` width: the
   * measured width in CSS pixels, or `CHART_VIEWBOX_WIDTH` before one exists.
   */
  readonly width: number;
  /** Estimates a string's advance in the bar-label role, in the same user units. */
  readonly measureText: TextMeasure;
}

/**
 * The narrowest frame a model is laid out in: both gutters and a time axis as
 * wide as the lane-label gutter.
 *
 * The stylesheet's chart minimum keeps a real canvas far wider than this; the
 * floor only stops a pathological measurement — a canvas squeezed below its
 * own gutters — from handing the time scale an inverted range, which it would
 * swap and so draw bars across the lane labels. An element narrower than the
 * floor shows this frame scaled down to fit it, as `meet` fits any drawing
 * wider than its box.
 */
const MIN_CANVAS_FRAME_WIDTH = LANE_LABEL_WIDTH * 2 + CANVAS_RIGHT_GUTTER;

/**
 * The frame a model is drawn on at a measured canvas width.
 *
 * @param width The canvas's accepted rendered width in CSS pixels (see
 *   {@link acceptCanvasWidth}), or `undefined` while none has been measured.
 * @returns {@link FALLBACK_CANVAS_FRAME} while nothing is measured, and
 *   otherwise a frame exactly that wide — never narrower than
 *   {@link MIN_CANVAS_FRAME_WIDTH} — so one user unit is one CSS pixel.
 */
function canvasFrameFor(width: number | undefined): CanvasFrame {
  if (width === undefined) {
    return FALLBACK_CANVAS_FRAME;
  }

  return Object.freeze({
    width: Math.max(width, MIN_CANVAS_FRAME_WIDTH),
    measureText: BAR_LABEL_MEASURE,
  });
}

/*
 * Bar labels
 *
 * A bar's label is its span's name and precise duration ("name · 12.40 ms"),
 * the very text the bar's title, the detail strip and the table print for the
 * same span, so one span never reads "1.6 s" on its bar and "1.567 s" in its
 * row. Only the axis ticks are compact: a tick marks a position on the scale,
 * not a measurement a reader compares. The label is fitted in logical units
 * with the frame's advance estimate and drawn in the first place it fits whole:
 *
 *   1. after the bar — start-anchored `BAR_LABEL_GAP` past its end;
 *   2. before the bar — end-anchored `BAR_LABEL_GAP` before its start;
 *   3. inside the bar — start-anchored `BAR_LABEL_INSET` past its start, in
 *      the `dg-timeline__bar-label--inside` treatment (the base surface on the
 *      kind fill, as a flame frame's label is drawn).
 *
 * Where it fits in none of them, it is shortened into the WIDEST of the three
 * rooms (ties go to the order above): the name is cut to an ellipsis and the
 * " · duration" suffix kept while at least `MIN_BAR_LABEL_GRAPHEMES` of the
 * name fit beside it — the duration is what the bar's length encodes, and a
 * reader compares it across bars — otherwise the name alone is drawn, cut if it
 * must be. The room before a bar is considered too, not only the room after and
 * inside it: a late, short span (a commit at the window's end) has no room
 * after it and none inside, and the room before it is where its name still
 * fits. Where not even that fits, the bar is left unlabelled (`undefined`).
 *
 * A room is the free run of the bar's OWN ROW on that side: bounded by the
 * lane-label column on the left and the canvas's trailing gutter on the right,
 * and ended by any other bar on the row or any label already placed there,
 * each kept `BAR_LABEL_GAP` clear so a label cannot be read as belonging to its
 * neighbour. So no label is drawn over a lane label, past the canvas edge, over
 * a foreign bar or over another label. The row is the only scope a collision
 * needs: a label is centred in its row, and the row pitch is taller than the
 * label's glyphs, so it cannot reach a neighbouring row's bars.
 *
 * Bars are labelled in the model's row order, so a parent, drawn first, claims
 * its room before the siblings that follow it. The result is a pure function of
 * the bar geometry and the deterministic estimate: identical on every render
 * and in every environment, with or without layout.
 */

/** A horizontal run of one row, in user units, from `start` to `end`. */
interface RowExtent {
  readonly start: number;
  readonly end: number;
}

/** A bar before it is labelled: everything {@link BarGeometry} holds but the label. */
type UnlabelledBar = Omit<BarGeometry, 'label'>;

/** The key of the row a bar sits in: its lane and its row within that lane. */
function rowKeyOfBar(bar: UnlabelledBar): string {
  return `${String(bar.row.laneIndex)}:${String(bar.laneRow)}`;
}

/** Appends `value` to the list `key` names, creating the list on first use. */
function appendToRow<T>(rows: Map<string, T[]>, key: string, value: T): void {
  const values = rows.get(key);
  if (values === undefined) {
    rows.set(key, [value]);
  } else {
    values.push(value);
  }
}

/**
 * The run from `start` to `end` widened by `BAR_LABEL_GAP` on both sides: an
 * obstacle as a label must keep clear of it, the gap it keeps from its own bar.
 */
function paddedExtent(start: number, end: number): RowExtent {
  return { start: start - BAR_LABEL_GAP, end: end + BAR_LABEL_GAP };
}

/**
 * How many of the ascending `values` are at most `value` — or, when `strict`,
 * less than it. A binary search, so a room query costs a logarithm of the
 * row's size rather than a scan of it.
 */
function countUpTo(values: readonly number[], value: number, strict: boolean): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    // In range by the loop bound; the fallback only satisfies the index type.
    const probe = values[middle] ?? Number.POSITIVE_INFINITY;
    if (strict ? probe < value : probe <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

/**
 * One row's obstacles, indexed for the room queries of {@link placeBarLabel}:
 * its bars, fixed once every bar is placed, and the labels placed on it so far.
 * Every extent is padded ({@link paddedExtent}).
 *
 * Indexed rather than scanned because a row can be long — a render-heavy
 * capture puts hundreds or thousands of spans at one depth of one lane — and
 * a scan per query would make labelling quadratic in the row. The bars are
 * ordered by start with running maxima of their ends, so "does a bar other
 * than this one cover this point, and where does the nearest one begin or
 * end" is one binary search. The labels never overlap one another — each is
 * placed in a room that excludes every label before it — so, ordered by start,
 * they are ordered by end too, and the same questions are one search each.
 */
interface RowIndex {
  /** The padded start of each bar, ordered by start. */
  readonly starts: readonly number[];
  /** Where each bar sits in that order. */
  readonly positionOf: ReadonlyMap<UnlabelledBar, number>;
  /**
   * For the prefix of that order ending at each position: the position of
   * the bar with the greatest padded end, that end, and the greatest end
   * among the prefix's other bars — so the greatest end with any one bar left
   * out is known without a rescan.
   */
  readonly leaderAt: readonly number[];
  readonly leaderEnd: readonly number[];
  readonly runnerUpEnd: readonly number[];
  /** The padded starts and ends of the labels placed on the row, ordered by start. */
  readonly labelStarts: number[];
  readonly labelEnds: number[];
}

/** Indexes one row's bars; the row starts with no labels. */
function indexRow(rowBars: readonly UnlabelledBar[]): RowIndex {
  // `sort` is stable, so bars that start together keep the model's order.
  const bars = [...rowBars].sort((left, right) => left.x - right.x);
  const starts: number[] = [];
  const positionOf = new Map<UnlabelledBar, number>();
  const leaderAt: number[] = [];
  const leaderEnd: number[] = [];
  const runnerUpEnd: number[] = [];

  let leader = -1;
  let best = Number.NEGATIVE_INFINITY;
  let second = Number.NEGATIVE_INFINITY;
  for (const [position, bar] of bars.entries()) {
    const extent = paddedExtent(bar.x, bar.end);
    starts.push(extent.start);
    positionOf.set(bar, position);
    if (extent.end > best) {
      second = best;
      best = extent.end;
      leader = position;
    } else if (extent.end > second) {
      second = extent.end;
    }
    leaderAt.push(leader);
    leaderEnd.push(best);
    runnerUpEnd.push(second);
  }

  return {
    starts,
    positionOf,
    leaderAt,
    leaderEnd,
    runnerUpEnd,
    labelStarts: [],
    labelEnds: [],
  };
}

/**
 * The greatest padded end among the first `count` bars of the row with `self`
 * left out, or `-Infinity` when there is no such bar.
 */
function greatestBarEnd(index: RowIndex, count: number, self: UnlabelledBar): number {
  const last = count - 1;
  if (last < 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const leadsPrefix = index.leaderAt[last] === index.positionOf.get(self);

  return (
    (leadsPrefix ? index.runnerUpEnd[last] : index.leaderEnd[last]) ?? Number.NEGATIVE_INFINITY
  );
}

/**
 * The free run rightward of `from`, up to `limit` or the nearest obstacle
 * other than `self`'s own bar, whichever comes first; `0` when an obstacle
 * covers `from` itself.
 */
function roomRightOf(index: RowIndex, from: number, limit: number, self: UnlabelledBar): number {
  // The bars that start at or before `from`: one of them covers it when the
  // greatest of their ends lies past it. The first bar after them is the
  // nearest that starts past it — skipping `self`, should that be the one.
  const count = countUpTo(index.starts, from, false);
  if (greatestBarEnd(index, count, self) > from) {
    return 0;
  }
  const next = count === index.positionOf.get(self) ? count + 1 : count;
  let end = Math.min(limit, index.starts[next] ?? Number.POSITIVE_INFINITY);

  const labelCount = countUpTo(index.labelStarts, from, false);
  if ((index.labelEnds[labelCount - 1] ?? Number.NEGATIVE_INFINITY) > from) {
    return 0;
  }
  end = Math.min(end, index.labelStarts[labelCount] ?? Number.POSITIVE_INFINITY);

  return Math.max(end - from, 0);
}

/**
 * The free run leftward of `from`, down to `limit` or the nearest obstacle
 * other than `self`'s own bar, whichever comes first; `0` when an obstacle
 * covers `from` itself.
 */
function roomLeftOf(index: RowIndex, from: number, limit: number, self: UnlabelledBar): number {
  // The bars and labels that start before `from`: one of them covers it when
  // the greatest of their ends reaches it, and otherwise that end is where the
  // room begins.
  const barEnd = greatestBarEnd(index, countUpTo(index.starts, from, true), self);
  const labelCount = countUpTo(index.labelStarts, from, true);
  const labelEnd = index.labelEnds[labelCount - 1] ?? Number.NEGATIVE_INFINITY;
  if (barEnd >= from || labelEnd >= from) {
    return 0;
  }

  return Math.max(from - Math.max(limit, barEnd, labelEnd), 0);
}

/** Records a label placed from `start` to `end` on the row, as an obstacle to later labels. */
function recordLabel(index: RowIndex, start: number, end: number): void {
  const extent = paddedExtent(start, end);
  const at = countUpTo(index.labelStarts, extent.start, false);
  index.labelStarts.splice(at, 0, extent.start);
  index.labelEnds.splice(at, 0, extent.end);
}

/** One side of a bar a label could occupy, and how much room it has there. */
interface LabelSlot {
  readonly placement: BarLabelPlacement;
  /** The label's anchor point: where it starts, or ends when end-anchored. */
  readonly x: number;
  readonly anchor: 'start' | 'end';
  /** The free width at that anchor, in user units. */
  readonly room: number;
}

/**
 * The shortened forms of a label that fit `room`, best first: the name cut to
 * an ellipsis with the duration suffix kept, then the name alone (whole where
 * it fits, cut where it must be). `undefined` when neither keeps at least
 * {@link MIN_BAR_LABEL_GRAPHEMES} of the name.
 */
function shortenBarLabel(
  name: string,
  suffix: string,
  room: number,
  measure: TextMeasure,
): { readonly text: string; readonly width: number } | undefined {
  const options = { minGraphemes: MIN_BAR_LABEL_GRAPHEMES };

  const beside = fitTextToWidth(name, room - measure(suffix), measure, options);
  if (beside !== undefined) {
    // Estimated for the text as drawn rather than summed from its parts, so a
    // measure that is not additive across the join cannot carry the label past
    // its room.
    const text = `${beside.text}${suffix}`;
    const width = measure(text);
    if (width <= room) {
      return { text, width };
    }
  }

  const alone = fitTextToWidth(name, room, measure, options);

  return alone === undefined ? undefined : { text: alone.text, width: alone.width };
}

/** A label of `text`, `width` user units wide, drawn in `slot`. */
function labelInSlot(slot: LabelSlot, text: string, width: number): BarLabelGeometry {
  return {
    text,
    x: slot.x,
    anchor: slot.anchor,
    placement: slot.placement,
    start: slot.anchor === 'start' ? slot.x : slot.x - width,
    width,
  };
}

/**
 * Places one bar's label on its row (see "Bar labels" above), or returns
 * `undefined` when no recognisable form of it fits.
 *
 * The label is captured text, so every Unicode direction control in it is
 * drawn as its visible escape (`formatUntrustedText`) rather than obeyed. The
 * whole label is revealed here, before it is measured, so the width decided is
 * the width drawn. A shortened label is revealed by `fitTextToWidth` itself,
 * which is handed the RAW name on purpose: it reveals grapheme by grapheme and
 * keeps each escape whole, where a name revealed beforehand could be cut in
 * the middle of one.
 *
 * @param bar The bar to label.
 * @param row The bar's row: every bar on it and every label already placed.
 * @param frame The canvas width and the label measure.
 */
function placeBarLabel(
  bar: UnlabelledBar,
  row: RowIndex,
  frame: CanvasFrame,
): BarLabelGeometry | undefined {
  const { measureText } = frame;
  const name = collapseWhitespace(bar.row.name);
  const suffix = `${BAR_LABEL_SEPARATOR}${formatDuration(bar.row.durationMs)}`;
  const whole = `${formatUntrustedText(name)}${suffix}`;
  const wholeWidth = measureText(whole);

  const plotEnd = frame.width - CANVAS_RIGHT_GUTTER;
  const afterX = bar.end + BAR_LABEL_GAP;
  const beforeX = bar.x - BAR_LABEL_GAP;
  const insideX = bar.x + BAR_LABEL_INSET;
  const insideEnd = bar.end - BAR_LABEL_INSET;

  // In the order a whole label is tried in, which is also the tie-break order
  // for a shortened one.
  const slots: readonly LabelSlot[] = [
    {
      placement: 'after',
      x: afterX,
      anchor: 'start',
      room: roomRightOf(row, afterX, plotEnd, bar),
    },
    {
      placement: 'before',
      x: beforeX,
      anchor: 'end',
      room: roomLeftOf(row, beforeX, LANE_LABEL_WIDTH, bar),
    },
    {
      placement: 'inside',
      x: insideX,
      anchor: 'start',
      room: insideEnd > insideX ? roomRightOf(row, insideX, insideEnd, bar) : 0,
    },
  ];

  const fitting = slots.find((slot) => wholeWidth <= slot.room);
  if (fitting !== undefined) {
    return labelInSlot(fitting, whole, wholeWidth);
  }

  let widest: LabelSlot | undefined;
  for (const slot of slots) {
    if (slot.room > 0 && (widest === undefined || slot.room > widest.room)) {
      widest = slot;
    }
  }
  if (widest === undefined) {
    return undefined;
  }

  const shortened = shortenBarLabel(name, suffix, widest.room, measureText);

  return shortened === undefined ? undefined : labelInSlot(widest, shortened.text, shortened.width);
}

/**
 * Labels every bar, in order, each against the bars of its row and the labels
 * placed on that row before it.
 */
function labelBars(bars: readonly UnlabelledBar[], frame: CanvasFrame): BarGeometry[] {
  const barsByRow = new Map<string, UnlabelledBar[]>();
  for (const bar of bars) {
    appendToRow(barsByRow, rowKeyOfBar(bar), bar);
  }
  const rows = new Map<string, RowIndex>();
  for (const [key, rowBars] of barsByRow) {
    rows.set(key, indexRow(rowBars));
  }

  return bars.map((bar) => {
    const row = rows.get(rowKeyOfBar(bar));
    // Every bar was indexed into its row above; the guard satisfies the map type.
    const label = row === undefined ? undefined : placeBarLabel(bar, row, frame);
    if (row !== undefined && label !== undefined) {
      recordLabel(row, label.start, label.start + label.width);
    }

    return { ...bar, label };
  });
}

/*
 * Packing a depth
 *
 * A lane's depths are ranked (`rankLaneDepths`), so a deeper span always sits
 * below a shallower one, and each depth is then packed into sub-rows, so spans
 * of one depth that overlap once drawn are stacked rather than painted over
 * one another. Overlap is the ordinary case, not the exception: parallel
 * requests under one interaction overlap by construction, one commit renders
 * many components within a few milliseconds, and a run of short operations
 * each widened to the minimum visible width can overlap once drawn even where
 * their measured windows do not.
 *
 * The packing is greedy interval partitioning over the DRAWN extent — the
 * placement after the scale's minimum-width clamp, because that is what
 * paints. Taken by left edge, then model order, each span goes into the first
 * sub-row whose last span ends at or before its left edge (within
 * `TOUCH_TOLERANCE`, so spans that only touch share a sub-row), and a span
 * that fits in none opens the next. Taking spans by left edge makes that
 * choice optimal: a depth takes exactly as many sub-rows as the most spans
 * stacked over any one point, so a depth whose spans never overlap keeps the
 * single row it always had. It is the flame chart's packing of an icicle depth.
 *
 * A depth that would need more than `MAX_SUB_ROWS_PER_DEPTH` sub-rows is packed
 * by priority instead: the longest spans first — a pinned span, the panel's
 * selection, before all of them (see `buildGeometry`) — each into the first of
 * the capped sub-rows where it overlaps nothing. Whatever fits nowhere is
 * gathered, overlapping and touching runs merged, into "+N" marks on one extra
 * row beneath the depth. The longest operations are the ones a reading of
 * where the time went needs as bars; each mark states, in place, how many spans
 * it holds and that the table below lists every one of them.
 *
 * Sub-rows are numbered depth-major across the lane — every sub-row of one
 * depth, and its overflow row, above every sub-row of the next — so nesting
 * still reads downward and a connector still runs down from a parent to its
 * child. The result is a pure function of the placements: identical on every
 * render and in every environment.
 */

/** One row's drawn extent, before it is given a sub-row of its lane. */
interface PlacedSpan {
  /** The row it draws. */
  readonly row: TimelineBar;
  /** Its position in the model's rows: the tie-break of every packing order. */
  readonly order: number;
  /** Its drawn extent: the scale's placement, after the minimum-width clamp. */
  readonly placement: SpanGeometry;
}

/** One depth of one lane, packed. */
interface DepthPacking {
  /** The sub-rows, top to bottom — at most `MAX_SUB_ROWS_PER_DEPTH` — each left to right. */
  readonly subRows: readonly (readonly PlacedSpan[])[];
  /** The spans no sub-row could hold, left to right; empty when the depth fits. */
  readonly overflow: readonly PlacedSpan[];
}

/** Whether a run ending at `end` reaches past `start` by more than a touch. */
function runsPast(end: number, start: number): boolean {
  return end - start > TOUCH_TOLERANCE;
}

/** Orders spans by drawn left edge, then by model order. */
function byLeftEdge(left: PlacedSpan, right: PlacedSpan): number {
  return left.placement.x - right.placement.x || left.order - right.order;
}

/**
 * A duration as a packing priority and a mark's time bound: the measured
 * milliseconds, and `0` for a value that is not a finite, positive measurement.
 * Geometry only — what a reader is told about such a value is the formatter's.
 */
function drawnDurationMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Left-edge first-fit packing (see "Packing a depth" above) into at most `cap`
 * sub-rows.
 *
 * @param spans One depth's spans, in any order.
 * @param cap The most sub-rows the depth may take.
 * @returns The sub-rows, or `undefined` once the depth needs more than `cap`.
 */
function packByLeftEdge(spans: readonly PlacedSpan[], cap: number): PlacedSpan[][] | undefined {
  const subRows: PlacedSpan[][] = [];
  const ends: number[] = [];

  for (const span of [...spans].sort(byLeftEdge)) {
    const target = ends.findIndex((end) => !runsPast(end, span.placement.x));
    const subRow = target < 0 ? undefined : subRows[target];
    if (subRow !== undefined) {
      subRow.push(span);
      ends[target] = Math.max(ends[target] ?? span.placement.end, span.placement.end);
      continue;
    }
    if (subRows.length >= cap) {
      return undefined;
    }
    subRows.push([span]);
    ends.push(span.placement.end);
  }

  return subRows;
}

/**
 * One capped sub-row while it is filled by priority: its spans and their drawn
 * extents, ordered by left edge. The extents never overlap beyond a touch, so
 * ordered by start they are ordered by end too, and whether a new span fits is
 * one binary search against its two neighbours rather than a scan of the row.
 */
interface PrioritySubRow {
  readonly starts: number[];
  readonly ends: number[];
  readonly spans: PlacedSpan[];
}

/**
 * Where `placement` would go in `subRow`'s left-edge order, or `undefined` when
 * it overlaps a span already there by more than a touch.
 */
function insertionPoint(subRow: PrioritySubRow, placement: SpanGeometry): number | undefined {
  const at = countUpTo(subRow.starts, placement.x, false);
  const endBefore = subRow.ends[at - 1];
  if (endBefore !== undefined && runsPast(endBefore, placement.x)) {
    return undefined;
  }
  const startAfter = subRow.starts[at];
  if (startAfter !== undefined && runsPast(placement.end, startAfter)) {
    return undefined;
  }

  return at;
}

/**
 * Priority packing (see "Packing a depth" above) into exactly `cap` sub-rows:
 * the pinned span first, then the longest spans, each into the first sub-row
 * where it overlaps nothing; what fits nowhere overflows.
 *
 * @param spans One depth's spans, in any order.
 * @param cap How many sub-rows the depth may take.
 * @param pinnedEventId A span placed before every other, when it is among them.
 */
function packByPriority(
  spans: readonly PlacedSpan[],
  cap: number,
  pinnedEventId: string | undefined,
): DepthPacking {
  const ordered = [...spans].sort((left, right) => {
    const leftPinned = left.row.eventId === pinnedEventId;
    if (leftPinned !== (right.row.eventId === pinnedEventId)) {
      return leftPinned ? -1 : 1;
    }

    return (
      drawnDurationMs(right.row.durationMs) - drawnDurationMs(left.row.durationMs) ||
      left.order - right.order
    );
  });
  const subRows: PrioritySubRow[] = Array.from({ length: cap }, () => ({
    starts: [],
    ends: [],
    spans: [],
  }));
  const overflow: PlacedSpan[] = [];

  for (const span of ordered) {
    let placed = false;
    for (const subRow of subRows) {
      const at = insertionPoint(subRow, span.placement);
      if (at === undefined) {
        continue;
      }
      subRow.starts.splice(at, 0, span.placement.x);
      subRow.ends.splice(at, 0, span.placement.end);
      subRow.spans.splice(at, 0, span);
      placed = true;
      break;
    }
    if (!placed) {
      overflow.push(span);
    }
  }

  // A sub-row is used only once every sub-row above it refused a span, so the
  // used ones are a prefix and dropping the empty tail keeps their order.
  return {
    subRows: subRows.filter((subRow) => subRow.spans.length > 0).map((subRow) => subRow.spans),
    overflow: overflow.sort(byLeftEdge),
  };
}

/**
 * Packs one depth of one lane (see "Packing a depth" above).
 *
 * @param spans The depth's spans.
 * @param pinnedEventId A span to keep drawn as a bar should the depth overflow.
 */
function packDepth(spans: readonly PlacedSpan[], pinnedEventId: string | undefined): DepthPacking {
  const subRows = packByLeftEdge(spans, MAX_SUB_ROWS_PER_DEPTH);

  return subRows === undefined
    ? packByPriority(spans, MAX_SUB_ROWS_PER_DEPTH, pinnedEventId)
    : { subRows, overflow: [] };
}

/** A run of gathered spans before its row is placed vertically. */
interface OverflowRun {
  readonly id: string;
  readonly x: number;
  readonly end: number;
  readonly count: number;
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Merges a depth's overflowing spans, ordered by left edge, into runs: a span
 * that overlaps or touches the run before it joins that run, and any other
 * starts the next one.
 */
function gatherOverflow(spans: readonly PlacedSpan[]): OverflowRun[] {
  const runs: OverflowRun[] = [];
  let open: OverflowRun | undefined;

  for (const span of spans) {
    const { x, end } = span.placement;
    const { startTime } = span.row;
    // A span with no usable start widens no time bound; its mark still counts it.
    const timed = Number.isFinite(startTime);
    const spanStart = timed ? startTime : Number.POSITIVE_INFINITY;
    const spanEnd = timed
      ? startTime + drawnDurationMs(span.row.durationMs)
      : Number.NEGATIVE_INFINITY;

    if (open !== undefined && !runsPast(x, open.end)) {
      open = {
        ...open,
        end: Math.max(open.end, end),
        count: open.count + 1,
        startTime: Math.min(open.startTime, spanStart),
        endTime: Math.max(open.endTime, spanEnd),
      };
      continue;
    }

    if (open !== undefined) {
      runs.push(open);
    }
    open = { id: span.row.eventId, x, end, count: 1, startTime: spanStart, endTime: spanEnd };
  }
  if (open !== undefined) {
    runs.push(open);
  }

  return runs;
}

/**
 * Places the count label of every "+N" mark on one overflow row, left to
 * right: inside the mark where it fits there, otherwise after it, otherwise
 * before it, each kept `BAR_LABEL_GAP` clear of the neighbouring marks and
 * labels, the lane-label column and the canvas's trailing gutter — and nowhere,
 * where none of the three holds it. The mark's own title carries the count in
 * every case.
 *
 * @param runs The row's runs, left to right.
 * @param frame The canvas width and the label measure.
 * @returns One label, or `undefined`, per run.
 */
function labelOverflowRow(
  runs: readonly OverflowRun[],
  frame: CanvasFrame,
): (OverflowLabelGeometry | undefined)[] {
  const plotEnd = frame.width - CANVAS_RIGHT_GUTTER;
  let floor = LANE_LABEL_WIDTH;

  return runs.map((run, index) => {
    const text = `+${formatCount(run.count)}`;
    const textWidth = frame.measureText(text);
    const next = runs[index + 1];
    const afterX = run.end + BAR_LABEL_GAP;
    const afterLimit = next === undefined ? plotEnd : next.x - BAR_LABEL_GAP;
    const beforeX = run.x - BAR_LABEL_GAP;

    let label: OverflowLabelGeometry | undefined;
    let occupiedEnd = run.end;
    if (run.end - run.x - BAR_LABEL_INSET * 2 >= textWidth) {
      label = { text, x: run.x + BAR_LABEL_INSET, anchor: 'start' };
    } else if (afterLimit - afterX >= textWidth) {
      label = { text, x: afterX, anchor: 'start' };
      occupiedEnd = afterX + textWidth;
    } else if (beforeX - textWidth >= floor) {
      label = { text, x: beforeX, anchor: 'end' };
    }
    floor = occupiedEnd + BAR_LABEL_GAP;

    return label;
  });
}

/**
 * Turns the model into the canvas it is drawn on, reading no layout and
 * mutating nothing.
 *
 * @param model The drawn window's rows.
 * @param frame The canvas width and the label measure.
 * @param pinnedEventId A row to keep drawn as a bar even where its depth
 *   overflows — the panel's selection, passed only when the unpinned layout
 *   gathered it into a "+N" mark (see `TimelineView`), so a selection made
 *   elsewhere is still marked on the canvas and a layout never moves under a
 *   bar the reader just clicked.
 */
function buildGeometry(
  model: TimelineModel,
  frame: CanvasFrame,
  pinnedEventId?: string,
): TimelineGeometry {
  const { width } = frame;
  const scale = createTimeScale(
    [model.startTime, model.endTime],
    [LANE_LABEL_WIDTH, width - CANVAS_RIGHT_GUTTER],
  );

  // Depth is what places a row inside its lane, and a lane's depths are sparse:
  // a tier holds the spans of one process, nested under spans drawn in other
  // lanes, so a database lane can hold an orphan re-attached at depth 1 and a
  // query nested at depth 5. Each lane's depths are ranked (`rankLaneDepths`):
  // a deeper span still sits below a shallower one, and no row is reserved for
  // a depth nothing in the lane occupies — so a lane that begins six levels
  // down starts at its own first row, and a gap in its depths opens no empty
  // band. Each ranked depth is then packed into the sub-rows its overlapping
  // spans need (see "Packing a depth" above).
  const laneDepths: number[][] = model.tiers.map(() => []);
  for (const row of model.rows) {
    laneDepths[row.laneIndex]?.push(usableDepth(row.depth));
  }
  const laneRanks = laneDepths.map((depths) => rankLaneDepths(depths));

  // Every bar's drawn extent, placed once: the packing reads it, and so does
  // the bar itself. The extent is the scale's, after its minimum-width clamp,
  // because that is what paints.
  const placed: PlacedSpan[] = model.rows.map((row, order) => ({
    row,
    order,
    placement: placeSpanDuration(row.startTime, row.durationMs, scale),
  }));

  // The spans of each lane, grouped by ranked depth, shallowest first. Every
  // depth was ranked above, so each group is non-empty.
  const spansByLaneDepth: PlacedSpan[][][] = laneRanks.map((rank) =>
    Array.from({ length: rank.rowCount }, (): PlacedSpan[] => []),
  );
  for (const span of placed) {
    const depthRank = laneRanks[span.row.laneIndex]?.rowOf.get(usableDepth(span.row.depth)) ?? 0;
    spansByLaneDepth[span.row.laneIndex]?.[depthRank]?.push(span);
  }

  // Each row's lane row — depth-major across its lane — or `undefined` for a
  // row gathered into a "+N" mark; and each overflow row's gathered runs.
  const laneRowOf: (number | undefined)[] = placed.map(() => undefined);
  const overflowRows: {
    readonly laneIndex: number;
    readonly laneRow: number;
    readonly runs: readonly OverflowRun[];
  }[] = [];
  const gatheredEventIds = new Set<string>();
  const laneRowCounts = spansByLaneDepth.map((depths, laneIndex) => {
    let nextRow = 0;
    for (const spans of depths) {
      const packing = packDepth(spans, pinnedEventId);
      for (const [subRow, members] of packing.subRows.entries()) {
        for (const member of members) {
          laneRowOf[member.order] = nextRow + subRow;
        }
      }
      nextRow += packing.subRows.length;
      if (packing.overflow.length > 0) {
        for (const span of packing.overflow) {
          gatheredEventIds.add(span.row.eventId);
        }
        overflowRows.push({ laneIndex, laneRow: nextRow, runs: gatherOverflow(packing.overflow) });
        nextRow += 1;
      }
    }

    return nextRow;
  });

  const laneStack = layoutLaneStack(laneRowCounts);

  const lanes: LaneGeometry[] = model.tiers.map((tier, index) => {
    const box = laneStack.lanes[index];

    return {
      tier,
      label: formatTierLabel(tier),
      accent: tierColorVar(tier),
      y: AXIS_BAND_HEIGHT + (box?.y ?? 0),
      height: box?.height ?? 0,
      rowCount: box?.rowCount ?? 0,
    };
  });

  // Where a bar or a mark on row `laneRow` of lane `laneIndex` sits: inset in
  // its row, never shorter than the floor.
  const rowBox = (laneIndex: number, laneRow: number): { y: number; height: number } => {
    const depthRow = layoutDepth(laneRow);

    return {
      y: (lanes[laneIndex]?.y ?? AXIS_BAND_HEIGHT) + depthRow.y + BAR_INSET,
      height: clamp(depthRow.height - BAR_INSET * 2, MIN_BAR_HEIGHT, depthRow.height),
    };
  };

  const unlabelled: UnlabelledBar[] = [];
  for (const { row, order, placement } of placed) {
    const laneRow = laneRowOf[order];
    if (laneRow === undefined) {
      // Gathered into a "+N" mark: counted there, and a row of the table.
      continue;
    }
    const { y, height } = rowBox(row.laneIndex, laneRow);

    unlabelled.push({
      row,
      laneRow,
      x: placement.x,
      width: placement.width,
      end: placement.end,
      y,
      height,
      centerY: y + height / 2,
      color: kindColorVar(row.kind),
      minWidthApplied: placement.minWidthApplied,
    });
  }

  const overflow: OverflowGeometry[] = [];
  for (const { laneIndex, laneRow, runs } of overflowRows) {
    const { y, height } = rowBox(laneIndex, laneRow);
    const labels = labelOverflowRow(runs, frame);
    for (const [index, run] of runs.entries()) {
      overflow.push({
        id: run.id,
        x: run.x,
        width: run.end - run.x,
        y,
        height,
        centerY: y + height / 2,
        count: run.count,
        startTime: run.startTime,
        endTime: run.endTime,
        label: labels[index],
      });
    }
  }

  // Every bar is placed before any is labelled, because a label must keep clear
  // of the bars that come after it on its row as well as those before it.
  const bars = labelBars(unlabelled, frame);

  // A connector joins the row its parent resolved to in the WHOLE walk: the
  // first row carrying that span — a span id inside its own trace, the key
  // `traceSpanKey` builds — so a colliding span id in another trace on the
  // same page never receives a connector. On a flat page the walk's order is
  // the parent-first order, in which the first record carrying a span is the
  // one that claimed it and had that span's children expanded beneath it. So
  // every connector joins the record its child is drawn under, a capture
  // holding two records of one span cannot make a connector ambiguous, and a
  // parent outside the drawn window is never stood in for by a later record of
  // the same span that happens to be drawn.
  const barsByWalkIndex = new Map<number, BarGeometry>();
  for (const bar of bars) {
    barsByWalkIndex.set(bar.row.walkIndex, bar);
  }

  const edges: EdgeGeometry[] = [];
  for (const bar of bars) {
    const { parentWalkIndex, parentDrawn, walkIndex } = bar.row;
    const parent =
      parentWalkIndex === undefined || !parentDrawn || parentWalkIndex === walkIndex
        ? undefined
        : barsByWalkIndex.get(parentWalkIndex);
    if (parent === undefined) {
      // The parent has no bar — not on a loaded page, outside the drawn
      // window, gathered into a "+N" mark, or the row itself. The row is still
      // drawn; only the connector is absent, because a line to nowhere, or to
      // another row, would assert a relationship the reader cannot check. The
      // row's description says where a parent outside the window is (see
      // `lineageNoteFor`), and its table row lists it under the same parent.
      continue;
    }

    // Down from the parent's leading edge, then across to the child's: the
    // vertical run stays under the parent, so a reader follows nesting by
    // eye. Hairline-aligned, because these are one-unit strokes.
    edges.push({
      id: bar.row.eventId,
      path: `M ${String(alignHairline(parent.x))} ${String(alignHairline(parent.centerY))} V ${String(
        alignHairline(bar.centerY),
      )} H ${String(alignHairline(bar.x))}`,
      ambiguous: bar.row.lineageAmbiguous,
      inferred: bar.row.lineage !== undefined && !bar.row.lineageAmbiguous,
      orphaned: bar.row.orphaned,
    });
  }

  const ticks = generateAxisTicks(scale, { origin: model.startTime }).ticks;
  const height = Math.max(
    AXIS_BAND_HEIGHT + laneStack.height + CANVAS_BOTTOM_PADDING,
    AXIS_BAND_HEIGHT + DEFAULT_ROW_HEIGHT + CANVAS_BOTTOM_PADDING,
  );

  return { scale, lanes, bars, overflow, gatheredEventIds, edges, ticks, width, height };
}

/*
 * ---------------------------------------------------------------------------
 * Counted words
 *
 * Every count this view prints agrees its noun — and the pronoun and verb of
 * the same sentence — with the number beside it through the package's one rule
 * in `../utils/format`, which decides from the count as `formatCount` prints
 * it. Never an inline plural: that is how a summary pill ends up reading
 * "1 spans" and a canvas description "1 tier lanes".
 * ---------------------------------------------------------------------------
 */

/** "1 span" / "4 spans". */
const SPAN_NOUN: CountedNoun = countedNoun('span');

/** The summary pill's lane count: "1 tier" / "3 tiers". */
const TIER_NOUN: CountedNoun = countedNoun('tier');

/** The canvas description's lane count: "1 tier lane" / "3 tier lanes". */
const TIER_LANE_NOUN: CountedNoun = countedNoun('tier lane');

/** The drawn spans a window statement refers back to: "before it" / "before them". */
const DRAWN_PRONOUN: CountedNoun = countedNoun('it', 'them');

/** The listed spans' possessive: "with its kind" / "with their kind". */
const SPAN_POSSESSIVE: CountedNoun = countedNoun('its', 'their');

/** The verb that agrees with how many spans a window leaves undrawn. */
const IS_VERB: CountedNoun = countedNoun('is', 'are');

/**
 * The other candidates of an ambiguous attribution, with their verb: one is
 * "the other was …", several are "the others were …".
 */
const OTHER_CANDIDATES: CountedNoun = countedNoun('the other was', 'the others were');

/*
 * ---------------------------------------------------------------------------
 * Describing a row
 *
 * Every vocabulary lookup below is a total `Record` with a fallback rather than
 * a `switch` closed by an exhaustiveness assertion, and that is deliberate: a
 * status, kind or tier this build does not know can legitimately arrive from a
 * newer producer or from the session store, and throwing on one would take down
 * a whole panel over a row it could still draw. The sibling modules in
 * `../utils/**` resolve the same problem the same way.
 * ---------------------------------------------------------------------------
 */

/**
 * The operation name of every span on screen, keyed by {@link traceSpanKey} —
 * a span id inside its own trace — so a candidate parent recorded as a bare
 * span id can be named in words.
 */
type SpanNames = ReadonlyMap<string, string>;

/** No names: the lookup of a view with no rows, shared so it never changes identity. */
const NO_SPAN_NAMES: SpanNames = new Map<string, string>();

/**
 * The span-name lookup for a model's rows.
 *
 * The first row carrying a span answers for it — the same first-claim rule the
 * connectors are resolved by (see `buildGeometry`) — so a capture holding two
 * records of one span names a candidate after the record its children are
 * drawn under.
 *
 * @param rows The rows on screen, in the model's order.
 * @returns The lookup; empty for no rows.
 */
function spanNamesOf(rows: readonly TimelineBar[]): SpanNames {
  if (rows.length === 0) {
    return NO_SPAN_NAMES;
  }

  const names = new Map<string, string>();
  for (const row of rows) {
    const key = traceSpanKey(row.traceId, row.spanId);
    if (!names.has(key)) {
      names.set(key, row.name);
    }
  }

  return names;
}

/**
 * One candidate parent, as the description states it: the operation that span
 * recorded, with its id kept beside it — `name (0000000000000a01)` — when a span
 * of the row's own trace with that id is on screen, and the bare id otherwise.
 * A candidate from another trace, or on a page not loaded, is stated exactly as
 * it was recorded rather than guessed at; the id is kept in both forms, so the
 * reader can always look the span up.
 *
 * @param row The row whose attribution was ambiguous.
 * @param candidateSpanId One of the candidate span ids it recorded.
 * @param spanNames The names of the spans on screen.
 */
function candidateText(row: TimelineBar, candidateSpanId: string, spanNames: SpanNames): string {
  const name = spanNames.get(traceSpanKey(row.traceId, candidateSpanId));

  return name === undefined ? candidateSpanId : `${name} (${candidateSpanId})`;
}

/**
 * Whether a row's parent is a span of this view that lies outside the rows
 * drawn now, so no connector reaches it — a state the lineage note states and
 * the detail strip's flag names. A type guard, so the note can name the parent
 * and its position without re-checking either.
 */
function parentOutsideWindow(row: TimelineBar): row is TimelineBar & {
  readonly parentSpanId: string;
  readonly parentWalkIndex: number;
} {
  return (
    row.parentSpanId !== undefined &&
    row.parentWalkIndex !== undefined &&
    row.parentWalkIndex !== row.walkIndex &&
    !row.parentDrawn
  );
}

/** The flag of a row the correlator re-attached to the trace root. */
const REATTACHED_FLAG = 'Re-attached';

/** The flag of a row whose parent was one of several candidates. */
const AMBIGUOUS_PARENT_FLAG = 'Ambiguous parent';

/** The flag of a row whose parent is not among the spans loaded. */
const PARENT_NOT_LOADED_FLAG = 'Parent not loaded';

/** The flag of a row whose parent lies outside the rows drawn now. */
const PARENT_NOT_DRAWN_FLAG = 'Parent not drawn';

/** The flag of a row attributed to its parent across an asynchronous boundary. */
const INFERRED_PARENT_FLAG = 'Inferred parent';

/** The one flag the detail strip's lead run shows for a row's lineage note. */
interface LineageFlag {
  readonly label: string;
  readonly tone: BadgeTone;
}

/**
 * The flag that names a row's lineage note in the detail strip's lead run, or
 * `undefined` exactly when {@link lineageNoteFor} has nothing to say.
 *
 * One flag for the whole note, named by its most consequential state: a guessed
 * parent first, then a re-attachment — both warnings, because the drawn
 * position is not a measured one — then the informational states. The table's
 * flag words are reused where the table has one, so a row reads the same in
 * both places. The flag is the note's pointer path: the note itself sits in the
 * strip's clipped trailing run, cut with an ellipsis on a narrow panel, and the
 * flag's tooltip carries the whole of it from the lead run, which clips
 * nothing.
 */
function lineageFlagFor(row: TimelineBar): LineageFlag | undefined {
  if (row.lineageAmbiguous) {
    return { label: AMBIGUOUS_PARENT_FLAG, tone: 'warning' };
  }
  if (row.orphaned) {
    return { label: REATTACHED_FLAG, tone: 'warning' };
  }
  if (row.parentNotLoaded && row.parentSpanId !== undefined) {
    return { label: PARENT_NOT_LOADED_FLAG, tone: 'info' };
  }
  if (parentOutsideWindow(row)) {
    return { label: PARENT_NOT_DRAWN_FLAG, tone: 'info' };
  }
  if (row.lineage !== undefined) {
    return { label: INFERRED_PARENT_FLAG, tone: 'info' };
  }
  return undefined;
}

/**
 * What the pipeline recorded about how this row joined its trace, and where
 * this view could not place it under its parent, as a sentence — or nothing,
 * when it joined the ordinary way and is drawn under its parent.
 *
 * The dashed edge, the orphan mark and the "Parent not loaded" flag are visual
 * signals, and a visual signal is never the only signal: everything they mean
 * is also stated here, in the row's description and its detail strip. So is
 * the absence of a connector to a parent that lies outside the drawn window:
 * the note names the parent's span id and its position in the whole walk, so
 * the reader can page to it. The other candidates of an ambiguous attribution
 * are named through `spanNames` (see {@link candidateText}).
 */
function lineageNoteFor(row: TimelineBar, spanNames: SpanNames): string | undefined {
  const notes: string[] = [];

  if (row.orphaned) {
    notes.push(
      row.orphanReason === undefined
        ? 'Re-attached to the root: this span names a parent that never arrived.'
        : `Re-attached to the root (${row.orphanReason}): the parent this span names never arrived.`,
    );
  }
  if (row.parentNotLoaded && row.parentSpanId !== undefined) {
    notes.push(
      `Its parent span ${row.parentSpanId} is not among the spans loaded here — it may be on a page not yet loaded or outside this query — so this span is drawn at the top level.`,
    );
  }
  if (parentOutsideWindow(row)) {
    notes.push(
      `Its parent span ${row.parentSpanId} is span ${formatCount(
        row.parentWalkIndex + 1,
      )} of this view, outside the spans drawn now, so no connector is drawn to it.`,
    );
  }
  if (row.lineage !== undefined) {
    notes.push(`Attributed across an asynchronous boundary (${row.lineage}).`);
  }
  if (row.lineageAmbiguous) {
    notes.push(
      row.lineageCandidates.length === 0
        ? 'More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty.'
        : `More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty; ${pluralize(
            row.lineageCandidates.length,
            OTHER_CANDIDATES,
          )} ${row.lineageCandidates
            .map((candidate) => candidateText(row, candidate, spanNames))
            .join(', ')}.`,
    );
  }

  return notes.length === 0 ? undefined : notes.join(' ');
}

/**
 * One row as a sentence: what it is, which tier it ran on, how long it took,
 * when it started relative to the window, how it reported and what the
 * pipeline had to infer about its position.
 *
 * Used for the bar's own description, for the detail strip and for the tooltip
 * on the row's name, so the three cannot drift apart. Values arrive redacted
 * and truncated and are rendered exactly as given, except that every Unicode
 * direction control in them — in the name, the orphan reason, the lineage or a
 * candidate's name or id — is returned as its visible escape
 * (`formatUntrustedText`). The sentence exists only to be displayed: the bar
 * writes it into its `aria-label` and SVG `<title>`, which no primitive
 * reveals for it, so it is revealed here once for every carrier. The row it
 * describes, and every key and callback derived from that row, stay raw.
 *
 * @param row The row to describe.
 * @param origin The window start its offset is measured from.
 * @param spanNames The names of the spans on screen, for naming candidates.
 */
function describeBar(row: TimelineBar, origin: number, spanNames: SpanNames): string {
  const sentence = `${row.name} — ${formatKindLabel(row.kind)}, ${formatTierLabel(
    row.tier,
  )} tier, ${formatDuration(row.durationMs)} at ${formatOffset(
    row.startTime,
    origin,
  )}. Reported: ${formatStatusLabel(row.status)}.`;
  const note = lineageNoteFor(row, spanNames);

  return formatUntrustedText(note === undefined ? sentence : `${sentence} ${note}`);
}

/** The verb that agrees with a count of spans: "is" or "are". */
const IS_NOUN = countedNoun('is', 'are');

/** What a gathered span is not drawn as, agreeing with its count. */
const BAR_NOUN = countedNoun('a bar', 'bars');

/** The noun "+N" marks are counted by. */
const OVERFLOW_MARK_NOUN = countedNoun('“+N” mark');

/**
 * A "+N" mark as a sentence — its SVG title: how many spans it gathers, over
 * which part of the window, why they are not bars, and where every one of them
 * is instead.
 *
 * @param mark The mark.
 * @param origin The window start its offsets are measured from.
 */
function describeOverflow(mark: OverflowGeometry, origin: number): string {
  const during =
    Number.isFinite(mark.startTime) && Number.isFinite(mark.endTime)
      ? ` from ${formatOffset(mark.startTime, origin)} to ${formatOffset(mark.endTime, origin)}`
      : '';

  return `+${formatCount(mark.count)}: ${formatCountOf(
    mark.count,
    'overlapping span',
  )}${during} ${pluralize(mark.count, IS_NOUN)} not drawn as ${pluralize(
    mark.count,
    BAR_NOUN,
  )}. A lane draws at most ${formatCount(
    MAX_SUB_ROWS_PER_DEPTH,
  )} rows of bars for one depth and keeps the longest spans as bars. Every span is listed in the table below.`;
}

/**
 * The statement the canvas's text alternative and the footer make when the
 * lanes gathered spans into "+N" marks, or `undefined` when every row is a bar.
 *
 * @param geometry The drawn canvas.
 */
function overflowStatement(geometry: TimelineGeometry): string | undefined {
  const gathered = geometry.gatheredEventIds.size;
  if (gathered === 0) {
    return undefined;
  }

  return `${formatCountOf(gathered, 'span')} ${pluralize(
    gathered,
    IS_NOUN,
  )} gathered into ${formatCountOf(
    geometry.overflow.length,
    OVERFLOW_MARK_NOUN,
  )} where more spans overlap than a lane draws rows for; the table below lists each of them.`;
}

/** Where an axis label sits relative to its tick, so no label leaves the canvas. */
function axisLabelAnchor(index: number, count: number): 'start' | 'middle' | 'end' {
  if (index === 0) {
    return 'start';
  }

  return index === count - 1 ? 'end' : 'middle';
}

/*
 * ---------------------------------------------------------------------------
 * The canvas
 * ---------------------------------------------------------------------------
 */

/**
 * The canvas width to lay out at, given one reading of the canvas's rendered
 * width.
 *
 * - A reading that is not a finite width of at least one pixel comes from an
 *   element that is not laid out — detached, inside a hidden panel, or in a
 *   DOM with no layout — and changes nothing: the width already accepted
 *   stands, or the fallback frame while there is none, so a panel hidden and
 *   shown again is not laid out twice on the way.
 * - An accepted reading is floored to a whole pixel, and a reading inside the
 *   pixel already accepted keeps that width, so sub-pixel jitter — a
 *   fractional panel width, a zoomed window — never lays the drawing out again.
 *
 * Flooring rather than rounding keeps the `viewBox` never wider than the
 * element, so `meet` never draws a label below its token size and the
 * drawing's rendered height never falls below its logical height. A vertical
 * scrollbar the drawing's own height brings into the scroll viewport narrows
 * the element by whole pixels, which leaves the floored-away fraction as it
 * was and the drawing at least as tall, so the scrollbar is never withdrawn by
 * the width it caused and the two widths cannot alternate.
 *
 * @param current The width accepted so far, or `undefined` before the first.
 * @param reading The rendered width just read, in CSS pixels.
 * @returns The width to lay out at — `current` itself when nothing changed, so
 *   setting it is a no-op that renders nothing.
 */
function acceptCanvasWidth(current: number | undefined, reading: number): number | undefined {
  if (!Number.isFinite(reading) || reading < 1) {
    return current;
  }

  const width = Math.floor(reading);

  return width === current ? current : width;
}

/**
 * Observes the rendered width of the canvas its ref is attached to, so the
 * drawing is laid out one user unit to a CSS pixel (see this module's header).
 *
 * The ref is a state setter: attaching a canvas — the view mounts one only
 * once it has rows to draw, and a fresh one after a state change — re-runs the
 * layout effect for exactly that element, and detaching it, or unmounting the
 * view, disconnects the observer. The width is read in two ways:
 *
 * - once synchronously, off the element's box, inside the layout effect: an
 *   update raised there is committed before the browser paints, so a freshly
 *   mounted canvas is never painted in the fallback frame and then laid out
 *   again, which would shift everything below it;
 * - then by a `ResizeObserver`, on every later change of the element's
 *   content-box width — the panel resized, a split pane dragged, a scrollbar
 *   appearing in the viewport.
 *
 * The element's width is its container's, set by the stylesheet, and never its
 * `viewBox`'s, so laying the drawing out at the observed width cannot change
 * the observed width. Where `ResizeObserver` does not exist the synchronous
 * reading is the only one; where nothing is laid out (a layout-free DOM, whose
 * boxes all measure zero) no reading is accepted and the width stays
 * `undefined`, which the view draws in the fallback frame.
 *
 * @returns The accepted width in whole CSS pixels, `undefined` until one has
 *   been measured, and the ref callback to attach to the `<svg>`.
 */
function useCanvasWidth(): readonly [
  width: number | undefined,
  canvasRef: (canvas: SVGSVGElement | null) => void,
] {
  const [canvas, setCanvas] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (canvas === null) {
      return undefined;
    }

    const accept = (reading: number): void => {
      setWidth((current) => acceptCanvasWidth(current, reading));
    };

    accept(canvas.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === canvas) {
          accept(entry.contentRect.width);
        }
      }
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [canvas]);

  return [width, setCanvas];
}

/** A `style` object that may carry this package's component-scoped properties. */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/** What {@link TimelineCanvas} draws. */
interface TimelineCanvasProps {
  /**
   * The positioned lanes, bars, edges and ticks, in the canvas's user units:
   * one to a CSS pixel once the canvas is measured (see {@link useCanvasWidth}).
   */
  readonly geometry: TimelineGeometry;
  /** Attaches the `<svg>` to the view's width observer. */
  readonly canvasRef: (canvas: SVGSVGElement | null) => void;
  /** The window the offsets in the bars' descriptions are measured from. */
  readonly origin: number;
  /** The names of the spans on screen, so a description can name its candidates. */
  readonly spanNames: SpanNames;
  /** The row currently selected, so its bar carries the selected state. */
  readonly selectedEventId: string | undefined;
  /** Raised when a bar is activated with a pointer. */
  readonly onSelect: (row: TimelineBar) => void;
  /**
   * Raised with a bar's row when the pointer enters it. Leaving a bar raises
   * nothing: the preview it started stays while the pointer travels on to the
   * detail strip, and the parent ends it (see `TimelineView`).
   */
  readonly onHover: (eventId: string) => void;
  /**
   * The canvas's text alternative. Written into the `<svg>`'s own
   * `aria-label`, which no primitive reveals, so the canvas prints any
   * direction control in it as its visible escape itself.
   */
  readonly label: string;
}

/**
 * The SVG: lane bands, the axis over them, the connectors, the bars, then the
 * "+N" marks.
 *
 * Paint order is the component's responsibility — SVG paints in document order
 * and `z-index` does not apply — so the groups are written in the order they
 * must be painted: the bands behind everything, the gridlines over the bands,
 * the connectors under the bars they join, and the bars and their labels last,
 * with the marks of each depth's overflow row, which no bar shares.
 * A label beside its bar is laid on a backdrop in the lane's own surface
 * colour, the bar's height and the label's width plus its inset: a connector
 * or gridline running under the label stops at the backdrop's edges instead of
 * showing through the spaces between its words, which the label's halo cannot
 * cover — a halo outlines glyphs, and a space has none. Its inset is narrower
 * than the `BAR_LABEL_GAP` every label keeps from every bar, so it never
 * covers one.
 *
 * The canvas is a `role="figure"` named by its text alternative, and every bar
 * and "+N" mark inside it is a `role="img"` named by its full description — the
 * sentence its native tooltip shows — so the hover information is in the
 * accessibility tree for a screen reader browsing the picture, not only in the
 * tooltip and the detail strip. The lanes, the axis, the connectors and the
 * visible labels repeat what those names say and are hidden from assistive
 * technology. The bars are deliberately not focusable: two thousand tab stops
 * would bury the rest of the panel. The keyboard-reachable representation of
 * exactly these rows is the table the parent renders below it.
 */
function TimelineCanvas(props: TimelineCanvasProps): ReactElement {
  const { geometry, canvasRef, origin, spanNames, selectedEventId, onSelect, onHover, label } =
    props;
  const gridlineEnd = geometry.height - CANVAS_BOTTOM_PADDING;
  const tickCount = geometry.ticks.length;

  return (
    // CSS sizes the element to its container (`width="100%"`), and the
    // drawing is laid out at the width it measures there, so the `viewBox` is
    // exactly the element's width — one unit to a CSS pixel — and as tall as
    // the lanes. `height` is the drawing's logical height, the other half of
    // its aspect ratio, so the element is that tall too. Before a measurement
    // the `viewBox` is the fallback frame's fixed width, and `meet` scales the
    // drawing uniformly into the element from its top-left corner rather than
    // stretching it. See this module's header.
    <svg
      ref={canvasRef}
      className="dg-timeline__canvas"
      role="figure"
      aria-label={formatUntrustedText(label)}
      width="100%"
      height={geometry.height}
      viewBox={`0 0 ${String(geometry.width)} ${String(geometry.height)}`}
      preserveAspectRatio="xMinYMin meet"
    >
      {/* Decoration for the eye: the lane bands and their labels, the axis and
          the connectors are hidden from assistive technology, because every
          bar and mark below names its own tier, offset and relationships. */}
      <g className="dg-timeline__lanes" aria-hidden="true">
        {geometry.lanes.map((lane) => {
          const accentStyle: CssVariableStyle = { '--dgc-lane-color': lane.accent };

          return (
            <g key={lane.tier}>
              <rect
                className="dg-timeline__lane"
                x={0}
                y={lane.y}
                width={geometry.width}
                height={lane.height}
              />
              <rect
                className="dg-timeline__lane"
                style={accentStyle}
                x={0}
                y={lane.y}
                width={LANE_ACCENT_WIDTH}
                height={lane.height}
              />
              <text
                className="dg-timeline__lane-label"
                x={LANE_ACCENT_WIDTH + BAR_LABEL_GAP}
                y={lane.y + lane.height / 2}
              >
                {lane.label}
              </text>
            </g>
          );
        })}
      </g>

      <g className="dg-timeline__axis" aria-hidden="true">
        {geometry.ticks.map((tick, index) => {
          const x = alignHairline(tick.offset);

          return (
            <g key={`${String(tick.value)}:${String(index)}`}>
              <line
                className="dg-timeline__axis-tick"
                x1={x}
                y1={AXIS_BAND_HEIGHT - AXIS_TICK_LENGTH}
                x2={x}
                y2={AXIS_BAND_HEIGHT}
              />
              <line
                className="dg-timeline__gridline"
                x1={x}
                y1={AXIS_BAND_HEIGHT}
                x2={x}
                y2={gridlineEnd}
              />
              <text
                className="dg-timeline__axis-label"
                x={clamp(tick.offset, 0, geometry.width)}
                y={AXIS_LABEL_BASELINE}
                textAnchor={axisLabelAnchor(index, tickCount)}
              >
                {tick.label}
              </text>
            </g>
          );
        })}
      </g>

      <g aria-hidden="true">
        {geometry.edges.map((edge) => (
          <path
            key={edge.id}
            className={clsx(
              'dg-timeline__edge',
              edge.ambiguous && ['dg-timeline__edge--dashed', 'dg-is-ambiguous'],
              edge.inferred && 'dg-is-inferred',
              // `dg-is-orphan` is the painted state and `dg-is-orphaned` the
              // contract's name for it; both are written, so neither the
              // stylesheet nor a consumer has to guess which spelling won.
              edge.orphaned && ['dg-is-orphan', 'dg-is-orphaned'],
            )}
            d={edge.path}
          />
        ))}
      </g>

      {geometry.bars.map((bar) => {
        const barStyle: CssVariableStyle = { '--dgc-bar-color': bar.color };
        // One sentence, three carriers: the bar's accessible name, its native
        // tooltip and (through the same function) the detail strip and the
        // table row's description, so none of them can say something else.
        const description = describeBar(bar.row, origin, spanNames);

        return (
          <g className="dg-timeline__row" key={bar.row.eventId}>
            <rect
              className={clsx(
                'dg-timeline__bar',
                bar.row.lineageAmbiguous && 'dg-is-ambiguous',
                bar.row.orphaned && ['dg-is-orphan', 'dg-is-orphaned'],
                bar.row.eventId === selectedEventId && 'dg-is-selected',
              )}
              style={barStyle}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              role="img"
              aria-label={description}
              onClick={() => {
                onSelect(bar.row);
              }}
              onPointerEnter={() => {
                onHover(bar.row.eventId);
              }}
            >
              {/* The user agent's own tooltip, kept for the pointer. The same
                  sentence is the bar's accessible name above, and it is
                  author-rendered in the detail strip, which the pointer can
                  reach and Escape dismisses, and in the table row's
                  description, which keyboard focus opens. */}
              <title>{description}</title>
            </rect>
            {bar.label === undefined || bar.label.placement === 'inside' ? null : (
              <rect
                className="dg-timeline__bar-label-backdrop"
                aria-hidden="true"
                x={bar.label.start - BAR_LABEL_INSET}
                y={bar.y}
                width={bar.label.width + BAR_LABEL_INSET * 2}
                height={bar.height}
              />
            )}
            {bar.label === undefined ? null : (
              <text
                className={clsx(
                  'dg-timeline__bar-label',
                  bar.label.placement === 'inside' && 'dg-timeline__bar-label--inside',
                )}
                // The visible label repeats the start of the bar's name, so it
                // is hidden rather than read twice.
                aria-hidden="true"
                x={bar.label.x}
                y={bar.centerY}
                textAnchor={bar.label.anchor}
              >
                {bar.label.text}
              </text>
            )}
          </g>
        );
      })}

      {/* The "+N" marks, each on its depth's overflow row, which holds no bar,
          so neither a mark nor its count can cover one. Not a control: every
          span a mark gathers is a row of the table below, and the mark's title
          says so. */}
      {geometry.overflow.map((mark) => {
        const description = describeOverflow(mark, origin);

        return (
          <g key={mark.id}>
            <rect
              className="dg-timeline__overflow"
              x={mark.x}
              y={mark.y}
              width={mark.width}
              height={mark.height}
              role="img"
              aria-label={description}
            >
              <title>{description}</title>
            </rect>
            {mark.label === undefined ? null : (
              <text
                className="dg-timeline__overflow-label"
                aria-hidden="true"
                x={mark.label.x}
                y={mark.centerY}
                textAnchor={mark.label.anchor}
              >
                {mark.label.text}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The detail strip
 * ---------------------------------------------------------------------------
 */

/** What {@link TimelineDetail} shows. */
interface TimelineDetailProps {
  /**
   * The row to spell out: the row under the pointer; when the pointer is away,
   * the row in the table that holds keyboard focus; and otherwise the selected
   * one. `undefined` when there is none of the three, which draws the strip's
   * resting line instead — the strip itself never leaves the layout.
   */
  readonly row: TimelineBar | undefined;
  /**
   * Whether `row` is a preview — the hovered or focused row, shown in place of
   * the selection only while the pointer or focus rests on it — rather than
   * the selected row itself. Stated in words at the head of the strip, so the
   * reader can tell a passing preview from what they selected.
   */
  readonly previewing: boolean;
  /** The window start every offset is measured from. */
  readonly origin: number;
  /** The names of the spans on screen, so the lineage notes can name candidates. */
  readonly spanNames: SpanNames;
}

/** What {@link TimelineDetail} needs beyond the line it draws. */
interface TimelineDetailStripProps extends TimelineDetailProps {
  /**
   * Receives the strip's element, so the parent can tell a pointer resting on
   * the strip — which keeps a hover preview — from one that moved elsewhere.
   */
  readonly stripRef: RefObject<HTMLDivElement | null>;
  /**
   * Raised with the shown row's event id when focus arrives inside the strip,
   * so the row the reader is reading holds the strip for as long as focus stays
   * in it, whatever the pointer does meanwhile.
   */
  readonly onFocusWithin: (eventId: string) => void;
}

/** The strip's accessible name: what the region beside the canvas is for. */
const DETAIL_LABEL = 'Span detail';

/** The strip's resting line, while no span is hovered, focused or selected. */
const DETAIL_RESTING_TEXT = 'Select a span, or point at a bar, to see its detail here.';

/** The lead word of the strip while it shows the selected span. */
const DETAIL_SELECTED_LEAD = 'Selected';

/** The lead word of the strip while it previews a hovered or focused span. */
const DETAIL_PREVIEW_LEAD = 'Preview';

/**
 * The selected row, spelled out between the canvas and the table — or, while
 * the pointer or keyboard focus rests on another row, a preview of that row.
 *
 * **The strip is always in the layout.** It occupies one reserved line
 * (`dg-timeline__detail` in `../styles/components.css`) whether or not a row
 * is shown, and it never wraps: a strip that appeared on hover and grew with
 * its content would push the table down under the pointer that was reading it.
 * A line longer than the panel is wide scrolls inside the strip instead of
 * adding a second one, and every value in it is also in the row's own cells
 * below. While nothing is hovered, focused or selected it shows a resting line
 * that says how to fill it.
 *
 * **It follows the selection; a hover or a focus is a preview.** What it shows
 * by default is the selected span, and a row under the pointer or holding
 * keyboard focus replaces it only for as long as the pointer or focus stays —
 * the lead word says which of the two the reader is looking at.
 *
 * **A preview is hoverable and dismissible (WCAG 1.4.13).** A bar's preview
 * does not end when the pointer leaves the bar: it stays while the pointer
 * crosses the canvas and the gap below it and rests on this strip, so the
 * source chip in it can be reached and used, and it ends when the pointer
 * moves on to the table, the toolbar or out of the view. Escape dismisses a
 * preview without moving the pointer or focus — see `TimelineView` for the two
 * listeners. Focus inside the strip — on the source chip a pointer clicked —
 * holds the row it shows, so neither the pointer moving away nor a dismissal
 * can pull the focused chip out from under the reader.
 *
 * This is where a bar's description is readable: the `Tooltip` primitive wraps
 * an HTML element and cannot wrap an SVG shape, so the stylesheet gives this
 * view a slot for it (`dg-timeline__tooltip`) and the bar itself carries the
 * same sentence as its SVG title. Everything the tooltip contract asks for is
 * here — the name, the kind, the tier, the duration, the offset, the status and
 * the lineage notes — and the chip, where the row resolved to a location.
 *
 * The name is the tooltip's trigger for a POINTER, and it is deliberately not a
 * tab stop: the strip mirrors the table row that holds focus, and that row —
 * while it holds keyboard focus — reveals the same description in its own
 * Operation cell (see {@link TimelineOperationName} and this module's header).
 * A focusable copy here would be a stray stop outside the table's roving tab
 * order. The strip's source chip is out of the tab order too, so nothing in the
 * strip is a stop: focus reaches it only when a pointer clicks that chip. The
 * trigger still carries the description as `aria-describedby`, so the full
 * sentence stays attached to the name for assistive technology.
 */
function TimelineDetail(props: TimelineDetailStripProps): ReactElement {
  const { row, previewing, origin, spanNames, stripRef, onFocusWithin } = props;
  const shownEventId = row?.eventId;

  // React's `onFocus` bubbles, so focus landing on the source chip — the one
  // focusable part of the strip, reached by a pointer — reaches this handler.
  // The resting line holds nothing focusable, so there is no row to report
  // while it shows.
  const handleFocus = useCallback((): void => {
    if (shownEventId !== undefined) {
      onFocusWithin(shownEventId);
    }
  }, [onFocusWithin, shownEventId]);

  return (
    <div
      ref={stripRef}
      className="dg-timeline__detail"
      role="group"
      aria-label={DETAIL_LABEL}
      onFocus={handleFocus}
    >
      {row === undefined ? (
        <Text size="sm" tone="muted">
          {DETAIL_RESTING_TEXT}
        </Text>
      ) : (
        <TimelineDetailLine
          row={row}
          previewing={previewing}
          origin={origin}
          spanNames={spanNames}
        />
      )}
    </div>
  );
}

/**
 * The one line {@link TimelineDetail} draws for a row, in two runs.
 *
 * The **lead run** — the lead word, the kind and tier badges, the name with
 * its description, and the flag of a lineage note — is what identifies the
 * span, so it is laid out first and keeps its width; on a narrow panel only the
 * name gives way, truncating. The **trailing run** — the duration, the offset,
 * the status, the source chip and the lineage note — takes what width is left
 * and is clipped at the strip's inline end rather than wrapped
 * (`dg-timeline__detail-rest`). Within it the note alone gives way, ending in a
 * visible ellipsis (`dg-timeline__detail-note`), so the reader sees that the
 * sentence continues. The whole note stays reachable: the flag's bubble carries
 * it, the other candidate parents of an ambiguous attribution included, and so
 * does the name's description. Both bubbles open from the lead run, which clips
 * nothing, so neither is ever cut off by the strip however narrow the panel is.
 *
 * @param props The row, whether it is a preview, the window start, and the
 *   names of the spans on screen, which the lineage note and the description
 *   name an ambiguous attribution's other candidates by.
 * @returns The line, laid out without wrapping.
 */
function TimelineDetailLine(
  props: TimelineDetailProps & { readonly row: TimelineBar },
): ReactElement {
  const { row, previewing, origin, spanNames } = props;
  const note = lineageNoteFor(row, spanNames);
  const flag = note === undefined ? undefined : lineageFlagFor(row);

  return (
    <>
      <Stack direction="horizontal" gap={2} align="center">
        <Text size="xs" tone="muted">
          {previewing ? DETAIL_PREVIEW_LEAD : DETAIL_SELECTED_LEAD}
        </Text>
        <Badge variant="soft" color={kindColorVar(row.kind)}>
          {formatKindLabel(row.kind)}
        </Badge>
        <Badge variant="outline" color={tierColorVar(row.tier)}>
          {formatTierLabel(row.tier)}
        </Badge>
        <div className="dg-timeline__tooltip">
          {/* The pointer's trigger and no tab stop: the row holding keyboard
              focus reveals the same description in its own Operation cell. */}
          <Tooltip content={describeBar(row, origin, spanNames)}>
            <Text size="sm" truncate>
              {row.name}
            </Text>
          </Tooltip>
        </div>
        {flag === undefined || note === undefined ? null : (
          <div className="dg-timeline__tooltip">
            {/* The lineage note's pointer path, after the name so the name
                stays the strip's first described element. Here in the lead
                run, which clips nothing, the bubble shows the whole note — the
                other candidate parents included — however narrow the strip
                cuts the note itself. No tab stop, like the name: the focused
                row's description carries the same note for the keyboard. */}
            <Tooltip content={note}>
              <Badge variant="outline" tone={flag.tone}>
                {flag.label}
              </Badge>
            </Tooltip>
          </div>
        )}
      </Stack>
      <div className="dg-timeline__detail-rest">
        <Stack direction="horizontal" gap={2} align="center">
          <DurationCell ms={row.durationMs} severity="auto" size="sm" />
          <Text size="sm" tone="secondary" numeric>
            {formatOffset(row.startTime, origin)}
          </Text>
          <Badge variant="soft" tone={statusTone(row.status)}>
            {formatStatusLabel(row.status)}
          </Badge>
          {/* Out of the tab order: the same chip is one arrow key into the
              row's own Source cell, and this one may sit in the clipped part of
              the run on a narrow panel, where focus would land on a control the
              reader cannot see. It stays a real control for the pointer. */}
          {row.source === undefined ? null : (
            <SourceLink location={row.source} compact tabIndex={-1} />
          )}
          {/* A direct child of the run's items, so the stylesheet can let it
              alone give way: it shrinks and ends in a visible ellipsis while
              every other item of the run keeps its width. */}
          {note === undefined ? null : (
            <Text size="xs" tone="warning" className="dg-timeline__detail-note">
              {note}
            </Text>
          )}
        </Stack>
      </div>
    </>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The keyboard-reachable equivalent
 * ---------------------------------------------------------------------------
 */

/** Props of {@link TimelineOperationName}. */
interface TimelineOperationNameProps {
  /** The row whose name and description are shown. */
  readonly row: TimelineBar;
  /** The window start every offset is measured from. */
  readonly origin: number;
  /** The names of the spans on screen, so the description can name candidates. */
  readonly spanNames: SpanNames;
  /** Whether the row itself holds keyboard focus and has not dismissed it. */
  readonly revealed: boolean;
}

/**
 * The name in a row's Operation cell and the description it announces.
 *
 * One `Tooltip`, two ways open. Normally a pointer opens it on hover. While the
 * row itself holds keyboard focus the row holds the same `Tooltip` open
 * instead (`open`), because the name is not focusable and must not become a
 * second stop in the row; the row's own handler answers Escape. Either way the
 * primitive measures the bubble against the name and re-places it on every
 * scroll and resize — an open bubble is fixed to the viewport, so one it did
 * not place would paint at the viewport's corner. It is one element in both
 * forms, so exactly one `role="tooltip"` belongs to the name at all times and
 * the name is never remounted by the switch, and the name stays described by
 * it through `aria-describedby`, so assistive technology hears the description
 * once. It opens below the name, so a row's description covers the rows after
 * it and never the table's header above the first row.
 *
 * The name carries no `tabIndex` at all — not `-1`, which would make a click on
 * the name focus the text instead of its row and strand the arrow keys the
 * table answers only on a row.
 */
function TimelineOperationName({
  row,
  origin,
  spanNames,
  revealed,
}: TimelineOperationNameProps): ReactElement {
  return (
    <Tooltip
      content={describeBar(row, origin, spanNames)}
      placement="bottom"
      open={revealed ? true : undefined}
    >
      <Text size="sm" truncate>
        {row.name}
      </Text>
    </Tooltip>
  );
}

/**
 * The columns of the tabular equivalent: the fields this node's catalog entry
 * declares it reads, in the order a reader scans them.
 *
 * A row's location is handed to `SourceLink` BY REFERENCE and field for field —
 * not copied, not normalised, not rounded — because the object the chip raises
 * is the object the editor opens (see that module). The chip is a real control,
 * and the table primitive does not treat a click inside one as a row
 * activation, so opening a file never also selects the span. It is
 * `tabIndex={-1}`, as `../primitives/DataTable` requires of every control a
 * cell renders: the table's own arrow keys (ArrowRight or F2 on the row) move
 * focus onto it, and a chip left in the Tab order would add one stop per
 * rendered row to the single roving stop the table body is.
 *
 * The name in the Operation cell is the trigger of the row's description (see
 * {@link TimelineOperationName}). It is never a tab stop: the table body is one
 * roving stop, and the keyboard reads the description while the row itself
 * holds focus instead (see this module's header).
 *
 * Every column declares its width ROLE, never a size (`DataTableColumnWidth`
 * in `../primitives/DataTable`), and the table resolves each role
 * to a track built from the design system's column floor and share tokens -
 * the same track every other table gives content of that kind. The operation
 * and its source chip are `name`, the identifier role; the kind chip is
 * `label`, whose floor holds a kind label such as "Outgoing request"; the
 * tier and the reported status are `status` chips; the offset and the duration
 * are `quantity` figures. Every role has a readable floor, and the table
 * primitive sums the floors and minimums into its own width: a panel just too
 * narrow for every floor narrows the two `name` columns, never below the
 * `--dg-column-yield` fraction of their floor, only as far as the equivalent
 * needs to fit, keeping every figure in view, and a panel too narrow even for
 * that keeps every floor and scrolls horizontally instead of squeezing a
 * column to its padding (see `DataTableColumn.width`).
 *
 * @param origin The window start every offset in the table is measured from.
 * @param revealedEventId The row whose description is revealed for keyboard
 *   focus, if any.
 * @param spanNames The names of the spans on screen, for naming candidates in
 *   each row's description.
 */
function timelineColumns(
  origin: number,
  revealedEventId: string | undefined,
  spanNames: SpanNames,
): readonly DataTableColumn<TimelineBar>[] {
  return [
    {
      key: 'name',
      header: 'Operation',
      rowHeader: true,
      width: 'name',
      cell: (row) => (
        <Stack direction="horizontal" gap={1} align="center" wrap>
          <TimelineOperationName
            row={row}
            origin={origin}
            spanNames={spanNames}
            revealed={row.eventId === revealedEventId}
          />
          {row.orphaned ? (
            <Badge variant="outline" tone="warning">
              {REATTACHED_FLAG}
            </Badge>
          ) : null}
          {row.lineageAmbiguous ? (
            <Badge variant="outline" tone="warning">
              {AMBIGUOUS_PARENT_FLAG}
            </Badge>
          ) : null}
          {row.parentNotLoaded ? (
            // Informational rather than a warning: nothing was lost, this view
            // just does not hold the parent (see the module header).
            <Badge variant="outline" tone="info">
              {PARENT_NOT_LOADED_FLAG}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 'label',
      cell: (row) => (
        <Badge variant="soft" color={kindColorVar(row.kind)}>
          {formatKindLabel(row.kind)}
        </Badge>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      width: 'status',
      cell: (row) => (
        <Badge variant="outline" color={tierColorVar(row.tier)}>
          {formatTierLabel(row.tier)}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Reported',
      width: 'status',
      cell: (row) => (
        <Badge variant="soft" tone={statusTone(row.status)}>
          {formatStatusLabel(row.status)}
        </Badge>
      ),
    },
    {
      key: 'offset',
      header: 'Offset',
      align: 'end',
      width: 'quantity',
      cell: (row) => (
        <Text size="sm" tone="secondary" numeric>
          {formatOffset(row.startTime, origin)}
        </Text>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'end',
      width: 'quantity',
      cell: (row) => <DurationCell ms={row.durationMs} severity="auto" size="sm" />,
    },
    {
      key: 'source',
      header: 'Source',
      width: 'name',
      cell: (row) =>
        row.source === undefined ? (
          <Text size="sm" tone="muted">
            {NOT_AVAILABLE_LABEL}
          </Text>
        ) : (
          // Out of the Tab order and reached by the table's arrow keys (see
          // above); still a real, pointer-activatable control.
          <SourceLink location={row.source} compact tabIndex={-1} />
        ),
    },
  ];
}

/** A row's stable key: the event id, which is unique even across duplicate spans. */
function rowKeyOf(row: TimelineBar): string {
  return row.eventId;
}

/**
 * The attribute `DataTable` writes on each data row: the row's index into the
 * `rows` it was given. The header row is `role="row"` too and never carries it,
 * which is what keeps it out of {@link DATA_ROW_SELECTOR}.
 */
const ROW_INDEX_ATTRIBUTE = 'data-row-index';

/** A data row of the equivalent table, as `DataTable` renders one. */
const DATA_ROW_SELECTOR = `[role="row"][${ROW_INDEX_ATTRIBUTE}]`;

/**
 * The row whose data row, in the equivalent table, contains `target`.
 *
 * Focus can land on the row itself (the table's roving stop) or on a control
 * inside it (the name trigger, a source chip); both belong to that row. The row
 * element is resolved inside `container` only, so a table nesting this view can
 * never lend it a row of its own.
 *
 * @param target Where focus landed.
 * @param container The element that holds the equivalent table.
 * @param rows The rows that table was given, in its order.
 * @returns The row, or `undefined` when focus is not inside a data row.
 */
function rowHoldingFocus(
  target: EventTarget,
  container: Element,
  rows: readonly TimelineBar[],
): TimelineBar | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const rowElement = target.closest(DATA_ROW_SELECTOR);
  if (rowElement === null || !container.contains(rowElement)) {
    return undefined;
  }

  const index = Number.parseInt(rowElement.getAttribute(ROW_INDEX_ATTRIBUTE) ?? '', 10);

  return Number.isInteger(index) ? rows[index] : undefined;
}

/** Whether `target` is a data row element of the equivalent table itself. */
function isDataRowElement(target: EventTarget): boolean {
  return target instanceof Element && target.matches(DATA_ROW_SELECTOR);
}

/** The row carrying `eventId`, or `undefined` for none or an id not on screen. */
function rowWithId(
  rows: readonly TimelineBar[],
  eventId: string | undefined,
): TimelineBar | undefined {
  return eventId === undefined ? undefined : rows.find((row) => row.eventId === eventId);
}

/**
 * The row the panel's selection stands for, or `undefined` when nothing is
 * selected or the selected event is not among the rows on screen.
 *
 * The row carrying the selected event id wins. Failing that, the first row that
 * names the same trace **and** the same span — the other pairing
 * `matchesPanelSelection` accepts — so a selection reported by a view that drew
 * the span under another record's id still lands on it here. At most one row is
 * returned: the table marks a single selected row and the canvas marks that
 * same one, so the two representations can never disagree.
 *
 * @param rows The rows on screen, in the model's order.
 * @param selection The panel's selection, as `useViewSelection` returns it.
 * @returns The selected row, if it is on screen.
 */
function rowForSelection(
  rows: readonly TimelineBar[],
  selection: PanelSelection | undefined,
): TimelineBar | undefined {
  if (selection === undefined) {
    return undefined;
  }

  return (
    rowWithId(rows, selection.eventId) ?? rows.find((row) => matchesPanelSelection(selection, row))
  );
}

/*
 * ---------------------------------------------------------------------------
 * Paging
 *
 * Only the `spans` source is paged from the provider. A `trace` is one
 * correlated tree, in memory whole, and reports its own truncation instead of
 * offering more. Paging the PROVIDER is a separate matter from paging the
 * drawn-row window (see "The drawn-row window" above): the window moves over
 * whatever the walk holds, which for a span result is every page loaded so far,
 * and a further page only lengthens the walk — it never grows what one window
 * draws.
 *
 * A span result is walked page by page, exactly as the service pages it. Every
 * request asks for the SAME page size — the authored limit, held inside the
 * contract's bounds. The first request starts at the authored offset (the
 * contract's default when none was authored), and each further request starts
 * at the `nextOffset` the previous response named. Nothing else advances the
 * walk: an offset is never derived from the length of a page (that drifts the
 * moment the service clamps a limit), a `total` never implies that another page
 * exists, and a response that names no next offset is the service saying the
 * result is exhausted. No ceiling on the rows loaded so far stops the walk
 * either, so a result longer than `DATA_QUERY_MAX_LIMIT` is reachable to its
 * last page, and a page already on screen is never requested a second time.
 *
 * The pages already loaded live in a {@link PageAccumulator} written ONLY by
 * the "Load more" handler. At the click the rows on screen, the offset to
 * advance to and the total are all in hand, so the accumulator is complete
 * before the next page is requested and no state is ever written from an
 * effect. It is stamped with the identity of the query it belongs to, and a
 * render whose query identity differs discards it by comparison — a node whose
 * query changes returns to its first page with no reset write anywhere, and no
 * frame ever mixes the rows of two queries.
 *
 * The rows loaded are the accumulated rows followed by the page that settled,
 * each event once, first occurrence kept, in the order the service delivered
 * them; the model then draws them parent-first (see this module's header), so a
 * page that brings a parent moves its loaded children beneath it. The service's
 * stable ordering means a page does not repeat a row, so the de-duplication is
 * a guard rather than a correction: a capture that grew between two requests
 * can push a row across a page boundary, and drawing it twice would
 * double-count real work.
 * ---------------------------------------------------------------------------
 */

/**
 * The pages of one span query loaded before the page now in flight.
 *
 * Immutable once written: loading a further page writes a new accumulator
 * whose `rows` already include every earlier page, so a page is never
 * re-requested and never re-merged into the rows before it.
 */
interface PageAccumulator {
  /**
   * The identity of the query these pages belong to: the node and its
   * authored query. The offset of the page in flight is not part of it — that
   * is {@link offset} — so advancing never discards the pages it advanced past.
   */
  readonly identity: string;

  /** Every row loaded before the page in flight, de-duplicated, in arrival order. */
  readonly rows: readonly TelemetryEvent[];

  /** The offset of the page in flight: the `nextOffset` the previous page named. */
  readonly offset: number;

  /**
   * The total the service last reported, carried across the request so the
   * footer keeps stating it while the next page is in flight or has failed.
   */
  readonly total: number | undefined;
}

/** No rows: the carried list before any page has been accumulated. */
const NO_EVENTS: readonly TelemetryEvent[] = Object.freeze([]);

/** The footer control that asks for the next page. */
const LOAD_MORE_LABEL = 'Load more spans';

/** The same control while that page is in flight: the appending indicator. */
const LOADING_MORE_LABEL = 'Loading more spans…';

/** The footer control that moves the drawn window back by one window. */
const PREVIOUS_SPANS_LABEL = 'Previous spans';

/** The footer control that moves the drawn window on by one window. */
const NEXT_SPANS_LABEL = 'Next spans';

/** Which way a paging control moves the drawn window. */
type PagingDirection = 'previous' | 'next';

/**
 * The refine route for a trace the correlator bounded, in the words the flame
 * chart uses: nothing more of it is in memory, so no control could show more.
 */
const REFINE_TRUNCATED_TRACE = 'Narrow the query or capture a shorter interaction to see the rest.';

/**
 * What the equivalent table holds, in the words of its caption, by the query
 * the view draws. A `trace` query draws the spans the correlator joined into
 * that one trace — not every span the interaction captured, since an
 * uncorrelated span belongs to no trace — and a `spans` query draws the
 * captured spans its filter selected, as far as its pages have been loaded
 * (the footer states the service's total beside them). The caption names the
 * set it lists and never claims more than that. Singular, then plural.
 */
const TABLE_SUBJECTS: Readonly<Record<'trace' | 'spans', readonly [string, string]>> = {
  trace: ['span correlated into this trace', 'spans correlated into this trace'],
  spans: [
    "captured span loaded for this view's query",
    "captured spans loaded for this view's query",
  ],
};

/**
 * The caption's name for the set of `count` spans the table lists.
 *
 * @param source The query source the view draws; anything but `trace` is a span query.
 * @param count How many spans the set holds.
 * @returns The subject, agreeing with `count` in number.
 */
function tableSubject(source: DataQuery['source'], count: number): string {
  const [singular, plural] = TABLE_SUBJECTS[source === 'trace' ? 'trace' : 'spans'];
  return count === 1 ? singular : plural;
}

/** Whether a window leaves any row of its walk undrawn. */
function isPartialWindow(window: RowWindow): boolean {
  return window.count < window.total;
}

/** The 1-based range of rows a window draws, as the footer and the labels write it. */
function windowRange(window: RowWindow): string {
  return `${formatCount(window.start + 1)}–${formatCount(window.end)}`;
}

/**
 * The spans a window draws, named by their 1-based positions as the canvas
 * description and the table caption write them: "spans 2,001–4,000", or
 * "span 2,001" for a window of one span, which has no range to write.
 *
 * @param window The drawn window.
 * @returns The lower-case phrase.
 */
function windowSpans(window: RowWindow): string {
  return window.count === 1
    ? `span ${formatCount(window.start + 1)}`
    : `spans ${windowRange(window)}`;
}

/**
 * The footer's statement of which rows a partial window draws, and how many
 * of the walk's rows lie before and after it undrawn — for example "Spans
 * 2,001–4,000 of 9,500 are drawn; 2,000 before them and 5,500 after them are
 * not." A window of one span names its one span — "Span 2,001 of 2,001 is
 * drawn; 2,000 before it are not." — and the closing verb agrees with how many
 * are undrawn. A window that draws the whole walk has nothing to state here.
 *
 * @param window The drawn window.
 * @returns The sentence, or `undefined` when the window draws every row.
 */
function windowStatement(window: RowWindow): string | undefined {
  if (!isPartialWindow(window)) {
    return undefined;
  }

  const total = formatCount(window.total);
  const drawn =
    window.count === 1
      ? `Span ${formatCount(window.start + 1)} of ${total} is drawn`
      : `Spans ${windowRange(window)} of ${total} are drawn`;
  const drawnPronoun = pluralize(window.count, DRAWN_PRONOUN);

  const undrawn: string[] = [];
  if (window.before > 0) {
    undrawn.push(`${formatCount(window.before)} before ${drawnPronoun}`);
  }
  if (window.after > 0) {
    undrawn.push(`${formatCount(window.after)} after ${drawnPronoun}`);
  }

  return `${drawn}; ${undrawn.join(' and ')} ${pluralize(
    window.before + window.after,
    IS_VERB,
  )} not.`;
}

/**
 * The footer's statement about a trace — or about span pages the service
 * reported no total for, which read as a bare count — the counterpart of a
 * span page's "Showing N of M spans.".
 *
 * A walk that fits one window states its count, its noun agreeing with it
 * ("1 span shown.", "4 spans shown."). A longer one states which of its rows
 * the window draws and how many it leaves before and after (see
 * {@link windowStatement}), M being the whole walk. A trace the correlator
 * bounded, whose depth the walk clamped, or that held more nodes than the walk
 * could visit says that more was captured than this view holds — paging the
 * window reaches none of that — and the correlator's case adds the refine
 * route.
 *
 * @param model The payload's model.
 * @returns The footer text.
 */
function traceFooterText(model: TimelineModel): string {
  const sentences: string[] = [
    windowStatement(model.window) ?? `${formatCountOf(model.window.count, SPAN_NOUN)} shown.`,
  ];

  // None of these is reached by paging the window, so each is stated on its
  // own, and the correlator's with the one route that does reach the rest.
  if (model.correlatorTruncated || model.depthClamped || model.walkBounded) {
    sentences.push('More were captured than this view holds.');
  }
  if (model.correlatorTruncated) {
    sentences.push(REFINE_TRUNCATED_TRACE);
  }

  return sentences.join(' ');
}

/**
 * The title shown for a resolved span page that held nothing while the result
 * may not: one that named a next page, one short of or past the end of a
 * positive total, and one past the first row of a result with no total.
 */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/**
 * The sentence for that page. It speaks only of the page: saying the capture
 * holds no spans would contradict the offset the provider just returned.
 */
const EMPTY_PAGE_MESSAGE =
  'This page of spans held nothing to place on the axis. More of the result remains to be loaded.';

/** What one empty state says: its short label and the sentence beneath it. */
interface EmptyCopy {
  /** The label above the message. */
  readonly title: string;
  /** The sentence that explains the absence. */
  readonly message: string;
}

/**
 * The empty state for a result that holds nothing this view can draw: an empty
 * correlated trace, or a span result whose total is zero (or unreported, on its
 * first page). Only here does the view say that nothing was captured.
 */
const NOTHING_CAPTURED_COPY: EmptyCopy = Object.freeze({
  title: 'Nothing to place on the axis',
  message: 'No correlated spans were captured for this interaction.',
});

/** The title for a span query authored with `limit: 0`: a total without rows. */
const COUNT_ONLY_TITLE = 'Count only';

/**
 * The noun for `count` spans, singular exactly when the count prints as `1`:
 * the package's rule (see "Counted words"), for a noun whose number is printed
 * apart from it.
 */
function spanNoun(count: number): string {
  return pluralize(count, SPAN_NOUN);
}

/**
 * The empty state of a resolved span page that put nothing on the axis, with
 * nothing carried from earlier pages and no next page to offer.
 *
 * An empty PAGE is not an empty CAPTURE. The query contract makes `limit: 0`
 * an explicit request for a total without rows, and an offset past the end an
 * empty page rather than an error; in both the service may report a positive
 * total. Saying "nothing was captured" there would contradict the total it
 * just reported, so the cases are told apart, most specific first:
 *
 * 1. `limit: 0` — the count-only view the panel asked for, stating the total
 *    when one was reported. No row is ever expected, so nothing is missing.
 * 2. A total of zero, or no total on the first page — the capture holds no
 *    matching span, and only this case says so.
 * 3. A positive total no greater than the page's offset — the page starts
 *    past the end of the result, and its position and the total are stated.
 * 4. A positive total greater than the page's offset — the rows exist but
 *    none are on this page, and the total is stated.
 * 5. No total, past the first row — the page's position is stated and nothing
 *    is claimed about the rest of the result.
 *
 * A reported total that is not a safe non-negative integer is treated as
 * unreported rather than printed: the seam does not validate it, and a count
 * the reader cannot trust is worse than none.
 *
 * @param limit The page size the request carried, already inside the
 * contract's bounds.
 * @param offset The offset of the page that resolved: the authored offset, or
 * the forward-moving `nextOffset` a previous page named — a non-negative safe
 * integer either way.
 * @param total The total the service reported for the whole span result.
 * @returns The title and message of the empty state to render.
 *
 * @example A `limit: 0` query answered with `total: 42`.
 * ```ts
 * emptySpanPageCopy(0, 0, 42);
 * // { title: 'Count only',
 * //   message: 'This view requests a count without rows: 42 spans matched its query.' }
 * ```
 */
function emptySpanPageCopy(limit: number, offset: number, total: number | undefined): EmptyCopy {
  const reported =
    total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined;

  if (limit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        reported === undefined
          ? 'This view requests a count without rows, and no total was reported for its query.'
          : `This view requests a count without rows: ${formatCount(reported)} ${spanNoun(
              reported,
            )} matched its query.`,
    };
  }

  if (reported === 0 || (reported === undefined && offset === 0)) {
    return NOTHING_CAPTURED_COPY;
  }

  if (reported === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(
        offset + 1,
      )} and holds no spans; no total was reported for this query.`,
    };
  }

  if (offset >= reported) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCount(
        reported,
      )} ${spanNoun(reported)} that matched this query.`,
    };
  }

  return {
    title: EMPTY_PAGE_TITLE,
    message: `${formatCount(reported)} ${spanNoun(
      reported,
    )} matched this query, but none are shown on this page.`,
  };
}

/**
 * The offset of the page after the one requested at `offset`, or `undefined`
 * when there is none.
 *
 * Only the service's own `nextOffset` advances the walk (see "Paging" above).
 * An absent value is the end of the result. So is a value that is not a safe
 * integer, or one that does not move past the page it follows: requesting it
 * would re-request rows already on screen — or loop on them forever — rather
 * than reach new ones.
 *
 * @param nextOffset The `nextOffset` the settled page reported.
 * @param offset The offset that page was requested at.
 * @returns The offset to request next, or `undefined` at the end of the result.
 */
function offsetAfterPage(nextOffset: number | undefined, offset: number): number | undefined {
  if (nextOffset === undefined || !Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
    return undefined;
  }

  return nextOffset;
}

/**
 * The rows already loaded followed by the page that settled, each event once.
 *
 * Keyed by event id, which is unique per record even across duplicate span ids.
 * The first occurrence wins and arrival order is kept, so a row already on
 * screen never moves or changes because a later page repeated it. A page that
 * adds nothing returns `loaded` itself, which keeps every memo downstream of it
 * from recomputing.
 *
 * @param loaded The rows of every earlier page, already de-duplicated.
 * @param page The page that just settled, in the service's order.
 * @returns The rows to draw.
 */
function appendPage(
  loaded: readonly TelemetryEvent[],
  page: readonly TelemetryEvent[],
): readonly TelemetryEvent[] {
  const seen = new Set<string>();
  for (const event of loaded) {
    seen.add(event.id);
  }

  const appended: TelemetryEvent[] = [];
  for (const event of page) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      appended.push(event);
    }
  }

  if (appended.length === 0) {
    return loaded;
  }

  return loaded.length === 0 ? appended : [...loaded, ...appended];
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/** The props of {@link Timeline}. */
export interface TimelineProps {
  /**
   * The validated `timeline` node this component draws.
   *
   * It carries the node's identity, its optional title and description, and the
   * required `DataQuery` whose source the catalog restricts to `trace` or
   * `spans`. The title names the table below the canvas rather than being
   * rendered as a heading here: the panel host owns a node's visible heading, so
   * emitting one here would print it twice.
   */
  node: TimelineNode;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;
}

/**
 * One correlated interaction on a shared time axis, in lanes by tier.
 *
 * @param props The props, as documented on {@link TimelineProps}.
 * @returns The chart and its tabular equivalent, or whichever of the three
 * states — loading, empty or failed — the node's query is currently in.
 *
 * The stateful view is rendered under a `key` that changes exactly when the
 * ambient `DataProvider` is replaced (see {@link useProviderGeneration}). A
 * host that rebinds a mounted panel to another session swaps the provider
 * without remounting the node, and the same node id and query can recur in
 * that session's panel; the accumulated pages, the next offset and the
 * hovered and focused rows of the previous provider must not survive into it,
 * so a new provider is a new instance that paints none of them and starts from
 * the authored first page. The selection is the panel host's, which drops it
 * with the panel it was made in; outside a host it is this instance's own
 * fallback and goes with it.
 *
 * @example The node a panel carries, rendered inside a host that provides a
 * data provider and the panel actions.
 * ```tsx
 * <Timeline node={node} />
 * ```
 */
export function Timeline(props: TimelineProps): ReactElement {
  const providerGeneration = useProviderGeneration();

  return <TimelineView key={providerGeneration} {...props} />;
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
 * The binding is adjusted during render, React's documented pattern for state
 * that follows a changed input: the replaced render is discarded before
 * commit, so nothing loaded from the previous provider is ever painted under
 * the new one. Compared by reference, which is what a provider's identity is:
 * a host creates one per session.
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
 * Where the drawn window of one query's walk starts, and the selection that
 * start already accounts for.
 *
 * Written by the paging controls and by a selection made elsewhere in the
 * panel that names a row outside the window; never from an effect. The query
 * identity tags it exactly as it tags the page accumulator, so a changed query
 * reads no state at all and draws from its first row.
 */
interface WindowState {
  /** The query identity the window was paged for. */
  readonly identity: string;
  /** The first row to draw; `windowRows` pulls a start past the walk's end back. */
  readonly start: number;
  /**
   * The selection this start was chosen with. The window follows the panel's
   * selection only when it CHANGES — a span selected in another view is paged
   * to once — so a reader who then pages away from it is not pulled back.
   */
  readonly followed: PanelSelection | undefined;
}

/**
 * Whether two selections name the same event through the same coordinates.
 *
 * By value rather than by reference, so a host that re-creates an equal
 * selection object is not taken for a new selection the window must follow.
 */
function sameSelection(
  left: PanelSelection | undefined,
  right: PanelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return (
    left.eventId === right.eventId && left.traceId === right.traceId && left.spanId === right.spanId
  );
}

/**
 * The stateful body of {@link Timeline}: one provider's pages, hover and focus
 * for one node, marking the panel's shared selection.
 *
 * @param props The props, as documented on {@link TimelineProps}.
 * @returns The chart and its tabular equivalent, or one of the three states.
 */
function TimelineView(props: TimelineProps): ReactElement {
  const { node, className } = props;

  // Read unconditionally, as a hook must be, and `undefined` outside a host by
  // that module's documented contract: a surface with no actions still renders.
  const actions = usePanelActions();

  // The panel's one shared selection under a host — so this chart marks the
  // span a flame cell, a table row or an evidence chip selected, and they mark
  // the one selected here — and this view's own last activation outside one
  // (see `useViewSelection` in ../host/PanelActions).
  const { selection, markSelected } = useViewSelection();

  const [pages, setPages] = useState<PageAccumulator | undefined>(undefined);
  // The drawn window's start, tagged with the query it was paged for, like the
  // page accumulator: a changed query starts at its first row again on the
  // render that shows it (see `WindowState`).
  const [windowState, setWindowState] = useState<WindowState | undefined>(undefined);
  // The bar the pointer last entered, previewed in the detail strip until the
  // pointer leaves the canvas-and-strip region or Escape dismisses it.
  const [hoveredEventId, setHoveredEventId] = useState<string | undefined>(undefined);
  // The row of the equivalent table that holds keyboard focus, while focus is
  // anywhere inside this view: it drives the detail strip (see this module's
  // header).
  const [focusedEventId, setFocusedEventId] = useState<string | undefined>(undefined);
  // The focused row whose preview Escape dismissed. The preview stays away for
  // as long as focus stays on that row, and returns when focus moves to another
  // one; the row stays the table's tab stop.
  const [dismissedFocusEventId, setDismissedFocusEventId] = useState<string | undefined>(undefined);
  // The row whose description is revealed in its Operation cell: set when the
  // row element itself receives focus that no pointer press caused, cleared
  // when that row loses focus and by Escape.
  const [revealedEventId, setRevealedEventId] = useState<string | undefined>(undefined);
  // Set by a pointer press inside the table and consumed by the focus it
  // causes, so a click — which focuses the row too — does not pop a bubble the
  // hover tooltip already offers. A ref, not state: it changes nothing on screen.
  const pointerFocusRef = useRef(false);

  // The block, the canvas's scroll container and the detail strip: the one
  // region a hover preview survives the pointer crossing, and the document the
  // view is mounted in, which is where an Escape pressed while the pointer
  // rests on a bar arrives. The block is also where a focus handoff after a
  // paging control disappears finds the table's tab stop.
  const blockRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // The canvas's rendered width, which the drawing is laid out at so a user
  // unit is a CSS pixel; `undefined` until one is measured (see
  // `useCanvasWidth`). Kept across a remount of the canvas, which sits in the
  // same viewport at the same width.
  const [canvasWidth, canvasRef] = useCanvasWidth();

  const source = node.query.source;

  // The catalog is the authority on which sources this node type can read, and
  // it is consulted rather than restated. A source outside that set is reported
  // as a failure: a grouped or computed result has no per-record position on a
  // shared axis, so there is nothing honest to draw from it.
  const supported = CATALOG_ENTRY.sources.includes(source);

  // The identity of the page sequence, for the accumulator above: the node's id
  // and its AUTHORED query, and never the offset of the page in flight, which
  // lives on the accumulator. It is compared and never parsed; the node's id is
  // in it so two nodes carrying the same query page independently, and a change
  // to anything the panel authored — the authored offset included, since that
  // is where the sequence starts — is a different sequence.
  const queryIdentity = `${node.id}|${JSON.stringify(node.query)}`;

  // Discarded during render rather than reset from an effect: the comparison is
  // pure, so a node whose query changed can never paint the old query's rows,
  // not even for one frame, and it returns to its first page by derivation.
  const activePages = pages !== undefined && pages.identity === queryIdentity ? pages : undefined;
  const carriedRows = activePages?.rows ?? NO_EVENTS;

  // One page size for every request, held inside the contract's bounds and
  // never grown; the walk advances by offset instead (see "Paging"). The floor
  // is the schema's own: an authored `0` is an explicit request for a total
  // without rows and is sent as written, never rounded up into a row.
  const pageLimit = clamp(node.query.limit ?? DATA_QUERY_DEFAULT_LIMIT, 0, DATA_QUERY_MAX_LIMIT);
  const pageOffset = activePages?.offset ?? node.query.offset ?? DATA_QUERY_DEFAULT_OFFSET;

  // The query's source is the discriminant, so the narrowed request is BUILT
  // from it rather than asserted about the payload: each branch hands the hook a
  // query whose source is a literal, which is what types the resolved page
  // precisely with no cast anywhere. Both hooks are called on every render; the
  // inactive one is handed `undefined`, which resolves nothing and calls no
  // provider.
  const traceQuery: (DataQuery & { source: 'trace' }) | undefined =
    supported && source === 'trace' ? { ...node.query, source: 'trace' } : undefined;
  const spansQuery: (DataQuery & { source: 'spans' }) | undefined =
    supported && source === 'spans'
      ? { ...node.query, source: 'spans', limit: pageLimit, offset: pageOffset }
      : undefined;

  const traceResult = useQuery(traceQuery);
  const spansResult = useQuery(spansQuery);

  // The span page that settled, or `undefined` while one is in flight or after
  // it failed — in which case the carried rows alone are what is on screen.
  const spansPage = spansResult.status === 'success' ? (spansResult.data ?? NO_EVENTS) : undefined;

  const spanRows = useMemo<readonly TelemetryEvent[]>(
    () => (spansPage === undefined ? carriedRows : appendPage(carriedRows, spansPage)),
    [carriedRows, spansPage],
  );

  // The whole walk of the payload, once per payload: paging the drawn window
  // re-cuts the model from it and walks nothing again (see "The drawn-row
  // window").
  const walk = useMemo<TimelineWalk | undefined>(() => {
    // `undefined` while the trace query is unsettled, failed or inactive, and
    // `null` when it settled with no matching trace — the service's own answer
    // for a capture that collected nothing correlated. Neither is a tree to
    // walk: the walk stays undefined, and a settled `null` renders the empty
    // state below, never an error.
    const tree = traceResult.data;
    if (tree !== undefined && tree !== null) {
      return walkFromTrace(tree);
    }

    // Every row loaded so far. While a further page is in flight, or after it
    // failed, that is the rows already on screen, which stay there; before the
    // first page settles there is nothing to walk and the loading state shows.
    if (spansPage !== undefined || spanRows.length > 0) {
      return walkFromSpans(spanRows);
    }

    return undefined;
  }, [traceResult.data, spansPage, spanRows]);

  // The drawn window's start: the one this query was last paged to, or its
  // first row. Discarded by comparison for a changed query, like the pages.
  const activeWindow =
    windowState !== undefined && windowState.identity === queryIdentity ? windowState : undefined;
  let windowStart = activeWindow?.start ?? 0;

  // A selection made anywhere in the panel that names a row outside the drawn
  // window pages the window to the aligned window holding that row
  // (`windowStartFor`), so the selected span is drawn and marked rather than
  // silently off screen. Only a CHANGED selection is followed, and the state is
  // adjusted during render — the pattern `useProviderGeneration` uses — so the
  // frame that would have drawn the old window is discarded before commit. The
  // walk is scanned once per change of selection or walk, never per render,
  // and nothing is followed until there is a walk to page.
  if (walk !== undefined && !sameSelection(activeWindow?.followed, selection)) {
    const selectedIndex =
      selection === undefined ? undefined : walkIndexOfSelection(walk, selection);
    const current = windowRows(walk.total, windowStart, MAX_DRAWN_ROWS);
    const followedStart =
      selectedIndex === undefined || windowContains(current, selectedIndex)
        ? windowStart
        : windowStartFor(selectedIndex, MAX_DRAWN_ROWS);
    setWindowState({ identity: queryIdentity, start: followedStart, followed: selection });
    windowStart = followedStart;
  }

  // The drawn window of the walk: never more than `MAX_DRAWN_ROWS` rows,
  // however long the walk and however often the reader pages.
  const model = useMemo<TimelineModel | undefined>(
    () => (walk === undefined ? undefined : modelFromWalk(walk, windowStart)),
    [walk, windowStart],
  );

  // The frame the window is drawn on: the canvas's measured width, or the
  // fixed fallback width while there is none (see "Canvas structure"). One
  // frame per accepted width, so an unchanged width never re-lays the drawing.
  const frame = useMemo<CanvasFrame>(() => canvasFrameFor(canvasWidth), [canvasWidth]);

  // The drawing of the window on that frame: a pure function of the model and
  // the width, so it is recomputed only when the drawn rows or the canvas's
  // accepted width change. The canvas draws it unless it gathered the
  // selection into a "+N" mark (see `geometry` below).
  const baseGeometry = useMemo<TimelineGeometry | undefined>(
    () => (model === undefined ? undefined : buildGeometry(model, frame)),
    [model, frame],
  );

  // The names every description draws candidate parents from: one lookup per
  // model, shared by the bar titles, the detail strip and the table.
  const spanNames = useMemo<SpanNames>(
    () => (model === undefined ? NO_SPAN_NAMES : spanNamesOf(model.rows)),
    [model],
  );

  // Records the activation (a no-op under a host, which records the report
  // itself) and reports it, so every view of the panel follows. All three
  // coordinates are supplied because this view holds all three.
  const handleSelect = useCallback(
    (row: TimelineBar): void => {
      const ref: PanelEventRef = {
        eventId: row.eventId,
        spanId: row.spanId,
        traceId: row.traceId,
      };
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  // The selected row, and the two previews that may stand in for it in the
  // strip. Each preview is resolved against the rows on screen on its own, so an
  // id that no longer names a row falls through to the next rather than
  // blanking the strip. A focused row is a preview only while it differs from
  // the selection and Escape has not dismissed it.
  const modelRows = model?.rows;
  const selectedRow = modelRows === undefined ? undefined : rowForSelection(modelRows, selection);
  const hoveredRow = modelRows === undefined ? undefined : rowWithId(modelRows, hoveredEventId);
  const focusedRow =
    modelRows === undefined || focusedEventId === dismissedFocusEventId
      ? undefined
      : rowWithId(modelRows, focusedEventId);
  const hoverPreviewing = hoveredRow !== undefined;
  const focusPreviewing = focusedRow !== undefined && focusedRow !== selectedRow;

  // The selection is marked on the canvas, never hidden in a "+N" mark: where
  // the layout above gathered the selected row, the window is drawn again with
  // that row pinned as a bar. Only then — a selection the layout already draws
  // as a bar changes nothing, so no bar moves under the pointer that selected
  // it — and the drawing stays a pure function of the model and that one id.
  const pinnedEventId =
    selectedRow !== undefined && baseGeometry?.gatheredEventIds.has(selectedRow.eventId) === true
      ? selectedRow.eventId
      : undefined;
  const geometry = useMemo<TimelineGeometry | undefined>(
    () =>
      model === undefined || pinnedEventId === undefined
        ? baseGeometry
        : buildGeometry(model, frame, pinnedEventId),
    [baseGeometry, model, frame, pinnedEventId],
  );

  const handleHover = useCallback((eventId: string): void => {
    setHoveredEventId(eventId);
  }, []);

  // Ends the hover preview once the pointer is over anything outside the
  // canvas-and-strip region: the toolbar, the table, the footer. The block's
  // own box is the gap between the canvas and the strip, which the pointer
  // crosses on its way down, so it keeps the preview. Leaving a bar does not
  // end it, which is what lets the pointer reach the strip at all (WCAG 1.4.13
  // "hoverable").
  const handleBlockPointerOver = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const { target, currentTarget } = event;
    if (!(target instanceof Node) || target === currentTarget) {
      return;
    }

    if (
      viewportRef.current?.contains(target) === true ||
      stripRef.current?.contains(target) === true
    ) {
      return;
    }

    setHoveredEventId(undefined);
  }, []);

  // The pointer left the view altogether. Listened for as the native,
  // non-bubbling `pointerleave` of the block itself rather than through React's
  // synthetic leave, which React derives from `pointerout` and its
  // `relatedTarget`: a pointer event that reports no related target reads to
  // React as leaving the window, and would end a preview the pointer is still
  // carrying from a bar to the strip. The native event is dispatched only when
  // the pointer really leaves the block.
  useEffect(() => {
    const block = blockRef.current;
    if (block === null) {
      return undefined;
    }

    const end = (): void => {
      setHoveredEventId(undefined);
    };

    block.addEventListener('pointerleave', end);
    return () => {
      block.removeEventListener('pointerleave', end);
    };
  }, []);

  // The first Escape layer, for a preview that keyboard focus drives: the key
  // reaches the element holding focus, and every focusable part of this view
  // is inside the block. It dismisses both previews — the strip then shows the
  // selection, or its resting line — and consumes the key only when it
  // dismissed something, so a dialog or a shortcut above the panel still sees
  // an Escape this view had no use for. Anything open nearer the focus closes
  // first and consumes that press itself — the description a keyboard-focused
  // row reveals (see `handleEquivalentKeyDown`), or a `Tooltip` bubble open on
  // a control inside a row — so each press dismisses one layer. Focus inside
  // the strip — on the source chip a pointer clicked — is reading the preview
  // itself, and dismissing the strip would unmount the focused chip.
  const handleBlockKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }

      const { target } = event;
      if (target instanceof Node && stripRef.current?.contains(target) === true) {
        return;
      }

      if (!hoverPreviewing && !focusPreviewing) {
        return;
      }

      setHoveredEventId(undefined);
      if (focusPreviewing) {
        setDismissedFocusEventId(focusedEventId);
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [focusPreviewing, focusedEventId, hoverPreviewing],
  );

  // The second Escape layer, for a preview the pointer drives: the pointer does
  // not move focus, so while the pointer rests on a bar or on the strip the key
  // goes to whatever holds focus — most often the page body. The listener lives
  // on the view's own document for exactly as long as a hover preview is shown,
  // and consumes nothing. An Escape something else already handled is left
  // alone, and one the handler above consumed never arrives.
  useEffect(() => {
    if (!hoverPreviewing) {
      return undefined;
    }

    const ownerDocument = blockRef.current?.ownerDocument ?? document;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }

      // Focus inside the strip holds the row it shows (see
      // `handleStripFocus`), so ending the hover preview never unmounts the
      // focused chip.
      setHoveredEventId(undefined);
    };

    ownerDocument.addEventListener('keydown', dismiss);
    return () => {
      ownerDocument.removeEventListener('keydown', dismiss);
    };
  }, [hoverPreviewing]);

  // Follows focus into the equivalent table, wherever in a row it lands. React's
  // `onFocus` bubbles, so one handler on the table's wrapper sees the roving row
  // and every control inside it; focus that lands outside a data row changes
  // nothing. Focus reaching another row ends a dismissal, so that row previews.
  // The row's description is revealed only for focus of the row element itself
  // that no pointer press caused: Tab, Shift+Tab and the table's arrow keys.
  // Focus on a control inside the row — its source chip, which the arrow keys
  // also reach — is not the row's and reveals nothing. The reveal is decided on
  // every focus a row receives, not only when the focused row changes, so
  // returning from the chip to its own row reveals that row's description
  // again.
  const handleEquivalentFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>): void => {
      const fromPointer = pointerFocusRef.current;
      pointerFocusRef.current = false;

      if (modelRows === undefined) {
        return;
      }

      const row = rowHoldingFocus(event.target, event.currentTarget, modelRows);
      if (row === undefined) {
        return;
      }

      if (row.eventId !== focusedEventId) {
        setFocusedEventId(row.eventId);
        setDismissedFocusEventId(undefined);
      }
      setRevealedEventId(isDataRowElement(event.target) && !fromPointer ? row.eventId : undefined);
    },
    [focusedEventId, modelRows],
  );

  // Focus arriving inside the strip makes the row it shows the focused one, so
  // the strip keeps showing it while the reader is in it. Nothing in the strip
  // is a tab stop, so that focus is a pointer's: a click on the strip's source
  // chip, most often while the pointer is previewing a bar.
  const handleStripFocus = useCallback(
    (eventId: string): void => {
      if (eventId !== focusedEventId) {
        setFocusedEventId(eventId);
        setDismissedFocusEventId(undefined);
      }
    },
    [focusedEventId],
  );

  // A row element losing focus — to another row, to a control inside it, or out
  // of the table — ends its reveal; the focus that follows, if it lands on a
  // row, reveals that row's instead.
  const handleEquivalentBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    if (isDataRowElement(event.target)) {
      setRevealedEventId(undefined);
    }
  }, []);

  const handleEquivalentPointerDown = useCallback((): void => {
    pointerFocusRef.current = true;
  }, []);

  // Escape dismisses the revealed description until focus moves to another
  // row, and is consumed only when there was one to dismiss: a dialog or a
  // picking mode above the panel needs Escape too. It is the innermost of the
  // view's Escape layers, so the press stops here and the strip's preview of
  // the same row is the next press's to dismiss (see `handleBlockKeyDown`). An
  // Escape something inside the table already handled is left alone. Any key
  // press is keyboard use, so it also forgets a pointer press that caused no
  // focus.
  const handleEquivalentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      pointerFocusRef.current = false;
      if (event.key === 'Escape' && !event.defaultPrevented && revealedEventId !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        setRevealedEventId(undefined);
      }
    },
    [revealedEventId],
  );

  // Forgets the focused row only when focus leaves this view altogether. Moving
  // from a row to the detail strip above the table — which shows that row — or
  // to the footer keeps it, so the strip does not change under the reader.
  const handleBlockBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) {
      return;
    }

    setFocusedEventId(undefined);
    setDismissedFocusEventId(undefined);
  }, []);

  // Where the next page starts, read off the page that settled; `undefined`
  // whenever there is no next page to offer — a trace, a page still in flight or
  // failed, or a response that named no usable next offset.
  const nextPageOffset =
    source === 'spans' && spansResult.status === 'success'
      ? offsetAfterPage(spansResult.nextOffset, pageOffset)
      : undefined;

  // The total the service reported for the whole span result, kept from the
  // last page that reported one while the next is in flight or has failed.
  const knownTotal = spansResult.total ?? activePages?.total;

  // The ONLY writer of the accumulator. Every row on screen — the carried rows
  // and the page that just settled — becomes the carried rows of the next page,
  // so nothing already loaded is ever requested again.
  const handleLoadMore = useCallback((): void => {
    if (nextPageOffset === undefined) {
      return;
    }

    setPages({
      identity: queryIdentity,
      rows: spanRows,
      offset: nextPageOffset,
      total: knownTotal,
    });
  }, [nextPageOffset, queryIdentity, spanRows, knownTotal]);

  // The two paging controls, so focus can be handed from one to the other when
  // the window reaches either end of the walk and the activated one goes away.
  const previousSpansRef = useRef<HTMLButtonElement | null>(null);
  const nextSpansRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The paging control last activated, read once the window it asked for has
   * rendered: at the first or the last window that control has gone, and focus
   * moves to the control that pages back the other way — or, should neither
   * remain, to the table's tab stop — rather than falling back to the document.
   */
  const focusAfterPaging = useRef<PagingDirection | undefined>(undefined);

  // Moves the drawn window by one window. The window never grows: the next
  // window starts where this one ends, the previous one a whole budget
  // earlier, and neither passes the ends of the walk (see `../utils/scale`).
  // The selection already followed is carried over, so paging away from a
  // selected span is not undone by following it again.
  const modelWindow = model?.window;
  const moveDrawnWindow = useCallback(
    (direction: PagingDirection): void => {
      if (modelWindow === undefined) {
        return;
      }
      focusAfterPaging.current = direction;
      setWindowState({
        identity: queryIdentity,
        start:
          direction === 'next' ? nextWindowStart(modelWindow) : previousWindowStart(modelWindow),
        followed: selection,
      });
    },
    [modelWindow, queryIdentity, selection],
  );
  const handlePreviousSpans = useCallback((): void => {
    moveDrawnWindow('previous');
  }, [moveDrawnWindow]);
  const handleNextSpans = useCallback((): void => {
    moveDrawnWindow('next');
  }, [moveDrawnWindow]);

  useEffect(() => {
    const direction = focusAfterPaging.current;
    if (direction === undefined) {
      return;
    }
    focusAfterPaging.current = undefined;
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
    const counterpart = direction === 'next' ? previousSpansRef.current : nextSpansRef.current;
    (
      counterpart ?? block.querySelector<HTMLElement>('.dg-timeline__equivalent [tabindex="0"]')
    )?.focus();
  }, [model]);

  const activeResult = source === 'trace' ? traceResult : spansResult;

  // The query the active hook was handed: exactly what a failure reports as the
  // failing query and what its retry asks again — for a span result, the page
  // size and offset this render requested included. The authored query stands
  // in only when neither hook was handed one, which is the unsupported source,
  // and that branch reports the authored query itself.
  const activeQuery: DataQuery = (source === 'trace' ? traceQuery : spansQuery) ?? node.query;

  // A further span page in flight behind rows already on screen, and one that
  // failed behind them. Both are reported in the footer; neither replaces the
  // chart and table the reader is already reading.
  const appending =
    source === 'spans' && spansResult.status === 'loading' && carriedRows.length > 0;
  const pageFailed = source === 'spans' && spansResult.status === 'error' && carriedRows.length > 0;

  let content: ReactNode;

  if (!supported) {
    // A panel defect rather than a failed request: nothing was asked, so the
    // authored query is what is shown and no retry is offered — asking again
    // cannot change the answer. The wording is the shared contract's, composed
    // from this node type's catalog entry.
    content = (
      <div className="dg-timeline__error">
        <ErrorState {...unsupportedQueryProps(node.type, node.query)} />
      </div>
    );
  } else if (activeResult.status === 'loading' && !appending) {
    content = (
      <div className="dg-timeline__loading">
        <LoadingState variant="chart" label="Loading the correlated timeline…" />
      </div>
    );
  } else if (activeResult.status === 'error' && !pageFailed) {
    // Nothing is on screen yet, so the failure is the view's: the shared
    // contract supplies the title, the generic lead with the provider's cause,
    // the hint, the code, the failing query in the one format every node
    // prints, the technical details, the announcement and the retry.
    content = (
      <div className="dg-timeline__error">
        <ErrorState {...queryFailureProps(activeResult, activeQuery)} />
      </div>
    );
  } else if (
    (model === undefined || geometry === undefined || model.rows.length === 0) &&
    nextPageOffset !== undefined &&
    pageLimit > 0
  ) {
    // A resolved span page with nothing on it that still names where the next
    // page starts. The provider's offset is the whole of the paging contract,
    // so the rows after it stay reachable: the page is reported as empty —
    // never the capture — and the paging control is offered as under a full page.
    // A count-only query (`limit: 0`) is excluded: every page it could reach is
    // requested at the same zero size and holds no rows, so a paging control
    // would advance through nothing. It falls through to its count-only state.
    content = (
      <>
        <div className="dg-timeline__empty">
          <EmptyState title={EMPTY_PAGE_TITLE} message={EMPTY_PAGE_MESSAGE} />
        </div>
        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
          <Text size="xs" tone="muted">
            {knownTotal === undefined
              ? `${formatCountOf(0, SPAN_NOUN)} shown.`
              : `Showing ${formatCount(0)} of ${formatCountOf(knownTotal, SPAN_NOUN)}.`}
          </Text>
          <Button variant="secondary" size="sm" onClick={handleLoadMore}>
            {LOAD_MORE_LABEL}
          </Button>
        </Stack>
      </>
    );
  } else if (model === undefined || geometry === undefined || model.rows.length === 0) {
    // Nothing on the axis and no next page to offer. A trace reports no total,
    // so an empty one is an empty capture. A resolved span page is told apart
    // by the size and position it was requested at and the total the service
    // reported (see `emptySpanPageCopy`): a count-only query, a page past the
    // end or a page short of it is never reported as an empty capture.
    const empty =
      source === 'spans' && spansResult.status === 'success'
        ? emptySpanPageCopy(pageLimit, pageOffset, knownTotal)
        : NOTHING_CAPTURED_COPY;

    // Only the empty capture carries the view's glyph, as every other view's
    // empty capture does: a count-only answer or an empty page is a statement
    // about paging, and its title already names which one it is.
    content = (
      <div className="dg-timeline__empty">
        <EmptyState
          title={empty.title}
          message={empty.message}
          icon={empty === NOTHING_CAPTURED_COPY ? <ChartGantt className="dg-icon" /> : undefined}
        />
      </div>
    );
  } else {
    // The drawn window's extent: a subtraction, not a measured duration, so it
    // floors at zero itself — the formatter answers a negative duration with
    // "n/a", and a window never runs backwards.
    const windowMs = clampNonNegative(model.endTime - model.startTime);
    const { window } = model;
    // What is drawn — the window's rows — and what the walk holds in all: for a
    // span result, every row loaded so far.
    const drawn = model.rows.length;
    const loaded = window.total;
    // Whether the walk holds rows this window does not draw, which the footer
    // states and the paging controls reach.
    const windowed = isPartialWindow(window);
    // Only a span result reports a total; a trace states its own truncation.
    const total = source === 'spans' ? knownTotal : undefined;
    // Offered only while the service names a next page. A total larger than
    // what is loaded is stated in the footer and marked as partial, but never
    // taken to mean that a further page exists.
    const canLoadMore = nextPageOffset !== undefined;
    const partial =
      model.truncated ||
      windowed ||
      canLoadMore ||
      appending ||
      pageFailed ||
      (total !== undefined && loaded < total);

    // The selection is what the strip shows; the pointer, then keyboard focus,
    // preview another row in its place while they rest on it and until Escape
    // dismisses them (see the three rows resolved above the handlers).
    const detailRow = hoveredRow ?? focusedRow ?? selectedRow;
    const previewing = detailRow !== undefined && detailRow !== selectedRow;

    // A window that draws part of the walk says so in the picture's own words,
    // as the flame chart's does: the subset, which rows it is, and the walk it
    // was cut from. The table below holds exactly the rows the canvas draws.
    // Every count agrees its noun with its number ("1 span in 1 tier lane"),
    // and a window of one span names its one position rather than a range.
    const drawnCount = windowed
      ? `${formatCount(drawn)} of ${formatCountOf(loaded, SPAN_NOUN)} (${windowSpans(window)})`
      : formatCountOf(drawn, SPAN_NOUN);
    const drawnPossessive = pluralize(drawn, SPAN_POSSESSIVE);
    // Spans a crowded depth gathered into "+N" marks are stated in the canvas's
    // own words and in the footer, not only drawn as marks.
    const gatheredText = overflowStatement(geometry);
    const canvasLabel = `${CATALOG_ENTRY.label}: ${drawnCount} in ${formatCountOf(
      model.tiers.length,
      TIER_LANE_NOUN,
    )} over ${formatDuration(windowMs)}. ${
      windowed
        ? `The table below lists the same ${spanNoun(
            drawn,
          )} with ${drawnPossessive} kind, tier, offset and duration.`
        : drawn === 1
          ? 'The table below lists it with its kind, tier, offset and duration.'
          : 'The table below lists each of them with its kind, tier, offset and duration.'
    }${gatheredText === undefined ? '' : ` ${gatheredText}`}`;
    const tableCaption = windowed
      ? `${node.title ?? CATALOG_ENTRY.label}: ${windowSpans(window)} of the ${formatCount(
          loaded,
        )} ${tableSubject(source, loaded)}, with ${drawnPossessive} kind, tier, offset and duration.`
      : `${node.title ?? CATALOG_ENTRY.label}: the ${formatCount(drawn)} ${tableSubject(
          source,
          drawn,
        )}, with ${drawnPossessive} kind, tier, offset and duration.`;

    // A span result states the service's total first; the window's own
    // statement follows whenever the window leaves loaded rows undrawn.
    const spansWindowText = windowStatement(window);
    const footerText =
      total === undefined
        ? traceFooterText(model)
        : `Showing ${formatCount(loaded)} of ${formatCountOf(total, SPAN_NOUN)}.${
            spansWindowText === undefined ? '' : ` ${spansWindowText}`
          }`;
    // What the lanes gathered into "+N" marks follows what the window holds.
    const footerStatement =
      gatheredText === undefined ? footerText : `${footerText} ${gatheredText}`;

    content = (
      <>
        <Toolbar
          className="dg-timeline__toolbar"
          label="Timeline summary"
          compact
          wrap
          status={[
            { label: formatCountOf(drawn, SPAN_NOUN), variant: 'soft' },
            { label: formatCountOf(model.tiers.length, TIER_NOUN), variant: 'soft' },
            { label: `${formatDuration(windowMs)} elapsed`, variant: 'soft' },
            ...(partial
              ? [{ label: 'Partial result', tone: 'warning' as const, variant: 'outline' as const }]
              : []),
          ]}
        />

        <div ref={viewportRef} className="dg-timeline__viewport">
          <TimelineCanvas
            geometry={geometry}
            canvasRef={canvasRef}
            origin={model.startTime}
            spanNames={spanNames}
            selectedEventId={selectedRow?.eventId}
            onSelect={handleSelect}
            onHover={handleHover}
            label={canvasLabel}
          />
        </div>

        {/* Always drawn, in a reserved line, so neither a hover nor a
            selection moves the table below it (see `TimelineDetail`). */}
        <TimelineDetail
          row={detailRow}
          previewing={previewing}
          origin={model.startTime}
          spanNames={spanNames}
          stripRef={stripRef}
          onFocusWithin={handleStripFocus}
        />

        <div
          className="dg-timeline__equivalent"
          onFocus={handleEquivalentFocus}
          onBlur={handleEquivalentBlur}
          onPointerDown={handleEquivalentPointerDown}
          onKeyDown={handleEquivalentKeyDown}
        >
          <DataTable<TimelineBar>
            id={`${node.id}-rows`}
            caption={tableCaption}
            rows={model.rows}
            columns={timelineColumns(model.startTime, revealedEventId, spanNames)}
            rowKey={rowKeyOf}
            selectedRowKey={selectedRow === undefined ? null : rowKeyOf(selectedRow)}
            onRowActivate={handleSelect}
            compact
          />
        </div>

        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
          {/* Polite and live, so the count a further page or another window
              reveals is announced; never `role="status"`, which is the
              loading placeholder's. */}
          <Text size="xs" tone="muted" aria-live="polite">
            {footerStatement}
          </Text>
          {windowed ? (
            // The walk is in memory whole, so these move the drawn window over
            // it instead of asking the provider for anything. Each is present
            // only while there are rows on its side of the window; the slot of
            // an absent one is kept, so the other is never remounted and never
            // loses focus when the window reaches an end.
            <Stack direction="horizontal" gap={2} align="center" wrap>
              {window.before > 0 ? (
                <Button
                  ref={previousSpansRef}
                  variant="secondary"
                  size="sm"
                  onClick={handlePreviousSpans}
                >
                  {PREVIOUS_SPANS_LABEL}
                </Button>
              ) : null}
              {window.after > 0 ? (
                <Button ref={nextSpansRef} variant="secondary" size="sm" onClick={handleNextSpans}>
                  {NEXT_SPANS_LABEL}
                </Button>
              ) : null}
            </Stack>
          ) : null}
          {canLoadMore || appending ? (
            // Kept in place while the page it asked for is in flight — disabled
            // and busy, its label the appending indicator — so the control
            // does not vanish from under the reader's pointer or focus.
            <Button
              variant="secondary"
              size="sm"
              disabled={!canLoadMore}
              aria-busy={appending}
              onClick={handleLoadMore}
            >
              {appending ? LOADING_MORE_LABEL : LOAD_MORE_LABEL}
            </Button>
          ) : null}
        </Stack>

        {pageFailed ? (
          // The next page failed, the rows above it did not: the failure and
          // its retry sit below them, and the retry re-requests that same page.
          // The page scope says so in its title and lead, and the query shown
          // is the page that failed, at the offset it was requested at.
          <div className="dg-timeline__error">
            <ErrorState
              {...queryFailureProps(spansResult, spansQuery ?? node.query, { scope: 'page' })}
            />
          </div>
        ) : null}
      </>
    );
  }

  // The block listens for the two ends of a preview: the pointer moving out of
  // the canvas-and-strip region or out of the view, and Escape from whatever
  // holds focus inside it. None of these makes the block itself interactive.
  return (
    <div
      ref={blockRef}
      className={clsx('dg-timeline', className)}
      onBlur={handleBlockBlur}
      onKeyDown={handleBlockKeyDown}
      onPointerOver={handleBlockPointerOver}
    >
      {content}
    </div>
  );
}
