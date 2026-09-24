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
 * icicle orientation. Depth is the row (`../utils/scale`'s `rowY`), time is the
 * horizontal axis (`timeScaleForTrace` over the trace's own window), so a
 * parent always sits directly above the children it contains and a reader
 * follows causality downward.
 *
 * ## NOTHING IS MEASURED FROM THE DOM
 *
 * The canvas is a fixed logical `viewBox` of {@link CANVAS_WIDTH} user units
 * with a `width="100%"` attribute, so every coordinate is arithmetic over the
 * capture and the browser performs the one scaling step. There is no
 * `getBoundingClientRect`, no `ResizeObserver` and no `offsetWidth` anywhere in
 * this file: a component whose geometry depends on a measurement renders
 * nothing on its first paint, renders nothing at all under a test DOM that
 * reports zeroes, and is untestable in exactly the state a reader most needs it
 * to be right (AAP 0.8.3).
 *
 * ## THE CHART IS AN IMAGE; THE LIST IS THE INTERFACE
 *
 * The `<svg>` is `role="img"` with a text alternative summarising the trace, so
 * assistive technology is told what the picture shows rather than being walked
 * through hundreds of `<rect>` elements. Beneath it, **every frame** appears as
 * a row of an indented list: its name on a real `Button`, its kind, its tier,
 * its measured duration, its own time, a source chip where the span resolved to
 * a place in the project, and a disclosure control where its subtree is folded.
 * That list is the keyboard path, the screen-reader path and the path a test
 * asserts against (AAP 0.6.4 puts accessibility above visual fidelity), and it
 * is complete: a frame the chart draws is a row the list carries, and a frame
 * neither shows is named in a note rather than dropped.
 *
 * ## EVIDENCE IS NEVER DROPPED, AND NEVER QUIETLY
 *
 * The `trace` source answers with a whole {@link TraceTree}, not a page, so
 * there is no "load more" here and no honest way to show part of a trace
 * silently. Every reduction is reported in a note under the chart: a trace the
 * correlator itself truncated, a subtree past the depth this layout draws, a
 * subtree folded for legibility, a record re-attached to the root because its
 * parent never arrived (marked `dg-is-orphan` on its row), a span id the
 * correlator saw twice, and a trace that arrived with more than one root.
 *
 * ## DATA IN, INTENT OUT
 *
 * Data arrives only through the node's `DataQuery`, resolved by `../host/useQuery`
 * against the host's `DataProvider`; interactions leave only through
 * `../host/PanelActions`. This component opens no socket, calls no `fetch` and
 * knows no URL (AAP 0.1.2, 0.4.2). Selecting a frame reports a
 * `PanelEventRef`; a source chip forwards its location field for field;
 * folding a subtree reports `onExpand` with this node's id.
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
 *   `dg-flame__row`               one depth row of the icicle
 *   `dg-flame__frame`             one frame, filled from `--dgc-frame-color`
 *   `dg-flame__frame-label`       the label drawn inside a frame
 *   `dg-flame__equivalent`        the text equivalent, a list
 *   `dg-flame__equivalent-row`    one frame's row, indented by `--dgc-depth`
 *   `dg-flame__tooltip`           the slot a row's tooltip is positioned in
 *   `dg-is-selected`              the selected frame and its row
 *   `dg-is-orphan`                a re-attached record (the canonical state name)
 *
 * @see ../utils/scale for every coordinate: the time scale, the depth layout,
 * the bounded traversal and the axis ticks.
 * @see ../host/PanelActions for the interaction contract.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type { DataQuery, FlameNode } from '@debuggen/panel-schema';
import { PANEL_NODE_CATALOG } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { clampNonNegative, roundMs } from '@debuggen/shared';
import type {
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { kindColorVar } from '../utils/color';
import {
  formatCount,
  formatDuration,
  formatKindLabel,
  formatStatusLabel,
  formatTierLabel,
  truncate,
} from '../utils/format';
import {
  alignHairline,
  flattenTraceRows,
  generateAxisTicks,
  heightForMaxDepth,
  placeSpanDuration,
  rowY,
  timeScaleForTrace,
} from '../utils/scale';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * Every constant below is in SVG user units, the permitted structural form of
 * AAP 0.6.4 — not a CSS length, not a device pixel and not a design token. The
 * vertical rhythm itself is NOT restated here: row height and row gutter come
 * from `../utils/scale`, so this view shares one pitch with the timeline and
 * the waterfall.
 * ---------------------------------------------------------------------------
 */

/**
 * The canvas's logical width in user units: 1 000.
 *
 * The `viewBox` is fixed and the `width` attribute is relational, so this
 * number is a coordinate space rather than a size: a frame occupying a tenth of
 * the trace is 100 units wide whatever the panel's real width turns out to be.
 * One thousand divides the sub-percent durations of a fast capture without
 * collapsing them and keeps every coordinate well inside a float's exact range.
 */
const CANVAS_WIDTH = 1000;

/** The band the time axis occupies above the first depth row, in user units. */
const AXIS_BAND_HEIGHT = 16;

/** How far a tick rule rises from the axis baseline, in user units. */
const AXIS_TICK_LENGTH = 4;

/** The baseline a tick label sits on, in user units. */
const AXIS_LABEL_BASELINE = AXIS_BAND_HEIGHT - AXIS_TICK_LENGTH - 2;

/** The inset between a frame's edge and its label, in user units. */
const LABEL_INSET = 4;

/**
 * The advance of one character of the monospace label role, in user units.
 *
 * An estimate, and deliberately a generous one: the label is truncated to the
 * budget this yields, so over-estimating drops a character that would have fit
 * while under-estimating paints text over a frame's edge. The alternative —
 * measuring the text — is the DOM measurement this component does not do.
 */
const LABEL_CHAR_ADVANCE = 6;

/** The narrowest frame that carries a label at all, in user units. */
const MIN_LABEL_WIDTH = 32;

/** The fewest characters worth drawing inside a frame. */
const MIN_LABEL_CHARS = 3;

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

/** How many of a frame's nearest ancestors its detail names. */
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

/** The error state's message for a failed query. */
const ERROR_MESSAGE = 'The nested timing for this view could not be loaded.';

/**
 * The error state's message for a node or a non-null payload this view cannot
 * draw. A `null` trace is never one: it is the empty state's case.
 */
const MISMATCH_MESSAGE =
  'This view reads a correlated trace and received something else, so it was not drawn. The panel it belongs to needs regenerating.';

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
  /** Whether this frame's subtree can be folded — it has children to fold. */
  readonly foldable: boolean;
  /** Whether this frame's subtree is folded away right now. */
  readonly folded: boolean;
  /** Whether the depth bound, rather than a fold, hid its children. */
  readonly childrenBeyondDepth: boolean;
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
  /** The shown frames grouped by depth, each group a row of the icicle. */
  readonly depthRows: readonly (readonly PlacedFrame[])[];
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
  /** Whether this layout's depth or size bound left frames out. */
  readonly layoutTruncated: boolean;
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
  depthRows: [],
  canvasHeight: AXIS_BAND_HEIGHT,
  ticks: [],
  foldedAway: 0,
  foldCount: 0,
  layoutTruncated: false,
  treeTruncated: false,
  orphanCount: 0,
  rootCount: 0,
  duplicateCount: 0,
  totalDurationMs: 0,
  nodeCount: 0,
  shownDepth: 0,
};

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

/*
 * ---------------------------------------------------------------------------
 * Text
 * ---------------------------------------------------------------------------
 */

/**
 * The query as one line of text, for an error state's detail.
 *
 * Built field by field from the query's own vocabulary rather than serialised
 * wholesale, so the string stays readable and cannot grow to carry a field this
 * view does not use.
 */
function describeQuery(query: DataQuery): string {
  const parts: string[] = [`source=${query.source}`];
  const filter = query.filter;

  if (filter !== undefined) {
    if (filter.traceId !== undefined) {
      parts.push(`traceId=${filter.traceId}`);
    }
    if (filter.kinds !== undefined) {
      parts.push(`kinds=${filter.kinds.join('|')}`);
    }
    if (filter.component !== undefined) {
      parts.push(`component=${filter.component}`);
    }
    if (filter.tier !== undefined) {
      parts.push(`tier=${filter.tier}`);
    }
    if (filter.minDuration !== undefined) {
      parts.push(`minDuration=${String(filter.minDuration)}`);
    }
  }

  if (query.sort !== undefined) {
    parts.push(`sort=${query.sort}`);
  }
  if (query.limit !== undefined) {
    parts.push(`limit=${String(query.limit)}`);
  }
  if (query.offset !== undefined) {
    parts.push(`offset=${String(query.offset)}`);
  }

  return parts.join(' ');
}

/** "1 operation" / "4 operations", with the package's own number formatting. */
function pluralOperations(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'operation' : 'operations'}`;
}

/** "1 nested call" / "7 nested calls". */
function pluralNestedCalls(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'nested call' : 'nested calls'}`;
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
    lines.push(`Inside ${frame.ancestry.join(' › ')}`);
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

  return `${heading}: ${pluralOperations(model.frames.length)} nested ${String(levels)} ${
    levels === 1 ? 'level' : 'levels'
  } deep, ${formatDuration(model.totalDurationMs)} from the first to the last.`;
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
 * The threshold is in the layout's own units rather than in device pixels,
 * because nothing here knows how wide a unit will be painted. A bar too narrow
 * for a legible fragment carries no label at all: three characters of an
 * operation's name identify nothing, and text painted past a bar's edge reads
 * as belonging to its neighbour.
 */
function frameLabelText(name: string, width: number): string | undefined {
  if (width < MIN_LABEL_WIDTH) {
    return undefined;
  }

  const budget = Math.floor((width - LABEL_INSET * 2) / LABEL_CHAR_ADVANCE);
  if (budget < MIN_LABEL_CHARS) {
    return undefined;
  }

  return truncate(name, budget);
}

/*
 * ---------------------------------------------------------------------------
 * Derivation
 * ---------------------------------------------------------------------------
 */

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
 * @param tree The resolved trace, read and never mutated.
 * @param folds Which frames the developer has explicitly opened or closed, by
 * frame id; a frame absent from the map takes the default for its depth.
 * @returns The frames, their bars grouped into depth rows, the axis and every
 * count a note is rendered from.
 */
function buildModel(tree: TraceTree | undefined, folds: ReadonlyMap<string, boolean>): FlameModel {
  if (tree === undefined || tree.nodeCount === 0 || tree.roots.length === 0) {
    return EMPTY_MODEL;
  }

  const layout = flattenTraceRows(tree, { maxDepth: MAX_ICICLE_DEPTH });
  const scale = timeScaleForTrace(tree, [0, CANVAS_WIDTH]);
  const axis = generateAxisTicks(scale);

  const frames: FlameFrame[] = [];
  const barsByDepth: PlacedFrame[][] = [];

  /** Every visited row's name and ancestor chain, by row index. */
  const nameByRow: string[] = [];
  const ancestryByRow: (readonly string[])[] = [];

  /** Rows hidden because an ancestor is folded, and rows that are folded. */
  const hiddenRows = new Set<number>();
  const foldedRows = new Set<number>();

  /** Span ids already used as a frame id, so a duplicate cannot collide. */
  const usedSpanIds = new Set<string>();

  let foldedAway = 0;
  let shownDepth = 0;

  for (const row of layout.rows) {
    const { event } = row.node;
    const parentIndex = row.parentRowIndex;
    const parentName = parentIndex === undefined ? undefined : nameByRow[parentIndex];
    const parentAncestry = parentIndex === undefined ? undefined : ancestryByRow[parentIndex];
    const ancestry =
      parentName === undefined
        ? []
        : [...(parentAncestry ?? []), parentName].slice(-MAX_ANCESTRY_NAMES);

    nameByRow[row.rowIndex] = event.name;
    ancestryByRow[row.rowIndex] = ancestry;

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
      foldable,
      folded,
      childrenBeyondDepth: row.childrenTruncated,
    };

    frames.push(frame);
    shownDepth = Math.max(shownDepth, row.depth);

    const geometry = placeSpanDuration(event.startTime, event.duration, scale);
    const placed: PlacedFrame = {
      frame,
      x: geometry.x,
      width: geometry.width,
      y: AXIS_BAND_HEIGHT + rowY(row.depth),
      height: row.height,
      label: frameLabelText(event.name, geometry.width),
    };

    const bucket = barsByDepth[row.depth];
    if (bucket === undefined) {
      barsByDepth[row.depth] = [placed];
    } else {
      bucket.push(placed);
    }
  }

  // Dense by construction — a shown frame's ancestors are all shown, so no
  // depth between the root and the deepest shown row can be empty — and built
  // through a defaulted read so a gap could never become a hole in the array.
  const depthRows: readonly (readonly PlacedFrame[])[] =
    frames.length === 0
      ? []
      : Array.from({ length: shownDepth + 1 }, (_unused, depth) => barsByDepth[depth] ?? []);

  return {
    frames,
    depthRows,
    canvasHeight:
      frames.length === 0 ? AXIS_BAND_HEIGHT : AXIS_BAND_HEIGHT + heightForMaxDepth(shownDepth),
    ticks: axis.ticks,
    foldedAway,
    foldCount: foldedRows.size,
    layoutTruncated: layout.truncated,
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

  if (model.treeTruncated) {
    notes.push(
      'This trace arrived incomplete: the correlator stopped before including everything.',
    );
  }
  if (model.layoutTruncated) {
    notes.push(
      `Deeper than ${String(MAX_ICICLE_DEPTH)} levels, or beyond this view's size bound, is not drawn.`,
    );
  }
  if (model.foldCount > 0) {
    notes.push(
      `${formatCount(model.foldCount)} ${
        model.foldCount === 1 ? 'subtree is' : 'subtrees are'
      } folded, hiding ${pluralOperations(model.foldedAway)}. Expand a row to see them.`,
    );
  }
  if (model.rootCount > 1) {
    notes.push(
      `This trace has ${formatCount(model.rootCount)} roots, so part of it was captured without the work that started it.`,
    );
  }
  if (model.orphanCount > 0) {
    notes.push(
      `${pluralOperations(model.orphanCount)} were re-attached to the trace root because their parent never arrived; each is marked on its row.`,
    );
  }
  if (model.duplicateCount > 0) {
    notes.push(
      `${formatCount(model.duplicateCount)} span ${
        model.duplicateCount === 1 ? 'id was' : 'ids were'
      } recorded more than once in this trace.`,
    );
  }

  return notes;
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
  const { status, data, error, retry } = useQuery(traceQuery);

  /** The frame the developer last activated, for the `dg-is-selected` state. */
  const [selectedFrameId, setSelectedFrameId] = useState<string | undefined>(undefined);

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

  const model = useMemo(() => buildModel(tree, folds), [tree, folds]);

  const handleSelect = useCallback(
    (frame: FlameFrame): void => {
      setSelectedFrameId(frame.frameId);
      // Both hints are supplied because this view holds both: the receiver is
      // spared a lookup and can scope a trace-filtered view immediately.
      actions?.onSelectEvent({
        eventId: frame.eventId,
        spanId: frame.spanId,
        traceId: frame.traceId,
      });
    },
    [actions],
  );

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

  // A node that validated cannot reach this branch, so the copy names the
  // panel rather than asking the developer to do anything: there is no
  // interaction that would fix it and therefore no retry offered.
  if (traceQuery === undefined) {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__error">
          <ErrorState message={MISMATCH_MESSAGE} query={describeQuery(query)} />
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
          <ErrorState
            message={ERROR_MESSAGE}
            code={error?.code}
            query={describeQuery(traceQuery)}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  // Only a non-null payload can be malformed; the service's `null` falls
  // through to the empty state below.
  if (tree === undefined && !emptyCapture) {
    return (
      <div className={clsx('dg-flame', className)}>
        <div className="dg-flame__error">
          <ErrorState message={MISMATCH_MESSAGE} query={describeQuery(traceQuery)} />
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
          <EmptyState message={EMPTY_MESSAGE} />
        </div>
      </div>
    );
  }

  const notes = notesFor(model);
  const listLabel = `${node.title ?? CATALOG_ENTRY.label}: ${pluralOperations(
    model.frames.length,
  )}, innermost last`;

  return (
    <div className={clsx('dg-flame', className)}>
      {notes.map((note) => (
        <Text key={note} as="p" size="xs" tone="muted" className="dg-flame__note">
          {note}
        </Text>
      ))}

      <div className="dg-flame__viewport">
        {/* A picture with a text alternative, deliberately: the rows beneath it
            are the representation a keyboard and a screen reader use, so the
            canvas announces what it shows instead of exposing one node per
            bar (AAP 0.6.4). The `viewBox` is fixed and the width relational,
            so no geometry here depends on a measurement. */}
        <svg
          className="dg-flame__canvas"
          role="img"
          aria-label={canvasTextAlternative(model, node.title)}
          viewBox={`0 0 ${String(CANVAS_WIDTH)} ${String(model.canvasHeight)}`}
          width="100%"
          height={model.canvasHeight}
          preserveAspectRatio="none"
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

          {model.depthRows.map((bars, depth) => (
            // The depth is the row's identity in an icicle, so it is also the
            // key: a fold changes which frames a row holds, never which row a
            // depth is.
            <g className="dg-flame__row" key={depth}>
              {bars.map((bar) => {
                const frameColor: CssVariableStyle = {
                  '--dgc-frame-color': kindColorVar(bar.frame.kind),
                };
                return (
                  <g key={bar.frame.frameId}>
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
                    >
                      <title>{frameTooltipText(bar.frame)}</title>
                    </rect>
                    {bar.label === undefined ? null : (
                      <text
                        className="dg-flame__frame-label"
                        x={bar.x + LABEL_INSET}
                        y={bar.y + bar.height / 2}
                      >
                        {bar.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      {/* The text equivalent: one row per drawn frame, indented by its depth,
          in the same order the canvas draws them. It is the keyboard path and
          the screen-reader path, and it carries every frame the canvas draws —
          anything neither shows is named in a note above. */}
      <ul className="dg-flame__equivalent" aria-label={listLabel}>
        {model.frames.map((frame) => {
          const depthStyle: CssVariableStyle = { '--dgc-depth': String(frame.depth) };
          const selected = frame.frameId === selectedFrameId;
          const provenance = provenanceOf(frame);
          const kindColor = kindColorVar(frame.kind);

          return (
            <li
              key={frame.frameId}
              className={clsx(
                'dg-flame__equivalent-row',
                selected && 'dg-is-selected',
                frame.orphaned && 'dg-is-orphan',
              )}
              style={depthStyle}
              aria-level={frame.depth + 1}
              aria-current={selected ? 'true' : undefined}
            >
              {frame.foldable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-expanded={!frame.folded}
                  aria-label={
                    frame.folded
                      ? `Expand the ${pluralNestedCalls(frame.childCount)} inside ${frame.name}`
                      : `Collapse the ${pluralNestedCalls(frame.childCount)} inside ${frame.name}`
                  }
                  icon={
                    frame.folded ? (
                      <ChevronRight aria-hidden="true" className="dg-icon" />
                    ) : (
                      <ChevronDown aria-hidden="true" className="dg-icon" />
                    )
                  }
                  onClick={() => {
                    handleToggle(frame);
                  }}
                />
              ) : null}

              <Tooltip
                className="dg-flame__tooltip"
                content={
                  <>
                    <Text as="span" size="sm" weight="medium">
                      {frame.name}
                    </Text>{' '}
                    <Badge color={kindColor}>{formatKindLabel(frame.kind)}</Badge>{' '}
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
                          {`inside ${frame.ancestry.join(' › ')}`}
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
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    handleSelect(frame);
                  }}
                >
                  {truncate(frame.name, ROW_NAME_BUDGET)}
                </Button>
              </Tooltip>

              <Badge color={kindColor}>{formatKindLabel(frame.kind)}</Badge>

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
                  {`nested calls below ${String(MAX_ICICLE_DEPTH)} levels are not shown`}
                </Text>
              ) : null}

              {frame.source === undefined ? null : <SourceLink location={frame.source} compact />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
