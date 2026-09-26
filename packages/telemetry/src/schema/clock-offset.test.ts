/**
 * Tests for `./clock-offset.ts`: the HTTP `Date` parser, the offset bound and
 * the interval-intersection estimator both producers run.
 *
 * The estimator's contract is checked against a simulated server whose clock
 * is a known offset from the producer's: every sample is built the way a real
 * one arises — the server writes a one-second `Date` at some moment between
 * the producer sending and receiving — so the tests can assert the property
 * that matters, that the true offset always lies inside the reported
 * interval, rather than restating the arithmetic.
 */

import { describe, expect, it } from 'vitest';

import {
  CLOCK_OFFSET_BOUND_MS,
  ClockOffsetEstimator,
  HTTP_DATE_RESOLUTION_MS,
  MAX_CLOCK_SAMPLE_ROUND_TRIP_MS,
  isClockOffsetMs,
  parseHttpDate,
} from './clock-offset.js';
import type { ClockSample } from './clock-offset.js';

/** A fixed producer-clock instant the samples are built around. */
const BASE = 1_790_380_654_000.25;

/**
 * A deterministic pseudo-random sequence in `[0, 1)` (a 32-bit LCG), so the
 * simulated samples are reproducible run to run.
 *
 * @param seed The starting state.
 * @returns The generator.
 */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * A sample from a server whose clock reads `producer clock + trueOffset`.
 *
 * @param trueOffset The offset the estimator should find.
 * @param sentAt The producer's clock when the request left.
 * @param roundTrip How long the round trip took, in the producer's clock.
 * @param writeFraction Where in the round trip the server wrote its `Date`.
 * @returns The sample the producer would record.
 */
function simulatedSample(
  trueOffset: number,
  sentAt: number,
  roundTrip: number,
  writeFraction: number,
): ClockSample {
  const writtenAt = sentAt + roundTrip * writeFraction;
  const serverDateMs =
    Math.floor((writtenAt + trueOffset) / HTTP_DATE_RESOLUTION_MS) * HTTP_DATE_RESOLUTION_MS;

  return { serverDateMs, sentAt, receivedAt: sentAt + roundTrip };
}

describe('parseHttpDate', () => {
  it('parses the IMF-fixdate a Node HTTP server writes', () => {
    const instant = Date.UTC(2026, 8, 25, 23, 57, 34);

    expect(parseHttpDate(new Date(instant).toUTCString())).toBe(instant);
    expect(parseHttpDate('Fri, 25 Sep 2026 23:57:34 GMT')).toBe(instant);
  });

  it('parses the RFC 9110 example', () => {
    expect(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
  });

  it.each([
    ['an absent header', null],
    ['an undefined header', undefined],
    ['a number', 1_790_380_654_000],
    ['an empty string', ''],
    ['the obsolete RFC 850 form', 'Sunday, 06-Nov-94 08:49:37 GMT'],
    ['the obsolete asctime form', 'Sun Nov  6 08:49:37 1994'],
    ['an ISO 8601 instant', '2026-09-25T23:57:34.000Z'],
    ['a wrong weekday', 'Mon, 25 Sep 2026 23:57:34 GMT'],
    ['an impossible date', 'Sat, 31 Feb 2026 10:00:00 GMT'],
    ['a zone other than GMT', 'Fri, 25 Sep 2026 23:57:34 UTC'],
    ['lowercase names', 'fri, 25 sep 2026 23:57:34 GMT'],
    ['surrounding whitespace', ' Fri, 25 Sep 2026 23:57:34 GMT'],
    ['an out-of-range hour', 'Fri, 25 Sep 2026 24:57:34 GMT'],
  ])('rejects %s', (_label: string, value: unknown) => {
    expect(parseHttpDate(value)).toBeUndefined();
  });
});

describe('isClockOffsetMs', () => {
  it.each([0, 1, -1, 999, CLOCK_OFFSET_BOUND_MS, -CLOCK_OFFSET_BOUND_MS])('accepts %d', (value) => {
    expect(isClockOffsetMs(value)).toBe(true);
  });

  it.each([
    0.5,
    CLOCK_OFFSET_BOUND_MS + 1,
    -CLOCK_OFFSET_BOUND_MS - 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    null,
    undefined,
  ])('rejects %s', (value: unknown) => {
    expect(isClockOffsetMs(value)).toBe(false);
  });
});

describe('ClockOffsetEstimator', () => {
  it('reports nothing before its first sample', () => {
    const estimator = new ClockOffsetEstimator();

    expect(estimator.estimate()).toBeUndefined();
    expect(estimator.snapshot()).toEqual({
      offsetMs: undefined,
      lowerBoundMs: undefined,
      upperBoundMs: undefined,
      samples: 0,
      accepted: 0,
      resets: 0,
      rejected: 0,
    });
  });

  it('turns one sample into the interval [D − receivedAt, D + 1000 − sentAt]', () => {
    const estimator = new ClockOffsetEstimator();
    const sample: ClockSample = { serverDateMs: 10_000, sentAt: 9_900, receivedAt: 9_950 };

    expect(estimator.observe(sample)).toBe('accepted');
    const snapshot = estimator.snapshot();

    expect(snapshot.lowerBoundMs).toBe(50);
    expect(snapshot.upperBoundMs).toBe(1_100);
    expect(snapshot.offsetMs).toBe(575);
    expect(estimator.estimate()).toBe(575);
  });

  it('narrows the interval by intersecting consistent samples', () => {
    const estimator = new ClockOffsetEstimator();

    estimator.observe({ serverDateMs: 10_000, sentAt: 9_900, receivedAt: 9_950 });
    expect(estimator.observe({ serverDateMs: 11_000, sentAt: 10_600, receivedAt: 10_620 })).toBe(
      'accepted',
    );

    const snapshot = estimator.snapshot();
    expect(snapshot.lowerBoundMs).toBe(380);
    expect(snapshot.upperBoundMs).toBe(1_100);
    expect(snapshot.offsetMs).toBe(740);
    expect(snapshot.accepted).toBe(2);
  });

  it.each([
    ['in step', 0],
    ['ahead by 750 ms', 750],
    ['behind by 2.3 s', -2_300],
    ['ahead by 41 s', 41_000],
  ])(
    'always keeps the true offset inside its interval when the server is %s',
    (_label, trueOffset) => {
      const random = sequence(0x5eed + trueOffset);
      const estimator = new ClockOffsetEstimator();
      let sentAt = BASE;

      for (let index = 0; index < 200; index += 1) {
        const roundTrip = 1 + random() * 80;
        const outcome = estimator.observe(simulatedSample(trueOffset, sentAt, roundTrip, random()));
        const snapshot = estimator.snapshot();

        expect(outcome).toBe('accepted');
        expect(snapshot.lowerBoundMs).toBeLessThanOrEqual(trueOffset);
        expect(snapshot.upperBoundMs).toBeGreaterThanOrEqual(trueOffset);
        sentAt += 137 + random() * 400;
      }

      const final = estimator.snapshot();
      const width = (final.upperBoundMs ?? Number.NaN) - (final.lowerBoundMs ?? Number.NaN);
      expect(width).toBeLessThan(HTTP_DATE_RESOLUTION_MS / 4);
      expect(Math.abs((final.offsetMs ?? Number.NaN) - trueOffset)).toBeLessThan(
        HTTP_DATE_RESOLUTION_MS / 8,
      );
      expect(final).toMatchObject({ samples: 200, accepted: 200, resets: 0, rejected: 0 });
    },
  );

  it('restarts from the newest sample when the clocks step apart', () => {
    const estimator = new ClockOffsetEstimator();
    let sentAt = BASE;
    for (let index = 0; index < 20; index += 1) {
      estimator.observe(simulatedSample(0, sentAt, 10, 0.5));
      sentAt += 333;
    }

    // The producer's clock falls five seconds behind the server's.
    const stepped = simulatedSample(5_000, sentAt, 10, 0.5);
    expect(estimator.observe(stepped)).toBe('reset');

    const snapshot = estimator.snapshot();
    expect(snapshot.lowerBoundMs).toBe(stepped.serverDateMs - stepped.receivedAt);
    expect(snapshot.upperBoundMs).toBe(
      stepped.serverDateMs + HTTP_DATE_RESOLUTION_MS - stepped.sentAt,
    );
    expect(snapshot.resets).toBe(1);
    expect(snapshot.lowerBoundMs).toBeLessThanOrEqual(5_000);
    expect(snapshot.upperBoundMs).toBeGreaterThanOrEqual(5_000);
  });

  it.each([
    ['a negative round trip', { serverDateMs: 10_000, sentAt: 9_950, receivedAt: 9_900 }],
    [
      'a round trip longer than the limit',
      { serverDateMs: 10_000, sentAt: 0, receivedAt: MAX_CLOCK_SAMPLE_ROUND_TRIP_MS + 1 },
    ],
    ['a non-finite server date', { serverDateMs: Number.NaN, sentAt: 9_900, receivedAt: 9_950 }],
    [
      'a non-finite send time',
      { serverDateMs: 10_000, sentAt: Number.NEGATIVE_INFINITY, receivedAt: 9_950 },
    ],
    [
      'an interval beyond the bound',
      { serverDateMs: CLOCK_OFFSET_BOUND_MS + 20_000, sentAt: 9_900, receivedAt: 9_950 },
    ],
  ])('rejects %s without touching the estimate', (_label, sample: ClockSample) => {
    const estimator = new ClockOffsetEstimator();
    estimator.observe({ serverDateMs: 10_000, sentAt: 9_900, receivedAt: 9_950 });
    const before = estimator.snapshot();

    expect(estimator.observe(sample)).toBe('rejected');

    expect(estimator.snapshot()).toEqual({
      ...before,
      samples: before.samples + 1,
      rejected: before.rejected + 1,
    });
  });

  it('accepts a round trip of exactly the limit', () => {
    const estimator = new ClockOffsetEstimator();

    expect(
      estimator.observe({
        serverDateMs: 10_000,
        sentAt: 0,
        receivedAt: MAX_CLOCK_SAMPLE_ROUND_TRIP_MS,
      }),
    ).toBe('accepted');
  });

  it('reads a response header, ignoring a response that carried none', () => {
    const estimator = new ClockOffsetEstimator();
    const instant = Date.UTC(2026, 8, 25, 23, 57, 34);
    const header = new Date(instant).toUTCString();

    expect(estimator.observeHttpDate(null, instant - 20, instant + 10)).toBeUndefined();
    expect(estimator.observeHttpDate(undefined, instant - 20, instant + 10)).toBeUndefined();
    expect(estimator.snapshot().samples).toBe(0);

    expect(estimator.observeHttpDate('yesterday', instant - 20, instant + 10)).toBe('rejected');
    expect(estimator.observeHttpDate(header, instant - 20, instant + 10)).toBe('accepted');

    expect(estimator.snapshot()).toMatchObject({
      lowerBoundMs: -10,
      upperBoundMs: HTTP_DATE_RESOLUTION_MS + 20,
      samples: 2,
      accepted: 1,
      rejected: 1,
    });
  });

  it('reports a whole-millisecond estimate, never -0', () => {
    const estimator = new ClockOffsetEstimator();
    // Interval [-500.4, 499.6]: the midpoint -0.4 rounds to -0 without the guard.
    estimator.observe({ serverDateMs: 10_000, sentAt: 10_500.4, receivedAt: 10_500.4 });

    const estimate = estimator.estimate();
    expect(Object.is(estimate, 0)).toBe(true);
    expect(isClockOffsetMs(estimate)).toBe(true);
  });

  it('only ever reports an offset the event schema accepts', () => {
    const random = sequence(0xc10c);
    const estimator = new ClockOffsetEstimator();

    for (let index = 0; index < 500; index += 1) {
      const sentAt = BASE + random() * 1e6;
      estimator.observe({
        serverDateMs: Math.floor((sentAt + (random() - 0.5) * 2e5) / 1_000) * 1_000,
        sentAt,
        receivedAt: sentAt + random() * 50,
      });
      const estimate = estimator.estimate();

      expect(estimate === undefined || isClockOffsetMs(estimate)).toBe(true);
    }
  });

  it('hands out frozen snapshots that later samples do not change', () => {
    const estimator = new ClockOffsetEstimator();
    estimator.observe({ serverDateMs: 10_000, sentAt: 9_900, receivedAt: 9_950 });
    const first = estimator.snapshot();

    estimator.observe({ serverDateMs: 11_000, sentAt: 10_600, receivedAt: 10_620 });

    expect(Object.isFrozen(first)).toBe(true);
    expect(first.accepted).toBe(1);
    expect(estimator.snapshot().accepted).toBe(2);
  });
});
