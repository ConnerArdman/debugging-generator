/**
 * The per-producer clock offset: an **informational** estimate of how far a
 * producer's clock sits from the clock of the HTTP server that answered it.
 *
 * Every telemetry event has one time base — `startTime` is Unix epoch
 * milliseconds as the producer stamped it — and no clock alignment is applied
 * beyond a recorded per-producer `clockOffsetMs` (server `Date` header versus
 * local clock, informational; `docs/ARCHITECTURE.md` §5.2). This module is the
 * one definition of that measurement: its bound, the parser for the header it
 * is taken from, and the estimator both producers run. The value it yields
 * travels on each event as the optional `clockOffsetMs` field declared in
 * `./event.ts` and is persisted by the service in
 * `telemetry_events.clock_offset_ms`.
 *
 * ## What is measured, and against what
 *
 * `clockOffsetMs = server clock − producer clock`, in whole milliseconds: a
 * positive value means the server's clock is ahead of the producer's. Each
 * producer compares its **own** event clock — the clock its `startTime` values
 * come from — with the `Date` header of the responses it already receives:
 *
 * - the browser agent (`../browser/transport.ts`, fed by `../browser/fetch.ts`)
 *   against the dev server's `Date` on same-origin fetch/XHR responses its hook
 *   observes, compared with `performance.timeOrigin + performance.now()`;
 * - the Node preload (`../node/exporter.ts`) against the local service's
 *   `Date` on the answers to its own `POST /telemetry/ingest` requests,
 *   compared with the wall clock OpenTelemetry stamps span starts with.
 *
 * Both servers run on the developer's machine, so the offset is normally a few
 * hundred milliseconds of measurement uncertainty around zero. What it can
 * reveal is a producer whose clock has drifted: a page document's
 * `performance.timeOrigin`-based clock does not follow a wall-clock adjustment
 * made after the page loaded. The offset is recorded for a reader to judge
 * cross-tier ordering by; **nothing applies it** to an event's times.
 *
 * ## The estimator: interval intersection
 *
 * An HTTP `Date` header has one-second resolution (RFC 9110 IMF-fixdate), and
 * the server wrote it at some unknown moment between the producer sending the
 * request and receiving the response. One sample therefore does not give an
 * offset; it gives an interval that contains it. With `D` the header's value,
 * the server's clock read somewhere in `[D, D + 1000)` while the producer's
 * clock read somewhere in `[sentAt, receivedAt]`, so
 *
 * ```text
 * offset ∈ [D − receivedAt, D + 1000 − sentAt]
 * ```
 *
 * {@link ClockOffsetEstimator} intersects the intervals of successive samples
 * and reports the midpoint of what remains. Samples taken at different
 * sub-second phases of the server's clock cut the one-second window from both
 * sides, so the interval narrows well below the header's resolution as a
 * capture runs. A sample whose interval is disjoint from the current one means
 * the two clocks moved relative to each other (a clock step, or drift that has
 * outgrown the interval), and the estimator restarts from that newest sample
 * rather than keeping a stale answer; the restart is counted.
 *
 * A sample is rejected — counted, never used — when its times are not finite,
 * when its round trip is negative or longer than
 * {@link MAX_CLOCK_SAMPLE_ROUND_TRIP_MS} (the interval would be too wide to
 * say anything), or when its interval reaches beyond
 * {@link CLOCK_OFFSET_BOUND_MS}.
 *
 * ## Deliberately dependency-free
 *
 * Like `./kinds.ts` and `./attributes.ts`, this file imports **nothing**. The
 * page agent is bundled into an IIFE injected at `document_start`, and
 * `esbuild.agent.mjs` fails that bundle if an input resolves to a schema
 * library, a cross-package runtime dependency or a Node builtin; the preload
 * and the service share the same constants through the package's library
 * entry. One estimator, one bound, three processes.
 *
 * @packageDocumentation
 */

/**
 * The largest clock offset, in either direction, a producer may report:
 * `86_400_000` ms, one day.
 *
 * Both producers and both servers run on one machine, so a real offset is
 * orders of magnitude smaller. The bound exists to keep a broken sample — a
 * cached response replayed hours later, a header from a misconfigured proxy —
 * from being recorded as a measurement. `./event.ts` validates the event field
 * against it and the store's column `CHECK` is built from it.
 */
export const CLOCK_OFFSET_BOUND_MS = 86_400_000;

/**
 * The resolution of an HTTP `Date` header: one second. The server's clock read
 * somewhere in `[D, D + HTTP_DATE_RESOLUTION_MS)` when it wrote the value `D`.
 */
export const HTTP_DATE_RESOLUTION_MS = 1_000;

/**
 * The longest request/response round trip a sample may span: ten seconds.
 *
 * A sample's interval is one second plus its round trip wide, so a longer
 * round trip cannot narrow an estimate that is already within the header's
 * resolution, and a request that took that long was stalled rather than
 * measured.
 */
export const MAX_CLOCK_SAMPLE_ROUND_TRIP_MS = 10_000;

/** The exact length of an IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE_LENGTH = 29;

/** RFC 9110 §5.6.7 IMF-fixdate, the only form a conforming server generates. */
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parses an HTTP `Date` header value into epoch milliseconds.
 *
 * Only the IMF-fixdate form is accepted, because it is the only form RFC 9110
 * lets a server generate and the one Node's HTTP server writes. The value must
 * also be its own canonical form: `Date.parse` rolls an impossible date such as
 * 31 February over into March and ignores a wrong weekday, so the parsed
 * instant is formatted back and compared with the input.
 *
 * @param value The raw header value, as `Headers.get()` or
 *   `XMLHttpRequest.getResponseHeader()` returned it.
 * @returns The instant in epoch milliseconds (a whole second), or `undefined`
 *   when the value is absent or not a canonical IMF-fixdate.
 */
export function parseHttpDate(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    value.length !== IMF_FIXDATE_LENGTH ||
    !IMF_FIXDATE_PATTERN.test(value)
  ) {
    return undefined;
  }

  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toUTCString() !== value) {
    return undefined;
  }

  return instant;
}

/**
 * Whether `value` is a reportable clock offset: a whole number of milliseconds
 * no further than {@link CLOCK_OFFSET_BOUND_MS} from zero.
 *
 * @param value Any value.
 * @returns `true` when the value may be stamped as an event's `clockOffsetMs`.
 */
export function isClockOffsetMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= CLOCK_OFFSET_BOUND_MS
  );
}

/** One observation of a server's clock, in the producer's own clock. */
export interface ClockSample {
  /** The server's `Date` header, in epoch milliseconds (see {@link parseHttpDate}). */
  readonly serverDateMs: number;
  /** The producer's clock immediately before the request was sent. */
  readonly sentAt: number;
  /** The producer's clock when the response (at least its headers) arrived. */
  readonly receivedAt: number;
}

/**
 * What {@link ClockOffsetEstimator.observe} did with a sample:
 *
 * - `accepted` — the sample's interval was intersected with the current one
 *   (or became the first one);
 * - `reset` — the interval was disjoint from the current one, so the estimate
 *   restarted from this sample;
 * - `rejected` — the sample was unusable and changed nothing but the count.
 */
export type ClockSampleOutcome = 'accepted' | 'reset' | 'rejected';

/** A point-in-time view of an estimator, for a producer's diagnostics. */
export interface ClockOffsetSnapshot {
  /** The current estimate (see {@link ClockOffsetEstimator.estimate}), if any. */
  readonly offsetMs: number | undefined;
  /** The lower end of the interval the true offset lies in, if any. */
  readonly lowerBoundMs: number | undefined;
  /** The upper end of that interval, if any. */
  readonly upperBoundMs: number | undefined;
  /** Every sample observed: `accepted + resets + rejected`. */
  readonly samples: number;
  /** Samples intersected into the estimate, including the first one. */
  readonly accepted: number;
  /** Samples that restarted the estimate because they were disjoint from it. */
  readonly resets: number;
  /** Samples that were unusable. */
  readonly rejected: number;
}

/** The interval one sample constrains the offset to. */
interface OffsetInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * The interval a sample constrains the offset to, or `undefined` when the
 * sample is unusable.
 *
 * @param sample The observation.
 * @returns `[D − receivedAt, D + 1000 − sentAt]`, or `undefined`.
 */
function intervalOf(sample: ClockSample): OffsetInterval | undefined {
  const { serverDateMs, sentAt, receivedAt } = sample;
  if (!Number.isFinite(serverDateMs) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) {
    return undefined;
  }

  const roundTrip = receivedAt - sentAt;
  if (roundTrip < 0 || roundTrip > MAX_CLOCK_SAMPLE_ROUND_TRIP_MS) {
    return undefined;
  }

  const lower = serverDateMs - receivedAt;
  const upper = serverDateMs + HTTP_DATE_RESOLUTION_MS - sentAt;
  if (lower < -CLOCK_OFFSET_BOUND_MS || upper > CLOCK_OFFSET_BOUND_MS) {
    return undefined;
  }

  return { lower, upper };
}

/**
 * Estimates one producer's clock offset from the `Date` headers of the
 * responses it receives, by interval intersection (see the module overview).
 *
 * One instance belongs to one producer — one page document, or one preload
 * process — and lives as long as that producer: the offset is a property of
 * the producer's clock, not of a capture. The class holds four numbers and
 * three counters, performs no I/O, reads no clock of its own and never throws.
 */
export class ClockOffsetEstimator {
  #lower: number | undefined;
  #upper: number | undefined;
  #accepted = 0;
  #resets = 0;
  #rejected = 0;

  /**
   * Folds one sample into the estimate.
   *
   * @param sample The observation.
   * @returns What was done with it.
   */
  observe(sample: ClockSample): ClockSampleOutcome {
    const interval = intervalOf(sample);
    if (interval === undefined) {
      this.#rejected += 1;
      return 'rejected';
    }

    if (this.#lower === undefined || this.#upper === undefined) {
      this.#lower = interval.lower;
      this.#upper = interval.upper;
      this.#accepted += 1;
      return 'accepted';
    }

    const lower = Math.max(this.#lower, interval.lower);
    const upper = Math.min(this.#upper, interval.upper);
    if (lower > upper) {
      this.#lower = interval.lower;
      this.#upper = interval.upper;
      this.#resets += 1;
      return 'reset';
    }

    this.#lower = lower;
    this.#upper = upper;
    this.#accepted += 1;
    return 'accepted';
  }

  /**
   * Folds one response's `Date` header into the estimate.
   *
   * @param dateHeader The raw header value; `null` or `undefined` when the
   *   response carried none.
   * @param sentAt The producer's clock immediately before the request was sent.
   * @param receivedAt The producer's clock when the response arrived.
   * @returns What was done with the sample, or `undefined` when there was no
   *   header and therefore no sample. A header that is present but not a
   *   canonical IMF-fixdate is a `rejected` sample.
   */
  observeHttpDate(
    dateHeader: string | null | undefined,
    sentAt: number,
    receivedAt: number,
  ): ClockSampleOutcome | undefined {
    if (dateHeader === null || dateHeader === undefined) {
      return undefined;
    }

    const serverDateMs = parseHttpDate(dateHeader);
    if (serverDateMs === undefined) {
      this.#rejected += 1;
      return 'rejected';
    }

    return this.observe({ serverDateMs, sentAt, receivedAt });
  }

  /**
   * The current estimate: the midpoint of the interval, in whole milliseconds.
   *
   * @returns The offset to stamp on the producer's next events, or `undefined`
   *   before the first usable sample. Never `-0`, so the value serialises and
   *   compares exactly as it reads.
   */
  estimate(): number | undefined {
    if (this.#lower === undefined || this.#upper === undefined) {
      return undefined;
    }

    const rounded = Math.round((this.#lower + this.#upper) / 2);
    return rounded === 0 ? 0 : rounded;
  }

  /**
   * A point-in-time view of the estimator.
   *
   * @returns A fresh, frozen snapshot.
   */
  snapshot(): ClockOffsetSnapshot {
    return Object.freeze({
      offsetMs: this.estimate(),
      lowerBoundMs: this.#lower,
      upperBoundMs: this.#upper,
      samples: this.#accepted + this.#resets + this.#rejected,
      accepted: this.#accepted,
      resets: this.#resets,
      rejected: this.#rejected,
    });
  }
}
