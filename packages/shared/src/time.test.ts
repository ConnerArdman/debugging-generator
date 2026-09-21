/**
 * Tests for `./time.ts`: the canonical time base every tier's spans land on.
 *
 * Three producers time the same interaction from three different clocks — the
 * page agent against `performance.timeOrigin`, the OpenTelemetry tracer inside
 * the Next.js dev-server process against an `HrTime` pair, and the database
 * instrumentation inside that same process — and the whole correlation model
 * assumes their numbers are comparable. The telemetry event contract fixes what
 * "comparable" means: `startTime` is Unix **epoch milliseconds as a double with
 * sub-millisecond precision** and `duration` is milliseconds. The conversions in
 * `time.ts` are the only place that contract is implemented, so a defect here
 * does not surface here — it surfaces as a trace tree ordered wrongly, a
 * database span that appears to start before the request that issued it, or a
 * 0.4 ms handler reported as `0`.
 *
 * Four properties are therefore on trial, and each one has a consumer behind it.
 *
 * 1. **The exact vectors.** `hrTimeToEpochMs` and `hrTimeDurationMs` are what
 *    the Node exporter applies to every `ReadableSpan` it converts, so the
 *    numbers asserted below are the canonical ones: the telemetry package's own
 *    conversion suite asserts the same arithmetic, and the two must never
 *    disagree about a vector.
 * 2. **Sub-millisecond precision survives.** A fast server handler and the React
 *    commit that follows it routinely start inside the same millisecond.
 *    Truncating the nanosecond remainder would collapse their order, which no
 *    amount of downstream sorting can recover, so the remainder is asserted to
 *    be present rather than merely "close enough".
 * 3. **Well-formedness in both directions.** `epochMsToHrTime` must always hand
 *    back a pair whose nanosecond member is an integer inside
 *    `[0, 1_000_000_000)` — including the rounding case that reaches a full
 *    second's worth of nanoseconds and has to carry into the second member, and
 *    including pre-epoch values, where `Math.floor` rather than truncation is
 *    what keeps the remainder non-negative.
 * 4. **The boundaries refuse nonsense instead of propagating it.** A `NaN`
 *    timestamp compares false against everything and poisons every sum it
 *    enters, so the conversions that would otherwise produce a nonsense
 *    artefact (`epochMsToHrTime`, both ISO helpers) throw a `DebuggenError`,
 *    while the hot-path conversion on every exported span deliberately does not
 *    validate. Both halves of that split are asserted.
 *
 * Assertion habits used throughout, each deliberate.
 *
 * - **`toBe` where a value is exactly representable, `toBeCloseTo` only where
 *   the representation itself quantises.** `0.0015 s` is exactly `1.5 ms` in
 *   binary, so asserting it loosely would let a truncating implementation pass.
 *   At a present-day epoch value a double's spacing is roughly a quarter of a
 *   microsecond, which is why the millisecond-scale assertions there are made to
 *   three decimals — the same three decimals `roundMs` defaults to.
 * - **Tuple members asserted individually, not only as a pair.** A carry bug
 *   yields `[1, 1_000_000_000]`, which converts back to the right instant and
 *   passes any round-trip assertion while breaking every consumer that compares
 *   nanosecond members within a second.
 * - **The error's code, not its message.** A boundary picks a recovery path from
 *   `DebuggenError.code`; message text is for humans and may be reworded.
 * - **No monotonicity assertions across calls to the ambient clock.** Two reads
 *   of a wall clock on a loaded machine are not ordered by anything this module
 *   controls, and a test that assumes they are fails at 3 a.m. in CI rather than
 *   when the code is wrong.
 *
 * The ambient-clock degradation paths are covered with `vi.stubGlobal`, which
 * the unit is written to permit: `time.ts` reads `globalThis.performance` inside
 * each function rather than capturing it at module scope. Every stub is undone
 * in `afterEach`, so no case can leak a fake clock into the next one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError } from './errors.js';
import {
  clampNonNegative,
  epochMsFromIso,
  epochMsToHrTime,
  hrTimeDurationMs,
  hrTimeToEpochMs,
  isoFromEpochMs,
  nowEpochMs,
  nowEpochMsPrecise,
  performanceToEpochMs,
  roundMs,
  type HrTime,
} from './time.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * A present-day instant as an `HrTime` pair, in the shape the OpenTelemetry SDK
 * hands the Node exporter: whole seconds since the epoch plus a nanosecond
 * remainder that is not a whole number of milliseconds.
 *
 * `1_700_000_000 s` is 2023-11-14T22:13:20Z — chosen because a 2020s epoch value
 * is where a double's mantissa starts to matter, so the assertions made against
 * it are the ones that would catch a conversion written for small numbers.
 */
const PRESENT_DAY_HR_TIME: HrTime = [1_700_000_000, 123_456_789];

/**
 * The nanosecond remainder of {@link PRESENT_DAY_HR_TIME} stated in
 * milliseconds: 123.456789 ms past the second.
 */
const PRESENT_DAY_FRACTIONAL_MS = 123.456789;

/**
 * {@link PRESENT_DAY_HR_TIME} expressed as epoch milliseconds.
 *
 * Composed from the whole second and the decimal millisecond literal above
 * rather than from the unit's own arithmetic, so the assertions compare the
 * conversion against the number a developer reading the pair would expect
 * instead of against a rearrangement of the division being tested.
 *
 * It is a sum rather than the single literal `1_700_000_000_123.456789` for a
 * reason this suite is precisely about: that literal is not representable as a
 * double — its nearest neighbour prints as `1700000000123.4568` — so writing it
 * out is itself a lint error (`no-loss-of-precision`), and the sum evaluates to
 * that same nearest neighbour without pretending otherwise. Which is the whole
 * point of the microsecond-resolution note below: at this magnitude the
 * representation, not the conversion, is what limits precision.
 */
const PRESENT_DAY_EPOCH_MS = 1_700_000_000_000 + PRESENT_DAY_FRACTIONAL_MS;

/** The whole-millisecond instant inside {@link PRESENT_DAY_EPOCH_MS}. */
const PRESENT_DAY_WHOLE_MS = 1_700_000_000_123;

/** {@link PRESENT_DAY_WHOLE_MS} as the ISO 8601 text `isoFromEpochMs` produces. */
const PRESENT_DAY_ISO = '2023-11-14T22:13:20.123Z';

/**
 * The ECMAScript time-value limit, ±100 000 000 days in milliseconds.
 *
 * Restated here rather than imported because `time.ts` keeps its `MAX_EPOCH_MS`
 * constant module-private: the contract is the *value*, and stating it
 * independently means a typo in either copy shows up as a failing test.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * An epoch timestamp comfortably in the past (2020-01-01T00:00:00Z), used as the
 * floor for "is this a plausible wall-clock value?" assertions.
 *
 * A floor rather than an equality check: the paths that resolve the ambient
 * clock must be exercised without pinning the machine's actual time, which no
 * test may assume.
 */
const PLAUSIBLE_EPOCH_FLOOR_MS = Date.UTC(2020, 0, 1);

/**
 * How far a reading of one clock may sit from a reading of another before the
 * assertion is calling it a defect.
 *
 * `nowEpochMsPrecise` derives its value from `performance.timeOrigin` plus a
 * monotonic counter while `Date.now()` reads the wall clock, so the two agree
 * only approximately — measured at a third of a millisecond apart on this
 * runtime, and given two seconds of headroom here because the machine running
 * these tests may be loaded enough to be descheduled between the two reads.
 * Tight enough that a wrong origin (a `performance.now()` value mistaken for an
 * epoch value, say, which is off by the whole age of the process) still fails.
 */
const CLOCK_AGREEMENT_TOLERANCE_MS = 2_000;

/**
 * Values whose round trip through `epochMsToHrTime` and back must return the
 * original instant.
 *
 * The three the event contract cares about — a whole millisecond, a half
 * millisecond (the fractional part a `PerformanceEntry` routinely carries) and a
 * microsecond-scale fraction — plus the values that exercise the sign and
 * magnitude edges: zero, a small positive, and two pre-epoch instants, where
 * flooring rather than truncating is what keeps the nanosecond member
 * non-negative.
 */
const ROUND_TRIP_SAMPLES: readonly { readonly label: string; readonly epochMs: number }[] = [
  { label: 'zero', epochMs: 0 },
  { label: 'a small whole millisecond value', epochMs: 42 },
  { label: 'a half-millisecond value', epochMs: 1.5 },
  { label: 'a present-day whole millisecond', epochMs: PRESENT_DAY_WHOLE_MS },
  { label: 'a present-day half millisecond', epochMs: PRESENT_DAY_WHOLE_MS + 0.5 },
  { label: 'a present-day microsecond fraction', epochMs: PRESENT_DAY_WHOLE_MS + 0.001 },
  { label: 'a pre-epoch half millisecond', epochMs: -1.5 },
  { label: 'a pre-epoch fractional millisecond', epochMs: -1_500.25 },
];

/**
 * Non-finite values every validating boundary must refuse.
 *
 * All three arrive the same way in practice — an arithmetic on a reading that
 * was itself unusable — and all three are equally destructive downstream, so
 * each boundary is asserted against the whole set rather than against `NaN`
 * alone.
 */
const NON_FINITE_VALUES: readonly { readonly label: string; readonly value: number }[] = [
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
];

/**
 * Runs `call` and returns the `DebuggenError` it threw, asserting on the way
 * that it threw one and that the code is `INTERNAL`.
 *
 * Every throw in `time.ts` is a programming-error report from the bottom of the
 * package graph, which is what `INTERNAL` means there, so the code is checked
 * once here instead of in every case. Membership is tested with
 * `DebuggenError.is` rather than `instanceof`, which is the supported test in
 * this repository: four processes each bundle their own copy of the class, so
 * constructor identity is not a reliable question to ask.
 *
 * @param call The invocation under test.
 * @returns The thrown error, for a case that wants to assert on its details.
 */
function expectDebuggenError(call: () => unknown): DebuggenError {
  let thrown: unknown;
  let threw = false;

  try {
    call();
  } catch (caught: unknown) {
    thrown = caught;
    threw = true;
  }

  expect(threw, 'the call must throw rather than return a nonsense value').toBe(true);
  expect(DebuggenError.is(thrown), 'the thrown value must be a DebuggenError').toBe(true);
  if (!DebuggenError.is(thrown)) {
    // Unreachable: the assertion above has already failed the test. Present so
    // the return type is a `DebuggenError` without a cast.
    throw new Error('Expected a DebuggenError.');
  }

  expect(thrown.code).toBe('INTERNAL');
  return thrown;
}

/** Undoes any clock stub a case installed, so none of them can leak. */
afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * ---------------------------------------------------------------------------
 * HrTime -> epoch milliseconds (the Node exporter's conversion)
 * ---------------------------------------------------------------------------
 */

describe('hrTimeToEpochMs', () => {
  it('converts the zero pair to zero', () => {
    expect(hrTimeToEpochMs([0, 0])).toBe(0);
  });

  it('keeps a half-millisecond nanosecond remainder exactly', () => {
    // 1_500_000 ns is 1.5 ms, and 1.5 is exactly representable in binary, so
    // this is asserted with `toBe`: a loose assertion here would accept an
    // implementation that truncated the remainder to 1.
    expect(hrTimeToEpochMs([0, 1_500_000])).toBe(1.5);
  });

  it('scales whole seconds to milliseconds', () => {
    expect(hrTimeToEpochMs([1, 0])).toBe(1_000);
    expect(hrTimeToEpochMs([2, 500_000_000])).toBe(2_500);
  });

  it('converts a present-day pair to the instant the pair names', () => {
    // `toBeCloseTo(…, 3)` rather than `toBe`, because at ≈1.7 × 10¹² ms a
    // double's neighbours are roughly a quarter of a microsecond apart: the
    // nanosecond input is quantised by the representation itself, so the
    // conversion is only ever defined to about microsecond resolution. That is
    // exactly why `roundMs` defaults to three decimals and why three decimals
    // is the documented precision floor for a stored `startTime`.
    expect(hrTimeToEpochMs(PRESENT_DAY_HR_TIME)).toBeCloseTo(PRESENT_DAY_EPOCH_MS, 3);
  });

  it('retains the sub-millisecond remainder instead of truncating it', () => {
    const result = hrTimeToEpochMs(PRESENT_DAY_HR_TIME);

    // The property the event contract depends on, asserted as a property and
    // not as a number: the fraction is present, and it is a fraction of the
    // millisecond the pair names rather than of the next one.
    expect(Number.isInteger(result)).toBe(false);
    expect(result).toBeGreaterThan(PRESENT_DAY_WHOLE_MS);
    expect(result).toBeLessThan(PRESENT_DAY_WHOLE_MS + 1);
  });

  it('converts a pre-epoch pair, whose second member is negative', () => {
    // How `epochMsToHrTime` represents 1.5 ms before the epoch: one second
    // back, with a positive nanosecond remainder inside it.
    expect(hrTimeToEpochMs([-1, 998_500_000])).toBe(-1.5);
  });

  it('propagates a non-finite member as NaN rather than throwing', () => {
    // Deliberate, and the counterpart to the rejections asserted further down:
    // this conversion runs on every exported span and its input comes from an
    // SDK that built the pair itself, so it validates nothing. Rejection is the
    // job of the boundaries that would otherwise persist a nonsense artefact.
    expect(hrTimeToEpochMs([Number.NaN, 0])).toBeNaN();
    expect(hrTimeToEpochMs([0, Number.NaN])).toBeNaN();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Epoch milliseconds -> HrTime
 * ---------------------------------------------------------------------------
 */

describe('epochMsToHrTime', () => {
  it.each(ROUND_TRIP_SAMPLES)('round-trips $label through hrTimeToEpochMs', ({ epochMs }) => {
    const pair = epochMsToHrTime(epochMs);

    expect(hrTimeToEpochMs(pair)).toBeCloseTo(epochMs, 3);
  });

  it.each(ROUND_TRIP_SAMPLES)('produces a well-formed pair for $label', ({ epochMs }) => {
    const [seconds, nanoseconds] = epochMsToHrTime(epochMs);

    // The invariant every consumer relies on: whole seconds, and a nanosecond
    // remainder that is an integer inside its own second. A pair carrying
    // `1_000_000_000` ns converts back to the right instant and would pass the
    // round-trip case above while breaking any comparison of nanosecond members
    // within a second.
    expect(Number.isInteger(seconds)).toBe(true);
    expect(Number.isInteger(nanoseconds)).toBe(true);
    expect(nanoseconds).toBeGreaterThanOrEqual(0);
    expect(nanoseconds).toBeLessThan(1_000_000_000);
  });

  it('splits a present-day instant into the expected members', () => {
    expect(epochMsToHrTime(PRESENT_DAY_WHOLE_MS)).toEqual([1_700_000_000, 123_000_000]);
    expect(epochMsToHrTime(PRESENT_DAY_WHOLE_MS + 0.5)).toEqual([1_700_000_000, 123_500_000]);
  });

  it('floors a pre-epoch instant so the nanosecond remainder stays non-negative', () => {
    // Truncation toward zero would give `[-1, -500_000]`, which is neither
    // well-formed nor comparable; flooring moves the second further back and
    // keeps the remainder inside it.
    expect(epochMsToHrTime(-1.5)).toEqual([-1, 998_500_000]);
  });

  it('carries into the second when the rounded remainder reaches a whole second', () => {
    // Constructed for the carry: the fractional millisecond of 1999.9999999
    // scales to 999_999_999.9 ns, which `Math.round` lifts to exactly
    // 1_000_000_000 — a value that must never appear in the nanosecond member.
    const [seconds, nanoseconds] = epochMsToHrTime(1_999.9999999);

    expect(seconds).toBe(2);
    expect(nanoseconds).toBe(0);
    expect(nanoseconds).toBeLessThan(1_000_000_000);
  });

  it('carries out of the zeroth second as well', () => {
    expect(epochMsToHrTime(999.9999999)).toEqual([1, 0]);
  });

  it.each(NON_FINITE_VALUES)('refuses $label with a DebuggenError', ({ value }) => {
    // Refused at the point of conversion, where the stack still names the
    // caller that produced the value: a `NaN` second silently corrupts every
    // ordering and grouping it later takes part in.
    const error = expectDebuggenError(() => epochMsToHrTime(value));

    expect(error.message).toContain('hrTime');
  });

  it('reports the offending value as a string in the error details', () => {
    // Stringified on purpose: `JSON.stringify` renders NaN and Infinity as
    // `null`, and these details may be logged or persisted with a session.
    const error = expectDebuggenError(() => epochMsToHrTime(Number.NaN));

    expect(error.details).toEqual({ epochMs: 'NaN' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Durations
 * ---------------------------------------------------------------------------
 */

describe('hrTimeDurationMs', () => {
  it('computes a duration across a second boundary', () => {
    // 100 ms into the second minus 900 ms into the previous one: the nanosecond
    // members are differenced separately, so the borrow is arithmetic rather
    // than a special case.
    expect(hrTimeDurationMs([1, 900_000_000], [2, 100_000_000])).toBe(200);
  });

  it('returns zero for identical pairs', () => {
    expect(hrTimeDurationMs(PRESENT_DAY_HR_TIME, PRESENT_DAY_HR_TIME)).toBe(0);
  });

  it('keeps sub-millisecond resolution inside one second', () => {
    // The case that justifies differencing the pair rather than subtracting two
    // epoch-millisecond conversions. 100_000 ns is exactly 0.1 ms, and the
    // pair-wise route returns exactly that; the subtraction route returns
    // 0.10009765625, because at ≈1.7 × 10¹² ms each converted instant has
    // already been rounded to the nearest representable double a quarter of a
    // microsecond away. Asserted to six decimals, which the pair-wise answer
    // satisfies and the quantised one does not — and for a database query timed
    // in microseconds that quantisation is the whole measurement.
    const start: HrTime = [1_700_000_000, 123_456_789];
    const end: HrTime = [1_700_000_000, 123_556_789];

    expect(hrTimeDurationMs(start, end)).toBeCloseTo(0.1, 6);
    expect(hrTimeDurationMs(start, end)).toBe(0.1);
  });

  it('returns a negative duration when the arguments are reversed', () => {
    // Signed on purpose. Hiding a backwards measurement is a decision taken
    // where it is visible — a publisher passes the result through
    // `clampNonNegative` — and never inside a subtraction.
    const reversed = hrTimeDurationMs([2, 100_000_000], [1, 900_000_000]);

    expect(reversed).toBe(-200);
    expect(clampNonNegative(reversed)).toBe(0);
  });

  it('agrees with the difference of two converted instants at a small magnitude', () => {
    // Cross-check of the two routes where the representation does not quantise,
    // so the pair-wise arithmetic is shown to be the same arithmetic and not
    // merely a different one that happens to be finer.
    const start: HrTime = [3, 250_000_000];
    const end: HrTime = [4, 750_000_000];

    expect(hrTimeDurationMs(start, end)).toBe(hrTimeToEpochMs(end) - hrTimeToEpochMs(start));
  });
});

/*
 * ---------------------------------------------------------------------------
 * performance-relative readings -> epoch milliseconds (the browser agent's
 * conversion)
 * ---------------------------------------------------------------------------
 */

describe('performanceToEpochMs with an injected origin', () => {
  it('adds the origin to the relative reading exactly', () => {
    // The `performance.timeOrigin + entry.startTime` computation the event
    // contract prescribes for the browser tier, with the origin supplied the way
    // the agent supplies it: read once per document and reused.
    expect(performanceToEpochMs(12.5, 1_700_000_000_000)).toBe(1_700_000_000_012.5);
  });

  it('preserves a fractional relative reading', () => {
    // A `PerformanceEntry.startTime` is fractional in every browser, and that
    // fraction is the sub-millisecond precision of the whole browser tier, so no
    // rounding happens in this conversion.
    const result = performanceToEpochMs(0.125, 1_700_000_000_000);

    expect(result).toBe(1_700_000_000_000.125);
    expect(Number.isInteger(result)).toBe(false);
  });

  it('honours an origin of zero instead of falling back to the ambient clock', () => {
    // The distinction between `??` and `||`, which matters: a worker or a test
    // harness whose clock origin genuinely is 0 must get the relative reading
    // back unchanged, not a wall-clock timestamp it never asked for.
    vi.stubGlobal('performance', { now: () => 5_000, timeOrigin: 1_700_000_000_000 });

    expect(performanceToEpochMs(5, 0)).toBe(5);
  });

  it('uses a non-finite injected origin verbatim', () => {
    // No rescue: a caller that passes NaN sees its own mistake, rather than a
    // plausible-looking timestamp taken from a clock it did not ask about.
    expect(performanceToEpochMs(5, Number.NaN)).toBeNaN();
  });
});

describe('performanceToEpochMs resolving the origin from the ambient clock', () => {
  it('uses performance.timeOrigin when the host exposes one', () => {
    // Stubbed so the resolved value is exact rather than plausible: this is the
    // route the agent takes when it has no origin to hand.
    vi.stubGlobal('performance', { now: () => 42, timeOrigin: 1_700_000_000_000 });

    expect(performanceToEpochMs(0.5)).toBe(1_700_000_000_000.5);
  });

  it('reads now() with the performance object as its receiver', () => {
    // A host implementation is free to require its own receiver, so the probe
    // must not detach the function. This stub reads `this`, which throws when it
    // is called unbound — and a throw inside a conversion on the agent's hot
    // path would take the whole capture down.
    const clock = {
      offsetMs: 250,
      now(): number {
        return this.offsetMs;
      },
    };
    vi.stubGlobal('performance', clock);

    // No `timeOrigin` on the stub, so the origin is derived as
    // `Date.now() - now()` and the result lands 250 ms in the past.
    const result = performanceToEpochMs(0);

    expect(result).toBeGreaterThan(PLAUSIBLE_EPOCH_FLOOR_MS);
    // The stub's 250 ms reading is visible in the answer, which is only possible
    // if `now()` was invoked successfully with its own receiver.
    expect(Date.now() - result).toBeGreaterThanOrEqual(250);
    expect(Date.now() - result).toBeLessThan(250 + CLOCK_AGREEMENT_TOLERANCE_MS);
  });

  it('derives the origin from Date.now() when the clock has no usable origin', () => {
    vi.stubGlobal('performance', { now: () => 1_000 });

    // Origin is `Date.now() - 1_000`, so a relative reading of 1 000 ms lands
    // back at "now": the derived origin is off by at most the microseconds
    // between the two reads, and every entry is shifted by the same constant, so
    // ordering within the producer is unaffected.
    expect(Math.abs(performanceToEpochMs(1_000) - Date.now())).toBeLessThan(
      CLOCK_AGREEMENT_TOLERANCE_MS,
    );
  });

  it.each([
    { label: 'no performance global at all', value: undefined },
    { label: 'a null performance global', value: null },
    { label: 'a non-object performance global', value: 42 },
    { label: 'a performance object with no callable now', value: { timeOrigin: 0 } },
    { label: 'a clock whose now() returns a non-number', value: { now: () => 'soon' } },
    { label: 'a clock whose now() returns NaN', value: { now: () => Number.NaN } },
  ])('degrades to Date.now() given $label', ({ value }) => {
    vi.stubGlobal('performance', value);

    const result = performanceToEpochMs(0);

    // A missing or unusable clock costs absolute precision and never
    // correctness: the value is still a wall-clock timestamp, and no `NaN`
    // reaches an event from a stub that returned one.
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeGreaterThan(PLAUSIBLE_EPOCH_FLOOR_MS);
    expect(Math.abs(result - Date.now())).toBeLessThan(CLOCK_AGREEMENT_TOLERANCE_MS);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Reading "now"
 * ---------------------------------------------------------------------------
 */

describe('nowEpochMs', () => {
  it('is a whole-millisecond wall-clock reading', () => {
    const result = nowEpochMs();

    // `Date.now()` and nothing more: this is the function for record
    // timestamps, where a whole millisecond is the unit the field is defined in.
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThan(PLAUSIBLE_EPOCH_FLOOR_MS);
    expect(Math.abs(result - Date.now())).toBeLessThan(CLOCK_AGREEMENT_TOLERANCE_MS);
  });
});

describe('nowEpochMsPrecise', () => {
  it('agrees with the wall clock without being restricted to whole milliseconds', () => {
    const result = nowEpochMsPrecise();

    // Deliberately no integer assertion in either direction: on a host with a
    // fine-grained clock this carries a fraction, and on one without it degrades
    // to `Date.now()` — both are correct, and a test that demanded one would
    // fail on the other. Ordering never depends on this resolution anyway: the
    // event contract falls through to the per-producer sequence number.
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeGreaterThan(PLAUSIBLE_EPOCH_FLOOR_MS);
    expect(Math.abs(result - Date.now())).toBeLessThan(CLOCK_AGREEMENT_TOLERANCE_MS);
  });

  it('is the origin plus the monotonic reading when both are available', () => {
    vi.stubGlobal('performance', { now: () => 4.25, timeOrigin: 1_700_000_000_000 });

    // Exact, so the composition is asserted rather than inferred from a
    // tolerance — and the fractional part survives, which is the whole reason
    // span start times use this function instead of `nowEpochMs`.
    expect(nowEpochMsPrecise()).toBe(1_700_000_000_004.25);
  });

  it('degrades to the wall clock when the host exposes no usable origin', () => {
    vi.stubGlobal('performance', { now: () => 1_000 });

    // A clock without an origin cannot produce an epoch value on its own, and
    // `Date.now() - now() + now()` would only reintroduce the same reading with
    // extra error, so this path reads the wall clock outright.
    expect(Math.abs(nowEpochMsPrecise() - Date.now())).toBeLessThan(CLOCK_AGREEMENT_TOLERANCE_MS);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The rounding policy
 * ---------------------------------------------------------------------------
 */

describe('roundMs', () => {
  it('keeps three decimals by default', () => {
    // Three decimals is the documented precision floor for a stored `startTime`
    // or `duration`: microsecond resolution, which is all a double retains at a
    // present-day epoch value anyway.
    expect(roundMs(1.23456789)).toBe(1.235);
    expect(roundMs(PRESENT_DAY_EPOCH_MS)).toBe(1_700_000_000_123.457);
  });

  it('rounds over the decimal representation, not over a binary product', () => {
    // The two examples the policy is documented with: the answers the digits
    // imply.
    expect(roundMs(1.2345)).toBe(1.235);
    expect(roundMs(2.675, 2)).toBe(2.68);

    // The vectors that actually separate this policy from the two
    // implementations someone would otherwise reach for, and the reason they
    // are pinned here rather than left to the examples above — which a
    // multiplication happens to get right on this runtime.
    //
    //   value   decimals | this policy | value * 10**d, rounded | toFixed(d)
    //   1.005          2 |        1.01 |                      1 |       1.00
    //   8.575          2 |        8.58 |                   8.57 |       8.57
    //   1.0005         3 |       1.001 |                  1.001 |      1.000
    //
    // Each of those inputs is a tie in decimal that the binary value sits just
    // below, so a multiply-then-round or a `toFixed` implementation rounds it
    // down and this one — which re-reads the value's own shortest decimal form
    // and breaks the tie upward — rounds it up.
    expect(roundMs(1.005, 2)).toBe(1.01);
    expect(roundMs(8.575, 2)).toBe(8.58);
    expect(roundMs(1.0005)).toBe(1.001);
  });

  it('breaks ties toward positive infinity', () => {
    // The stated policy. Durations are non-negative, so the negative case only
    // ever applies to a value some caller has yet to clamp.
    expect(roundMs(1.5, 0)).toBe(2);
    expect(roundMs(2.5, 0)).toBe(3);
    expect(roundMs(-1.5, 0)).toBe(-1);
    expect(roundMs(-2.5, 0)).toBe(-2);
  });

  it('truncates to whole milliseconds when asked for no decimals', () => {
    expect(roundMs(46.4, 0)).toBe(46);
    expect(roundMs(PRESENT_DAY_EPOCH_MS, 0)).toBe(PRESENT_DAY_WHOLE_MS);
  });

  it('returns a value that already has fewer decimals unchanged', () => {
    expect(roundMs(47.5)).toBe(47.5);
    expect(roundMs(47)).toBe(47);
    expect(roundMs(0)).toBe(0);
    expect(roundMs(-3.25)).toBe(-3.25);
  });

  it('removes floating-point noise so equal measurements serialise identically', () => {
    // The reason this function exists: the same duration computed two ways must
    // not produce two different JSON values.
    expect(roundMs(46.99999999999999)).toBe(47);
    expect(roundMs(47.00000000000001)).toBe(47);
    expect(roundMs(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds a sub-microsecond value up to the smallest retained decimal', () => {
    expect(roundMs(0.0005)).toBe(0.001);
    expect(roundMs(0.0004)).toBe(0);
  });

  it('accepts the full documented decimal range', () => {
    expect(roundMs(1.123456789012345, 15)).toBe(1.123456789012345);
    expect(roundMs(1.987, 15)).toBe(1.987);
  });

  it.each(NON_FINITE_VALUES)('returns $label unchanged', ({ value }) => {
    // Rounding is a presentation concern and must not be the thing that decides
    // what a non-finite measurement means; the schema that validates the event,
    // or the boundary that refuses it, is where that belongs.
    if (Number.isNaN(value)) {
      expect(roundMs(value)).toBeNaN();
      return;
    }
    expect(roundMs(value)).toBe(value);
  });

  it.each([
    { label: 'a fractional decimal count', decimals: 2.5 },
    { label: 'a negative decimal count', decimals: -1 },
    { label: 'a decimal count past the informative range', decimals: 16 },
    { label: 'a NaN decimal count', decimals: Number.NaN },
  ])('refuses $label with a DebuggenError', ({ decimals }) => {
    // Refused rather than clamped: beyond fifteen places a double carries no
    // further information, so such a request is a caller mistake, and silently
    // clamping it would hide the mistake.
    const error = expectDebuggenError(() => roundMs(1, decimals));

    expect(error.message).toContain('roundMs');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Clamping
 * ---------------------------------------------------------------------------
 */

describe('clampNonNegative', () => {
  it('replaces a negative value with zero', () => {
    // A slightly negative duration is an ordinary outcome — a wall-clock
    // adjustment between two readings, a reconstructed end — and it means "this
    // took approximately no time", not "time ran backwards".
    expect(clampNonNegative(-1)).toBe(0);
    expect(clampNonNegative(-0.0001)).toBe(0);
    expect(clampNonNegative(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('passes a positive value through untouched', () => {
    expect(clampNonNegative(5.5)).toBe(5.5);
    expect(clampNonNegative(PRESENT_DAY_EPOCH_MS)).toBe(PRESENT_DAY_EPOCH_MS);
    expect(clampNonNegative(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(clampNonNegative(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns zero for zero, normalising negative zero', () => {
    // `-0` is normalised so that a JSON round trip and an `Object.is`
    // comparison in a test agree about the value.
    expect(clampNonNegative(0)).toBe(0);
    expect(Object.is(clampNonNegative(-0), 0)).toBe(true);
    expect(Object.is(clampNonNegative(-0), -0)).toBe(false);
  });

  it('maps NaN to zero, as documented, rather than propagating it', () => {
    // A deliberate choice with a cost: the alternative turns one unusable
    // reading into an unusable total for the whole capture, because `NaN`
    // poisons every sum, comparison and sort it takes part in. A caller that
    // needs to know a measurement was unusable must check before clamping.
    //
    // The behaviour is asserted, not the branch that implements it: `NaN > 0`
    // is already false, so the explicit `Number.isNaN` guard in the unit is
    // belt-and-braces and removing it would not change this answer. What must
    // never change is the answer.
    expect(clampNonNegative(Number.NaN)).toBe(0);
    expect(Number.isNaN(clampNonNegative(Number.NaN))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * ISO text (the session store's record timestamps)
 * ---------------------------------------------------------------------------
 */

describe('isoFromEpochMs and epochMsFromIso', () => {
  it('formats a present-day instant as UTC ISO 8601 text', () => {
    // Readable in a database row, and it sorts lexicographically in the same
    // order it sorts chronologically — the two reasons record timestamps are
    // stored as text rather than as numbers.
    expect(isoFromEpochMs(PRESENT_DAY_WHOLE_MS)).toBe(PRESENT_DAY_ISO);
  });

  it('round-trips an integer-millisecond value exactly', () => {
    expect(epochMsFromIso(isoFromEpochMs(PRESENT_DAY_WHOLE_MS))).toBe(PRESENT_DAY_WHOLE_MS);
    expect(epochMsFromIso(PRESENT_DAY_ISO)).toBe(PRESENT_DAY_WHOLE_MS);
    expect(epochMsFromIso(isoFromEpochMs(0))).toBe(0);
    expect(epochMsFromIso(isoFromEpochMs(-1_000))).toBe(-1_000);
  });

  it('loses sub-millisecond precision, which is why spans never go through it', () => {
    // The claim stated on both functions, asserted rather than trusted: ISO text
    // has millisecond granularity, so the fraction is gone from the text and
    // cannot come back. A span timestamp passed through this pair would silently
    // quantise the timeline the whole correlation model depends on, so
    // `startTime` and `duration` persist as numeric epoch milliseconds and only
    // record-level timestamps are formatted here.
    const fractional = PRESENT_DAY_WHOLE_MS + 0.5;
    const text = isoFromEpochMs(fractional);
    const restored = epochMsFromIso(text);

    expect(text).toBe(PRESENT_DAY_ISO);
    expect(restored).not.toBe(fractional);
    expect(restored).toBe(PRESENT_DAY_WHOLE_MS);
    expect(fractional - restored).toBe(0.5);
  });

  it('reads a timestamp written with an offset back as the same instant', () => {
    // `Date.parse` honours the offset, so a value that did not come from
    // `isoFromEpochMs` — a timestamp typed into a fixture, say — still resolves
    // to the instant it names rather than to a local-time reading of it.
    expect(epochMsFromIso('2023-11-14T23:13:20.123+01:00')).toBe(PRESENT_DAY_WHOLE_MS);
  });

  it('round-trips the extremes of the representable range', () => {
    // The boundary is inclusive: `Date` represents ±100 000 000 days, and the
    // extended-year ISO form carries them both.
    expect(epochMsFromIso(isoFromEpochMs(MAX_EPOCH_MS))).toBe(MAX_EPOCH_MS);
    expect(epochMsFromIso(isoFromEpochMs(-MAX_EPOCH_MS))).toBe(-MAX_EPOCH_MS);
  });

  it.each(NON_FINITE_VALUES)('refuses to format $label', ({ value }) => {
    const error = expectDebuggenError(() => isoFromEpochMs(value));

    expect(error.message).toContain('ISO 8601');
  });

  it.each([
    { label: 'one millisecond past the maximum', value: MAX_EPOCH_MS + 1 },
    { label: 'one millisecond before the minimum', value: -MAX_EPOCH_MS - 1 },
  ])('refuses to format $label', ({ value }) => {
    // Refused here so that a bare `RangeError` from `toISOString` — which names
    // nothing a reader can act on — never escapes a conversion helper.
    const error = expectDebuggenError(() => isoFromEpochMs(value));

    expect(error.message).toContain('Date');
    expect(error.details).toEqual({ epochMs: value, maxEpochMs: MAX_EPOCH_MS });
  });

  it.each([
    { label: 'prose', iso: 'not a timestamp' },
    { label: 'an empty string', iso: '' },
    { label: 'an impossible month', iso: '2023-13-01T00:00:00.000Z' },
    { label: 'a bare identifier', iso: 'yesterday' },
  ])('refuses to parse $label', ({ iso }) => {
    // `Date.parse` answers `NaN` for unparseable input, and a `NaN` timestamp
    // that reaches a comparison makes every retention and ordering decision
    // taken with it wrong without ever looking wrong.
    const error = expectDebuggenError(() => epochMsFromIso(iso));

    expect(error.message).toContain('ISO 8601');
    expect(error.details).toEqual({ iso });
  });

  it('truncates an over-long unparseable value in the error it reports', () => {
    // An error raised here may be logged and persisted with a session, so the
    // offending value has to be identifiable without a malformed multi-kilobyte
    // string being carried along with it.
    const error = expectDebuggenError(() => epochMsFromIso('x'.repeat(200)));
    const reported = (error.details as { readonly iso?: unknown } | undefined)?.iso;

    expect(typeof reported).toBe('string');
    expect(reported).toBe(`${'x'.repeat(64)}…`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The compositions the producers actually persist
 * ---------------------------------------------------------------------------
 */

describe('the canonical producer compositions', () => {
  it('persists a server span as rounded epoch milliseconds and a clamped duration', () => {
    // The exact sequence the Node exporter applies to a `ReadableSpan`:
    // `hrTimeToEpochMs` for the start, `hrTimeDurationMs` for the elapsed time
    // rather than a subtraction of two converted instants, `roundMs(…, 3)` so
    // stored JSON is stable at microsecond resolution, and `clampNonNegative`
    // so a clock hiccup can never publish a negative duration. These three
    // numbers are the canonical ones: the telemetry package's own conversion
    // suite asserts the same composition, and the two must not diverge.
    const start: HrTime = PRESENT_DAY_HR_TIME;
    const end: HrTime = [1_700_000_000, 123_556_789];

    expect(roundMs(hrTimeToEpochMs(start), 3)).toBe(1_700_000_000_123.457);
    expect(clampNonNegative(roundMs(hrTimeDurationMs(start, end), 3))).toBe(0.1);
    // A span whose recorded end precedes its start publishes as "took
    // approximately no time" instead of as a negative bar in a waterfall.
    expect(clampNonNegative(roundMs(hrTimeDurationMs(end, start), 3))).toBe(0);
  });

  it('persists a browser entry as the rounded sum of the origin and the reading', () => {
    // The page agent's sequence for a `PerformanceEntry`: add the document's
    // origin, then round at the point of persistence — never before, so the
    // entry's own fractional millisecond is what gets rounded rather than
    // something already quantised.
    const persisted = roundMs(performanceToEpochMs(12.3456789, 1_700_000_000_000), 3);

    expect(persisted).toBe(1_700_000_000_012.346);
  });

  it('keeps a server and a browser event in the same order they occurred', () => {
    // Why any of this matters: two producers, two clocks, one timeline. The
    // browser interaction happens 12.346 ms into the document and the server
    // span 123.457 ms into the same second, so the correlator's primary sort
    // key must put them in that order — which it can only do because both
    // numbers mean the same thing.
    const browserEvent = roundMs(performanceToEpochMs(12.3456789, 1_700_000_000_000), 3);
    const serverEvent = roundMs(hrTimeToEpochMs(PRESENT_DAY_HR_TIME), 3);

    expect(browserEvent).toBeLessThan(serverEvent);
    expect(serverEvent - browserEvent).toBeCloseTo(111.111, 3);
  });
});
