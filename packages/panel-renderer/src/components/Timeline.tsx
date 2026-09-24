/**
 * `Timeline` — the cross-tier correlated view of one interaction: every
 * captured span placed on a shared time axis, grouped into lanes by the tier
 * that produced it (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `timeline` type, and
 * it is the node a "where did the time go" panel opens with. It has to be able
 * to show the whole shape of one interaction at once — the click, the handler,
 * the state update, the request, the server span that answered it, the route
 * handler, the service functions nested inside it, the datastore call at the
 * bottom, the outgoing call beside it, the response and the render that
 * followed — as one ordered tree with a duration on every row (AAP 0.4.2).
 *
 * ## Data arrives through the node's query, and only through it
 *
 * The node carries a `DataQuery` whose source the catalog restricts to `trace`
 * or `spans`; this file resolves it with `../host/useQuery` and touches no
 * socket, no `fetch` and no service internals (AAP 0.4.2). The two payload
 * shapes are normalised into ONE render-local model ({@link TimelineBar}) and
 * the branch is taken on the QUERY'S OWN SOURCE — the discriminant the panel
 * was authored with — never by inspecting the data's shape:
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
 *   parent-before-child order AAP 0.2.3 fixes, which a child whose clock reads
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
 * ## The canvas is laid out in CSS pixels
 *
 * `../utils/measure`'s `useChartCanvas` reports the inner width of the scroll
 * viewport the canvas is drawn into, kept current as the panel is resized, and
 * the canvas is drawn exactly that wide with a `viewBox` of the same size
 * (`resolveCanvasWidth` in `../utils/scale`): one user unit is one CSS pixel,
 * so the 11 px label roles render at 11 px at every panel width, the canvas
 * declares no height it does not draw into, and the time axis spans the whole
 * section however wide it is. A viewport narrower than `MIN_CANVAS_WIDTH`
 * scrolls the canvas horizontally instead of squeezing it. This file reads no
 * layout itself: the hook takes its first measurement while the viewport's ref
 * attaches, before the first paint, and follows every resize after it.
 *
 * A bar's label is measured in the label font before it is placed, so it is
 * drawn only where it fits — after the bar, before it, inside it, or shortened
 * to an ellipsis — and never across the lane labels, past the canvas edge or
 * over another bar or label (see "Bar labels" below).
 *
 * Where nothing can be measured — an environment with no layout, which is
 * every component suite — the canvas lays out at `DEFAULT_CANVAS_WIDTH` user
 * units, declares `width="100%"` and scales that drawing uniformly to its
 * container (`preserveAspectRatio="xMinYMin meet"`, so glyphs are never
 * stretched sideways), and labels are measured by the hook's deterministic
 * estimate. The drawing is then a pure function of the data, which is what the
 * layout-free suite asserts against.
 *
 * Every coordinate comes from `../utils/scale` and every colour from
 * `../utils/color`; this file performs no interval arithmetic of its own and
 * writes no colour, length or spacing literal. A bar's kind colour travels to
 * the stylesheet as `--dgc-bar-color` and a lane's tier accent as
 * `--dgc-lane-color`, which are the only inline values written anywhere below
 * (AAP 0.6.4).
 *
 * ## An SVG alone is not a representation
 *
 * The canvas is `role="img"` with a text alternative, which means its contents
 * are not in the accessibility tree and its bars are not focusable. The
 * keyboard-reachable representation is therefore mandatory rather than a
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
 * every view of the panel moves its mark together. Outside a host the view
 * falls back to its own last activation, exactly as it behaved on its own.
 *
 * ## Evidence is rendered as it arrives
 *
 * - An **ambiguous** async continuation — more than one settled request had an
 *   open continuation window when the event landed — is drawn with the dashed
 *   warning edge the stylesheet implements and a dashed warning outline on its
 *   bar, and its alternative candidates are named in the row's description: by
 *   the operation each recorded and its span id, where the candidate is a span
 *   of the same trace among the rows on screen, and by its span id alone
 *   otherwise. A guessed relationship must never read as a measured one
 *   (AAP 0.4.2).
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
 *   while it loads and if it fails. A `trace` arrives whole, so a walk stopped
 *   at its row bound (`../utils/scale`'s `DEFAULT_MAX_TRACE_ROWS`) states "N of
 *   M spans shown", M being the trace's own node count, and offers "Show more
 *   spans", which raises the bound by one step without asking the provider for
 *   anything; the bound returns to its default when the node's query changes.
 *   A trace the correlator itself bounded says so and gives the refine route —
 *   narrowing the query or capturing a shorter interaction — since nothing more
 *   of it is in memory.
 * - URLs, statements and attribute values arrive redacted and truncated
 *   (AAP 0.5.2). They are rendered exactly as given: nothing here reconstructs
 *   a URL, expands a statement or dumps an attribute bag.
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
 *   dg-timeline__detail        the reserved, never-wrapping line between the
 *                              canvas and the table: the selected span, or a
 *                              hovered or focused one previewed in its place
 *   dg-timeline__detail-rest   that line's trailing run, clipped rather than
 *                              wrapped on a narrow panel
 *   dg-timeline__tooltip       the slot the shown row's description sits in
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
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceTree,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { kindColorVar, tierColorVar } from '../utils/color';
import { fitTextToWidth, useChartCanvas } from '../utils/measure';
import type { TextMeasure } from '../utils/measure';
import {
  NOT_AVAILABLE_LABEL,
  collapseWhitespace,
  formatCount,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
  formatTierLabel,
} from '../utils/format';
import {
  DEFAULT_MAX_TRACE_ROWS,
  DEFAULT_ROW_HEIGHT,
  alignHairline,
  clamp,
  createTimeScale,
  flattenTraceRows,
  generateAxisTicks,
  isMeasuredWidth,
  layoutDepth,
  layoutLaneStack,
  placeSpanDuration,
  rankLaneDepths,
  resolveCanvasWidth,
} from '../utils/scale';
import type { AxisTick, FlatTraceRow, TimeScale, TraceLayoutOptions } from '../utils/scale';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The catalog entry, and the vocabulary taken from it
 *
 * The node catalog is the single registry of node types (AAP 0.6.2): which
 * sources this node may read and which telemetry fields it reads are declared
 * there and imported here, never restated. A source the catalog does not allow
 * is reported as a failure rather than drawn from, because a panel that asked
 * for an aggregate has asked for something this view cannot place on an axis.
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
 * so a coordinate has exactly one owner. A measured canvas draws one user unit
 * per CSS pixel, so these are pixel sizes there; an unmeasured one scales its
 * `DEFAULT_CANVAS_WIDTH` units to its container (see this module's header).
 * None of these is a CSS value — no `px`, no `rem`, no colour. The canvas's
 * WIDTH is not among them: it is the viewport's, resolved per render.
 * ---------------------------------------------------------------------------
 */

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
 * exactly once, in `@debuggen/telemetry` (AAP 0.2.3), and this package imports
 * them as types only. What follows is the flat, already-positioned view of them
 * that this one component draws — one row per span, whichever payload it came
 * from — so that the two payload shapes are reconciled in ONE place instead of
 * in every branch of the render. Its field names deliberately echo the
 * telemetry timeline row (`depth`, `offsetMs`'s origin, `durationMs`), so a
 * reader moving between the two is reading the same vocabulary.
 * ---------------------------------------------------------------------------
 */

/** One span, ready to draw: its identity, its place in the tree and its flags. */
interface TimelineBar {
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
  /** Which lane this row belongs to, as an index into the model's `tiers`. */
  readonly laneIndex: number;
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

/** The rows of one payload, the window they occupy and what was left out. */
interface TimelineModel {
  /** Every row, in the order the payload established. */
  readonly rows: readonly TimelineBar[];
  /** The tiers present, in lane order — the index `TimelineBar.laneIndex` names. */
  readonly tiers: readonly TelemetryTier[];
  /** The window's start, in epoch milliseconds: the origin every offset reads from. */
  readonly startTime: number;
  /** The window's end, in epoch milliseconds. */
  readonly endTime: number;
  /**
   * Whether rows exist that this model does not hold, for any reason: the
   * walk's row bound, its depth bound, or the correlator's own truncation. It
   * is what marks the summary as a partial result.
   */
  readonly truncated: boolean;
  /**
   * Whether the trace walk stopped at its ROW bound with more of the tree in
   * memory — the one reduction "Show more spans" lifts. Only a trace sets it.
   */
  readonly walkBounded: boolean;
  /**
   * Whether the correlator itself bounded the trace before this view saw it.
   * Nothing more of it is in memory, so no control can show more: only a
   * narrower query or a shorter capture reaches the rest. Only a trace sets it.
   */
  readonly correlatorTruncated: boolean;
  /**
   * Whether the walk's DEPTH bound left children out. A larger row bound does
   * not lift it, so the footer states it apart from the row bound.
   */
  readonly depthClamped: boolean;
  /**
   * The trace's own node count — the `M` of "N of M spans shown" — or
   * `undefined` for span pages, whose total the service reports instead.
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
 * on it for types only (AAP 0.2.2), so importing the constant would add a
 * runtime edge the layering forbids. The names are the ones
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

/** The window the rows themselves occupy: the earliest start to the latest end. */
function boundsOfBars(bars: readonly UnassignedBar[]): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  for (const bar of bars) {
    if (!Number.isFinite(bar.startTime)) {
      continue;
    }
    const barEnd =
      bar.startTime + (Number.isFinite(bar.durationMs) ? Math.max(bar.durationMs, 0) : 0);
    start = Math.min(start, bar.startTime);
    end = Math.max(end, barEnd);
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
function barFromTraceRow(row: FlatTraceRow): UnassignedBar {
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
function barFromEvent(
  event: TelemetryEvent,
  depth: number,
  parentNotLoaded: boolean,
): UnassignedBar {
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
 * The SIBLING order of a flat page: the canonical keys AAP 0.2.3 fixes, each
 * reached only when every earlier key ties — `startTime`, then `producerId`,
 * then the producer's own `seq`, then the store's `ingestSeq` — with the event
 * id as defence in depth.
 *
 * It orders siblings, and the roots of the loaded forest, and nothing else.
 * Parent-before-child outranks every one of these keys and is established by
 * the walk in {@link flattenParentFirst}, never by a timestamp: the browser and
 * the server read two clocks and no alignment is applied, so a child's start
 * can legitimately read earlier than its parent's.
 *
 * A local mirror of `@debuggen/telemetry`'s `compareEventsCanonical`, key for
 * key and comparison for comparison. It is mirrored rather than imported
 * because this package depends on telemetry for types only (AAP 0.2.2), and
 * importing the function would add a runtime edge the layering forbids. Like
 * that function it compares with `<`/`>` alone, so a non-finite number — which
 * the event schema rejects, but which a store an older build wrote could still
 * hand over — falls through to the next key instead of returning `NaN` into the
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
 * expands nothing — which is exactly the record `buildGeometry`'s
 * first-bar-per-span lookup resolves, so every connector joins the record its
 * child is drawn beneath. A set of visited event ids — the identity the pages
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
function flattenParentFirst(events: readonly TelemetryEvent[]): readonly UnassignedBar[] {
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

  const bars: UnassignedBar[] = [];
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

/**
 * The bounds the trace walk runs under.
 *
 * The walk visits ONE span past `maxRows` and keeps only the first `maxRows`
 * rows (its `visibleRows` window): whether it produced that extra span is the
 * exact answer to "does the trace hold more than this view shows", which the
 * layout's `truncated` flag cannot give because the depth bound sets it too.
 *
 * @param tree The resolved trace.
 * @param maxRows The most spans this view shows.
 * @returns The layout options.
 */
function traceWalkOptions(tree: TraceTree, maxRows: number): TraceLayoutOptions {
  // The tree's own greatest depth bounds the walk. It is honoured only when it
  // is a usable positive integer: a stored tree reporting `0` while its roots
  // carry children would otherwise have every child left unvisited, and hiding
  // captured work is the one thing this walk may not do. Absent, the walk uses
  // the layout module's own bound.
  const rows = { maxRows: maxRows + 1, visibleRows: maxRows };
  return Number.isInteger(tree.maxDepth) && tree.maxDepth > 0
    ? { ...rows, maxDepth: tree.maxDepth }
    : rows;
}

/**
 * A correlated trace as rows: the children-only walk, in tree order.
 *
 * @param tree The resolved trace.
 * @param maxRows The row bound in force — the default, or as raised by "Show
 * more spans".
 * @returns The model, with what the walk and the correlator left out.
 */
function modelFromTrace(tree: TraceTree, maxRows: number): TimelineModel {
  const layout = flattenTraceRows(tree, traceWalkOptions(tree, maxRows));
  const bars = layout.rows.map(barFromTraceRow);
  const { rows, tiers } = assignLanes(bars);

  // The tree publishes its own window, and the rows' own bounds WIDEN it rather
  // than replace it: an async continuation that settled after the root closed is
  // real captured work, and an axis that ended at the root's end would clip it.
  const derived = boundsOfBars(bars);
  const startTime =
    bars.length === 0
      ? isUsableInstant(tree.startTime)
        ? tree.startTime
        : 0
      : isUsableInstant(tree.startTime)
        ? Math.min(tree.startTime, derived.start)
        : derived.start;
  const endTime =
    bars.length === 0
      ? isUsableInstant(tree.endTime)
        ? tree.endTime
        : 0
      : isUsableInstant(tree.endTime)
        ? Math.max(tree.endTime, derived.end)
        : derived.end;

  // The lookahead span was produced only when more of the tree lies within the
  // depth bound than the row bound shows.
  const walkBounded = layout.totalRowCount > maxRows;
  const depthClamped = layout.rows.some((row) => row.childrenTruncated);

  return {
    rows,
    tiers,
    startTime,
    endTime,
    // Every truncation matters and they are different statements: the
    // correlator may have dropped nodes before this view saw the tree, and this
    // walk may have stopped at its row bound or its depth bound.
    truncated: tree.truncated || walkBounded || depthClamped,
    walkBounded,
    correlatorTruncated: tree.truncated,
    depthClamped,
    nodeCount: tree.nodeCount,
  };
}

/**
 * The loaded rows of a flat span list — every page loaded so far, already
 * de-duplicated — as rows, parent before child.
 *
 * The order is {@link flattenParentFirst}'s: the loaded rows linked into a
 * parent/child forest and walked depth-first, with {@link compareSpans}
 * ordering siblings. It is recomputed from every loaded row each time a page
 * settles, so a page that brings a parent re-links the children already on
 * screen beneath it, and clears their "Parent not loaded" mark.
 */
function modelFromSpans(events: readonly TelemetryEvent[]): TimelineModel {
  const bars = flattenParentFirst(events);
  const { rows, tiers } = assignLanes(bars);
  const window = boundsOfBars(bars);

  return {
    rows,
    tiers,
    startTime: window.start,
    endTime: window.end,
    // A page is not a truncated result: how much of the result it holds is what
    // `total` reports, and the footer states it exactly rather than as a flag.
    truncated: false,
    walkBounded: false,
    correlatorTruncated: false,
    depthClamped: false,
    nodeCount: undefined,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * One pure function of the model and the canvas it is drawn on — the canvas's
 * width and a measure of the label font — so the same three inputs always draw
 * the same picture, and no layout is read here. Every number below comes out
 * of `../utils/scale`: the time-to-pixel map, a bar's offset and width with its
 * minimum visible width and its edge clipping, the lane stack, the depth
 * rhythm and the axis ticks. Re-deriving any of that here would give the
 * product two timelines that disagree slightly.
 * ---------------------------------------------------------------------------
 */

/** A floor on a bar's height, so a row rhythm change can never erase a bar. */
const MIN_BAR_HEIGHT = 4;

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
  /** How many rows the lane holds: one per distinct depth among its spans. */
  readonly rowCount: number;
}

/**
 * Where a bar's label sits: beside the bar on the lane surface (after its end
 * or before its start), or inside it on the kind fill.
 */
type BarLabelPlacement = 'after' | 'before' | 'inside';

/** A bar's label, measured and placed (see "Bar labels" below). */
interface BarLabelGeometry {
  /**
   * The text drawn: the span's name and compact duration, or — where that does
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
  /** The text's measured advance width, in user units. */
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

/** Everything the canvas needs, computed once per model. */
interface TimelineGeometry {
  /** The time-to-pixel map the bars and the axis share. */
  readonly scale: TimeScale;
  /** The lane bands, in lane order. */
  readonly lanes: readonly LaneGeometry[];
  /** One bar per row, in the model's order. */
  readonly bars: readonly BarGeometry[];
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
 * data, and all of what it knows about the page.
 */
interface CanvasFrame {
  /**
   * The canvas's width in user units, from `resolveCanvasWidth`: the viewport's
   * measured inner width in CSS pixels, or the unmeasured fallback width.
   */
  readonly width: number;
  /** Measures a string in the bar-label font, in the same user units. */
  readonly measureText: TextMeasure;
}

/*
 * Bar labels
 *
 * A bar's label is its span's name and compact duration ("name · 12 ms"),
 * measured in the label font and drawn in the first place it fits whole:
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
 * the bar geometry and the measure: identical on every render, and in the
 * unmeasured mode (with the measure's deterministic estimate) identical in an
 * environment with no layout.
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
    // Measured as drawn rather than summed, so no kerning across the join can
    // carry the label past its room.
    const text = `${beside.text}${suffix}`;
    const width = measure(text);
    if (width <= room) {
      return { text, width };
    }
  }

  const alone = fitTextToWidth(name, room, measure, options);

  return alone === undefined ? undefined : { text: alone.text, width: alone.width };
}

/** A label of `text`, measured `width` wide, drawn in `slot`. */
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
  const suffix = `${BAR_LABEL_SEPARATOR}${formatDurationCompact(bar.row.durationMs)}`;
  const whole = `${name}${suffix}`;
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

/** Turns the model into the canvas it is drawn on, reading no layout and mutating nothing. */
function buildGeometry(model: TimelineModel, frame: CanvasFrame): TimelineGeometry {
  const { width } = frame;
  const scale = createTimeScale(
    [model.startTime, model.endTime],
    [LANE_LABEL_WIDTH, width - CANVAS_RIGHT_GUTTER],
  );

  // Depth is what places a row inside its lane, and a lane's depths are sparse:
  // a tier holds the spans of one process, nested under spans drawn in other
  // lanes, so a database lane can hold an orphan re-attached at depth 1 and a
  // query nested at depth 5. Each lane's depths are ranked (`rankLaneDepths`):
  // every distinct depth occupies one row, a deeper span still sits below a
  // shallower one, and no row is reserved for a depth nothing in the lane
  // occupies — so a lane that begins six levels down starts at its own first
  // row, and a gap in its depths opens no empty band.
  const laneDepths: number[][] = model.tiers.map(() => []);
  for (const row of model.rows) {
    laneDepths[row.laneIndex]?.push(usableDepth(row.depth));
  }
  const laneRanks = laneDepths.map((depths) => rankLaneDepths(depths));

  const laneStack = layoutLaneStack(laneRanks.map((rank) => rank.rowCount));

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

  const unlabelled: UnlabelledBar[] = model.rows.map((row) => {
    const lane = lanes[row.laneIndex];
    // Every depth was ranked above; the fallback is the compiler's reassurance.
    const laneRow = laneRanks[row.laneIndex]?.rowOf.get(usableDepth(row.depth)) ?? 0;
    const depthRow = layoutDepth(laneRow);
    const placement = placeSpanDuration(row.startTime, row.durationMs, scale);

    const height = clamp(depthRow.height - BAR_INSET * 2, MIN_BAR_HEIGHT, depthRow.height);
    const y = (lane?.y ?? AXIS_BAND_HEIGHT) + depthRow.y + BAR_INSET;

    return {
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
    };
  });

  // Every bar is placed before any is labelled, because a label must keep clear
  // of the bars that come after it on its row as well as those before it.
  const bars = labelBars(unlabelled, frame);

  // The first bar carrying a span — a span id inside its own trace, the key
  // `traceSpanKey` builds — answers a parent lookup, so a colliding span id in
  // another trace on the same page never receives a connector. The bars are in
  // the model's row order, and on a flat page that is the parent-first walk's
  // order, in which the first record carrying a span is the one that claimed it
  // and had that span's children expanded beneath it. So every connector joins
  // the record its child is drawn under, and a capture holding two records of
  // one span cannot make a connector ambiguous.
  const barsBySpan = new Map<string, BarGeometry>();
  for (const bar of bars) {
    const key = traceSpanKey(bar.row.traceId, bar.row.spanId);
    if (!barsBySpan.has(key)) {
      barsBySpan.set(key, bar);
    }
  }

  const edges: EdgeGeometry[] = [];
  for (const bar of bars) {
    const parentSpanId = bar.row.parentSpanId;
    if (parentSpanId === undefined) {
      continue;
    }

    const parent = barsBySpan.get(traceSpanKey(bar.row.traceId, parentSpanId));
    if (parent === undefined || parent === bar) {
      // The parent is not on screen — not on this page, or above the walk's
      // bound. The row is still drawn; only the connector is absent, because a
      // line to nowhere would assert a relationship the reader cannot check.
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

  return { scale, lanes, bars, edges, ticks, width, height };
}

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

/** The badge tone each span status reads in. */
const STATUS_TONES: Readonly<Record<TelemetryStatus, BadgeTone>> = Object.freeze({
  unset: 'neutral',
  ok: 'success',
  error: 'danger',
});

/** The tone for `status`, neutral for a status outside this build's vocabulary. */
function statusToneFor(status: TelemetryStatus): BadgeTone {
  const tone: BadgeTone | undefined = STATUS_TONES[status];

  return tone ?? 'neutral';
}

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
 * What the pipeline recorded about how this row joined its trace, and where
 * this view could not place it under its parent, as a sentence — or nothing,
 * when it joined the ordinary way and is drawn under its parent.
 *
 * The dashed edge, the orphan mark and the "Parent not loaded" flag are visual
 * signals, and a visual signal is never the only signal: everything they mean
 * is also stated here, in the row's description and its detail strip. The
 * other candidates of an ambiguous attribution are named through `spanNames`
 * (see {@link candidateText}).
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
  if (row.lineage !== undefined) {
    notes.push(`Attributed across an asynchronous boundary (${row.lineage}).`);
  }
  if (row.lineageAmbiguous) {
    notes.push(
      row.lineageCandidates.length === 0
        ? 'More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty.'
        : `More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty; the others were ${row.lineageCandidates
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
 * and truncated and are rendered exactly as given (AAP 0.5.2).
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

  return note === undefined ? sentence : `${sentence} ${note}`;
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

/** A `style` object that may carry this package's component-scoped properties. */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/** What {@link TimelineCanvas} draws. */
interface TimelineCanvasProps {
  /** The positioned lanes, bars, edges and ticks. */
  readonly geometry: TimelineGeometry;
  /**
   * Whether the geometry was laid out at the viewport's measured width, in
   * which case the canvas is drawn at that size in CSS pixels; otherwise it is
   * the unmeasured fallback, scaled to its container.
   */
  readonly measured: boolean;
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
  /** The canvas's text alternative. */
  readonly label: string;
}

/**
 * The SVG: lane bands, the axis over them, the connectors, then the bars.
 *
 * Paint order is the component's responsibility — SVG paints in document order
 * and `z-index` does not apply — so the groups are written in the order they
 * must be painted: the bands behind everything, the gridlines over the bands,
 * the connectors under the bars they join, and the bars and their labels last.
 * A label beside its bar is laid on a backdrop in the lane's own surface
 * colour, the bar's height and the label's width plus its inset: a connector
 * or gridline running under the label stops at the backdrop's edges instead of
 * showing through the spaces between its words, which the label's halo cannot
 * cover — a halo outlines glyphs, and a space has none. Its inset is narrower
 * than the `BAR_LABEL_GAP` every label keeps from every bar, so it never
 * covers one.
 *
 * The canvas is `role="img"` with a text alternative, so its bars are not in
 * the accessibility tree and deliberately not focusable: a tab stop with no
 * accessible name is worse than none. The keyboard-reachable representation of
 * exactly these rows is the table the parent renders below it.
 */
function TimelineCanvas(props: TimelineCanvasProps): ReactElement {
  const { geometry, measured, origin, spanNames, selectedEventId, onSelect, onHover, label } =
    props;
  const gridlineEnd = geometry.height - CANVAS_BOTTOM_PADDING;
  const tickCount = geometry.ticks.length;

  return (
    // Measured, the canvas is `geometry.width` CSS pixels wide with a viewBox
    // of the same size: one user unit per pixel, nothing scaled, and the
    // default `preserveAspectRatio` has no ratio to reconcile. Unmeasured (no
    // layout), the fallback width is scaled uniformly to the container — see
    // this module's header.
    <svg
      className="dg-timeline__canvas"
      role="img"
      aria-label={label}
      width={measured ? geometry.width : '100%'}
      height={geometry.height}
      viewBox={`0 0 ${String(geometry.width)} ${String(geometry.height)}`}
      preserveAspectRatio={measured ? undefined : 'xMinYMin meet'}
    >
      <g className="dg-timeline__lanes">
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

      <g className="dg-timeline__axis">
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

      <g>
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
              onClick={() => {
                onSelect(bar.row);
              }}
              onPointerEnter={() => {
                onHover(bar.row.eventId);
              }}
            >
              {/* The user agent's own tooltip, kept for the pointer. The same
                  sentence is author-rendered in the detail strip, which the
                  pointer can reach and Escape dismisses, and in the table row's
                  description, which keyboard focus opens. */}
              <title>{describeBar(bar.row, origin, spanNames)}</title>
            </rect>
            {bar.label === undefined || bar.label.placement === 'inside' ? null : (
              <rect
                className="dg-timeline__bar-label-backdrop"
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
 * The **lead run** — the lead word, the kind and tier badges, and the name with
 * its description — is what identifies the span, so it is laid out first and
 * keeps its width; on a narrow panel only the name gives way, truncating. The
 * **trailing run** — the duration, the offset, the status, the source chip and
 * the lineage note — takes what width is left and is clipped at the strip's
 * inline end rather than wrapped (`dg-timeline__detail-rest`). The name's
 * description bubble opens from the lead run, which clips nothing, so it is
 * never cut off by the strip however narrow the panel is.
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
      </Stack>
      <div className="dg-timeline__detail-rest">
        <Stack direction="horizontal" gap={2} align="center">
          <DurationCell ms={row.durationMs} severity="auto" size="sm" />
          <Text size="sm" tone="secondary" numeric>
            {formatOffset(row.startTime, origin)}
          </Text>
          <Badge variant="soft" tone={statusToneFor(row.status)}>
            {formatStatusLabel(row.status)}
          </Badge>
          {/* Out of the tab order: the same chip is one arrow key into the
              row's own Source cell, and this one may sit in the clipped part of
              the run on a narrow panel, where focus would land on a control the
              reader cannot see. It stays a real control for the pointer. */}
          {row.source === undefined ? null : (
            <SourceLink location={row.source} compact tabIndex={-1} />
          )}
          {note === undefined ? null : (
            <Text size="xs" tone="warning">
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
 * The columns of the tabular equivalent: the fields AAP 0.6.2 says this node
 * reads, in the order a reader scans them.
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
 * Every column has a readable MINIMUM in `ch` of the table's type - the widest
 * kind chip ("Outgoing request"), tier, status, offset and duration figure plus
 * the cell's padding - and a share of the spare width. The table primitive sums
 * those minimums into its floor, so in a narrow panel the equivalent scrolls
 * horizontally instead of squeezing a column to its padding (see
 * `../primitives/DataTable`, `DataTableColumn.width`).
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
      width: 'minmax(28ch, 3fr)',
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
              Re-attached
            </Badge>
          ) : null}
          {row.lineageAmbiguous ? (
            <Badge variant="outline" tone="warning">
              Ambiguous parent
            </Badge>
          ) : null}
          {row.parentNotLoaded ? (
            // Informational rather than a warning: nothing was lost, this view
            // just does not hold the parent (see the module header).
            <Badge variant="outline" tone="info">
              Parent not loaded
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 'minmax(18ch, 1fr)',
      cell: (row) => (
        <Badge variant="soft" color={kindColorVar(row.kind)}>
          {formatKindLabel(row.kind)}
        </Badge>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      width: 'minmax(11ch, 1fr)',
      cell: (row) => (
        <Badge variant="outline" color={tierColorVar(row.tier)}>
          {formatTierLabel(row.tier)}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Reported',
      width: 'minmax(12ch, 1fr)',
      cell: (row) => (
        <Badge variant="soft" tone={statusToneFor(row.status)}>
          {formatStatusLabel(row.status)}
        </Badge>
      ),
    },
    {
      key: 'offset',
      header: 'Offset',
      align: 'end',
      width: 'minmax(12ch, 1fr)',
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
      width: 'minmax(13ch, 1fr)',
      cell: (row) => <DurationCell ms={row.durationMs} severity="auto" size="sm" />,
    },
    {
      key: 'source',
      header: 'Source',
      width: 'minmax(24ch, 2fr)',
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
 * Only the `spans` source is paged. A `trace` is one correlated tree, drawn
 * whole, and reports its own truncation instead of offering more.
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

/**
 * The footer control that raises a trace walk's row bound by one step. A trace
 * arrives whole, so this shows more of what is already in memory rather than
 * asking the provider for another page.
 */
const SHOW_MORE_SPANS_LABEL = 'Show more spans';

/**
 * The refine route for a trace the correlator bounded, in the words the flame
 * chart uses: nothing more of it is in memory, so no control could show more.
 */
const REFINE_TRUNCATED_TRACE = 'Narrow the query or capture a shorter interaction to see the rest.';

/**
 * The row bound after one "Show more spans": one default step higher, capped
 * at the trace's own node count when that count is larger than the bound in
 * force. A trace whose count cannot be believed still moves by one step, so
 * the control always reveals something the walk left out.
 *
 * @param maxRows The row bound in force.
 * @param nodeCount The trace's own node count.
 * @returns The next row bound.
 */
function nextTraceRowBound(maxRows: number, nodeCount: number): number {
  const stepped = maxRows + DEFAULT_MAX_TRACE_ROWS;
  return nodeCount > maxRows ? Math.min(stepped, nodeCount) : stepped;
}

/**
 * The footer's statement about a trace — or about span pages the service
 * reported no total for, which read as a bare count — the counterpart of a
 * span page's "Showing N of M spans.".
 *
 * A walk stopped at its row bound states N of M, where M is the trace's own
 * node count — or, for a trace whose count cannot be believed, only that these
 * are the first N. A trace the correlator bounded, or whose depth the walk
 * clamped, says that more was captured than this view holds, and the
 * correlator's case adds the refine route.
 *
 * @param model The payload's model.
 * @returns The footer text.
 */
function traceFooterText(model: TimelineModel): string {
  const loaded = model.rows.length;
  const total = model.nodeCount ?? 0;
  const sentences: string[] = [];

  if (!model.walkBounded) {
    sentences.push(`${formatCount(loaded)} spans shown.`);
  } else if (total > loaded) {
    sentences.push(`${formatCount(loaded)} of ${formatCount(total)} spans shown.`);
  } else {
    sentences.push(`The first ${formatCount(loaded)} spans of this trace are shown.`);
  }

  // Neither the correlator's bound nor the depth bound is lifted by a larger
  // row bound, so each is stated on its own, and the correlator's with the one
  // route that does reach the rest.
  if (model.correlatorTruncated || model.depthClamped) {
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

/** The noun for `count` spans, singular exactly when there is one. */
function spanNoun(count: number): string {
  return count === 1 ? 'span' : 'spans';
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
  // A trace walk's row bound as raised by "Show more spans", tagged with the
  // query it was raised for, like the page accumulator: a changed query reads
  // the default bound again on the render that shows it.
  const [raisedTraceBound, setRaisedTraceBound] = useState<
    { readonly identity: string; readonly maxRows: number } | undefined
  >(undefined);
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
  // rests on a bar arrives. The block is also where a focus handoff after
  // "Show more spans" finds the table's tab stop.
  const blockRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

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
  const maxTraceRows =
    raisedTraceBound !== undefined && raisedTraceBound.identity === queryIdentity
      ? raisedTraceBound.maxRows
      : DEFAULT_MAX_TRACE_ROWS;

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

  const model = useMemo<TimelineModel | undefined>(() => {
    // `undefined` while the trace query is unsettled, failed or inactive, and
    // `null` when it settled with no matching trace — the service's own answer
    // for a capture that collected nothing correlated. Neither is a tree to
    // walk: the model stays undefined, and a settled `null` renders the empty
    // state below, never an error.
    const tree = traceResult.data;
    if (tree !== undefined && tree !== null) {
      return modelFromTrace(tree, maxTraceRows);
    }

    // Every row loaded so far. While a further page is in flight, or after it
    // failed, that is the rows already on screen, which stay there; before the
    // first page settles there is nothing to model and the loading state shows.
    if (spansPage !== undefined || spanRows.length > 0) {
      return modelFromSpans(spanRows);
    }

    return undefined;
  }, [traceResult.data, spansPage, spanRows, maxTraceRows]);

  // The canvas's viewport, observed: its inner width in CSS pixels once it has
  // been laid out (`undefined` before that and wherever there is no layout),
  // and a measure of the bar-label font — `.dg-timeline__bar-label` is set in
  // `--dg-mono-sm`. Called unconditionally, as a hook must be; its ref attaches
  // only when the viewport renders, which is the settled state below.
  const {
    ref: measureViewportRef,
    width: viewportWidth,
    measureText,
  } = useChartCanvas<HTMLDivElement>({ font: 'monoSm' });
  const measured = isMeasuredWidth(viewportWidth);
  const canvasWidth = resolveCanvasWidth(viewportWidth);

  // One element, two readers: the measure above observes the viewport's width,
  // and `viewportRef` is how the hover handlers below ask whether the pointer
  // is still inside it. The callback ref attaches both and detaches both.
  const attachViewport = useCallback(
    (element: HTMLDivElement | null) => {
      viewportRef.current = element;
      const release = measureViewportRef(element);

      return () => {
        viewportRef.current = null;
        release?.();
      };
    },
    [measureViewportRef],
  );

  const geometry = useMemo<TimelineGeometry | undefined>(
    () =>
      model === undefined ? undefined : buildGeometry(model, { width: canvasWidth, measureText }),
    [model, canvasWidth, measureText],
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

  /**
   * Set when "Show more spans" was activated, and read once the rows it asked
   * for have rendered: when the bound now covers the whole trace, the control
   * that held focus has gone, and focus moves to the table's tab stop rather
   * than falling back to the document.
   */
  const focusAfterShowMore = useRef(false);

  const traceNodeCount = model?.nodeCount;
  const handleShowMoreSpans = useCallback((): void => {
    if (traceNodeCount === undefined) {
      return;
    }
    focusAfterShowMore.current = true;
    setRaisedTraceBound({
      identity: queryIdentity,
      maxRows: nextTraceRowBound(maxTraceRows, traceNodeCount),
    });
  }, [maxTraceRows, queryIdentity, traceNodeCount]);

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
    block.querySelector<HTMLElement>('.dg-timeline__equivalent [tabindex="0"]')?.focus();
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
              ? `${formatCount(0)} spans shown.`
              : `Showing ${formatCount(0)} of ${formatCount(knownTotal)} spans.`}
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
    const windowMs = model.endTime - model.startTime;
    const loaded = model.rows.length;
    // Only a span result reports a total; a trace states its own truncation.
    const total = source === 'spans' ? knownTotal : undefined;
    // Offered only while the service names a next page. A total larger than
    // what is loaded is stated in the footer and marked as partial, but never
    // taken to mean that a further page exists.
    const canLoadMore = nextPageOffset !== undefined;
    const partial =
      model.truncated ||
      canLoadMore ||
      appending ||
      pageFailed ||
      (total !== undefined && loaded < total);

    // The selection is what the strip shows; the pointer, then keyboard focus,
    // preview another row in its place while they rest on it and until Escape
    // dismisses them (see the three rows resolved above the handlers).
    const detailRow = hoveredRow ?? focusedRow ?? selectedRow;
    const previewing = detailRow !== undefined && detailRow !== selectedRow;

    // A walk stopped at its row bound says so in the picture's own words, as the
    // flame chart's does: the subset and the trace it was drawn from.
    const traceTotal = model.walkBounded ? model.nodeCount : undefined;
    const drawnCount =
      traceTotal !== undefined && traceTotal > loaded
        ? `${formatCount(loaded)} of ${formatCount(traceTotal)}`
        : formatCount(loaded);
    const canvasLabel = `${CATALOG_ENTRY.label}: ${drawnCount} spans in ${formatCount(
      model.tiers.length,
    )} tier lanes over ${formatDuration(
      windowMs,
    )}. The table below lists every span with its kind, tier, offset and duration.`;

    const footerText =
      total === undefined
        ? traceFooterText(model)
        : `Showing ${formatCount(loaded)} of ${formatCount(total)} spans.`;

    content = (
      <>
        <Toolbar
          className="dg-timeline__toolbar"
          label="Timeline summary"
          compact
          wrap
          status={[
            { label: `${formatCount(loaded)} spans`, variant: 'soft' },
            { label: `${formatCount(model.tiers.length)} tiers`, variant: 'soft' },
            { label: `${formatDuration(windowMs)} elapsed`, variant: 'soft' },
            ...(partial
              ? [{ label: 'Partial result', tone: 'warning' as const, variant: 'outline' as const }]
              : []),
          ]}
        />

        <div ref={attachViewport} className="dg-timeline__viewport">
          <TimelineCanvas
            geometry={geometry}
            measured={measured}
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
            caption={`${node.title ?? CATALOG_ENTRY.label}: every captured span of this interaction, with its kind, tier, offset and duration.`}
            rows={model.rows}
            columns={timelineColumns(model.startTime, revealedEventId, spanNames)}
            rowKey={rowKeyOf}
            selectedRowKey={selectedRow === undefined ? null : rowKeyOf(selectedRow)}
            onRowActivate={handleSelect}
            compact
          />
        </div>

        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
          {/* Polite and live, so the count a further page or a larger bound
              reveals is announced; never `role="status"`, which is the
              loading placeholder's. */}
          <Text size="xs" tone="muted" aria-live="polite">
            {footerText}
          </Text>
          {model.walkBounded ? (
            // A trace is in memory whole, so this raises the walk's row bound
            // by one step instead of asking the provider for a page.
            <Button variant="secondary" size="sm" onClick={handleShowMoreSpans}>
              {SHOW_MORE_SPANS_LABEL}
            </Button>
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
