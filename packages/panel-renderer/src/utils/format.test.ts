/**
 * The byte-size formatters of `utils/format`: the split form a metric tile
 * renders as a figure and a unit, and the joined form every other surface
 * shows.
 *
 * Two properties are pinned. The split form answers with the same
 * discriminated shape as the duration split, so a caller styles the unit on
 * its own and can never print `undefined` beside a figure. And the joined form
 * is exactly the split form's `text` for every input, so moving a surface from
 * one to the other can never change what a reader sees.
 */

import { describe, expect, it } from 'vitest';

import { NOT_AVAILABLE_LABEL, formatBytes, formatBytesParts, formatMetric } from './format';

/** One kilobyte on the decimal (SI) scale the formatter uses. */
const KB = 1000;

describe('formatBytesParts', () => {
  it.each([
    { bytes: 0, value: '0', unit: 'B' },
    { bytes: 1, value: '1', unit: 'B' },
    { bytes: 512, value: '512', unit: 'B' },
    { bytes: 999, value: '999', unit: 'B' },
    { bytes: KB, value: '1.0', unit: 'kB' },
    { bytes: 2048, value: '2.0', unit: 'kB' },
    { bytes: 1_500_000, value: '1.5', unit: 'MB' },
    { bytes: 3.2 * KB ** 3, value: '3.2', unit: 'GB' },
    { bytes: 7 * KB ** 4, value: '7.0', unit: 'TB' },
    { bytes: 4.5 * KB ** 5, value: '4.5', unit: 'PB' },
  ])('splits $bytes bytes into $value and $unit', ({ bytes, value, unit }) => {
    expect(formatBytesParts(bytes)).toEqual({
      available: true,
      value,
      unit,
      text: `${value} ${unit}`,
    });
  });

  it('keeps the petabyte unit, with grouped digits, beyond the top of the scale', () => {
    expect(formatBytesParts(1234 * KB ** 5)).toEqual({
      available: true,
      value: '1,234.0',
      unit: 'PB',
      text: '1,234.0 PB',
    });
  });

  it('clamps a negative size to zero bytes, as the producers do', () => {
    expect(formatBytesParts(-512)).toEqual({ available: true, value: '0', unit: 'B', text: '0 B' });
  });

  it.each([
    { reading: 'NaN', bytes: Number.NaN },
    { reading: 'Infinity', bytes: Number.POSITIVE_INFINITY },
    { reading: '-Infinity', bytes: Number.NEGATIVE_INFINITY },
    { reading: 'a magnitude fixed notation cannot express', bytes: 1e40 },
  ])('answers the unavailable arm, with no unit, for $reading', ({ bytes }) => {
    const parts = formatBytesParts(bytes);

    expect(parts).toEqual({
      available: false,
      value: NOT_AVAILABLE_LABEL,
      text: NOT_AVAILABLE_LABEL,
    });
    expect('unit' in parts).toBe(false);
  });

  it('shares one frozen unavailable answer, so no caller can mutate it', () => {
    const first = formatBytesParts(Number.NaN);

    expect(formatBytesParts(Number.POSITIVE_INFINITY)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    0,
    1,
    512,
    999,
    KB,
    2048,
    999_949,
    999_950,
    1_500_000,
    3.2 * KB ** 3,
    1234 * KB ** 5,
    -512,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e40,
  ])('is exactly the split form joined, for %d', (bytes) => {
    expect(formatBytes(bytes)).toBe(formatBytesParts(bytes).text);
  });

  it('keeps its documented examples', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(Number.NaN)).toBe(NOT_AVAILABLE_LABEL);
  });

  it('is still what a measured byte metric formats to, and an unmeasured one is n/a', () => {
    const measured = formatMetric({
      id: 'transferred_bytes',
      label: 'Transferred bytes',
      unit: 'bytes',
      value: 2048,
      available: true,
    });
    const unmeasured = formatMetric({
      id: 'transferred_bytes',
      label: 'Transferred bytes',
      unit: 'bytes',
      available: false,
    });

    expect(measured.text).toBe(formatBytes(2048));
    expect(measured.available).toBe(true);
    expect(unmeasured.text).toBe(NOT_AVAILABLE_LABEL);
    expect(unmeasured.available).toBe(false);
  });
});
