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
 * A row's full description — the sentence a bar carries as its SVG title — is
 * keyboard-reachable too, because a tooltip opens on focus and an unfocusable
 * trigger would make it hover-only. Two routes lead to it, and neither adds a
 * tab stop to every row. The row that holds focus drives the detail strip above
 * the table, whose name is a focusable tooltip trigger reached by Shift+Tab
 * from the row (past the strip's source chip, when the row has one). And
 * the name in that row's own Operation cell becomes a tab stop — in that row
 * only, one Tab from the row itself — while the name in every other row stays
 * out of the tab order, so the body remains the single roving stop the table
 * primitive makes it plus the one trigger of the row being read.
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
 * - A **partial** result says so: a `spans` result reports how much of it is
 *   on screen and, for as long as the service names a next offset, offers the
 *   next page — appended after the rows already drawn, which stay on screen
 *   while it loads and if it fails; a `trace` reports the correlator's own
 *   truncation and the walk's.
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
import type { CSSProperties, FocusEvent as ReactFocusEvent, ReactElement, ReactNode } from 'react';

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
 * What the pipeline recorded about how this row joined its trace, and where
 * this view could not place it under its parent, as a sentence — or nothing,
 * when it joined the ordinary way and is drawn under its parent.
 *
 * The dashed edge, the orphan mark and the "Parent not loaded" flag are visual
 * signals, and a visual signal is never the only signal: everything they mean
 * is also stated here, in the row's description and its detail strip.
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
  /**
   * The row under the pointer; when the pointer is away, the row in the table
   * that holds keyboard focus; and otherwise the selected one.
   */
  readonly row: TimelineBar;
  /** The window start every offset is measured from. */
  readonly origin: number;
}

/**
 * The hovered, focused or selected row, spelled out beside the canvas.
 *
 * This is where a bar's description is readable: the `Tooltip` primitive wraps
 * an HTML element and cannot wrap an SVG shape, so the stylesheet gives this
 * view a slot for it (`dg-timeline__tooltip`) and the bar itself carries the
 * same sentence as its SVG title. Everything the tooltip contract asks for is
 * here — the name, the kind, the tier, the duration, the offset, the status and
 * the lineage notes — and the chip, where the row resolved to a location.
 *
 * The name is the tooltip's trigger, and it is focusable on purpose: the
 * primitive opens on focus, so an unfocusable trigger would leave the full
 * description to pointer users alone. It is named by its own text, and the
 * global `:focus-visible` rule in `../styles/base.css` draws its ring.
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
          <Text size="sm" truncate tabIndex={0}>
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
 * The name in the Operation cell is the trigger of the row's description, and
 * it is a tab stop in exactly one row: the one that holds keyboard focus, one
 * Tab from the row itself. Every other row's name carries no `tabIndex` at all
 * — not `-1`, which would make a click on the name focus the text instead of
 * its row and strand the arrow keys the table answers only on a row — so the
 * table body gains one tab stop, not one per rendered row (see this module's
 * header).
 *
 * @param origin The window start every offset in the table is measured from.
 * @param focusedEventId The row that holds keyboard focus, if any.
 */
function timelineColumns(
  origin: number,
  focusedEventId: string | undefined,
): readonly DataTableColumn<TimelineBar>[] {
  return [
    {
      key: 'name',
      header: 'Operation',
      rowHeader: true,
      width: 'minmax(0, 3fr)',
      cell: (row) => (
        <Stack direction="horizontal" gap={1} align="center" wrap>
          <Tooltip content={describeBar(row, origin)}>
            <Text size="sm" truncate tabIndex={row.eventId === focusedEventId ? 0 : undefined}>
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

/** The row carrying `eventId`, or `undefined` for none or an id not on screen. */
function rowWithId(
  rows: readonly TimelineBar[],
  eventId: string | undefined,
): TimelineBar | undefined {
  return eventId === undefined ? undefined : rows.find((row) => row.eventId === eventId);
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

/** The title of the footer's failure, when the rows above it are still good. */
const PAGE_ERROR_TITLE = 'The next page of spans could not be loaded';

/** The footer failure's message when the provider's error carried none. */
const PAGE_ERROR_MESSAGE =
  'The spans already shown are unaffected; retry to request the page again.';

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
 * selected, hovered and focused rows of the previous provider must not
 * survive into it, so a new provider is a new instance that paints none of
 * them and starts from the authored first page.
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
 * The stateful body of {@link Timeline}: one provider's pages, selection and
 * focus for one node.
 *
 * @param props The props, as documented on {@link TimelineProps}.
 * @returns The chart and its tabular equivalent, or one of the three states.
 */
function TimelineView(props: TimelineProps): ReactElement {
  const { node, className } = props;

  // Read unconditionally, as a hook must be, and `undefined` outside a host by
  // that module's documented contract: a surface with no actions still renders.
  const actions = usePanelActions();

  const [pages, setPages] = useState<PageAccumulator | undefined>(undefined);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(undefined);
  const [hoveredEventId, setHoveredEventId] = useState<string | undefined>(undefined);
  // The row of the equivalent table that holds keyboard focus, while focus is
  // anywhere inside this view: it drives the detail strip and makes that row's
  // name a tab stop (see this module's header).
  const [focusedEventId, setFocusedEventId] = useState<string | undefined>(undefined);

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

  const model = useMemo<TimelineModel | undefined>(() => {
    // `undefined` while the trace query is unsettled, failed or inactive, and
    // `null` when it settled with no matching trace — the service's own answer
    // for a capture that collected nothing correlated. Neither is a tree to
    // walk: the model stays undefined, and a settled `null` renders the empty
    // state below, never an error.
    const tree = traceResult.data;
    if (tree !== undefined && tree !== null) {
      return modelFromTrace(tree);
    }

    // Every row loaded so far. While a further page is in flight, or after it
    // failed, that is the rows already on screen, which stay there; before the
    // first page settles there is nothing to model and the loading state shows.
    if (spansPage !== undefined || spanRows.length > 0) {
      return modelFromSpans(spanRows);
    }

    return undefined;
  }, [traceResult.data, spansPage, spanRows]);

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

  // Follows focus into the equivalent table, wherever in a row it lands. React's
  // `onFocus` bubbles, so one handler on the table's wrapper sees the roving row
  // and every control inside it; focus that lands outside a data row changes
  // nothing.
  const modelRows = model?.rows;
  const handleEquivalentFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>): void => {
      if (modelRows === undefined) {
        return;
      }

      const row = rowHoldingFocus(event.target, event.currentTarget, modelRows);
      if (row !== undefined) {
        setFocusedEventId(row.eventId);
      }
    },
    [modelRows],
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

  const activeResult = source === 'trace' ? traceResult : spansResult;
  const serializedQuery = JSON.stringify(node.query, null, 2);

  // A further span page in flight behind rows already on screen, and one that
  // failed behind them. Both are reported in the footer; neither replaces the
  // chart and table the reader is already reading.
  const appending =
    source === 'spans' && spansResult.status === 'loading' && carriedRows.length > 0;
  const pageFailed = source === 'spans' && spansResult.status === 'error' && carriedRows.length > 0;

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
  } else if (activeResult.status === 'loading' && !appending) {
    content = (
      <div className="dg-timeline__loading">
        <LoadingState variant="chart" label="Loading the correlated timeline…" />
      </div>
    );
  } else if (activeResult.status === 'error' && !pageFailed) {
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

    content = (
      <div className="dg-timeline__empty">
        <EmptyState title={empty.title} message={empty.message} />
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

    // The pointer first, then keyboard focus, then the selection: each is
    // resolved against the rows on screen on its own, so an id that no longer
    // names a row falls through to the next rather than blanking the strip.
    const detailRow =
      rowWithId(model.rows, hoveredEventId) ??
      rowWithId(model.rows, focusedEventId) ??
      rowWithId(model.rows, selectedEventId);

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

        <div className="dg-timeline__equivalent" onFocus={handleEquivalentFocus}>
          <DataTable<TimelineBar>
            id={`${node.id}-rows`}
            caption={`${node.title ?? CATALOG_ENTRY.label}: every captured span of this interaction, with its kind, tier, offset and duration.`}
            rows={model.rows}
            columns={timelineColumns(model.startTime, focusedEventId)}
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
          <div className="dg-timeline__error">
            <ErrorState
              title={PAGE_ERROR_TITLE}
              message={spansResult.error?.message ?? PAGE_ERROR_MESSAGE}
              code={spansResult.error?.code}
              query={JSON.stringify(spansQuery ?? node.query, null, 2)}
              onRetry={spansResult.retry}
            />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={clsx('dg-timeline', className)} onBlur={handleBlockBlur}>
      {content}
    </div>
  );
}
