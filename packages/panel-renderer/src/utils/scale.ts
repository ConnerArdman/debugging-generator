/**
 * Geometry — the arithmetic behind the four SVG visualizations of this package:
 * `Timeline`, `Waterfall`, `FlameChart` and `DependencyGraph` (AAP 0.6.2,
 * 0.7.1 Group 1, which names them as the components "sharing
 * `utils/scale.ts`").
 *
 * Four views draw the same captured evidence four ways, and every one of them
 * needs the same handful of answers: where in a window does this instant sit,
 * how wide is a span that lasted this long, which row does depth `n` occupy,
 * where do the axis ticks go, and where does a participant of a layered graph
 * belong. Answering those five questions once, here, is what keeps a bar in one
 * view aligned with the same bar in another; four private implementations of a
 * time-to-pixel map would drift the moment one of them rounded differently.
 *
 * ## The renderer does its own traversal
 *
 * `@debuggen/telemetry` is a **type-only** dependency of this package (AAP
 * 0.2.2 lists it as "telemetry (types)"), so none of its runtime helpers — its
 * correlator, its tree walkers, its interval unions, its aggregators — may be
 * imported here, and {@link flattenTraceRows} therefore implements its own walk
 * of the children-only tree. What it must *not* do is re-decide anything the
 * upstream correlator already decided: sibling order is canonical when it
 * arrives (parent before child, then start time, then the producer's sequence,
 * then the store's ingest sequence) and this module preserves it exactly.
 *
 * ## Numbers, never CSS
 *
 * Every value returned from here is a unitless `number` in SVG user units (or
 * milliseconds, where a time is returned), because AAP 0.6.4 permits no
 * hardcoded CSS value anywhere in this package. Nothing here returns a length
 * string, a colour, a class name or a custom-property reference: colour and
 * severity are `./color`'s decisions, text is `./format`'s, and anything that
 * belongs in a stylesheet stays in the stylesheet. The one string this module
 * produces is SVG *path data* ({@link edgePathData}), which is geometry
 * serialised into the one attribute that has no numeric form.
 *
 * ## No non-finite number may escape
 *
 * A single `NaN` in a `<rect x>` or a `<path d>` blanks an entire chart, and a
 * chart that renders nothing is indistinguishable from a capture that found
 * nothing — which is exactly the confusion this product exists to remove. Every
 * division here guards its denominator, every option is sanitised before it is
 * used, and every exported function documents what it does with a degenerate
 * input. The rule is absolute: a caller can pass `NaN`, `Infinity`, an inverted
 * window or a zero-width viewport and still get finite geometry back.
 *
 * ## Layering
 *
 * - `./format` is the **single** permitted sibling import, and only for axis
 *   tick labels ({@link generateAxisTicks}): the axis must read in the same
 *   units, with the same digits, as the table beside it. `./format` imports
 *   nothing from here, so the pair stays acyclic.
 * - `./color` is deliberately **not** imported. Colour is a separate concern,
 *   and an edge from here to it would pull the token graph into every consumer
 *   of a coordinate.
 * - `@debuggen/shared` supplies the two numeric helpers this module refuses to
 *   re-implement: `clampNonNegative` (the product's duration clamp) and
 *   `roundMs` (its single rounding policy).
 * - No platform builtin, no React, no transport, no module-level mutable state.
 *   Importing this module computes nothing; every export is a pure function of
 *   its arguments or a frozen constant, and no input object or array is ever
 *   mutated — the trace structures are shared with other views and are JSON
 *   round-trip safe upstream, which is a property this module keeps.
 *
 * `src/index.ts` does not re-export `./utils`, so this surface is
 * package-internal.
 *
 * @packageDocumentation
 */

import { clampNonNegative, roundMs } from '@debuggen/shared';
import type { SpanId } from '@debuggen/shared';
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
  TelemetryEvent,
  TimelineRow,
  TimelineView,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import { formatDurationCompact } from './format';

/*
 * ---------------------------------------------------------------------------
 * Internal numeric guards
 *
 * The four sanitisers every public entry point funnels its arguments through.
 * They are the mechanical half of the "no non-finite number may escape" rule:
 * a value that cannot be used is replaced by a documented fallback at the
 * boundary, so no arithmetic further in has to ask again.
 * ---------------------------------------------------------------------------
 */

/** `value` when it is a finite number, otherwise `fallback`. */
function asFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `value` when it is finite and strictly positive, otherwise `fallback`. */
function asPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `value` when it is finite and zero or more, otherwise `fallback`. */
function asNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** `value` when it is an integer of zero or more, otherwise `fallback`. */
function asNonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * A duration in milliseconds, made usable: non-finite becomes `0`, negative
 * becomes `0`.
 *
 * `clampNonNegative` is the product's own duration clamp and is what the
 * producers apply, so this module reuses it rather than writing a second one;
 * the finiteness check in front of it exists because that helper maps `NaN` to
 * zero but lets `Infinity` through.
 */
function usableDurationMs(value: number | undefined): number {
  return clampNonNegative(asFinite(value, 0));
}

/*
 * ---------------------------------------------------------------------------
 * Numeric primitives
 * ---------------------------------------------------------------------------
 */

/**
 * Constrains `value` to the inclusive range `[min, max]`.
 *
 * `@debuggen/shared` owns `clampNonNegative` but has no two-bound clamp, so
 * this module owns this one; it is used by every scale, placement and layout
 * function here and is exported because the four SVG components need it for
 * the same reason (pinning a hover position, a brush edge or a label offset
 * into a viewport).
 *
 * Degenerate inputs, all deliberate and all finite:
 *
 * - `min > max` — the bounds are swapped rather than rejected, so a caller that
 *   computed them from a reversed window still gets a value inside the interval
 *   they describe.
 * - a non-finite `value` — `NaN` yields the lower bound (there is no sensible
 *   side to pin it to, and the lower bound is the one that keeps a bar on
 *   screen), while `Infinity` and `-Infinity` pin to the upper and lower bound
 *   respectively, which is what the ordering already implies.
 * - a non-finite bound — replaced by `value` itself, leaving the other bound to
 *   do the constraining.
 *
 * @param value The number to constrain.
 * @param min Lower bound.
 * @param max Upper bound.
 * @returns A finite number in `[min, max]` after the normalisations above.
 */
export function clamp(value: number, min: number, max: number): number {
  const lowerBound = asFinite(min, value);
  const upperBound = asFinite(max, value);
  const lower = Math.min(lowerBound, upperBound);
  const upper = Math.max(lowerBound, upperBound);

  if (Number.isNaN(value)) {
    return lower;
  }

  return Math.min(Math.max(value, lower), upper);
}

/**
 * Where `value` sits between `start` and `end`, as a fraction.
 *
 * The normalisation half of a linear scale, exported on its own because a
 * component occasionally needs the fraction rather than the pixel — an SVG
 * gradient stop, a percentage-width lane, a progress arc.
 *
 * `0` marks `start` and `1` marks `end`; a value outside the interval yields a
 * fraction outside `[0, 1]`, which is information rather than an error, so it is
 * not clamped here. Use {@link clamp} on the result when the caller needs it
 * pinned.
 *
 * Degenerate inputs: a zero-width interval (`start === end`), an inverted one
 * (`end < start`) or any non-finite argument yields `0`. That is the choice
 * that makes a collapsed window draw everything at its left edge instead of
 * dividing by zero.
 *
 * @param value The number to locate.
 * @param start The value that maps to `0`.
 * @param end The value that maps to `1`.
 */
export function normalizeFraction(value: number, start: number, end: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }

  const span = end - start;
  if (span <= 0) {
    return 0;
  }

  return (value - start) / span;
}

/**
 * The inverse of {@link normalizeFraction}: the value `fraction` of the way
 * from `start` to `end`.
 *
 * Linear interpolation, and the second half of every scale here. A fraction
 * outside `[0, 1]` extrapolates rather than clamping, for the same reason as
 * above.
 *
 * Degenerate inputs: a non-finite `fraction` yields `start`; a non-finite bound
 * is replaced by the other bound, so the result is always finite. A zero-width
 * interval yields `start`, which is the only value it contains.
 *
 * @param fraction `0` for `start`, `1` for `end`.
 * @param start The value at fraction `0`.
 * @param end The value at fraction `1`.
 */
export function interpolate(fraction: number, start: number, end: number): number {
  const from = asFinite(start, asFinite(end, 0));
  const to = asFinite(end, from);
  const ratio = asFinite(fraction, 0);

  return from + (to - from) * ratio;
}

/**
 * Rounds a pixel coordinate to a whole SVG user unit.
 *
 * Not applied by this module's placement functions — they return fractional
 * pixels on purpose (see {@link SpanGeometry}) — and exported for the cases
 * where a component genuinely wants integers: an icicle row's height, a
 * container's declared size, a scroll offset it compares against a row index.
 *
 * A non-finite input yields `0` rather than propagating.
 */
export function roundPixels(value: number): number {
  return Math.round(asFinite(value, 0));
}

/**
 * Offsets a coordinate onto the half-pixel grid, so a one-unit stroke renders
 * as one crisp line instead of two half-intensity ones.
 *
 * For the axis rules, lane separators and gridlines of `Timeline`, `Waterfall`
 * and `FlameChart`. It applies to *strokes*, which straddle their coordinate;
 * filled geometry (every span bar) must not use it, because a bar's edge is its
 * boundary rather than its centre.
 *
 * A non-finite input yields `0.5`, the aligned form of the origin.
 */
export function alignHairline(value: number): number {
  return Math.round(asFinite(value, 0)) + 0.5;
}

/*
 * ---------------------------------------------------------------------------
 * Canvas width
 *
 * The time views draw in one fixed logical coordinate space and never read the
 * size of the element they are drawn into: `Timeline` and `FlameChart` lay out
 * in a `viewBox` {@link CHART_VIEWBOX_WIDTH} units wide, declare
 * `width="100%"` and `preserveAspectRatio="xMinYMin meet"`, and leave sizing
 * to the stylesheet, which scales the drawing uniformly to its container. A
 * label is set in the stylesheet's type role, which inside the viewBox is that
 * many user units tall, so a label that fits its bar in logical units fits it
 * at every panel width. `DependencyGraph` lays out at its own deterministic
 * logical size, one unit to a CSS pixel, and its viewport scrolls a graph
 * wider than the panel. Either way the drawing is a pure function of the data,
 * identical in a browser and in a layout-free test DOM.
 * ---------------------------------------------------------------------------
 */

/**
 * The fixed logical width of a time chart's canvas, in SVG user units: 1 000.
 *
 * `Timeline` and `FlameChart` lay every bar, frame, tick and label out in a
 * `viewBox` exactly this wide, and the stylesheet sizes the element
 * relationally (`inline-size: 100%`, its block size following the viewBox's
 * aspect ratio) with `preserveAspectRatio="xMinYMin meet"`, so the drawing
 * scales uniformly to its container and a glyph is never stretched sideways.
 * No view reads its container's size: the drawing is a pure function of the
 * data, identical in a browser and in a layout-free test DOM.
 *
 * A thousand units keeps every placement a round per-mille of the plotted
 * window, which is what the package's layout-free tests assert against.
 */
export const CHART_VIEWBOX_WIDTH = 1000;

/*
 * ---------------------------------------------------------------------------
 * The linear time scale
 * ---------------------------------------------------------------------------
 */

/**
 * The time window a scale maps from: `[start, end]` in Unix epoch
 * milliseconds.
 *
 * Epoch milliseconds as a double with sub-millisecond precision is the
 * product's canonical time base across every tier (AAP 0.2.3), which is why a
 * domain is expressed in it and never in an offset — an offset is only
 * meaningful beside the origin it was measured from, and mixing the two is the
 * one coordinate mistake these views can make silently.
 */
export type ScaleDomain = readonly [start: number, end: number];

/**
 * The pixel interval a scale maps onto: `[start, end]` in SVG user units.
 *
 * Normally `[0, width]`, but a view with a gutter for its row labels passes
 * `[labelWidth, width]` and gets the inset for free.
 */
export type ScaleRange = readonly [start: number, end: number];

/**
 * A linear map from an instant to a pixel, and back.
 *
 * Immutable by construction: every field is `readonly`, the object is frozen,
 * and there is no setter. A view that pans or zooms builds a new scale from the
 * new window — which is also what makes a scale safe to hold in React state and
 * to compare by reference.
 *
 * Shared by `Timeline`, `Waterfall` and `FlameChart` (whose x-axis is time) and
 * used by any component that has to turn a pointer position back into an
 * instant.
 */
export interface TimeScale {
  /** The first instant in the window, in epoch milliseconds. */
  readonly domainStart: number;
  /** The last instant in the window, in epoch milliseconds. */
  readonly domainEnd: number;
  /** `domainEnd - domainStart` in milliseconds; `0` for a collapsed window. */
  readonly domainSpan: number;
  /** The pixel the window starts at. */
  readonly rangeStart: number;
  /** The pixel the window ends at. */
  readonly rangeEnd: number;
  /** `rangeEnd - rangeStart` in pixels; `0` for a collapsed viewport. */
  readonly rangeSpan: number;
  /**
   * Pixels per millisecond: the scale's slope, `0` when it is degenerate.
   *
   * Exposed because it is what a caller needs to decide whether a duration is
   * worth drawing at all, and because a component that lays out thousands of
   * bars can multiply by it directly rather than calling {@link toPixels} per
   * bar.
   */
  readonly pixelsPerMs: number;
  /**
   * Whether the window or the viewport has no width.
   *
   * `true` means every instant maps to {@link rangeStart} and every pixel maps
   * to {@link domainStart}. It is a normal state, not an error: an empty
   * capture, a trace with a single instantaneous event, or a caller that
   * passed an empty pixel range all produce it, and a view should
   * read it to decide whether to draw an axis rather than to decide whether to
   * draw at all.
   */
  readonly degenerate: boolean;
  /**
   * The pixel an instant sits at, extrapolating outside the window.
   *
   * Always finite. A non-finite argument yields {@link rangeStart}.
   */
  readonly toPixels: (time: number) => number;
  /**
   * The pixel an instant sits at, pinned to `[rangeStart, rangeEnd]`.
   *
   * The variant to draw with: an instant outside the window pins to the edge
   * instead of placing geometry outside the viewport, where it would either be
   * clipped by the SVG or overlap a neighbouring view. {@link placeSpan} and
   * its siblings use this and report the pinning through
   * {@link SpanGeometry.clippedStart} and {@link SpanGeometry.clippedEnd}.
   */
  readonly toPixelsClamped: (time: number) => number;
  /**
   * The instant a pixel corresponds to, extrapolating outside the viewport.
   *
   * The inverse needed for hover and brush interactions. The result is an
   * unrounded epoch millisecond double, deliberately: the product's rounding
   * policy keeps three decimal places of a millisecond, and applying it to an
   * absolute epoch value would round at the fifteenth significant digit, where
   * a double's own precision has already run out. Round a *duration* — a
   * difference of two of these — not an instant.
   *
   * Always finite. A non-finite argument yields {@link domainStart}.
   */
  readonly toTime: (pixels: number) => number;
  /**
   * The instant a pixel corresponds to, pinned to `[domainStart, domainEnd]`.
   *
   * For a drag that leaves the viewport: a brush should stop at the edge of the
   * window rather than selecting a time the capture never covered.
   */
  readonly toTimeClamped: (pixels: number) => number;
}

/**
 * Builds a {@link TimeScale} from a time window and a pixel interval.
 *
 * The one place a time-to-pixel map is defined in this package.
 *
 * Degenerate inputs, each resolved rather than rejected so that a component can
 * render unconditionally:
 *
 * - **Zero-width window** (`start === end`) — a trace holding one
 *   instantaneous event, or an empty one, whose upstream convention reports
 *   `startTime === endTime === 0`. The scale is `degenerate`, `pixelsPerMs` is
 *   `0`, every instant maps to `rangeStart` and every pixel maps to
 *   `domainStart`. Spans still draw, at {@link MIN_SPAN_WIDTH}.
 * - **Inverted window** (`end < start`) — the bounds are swapped, so a caller
 *   that computed them from an unordered pair gets the window it meant.
 * - **Zero-width or inverted viewport** — same treatment: swapped if inverted,
 *   and `degenerate` if it has no width (a caller that passed an empty range).
 * - **Non-finite bound** — replaced with `0`, which collapses the affected
 *   interval rather than poisoning every coordinate derived from it.
 *
 * @param domain The time window, in epoch milliseconds.
 * @param range The pixel interval, in SVG user units.
 * @returns A frozen, immutable scale.
 */
export function createTimeScale(domain: ScaleDomain, range: ScaleRange): TimeScale {
  const [rawDomainStart, rawDomainEnd] = domain;
  const [rawRangeStart, rawRangeEnd] = range;

  const domainLow = asFinite(rawDomainStart, 0);
  const domainHigh = asFinite(rawDomainEnd, 0);
  const rangeLow = asFinite(rawRangeStart, 0);
  const rangeHigh = asFinite(rawRangeEnd, 0);

  const domainStart = Math.min(domainLow, domainHigh);
  const domainEnd = Math.max(domainLow, domainHigh);
  const rangeStart = Math.min(rangeLow, rangeHigh);
  const rangeEnd = Math.max(rangeLow, rangeHigh);

  const domainSpan = domainEnd - domainStart;
  const rangeSpan = rangeEnd - rangeStart;
  const degenerate = domainSpan <= 0 || rangeSpan <= 0;
  const pixelsPerMs = degenerate ? 0 : rangeSpan / domainSpan;

  const toPixels = (time: number): number => {
    if (degenerate) {
      return rangeStart;
    }
    return rangeStart + (asFinite(time, domainStart) - domainStart) * pixelsPerMs;
  };

  const toTime = (pixels: number): number => {
    if (degenerate) {
      return domainStart;
    }
    return domainStart + (asFinite(pixels, rangeStart) - rangeStart) / pixelsPerMs;
  };

  return Object.freeze<TimeScale>({
    domainStart,
    domainEnd,
    domainSpan,
    rangeStart,
    rangeEnd,
    rangeSpan,
    pixelsPerMs,
    degenerate,
    toPixels,
    toPixelsClamped: (time: number): number => clamp(toPixels(time), rangeStart, rangeEnd),
    toTime,
    toTimeClamped: (pixels: number): number => clamp(toTime(pixels), domainStart, domainEnd),
  });
}

/**
 * Builds the scale that lays a correlated trace out across `range`.
 *
 * The window is the tree's own `startTime` and `endTime`, which is what makes
 * the root span fill the viewport and every descendant sit inside it.
 *
 * This factory exists so that no component has to remember that a trace
 * publishes its length as `totalDuration` while a timeline view publishes its
 * own as `totalDurationMs` (see {@link timeScaleForTimelineView}): the length
 * is not needed here at all, because the two endpoints are authoritative and
 * the difference between them is what the scale computes.
 *
 * An empty tree reports both endpoints as `0`, which yields a degenerate scale
 * — handled, not special-cased, by {@link createTimeScale}.
 *
 * Consumers: `Timeline`, `FlameChart`, `Waterfall`.
 *
 * @param tree A correlated trace, read and never mutated.
 * @param range The pixel interval to lay it out across.
 */
export function timeScaleForTrace(tree: TraceTree, range: ScaleRange): TimeScale {
  return createTimeScale([tree.startTime, tree.endTime], range);
}

/**
 * Builds the scale that lays a timeline view out across `range`.
 *
 * The window is the view's `startTime` and `endTime` — the rows it actually
 * carries, not the trace they came from, which is what keeps every row's
 * `offsetMs` inside the window even when the view was truncated or excluded
 * orphans.
 *
 * An empty view reports zeroes by the same convention as an empty trace and
 * yields a degenerate scale.
 *
 * Consumers: `Timeline`, `Waterfall`.
 *
 * @param view A timeline view, read and never mutated.
 * @param range The pixel interval to lay it out across.
 */
export function timeScaleForTimelineView(view: TimelineView, range: ScaleRange): TimeScale {
  return createTimeScale([view.startTime, view.endTime], range);
}

/*
 * ---------------------------------------------------------------------------
 * Span placement
 * ---------------------------------------------------------------------------
 */

/**
 * The narrowest a span bar is ever drawn, in SVG user units: 2.
 *
 * Sub-millisecond operations are the normal case rather than the exception — a
 * hook transition, a fast patched function, a cached response — and at a
 * typical panel width one of them is a fraction of one pixel. Rounded down it
 * would disappear, and evidence a view silently declines to draw is evidence
 * the developer cannot click, cannot trace to source and has no reason to
 * believe was ever captured. Two units is the smallest bar that survives a
 * fractional-pixel layout and still reads as a bar rather than as a gridline.
 *
 * Every placement function here honours it, reports when it had to
 * ({@link SpanGeometry.minWidthApplied}) and keeps the widened bar inside the
 * viewport. A caller that wants a different floor passes
 * {@link PlacementOptions.minWidth}; `0` is accepted and means "draw it exactly
 * as measured".
 */
export const MIN_SPAN_WIDTH = 2;

/** How a span is placed. The single member is optional. */
export interface PlacementOptions {
  /**
   * The narrowest the bar may be drawn, in SVG user units; defaults to
   * {@link MIN_SPAN_WIDTH}.
   *
   * Declared `| undefined` so a caller may forward an optional configuration
   * value straight through under this repository's `exactOptionalPropertyTypes`
   * setting; a value that is not finite and zero or more is treated as absent.
   */
  readonly minWidth?: number | undefined;
}

/**
 * Where one span's bar goes, and what the window did to it.
 *
 * ## Fractional pixels, on purpose
 *
 * `x` and `width` are **not** rounded. Two adjacent bars rounded independently
 * either overlap by a unit or leave a one-unit seam between them, and a seam
 * inside a contiguous span reads as a gap in the work — exactly the wrong
 * inference in a latency view. SVG accepts fractional user units and
 * anti-aliases them, so the sub-pixel boundary between two bars stays where the
 * measurements put it. Use {@link roundPixels} where integers are genuinely
 * wanted, and {@link alignHairline} for one-unit strokes.
 *
 * ## The flags are for edge markers, not for filtering
 *
 * A clipped span is still drawn; the flags exist so a view can mark the edge it
 * was cut at. They matter for the asynchronous-continuation lineage of AAP
 * 0.4.2, where a child legitimately settles after its parent's window closed.
 */
export interface SpanGeometry {
  /** The bar's left edge, in SVG user units, inside the scale's range. */
  readonly x: number;
  /** The bar's width in SVG user units; never below the effective minimum. */
  readonly width: number;
  /** `x + width`, the bar's right edge — provided so callers do not re-add. */
  readonly end: number;
  /** Whether the span began before the window and was cut at its left edge. */
  readonly clippedStart: boolean;
  /** Whether the span ended after the window and was cut at its right edge. */
  readonly clippedEnd: boolean;
  /**
   * Whether the span lies entirely outside the window.
   *
   * The bar is pinned to the nearest edge at the minimum width rather than
   * omitted, so a view may draw an off-window marker; a view that would rather
   * skip it has the flag to skip on.
   */
  readonly outsideWindow: boolean;
  /**
   * Whether the minimum width had to be applied.
   *
   * `true` means the bar is wider than the operation measured, so a duration
   * label does not belong inside it and its right edge is not a measurement.
   */
  readonly minWidthApplied: boolean;
}

/**
 * The one placement implementation. Every public entry point normalises its
 * arguments into an absolute `[start, end]` pair and delegates here.
 */
function placeAbsolute(
  startTime: number,
  endTime: number,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  const first = asFinite(startTime, scale.domainStart);
  const second = asFinite(endTime, first);
  const from = Math.min(first, second);
  const to = Math.max(first, second);

  const minWidth = asNonNegative(options?.minWidth, MIN_SPAN_WIDTH);
  const left = scale.toPixelsClamped(from);
  const right = scale.toPixelsClamped(to);
  const measuredWidth = Math.max(right - left, 0);
  const width = Math.max(measuredWidth, minWidth);

  // Keep a widened bar inside the viewport by shifting it left off the right
  // edge — but only when the viewport is wide enough to hold it. A viewport
  // narrower than the minimum width (or with no width at all) has no
  // interval to fit the bar into, so the
  // bar starts at the left edge and the caller's own clipping applies.
  const overflow = left + width - scale.rangeEnd;
  const x = overflow > 0 && scale.rangeSpan >= width ? scale.rangeEnd - width : left;

  return {
    x,
    width,
    end: x + width,
    clippedStart: from < scale.domainStart,
    clippedEnd: to > scale.domainEnd,
    outsideWindow: to < scale.domainStart || from > scale.domainEnd,
    minWidthApplied: width > measuredWidth,
  };
}

/**
 * Places a span given its **absolute** start and end instants.
 *
 * The entry point for a row that carries both endpoints — a timeline row does,
 * and so does anything derived from one. Both arguments are epoch
 * milliseconds; passing an offset to either is the coordinate mistake
 * {@link placeOffsetSpan} exists to prevent.
 *
 * Degenerate inputs: a reversed pair is normalised (the earlier instant becomes
 * the left edge); a non-finite `startTime` is read as the window start and a
 * non-finite `endTime` as the start instant, which yields an instantaneous bar
 * at the minimum width rather than a `NaN` coordinate. Under a degenerate scale
 * every bar sits at the range start at the minimum width.
 *
 * Consumers: `Timeline`, `Waterfall`, `FlameChart`.
 *
 * @param startTime The span's start, in epoch milliseconds.
 * @param endTime The span's end, in epoch milliseconds.
 * @param scale The window to place it in.
 * @param options Minimum-width override.
 */
export function placeSpan(
  startTime: number,
  endTime: number,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  return placeAbsolute(startTime, endTime, scale, options);
}

/**
 * Places a span given its **absolute** start instant and its duration.
 *
 * The captured-event shape: a start in epoch milliseconds and a length in
 * milliseconds. A negative or non-finite duration is clamped to zero through
 * the shared duration clamp, which yields an instantaneous bar at the minimum
 * width — the honest rendering of a measurement that reports no length.
 *
 * Consumers: `Timeline`, `Waterfall`, `FlameChart`.
 *
 * @param startTime The span's start, in epoch milliseconds.
 * @param durationMs The span's inclusive duration, in milliseconds.
 * @param scale The window to place it in.
 * @param options Minimum-width override.
 */
export function placeSpanDuration(
  startTime: number,
  durationMs: number,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  const from = asFinite(startTime, scale.domainStart);
  return placeAbsolute(from, from + usableDurationMs(durationMs), scale, options);
}

/**
 * Places a captured event's span.
 *
 * Accepts the two fields it reads rather than the whole event, so a caller may
 * pass an event, a node's event or any object carrying the same two numbers
 * without a cast. The event's own time base is what makes this safe:
 * `startTime` is epoch milliseconds and `duration` is milliseconds, on every
 * tier (AAP 0.2.3).
 *
 * Consumers: `FlameChart` and `Timeline`, which lay out the nodes of a
 * correlated trace directly.
 *
 * @param event Any object carrying the event's `startTime` and `duration`.
 * @param scale The window to place it in.
 * @param options Minimum-width override.
 */
export function placeEventSpan(
  event: Pick<TelemetryEvent, 'startTime' | 'duration'>,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  return placeSpanDuration(event.startTime, event.duration, scale, options);
}

/**
 * Places a timeline row's bar.
 *
 * It reads the row's **absolute** `startTime` and `endTime`, and deliberately
 * ignores its `offsetMs`: that field is measured from the *view's* start, so
 * feeding it to a scale built from the same view's window would apply the
 * origin twice and shift every bar by the window's own start. Pass the scale
 * from {@link timeScaleForTimelineView} — or any narrower window, which is what
 * makes zooming work — and the two coordinate systems stay separate.
 * {@link placeOffsetSpan} is the entry point for the relative form.
 *
 * Consumers: `Timeline`, `Waterfall`.
 *
 * @param row A timeline row, read and never mutated.
 * @param scale The window to place it in.
 * @param options Minimum-width override.
 */
export function placeTimelineRow(
  row: TimelineRow,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  return placeAbsolute(row.startTime, row.endTime, scale, options);
}

/**
 * Places a span expressed as an **offset from a view's start** plus a duration.
 *
 * The relative form, for a caller holding a row's `offsetMs` rather than its
 * absolute instants. `viewStartTime` is the origin that offset was measured
 * from — a timeline view's `startTime` — and the sum of the two is the absolute
 * start every other placement function takes.
 *
 * Degenerate inputs: a non-finite or negative offset is read as `0` (the view's
 * own start), and a non-finite origin as the scale's window start.
 *
 * @param offsetMs Milliseconds from `viewStartTime` to the span's start.
 * @param durationMs The span's inclusive duration, in milliseconds.
 * @param viewStartTime The origin the offset was measured from, in epoch milliseconds.
 * @param scale The window to place it in.
 * @param options Minimum-width override.
 */
export function placeOffsetSpan(
  offsetMs: number,
  durationMs: number,
  viewStartTime: number,
  scale: TimeScale,
  options?: PlacementOptions,
): SpanGeometry {
  const origin = asFinite(viewStartTime, scale.domainStart);
  return placeSpanDuration(origin + usableDurationMs(offsetMs), durationMs, scale, options);
}

/**
 * The width a duration occupies under a scale, independent of where it starts.
 *
 * For the proportional bars that carry no position: a metric card's inline bar,
 * a waterfall's summary row, a legend swatch sized to a threshold. Honours the
 * same minimum width as the placement functions, so a sub-millisecond duration
 * is visible here too.
 *
 * Degenerate inputs: a non-finite or negative duration is clamped to zero, and
 * a degenerate scale yields the effective minimum width — never `NaN`.
 *
 * @param durationMs A duration in milliseconds.
 * @param scale The scale whose slope converts it.
 * @param options Minimum-width override.
 */
export function spanWidth(
  durationMs: number,
  scale: TimeScale,
  options?: PlacementOptions,
): number {
  const minWidth = asNonNegative(options?.minWidth, MIN_SPAN_WIDTH);
  return Math.max(usableDurationMs(durationMs) * scale.pixelsPerMs, minWidth);
}

/*
 * ---------------------------------------------------------------------------
 * Row and depth geometry
 *
 * Two layouts share one vertical rhythm. A flattened list — a timeline's or a
 * waterfall's nested rows — gives every node a row of its own, so `y` follows
 * the node's position in the walk. An icicle — the hierarchical form
 * `FlameChart` draws, which AAP 0.6.6 records as the stated equivalent of a
 * sampled flame graph, since the product has no CPU profiler — gives every
 * node the row of its depth, so siblings share a row and nesting reads
 * downward. The pitch is the same in both, which is what lets a view switch
 * between them without re-measuring anything.
 * ---------------------------------------------------------------------------
 */

/**
 * The height of one row, in SVG user units: 18.
 *
 * Sized for the dense typography of this design system (AAP 0.6.3), where the
 * body text role is 13/18 — one row holds one line of it without clipping its
 * descenders. It is a plain number rather than a token because it is consumed
 * by SVG geometry attributes, which take no custom property.
 */
export const DEFAULT_ROW_HEIGHT = 18;

/**
 * The vertical space between two rows, in SVG user units: 2.
 *
 * Enough to separate adjacent bars at the dense end of the spacing scale
 * without turning a deep tree into a striped block.
 */
export const DEFAULT_ROW_GUTTER = 2;

/**
 * The vertical space between two lanes, in SVG user units: 8.
 *
 * Wider than the row gutter on purpose: a lane boundary is a change of tier,
 * which the reader must see at a glance.
 */
export const DEFAULT_LANE_GUTTER = 8;

/** The vertical rhythm of a row layout. Both members are optional. */
export interface RowLayoutOptions {
  /**
   * Row height in SVG user units; defaults to {@link DEFAULT_ROW_HEIGHT}. A
   * value that is not finite and positive is treated as absent.
   */
  readonly rowHeight?: number | undefined;
  /**
   * Space between rows in SVG user units; defaults to
   * {@link DEFAULT_ROW_GUTTER}. A value that is not finite and zero or more is
   * treated as absent.
   */
  readonly rowGutter?: number | undefined;
}

/** The vertical rhythm of a lane stack. */
export interface LaneLayoutOptions extends RowLayoutOptions {
  /**
   * Space between lanes in SVG user units; defaults to
   * {@link DEFAULT_LANE_GUTTER}. A value that is not finite and zero or more is
   * treated as absent.
   */
  readonly laneGutter?: number | undefined;
}

/** One row's vertical placement. */
export interface RowGeometry {
  /** Which row of the layout this is, counting from `0`. */
  readonly rowIndex: number;
  /** The row's top edge, in SVG user units. */
  readonly y: number;
  /** The row's height, in SVG user units. */
  readonly height: number;
}

/** Resolves the row height a caller asked for, or the default. */
function resolveRowHeight(options?: RowLayoutOptions): number {
  return asPositive(options?.rowHeight, DEFAULT_ROW_HEIGHT);
}

/** Resolves the row gutter a caller asked for, or the default. */
function resolveRowGutter(options?: RowLayoutOptions): number {
  return asNonNegative(options?.rowGutter, DEFAULT_ROW_GUTTER);
}

/**
 * The top edge of row `rowIndex`, in SVG user units.
 *
 * The whole vertical layout is this one multiplication, which is why it is a
 * function rather than four copies of `index * (height + gutter)`.
 *
 * Degenerate inputs: a `rowIndex` that is not a non-negative integer is read as
 * `0`, so a caller that computed one from an empty list still gets the layout's
 * origin instead of a `NaN` offset.
 *
 * @param rowIndex The row's position, counting from `0`.
 * @param options Row rhythm overrides.
 */
export function rowY(rowIndex: number, options?: RowLayoutOptions): number {
  return asNonNegativeInt(rowIndex, 0) * (resolveRowHeight(options) + resolveRowGutter(options));
}

/**
 * The row a node's `depth` occupies in an icicle layout.
 *
 * In an icicle, depth *is* the row: the time axis carries the horizontal
 * position and nesting reads downward, so every node at depth `n` shares one
 * row and a parent sits directly above its children. That is what
 * `FlameChart` draws, and what a nested `Timeline` uses for its indentation
 * guides.
 *
 * Degenerate inputs: a `depth` that is not a non-negative integer is read as
 * `0` — the root row.
 *
 * @param depth The node's distance from the trace root.
 * @param options Row rhythm overrides.
 */
export function layoutDepth(depth: number, options?: RowLayoutOptions): RowGeometry {
  const rowIndex = asNonNegativeInt(depth, 0);

  return {
    rowIndex,
    y: rowY(rowIndex, options),
    height: resolveRowHeight(options),
  };
}

/**
 * The total height of `rowCount` stacked rows, in SVG user units.
 *
 * Gutters sit *between* rows, so `n` rows carry `n - 1` of them and the layout
 * has no trailing space to trim — which is what keeps a scroll container's
 * declared height equal to the geometry inside it.
 *
 * Degenerate inputs: a `rowCount` that is not a non-negative integer, or is
 * zero, yields `0`. An empty view therefore declares no height rather than one
 * row's worth of blank space.
 *
 * @param rowCount How many rows are stacked.
 * @param options Row rhythm overrides.
 */
export function layoutHeight(rowCount: number, options?: RowLayoutOptions): number {
  const count = asNonNegativeInt(rowCount, 0);
  if (count <= 0) {
    return 0;
  }

  return count * resolveRowHeight(options) + (count - 1) * resolveRowGutter(options);
}

/**
 * The total height an icicle layout needs to show every depth up to `maxDepth`.
 *
 * A tree whose greatest depth is `n` occupies `n + 1` rows, because depth
 * counts from zero. Pass a correlated trace's own `maxDepth`, which reports
 * `0` both for a single-level tree and for an empty one — the first needs one
 * row and the second needs none, so a caller with an empty tree should use
 * {@link layoutHeight} with a row count of `0` instead.
 *
 * @param maxDepth The greatest depth present.
 * @param options Row rhythm overrides.
 */
export function heightForMaxDepth(maxDepth: number, options?: RowLayoutOptions): number {
  return layoutHeight(asNonNegativeInt(maxDepth, 0) + 1, options);
}

/** One lane's vertical placement inside a stack of lanes. */
export interface LaneBox {
  /** The lane's position in the stack, counting from `0`. */
  readonly index: number;
  /** The lane's top edge, in SVG user units. */
  readonly y: number;
  /** The lane's height: its rows and the gutters between them. */
  readonly height: number;
  /** How many rows the lane holds. */
  readonly rowCount: number;
}

/** A stack of lanes and the height it occupies. */
export interface LaneStackLayout {
  /** One box per input row count, in the same order, including empty lanes. */
  readonly lanes: readonly LaneBox[];
  /** The stack's total height, with no trailing gutter. */
  readonly height: number;
}

/**
 * Stacks lanes vertically and reports where each one starts.
 *
 * `Timeline` draws one lane per tier. It passes the lanes' row counts — a
 * timeline view publishes `rowCount` on every lane — and positions a row at
 * `lane.y + rowY(indexWithinLane)`, which keeps one vertical rhythm across the
 * whole view.
 *
 * Numbers rather than lane objects, deliberately: the geometry depends on how
 * many rows a lane holds and on nothing else, so this function needs no
 * telemetry type and cannot go stale when one changes.
 *
 * A lane with no rows keeps its position in the stack, occupies no height and
 * contributes no gutter, so an empty lane cannot open a gap the reader would
 * read as a missing tier. A row count that is not a non-negative integer is
 * read as `0`.
 *
 * @param rowCounts How many rows each lane holds, in stack order.
 * @param options Row and lane rhythm overrides.
 */
export function layoutLaneStack(
  rowCounts: readonly number[],
  options?: LaneLayoutOptions,
): LaneStackLayout {
  const laneGutter = asNonNegative(options?.laneGutter, DEFAULT_LANE_GUTTER);
  const lanes: LaneBox[] = [];
  let cursor = 0;
  let height = 0;

  for (const [index, rawRowCount] of rowCounts.entries()) {
    const rowCount = asNonNegativeInt(rawRowCount, 0);
    const laneHeight = layoutHeight(rowCount, options);

    lanes.push({ index, y: cursor, height: laneHeight, rowCount });

    if (laneHeight > 0) {
      height = cursor + laneHeight;
      cursor = height + laneGutter;
    }
  }

  return { lanes, height };
}

/**
 * Maps each depth present in a lane to a compact row index: the smallest depth
 * becomes row `0`, the next distinct depth row `1`, and so on, with no row
 * reserved for a depth nothing occupies.
 *
 * A lane of a tiered timeline holds the spans of one tier, and their trace
 * depths are sparse within it — a database lane can hold a query at depth 1
 * (an orphan attached to the trace root) and another at depth 5 (nested under
 * a request, a route handler and a function that all sit in other lanes).
 * Reserving one row per depth between the extremes would draw three empty rows
 * between those two bars; ranking the depths keeps the nesting order — a
 * deeper span still sits below a shallower one — without the gaps.
 *
 * A depth that is not a non-negative integer is read as `0`. Duplicates share a
 * row. The input is not mutated.
 *
 * @param depths The depths present in one lane, in any order.
 * @returns A map from each distinct depth to its row index, and the row count.
 */
export function rankLaneDepths(depths: readonly number[]): {
  readonly rowOf: ReadonlyMap<number, number>;
  readonly rowCount: number;
} {
  const distinct = [...new Set(depths.map((depth) => asNonNegativeInt(depth, 0)))].sort(
    (left, right) => left - right,
  );
  const rowOf = new Map<number, number>();
  for (const [row, depth] of distinct.entries()) {
    rowOf.set(depth, row);
  }
  return { rowOf, rowCount: distinct.length };
}

/*
 * ---------------------------------------------------------------------------
 * Trace traversal
 * ---------------------------------------------------------------------------
 */

/**
 * The largest number of nodes {@link flattenTraceRows} will visit: 2 000.
 *
 * A guard against a pathological capture rather than a product limit — a
 * correlated interaction is tens of spans, while a capture left running on an
 * idle page that re-renders on a timer can be thousands, and a view no one can
 * read is worth less than the same view marked as truncated. The bound
 * deliberately matches the row bound the upstream timeline builder applies, so
 * the two views of one capture agree on how much they show; it is declared here
 * rather than imported because telemetry is a type-only dependency of this
 * package and its constants are runtime values.
 */
export const DEFAULT_MAX_TRACE_ROWS = 2000;

/**
 * The deepest node {@link flattenTraceRows} will place: 1 024.
 *
 * The same guard, vertically, and the same value the correlator uses before it
 * stops extending a chain. Reaching it means the input is not the shape a tree
 * should be, and stopping is what keeps a bounded walk bounded.
 */
export const DEFAULT_MAX_TRACE_DEPTH = 1024;

/*
 * ---------------------------------------------------------------------------
 * The drawn-row budget
 *
 * A capture can hold far more spans than one SVG can carry: a trace of a
 * hundred thousand nodes is a hundred thousand bars, labels and handlers, and a
 * DevTools panel that mounts them freezes. So a view never draws more than a
 * fixed number of rows at once, however often a reader asks for more. Asking
 * for more MOVES a window of at most that many rows over the full, ordered
 * walk instead of growing it; what lies before and after the window is counted
 * and stated, never silently dropped. The helpers below are that window's
 * arithmetic, shared so the views that page a walk agree on what "the next
 * rows" are.
 * ---------------------------------------------------------------------------
 */

/**
 * The most rows one SVG view draws at once: 2 000 — an absolute budget, not a
 * starting bound.
 *
 * Equal to {@link DEFAULT_MAX_TRACE_ROWS}, so a trace that fits the default
 * walk is drawn whole and a larger one is drawn a window at a time. A view
 * whose rows are heavier than a bar (a row of controls rather than a rect) may
 * pass a smaller budget of its own to {@link windowRows}; none may pass a
 * larger one and still claim to be bounded.
 */
export const MAX_DRAWN_ROWS = DEFAULT_MAX_TRACE_ROWS;

/**
 * A contiguous window of at most `budget` rows over an ordered walk of `total`
 * rows: rows `[start, end)` are drawn, `before` rows precede them and `after`
 * rows follow them.
 *
 * `before + count + after === total` always holds, so a view can state "rows
 * `start + 1`–`end` of `total`" and how many it did not draw without any
 * arithmetic of its own.
 */
export interface RowWindow {
  /** The index of the first drawn row; `0` when there are no rows. */
  readonly start: number;
  /** One past the index of the last drawn row; `start` when none are drawn. */
  readonly end: number;
  /** How many rows are drawn: `end - start`, never more than `budget`. */
  readonly count: number;
  /** How many rows the walk holds in all. */
  readonly total: number;
  /** How many rows precede the window and are not drawn: `start`. */
  readonly before: number;
  /** How many rows follow the window and are not drawn: `total - end`. */
  readonly after: number;
  /** The most rows the window may hold. */
  readonly budget: number;
}

/**
 * The window of at most `budget` rows starting at `start` over `total` rows.
 *
 * - `total` that is not a non-negative integer is read as `0`: an empty walk
 *   yields an empty window at `0`.
 * - `budget` that is not a positive integer is read as {@link MAX_DRAWN_ROWS}.
 * - `start` that is not a non-negative integer is read as `0`, and a start at
 *   or past the end is pulled back to the start of the last window
 *   ({@link windowStartFor} of the last row), so a window over a non-empty walk
 *   is never empty — a walk that shrank under a window (a changed query, a
 *   folded subtree) shows its last rows rather than nothing.
 *
 * @param total How many rows the walk holds.
 * @param start The first row to draw.
 * @param budget The most rows to draw.
 */
export function windowRows(total: number, start = 0, budget: number = MAX_DRAWN_ROWS): RowWindow {
  const rows = asNonNegativeInt(total, 0);
  const size =
    typeof budget === 'number' && Number.isInteger(budget) && budget > 0 ? budget : MAX_DRAWN_ROWS;
  const requested = asNonNegativeInt(start, 0);
  const first = rows === 0 ? 0 : requested < rows ? requested : windowStartFor(rows - 1, size);
  const end = Math.min(rows, first + size);
  return {
    start: first,
    end,
    count: end - first,
    total: rows,
    before: first,
    after: rows - end,
    budget: size,
  };
}

/**
 * The start of the aligned window that holds row `index`: the largest multiple
 * of `budget` not greater than `index`.
 *
 * What a view pages to when it must reveal a particular row — a selection made
 * in another view, a search hit — so the window it shows is the same one the
 * next/previous controls would have reached. A non-integer or negative `index`
 * reads as `0`; `budget` is sanitised as in {@link windowRows}.
 */
export function windowStartFor(index: number, budget: number = MAX_DRAWN_ROWS): number {
  const row = asNonNegativeInt(index, 0);
  const size =
    typeof budget === 'number' && Number.isInteger(budget) && budget > 0 ? budget : MAX_DRAWN_ROWS;
  return Math.floor(row / size) * size;
}

/**
 * The start of the window after `window`: its `end` while rows follow it, and
 * its own `start` when it is already the last window, so "next" never moves
 * past the walk.
 */
export function nextWindowStart(window: RowWindow): number {
  return window.after > 0 ? window.end : window.start;
}

/**
 * The start of the window before `window`: one budget earlier, and never
 * before the first row.
 */
export function previousWindowStart(window: RowWindow): number {
  return Math.max(0, window.start - window.budget);
}

/** Whether row `index` is drawn by `window`. */
export function windowContains(window: RowWindow, index: number): boolean {
  return Number.isInteger(index) && index >= window.start && index < window.end;
}

/** How a correlated trace is flattened for rendering. Every member is optional. */
export interface TraceLayoutOptions extends RowLayoutOptions {
  /**
   * The deepest node to place; defaults to {@link DEFAULT_MAX_TRACE_DEPTH}. A
   * node at exactly this depth is placed, and its children are not visited. A
   * value that is not a non-negative integer is treated as absent.
   */
  readonly maxDepth?: number | undefined;
  /**
   * The largest number of nodes to visit; defaults to
   * {@link DEFAULT_MAX_TRACE_ROWS}. A value that is not a non-negative integer
   * is treated as absent.
   */
  readonly maxRows?: number | undefined;
  /**
   * The first row to materialise, for a view that draws a window of the walk
   * (see {@link windowRows}); defaults to `0`.
   *
   * The walk still counts every row before it, so the layout's total row count
   * describes the whole tree while the window moves.
   */
  readonly firstRow?: number | undefined;
  /**
   * How many rows to materialise from {@link firstRow}; defaults to all of
   * them. `0` materialises none, which is a legitimate request from a view
   * scrolled past its own content.
   */
  readonly visibleRows?: number | undefined;
}

/**
 * One node of a correlated trace, positioned for rendering.
 *
 * ## It borrows, it does not copy
 *
 * `node` is the input node itself, not a clone: a view needs the event's
 * attributes, its source location and its identity, and copying them would
 * double the memory of a large capture for no gain. It is borrowed **read-only**
 * — nothing in this module writes to a node, a child array or an event.
 *
 * ## Two vertical coordinates, because there are two layouts
 *
 * `y` is the node's own row in the flattened walk (a nested timeline or
 * waterfall, one row per node) and `depthY` is the row of its depth (an icicle,
 * where siblings share a row). Both come from one pass, so a view that offers
 * both layouts measures nothing twice.
 *
 * ## The parent is carried down the walk
 *
 * A trace node has no parent pointer, by design: a cycle is not JSON, and this
 * structure crosses an HTTP response. The walk therefore passes what a view
 * needs to draw a connector — the parent's span id and its row — down the
 * recursion instead, and never writes it onto the borrowed node.
 */
export interface FlatTraceRow {
  /** The node this row draws, borrowed read-only from the input tree. */
  readonly node: TraceNode;
  /** The row's position in the flattened walk, counting from `0`. */
  readonly rowIndex: number;
  /**
   * The node's distance from the trace root, as the walk measured it.
   *
   * The walk's own count rather than the node's `depth` field, so the vertical
   * layout is monotone in the structure the view is drawing even if a producer
   * or a store round-trip left the two disagreeing. They are identical for a
   * tree the correlator built.
   */
  readonly depth: number;
  /** The row's top edge in a flattened layout, in SVG user units. */
  readonly y: number;
  /** The row's top edge in an icicle layout, in SVG user units. */
  readonly depthY: number;
  /** The row's height, in SVG user units. */
  readonly height: number;
  /** The node's span id — what a selection or an evidence citation names. */
  readonly spanId: SpanId;
  /** The parent's span id, absent at a root. */
  readonly parentSpanId?: SpanId | undefined;
  /** The parent's `rowIndex`, absent at a root. The other end of a connector. */
  readonly parentRowIndex?: number | undefined;
  /** Whether the node has children at all, whether or not they were visited. */
  readonly hasChildren: boolean;
  /** Whether the node's children were left unvisited because of the depth bound. */
  readonly childrenTruncated: boolean;
  /**
   * Whether the correlator had to re-attach this node rather than place it.
   *
   * An orphan is laid out like any other row — it is real captured work with
   * real timings, and dropping it would hide evidence — and flagged so a view
   * can mark that the structure around it is not the shape the application had.
   */
  readonly orphaned: boolean;
  /** The attribution mechanism, when the node joined its trace asynchronously. */
  readonly lineage?: string | undefined;
  /**
   * Whether more than one candidate parent was open at attribution time.
   *
   * `Timeline` draws such a connector dashed rather than presenting a guess as
   * a fact.
   */
  readonly lineageAmbiguous: boolean;
}

/** A correlated trace, flattened and positioned. */
export interface TraceLayout {
  /** The materialised rows: the drawn window, or all of them. */
  readonly rows: readonly FlatTraceRow[];
  /** How many rows were materialised; always `rows.length`. */
  readonly rowCount: number;
  /**
   * How many rows the walk produced, whether materialised or not.
   *
   * What a drawn-row window pages over ({@link windowRows}), and the `M` in
   * "showing N of M".
   */
  readonly totalRowCount: number;
  /** The index of the first materialised row. */
  readonly firstRow: number;
  /** The greatest depth the walk reached; `0` for a single-level or empty tree. */
  readonly maxDepth: number;
  /** The height of a flattened layout of {@link totalRowCount} rows. */
  readonly height: number;
  /** The height of an icicle layout of {@link maxDepth} + 1 rows; `0` when empty. */
  readonly depthHeight: number;
  /**
   * Whether this layout left out nodes it was given, through the row or depth
   * bound.
   *
   * It describes *this* walk only. A trace may also arrive already truncated by
   * the correlator, which the tree reports itself; a view that says "partial"
   * should consult both rather than either.
   */
  readonly truncated: boolean;
}

/** One pending node of the walk, with the ancestry the node cannot carry. */
interface TraceWalkFrame {
  readonly node: TraceNode;
  readonly depth: number;
  readonly parentSpanId: SpanId | undefined;
  readonly parentRowIndex: number | undefined;
}

/**
 * Flattens a correlated trace into positioned rows, depth-first.
 *
 * The traversal every SVG view of a trace shares. It is implemented here rather
 * than taken from telemetry because that package is a type-only dependency of
 * this one (AAP 0.2.2), and it is implemented over an **explicit stack** rather
 * than by recursion so that a pathological tree cannot overflow the call stack
 * of a DevTools panel.
 *
 * ## What it does not do
 *
 * - **It does not re-sort.** Sibling order arrives canonical from the
 *   correlator, which is the only layer holding the tie-breakers that make the
 *   order total — two producers can share a millisecond. Children are pushed in
 *   reverse so that they pop in exactly the order they arrived. A view that
 *   wants a different order sorts its own derived array.
 * - **It does not mutate.** No input node, child array, event or option object
 *   is written to; every row is a new object holding a read-only reference.
 * - **It does not drop evidence.** Orphans are laid out and flagged. Only the
 *   two documented bounds omit anything, and both set
 *   {@link TraceLayout.truncated}.
 *
 * ## Degenerate inputs
 *
 * An empty tree yields no rows, zero heights, `maxDepth` `0` and
 * `truncated: false`. A bound of `0` rows yields no rows with
 * `truncated: true` when the tree was not itself empty. A window past the end
 * of the walk yields no rows while still reporting the full
 * {@link TraceLayout.totalRowCount}.
 *
 * Consumers: `FlameChart` (via `depthY`), `Timeline` and `Waterfall` (via `y`).
 *
 * @param tree A correlated trace, read and never mutated.
 * @param options Bounds, drawn-row window and row rhythm.
 */
export function flattenTraceRows(tree: TraceTree, options?: TraceLayoutOptions): TraceLayout {
  const maxRows = asNonNegativeInt(options?.maxRows, DEFAULT_MAX_TRACE_ROWS);
  const maxDepth = asNonNegativeInt(options?.maxDepth, DEFAULT_MAX_TRACE_DEPTH);
  const firstRow = asNonNegativeInt(options?.firstRow, 0);
  const requestedVisible = options?.visibleRows;
  const windowEnd =
    typeof requestedVisible === 'number' &&
    Number.isInteger(requestedVisible) &&
    requestedVisible >= 0
      ? firstRow + requestedVisible
      : Number.POSITIVE_INFINITY;

  const rowHeight = resolveRowHeight(options);
  const rows: FlatTraceRow[] = [];
  const stack: TraceWalkFrame[] = [];

  // Roots in reverse, so the first root is the first row.
  for (let index = tree.roots.length - 1; index >= 0; index -= 1) {
    const root = tree.roots[index];
    if (root === undefined) {
      continue;
    }
    stack.push({ node: root, depth: 0, parentSpanId: undefined, parentRowIndex: undefined });
  }

  let produced = 0;
  let deepest = 0;
  let truncated = false;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    if (produced >= maxRows) {
      // Nodes remain that this layout will not show.
      truncated = true;
      break;
    }

    const rowIndex = produced;
    produced += 1;
    deepest = Math.max(deepest, frame.depth);

    const { node, depth } = frame;
    const children = node.children;
    const childrenBlocked = depth >= maxDepth;
    const childrenTruncated = children.length > 0 && childrenBlocked;
    if (childrenTruncated) {
      truncated = true;
    }

    if (rowIndex >= firstRow && rowIndex < windowEnd) {
      rows.push({
        node,
        rowIndex,
        depth,
        y: rowY(rowIndex, options),
        depthY: rowY(depth, options),
        height: rowHeight,
        spanId: node.event.spanId,
        parentSpanId: frame.parentSpanId,
        parentRowIndex: frame.parentRowIndex,
        hasChildren: children.length > 0,
        childrenTruncated,
        orphaned: node.orphaned,
        lineage: node.lineage?.value,
        lineageAmbiguous: node.lineage?.ambiguous === true,
      });
    }

    if (childrenBlocked) {
      continue;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) {
        continue;
      }
      stack.push({
        node: child,
        depth: depth + 1,
        parentSpanId: node.event.spanId,
        parentRowIndex: rowIndex,
      });
    }
  }

  return {
    rows,
    rowCount: rows.length,
    totalRowCount: produced,
    firstRow,
    maxDepth: deepest,
    height: layoutHeight(produced, options),
    depthHeight: produced > 0 ? heightForMaxDepth(deepest, options) : 0,
    truncated,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Time-axis ticks
 * ---------------------------------------------------------------------------
 */

/** How many ticks an axis aims for when the caller does not say: 6. */
export const DEFAULT_TICK_COUNT = 6;

/**
 * The closest two ticks may sit, in SVG user units: 48.
 *
 * Wide enough for a compact duration label of the length this scale produces
 * (`1.2 s`, `470 µs`) plus breathing room, so a narrow panel drops ticks
 * instead of overlapping their labels.
 */
export const MIN_TICK_SPACING = 48;

/**
 * The hard iteration cap on tick generation: 64.
 *
 * Every loop in this module is bounded. This one bounds an axis whose step
 * underflowed against its window — the failure mode that would otherwise be an
 * unbounded loop in a render pass — and a view that reaches it is told so
 * through {@link AxisTicks.truncated}.
 */
export const MAX_AXIS_TICKS = 64;

/**
 * The smallest step an axis will use: 0.001 ms — one microsecond.
 *
 * The product stores durations to three decimal places of a millisecond, so a
 * finer step would draw ticks between two values it cannot distinguish.
 */
export const MIN_TICK_STEP = 0.001;

/**
 * The largest offset from the origin this module rounds before labelling.
 *
 * The shared rounding policy works by shifting a value's decimal exponent, so
 * it is exact only while the shifted value stays inside a double's integer
 * range. A tick offset beyond this — which only a caller measuring from an
 * origin far outside its own window can produce — is labelled unrounded rather
 * than rounded imprecisely.
 */
const MAX_ROUNDABLE_OFFSET_MS = 1e12;

/** How an axis is ticked. Every member is optional. */
export interface AxisTickOptions {
  /**
   * How many ticks to aim for; defaults to {@link DEFAULT_TICK_COUNT}. The
   * result is a "nice" step near this count rather than exactly this many
   * ticks, and {@link minSpacing} may reduce it further. A value that is not
   * finite and positive is treated as absent.
   */
  readonly targetCount?: number | undefined;
  /**
   * The closest two ticks may sit, in SVG user units; defaults to
   * {@link MIN_TICK_SPACING}. A value that is not finite and positive is
   * treated as absent.
   */
  readonly minSpacing?: number | undefined;
  /**
   * The instant tick offsets are measured from, and the value the step is
   * snapped against; defaults to the scale's own window start.
   *
   * Pass the trace's start when the scale shows a zoomed sub-window and the
   * labels should stay comparable with the unzoomed view: the ticks then land
   * on multiples of the step measured from that origin, at or after the window
   * start, instead of restarting at zero inside the zoom.
   */
  readonly origin?: number | undefined;
}

/** One tick of a time axis. */
export interface AxisTick {
  /**
   * The instant the tick marks, in epoch milliseconds.
   *
   * Always present, and always the raw number: a view that wants to label its
   * ticks itself works from this and from {@link relativeMs} rather than
   * parsing {@link label}.
   */
  readonly value: number;
  /** The tick's pixel position under the scale it was generated for. */
  readonly offset: number;
  /**
   * Milliseconds from the axis origin to the tick, rounded by the product's
   * rounding policy.
   *
   * What {@link label} is rendered from, and what a custom label should be
   * rendered from. Negative for a tick before the origin, which only an
   * explicit {@link AxisTickOptions.origin} inside the window can produce.
   */
  readonly relativeMs: number;
  /**
   * The tick's text, from the shared compact duration formatter.
   *
   * It comes from `./format` and from nowhere else, so an axis reads in the
   * same units and digits as the table beside it — a second number-to-text
   * routine here is how an axis ends up disagreeing with the data it labels.
   * A negative offset renders as the zero label, because that formatter clamps
   * a negative duration; a view that wants signed text builds it from
   * {@link relativeMs}.
   */
  readonly label: string;
}

/** A time axis's ticks and the decisions behind them. */
export interface AxisTicks {
  /**
   * The ticks, ascending, never empty.
   *
   * An axis with no ticks is an axis with no scale on it, which is worse than a
   * coarse one: the minimum is the window's endpoints.
   */
  readonly ticks: readonly AxisTick[];
  /**
   * Milliseconds between ticks: a 1, 2 or 5 times a power of ten.
   *
   * `0` when the window has no width and the single tick has nothing to be
   * spaced from.
   */
  readonly step: number;
  /**
   * A suggested decimal count for a caller labelling the ticks itself, derived
   * from {@link step}: `0` for a step of a millisecond or more, otherwise
   * enough places to distinguish two adjacent ticks.
   */
  readonly decimals: number;
  /** The instant offsets were measured from. */
  readonly origin: number;
  /** Whether the window had no width, so the axis carries one tick. */
  readonly degenerate: boolean;
  /** Whether {@link MAX_AXIS_TICKS} stopped the generator short of the window end. */
  readonly truncated: boolean;
}

/**
 * Rounds a raw step up to a human-readable one: 1, 2 or 5 times a power of ten.
 *
 * The reason an axis reads `0, 50, 100 ms` instead of `0, 37.4, 74.8` — the
 * window divided by a tick count almost never lands on a number a reader can
 * do arithmetic with, and an axis whose labels cannot be added up is decoration
 * rather than a scale.
 *
 * Degenerate inputs: a step that is not finite and positive, or is finer than
 * {@link MIN_TICK_STEP}, yields {@link MIN_TICK_STEP}; a step so large that
 * rounding it up would overflow a double is returned unchanged.
 *
 * @param rawStep The unrounded step, in milliseconds.
 * @returns A step of the form 1, 2 or 5 times a power of ten.
 */
export function niceStep(rawStep: number): number {
  const raw = asPositive(rawStep, MIN_TICK_STEP);
  if (raw <= MIN_TICK_STEP) {
    return MIN_TICK_STEP;
  }

  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const candidate = factor * magnitude;

  return Number.isFinite(candidate) && candidate > 0 ? candidate : raw;
}

/** The decimal places needed to tell two ticks a `step` apart from each other. */
function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || step >= 1) {
    return 0;
  }

  return clamp(Math.ceil(-Math.log10(step)), 0, 6);
}

/** Builds one tick, with the offset rounding guard the axis origin may need. */
function buildTick(value: number, origin: number, scale: TimeScale): AxisTick {
  const delta = asFinite(value - origin, 0);
  const relativeMs = Math.abs(delta) < MAX_ROUNDABLE_OFFSET_MS ? roundMs(delta) : delta;

  return {
    value,
    offset: scale.toPixelsClamped(value),
    relativeMs,
    label: formatDurationCompact(relativeMs),
  };
}

/**
 * Generates the ticks of a time axis.
 *
 * The axis of `Timeline`, `Waterfall` and `FlameChart`. It picks a
 * human-readable step near the requested tick count, snaps the first tick to a
 * multiple of that step at or after the window start (measured from
 * {@link AxisTickOptions.origin}, which defaults to the window start, so the
 * first tick of an unzoomed axis is the window start itself), and emits no tick
 * past the window end.
 *
 * The tick count is the *lower* of what the caller asked for and what
 * {@link AxisTickOptions.minSpacing} allows across the range, so a narrow panel
 * loses ticks rather than overlapping labels.
 *
 * Degenerate inputs, none of which yields an empty axis or an unbounded loop:
 *
 * - **A window with no width** — one tick, at the window start, with `step` `0`
 *   and `degenerate: true`. This covers an empty capture, a trace holding a
 *   single instantaneous event, and a first render before the container has
 *   been measured.
 * - **A window narrower than one microsecond** — the step floors at
 *   {@link MIN_TICK_STEP}, the resolution the product stores, so the axis stays
 *   readable instead of ticking below what the data can distinguish.
 * - **A step that would place its first tick past the window end** — the
 *   window's two endpoints are emitted instead, so the axis always carries a
 *   scale.
 * - **More ticks than {@link MAX_AXIS_TICKS}** — the generator stops and sets
 *   `truncated`.
 *
 * @param scale The scale whose window is being ticked.
 * @param options Tick count, minimum spacing and label origin.
 */
export function generateAxisTicks(scale: TimeScale, options?: AxisTickOptions): AxisTicks {
  const origin = asFinite(options?.origin, scale.domainStart);

  if (scale.degenerate) {
    return {
      ticks: [buildTick(scale.domainStart, origin, scale)],
      step: 0,
      decimals: 0,
      origin,
      degenerate: true,
      truncated: false,
    };
  }

  const minSpacing = asPositive(options?.minSpacing, MIN_TICK_SPACING);
  const spacingLimit = Math.max(Math.floor(scale.rangeSpan / minSpacing), 1);
  const requested = Math.max(Math.round(asPositive(options?.targetCount, DEFAULT_TICK_COUNT)), 1);
  const count = clamp(Math.min(requested, spacingLimit), 1, MAX_AXIS_TICKS);
  const step = niceStep(scale.domainSpan / count);

  // Snap to a multiple of the step measured from the origin, at or after the
  // window start. The index is recomputed per tick rather than accumulated, so
  // a long axis cannot drift by repeated addition.
  const firstIndex = Math.ceil(asFinite((scale.domainStart - origin) / step, 0));
  const tolerance = step * 1e-9;
  const ticks: AxisTick[] = [];
  let truncated = false;

  for (let index = 0; index < MAX_AXIS_TICKS; index += 1) {
    const value = origin + (firstIndex + index) * step;
    if (value > scale.domainEnd + tolerance) {
      break;
    }
    ticks.push(buildTick(value, origin, scale));

    if (index === MAX_AXIS_TICKS - 1) {
      const next = origin + (firstIndex + index + 1) * step;
      truncated = next <= scale.domainEnd + tolerance;
    }
  }

  if (ticks.length === 0) {
    // The snapped first tick landed past the window end: label the endpoints so
    // the axis still carries a scale.
    ticks.push(buildTick(scale.domainStart, origin, scale));
    ticks.push(buildTick(scale.domainEnd, origin, scale));
  }

  return {
    ticks,
    step,
    decimals: decimalsForStep(step),
    origin,
    degenerate: false,
    truncated,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Layered graph geometry
 *
 * `DependencyGraph` is a static layered left-to-right layout (AAP 0.6.2): work
 * flows rightward, one column per layer, and a participant sits to the right of
 * everything that calls it. Dragging and zooming are out of scope for this
 * version (AAP 0.6.6), so the geometry is a pure function of the data and the
 * rhythm — hover and click need no layout state at all.
 * ---------------------------------------------------------------------------
 */

/** The width of one participant box, in SVG user units: 168. */
export const DEFAULT_GRAPH_NODE_WIDTH = 168;

/** The height of one participant box, in SVG user units: 44. */
export const DEFAULT_GRAPH_NODE_HEIGHT = 44;

/**
 * The horizontal space between two columns, in SVG user units: 56.
 *
 * Wide enough that an edge between two columns is legible as a connector rather
 * than as a seam between two boxes.
 */
export const DEFAULT_GRAPH_COLUMN_GAP = 56;

/** The vertical space between two boxes in one column, in SVG user units: 16. */
export const DEFAULT_GRAPH_ROW_GAP = 16;

/**
 * The coordinate range this module will serialise into path data: ±1 000 000.
 *
 * A guard on {@link edgePathData}: a coordinate beyond this would be written in
 * exponent notation, which is not valid SVG path syntax and would silently
 * discard the whole path. No layout of a bounded graph comes close to it.
 */
const MAX_PATH_COORDINATE = 1e6;

/** The rhythm of a layered graph layout. Every member is optional. */
export interface GraphLayoutOptions {
  /**
   * Participant box width in SVG user units; defaults to
   * {@link DEFAULT_GRAPH_NODE_WIDTH}. A value that is not finite and positive
   * is treated as absent.
   */
  readonly nodeWidth?: number | undefined;
  /**
   * Participant box height in SVG user units; defaults to
   * {@link DEFAULT_GRAPH_NODE_HEIGHT}. A value that is not finite and positive
   * is treated as absent.
   */
  readonly nodeHeight?: number | undefined;
  /**
   * Space between columns in SVG user units; defaults to
   * {@link DEFAULT_GRAPH_COLUMN_GAP}. A value that is not finite and zero or
   * more is treated as absent.
   */
  readonly columnGap?: number | undefined;
  /**
   * Space between boxes within a column in SVG user units; defaults to
   * {@link DEFAULT_GRAPH_ROW_GAP}. A value that is not finite and zero or more
   * is treated as absent.
   */
  readonly rowGap?: number | undefined;
}

/** A point in SVG user units. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One participant box's rectangle and the cell it occupies. */
export interface GraphNodeBox {
  /** The box's left edge. */
  readonly x: number;
  /** The box's top edge. */
  readonly y: number;
  /** The box's width. */
  readonly width: number;
  /** The box's height. */
  readonly height: number;
  /** The box's horizontal centre — where a label or an icon anchors. */
  readonly centerX: number;
  /** The box's vertical centre — where an edge anchors. */
  readonly centerY: number;
  /** The column the box sits in, counting from `0`. */
  readonly layer: number;
  /** The box's position within its column, counting from `0`. */
  readonly indexInLayer: number;
}

/** The overall size of a layered graph canvas. */
export interface GraphCanvasSize {
  /** The canvas width, with no trailing column gap. */
  readonly width: number;
  /** The canvas height, with no trailing row gap. */
  readonly height: number;
}

/** Where an edge leaves its source box and meets its target box. */
export interface EdgeAnchors {
  /** The point on the source box's border. */
  readonly source: Point;
  /** The point on the target box's border. */
  readonly target: Point;
  /**
   * Which way the edge runs.
   *
   * `forward` is the normal left-to-right case. `backward` means the target
   * sits in an earlier column — which a cyclic dependency produces — and
   * `vertical` means both boxes share a column. A view may mark the two
   * unusual cases; the geometry is already correct for all three.
   */
  readonly orientation: 'forward' | 'backward' | 'vertical';
}

/** A cubic Bézier, as four points. */
export interface EdgeCurve {
  /** The curve's start: the anchor on the source box. */
  readonly source: Point;
  /** The control point that pulls the curve out of the source box. */
  readonly control1: Point;
  /** The control point that pulls the curve into the target box. */
  readonly control2: Point;
  /** The curve's end: the anchor on the target box. */
  readonly target: Point;
}

/** One participant, positioned. */
export interface PositionedGraphNode {
  /** The participant, borrowed read-only from the input graph. */
  readonly node: DependencyGraphNode;
  /** Its box. */
  readonly box: GraphNodeBox;
}

/** One relationship, positioned. */
export interface PositionedGraphEdge {
  /** The relationship, borrowed read-only from the input graph. */
  readonly edge: DependencyGraphEdge;
  /** Its anchors and orientation. */
  readonly anchors: EdgeAnchors;
  /** Its curve, ready for {@link edgePathData}. */
  readonly curve: EdgeCurve;
}

/** A layered graph, positioned. */
export interface DependencyGraphLayout {
  /** The participants, in the order the input listed them. */
  readonly nodes: readonly PositionedGraphNode[];
  /** The relationships whose endpoints were both present. */
  readonly edges: readonly PositionedGraphEdge[];
  /** The canvas width. */
  readonly width: number;
  /** The canvas height. */
  readonly height: number;
  /** How many columns the layout uses. */
  readonly layerCount: number;
  /** The tallest column's participant count — what sets the canvas height. */
  readonly maxNodesPerLayer: number;
  /**
   * Whether the layer indices were computed rather than read from the input:
   * the {@link GraphLayering.computed} flag of the layering the layout used.
   *
   * `true` means at least one participant carried no usable layer, so the whole
   * layering was recomputed by {@link assignGraphLayers} to keep the columns
   * internally consistent. A view may note it; the layout is valid either way.
   */
  readonly layersComputed: boolean;
  /**
   * How many relationships named a participant the graph does not contain.
   *
   * They are omitted — an edge to nothing has no second anchor — and counted
   * rather than silently dropped, because the count is the difference between
   * "these participants do not interact" and "part of this graph is missing".
   */
  readonly droppedEdgeCount: number;
}

/** Resolves the graph rhythm a caller asked for, or the defaults. */
function resolveGraphRhythm(options?: GraphLayoutOptions): {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
} {
  return {
    nodeWidth: asPositive(options?.nodeWidth, DEFAULT_GRAPH_NODE_WIDTH),
    nodeHeight: asPositive(options?.nodeHeight, DEFAULT_GRAPH_NODE_HEIGHT),
    columnGap: asNonNegative(options?.columnGap, DEFAULT_GRAPH_COLUMN_GAP),
    rowGap: asNonNegative(options?.rowGap, DEFAULT_GRAPH_ROW_GAP),
  };
}

/**
 * The box of the participant in column `layer`, row `indexInLayer`.
 *
 * The whole layered layout is this pair of multiplications, exposed on its own
 * so a view can place a box it is drawing outside a full layout — a hover
 * highlight, a focus ring, a measurement of where a column would start.
 *
 * Degenerate inputs: a `layer` or `indexInLayer` that is not a non-negative
 * integer is read as `0`, so a box always lands on the grid.
 *
 * @param layer The column, counting from `0`.
 * @param indexInLayer The position within the column, counting from `0`.
 * @param options Rhythm overrides.
 */
export function graphNodeBox(
  layer: number,
  indexInLayer: number,
  options?: GraphLayoutOptions,
): GraphNodeBox {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = resolveGraphRhythm(options);
  const column = asNonNegativeInt(layer, 0);
  const row = asNonNegativeInt(indexInLayer, 0);
  const x = column * (nodeWidth + columnGap);
  const y = row * (nodeHeight + rowGap);

  return {
    x,
    y,
    width: nodeWidth,
    height: nodeHeight,
    centerX: x + nodeWidth / 2,
    centerY: y + nodeHeight / 2,
    layer: column,
    indexInLayer: row,
  };
}

/**
 * The canvas a layered graph of this shape needs.
 *
 * Gaps sit *between* columns and rows, so the canvas has no trailing gap to
 * trim and its declared size equals the geometry inside it.
 *
 * Degenerate inputs: a count that is not a positive integer is read as `0`, and
 * either count at `0` yields a canvas of `0` by `0` — an empty graph declares
 * no size rather than one empty cell's worth.
 *
 * @param layerCount How many columns the layout uses.
 * @param maxNodesPerLayer The tallest column's participant count.
 * @param options Rhythm overrides.
 */
export function graphCanvasSize(
  layerCount: number,
  maxNodesPerLayer: number,
  options?: GraphLayoutOptions,
): GraphCanvasSize {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = resolveGraphRhythm(options);
  const columns = asNonNegativeInt(layerCount, 0);
  const rows = asNonNegativeInt(maxNodesPerLayer, 0);

  return {
    width: columns <= 0 ? 0 : columns * nodeWidth + (columns - 1) * columnGap,
    height: rows <= 0 ? 0 : rows * nodeHeight + (rows - 1) * rowGap,
  };
}

/**
 * Where an edge between two boxes leaves one and meets the other.
 *
 * Left-to-right by default: out of the source's right border and into the
 * target's left border, which is the reading direction of the layout. Two cases
 * are handled explicitly rather than left to produce a connector that runs
 * backwards through its own box: a target in an **earlier** column — what a
 * cyclic dependency produces — anchors the other way round, and two boxes in the
 * **same** column anchor vertically, from the upper box's bottom border to the
 * lower box's top border.
 *
 * Pure geometry: no colour, no stroke width, no marker. Those are the
 * component's, and the orientation this returns is what it keys them off.
 *
 * @param from The source participant's box.
 * @param to The target participant's box.
 */
export function edgeAnchors(from: GraphNodeBox, to: GraphNodeBox): EdgeAnchors {
  if (to.x > from.x) {
    return {
      source: { x: from.x + from.width, y: from.centerY },
      target: { x: to.x, y: to.centerY },
      orientation: 'forward',
    };
  }

  if (to.x < from.x) {
    return {
      source: { x: from.x, y: from.centerY },
      target: { x: to.x + to.width, y: to.centerY },
      orientation: 'backward',
    };
  }

  const downward = to.centerY >= from.centerY;

  return {
    source: { x: from.centerX, y: downward ? from.y + from.height : from.y },
    target: { x: to.centerX, y: downward ? to.y : to.y + to.height },
    orientation: 'vertical',
  };
}

/**
 * The cubic Bézier between two anchors, with horizontal control points.
 *
 * Horizontal control points are what make a layered graph's edges read as flow:
 * every connector leaves its source going sideways and arrives at its target
 * going sideways, so two edges into one box do not cross at its border. The
 * control points sit half the horizontal distance out from each anchor, which
 * degenerates — correctly — into a straight line for two anchors in the same
 * column.
 *
 * Numbers, not a path string: the component decides whether to draw the curve,
 * a straight line or an orthogonal route from the same four points.
 * {@link edgePathData} is there when it just wants the curve.
 *
 * Degenerate inputs: a non-finite coordinate on either anchor is read as `0`,
 * so the curve is always drawable.
 *
 * @param source The anchor the curve starts at.
 * @param target The anchor the curve ends at.
 */
export function edgeCurve(source: Point, target: Point): EdgeCurve {
  const from: Point = { x: asFinite(source.x, 0), y: asFinite(source.y, 0) };
  const to: Point = { x: asFinite(target.x, 0), y: asFinite(target.y, 0) };
  const reach = (to.x - from.x) / 2;

  return {
    source: from,
    control1: { x: from.x + reach, y: from.y },
    control2: { x: to.x - reach, y: to.y },
    target: to,
  };
}

/** Formats one coordinate for path data: finite, bounded, never exponential. */
function pathNumber(value: number): string {
  const bounded = clamp(asFinite(value, 0), -MAX_PATH_COORDINATE, MAX_PATH_COORDINATE);
  return String(Math.round(bounded * 100) / 100);
}

/**
 * Serialises a curve as SVG path data.
 *
 * The one string this module produces, because the `d` attribute has no numeric
 * form. It is geometry rather than style: no colour, no width, no dash pattern.
 * Coordinates are rounded to two decimals — finer than any display can resolve,
 * coarse enough to keep the attribute short — and bounded so that no
 * coordinate is ever written in exponent notation, which would make the path
 * unparseable and drop the edge from the drawing entirely.
 *
 * @param curve The curve to serialise.
 * @returns A `M`/`C` path, for example `M 0 0 C 10 0 20 10 30 10`.
 */
export function edgePathData(curve: EdgeCurve): string {
  const { source, control1, control2, target } = curve;
  const move = `M ${pathNumber(source.x)} ${pathNumber(source.y)}`;
  const control = `${pathNumber(control1.x)} ${pathNumber(control1.y)}`;
  const inbound = `${pathNumber(control2.x)} ${pathNumber(control2.y)}`;
  const destination = `${pathNumber(target.x)} ${pathNumber(target.y)}`;

  return `${move} C ${control} ${inbound} ${destination}`;
}

/** The discovery order of a participant the component search has not reached yet. */
const UNVISITED = -1;

/**
 * One group of participants that call one another in a cycle — a strongly
 * connected component — as a vertex of the acyclic graph the components form.
 */
interface LayeringComponent {
  /** The components this one calls; a repeated relationship is listed again. */
  readonly successors: LayeringComponent[];
  /** How many listed relationships into this component are not yet placed. */
  inDegree: number;
  /** Its column: the longest path to it from a component nothing calls. */
  layer: number;
}

/** One participant's bookkeeping in {@link assignGraphLayers}. */
interface LayeringVertex {
  /** The participant id this vertex stands for. */
  readonly id: string;
  /** The participants it calls, self-references and unknown endpoints excluded. */
  readonly successors: LayeringVertex[];
  /** Its depth-first discovery order; {@link UNVISITED} until reached. */
  order: number;
  /** The smallest discovery order reachable from it while its component is open. */
  lowLink: number;
  /** Whether it is on the open-component stack. */
  onStack: boolean;
  /** The component it closed into; `undefined` until the search closes it. */
  component: LayeringComponent | undefined;
}

/** One frame of the explicit depth-first call stack: a vertex and its next successor. */
interface LayeringFrame {
  /** The vertex being expanded. */
  readonly vertex: LayeringVertex;
  /** The index of the next successor to examine. */
  next: number;
}

/**
 * Tarjan's strongly-connected-component search, iteratively.
 *
 * The call stack is an array rather than the JavaScript stack, so a chain of
 * any length — a pathological payload of a hundred thousand participants, say —
 * costs memory proportional to its length and never a `RangeError`. Each vertex
 * is entered once and each successor examined once, so the search is O(V+E).
 * Every vertex leaves with its {@link LayeringVertex.component} set; the
 * components are returned in the order they closed, which the caller does not
 * rely on.
 */
function closeComponents(vertices: readonly LayeringVertex[]): LayeringComponent[] {
  const components: LayeringComponent[] = [];
  const open: LayeringVertex[] = [];
  const callStack: LayeringFrame[] = [];
  let discovered = 0;

  const enter = (vertex: LayeringVertex): void => {
    vertex.order = discovered;
    vertex.lowLink = discovered;
    discovered += 1;
    vertex.onStack = true;
    open.push(vertex);
    callStack.push({ vertex, next: 0 });
  };

  for (const root of vertices) {
    if (root.order !== UNVISITED) {
      continue;
    }
    enter(root);

    for (let frame = callStack.at(-1); frame !== undefined; frame = callStack.at(-1)) {
      const { vertex } = frame;
      const successor = vertex.successors[frame.next];

      if (successor !== undefined) {
        frame.next += 1;
        if (successor.order === UNVISITED) {
          enter(successor);
        } else if (successor.onStack) {
          vertex.lowLink = Math.min(vertex.lowLink, successor.order);
        }
        continue;
      }

      // Every successor examined: the frame returns to its caller, carrying
      // the lowest order it reached, exactly as the recursive form would.
      callStack.pop();
      const caller = callStack.at(-1);
      if (caller !== undefined) {
        caller.vertex.lowLink = Math.min(caller.vertex.lowLink, vertex.lowLink);
      }

      if (vertex.lowLink !== vertex.order) {
        continue;
      }

      // A component root: it and everything opened after it form one component.
      const component: LayeringComponent = { successors: [], inDegree: 0, layer: 0 };
      components.push(component);
      for (let member = open.pop(); member !== undefined; member = open.pop()) {
        member.onStack = false;
        member.component = component;
        if (member === vertex) {
          break;
        }
      }
    }
  }

  return components;
}

/**
 * Computes a column for every participant: the longest path from a participant
 * nothing calls, with the members of a cycle sharing one column.
 *
 * The **fallback** layering. A graph built upstream already carries a layer per
 * participant, and {@link resolveGraphLayering} uses those when it can; this
 * exists for the case the shape allows — a participant contributed by static
 * analysis, with no layer of its own — and is exported so a caller assembling a
 * graph by hand has the same rule available.
 *
 * Deliberately *not* graph analysis beyond layering: it answers "which column"
 * and nothing else. It reads `id`, `from` and `to`, and ignores every other
 * field.
 *
 * ## One linear pass, and what a cycle does
 *
 * O(V+E) for any input, in three steps that each visit every participant and
 * every relationship once:
 *
 *   1. **Components.** An iterative Tarjan search ({@link closeComponents})
 *      groups the participants that reach one another — the members of a cycle
 *      — into one strongly connected component. A cycle has no longest path, so
 *      its members cannot be ordered against each other, and they share a
 *      column rather than being pushed apart by a guess. The cycle's edges then
 *      stay legible as `vertical` connectors from {@link edgeAnchors}.
 *   2. **Condensation.** The components form an acyclic graph: one relationship
 *      per relationship between two different components.
 *   3. **Longest path.** Kahn's topological order over that acyclic graph, with
 *      each component placed one column right of the furthest component that
 *      calls it (`layer = max(caller layer + 1)`), so a participant always sits
 *      to the right of everything that calls it from outside its own cycle.
 *
 * No step iterates to a fixed point, so nothing needs a pass cap, and a chain
 * of any length is laid out in full: participant `i` of a chain lands in
 * column `i` whatever order its relationships arrived in.
 *
 * ## Deterministic for any permutation
 *
 * Both the partition into components and each component's longest path are
 * properties of the graph, not of the order the arrays list it in, so the same
 * participants and relationships in any order produce the same column for
 * every id. A repeated participant id is one participant — the first
 * occurrence stands for it — a self-referential edge is ignored, since no
 * participant can sit to the right of itself, and an edge naming a participant
 * the graph does not contain is ignored here and counted by
 * {@link layoutDependencyGraph}.
 *
 * @param nodes The participants; only their `id` is read.
 * @param edges The relationships; only `from` and `to` are read.
 * @returns A layer index per participant id, `0` or more and at most one less
 * than the number of distinct ids.
 */
export function assignGraphLayers(
  nodes: readonly DependencyGraphNode[],
  edges: readonly DependencyGraphEdge[],
): ReadonlyMap<string, number> {
  const vertices: LayeringVertex[] = [];
  const vertexById = new Map<string, LayeringVertex>();

  for (const node of nodes) {
    if (vertexById.has(node.id)) {
      continue;
    }
    const vertex: LayeringVertex = {
      id: node.id,
      successors: [],
      order: UNVISITED,
      lowLink: UNVISITED,
      onStack: false,
      component: undefined,
    };
    vertices.push(vertex);
    vertexById.set(node.id, vertex);
  }

  for (const edge of edges) {
    const from = vertexById.get(edge.from);
    const to = vertexById.get(edge.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    from.successors.push(to);
  }

  const components = closeComponents(vertices);

  for (const vertex of vertices) {
    const from = vertex.component;
    for (const successor of vertex.successors) {
      const to = successor.component;
      if (from === undefined || to === undefined || from === to) {
        continue;
      }
      from.successors.push(to);
      to.inDegree += 1;
    }
  }

  // Kahn's order: a component is placed only once every component calling it
  // has been, so its longest path is final when its callees are relaxed.
  const ready = components.filter((component) => component.inDegree === 0);
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const component = ready[cursor];
    if (component === undefined) {
      continue;
    }
    for (const successor of component.successors) {
      successor.layer = Math.max(successor.layer, component.layer + 1);
      successor.inDegree -= 1;
      if (successor.inDegree === 0) {
        ready.push(successor);
      }
    }
  }

  const layers = new Map<string, number>();
  for (const vertex of vertices) {
    layers.set(vertex.id, vertex.component?.layer ?? 0);
  }

  return layers;
}

/**
 * The columns of a layered graph, and where they came from.
 *
 * The one layering a view computes for a payload and then hands to everything
 * that needs it — the view's own canonical ordering and
 * {@link layoutDependencyGraph} — so the expensive half of the layout runs once
 * per payload and the ordering and the geometry can never disagree.
 */
export interface GraphLayering {
  /** A column per participant id, `0` or more. */
  readonly layers: ReadonlyMap<string, number>;
  /**
   * `true` when the columns were computed from the relationships by
   * {@link assignGraphLayers}; `false` when they were read from the payload's
   * own `layer` indices.
   */
  readonly computed: boolean;
}

/** Whether a payload's layer index can be used as a column. */
function isPlacedLayer(layer: number | undefined): layer is number {
  return typeof layer === 'number' && Number.isInteger(layer) && layer >= 0;
}

/**
 * The layering of a graph: the payload's own when it is complete, a computed
 * one otherwise.
 *
 * The payload's layer indices are used when **every** participant carries a
 * usable one — a non-negative integer — because they are the upstream
 * longest-path assignment and nothing here improves on them. When any
 * participant does not, the whole layering is computed with
 * {@link assignGraphLayers}. It is all or nothing on purpose: mixing a provided
 * index with a computed one would place two participants in one column by
 * coincidence rather than by a rule. A repeated participant id takes the column
 * of its first occurrence on either route, which is also the box its
 * relationships anchor on.
 *
 * Call it once per payload and pass the result to
 * {@link layoutDependencyGraph}; that is what keeps the layering from running
 * twice.
 *
 * @param nodes The participants; only `id` and `layer` are read.
 * @param edges The relationships; only `from` and `to` are read, and only when
 * the layering has to be computed.
 * @returns The columns, and whether they were computed.
 */
export function resolveGraphLayering(
  nodes: readonly DependencyGraphNode[],
  edges: readonly DependencyGraphEdge[],
): GraphLayering {
  if (!nodes.every((node) => isPlacedLayer(node.layer))) {
    return { layers: assignGraphLayers(nodes, edges), computed: true };
  }

  const layers = new Map<string, number>();
  for (const node of nodes) {
    if (!layers.has(node.id) && isPlacedLayer(node.layer)) {
      layers.set(node.id, node.layer);
    }
  }

  return { layers, computed: false };
}

/**
 * Lays a dependency graph out in columns.
 *
 * The layout `DependencyGraph` draws. Participants keep the order the input
 * gave them — upstream orders them by layer, then by descending total time,
 * then by id, and re-sorting here would make the same capture draw differently
 * in two views — and are stacked down their column in that order.
 *
 * ## Where the columns come from
 *
 * From `layering` when the caller supplies one, verbatim and without a second
 * look: a view that already resolved the layering to order its participants
 * passes that same object here, so the layering runs once per payload rather
 * than once for the ordering and again for the geometry.
 * {@link DependencyGraphLayout.layersComputed} is then that layering's
 * `computed` flag. A supplied layering **must** have been computed from the
 * same participants and relationships as `data` — in any order, since
 * {@link resolveGraphLayering} is permutation-independent — or the columns
 * describe some other graph.
 *
 * Without one, this calls {@link resolveGraphLayering} itself: the input's own
 * layer indices when **every** participant carries a usable one, and otherwise a
 * layering computed from the relationships for all of them.
 *
 * ## Degenerate inputs
 *
 * An empty graph yields no nodes, no edges, a `0` by `0` canvas and a layer
 * count of `0`. An edge naming a participant the graph does not contain is
 * omitted and counted in
 * {@link DependencyGraphLayout.droppedEdgeCount}. A negative, fractional or
 * non-finite layer index is treated as absent, which triggers the recomputation
 * rather than placing a box off-canvas, and a participant a supplied layering
 * has no usable column for is placed in column `0`.
 *
 * @param data The graph, read and never mutated.
 * @param options Rhythm overrides.
 * @param layering The layering already resolved for `data`, when the caller has
 * one; see above.
 */
export function layoutDependencyGraph(
  data: DependencyGraphData,
  options?: GraphLayoutOptions,
  layering?: GraphLayering,
): DependencyGraphLayout {
  const { layers, computed: layersComputed } =
    layering ?? resolveGraphLayering(data.nodes, data.edges);

  const nodes: PositionedGraphNode[] = [];
  const boxes = new Map<string, GraphNodeBox>();
  const filled = new Map<number, number>();
  let maxLayerSeen = -1;
  let maxNodesPerLayer = 0;

  for (const node of data.nodes) {
    const layer = asNonNegativeInt(layers.get(node.id), 0);
    const indexInLayer = filled.get(layer) ?? 0;
    filled.set(layer, indexInLayer + 1);
    maxLayerSeen = Math.max(maxLayerSeen, layer);
    maxNodesPerLayer = Math.max(maxNodesPerLayer, indexInLayer + 1);

    const box = graphNodeBox(layer, indexInLayer, options);
    nodes.push({ node, box });
    // A duplicate id would otherwise make an edge anchor on whichever box was
    // written last; keeping the first is what makes the layout deterministic.
    if (!boxes.has(node.id)) {
      boxes.set(node.id, box);
    }
  }

  const edges: PositionedGraphEdge[] = [];
  let droppedEdgeCount = 0;

  for (const edge of data.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from === undefined || to === undefined) {
      droppedEdgeCount += 1;
      continue;
    }

    const anchors = edgeAnchors(from, to);
    edges.push({ edge, anchors, curve: edgeCurve(anchors.source, anchors.target) });
  }

  const layerCount = nodes.length === 0 ? 0 : maxLayerSeen + 1;
  const { width, height } = graphCanvasSize(layerCount, maxNodesPerLayer, options);

  return {
    nodes,
    edges,
    width,
    height,
    layerCount,
    maxNodesPerLayer,
    layersComputed,
    droppedEdgeCount,
  };
}
