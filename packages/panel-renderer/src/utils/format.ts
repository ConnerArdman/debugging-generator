/**
 * Presentation formatting — the single home of every piece of *text* a
 * generated debugging panel prints for a number, a path or a captured preview.
 *
 * A panel is rendered twice, in two hosts: the Chrome DevTools panel and the
 * editor webview. Both read the same validated specification and the same
 * capture, so both must print the same characters for the same data — a
 * duration that reads `1.175 s` in one surface and `1175ms` in the other makes
 * two views of one interaction look like two measurements. Every formatter in
 * this module is therefore deterministic and locale-independent: the digits
 * come from explicit arithmetic and `toFixed`, the grouping separator and the
 * decimal point are fixed by this module rather than by a host's locale, and no
 * `Intl` formatter is constructed anywhere.
 *
 * ## What this module owns, and what it does not
 *
 * It owns the *text*: unit selection and fixed precision for durations, byte
 * sizes, counts and percentages; the singular/plural agreement of the words
 * printed beside a count; the code-point-safe truncation that keeps a
 * preview inside the capture's privacy bound; the one-line collapsing that
 * keeps a multi-line statement out of a table row's height; the grapheme-safe
 * fitting of an SVG label to a width in logical units ({@link fitTextToWidth},
 * over a deterministic advance estimate, so no view measures a font or reads
 * layout); the compact path and source-chip labels; and the readable labels
 * for the closed telemetry
 * vocabularies (`./color` delegates those here explicitly, so a legend and a
 * table cannot drift apart).
 *
 * It owns no visual decision. There is no colour, no token, no length and no
 * style value here — AAP 0.6.4 permits no hardcoded CSS value anywhere in this
 * package, and a formatter that emitted one would be taking a decision that
 * belongs to `./color` (colour and severity) or `./scale` (geometry).
 *
 * ## Absence is a value, not a failure
 *
 * {@link NOT_AVAILABLE_LABEL} is a first-class result. A capture legitimately
 * cannot measure everything it reports on — a transfer size is exposed for
 * same-origin responses only, and a server span reports none at all (AAP
 * 0.6.6) — so every formatter here answers an unmeasurable input with that one
 * label instead of a zero, a dash, an empty cell or the text `NaN`. A zero
 * would turn an absence into an observation, which the product forbids
 * structurally (AAP 0.8.4).
 *
 * ## Layering
 *
 * - This module is the **leaf** of `src/utils`: it imports nothing from
 *   `./color`, nothing from `./scale` and nothing from `../tokens`. `./scale`
 *   imports *from here* for its axis tick labels; the reverse edge would be a
 *   cycle.
 * - `@debuggen/shared` supplies the five helpers this module deliberately does
 *   **not** re-implement — `roundMs` (the product's single rounding policy),
 *   `clampNonNegative` (the producers' own duration clamp), `toPosix`,
 *   `basenamePosix` and `formatSourceLocation` (the canonical
 *   `file:line:column` label). A second implementation of any of them would be
 *   a second answer to a question the product answers once.
 * - `@debuggen/telemetry` is a **type-only** dependency (AAP 0.2.2): every
 *   telemetry import below is `import type`, and exhaustiveness over a closed
 *   vocabulary comes from typing a table as a `Record` over the union rather
 *   than from importing a runtime tuple.
 * - No platform builtin, no React, no transport. `src/index.ts` does not
 *   re-export `./utils`, so this surface is package-internal.
 *
 * Every export is a pure function or a frozen table, and importing this module
 * reads nothing, writes nothing and touches no global — which is what keeps
 * `"sideEffects": ["**\/*.css"]` in the package manifest honest.
 *
 * ## Consumers
 *
 * `../primitives/DurationCell.tsx` (the value/unit split), `MetricCards.tsx`
 * ({@link formatMetric}, {@link NOT_AVAILABLE_LABEL} and the duration and byte
 * value/unit splits), `Timeline.tsx`,
 * `Waterfall.tsx` and `FlameChart.tsx` (compact bar and tooltip labels),
 * `SpanTable.tsx`, `RenderTable.tsx`, `RequestTable.tsx`, `QueryTable.tsx`,
 * `EventLog.tsx`, `StateTransitionViewer.tsx` and `ComponentTree.tsx`
 * (durations, counts, bytes, shares, one-line previews), `SourceLink.tsx` (the
 * chip label and its title) and `../layout/SummaryHeader.tsx` (counts and
 * durations inside observed-fact text). {@link formatCountOf},
 * {@link pluralize} and {@link countedNoun} are the one count-agreement rule
 * for every sentence built around a count — today `Waterfall.tsx` (badges,
 * descriptions, disclosure names, the footer and the empty-page copy),
 * `FlameChart.tsx` (notes, disclosure names and the list label) and
 * `DependencyGraph.tsx` (notes and the canvas's text alternative); any other
 * view that counts something in words uses the same three rather than an
 * inline `count === 1 ? … : …`.
 */

import {
  basenamePosix,
  clampNonNegative,
  formatSourceLocation,
  isAbsolutePosix,
  roundMs,
  toPosix,
} from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type {
  MetricId,
  MetricUnit,
  MetricValue,
  RenderTrigger,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';

/*
 * ---------------------------------------------------------------------------
 * Labels and bounds that must not drift
 * ---------------------------------------------------------------------------
 */

/**
 * The text every formatter here returns for a value the capture could not
 * measure, and the only spelling of it in the package.
 *
 * Exported as a constant precisely so that a card, a table cell, a tooltip and
 * a test cannot each invent their own spelling — `N/A`, `—` and an empty cell
 * are three different claims, and only this one says "not measured". A caller
 * comparing a formatted string against this constant is the sanctioned way to
 * detect the absent case after the fact (AAP 0.6.6).
 */
export const NOT_AVAILABLE_LABEL = 'n/a';

/**
 * The single character appended to a truncated preview.
 *
 * One code point, so it costs exactly one unit of a truncation budget, and a
 * character rather than three dots so a fixed-width cell does not lose three
 * characters of content to the marker.
 */
export const ELLIPSIS = '…';

/** The ellipsis's cost in code points — one, by construction. */
const ELLIPSIS_COST = Array.from(ELLIPSIS).length;

/**
 * The type of the telemetry package's own preview bound, used as a compile-time
 * tripwire below.
 *
 * `typeof import(...)` is a type-level import: it is erased, so it adds no
 * runtime edge to `@debuggen/telemetry`, which this package depends on for
 * types only (AAP 0.2.2). Because the upstream constant is declared as a
 * literal, this alias is the literal, and the mirrored value below fails to
 * compile the moment the two disagree.
 */
type TelemetryPreviewBound = typeof import('@debuggen/telemetry').MAX_PREVIEW_LENGTH;

/**
 * The largest preview, in code points, that this renderer will display — 120.
 *
 * Mirrored from `packages/telemetry/src/schema/attributes.ts`, which is the
 * authority for it, and typed against that declaration so a change upstream
 * breaks this file rather than silently widening what the panel shows. It is
 * mirrored rather than imported because telemetry is a type-only dependency
 * here.
 *
 * The number is a privacy guarantee, not a layout preference: AAP 0.5.2 bounds
 * a captured prop, state or attribute preview at 120 characters, so the
 * renderer must never present more than the producer was allowed to capture.
 * It is the default budget of {@link truncate} and {@link oneLinePreview}.
 */
export const MAX_PREVIEW_LENGTH: TelemetryPreviewBound = 120;

/**
 * The magnitude at which JavaScript's fixed notation degenerates.
 *
 * `Number.prototype.toFixed` switches to exponential form at 1e21, so
 * `(1e21).toFixed(3)` is `'1e+21'` — text no numeric column can align and no
 * reader can scan. Every formatter here refuses a magnitude at or beyond this
 * bound and returns {@link NOT_AVAILABLE_LABEL} instead: a duration of 1e21
 * milliseconds is not a measurement, and printing an exponent would be a worse
 * answer than saying so.
 */
const MAX_FIXED_MAGNITUDE = 1e21;

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000;

/** Microseconds in one millisecond. */
const US_PER_MS = 1000;

/** Digits per thousands group. */
const GROUP_SIZE = 3;

/** The thousands separator, fixed rather than taken from a host locale. */
const GROUP_SEPARATOR = ',';

/*
 * ---------------------------------------------------------------------------
 * Numeric text primitives
 *
 * Three small internal functions every public formatter funnels through, so
 * that rounding policy, the fixed-notation guard and thousands grouping are
 * each implemented once. `roundMs` is the product's rounding policy and is
 * reused rather than re-derived; the guard exists because rounding a very large
 * value through a decimal exponent shift can itself produce a non-finite
 * result.
 * ---------------------------------------------------------------------------
 */

/**
 * Rounds `value` to `decimals` places and renders it in fixed notation.
 *
 * @returns The fixed-notation text, or `undefined` when the value cannot be
 * rendered that way — a non-finite input, a magnitude at or beyond
 * {@link MAX_FIXED_MAGNITUDE}, or a rounding that itself overflows. Every
 * caller maps `undefined` to {@link NOT_AVAILABLE_LABEL}.
 */
function fixedText(value: number, decimals: number): string | undefined {
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_FIXED_MAGNITUDE) {
    return undefined;
  }

  const rounded = roundMs(value, decimals);
  if (!Number.isFinite(rounded) || Math.abs(rounded) >= MAX_FIXED_MAGNITUDE) {
    return undefined;
  }

  return rounded.toFixed(decimals);
}

/**
 * Inserts thousands separators into an integer digit string, sign preserved.
 *
 * Deliberately string arithmetic rather than `Intl.NumberFormat`: the two hosts
 * this library renders in may carry different locales, and a count that groups
 * as `1,024` in one and `1.024` in the other would read as two different
 * numbers.
 */
function groupDigits(digits: string): string {
  const negative = digits.startsWith('-');
  const body = negative ? digits.slice(1) : digits;

  const groups: string[] = [];
  for (let end = body.length; end > 0; end -= GROUP_SIZE) {
    groups.push(body.slice(Math.max(0, end - GROUP_SIZE), end));
  }
  const grouped = groups.reverse().join(GROUP_SEPARATOR);

  return negative ? `-${grouped}` : grouped;
}

/**
 * {@link fixedText} with thousands grouping applied to the integer part.
 *
 * The fraction is left untouched, so the decimal point stays the ASCII `.` and
 * the digit count after it stays exactly `decimals` — which is what lets a
 * column of these strings align under the monospace token's tabular numerals
 * (AAP 0.6.3).
 */
function groupedFixed(value: number, decimals: number): string | undefined {
  const text = fixedText(value, decimals);
  if (text === undefined) {
    return undefined;
  }

  const separatorIndex = text.indexOf('.');
  if (separatorIndex < 0) {
    return groupDigits(text);
  }

  return `${groupDigits(text.slice(0, separatorIndex))}${text.slice(separatorIndex)}`;
}

/*
 * ---------------------------------------------------------------------------
 * Durations
 *
 * The most-used formatter in the package: every bar, tick, cell, tooltip and
 * observed-fact sentence that mentions time goes through it. Milliseconds are
 * the canonical unit of every telemetry event (AAP 0.2.3), so milliseconds are
 * what every entry point takes.
 * ---------------------------------------------------------------------------
 */

/** The unit symbols a formatted duration can carry. */
export type DurationUnit = 'µs' | 'ms' | 's';

/**
 * How many decimals a duration keeps.
 *
 * - `compact` — for dense axis ticks and bar labels, where horizontal space is
 *   the scarce resource.
 * - `precise` — for tooltips, detail rows and table cells, where the reader is
 *   comparing two numbers and the digits matter.
 *
 * Both resolve through one implementation, so the two can never disagree about
 * which unit a value belongs to.
 */
export type DurationPrecision = 'compact' | 'precise';

/**
 * A formatted duration, split so a caller can style the unit separately.
 *
 * A discriminated union rather than an object with an optional unit: the
 * unavailable case has no number and no unit at all, and making that a separate
 * arm means a caller cannot print `undefined` beside a value by forgetting to
 * check. `../primitives/DurationCell.tsx` renders `value` in the numeric token
 * and `unit` in the muted one, which is exactly the split this shape exists
 * for — no string surgery on `text`.
 */
export type DurationParts =
  | {
      /** The duration was measurable and is rendered below. */
      readonly available: true;
      /** The numeric text, already rounded and padded to the unit's precision. */
      readonly value: string;
      /** The unit `value` is expressed in. */
      readonly unit: DurationUnit;
      /** `value` and `unit` joined by a single space — the whole label. */
      readonly text: string;
    }
  | {
      /** The duration was not measurable; both fields are the absent label. */
      readonly available: false;
      readonly value: typeof NOT_AVAILABLE_LABEL;
      readonly text: typeof NOT_AVAILABLE_LABEL;
    };

/** One step of the duration scale: its symbol, its conversion and its digits. */
interface DurationScale {
  readonly unit: DurationUnit;
  /** Converts a millisecond value into this step's magnitude. */
  readonly toMagnitude: (ms: number) => number;
  /** Fixed decimals per precision, so a column of values stays aligned. */
  readonly decimals: Readonly<Record<DurationPrecision, number>>;
}

/**
 * Sub-millisecond durations, in whole microseconds at both precisions.
 *
 * Microseconds are the resolution the product stores (`roundMs` keeps three
 * decimal places of a millisecond), so a fractional microsecond is noise rather
 * than information and is not printed. A positive duration below half a
 * microsecond therefore reads `0 µs`, which is true at the stored resolution.
 */
const MICROSECOND_SCALE: DurationScale = Object.freeze({
  unit: 'µs',
  toMagnitude: (ms: number): number => ms * US_PER_MS,
  decimals: Object.freeze({ compact: 0, precise: 0 }),
});

/**
 * The canonical step: whole milliseconds when compact, hundredths when precise.
 *
 * Two decimals is enough to separate two spans inside the same millisecond in a
 * detail view, and dropping to whole milliseconds on an axis keeps a tick label
 * short. It is also the step an exact zero uses, since a zero has no magnitude
 * to select a unit from and milliseconds is how the rest of the product speaks
 * about a duration that took approximately no time.
 */
const MILLISECOND_SCALE: DurationScale = Object.freeze({
  unit: 'ms',
  toMagnitude: (ms: number): number => ms,
  decimals: Object.freeze({ compact: 0, precise: 2 }),
});

/**
 * Durations of a second and beyond: one decimal when compact, milliseconds
 * (three decimals) when precise.
 *
 * Three decimals keeps a precise seconds label loss-free against the
 * millisecond it came from, so a total that was `1175` milliseconds reads
 * `1.175 s` rather than a rounded `1.18 s`.
 */
const SECOND_SCALE: DurationScale = Object.freeze({
  unit: 's',
  toMagnitude: (ms: number): number => ms / MS_PER_SECOND,
  decimals: Object.freeze({ compact: 1, precise: 3 }),
});

/** The single unit-selection rule, shared by every duration entry point. */
function durationScale(ms: number): DurationScale {
  if (ms === 0) {
    return MILLISECOND_SCALE;
  }
  if (ms < 1) {
    return MICROSECOND_SCALE;
  }
  if (ms < MS_PER_SECOND) {
    return MILLISECOND_SCALE;
  }
  return SECOND_SCALE;
}

/**
 * The one frozen unavailable arm, so the absent case allocates nothing and no
 * caller can mutate a shared result.
 */
const UNAVAILABLE_DURATION: DurationParts = Object.freeze<DurationParts>({
  available: false,
  value: NOT_AVAILABLE_LABEL,
  text: NOT_AVAILABLE_LABEL,
});

/**
 * Formats a duration in milliseconds, split into its number and its unit.
 *
 * Unit selection, by the raw millisecond value and identical at both
 * precisions: below 1 ms → `µs`, below 1 000 ms → `ms`, otherwise `s`. The
 * boundary belongs to the larger unit, so `999.9` is milliseconds and `1000` is
 * seconds.
 *
 * The unit comes from the measurement, never from its rounded text, so a value
 * just under a boundary can print the next unit's magnitude in the unit it was
 * measured in: `999.9` renders as `1,000 ms` when compact, not as `1.0 s`. That
 * is deliberate — re-selecting the unit after rounding would make the unit
 * depend on the precision, and a value would then change units between a tick
 * label and the tooltip describing the same span.
 *
 * Degenerate inputs, each deliberate:
 *
 * - `0` → `0.00 ms` when precise and `0 ms` when compact. An exact zero carries
 *   no magnitude to choose a unit from, so it takes the canonical unit, and it
 *   keeps that unit's decimals rather than collapsing to a bare `0`: a column
 *   whose zero row has fewer digits than its neighbours no longer aligns.
 * - a negative value → clamped to `0` by the shared `clampNonNegative`, the
 *   same clamp the producers apply, and rendered exactly as the zero above.
 * - `NaN`, `Infinity`, `-Infinity` → the unavailable arm, whose `text` is
 *   {@link NOT_AVAILABLE_LABEL}. Neither `NaN` nor `Infinity` ever reaches a
 *   panel as text.
 * - a magnitude at or beyond {@link MAX_FIXED_MAGNITUDE} → the unavailable arm,
 *   because fixed notation degenerates into an exponent there.
 *
 * @param ms A duration in milliseconds.
 * @param precision Digit policy; defaults to `precise`.
 */
export function formatDurationParts(
  ms: number,
  precision: DurationPrecision = 'precise',
): DurationParts {
  if (!Number.isFinite(ms)) {
    return UNAVAILABLE_DURATION;
  }

  const clamped = clampNonNegative(ms);
  const scale = durationScale(clamped);
  const decimals = scale.decimals[precision];
  const value = groupedFixed(scale.toMagnitude(clamped), decimals);

  if (value === undefined) {
    return UNAVAILABLE_DURATION;
  }

  return {
    available: true,
    value,
    unit: scale.unit,
    text: `${value} ${scale.unit}`,
  };
}

/**
 * Formats a duration in milliseconds as one string, at `precise` precision.
 *
 * The default duration formatter: table cells, tooltips, detail rows and
 * observed-fact sentences. Same units, boundaries and degenerate-input
 * behaviour as {@link formatDurationParts}, whose `text` it returns.
 *
 * @example
 * ```ts
 * formatDuration(0.4); // '400 µs'
 * formatDuration(46.9994); // '47.00 ms'
 * formatDuration(1175); // '1.175 s'
 * formatDuration(Number.NaN); // 'n/a'
 * ```
 */
export function formatDuration(ms: number, precision: DurationPrecision = 'precise'): string {
  return formatDurationParts(ms, precision).text;
}

/**
 * Formats a duration in milliseconds at `compact` precision.
 *
 * For axis ticks and bar labels, where the label must stay short: whole
 * microseconds, whole milliseconds, or seconds to one decimal. `./scale` calls
 * this for its tick labels, which is why it exists as its own named export
 * rather than as an option a caller has to remember.
 *
 * @example
 * ```ts
 * formatDurationCompact(46.9994); // '47 ms'
 * formatDurationCompact(1175); // '1.2 s'
 * ```
 */
export function formatDurationCompact(ms: number): string {
  return formatDuration(ms, 'compact');
}

/**
 * Formats an event's offset from the start of its capture.
 *
 * Event log rows and timeline tooltips show an offset, never a wall-clock
 * time: the canonical time base is epoch milliseconds as a double (AAP 0.2.3),
 * and epoch text would be noise beside the interaction it belongs to. The
 * offset is a subtraction, rounded through the shared `roundMs` before it is
 * formatted so that two events one floating-point artefact apart cannot print
 * different offsets for the same instant.
 *
 * An offset that comes out negative — a producer whose first event predates the
 * origin the caller passed — clamps to `0 ms` rather than rendering a negative
 * duration. A non-finite origin or timestamp yields {@link NOT_AVAILABLE_LABEL}.
 *
 * @param epochMs The event's `startTime`, in epoch milliseconds.
 * @param originEpochMs The capture's (or trace's) start, in epoch milliseconds.
 * @param precision Digit policy; defaults to `precise`.
 */
export function formatOffset(
  epochMs: number,
  originEpochMs: number,
  precision: DurationPrecision = 'precise',
): string {
  if (!Number.isFinite(epochMs) || !Number.isFinite(originEpochMs)) {
    return NOT_AVAILABLE_LABEL;
  }

  return formatDuration(roundMs(epochMs - originEpochMs), precision);
}

/*
 * ---------------------------------------------------------------------------
 * Bytes, counts and shares
 * ---------------------------------------------------------------------------
 */

/** The unit symbols a formatted byte size can carry, decimal (SI) prefixes. */
export type ByteUnit = 'B' | 'kB' | 'MB' | 'GB' | 'TB' | 'PB';

/**
 * The byte units in ascending order.
 *
 * Typed as a non-empty tuple so the first element is statically known to exist
 * and the defensive fallback in {@link formatBytesParts} needs no assertion
 * under `noUncheckedIndexedAccess`.
 */
const BYTE_UNITS: readonly [ByteUnit, ...ByteUnit[]] = Object.freeze([
  'B',
  'kB',
  'MB',
  'GB',
  'TB',
  'PB',
] as const);

/**
 * Bytes per step of the byte scale: **1 000, the decimal convention**.
 *
 * Decimal rather than binary, and the unit symbols are the SI ones (`kB`, not
 * `KiB` and not an ambiguous `KB`), because the numbers this formats are
 * transfer sizes reported by the browser's resource timing — which every
 * browser's own network user interface presents in decimal units. Matching that
 * convention means a developer comparing a panel against the network panel of
 * the same load sees the same figure.
 */
const BYTES_PER_UNIT = 1000;

/** Decimals kept for a byte size at or above one kilobyte. */
const BYTE_DECIMALS = 1;

/** Decimals kept for a percentage. */
const PERCENT_DECIMALS = 1;

/** Decimals kept for a number whose unit this build does not recognise. */
const UNITLESS_DECIMALS = 2;

/**
 * A formatted byte size, split so a caller can style the unit separately.
 *
 * The same discriminated shape as {@link DurationParts}, for the same reason:
 * the unavailable case has no number and no unit at all, so a caller cannot
 * print `undefined` beside a value by forgetting to check. A metric tile
 * renders `value` in its prominent numeric role and `unit` in its own muted
 * element, exactly as it does for a duration — no string surgery on `text`.
 */
export type ByteParts =
  | {
      /** The size was measurable and is rendered below. */
      readonly available: true;
      /** The numeric text: whole bytes below a kilobyte, one decimal above. */
      readonly value: string;
      /** The decimal (SI) unit `value` is expressed in. */
      readonly unit: ByteUnit;
      /** `value` and `unit` joined by a single space — the whole label. */
      readonly text: string;
    }
  | {
      /** The size was not measurable; both fields are the absent label. */
      readonly available: false;
      readonly value: typeof NOT_AVAILABLE_LABEL;
      readonly text: typeof NOT_AVAILABLE_LABEL;
    };

/**
 * The one frozen unavailable arm of {@link ByteParts}, so the absent case
 * allocates nothing and no caller can mutate a shared result.
 */
const UNAVAILABLE_BYTES: ByteParts = Object.freeze<ByteParts>({
  available: false,
  value: NOT_AVAILABLE_LABEL,
  text: NOT_AVAILABLE_LABEL,
});

/**
 * Formats a byte count, selecting a decimal (1 000-based) unit, split into its
 * number and its unit.
 *
 * Whole bytes below one kilobyte, then one decimal for every larger unit, which
 * keeps a column of transfer sizes aligned while staying readable. The scale
 * stops at petabytes; a value beyond that keeps the petabyte unit.
 *
 * Degenerate inputs: `0` → `0 B`; a negative value clamps to `0` through the
 * shared `clampNonNegative`; `NaN` and `Infinity` → the unavailable arm, whose
 * `text` is {@link NOT_AVAILABLE_LABEL}, as does a magnitude fixed notation
 * cannot express. An *unmeasured* transfer size must not be passed here as `0`:
 * it is an absent metric value and renders through {@link formatMetric} as
 * `n/a` (AAP 0.6.6).
 *
 * @example
 * ```ts
 * formatBytesParts(2048); // { available: true, value: '2.0', unit: 'kB', text: '2.0 kB' }
 * formatBytesParts(Number.NaN); // { available: false, value: 'n/a', text: 'n/a' }
 * ```
 */
export function formatBytesParts(bytes: number): ByteParts {
  if (!Number.isFinite(bytes)) {
    return UNAVAILABLE_BYTES;
  }

  let magnitude = clampNonNegative(bytes);
  let index = 0;
  while (magnitude >= BYTES_PER_UNIT && index < BYTE_UNITS.length - 1) {
    magnitude /= BYTES_PER_UNIT;
    index += 1;
  }

  const unit: ByteUnit = BYTE_UNITS[index] ?? BYTE_UNITS[0];
  const value = groupedFixed(magnitude, index === 0 ? 0 : BYTE_DECIMALS);

  if (value === undefined) {
    return UNAVAILABLE_BYTES;
  }

  return { available: true, value, unit, text: `${value} ${unit}` };
}

/**
 * Formats a byte count as one string, selecting a decimal (1 000-based) unit.
 *
 * Same units, precision and degenerate-input behaviour as
 * {@link formatBytesParts}, whose `text` it returns, so the joined and the
 * split forms of one size can never disagree.
 *
 * @example
 * ```ts
 * formatBytes(512); // '512 B'
 * formatBytes(2048); // '2.0 kB'
 * formatBytes(1_500_000); // '1.5 MB'
 * ```
 */
export function formatBytes(bytes: number): string {
  return formatBytesParts(bytes).text;
}

/**
 * Formats a whole count with thousands grouping.
 *
 * For every cardinal a panel shows — renders per component, request and query
 * occurrences, duplicate occurrences, long tasks, errors, event totals. The
 * value is rounded to a whole number through the shared `roundMs` policy, so a
 * count that arrived as a floating-point sum prints as an integer rather than
 * as `4.000000001`.
 *
 * Degenerate inputs: a negative count clamps to `0`; `NaN` and `Infinity` →
 * {@link NOT_AVAILABLE_LABEL}. A count of `0` prints as `0` — zero occurrences
 * is an observation, unlike an unmeasured metric, and the two must not look
 * alike.
 *
 * @example
 * ```ts
 * formatCount(4); // '4'
 * formatCount(12_345); // '12,345'
 * ```
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return NOT_AVAILABLE_LABEL;
  }

  return groupedFixed(clampNonNegative(value), 0) ?? NOT_AVAILABLE_LABEL;
}

/*
 * ---------------------------------------------------------------------------
 * Counted words
 *
 * Every sentence a panel builds around a count — "1 row touched", "4 calls ·
 * loaded 9 of 9 spans", "1 operation was re-attached because its parent never
 * arrived" — has to agree with the number it prints. A component that
 * hand-rolls `count === 1 ? … : …` beside each figure eventually forgets one,
 * and the panel reads "1 rows". These helpers are the one agreement rule, and
 * they decide it from the count *as {@link formatCount} prints it*, so the
 * word can never disagree with the digits beside it.
 *
 * English only, deliberately: the product's copy is English and generic (AAP
 * 0.5.4), and a locale-aware plural rule would be an `Intl` dependency this
 * module forbids itself (see the header).
 * ---------------------------------------------------------------------------
 */

/**
 * A word or phrase in the two forms English agrees with a count.
 *
 * Usually a noun (`row`/`rows`, `request group`/`request groups`), but any
 * count-agreeing pair works the same way — a verb (`was`/`were`), a pronoun
 * (`its`/`their`) — which is how a sentence keeps its verb and pronouns in
 * step with the noun it counts without a second rule. Build one with
 * {@link countedNoun}; `one` is the form for a count that prints as `1`, and
 * `other` the form for every other count, zero included ("0 rows").
 */
export interface CountedNoun {
  /** The singular form, used when the count prints as exactly `1`. */
  readonly one: string;
  /** The plural form, used for every other count. */
  readonly other: string;
}

/**
 * Builds a frozen {@link CountedNoun}.
 *
 * The plural defaults to the regular English form, the singular with an `s`
 * appended, which covers the product's own vocabulary (`call`, `row`, `span`,
 * `operation`, `relationship`); pass `other` for anything irregular or for a
 * non-noun pair.
 *
 * @param one The singular form.
 * @param other The plural form; defaults to `one` followed by `s`.
 *
 * @example
 * ```ts
 * countedNoun('nested call'); // { one: 'nested call', other: 'nested calls' }
 * countedNoun('was', 'were'); // a verb that agrees with the same count
 * ```
 */
export function countedNoun(one: string, other = `${one}s`): CountedNoun {
  return Object.freeze({ one, other });
}

/**
 * Whether a count takes the singular: exactly when {@link formatCount} prints
 * it as `1`.
 *
 * Decided from the printed text rather than from `count === 1`, so a count that
 * arrived as a floating-point sum (`0.9999999`) prints `1` *and* takes the
 * singular. Zero, every other count and an unmeasurable count (printed as
 * {@link NOT_AVAILABLE_LABEL}) take the plural.
 */
function takesSingular(count: number): boolean {
  return formatCount(count) === '1';
}

/**
 * The form of `noun` that agrees with `count`, without the number.
 *
 * For the words around a count that are not the counted noun itself — the verb
 * and the pronouns of the same sentence — and for a noun whose number is
 * printed elsewhere ("loaded 9 of 9 spans" agrees its noun with the total).
 *
 * @param count The count the word agrees with.
 * @param noun A {@link CountedNoun}, or a singular noun with a regular `-s`
 * plural.
 *
 * @example
 * ```ts
 * pluralize(1, 'row'); // 'row'
 * pluralize(0, 'row'); // 'rows'
 * pluralize(4, countedNoun('was', 'were')); // 'were'
 * ```
 */
export function pluralize(count: number, noun: CountedNoun | string): string {
  const singular = takesSingular(count);

  if (typeof noun === 'string') {
    return singular ? noun : `${noun}s`;
  }

  return singular ? noun.one : noun.other;
}

/**
 * A count followed by the form of `noun` that agrees with it: the
 * {@link formatCount} text, one space, and {@link pluralize}'s word.
 *
 * The entry point for "N things": badges, footers, descriptions and notes.
 * Degenerate counts follow {@link formatCount} — a negative count prints `0`
 * with the plural, and `NaN` prints {@link NOT_AVAILABLE_LABEL} with the plural.
 *
 * @param count The count to print.
 * @param noun A {@link CountedNoun}, or a singular noun with a regular `-s`
 * plural.
 *
 * @example
 * ```ts
 * formatCountOf(1, 'row'); // '1 row'
 * formatCountOf(1240, 'row'); // '1,240 rows'
 * formatCountOf(2, countedNoun('nested call')); // '2 nested calls'
 * ```
 */
export function formatCountOf(count: number, noun: CountedNoun | string): string {
  return `${formatCount(count)} ${pluralize(count, noun)}`;
}

/**
 * Formats a fraction of one as a percentage, to one decimal place.
 *
 * The input is a **fraction**, not an already-scaled percentage: `0.423` prints
 * as `42.3%`. One decimal is fixed so a column of shares aligns, and values
 * above `1` are printed rather than clipped — a share that exceeds the whole is
 * a finding, and hiding it would hide the finding.
 *
 * Degenerate inputs: a negative fraction clamps to `0`, giving `0.0%`; `NaN`
 * and `Infinity` → {@link NOT_AVAILABLE_LABEL}. Use {@link formatShare} when
 * the fraction is a quotient, so that a zero denominator is handled before the
 * division rather than after it.
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return NOT_AVAILABLE_LABEL;
  }

  const value = groupedFixed(clampNonNegative(fraction) * 100, PERCENT_DECIMALS);

  return value === undefined ? NOT_AVAILABLE_LABEL : `${value}%`;
}

/**
 * Formats `part / total` as a percentage, guarding the division itself.
 *
 * The per-tier share of a total duration, a duplicate share of a request group,
 * an unchanged share of a render count: every one of those is a quotient whose
 * denominator can legitimately be zero, and this is the boundary that decides
 * what that means. A total of `0` (or a negative, `NaN` or infinite total)
 * yields {@link NOT_AVAILABLE_LABEL} rather than `0%`: there is no whole to take
 * a share of, and `0%` would assert that the part was measured and found
 * negligible. `"NaN%"` is therefore unreachable by construction.
 *
 * @param part The measured part, in the same unit as `total`.
 * @param total The whole the part is a share of.
 */
export function formatShare(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
    return NOT_AVAILABLE_LABEL;
  }

  return formatPercent(part / total);
}

/*
 * ---------------------------------------------------------------------------
 * Text: collapsing and the privacy-bounded preview
 * ---------------------------------------------------------------------------
 */

/**
 * Collapses every run of whitespace — including newlines and tabs — into one
 * space and trims the ends.
 *
 * A captured statement, an error message and a stack-derived label all arrive
 * multi-line, and a raw newline inside a table cell changes that row's height
 * and breaks the alignment of every column beside it. Collapsing is a display
 * decision only: the stored event keeps its original text, which the detail
 * drawer can show in full.
 *
 * @example
 * ```ts
 * collapseWhitespace('SELECT 1\n  FROM t'); // 'SELECT 1 FROM t'
 * ```
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Truncates text to at most `maxLength` **code points**, ellipsis included in
 * the budget.
 *
 * The budget defaults to {@link MAX_PREVIEW_LENGTH}, the 120-code-point privacy
 * bound AAP 0.5.2 fixes on a captured preview: the renderer never displays more
 * than the producer was allowed to capture, so the default is the guarantee and
 * a caller passing a *smaller* budget is the only sanctioned deviation.
 *
 * Counting is by code point, not by UTF-16 unit, so an astral character — an
 * emoji in a state value, a character outside the basic plane in a label — is
 * never cut in half into a lone surrogate. Text already within the budget is
 * returned as the same string, with no copy and no scan of its code points.
 *
 * Boundary behaviour: a budget of `0` or less yields the empty string; a budget
 * of exactly `1` yields the ellipsis alone; the empty string is returned
 * unchanged; and a fractional budget is truncated toward zero.
 *
 * @param text The text to shorten.
 * @param maxLength Maximum code points in the result, ellipsis included.
 * @returns Text of at most `maxLength` code points.
 */
export function truncate(text: string, maxLength: number = MAX_PREVIEW_LENGTH): string {
  const budget = Number.isFinite(maxLength) ? Math.trunc(maxLength) : MAX_PREVIEW_LENGTH;

  if (budget <= 0) {
    return '';
  }
  // A string's UTF-16 length is an upper bound on its code-point count, so this
  // is a sound early exit and keeps the common case allocation-free.
  if (text.length <= budget) {
    return text;
  }

  const points = Array.from(text);
  if (points.length <= budget) {
    return text;
  }

  return `${points.slice(0, budget - ELLIPSIS_COST).join('')}${ELLIPSIS}`;
}

/**
 * Collapses text to one line and truncates it to the preview budget.
 *
 * The formatter every table cell that shows captured text uses: a redacted
 * statement in the query table, an error message in the event log, a value
 * summary in the state-transition view. Equivalent to
 * `truncate(collapseWhitespace(text), maxLength)`, named so that a cell cannot
 * accidentally apply one half without the other.
 *
 * @param text The captured text.
 * @param maxLength Maximum code points; defaults to {@link MAX_PREVIEW_LENGTH}.
 */
export function oneLinePreview(text: string, maxLength: number = MAX_PREVIEW_LENGTH): string {
  return truncate(collapseWhitespace(text), maxLength);
}

/*
 * ---------------------------------------------------------------------------
 * Label fitting in logical units
 *
 * The SVG views place labels in or beside bars, frames and boxes whose widths
 * are data, so each must know whether a label fits before drawing it. They are
 * laid out in a fixed logical coordinate space (`./scale`'s
 * `CHART_VIEWBOX_WIDTH`, or a graph's own deterministic size) that CSS scales
 * to its container, and a label set in the stylesheet's type role is exactly
 * that many user units tall however the drawing is scaled — so a label's fit
 * is decided once, in logical units, and holds at every panel width. Nothing
 * here reads the DOM, measures a font or depends on layout: the advance of a
 * string is the deterministic estimate below, which is what lets every chart
 * render identically in a browser and under a layout-free test DOM.
 *
 * A character budget cannot answer the question — glyphs differ in advance (an
 * emoji is roughly two columns wide in a monospace run), and a budget wrong by
 * one glyph draws the ellipsis outside the frame it was meant to end — so the
 * estimate works per grapheme, and {@link fitTextToWidth} never splits one.
 * ---------------------------------------------------------------------------
 */

/**
 * Measures a string's advance width in SVG user units, in one fixed font.
 *
 * A measure is expected to be monotonic in the text — appending a grapheme
 * never makes a string narrower — which {@link fitTextToWidth} relies on to
 * search for a fit rather than try every length.
 */
export type TextMeasure = (text: string) => number;

/**
 * The advance {@link estimateTextWidth} assumes for one narrow grapheme, as a
 * fraction of the font size: 0.6 em, the advance of the common monospace faces
 * and wider than the average glyph of a proportional UI face, so the estimate
 * errs towards "does not fit".
 */
export const ESTIMATE_NARROW_ADVANCE_EM = 0.6;

/**
 * The advance {@link estimateTextWidth} assumes for one wide grapheme — an
 * emoji, or an East Asian wide or fullwidth character: 1.25 em, a little more
 * than a colour-emoji glyph or a CJK ideograph occupies.
 */
export const ESTIMATE_WIDE_ADVANCE_EM = 1.25;

/**
 * The font size, in SVG user units, an estimate assumes when none is given:
 * 11, the size of the package's `monoSm` and `textXs` type roles, which chart
 * labels are set in.
 */
export const DEFAULT_LABEL_FONT_SIZE = 11;

/**
 * A grapheme that occupies two columns: an emoji (Extended_Pictographic), or a
 * character from the East Asian wide and fullwidth blocks.
 */
const WIDE_GRAPHEME =
  /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

/**
 * The grapheme segmenter, created on first use rather than on import so that
 * importing this module still reads nothing. `null` records a platform without
 * `Intl.Segmenter`. Grapheme boundaries (UAX #29) do not vary by locale, so
 * this is not a locale-dependent formatter: it decides only where one
 * user-perceived character ends and the next begins.
 */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/** The shared grapheme segmenter, or `null` where the platform has none. */
function segmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return graphemeSegmenter;
}

/**
 * Splits `text` into graphemes — user-perceived characters — so a truncation
 * never cuts an emoji's surrogate pair, a flag's regional-indicator pair or a
 * letter from its combining accent.
 *
 * Uses `Intl.Segmenter` where available and falls back to code points, which
 * still keeps surrogate pairs together.
 */
export function splitGraphemes(text: string): string[] {
  const graphemes = segmenter();
  if (graphemes !== null) {
    return Array.from(graphemes.segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}

/** `value` when it is finite and strictly positive, otherwise `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The estimated advance width of `text` at `fontSize` user units:
 * {@link ESTIMATE_NARROW_ADVANCE_EM} per grapheme and
 * {@link ESTIMATE_WIDE_ADVANCE_EM} per wide grapheme.
 *
 * Deterministic and platform-free. A non-finite or non-positive `fontSize`
 * uses {@link DEFAULT_LABEL_FONT_SIZE}.
 *
 * @example
 * ```ts
 * estimateTextWidth('abcd', 10); // 24 — four narrow graphemes at 0.6 em
 * ```
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  const size = positiveOr(fontSize, DEFAULT_LABEL_FONT_SIZE);
  let ems = 0;
  for (const grapheme of splitGraphemes(text)) {
    ems += WIDE_GRAPHEME.test(grapheme) ? ESTIMATE_WIDE_ADVANCE_EM : ESTIMATE_NARROW_ADVANCE_EM;
  }
  return ems * size;
}

/**
 * A {@link TextMeasure} backed by {@link estimateTextWidth} at `fontSize`
 * user units — the measure every SVG view fits its labels with.
 */
export function createEstimateMeasure(fontSize: number = DEFAULT_LABEL_FONT_SIZE): TextMeasure {
  const size = positiveOr(fontSize, DEFAULT_LABEL_FONT_SIZE);
  return (text) => estimateTextWidth(text, size);
}

/** A string that fits a width, as {@link fitTextToWidth} returns it. */
export interface TextFit {
  /** The text to draw: the input unchanged, or a prefix ending in {@link ELLIPSIS}. */
  readonly text: string;
  /** Its advance width in user units, never more than the width asked for. */
  readonly width: number;
  /** Whether the input was shortened. */
  readonly truncated: boolean;
}

/** Options of {@link fitTextToWidth}. */
export interface FitTextOptions {
  /**
   * The fewest graphemes of the input a truncated result may keep before its
   * ellipsis; a width that cannot hold that many yields no fit at all. Defaults
   * to `1`. A label of one letter and an ellipsis still identifies a frame in a
   * sequence; a caller for whom it would not raises this.
   */
  readonly minGraphemes?: number;
}

/** A measure's answer made safe to compare: a non-finite or negative width never fits. */
function measured(measure: TextMeasure, text: string): number {
  const width = measure(text);
  return typeof width === 'number' && Number.isFinite(width) && width >= 0
    ? width
    : Number.POSITIVE_INFINITY;
}

/**
 * The longest form of `text` that fits `maxWidth` user units in the font
 * `measure` measures in: the whole string when it fits, otherwise the longest
 * grapheme prefix that fits with {@link ELLIPSIS} appended, otherwise
 * `undefined`.
 *
 * Trailing whitespace is trimmed before the ellipsis, so a cut never draws
 * "name …". The search is a binary search over prefix lengths, so fitting a
 * long label costs a logarithmic number of measurements.
 *
 * `undefined` — draw nothing — is returned for empty text, for a `maxWidth`
 * that is not finite and positive, and when not even `minGraphemes` graphemes
 * and the ellipsis fit.
 *
 * @param text The label.
 * @param maxWidth The room available, in user units.
 * @param measure Measures a string in the label's font.
 * @param options The shortest acceptable prefix.
 */
export function fitTextToWidth(
  text: string,
  maxWidth: number,
  measure: TextMeasure,
  options: FitTextOptions = {},
): TextFit | undefined {
  if (text.length === 0 || !(Number.isFinite(maxWidth) && maxWidth > 0)) {
    return undefined;
  }

  const whole = measured(measure, text);
  if (whole <= maxWidth) {
    return { text, width: whole, truncated: false };
  }

  const graphemes = splitGraphemes(text);
  const requested = options.minGraphemes;
  const minimum =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0 ? requested : 1;

  let low = minimum;
  let high = graphemes.length - 1;
  let best: TextFit | undefined;

  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const prefix = graphemes.slice(0, keep).join('').trimEnd();
    const candidate = prefix + ELLIPSIS;
    const width = measured(measure, candidate);

    if (width <= maxWidth) {
      // A prefix of nothing but whitespace trims to a bare ellipsis, which
      // names nothing; it is not a fit, but a longer prefix may still be.
      if (prefix.length > 0) {
        best = { text: candidate, width, truncated: true };
      }
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }

  return best;
}

/*
 * ---------------------------------------------------------------------------
 * Metric values
 *
 * Formatted by UNIT, never by id: the metric vocabulary belongs to
 * `packages/telemetry/src/aggregate/summary.ts`, and a renderer that switched
 * on ids would have to be edited every time a metric was added.
 * ---------------------------------------------------------------------------
 */

/** How one metric's value is formatted. */
type MetricUnitFormatter = (value: number) => string;

/**
 * The formatter each metric unit resolves to.
 *
 * Typed as a `Record` over the closed unit vocabulary, so a unit added upstream
 * fails to compile here until it has been given a formatter — which is the
 * intended way to find this table. The lookup below is still defensive: metric
 * values are read back from a store an older build may not share a vocabulary
 * with, and a table miss must not take a panel down mid-render.
 */
const METRIC_UNIT_FORMATTERS: Readonly<Record<MetricUnit, MetricUnitFormatter>> = Object.freeze({
  milliseconds: (value: number): string => formatDuration(value),
  count: (value: number): string => formatCount(value),
  bytes: (value: number): string => formatBytes(value),
});

/**
 * The fallback for a unit this build does not recognise: a grouped number with
 * no unit suffix.
 *
 * Deliberately unitless. Guessing a unit would let a count render as `4 ms`,
 * which reads as plausible and is wrong; a bare number makes no claim about
 * what it measures while still showing the reader the figure that was captured.
 */
function formatUnitlessNumber(value: number): string {
  return groupedFixed(value, UNITLESS_DECIMALS) ?? NOT_AVAILABLE_LABEL;
}

/**
 * The metric's number, or `undefined` when the capture could not measure it.
 *
 * One predicate for the three ways a metric can be absent — `available: false`,
 * a missing `value`, or a value that is not finite — so the string formatter and
 * the structured formatter can never disagree about whether a card is a number
 * or an `n/a`.
 */
function metricNumber(metric: MetricValue): number | undefined {
  if (!metric.available) {
    return undefined;
  }

  const { value } = metric;

  return value === undefined || !Number.isFinite(value) ? undefined : value;
}

/**
 * Formats one metric value as the text its card shows.
 *
 * An unmeasured metric — `available: false`, no `value`, or a non-finite value —
 * returns exactly {@link NOT_AVAILABLE_LABEL}: never `0`, never an empty string
 * and never a dash. That is a correctness requirement rather than a cosmetic
 * one. `transferred_bytes` is unmeasurable in an ordinary capture (a transfer
 * size is exposed for same-origin responses only, and a server span reports
 * none), AAP 0.6.6 records it as a known gap, and substituting a zero would
 * present an absence as an observation.
 *
 * A measured metric is dispatched on its unit: milliseconds through
 * {@link formatDuration}, counts through {@link formatCount}, bytes through
 * {@link formatBytes}, and a unit this build does not know through a unitless
 * grouped number.
 */
export function formatMetricValue(metric: MetricValue): string {
  const value = metricNumber(metric);
  if (value === undefined) {
    return NOT_AVAILABLE_LABEL;
  }

  const formatter: MetricUnitFormatter | undefined = METRIC_UNIT_FORMATTERS[metric.unit];

  return (formatter ?? formatUnitlessNumber)(value);
}

/**
 * One metric, ready for a card: its identity, its heading, its text and its
 * caveat.
 *
 * `note` is carried through untouched so a card can render the coverage caveat
 * beside an `n/a` — which is what turns "not measured" into "not measurable,
 * and here is why". It is product prose written by the aggregate layer, never a
 * captured value, so it is displayed verbatim.
 */
export interface MetricDisplay {
  /** Which metric this is, for the card's key and its detail link. */
  readonly id: MetricId;
  /** The card's heading, as the aggregate layer labelled it. */
  readonly label: string;
  /** The formatted value, or {@link NOT_AVAILABLE_LABEL}. */
  readonly text: string;
  /** Whether `text` is a measured number rather than the absent label. */
  readonly available: boolean;
  /** The metric's coverage caveat, when it carries one. */
  readonly note?: string;
}

/**
 * Formats one metric value into everything its card needs, in one pass.
 *
 * The entry point `MetricCards.tsx` uses: it pairs the formatted text with the
 * availability flag the card styles itself from, so a card never re-derives
 * availability by comparing strings, and it passes `note` through when the
 * metric carries one (omitting the property entirely otherwise, which
 * `exactOptionalPropertyTypes` requires).
 */
export function formatMetric(metric: MetricValue): MetricDisplay {
  const value = metricNumber(metric);

  return {
    id: metric.id,
    label: metric.label,
    text: value === undefined ? NOT_AVAILABLE_LABEL : formatMetricValue(metric),
    available: value !== undefined,
    ...(metric.note === undefined ? {} : { note: metric.note }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Paths and source locations
 *
 * Pure string work: no filesystem, no platform path module. A source location's
 * `file` is project-relative with POSIX separators by contract, which is what
 * makes these helpers total without one.
 * ---------------------------------------------------------------------------
 */

/** Trailing path segments a compact path keeps by default. */
export const DEFAULT_PATH_SEGMENTS = 2;

/**
 * Shortens a project-relative path for display, keeping its last segments.
 *
 * A chip, a table cell and a graph node caption all have to identify a file in
 * a few characters, and the identifying part of a path is its tail: the file
 * name plus enough of its parent directory to separate two files of the same
 * name. Deeper ancestors are replaced by a leading ellipsis, so the result
 * always shows *that* it was shortened.
 *
 * Separators are normalised with the shared `toPosix` (a path that reached the
 * renderer from a platform-specific producer may carry backslashes) and the
 * final component is taken with the shared `basenamePosix`, so a trailing
 * separator is ignored. Nothing here touches a filesystem.
 *
 * Degenerate inputs: the empty string returns the empty string; a path with no
 * final component (the root separator) is returned as-is; a `maxSegments` below
 * one is treated as one; a path with no more segments than the budget is
 * returned whole, with a leading separator preserved when it had one.
 *
 * @param file A path, conventionally the project-relative `file` of a source
 * location.
 * @param maxSegments How many trailing segments to keep; defaults to
 * {@link DEFAULT_PATH_SEGMENTS}.
 *
 * @example
 * ```ts
 * formatCompactPath('src/components/ComponentA.tsx'); // '…/components/ComponentA.tsx'
 * formatCompactPath('src/thing.ts'); // 'src/thing.ts'
 * ```
 */
export function formatCompactPath(
  file: string,
  maxSegments: number = DEFAULT_PATH_SEGMENTS,
): string {
  const posix = toPosix(file);
  if (basenamePosix(posix).length === 0) {
    return posix;
  }

  const budget = Number.isFinite(maxSegments) ? Math.max(1, Math.trunc(maxSegments)) : 1;
  const segments = posix.split('/').filter((segment) => segment.length > 0);

  if (segments.length <= budget) {
    return isAbsolutePosix(posix) ? `/${segments.join('/')}` : segments.join('/');
  }

  return `${ELLIPSIS}/${segments.slice(-budget).join('/')}`;
}

/**
 * The short label of a source-location chip: a compact path and a line.
 *
 * Deliberately *not* the canonical form. `formatSourceLocation` from
 * `@debuggen/shared` renders `file:line:column` with the whole path, and that is
 * what a log line, a diagnostic and this chip's title use — one string, so a
 * developer reading a path in a log and the same path on a chip can see they are
 * the same place. This label drops the column and abbreviates the path because a
 * chip has a few characters to work with; the column is noise at that size and
 * the path's tail is what identifies the file. A chip therefore shows this and
 * carries {@link formatSourceTooltip} as its accessible title, so nothing is
 * lost.
 *
 * @param location A validated source location.
 * @param maxSegments Trailing path segments to keep; defaults to
 * {@link DEFAULT_PATH_SEGMENTS}.
 */
export function formatSourceChipLabel(
  location: SourceLocation,
  maxSegments: number = DEFAULT_PATH_SEGMENTS,
): string {
  return `${formatCompactPath(location.file, maxSegments)}:${String(location.line)}`;
}

/**
 * The full label of a source location, symbol first when one is known.
 *
 * Built on the shared `formatSourceLocation` rather than re-deriving its output:
 * the `file:line:column` part is character-for-character the canonical form, and
 * this function only prefixes the `symbol` the canonical form deliberately
 * leaves out — the name of the function, component or handler, which is the
 * first thing a reader wants and the part a chip renders in its own style.
 *
 * Used as the title of a source chip and of any row that links to source.
 *
 * @param location A validated source location.
 * @returns `'symbol — file:line:column'`, or just `'file:line:column'` when the
 * location carries no symbol.
 */
export function formatSourceTooltip(location: SourceLocation): string {
  const canonical = formatSourceLocation(location);

  return location.symbol === undefined ? canonical : `${location.symbol} — ${canonical}`;
}

/*
 * ---------------------------------------------------------------------------
 * Readable labels for the closed telemetry vocabularies
 *
 * `./color` maps these vocabularies onto tokens and states that their readable
 * text belongs here, so the two decisions live in one module each and a legend,
 * a filter menu and a table row cannot disagree about what a value is called.
 * Each table is a `Record` over its union — total by construction — and each
 * lookup falls back to {@link humanizeLabel} rather than throwing, because
 * these run inside a render and telemetry can arrive from a producer newer than
 * this build.
 * ---------------------------------------------------------------------------
 */

/**
 * Turns a machine token into readable text: separators become spaces and the
 * first letter is capitalised.
 *
 * `.`, `_`, `-` and `:` are all treated as separators, so a dotted kind, a
 * snake-cased attribute key and a kebab-cased identifier all read the same way.
 * Only the first word is capitalised — title case would fight the product's
 * dense, sentence-case user interface — and the empty string is returned
 * unchanged.
 *
 * This is also the fallback every label table below uses for a value it has no
 * entry for, which is what lets an unrecognised value still render as words
 * rather than as raw text or not at all.
 *
 * @example
 * ```ts
 * humanizeLabel('perf.longtask'); // 'Perf longtask'
 * ```
 */
export function humanizeLabel(value: string): string {
  const words = value
    .split(/[._:-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  const sentence = words.join(' ');
  const first = sentence.slice(0, 1);

  return first.length === 0 ? '' : `${first.toUpperCase()}${sentence.slice(1)}`;
}

/**
 * The readable name of each telemetry kind.
 *
 * Product vocabulary, not producer vocabulary: a reader scanning an event log
 * should see what an entry *is*, not which observer reported it, so
 * `perf.longtask` reads as a long task and `http.client` as an outgoing
 * request. Total over the kind union by annotation, and frozen.
 */
export const KIND_LABELS: Readonly<Record<TelemetryKind, string>> = Object.freeze({
  interaction: 'Interaction',
  render: 'Render',
  commit: 'Commit',
  fetch: 'Fetch',
  xhr: 'XHR',
  navigation: 'Navigation',
  'perf.longtask': 'Long task',
  'perf.entry': 'Performance entry',
  error: 'Error',
  state: 'State change',
  'http.server': 'Server request',
  'route.handler': 'Route handler',
  function: 'Function',
  'db.query': 'Database query',
  'http.client': 'Outgoing request',
  'server.error': 'Server error',
  log: 'Log',
});

/**
 * The readable name of a telemetry kind, falling back to
 * {@link humanizeLabel} for a kind this build does not know.
 *
 * Never throws: an unrecognised kind still gets readable text, because dropping
 * the row would hide captured evidence.
 */
export function formatKindLabel(kind: TelemetryKind): string {
  const label: string | undefined = KIND_LABELS[kind];

  return label ?? humanizeLabel(kind);
}

/**
 * The readable name of each tier, for a badge or a filter option.
 *
 * **Mirrors `TIER_LANE_LABELS` in `packages/telemetry/src/aggregate/timeline.ts`,
 * which is the authority for these three words.** It is mirrored rather than
 * imported for the same reason {@link MAX_PREVIEW_LENGTH} is: that table is a
 * runtime value and telemetry is a type-only dependency of this package (AAP
 * 0.2.2), so importing it would add a runtime edge the layering forbids.
 *
 * Mirrored, and therefore narrowly scoped: a timeline, waterfall or flame lane
 * must render the label carried on its own lane data — the aggregate already
 * put it there — and must not call {@link formatTierLabel}. This table exists
 * for the places no lane object is in hand, such as a tier badge on a span row
 * or a tier entry in a filter menu, where the alternative is the raw `db`.
 */
export const TIER_LABELS: Readonly<Record<TelemetryTier, string>> = Object.freeze({
  browser: 'Browser',
  server: 'Server',
  db: 'Database',
});

/** The readable name of a tier, falling back to {@link humanizeLabel}. */
export function formatTierLabel(tier: TelemetryTier): string {
  const label: string | undefined = TIER_LABELS[tier];

  return label ?? humanizeLabel(tier);
}

/**
 * The readable name of each span status.
 *
 * `unset` reads as `Unreported` rather than as `Unset`: the value means the
 * producer expressed no opinion, and a reader should not have to know the
 * vocabulary to understand that. `ok` is upper-cased as the initialism it is.
 */
export const STATUS_LABELS: Readonly<Record<TelemetryStatus, string>> = Object.freeze({
  unset: 'Unreported',
  ok: 'OK',
  error: 'Error',
});

/** The readable name of a span status, falling back to {@link humanizeLabel}. */
export function formatStatusLabel(status: TelemetryStatus): string {
  const label: string | undefined = STATUS_LABELS[status];

  return label ?? humanizeLabel(status);
}

/**
 * The readable name of each render trigger.
 *
 * The wording keeps the product's two distinct answers distinct, which is the
 * whole point of the trigger vocabulary: `unchanged` means the inputs were all
 * equal and the render was therefore avoidable, while `unknown` means the
 * trigger could not be determined and no claim is being made. Presenting the
 * second as the first would turn an inconclusive observation into a finding.
 */
export const RENDER_TRIGGER_LABELS: Readonly<Record<RenderTrigger, string>> = Object.freeze({
  props: 'Props changed',
  state: 'State changed',
  context: 'Context changed',
  unchanged: 'No change',
  unknown: 'Unknown',
});

/**
 * The readable name of a render trigger, falling back to
 * {@link humanizeLabel}.
 */
export function formatRenderTriggerLabel(trigger: RenderTrigger): string {
  const label: string | undefined = RENDER_TRIGGER_LABELS[trigger];

  return label ?? humanizeLabel(trigger);
}
