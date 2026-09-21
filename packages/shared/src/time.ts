/**
 * The product's canonical time base: one definition of what a timestamp is, and
 * every conversion that produces one.
 *
 * Three tiers put spans on a single timeline — the browser agent in the page,
 * the OpenTelemetry tracer inside the Next.js dev-server process, and the
 * database instrumentation in that same process — so exactly one answer to
 * "what is a timestamp?" may exist in this repository. That answer is fixed by
 * the telemetry event contract:
 *
 * - `startTime` is **Unix epoch milliseconds as a double**, carrying
 *   sub-millisecond precision in its fractional part.
 * - `duration` is **milliseconds**, likewise a double.
 *
 * Each producer reaches that representation from a different native clock, and
 * both routes live here so the two can never drift:
 *
 * - The browser agent has monotonic readings relative to a page origin
 *   (`PerformanceEntry.startTime`, `PerformanceEventTiming`, long tasks) and
 *   converts them with {@link performanceToEpochMs}, which is the
 *   `performance.timeOrigin + entry.startTime` computation the event contract
 *   prescribes.
 * - The Node exporter has OpenTelemetry `HrTime` pairs on a `ReadableSpan` and
 *   converts them with {@link hrTimeToEpochMs} and {@link hrTimeDurationMs}.
 *
 * Everything downstream then compares like with like: the correlator orders a
 * trace by `startTime`, the aggregates bucket and sum durations, the session
 * store writes record timestamps, and the renderer formats durations for
 * display. Every one of those places must get the same number for the same
 * instant, which is the whole purpose of this module — one conversion, one
 * rounding policy, one fallback.
 *
 * ## What is deliberately absent
 *
 * No clock-offset or clock-alignment logic. Both producers run on the same
 * machine, so no alignment is applied; the informational per-producer
 * `clockOffsetMs` belongs to the telemetry layer that records it, not to this
 * conversion layer.
 *
 * ## Import constraints
 *
 * `@debuggen/shared` is the base layer of the package graph, so this module
 * imports no workspace package and no third-party package. It is also part of
 * the browser-safe `"."` entry, which the page agent, the DevTools panel and
 * the VS Code webview all bundle, so it uses no Node builtin and no
 * `process.hrtime`: `globalThis.performance` exists in a page, in a worker and
 * in Node, and is the only ambient clock this module reads. That read is lazy —
 * performed inside each function rather than captured at module scope — so a
 * test can stub or remove the global between cases and so a bundle that is
 * evaluated before the host installs its globals cannot capture a stale one.
 */

import { DebuggenError } from './errors.js';

/** Milliseconds in one second. */
const MILLISECONDS_PER_SECOND = 1_000;

/** Nanoseconds in one millisecond — the `HrTime` remainder's scale. */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/** Nanoseconds in one second, the modulus of an `HrTime` pair's second member. */
const NANOSECONDS_PER_SECOND = 1_000_000_000;

/**
 * The largest magnitude `Date` can represent, in epoch milliseconds
 * (±100 000 000 days, the ECMAScript time-value limit).
 *
 * {@link isoFromEpochMs} checks against this rather than letting
 * `Date.prototype.toISOString` raise a bare `RangeError` from inside a
 * conversion helper.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * The largest decimal count {@link roundMs} accepts.
 *
 * Beyond fifteen significant decimal places a double carries no information, so
 * a larger request is a caller mistake rather than a precision gain.
 */
const MAX_ROUNDING_DECIMALS = 15;

/**
 * How much of an unparseable timestamp {@link epochMsFromIso} repeats back.
 *
 * The offending string has to be identifiable in a log without a malformed
 * multi-kilobyte value being copied into an error that may be persisted with a
 * session.
 */
const MAX_REPORTED_TEXT_LENGTH = 64;

/**
 * A high-resolution instant as a `[seconds, nanoseconds]` pair.
 *
 * Intentionally **structurally compatible with OpenTelemetry's `HrTime`**: the
 * Node preload's span exporter hands a `ReadableSpan`'s `startTime` and
 * `endTime` straight to {@link hrTimeToEpochMs} and {@link hrTimeDurationMs}
 * without `@debuggen/shared` taking an `@opentelemetry/*` dependency, which it
 * must not do — this package is the base layer of the package graph and is
 * bundled into browser code that has no OpenTelemetry SDK in it. Declaring the
 * shape locally keeps the dependency edge out and still type-checks the call
 * sites, because OpenTelemetry's own `HrTime` is the same tuple.
 *
 * The element labels are for readability only; they carry no runtime meaning.
 * The first member is whole seconds since the Unix epoch and the second is the
 * nanosecond remainder within that second, so `nanoseconds` is always in
 * `[0, 1_000_000_000)` for a well-formed pair — which is what
 * {@link epochMsToHrTime} guarantees for the pairs it produces.
 */
export type HrTime = readonly [seconds: number, nanoseconds: number];

/**
 * A normalised reading of the ambient `performance` clock.
 *
 * Module-internal: the probe below flattens whatever `globalThis.performance`
 * happens to be into these two values, so every consumer in this file branches
 * on plain numbers instead of repeating the same duck-typing.
 */
interface ClockReading {
  /** `performance.now()` at the moment of the probe, in milliseconds. */
  readonly relativeMs: number;

  /**
   * `performance.timeOrigin`, or `undefined` when the object exposes no finite
   * one (a stub, a shimmed worker clock, an older host).
   */
  readonly timeOrigin: number | undefined;
}

/**
 * Reads `globalThis.performance` and returns a {@link ClockReading}, or
 * `undefined` when no usable clock is present.
 *
 * Duck-typed on purpose. This module is bundled for a page, a worker, the
 * DevTools panel, the VS Code webview and Node, and it is also the unit under
 * test in a suite that stubs the global; trusting the ambient type declaration
 * would turn any of those into a `TypeError` at runtime. The `now` function is
 * invoked with the `performance` object as its receiver, because a host
 * implementation is free to require one, and its result is re-checked: a stub
 * that returns something other than a finite number is treated as no clock at
 * all rather than poisoning a timestamp with `NaN`.
 *
 * @returns The reading, or `undefined` when `performance` is missing, is not an
 * object, has no callable `now`, or returned a non-finite value.
 */
function probePerformanceClock(): ClockReading | undefined {
  const candidate: unknown = (globalThis as { readonly performance?: unknown }).performance;
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }

  const clock = candidate as { readonly now?: unknown; readonly timeOrigin?: unknown };
  if (typeof clock.now !== 'function') {
    return undefined;
  }

  const relativeMs: unknown = (clock.now as () => unknown).call(candidate);
  if (typeof relativeMs !== 'number' || !Number.isFinite(relativeMs)) {
    return undefined;
  }

  const { timeOrigin } = clock;
  return {
    relativeMs,
    timeOrigin:
      typeof timeOrigin === 'number' && Number.isFinite(timeOrigin) ? timeOrigin : undefined,
  };
}

/**
 * The current instant in epoch milliseconds, at millisecond resolution.
 *
 * `Date.now()`, and nothing more. This is the function for **record**
 * timestamps — `createdAt` and `updatedAt` on a session, a modification or a
 * capture row in the session store, and the time on a log record — where a
 * whole millisecond is the unit the field is defined in and a wall-clock
 * reading is what a human later compares against a file's mtime.
 *
 * Span start times use {@link nowEpochMsPrecise} instead, because ordering
 * within one interaction routinely happens inside a single millisecond.
 *
 * @returns Whole epoch milliseconds.
 */
export function nowEpochMs(): number {
  return Date.now();
}

/**
 * The current instant in epoch milliseconds, with sub-millisecond precision
 * where the host can supply it.
 *
 * This is the function that gives a span start time its fractional part:
 * `performance.timeOrigin + performance.now()` reads a monotonic counter
 * against the document's (or process's) epoch origin, which is both finer than
 * a millisecond and immune to a wall-clock adjustment mid-capture. It is what
 * the browser agent and the patched-function span helper use to stamp events
 * they observe directly, rather than through a `PerformanceEntry`.
 *
 * When no usable clock is present the value degrades to `Date.now()`. That
 * loses resolution — two events in the same millisecond become equal — but it
 * does not break ordering: the event contract's canonical order falls through
 * to the per-producer sequence number and then to the store's ingest sequence,
 * both of which are always distinct. A missing clock therefore costs precision
 * and never correctness.
 *
 * @returns Epoch milliseconds, fractional when the host clock allows it.
 */
export function nowEpochMsPrecise(): number {
  const reading = probePerformanceClock();
  if (reading !== undefined && reading.timeOrigin !== undefined) {
    return reading.timeOrigin + reading.relativeMs;
  }
  return Date.now();
}

/**
 * Converts an OpenTelemetry-shaped `[seconds, nanoseconds]` pair to epoch
 * milliseconds.
 *
 * `seconds * 1_000 + nanoseconds / 1_000_000`. The nanosecond remainder is
 * **preserved as a fraction of a millisecond** rather than truncated — that
 * fraction *is* the sub-millisecond precision the event contract requires, and
 * dropping it would collapse the ordering of spans that start inside the same
 * millisecond, which every fast server handler does.
 *
 * This is the Node exporter's conversion: `ReadableSpan.startTime` and
 * `.endTime` arrive as exactly this tuple, and the span's `TelemetryEvent`
 * carries the result. A duration is computed with {@link hrTimeDurationMs}
 * rather than by subtracting two results of this function, because the
 * difference of two large doubles loses the precision the pair still had.
 *
 * ## Precision at present-day epoch values
 *
 * A double has 53 bits of mantissa, so at a 2020s epoch value (≈1.7 × 10¹²
 * milliseconds) the spacing between representable numbers is roughly a
 * quarter of a microsecond. Nanosecond input is therefore rounded to about
 * microsecond resolution by the representation itself — which is exactly why
 * {@link roundMs} exists and why its default of three decimals is the
 * documented precision floor for a stored `startTime`.
 *
 * Input is taken at face value: a non-finite member propagates to `NaN` instead
 * of throwing, because this conversion sits on the hot path of every exported
 * span and its input comes from an OpenTelemetry SDK that produced the pair
 * itself. Rejection is the job of the boundary conversions that would otherwise
 * produce a nonsense artefact — {@link epochMsToHrTime} and the two ISO
 * helpers.
 *
 * @param hrTime A `[seconds, nanoseconds]` pair, where `seconds` is whole
 * seconds since the Unix epoch.
 * @returns Epoch milliseconds, fractional when the pair carries a
 * sub-millisecond remainder.
 */
export function hrTimeToEpochMs(hrTime: HrTime): number {
  const [seconds, nanoseconds] = hrTime;
  return seconds * MILLISECONDS_PER_SECOND + nanoseconds / NANOSECONDS_PER_MILLISECOND;
}

/**
 * Converts epoch milliseconds back to an OpenTelemetry-shaped
 * `[seconds, nanoseconds]` pair.
 *
 * The inverse of {@link hrTimeToEpochMs}, for the places that have to hand a
 * timestamp the product observed (a browser event, a patched function's start)
 * to something that speaks `HrTime` — a span created with an explicit
 * `startTime`, or a fixture that has to look like SDK output.
 *
 * The split is `Math.floor(epochMs / 1_000)` whole seconds plus the remaining
 * milliseconds scaled to nanoseconds and rounded, so the pair is always
 * well-formed: `nanoseconds` is an integer in `[0, 1_000_000_000)`. Rounding
 * that remainder can reach a full second's worth of nanoseconds — an input of
 * `999.9999999` scales to `1_000_000_000` exactly — so the **carry** is applied
 * explicitly: the second is incremented and the nanosecond member reduced by
 * one second, which keeps the invariant that a consumer comparing nanosecond
 * members within the same second can rely on.
 *
 * Using `Math.floor` rather than truncation keeps the invariant for pre-epoch
 * (negative) values too: the second goes more negative and the nanosecond
 * remainder stays non-negative, so the round trip through
 * {@link hrTimeToEpochMs} still returns the original instant.
 *
 * @param epochMs Epoch milliseconds, fractional part allowed.
 * @returns A well-formed pair.
 * @throws A `DebuggenError` with code `INTERNAL` when `epochMs` is not finite.
 * A `NaN` second would silently corrupt every ordering and grouping downstream,
 * so it is refused at the point of conversion, where the stack still names the
 * caller that produced it.
 */
export function epochMsToHrTime(epochMs: number): HrTime {
  if (!Number.isFinite(epochMs)) {
    throw new DebuggenError(
      'INTERNAL',
      `Cannot convert the non-finite epoch millisecond value ${String(epochMs)} to an hrTime pair.`,
      {
        // Stringified: `JSON.stringify` renders NaN and Infinity as `null`, and
        // these details may be logged or persisted with a session.
        details: { epochMs: String(epochMs) },
      },
    );
  }

  const seconds = Math.floor(epochMs / MILLISECONDS_PER_SECOND);
  const remainderMs = epochMs - seconds * MILLISECONDS_PER_SECOND;
  const nanoseconds = Math.round(remainderMs * NANOSECONDS_PER_MILLISECOND);

  if (nanoseconds >= NANOSECONDS_PER_SECOND) {
    return [seconds + 1, nanoseconds - NANOSECONDS_PER_SECOND];
  }
  return [seconds, nanoseconds];
}

/**
 * The elapsed milliseconds from `start` to `end`, computed pair-wise.
 *
 * Seconds and nanoseconds are differenced **separately** and only then combined
 * — `(endSeconds - startSeconds) * 1_000 + (endNanos - startNanos) / 1_000_000`
 * — so the full nanosecond resolution survives. Converting both pairs to epoch
 * milliseconds first and subtracting would quantise the answer to the spacing
 * of doubles at a present-day epoch value (roughly a quarter of a microsecond),
 * turning a short database query's duration into noise.
 *
 * This is how the Node exporter computes a span's `duration` from its
 * `startTime` and `endTime`.
 *
 * The result is signed: reversed arguments give a negative number, and no
 * clamping happens here. A caller that is publishing a duration passes the
 * result through {@link clampNonNegative}, so the decision to hide a negative
 * value is taken where it is visible rather than inside a subtraction.
 *
 * @param start The earlier pair, conventionally a span's `startTime`.
 * @param end The later pair, conventionally a span's `endTime`.
 * @returns Milliseconds from `start` to `end`; `0` for identical pairs and
 * negative when `end` precedes `start`.
 */
export function hrTimeDurationMs(start: HrTime, end: HrTime): number {
  const [startSeconds, startNanoseconds] = start;
  const [endSeconds, endNanoseconds] = end;
  return (
    (endSeconds - startSeconds) * MILLISECONDS_PER_SECOND +
    (endNanoseconds - startNanoseconds) / NANOSECONDS_PER_MILLISECOND
  );
}

/**
 * Resolves the epoch origin of the ambient `performance` clock, degrading in
 * two documented steps.
 *
 * Module-internal, and the only place the fallback order is written:
 *
 * 1. `performance.timeOrigin` when the host exposes a finite one. This is the
 *    exact value a `PerformanceEntry`'s relative times are measured against, so
 *    it is the only reading that makes the conversion exact.
 * 2. `Date.now() - performance.now()` when a clock exists without a usable
 *    origin. The two readings are taken microseconds apart rather than
 *    simultaneously, so the derived origin can be off by that much; relative
 *    ordering within the producer is unaffected because every entry is shifted
 *    by the same constant.
 * 3. `Date.now()` when there is no clock at all. Relative offsets are then
 *    added to "now" rather than to the page's start, which makes absolute
 *    values wrong by the page's age — the reason a caller with a real origin to
 *    hand should always pass it explicitly.
 *
 * @returns The resolved origin in epoch milliseconds.
 */
function resolveTimeOrigin(): number {
  const reading = probePerformanceClock();
  if (reading === undefined) {
    return Date.now();
  }
  if (reading.timeOrigin !== undefined) {
    return reading.timeOrigin;
  }
  return Date.now() - reading.relativeMs;
}

/**
 * Converts a `performance`-relative reading to epoch milliseconds.
 *
 * `timeOrigin + relativeMs`, which is the `performance.timeOrigin +
 * entry.startTime` computation the event contract prescribes for the browser
 * tier. It is the browser agent's conversion for every relative number a page
 * hands it: `PerformanceEntry.startTime` for resource, navigation and paint
 * entries, the `startTime`, `processingStart` and `processingEnd` of a
 * `PerformanceEventTiming` that times an interaction's handler, and a long
 * task's start.
 *
 * Plain addition, deliberately: no rounding happens here, so an entry's
 * fractional millisecond survives into the event and a caller that wants a
 * stable stored value applies {@link roundMs} at the point of persistence.
 *
 * Pass `timeOrigin` explicitly wherever it is available — the agent reads it
 * once per document and reuses it, which is both exact and cheaper than probing
 * the global per entry. When it is omitted the origin is resolved from
 * `globalThis.performance` with the documented two-step degradation of this
 * module's internal resolver. An explicitly supplied origin is used verbatim,
 * including a non-finite one: a caller that passes `NaN` gets `NaN` and sees
 * its own mistake, rather than a plausible-looking timestamp from a clock it
 * did not ask for.
 *
 * @param relativeMs Milliseconds since the clock's origin, as a
 * `PerformanceEntry` reports them.
 * @param timeOrigin The clock's epoch origin. Omit only when the caller has no
 * access to it.
 * @returns Epoch milliseconds, preserving `relativeMs`'s fractional part.
 */
export function performanceToEpochMs(relativeMs: number, timeOrigin?: number): number {
  const origin = timeOrigin ?? resolveTimeOrigin();
  return origin + relativeMs;
}

/**
 * Shifts a number by `places` decimal exponents, through its decimal
 * representation.
 *
 * Module-internal helper for {@link roundMs}. The shift is performed by
 * rewriting the exponent of the value's own shortest round-trip decimal form
 * (`Number.prototype.toExponential` with no argument) rather than by
 * multiplying by a power of ten, because the multiplication introduces the very
 * error the rounding is meant to remove: `1.2345 * 1000` is
 * `1234.5000000000002` and `1.0005 * 1000` is `1000.4999999999999`, so a
 * multiply-then-round policy rounds one of those up and the other down even
 * though both look like ties in decimal. Re-parsing `"1.2345e3"` and
 * `"1.0005e3"` yields the nearest double to the decimal value the developer
 * wrote, which is the number the rounding policy is defined over.
 *
 * @param value A finite number.
 * @param places Exponents to add; negative shifts right.
 * @returns The shifted value.
 */
function shiftDecimalExponent(value: number, places: number): number {
  // `toExponential()` always yields "<mantissa>e<sign><digits>". The
  // destructuring defaults describe shapes it cannot produce — a missing
  // exponent is read as `e0`, a missing mantissa as zero — so the helper stays
  // total without a branch that could never run.
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  return Number(`${mantissa}e${String(Number(exponent) + places)}`);
}

/**
 * Rounds a millisecond value to `decimals` decimal places, breaking ties
 * toward positive infinity.
 *
 * This is the product's single rounding policy, and it exists so that a
 * persisted event, a panel-data response and a test snapshot all carry the same
 * digits for the same instant. Floating-point arithmetic otherwise leaks its
 * noise into stored JSON — a duration that is `46.99999999999999` in one run
 * and `47.00000000000001` in the next is the same duration and must serialise
 * identically.
 *
 * Three decimals is the default and the **documented precision floor for a
 * stored `startTime` or `duration`**: microsecond resolution, which is all a
 * double retains at a present-day epoch value anyway (see
 * {@link hrTimeToEpochMs}).
 *
 * ## Policy
 *
 * - Rounding is defined over the value's decimal representation, not over the
 *   binary product of a multiplication, so `roundMs(1.2345)` is `1.235` and
 *   `roundMs(2.675, 2)` is `2.68` — the answers the digits imply.
 * - A tie goes toward positive infinity: `roundMs(1.5, 0)` is `2` and
 *   `roundMs(-1.5, 0)` is `-1`. Durations are non-negative, so this only ever
 *   applies to a negative value some caller has yet to clamp.
 * - A value that already has fewer decimals than requested is returned
 *   unchanged.
 * - `NaN`, `Infinity` and `-Infinity` are returned **unchanged**. Rounding is a
 *   presentation concern and must not be the thing that decides what a
 *   non-finite measurement means; the schema that validates the event, or the
 *   boundary conversion that refuses it, is where that belongs.
 *
 * @param value The millisecond value to round.
 * @param decimals Decimal places to keep; defaults to `3`.
 * @returns The rounded value, or `value` itself when it is not finite.
 * @throws A `DebuggenError` with code `INTERNAL` when `decimals` is not an
 * integer in `[0, 15]`. Beyond fifteen places a double carries no further
 * information, so such a request is a caller mistake rather than a precision
 * gain, and silently clamping it would hide the mistake.
 */
export function roundMs(value: number, decimals: number = 3): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ROUNDING_DECIMALS) {
    throw new DebuggenError(
      'INTERNAL',
      `roundMs requires an integer decimal count in [0, ${String(MAX_ROUNDING_DECIMALS)}]; received ${String(decimals)}.`,
      { details: { decimals: String(decimals) } },
    );
  }

  if (!Number.isFinite(value)) {
    return value;
  }

  return shiftDecimalExponent(Math.round(shiftDecimalExponent(value, decimals)), -decimals);
}

/**
 * Replaces a negative value — or `NaN` — with `0`.
 *
 * Durations are the reason this exists. A duration is computed by subtracting
 * two clock readings, and a handful of ordinary situations make that difference
 * slightly negative or unusable: a wall-clock adjustment between the two
 * readings, a start and an end inside the same millisecond where only one of
 * them came from a fine-grained clock, or a span whose end was reconstructed
 * after the fact. None of those means "time ran backwards"; they mean "this
 * took approximately no time", and a timeline lane, a waterfall bar and a sum
 * over a capture all need a non-negative number to be meaningful.
 *
 * `NaN` maps to `0` for the same reason and as a deliberate choice: the
 * alternative — propagating it — turns one unusable reading into an unusable
 * total for the whole capture, because `NaN` poisons every sum, comparison and
 * sort it takes part in. A zero is visibly uninformative in a user interface
 * and harmless in an aggregate, which is the better failure. A caller that
 * needs to *know* a measurement was unusable must check before clamping.
 *
 * `-0` is normalised to `0`, so a JSON round trip and an `Object.is` comparison
 * in a test agree.
 *
 * @param value Any number, conventionally a duration in milliseconds.
 * @returns `value` when it is positive, otherwise `0`.
 */
export function clampNonNegative(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return value > 0 ? value : 0;
}

/**
 * Formats epoch milliseconds as an ISO 8601 timestamp in UTC.
 *
 * The session store's timestamp pair, with {@link epochMsFromIso}: record-level
 * times — a session's `createdAt` and `updatedAt`, a modification's
 * `appliedAt`, a cleanup's `completedAt` — are written as ISO text, which is
 * readable in a database row, sorts lexicographically in the same order it
 * sorts chronologically, and carries its timezone with it.
 *
 * **Spans do not use this.** ISO text has millisecond granularity, so a
 * fractional millisecond is truncated by the conversion (`0.5` millisecond past
 * the epoch formats as `…T00:00:00.000Z`). That is lossy in exactly the digits
 * the event contract requires, which is why `startTime` and `duration` persist
 * as numeric epoch milliseconds and only record-level timestamps go through
 * here.
 *
 * @param epochMs Epoch milliseconds. A fractional part is truncated toward zero
 * by `Date`.
 * @returns An ISO 8601 string in UTC, for example `2026-09-21T08:51:07.123Z`.
 * @throws A `DebuggenError` with code `INTERNAL` when `epochMs` is not finite,
 * or when its magnitude exceeds the ECMAScript time-value limit. Both cases are
 * refused here so that a bare `RangeError` from `toISOString` — which names
 * nothing a reader can act on — never escapes a conversion helper.
 */
export function isoFromEpochMs(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new DebuggenError(
      'INTERNAL',
      `Cannot format the non-finite epoch millisecond value ${String(epochMs)} as an ISO 8601 timestamp.`,
      { details: { epochMs: String(epochMs) } },
    );
  }

  if (Math.abs(epochMs) > MAX_EPOCH_MS) {
    throw new DebuggenError(
      'INTERNAL',
      `The epoch millisecond value ${String(epochMs)} is outside the range Date can represent (±${String(MAX_EPOCH_MS)}).`,
      { details: { epochMs, maxEpochMs: MAX_EPOCH_MS } },
    );
  }

  return new Date(epochMs).toISOString();
}

/**
 * Shortens text for an error's diagnostic details.
 *
 * Module-internal. An error built here may be logged and persisted with a
 * session, so the offending value has to be identifiable without a malformed
 * multi-kilobyte string being copied along with it.
 *
 * @param text The value to report back.
 * @returns `text`, or its first {@link MAX_REPORTED_TEXT_LENGTH} characters
 * followed by an ellipsis.
 */
function truncateForReport(text: string): string {
  if (text.length <= MAX_REPORTED_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_REPORTED_TEXT_LENGTH)}…`;
}

/**
 * Parses an ISO 8601 timestamp back to epoch milliseconds.
 *
 * The reading half of the session store's timestamp pair, with
 * {@link isoFromEpochMs}: a stored `createdAt` comes back as a number the rest
 * of the product can compare against {@link nowEpochMs} and against a retention
 * window.
 *
 * Sub-millisecond precision is **lost** through ISO text in both directions, so
 * a value that went out with a fractional part does not come back with it. This
 * is stated on both functions because it is the reason spans persist numeric
 * epoch milliseconds instead: passing a span timestamp through this pair would
 * silently quantise the timeline that the whole correlation model depends on.
 *
 * @param iso An ISO 8601 timestamp, as produced by {@link isoFromEpochMs}.
 * @returns Whole epoch milliseconds.
 * @throws A `DebuggenError` with code `INTERNAL`, naming the offending string
 * (truncated), when `iso` cannot be parsed. `Date.parse` answers `NaN` for
 * unparseable input, and a `NaN` timestamp that reaches a comparison makes
 * every retention and ordering decision taken with it wrong without ever
 * looking wrong, so it is refused here.
 */
export function epochMsFromIso(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    const reported = truncateForReport(iso);
    throw new DebuggenError('INTERNAL', `Could not parse "${reported}" as an ISO 8601 timestamp.`, {
      details: { iso: reported },
    });
  }
  return parsed;
}
