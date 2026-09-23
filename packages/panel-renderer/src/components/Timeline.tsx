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
 *   response), so every algorithm here works top-down.
 * - `spans` resolves to one PAGE of a flat event list. Order is canonical
 *   (`startTime`, then the producer's own sequence) and depth is derived from
 *   the `parentSpanId` chains that are present IN THAT PAGE. A span whose
 *   parent is simply not on the page is drawn at depth 0 and is **not** called
 *   an orphan: the correlator's `orphaned` flag means "the parent never
 *   arrived at all", which is a different statement, and conflating the two
 *   would invent evidence.
 *
 * ## Nothing here is measured
 *
 * The canvas is a FIXED logical `viewBox` scaled by CSS (`width: 100%`), so
 * the drawing is a pure function of the data: no `getBoundingClientRect`, no
 * `ResizeObserver`, no `offsetWidth`, and therefore an environment with no
 * layout — the component suites, and every first paint — renders exactly what
 * a browser renders. `preserveAspectRatio="xMinYMin meet"` is what keeps that
 * honest: the drawing scales uniformly, so a narrow panel shrinks the whole
 * picture rather than stretching the glyphs of its labels sideways.
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
 * ## Evidence is rendered as it arrives
 *
 * - An **ambiguous** async continuation — more than one settled request had an
 *   open continuation window when the event landed — is drawn with the dashed
 *   edge the stylesheet implements, and its alternative candidate span ids are
 *   named in the row's description. A guessed relationship must never read as
 *   a measured one (AAP 0.4.2).
 * - An **orphan** — a span whose parent never arrived, re-attached to the
 *   trace root — is marked and kept. Dropping it would silently remove real
 *   work from the picture.
 * - A **partial** result says so: the `spans` page reports how much of the
 *   result it holds and offers to load more; a `trace` reports the
 *   correlator's own truncation and the walk's.
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
 *   dg-timeline__row           one span: its bar and the label beside it
 *   dg-timeline__bar
 *   dg-timeline__bar-label
 *   dg-timeline__edge          a parent → child connector
 *   dg-timeline__tooltip       the slot the hovered row's description sits in
 *   dg-timeline__equivalent    the keyboard-reachable table of the same rows
 *   dg-timeline__empty         the three states
 *   dg-timeline__loading
 *   dg-timeline__error
 *   dg-is-selected             states, composed onto a bar or an edge
 *   dg-is-ambiguous
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
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

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
import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '../host/DataProvider';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { kindColorVar, tierColorVar } from '../utils/color';
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
  truncate,
} from '../utils/format';
import {
  DEFAULT_ROW_HEIGHT,
  alignHairline,
  clamp,
  createTimeScale,
  flattenTraceRows,
  generateAxisTicks,
  layoutDepth,
  layoutLaneStack,
  placeSpanDuration,
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
 * so a coordinate has exactly one owner. None of these is a CSS value — no
 * `px`, no `rem`, no colour — and none of them is measured.
 * ---------------------------------------------------------------------------
 */

/** The canvas's logical width. CSS scales it; nothing here reads a real size. */
const VIEW_BOX_WIDTH = 1000;

/** The leading gutter the tier labels occupy, before the time axis begins. */
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
 * The longest a bar's own label may be, in characters.
 *
 * A character bound rather than a measured width: nothing here may measure, and
 * a label that overran would be clipped by the viewport with no indication. The
 * full name is one row away in the table below and in the row's description, so
 * the bound costs nothing.
 */
const MAX_BAR_LABEL_CHARS = 32;

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
  /** Whether rows exist that this model does not hold. */
  readonly truncated: boolean;
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
  };
}

/** One flat event as a bar, at the depth the page's own parent chains imply. */
function barFromEvent(event: TelemetryEvent, depth: number): UnassignedBar {
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
    // absent from THIS PAGE is not an orphan (see this module's header).
    orphaned: readBooleanAttribute(attributes, ORPHANED_ATTRIBUTE),
    orphanReason: undefined,
  };
}

/**
 * The canonical order of a flat page: start, then the producer's own sequence.
 *
 * The same order the correlator establishes (AAP 0.2.3) — two producers can
 * share a millisecond, so the producer and its monotonic counter are what make
 * the order total — with the event id as a final tie-break so that a page
 * containing two records of one instant from one producer still sorts the same
 * way on every render.
 */
function compareSpans(left: TelemetryEvent, right: TelemetryEvent): number {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  if (left.producerId !== right.producerId) {
    return left.producerId < right.producerId ? -1 : 1;
  }
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? -1 : 1;
}

/**
 * The depth of one span, from the parent chains present in the page.
 *
 * Iterative and memoized: the chain is walked upwards collecting the spans
 * whose depth is not known yet, and the depths are then written back down it,
 * so a page of five thousand spans costs one pass rather than one pass per row.
 *
 * Two cases end the walk at depth `0`: a parent that is not in the page — which
 * says nothing about whether the parent ever existed, only that this page does
 * not hold it — and a chain that returns to a span already on the walk, which a
 * well-formed page cannot contain but a corrupted one could. Neither throws,
 * and neither drops a row.
 */
function resolveDepth(
  spanId: string,
  eventsBySpanId: ReadonlyMap<string, TelemetryEvent>,
  depths: Map<string, number>,
): number {
  const known = depths.get(spanId);
  if (known !== undefined) {
    return known;
  }

  const pending: string[] = [];
  const visiting = new Set<string>();
  // The depth of whatever sits above the last pending span. `-1` means "nothing
  // sits above it", which makes that last span a root at depth `0`.
  let anchorDepth = -1;
  let cursor: string | undefined = spanId;

  while (cursor !== undefined) {
    const cached = depths.get(cursor);
    if (cached !== undefined) {
      anchorDepth = cached;
      break;
    }
    if (visiting.has(cursor)) {
      break;
    }

    visiting.add(cursor);
    pending.push(cursor);

    // Annotated, because the loop's assignment below makes the two variables
    // mutually dependent and an inferred type here would be circular (TS7022).
    const parentSpanId: string | undefined = eventsBySpanId.get(cursor)?.parentSpanId;
    cursor =
      parentSpanId !== undefined && parentSpanId !== cursor && eventsBySpanId.has(parentSpanId)
        ? parentSpanId
        : undefined;
  }

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const entry = pending[index];
    if (entry === undefined) {
      continue;
    }
    anchorDepth += 1;
    depths.set(entry, anchorDepth);
  }

  return depths.get(spanId) ?? 0;
}

/** The bound the trace walk runs under. */
function traceWalkOptions(tree: TraceTree): TraceLayoutOptions | undefined {
  // The tree's own greatest depth bounds the walk. It is honoured only when it
  // is a usable positive integer: a stored tree reporting `0` while its roots
  // carry children would otherwise have every child left unvisited, and hiding
  // captured work is the one thing this walk may not do. Absent, the walk uses
  // the layout module's own bound.
  return Number.isInteger(tree.maxDepth) && tree.maxDepth > 0
    ? { maxDepth: tree.maxDepth }
    : undefined;
}

/** A correlated trace as rows: the children-only walk, in tree order. */
function modelFromTrace(tree: TraceTree): TimelineModel {
  const layout = flattenTraceRows(tree, traceWalkOptions(tree));
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

  return {
    rows,
    tiers,
    startTime,
    endTime,
    // Both truncations matter and they are different statements: the correlator
    // may have dropped nodes before this view saw the tree, and this walk may
    // have stopped at its own bound.
    truncated: tree.truncated || layout.truncated,
  };
}

/** One page of a flat span list as rows, ordered canonically and depth-derived. */
function modelFromSpans(events: readonly TelemetryEvent[]): TimelineModel {
  const ordered = [...events].sort(compareSpans);

  const eventsBySpanId = new Map<string, TelemetryEvent>();
  for (const event of ordered) {
    // First occurrence wins. A capture can legitimately hold two records under
    // one span id (a trace reports them as `duplicateSpanIds`), and a parent
    // lookup has to resolve to one of them deterministically.
    if (!eventsBySpanId.has(event.spanId)) {
      eventsBySpanId.set(event.spanId, event);
    }
  }

  const depths = new Map<string, number>();
  const bars = ordered.map((event) =>
    barFromEvent(event, resolveDepth(event.spanId, eventsBySpanId, depths)),
  );
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
  };
}

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * One pure function of the model, so the canvas is reproducible and nothing has
 * to be measured. Every number below comes out of `../utils/scale`: the
 * time-to-pixel map, a bar's offset and width with its minimum visible width
 * and its edge clipping, the lane stack, the depth rhythm and the axis ticks.
 * Re-deriving any of that here would give the product two timelines that
 * disagree slightly.
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
  /** How many depth rows the lane holds. */
  readonly rowCount: number;
}

/** One span's bar, its label and the paint it carries. */
interface BarGeometry {
  /** The row this bar draws. */
  readonly row: TimelineBar;
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
  /** The text drawn beside the bar: the name, shortened, and the duration. */
  readonly label: string;
  /** Where that text starts (or ends, when it is anchored at its end). */
  readonly labelX: number;
  /** Which side of {@link labelX} the text occupies. */
  readonly labelAnchor: 'start' | 'end';
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
  /** The canvas's logical height. */
  readonly height: number;
}

/** The text drawn beside a bar: a shortened name and the duration. */
function barLabelFor(row: TimelineBar): string {
  const name = truncate(collapseWhitespace(row.name), MAX_BAR_LABEL_CHARS);

  return `${name}${BAR_LABEL_SEPARATOR}${formatDurationCompact(row.durationMs)}`;
}

/** A depth read defensively: a value that is not a non-negative integer is a root. */
function usableDepth(depth: number): number {
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/** Turns the model into the canvas, with no measurement and no mutation. */
function buildGeometry(model: TimelineModel): TimelineGeometry {
  const scale = createTimeScale(
    [model.startTime, model.endTime],
    [LANE_LABEL_WIDTH, VIEW_BOX_WIDTH - CANVAS_RIGHT_GUTTER],
  );

  // Depth is what places a row inside its lane: a lane holds a contiguous slice
  // of the tree's depth range, so the slice is normalised to its own first depth
  // and a lane that begins six levels down still starts at its own first row
  // instead of reserving six empty ones.
  const laneFirstDepth: number[] = [];
  const laneRowCounts: number[] = [];

  for (const [index] of model.tiers.entries()) {
    laneFirstDepth[index] = Number.POSITIVE_INFINITY;
    laneRowCounts[index] = 0;
  }
  for (const row of model.rows) {
    const depth = usableDepth(row.depth);
    const first = laneFirstDepth[row.laneIndex];
    laneFirstDepth[row.laneIndex] = Math.min(first ?? depth, depth);
  }
  for (const row of model.rows) {
    const depth = usableDepth(row.depth);
    const first = laneFirstDepth[row.laneIndex] ?? depth;
    const rows = laneRowCounts[row.laneIndex] ?? 0;
    laneRowCounts[row.laneIndex] = Math.max(rows, depth - first + 1);
  }

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

  const midpoint = (scale.rangeStart + scale.rangeEnd) / 2;

  const bars: BarGeometry[] = model.rows.map((row) => {
    const lane = lanes[row.laneIndex];
    const depth = usableDepth(row.depth);
    const first = laneFirstDepth[row.laneIndex] ?? depth;
    const depthRow = layoutDepth(depth - first);
    const placement = placeSpanDuration(row.startTime, row.durationMs, scale);

    const height = clamp(depthRow.height - BAR_INSET * 2, MIN_BAR_HEIGHT, depthRow.height);
    const y = (lane?.y ?? AXIS_BAND_HEIGHT) + depthRow.y + BAR_INSET;

    // A label sits after the bar while there is room for it and before the bar
    // once the bar has passed the middle of the window. That is a decision made
    // from the bar's own position rather than from a measured text width, which
    // is what keeps it identical in a browser and in an environment with no
    // layout — and the bound below keeps the text inside the viewport, since an
    // SVG clips to its viewBox and a label outside it would simply vanish.
    const labelAfter = placement.end <= midpoint;

    return {
      row,
      x: placement.x,
      width: placement.width,
      end: placement.end,
      y,
      height,
      centerY: y + height / 2,
      color: kindColorVar(row.kind),
      label: barLabelFor(row),
      labelX: clamp(
        labelAfter ? placement.end + BAR_LABEL_GAP : placement.x - BAR_LABEL_GAP,
        0,
        VIEW_BOX_WIDTH,
      ),
      labelAnchor: labelAfter ? 'start' : 'end',
      minWidthApplied: placement.minWidthApplied,
    };
  });

  // The first bar carrying a span id answers a parent lookup, matching the
  // first-occurrence rule the flat payload resolves parents under, so a capture
  // holding two records of one span id cannot make a connector ambiguous.
  const barsBySpanId = new Map<string, BarGeometry>();
  for (const bar of bars) {
    if (!barsBySpanId.has(bar.row.spanId)) {
      barsBySpanId.set(bar.row.spanId, bar);
    }
  }

  const edges: EdgeGeometry[] = [];
  for (const bar of bars) {
    const parentSpanId = bar.row.parentSpanId;
    if (parentSpanId === undefined) {
      continue;
    }

    const parent = barsBySpanId.get(parentSpanId);
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
      orphaned: bar.row.orphaned,
    });
  }

  const ticks = generateAxisTicks(scale, { origin: model.startTime }).ticks;
  const height = Math.max(
    AXIS_BAND_HEIGHT + laneStack.height + CANVAS_BOTTOM_PADDING,
    AXIS_BAND_HEIGHT + DEFAULT_ROW_HEIGHT + CANVAS_BOTTOM_PADDING,
  );

  return { scale, lanes, bars, edges, ticks, height };
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
 * What the pipeline recorded about how this row joined its trace, as a
 * sentence — or nothing, when it joined the ordinary way.
 *
 * The dashed edge and the orphan mark are visual signals, and a visual signal
 * is never the only signal: everything they mean is also stated here, in the
 * row's description and its detail strip.
 */
function lineageNoteFor(row: TimelineBar): string | undefined {
  const notes: string[] = [];

  if (row.orphaned) {
    notes.push(
      row.orphanReason === undefined
        ? 'Re-attached to the root: this span names a parent that never arrived.'
        : `Re-attached to the root (${row.orphanReason}): the parent this span names never arrived.`,
    );
  }
  if (row.lineage !== undefined) {
    notes.push(`Attributed across an asynchronous boundary (${row.lineage}).`);
  }
  if (row.lineageAmbiguous) {
    notes.push(
      row.lineageCandidates.length === 0
        ? 'More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty.'
        : `More than one parent was possible, so this attribution is the most recently settled candidate rather than a certainty; the others were ${row.lineageCandidates.join(', ')}.`,
    );
  }

  return notes.length === 0 ? undefined : notes.join(' ');
}

/**
 * One row as a sentence: what it is, which tier it ran on, how long it took,
 * when it started relative to the window, how it reported and what the
 * pipeline had to infer about its position.
 *
 * Used for the bar's own description and for the tooltip on the row's name, so
 * the two cannot drift apart. Values arrive redacted and truncated and are
 * rendered exactly as given (AAP 0.5.2).
 */
function describeBar(row: TimelineBar, origin: number): string {
  const sentence = `${row.name} — ${formatKindLabel(row.kind)}, ${formatTierLabel(
    row.tier,
  )} tier, ${formatDuration(row.durationMs)} at ${formatOffset(
    row.startTime,
    origin,
  )}. Reported: ${formatStatusLabel(row.status)}.`;
  const note = lineageNoteFor(row);

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
  /** The window the offsets in the bars' descriptions are measured from. */
  readonly origin: number;
  /** The row currently selected, so its bar carries the selected state. */
  readonly selectedEventId: string | undefined;
  /** Raised when a bar is activated with a pointer. */
  readonly onSelect: (row: TimelineBar) => void;
  /** Raised with the row under the pointer, or `undefined` when it leaves. */
  readonly onHover: (eventId: string | undefined) => void;
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
 *
 * The canvas is `role="img"` with a text alternative, so its bars are not in
 * the accessibility tree and deliberately not focusable: a tab stop with no
 * accessible name is worse than none. The keyboard-reachable representation of
 * exactly these rows is the table the parent renders below it.
 */
function TimelineCanvas(props: TimelineCanvasProps): ReactElement {
  const { geometry, origin, selectedEventId, onSelect, onHover, label } = props;
  const gridlineEnd = geometry.height - CANVAS_BOTTOM_PADDING;
  const tickCount = geometry.ticks.length;

  return (
    <svg
      className="dg-timeline__canvas"
      role="img"
      aria-label={label}
      width="100%"
      height={geometry.height}
      viewBox={`0 0 ${String(VIEW_BOX_WIDTH)} ${String(geometry.height)}`}
      preserveAspectRatio="xMinYMin meet"
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
                width={VIEW_BOX_WIDTH}
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
                x={clamp(tick.offset, 0, VIEW_BOX_WIDTH)}
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
              onPointerLeave={() => {
                onHover(undefined);
              }}
            >
              <title>{describeBar(bar.row, origin)}</title>
            </rect>
            <text
              className="dg-timeline__bar-label"
              x={bar.labelX}
              y={bar.centerY}
              textAnchor={bar.labelAnchor}
            >
              {bar.label}
            </text>
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
  /** The row under the pointer, or the selected one when the pointer is away. */
  readonly row: TimelineBar;
  /** The window start every offset is measured from. */
  readonly origin: number;
}

/**
 * The hovered or selected row, spelled out beside the canvas.
 *
 * This is where a bar's description is readable: the `Tooltip` primitive wraps
 * an HTML element and cannot wrap an SVG shape, so the stylesheet gives this
 * view a slot for it (`dg-timeline__tooltip`) and the bar itself carries the
 * same sentence as its SVG title. Everything the tooltip contract asks for is
 * here — the name, the kind, the tier, the duration, the offset, the status and
 * the lineage notes — and the chip, where the row resolved to a location.
 */
function TimelineDetail(props: TimelineDetailProps): ReactElement {
  const { row, origin } = props;
  const note = lineageNoteFor(row);

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap>
      <Badge variant="soft" color={kindColorVar(row.kind)}>
        {formatKindLabel(row.kind)}
      </Badge>
      <Badge variant="outline" color={tierColorVar(row.tier)}>
        {formatTierLabel(row.tier)}
      </Badge>
      <div className="dg-timeline__tooltip">
        <Tooltip content={describeBar(row, origin)}>
          <Text size="sm" truncate>
            {row.name}
          </Text>
        </Tooltip>
      </div>
      <DurationCell ms={row.durationMs} severity="auto" size="sm" />
      <Text size="sm" tone="secondary" numeric>
        {formatOffset(row.startTime, origin)}
      </Text>
      <Badge variant="soft" tone={statusToneFor(row.status)}>
        {formatStatusLabel(row.status)}
      </Badge>
      {row.source === undefined ? null : <SourceLink location={row.source} compact />}
      {note === undefined ? null : (
        <Text size="xs" tone="warning">
          {note}
        </Text>
      )}
    </Stack>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The keyboard-reachable equivalent
 * ---------------------------------------------------------------------------
 */

/**
 * The columns of the tabular equivalent: the fields AAP 0.6.2 says this node
 * reads, in the order a reader scans them.
 *
 * A row's location is handed to `SourceLink` BY REFERENCE and field for field —
 * not copied, not normalised, not rounded — because the object the chip raises
 * is the object the editor opens (see that module). The chip is a real control,
 * and the table primitive does not treat a click inside one as a row
 * activation, so opening a file never also selects the span.
 *
 * @param origin The window start every offset in the table is measured from.
 */
function timelineColumns(origin: number): readonly DataTableColumn<TimelineBar>[] {
  return [
    {
      key: 'name',
      header: 'Operation',
      rowHeader: true,
      width: 'minmax(0, 3fr)',
      cell: (row) => (
        <Stack direction="horizontal" gap={1} align="center" wrap>
          <Tooltip content={describeBar(row, origin)}>
            <Text size="sm" truncate>
              {row.name}
            </Text>
          </Tooltip>
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
        </Stack>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 'minmax(0, 1fr)',
      cell: (row) => (
        <Badge variant="soft" color={kindColorVar(row.kind)}>
          {formatKindLabel(row.kind)}
        </Badge>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      width: 'minmax(0, 1fr)',
      cell: (row) => (
        <Badge variant="outline" color={tierColorVar(row.tier)}>
          {formatTierLabel(row.tier)}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Reported',
      width: 'minmax(0, 1fr)',
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
      width: 'minmax(0, 1fr)',
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
      width: 'minmax(0, 1fr)',
      cell: (row) => <DurationCell ms={row.durationMs} severity="auto" size="sm" />,
    },
    {
      key: 'source',
      header: 'Source',
      width: 'minmax(0, 2fr)',
      cell: (row) =>
        row.source === undefined ? (
          <Text size="sm" tone="muted">
            {NOT_AVAILABLE_LABEL}
          </Text>
        ) : (
          <SourceLink location={row.source} compact />
        ),
    },
  ];
}

/** A row's stable key: the event id, which is unique even across duplicate spans. */
function rowKeyOf(row: TimelineBar): string {
  return row.eventId;
}

/*
 * ---------------------------------------------------------------------------
 * Paging
 *
 * A page is grown rather than accumulated: "load more" raises the REQUESTED
 * WINDOW (`limit`) from the query's own offset instead of appending a second
 * page to a list held in state. Two reasons, and the first is decisive:
 * appending would mean writing state when a page settles — that is, from an
 * effect — which this package does not do, and the service orders every paged
 * source under a stable secondary key, so a wider window is a superset of a
 * narrower one and never a reshuffle of it.
 *
 * The page count is held ALONGSIDE the identity of the query it belongs to, so
 * a node whose query changes returns to its first page by derivation during
 * render, with no reset write anywhere.
 * ---------------------------------------------------------------------------
 */

/** How many pages of the current query the reader has asked for. */
interface PageState {
  /** The identity of the query those pages belong to. */
  readonly key: string;
  /** How many pages' worth of rows to request; at least one. */
  readonly pages: number;
}

/** The first page of whatever query arrives first. */
const INITIAL_PAGE: PageState = Object.freeze({ key: '', pages: 1 });

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
 * @example The node a panel carries, rendered inside a host that provides a
 * data provider and the panel actions.
 * ```tsx
 * <Timeline node={node} />
 * ```
 */
export function Timeline(props: TimelineProps): ReactElement {
  const { node, className } = props;

  // Read unconditionally, as a hook must be, and `undefined` outside a host by
  // that module's documented contract: a surface with no actions still renders.
  const actions = usePanelActions();

  const [page, setPage] = useState<PageState>(INITIAL_PAGE);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(undefined);
  const [hoveredEventId, setHoveredEventId] = useState<string | undefined>(undefined);

  const source = node.query.source;

  // The catalog is the authority on which sources this node type can read, and
  // it is consulted rather than restated. A source outside that set is reported
  // as a failure: a grouped or computed result has no per-record position on a
  // shared axis, so there is nothing honest to draw from it.
  const supported = CATALOG_ENTRY.sources.includes(source);

  // The identity of the request, for the page counter above. It is compared and
  // never parsed, and it includes the node's id so two nodes carrying the same
  // query page independently.
  const queryIdentity = `${node.id}|${JSON.stringify(node.query)}`;
  const pages = page.key === queryIdentity ? page.pages : 1;
  const authoredLimit = node.query.limit ?? DATA_QUERY_DEFAULT_LIMIT;
  const requestedLimit = clamp(authoredLimit * pages, authoredLimit, DATA_QUERY_MAX_LIMIT);

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
      ? { ...node.query, source: 'spans', limit: requestedLimit }
      : undefined;

  const traceResult = useQuery(traceQuery);
  const spansResult = useQuery(spansQuery);

  const model = useMemo<TimelineModel | undefined>(() => {
    const tree = traceResult.data;
    if (tree !== undefined) {
      return modelFromTrace(tree);
    }

    const spans = spansResult.data;
    if (spans !== undefined) {
      return modelFromSpans(spans);
    }

    return undefined;
  }, [traceResult.data, spansResult.data]);

  const geometry = useMemo<TimelineGeometry | undefined>(
    () => (model === undefined ? undefined : buildGeometry(model)),
    [model],
  );

  const handleSelect = useCallback(
    (row: TimelineBar): void => {
      setSelectedEventId(row.eventId);
      actions?.onSelectEvent({
        eventId: row.eventId,
        spanId: row.spanId,
        traceId: row.traceId,
      });
    },
    [actions],
  );

  const handleHover = useCallback((eventId: string | undefined): void => {
    setHoveredEventId(eventId);
  }, []);

  const handleLoadMore = useCallback((): void => {
    setPage({ key: queryIdentity, pages: pages + 1 });
  }, [pages, queryIdentity]);

  const activeResult = source === 'trace' ? traceResult : spansResult;
  const serializedQuery = JSON.stringify(node.query, null, 2);

  let content: ReactNode;

  if (!supported) {
    content = (
      <div className="dg-timeline__error">
        <ErrorState
          title="This view cannot draw the requested data"
          message={`A correlated timeline places each record on a shared axis, so it can read only ${CATALOG_ENTRY.sources.join(
            ' or ',
          )}. The panel asked for “${source}”.`}
          query={serializedQuery}
        />
      </div>
    );
  } else if (activeResult.status === 'loading') {
    content = (
      <div className="dg-timeline__loading">
        <LoadingState variant="chart" label="Loading the correlated timeline…" />
      </div>
    );
  } else if (activeResult.status === 'error') {
    content = (
      <div className="dg-timeline__error">
        <ErrorState
          message={activeResult.error?.message ?? 'The correlated timeline could not be loaded.'}
          code={activeResult.error?.code}
          query={serializedQuery}
          onRetry={activeResult.retry}
        />
      </div>
    );
  } else if (model === undefined || geometry === undefined || model.rows.length === 0) {
    content = (
      <div className="dg-timeline__empty">
        <EmptyState
          title="Nothing to place on the axis"
          message="No correlated spans were captured for this interaction."
        />
      </div>
    );
  } else {
    const windowMs = model.endTime - model.startTime;
    const loaded = model.rows.length;
    const total = activeResult.total;
    const morePages =
      activeResult.nextOffset !== undefined || (total !== undefined && loaded < total);
    const canLoadMore = source === 'spans' && morePages && requestedLimit < DATA_QUERY_MAX_LIMIT;
    const partial = model.truncated || morePages;

    const detailRow = model.rows.find((row) => row.eventId === (hoveredEventId ?? selectedEventId));

    const canvasLabel = `${CATALOG_ENTRY.label}: ${formatCount(
      loaded,
    )} spans in ${formatCount(model.tiers.length)} tier lanes over ${formatDuration(
      windowMs,
    )}. The table below lists every span with its kind, tier, offset and duration.`;

    const footerText =
      total === undefined
        ? model.truncated
          ? `${formatCount(loaded)} spans shown. More were captured than this view holds.`
          : `${formatCount(loaded)} spans shown.`
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

        <div className="dg-timeline__viewport">
          <TimelineCanvas
            geometry={geometry}
            origin={model.startTime}
            selectedEventId={selectedEventId}
            onSelect={handleSelect}
            onHover={handleHover}
            label={canvasLabel}
          />
        </div>

        {detailRow === undefined ? null : (
          <TimelineDetail row={detailRow} origin={model.startTime} />
        )}

        <div className="dg-timeline__equivalent">
          <DataTable<TimelineBar>
            id={`${node.id}-rows`}
            caption={`${node.title ?? CATALOG_ENTRY.label}: every captured span of this interaction, with its kind, tier, offset and duration.`}
            rows={model.rows}
            columns={timelineColumns(model.startTime)}
            rowKey={rowKeyOf}
            selectedRowKey={selectedEventId ?? null}
            onRowActivate={handleSelect}
            compact
          />
        </div>

        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
          <Text size="xs" tone="muted">
            {footerText}
          </Text>
          {canLoadMore ? (
            <Button variant="secondary" size="sm" onClick={handleLoadMore}>
              Load more spans
            </Button>
          ) : null}
        </Stack>
      </>
    );
  }

  return <div className={clsx('dg-timeline', className)}>{content}</div>;
}
