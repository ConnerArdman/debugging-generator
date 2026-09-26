/**
 * `utils/format`: the byte-size formatters, and the label fitting every SVG
 * view places its labels with.
 *
 * The byte-size formatters are the split form a metric tile renders as a
 * figure and a unit, and the joined form every other surface shows.
 *
 * Two properties are pinned. The split form answers with the same
 * discriminated shape as the duration split, so a caller styles the unit on
 * its own and can never print `undefined` beside a figure. And the joined form
 * is exactly the split form's `text` for every input, so moving a surface from
 * one to the other can never change what a reader sees.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LABEL_FONT_SIZE,
  ELLIPSIS,
  ESTIMATE_NARROW_ADVANCE_EM,
  ESTIMATE_WIDE_ADVANCE_EM,
  NOT_AVAILABLE_LABEL,
  createEstimateMeasure,
  estimateTextWidth,
  fitTextToWidth,
  formatBytes,
  formatBytesParts,
  formatMetric,
  splitGraphemes,
} from './format';
import type { TextMeasure } from './format';

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

/*
 * Label fitting in logical units: the deterministic advance estimate every SVG
 * view fits its labels with, and the grapheme-safe fit itself. The fitting
 * cases use an exact, hand-written measure — ten units per grapheme — so every
 * expected string is derivable by hand.
 */

/** Ten units per grapheme: every fit below is arithmetic. */
const tenPerGrapheme: TextMeasure = (text) => splitGraphemes(text).length * 10;

describe('splitGraphemes', () => {
  it('keeps an emoji, a flag and an accented letter whole', () => {
    expect(splitGraphemes('a\u{1F680}b')).toEqual(['a', '\u{1F680}', 'b']);
    expect(splitGraphemes('\u{1F1EF}\u{1F1F5}x')).toEqual(['\u{1F1EF}\u{1F1F5}', 'x']);
    expect(splitGraphemes('e\u0301z')).toEqual(['e\u0301', 'z']);
  });

  it('answers the same graphemes on every call', () => {
    expect(splitGraphemes('ab\u{1F680}')).toEqual(splitGraphemes('ab\u{1F680}'));
    expect(splitGraphemes('')).toEqual([]);
  });
});

describe('estimateTextWidth', () => {
  it('advances 0.6 em per narrow grapheme and 1.25 em per wide one', () => {
    expect(estimateTextWidth('abcd', 10)).toBeCloseTo(4 * ESTIMATE_NARROW_ADVANCE_EM * 10);
    expect(estimateTextWidth('a\u{1F680}', 10)).toBeCloseTo(
      (ESTIMATE_NARROW_ADVANCE_EM + ESTIMATE_WIDE_ADVANCE_EM) * 10,
    );
    expect(estimateTextWidth('\u6f22\u5b57', 10)).toBeCloseTo(2 * ESTIMATE_WIDE_ADVANCE_EM * 10);
  });

  it('assumes the default label size for an unusable font size', () => {
    expect(estimateTextWidth('ab', Number.NaN)).toBeCloseTo(
      2 * ESTIMATE_NARROW_ADVANCE_EM * DEFAULT_LABEL_FONT_SIZE,
    );
    expect(createEstimateMeasure(-1)('ab')).toBeCloseTo(
      2 * ESTIMATE_NARROW_ADVANCE_EM * DEFAULT_LABEL_FONT_SIZE,
    );
    expect(createEstimateMeasure()('ab')).toBeCloseTo(
      2 * ESTIMATE_NARROW_ADVANCE_EM * DEFAULT_LABEL_FONT_SIZE,
    );
  });
});

describe('fitTextToWidth', () => {
  it('returns the whole text when it fits', () => {
    expect(fitTextToWidth('query', 50, tenPerGrapheme)).toEqual({
      text: 'query',
      width: 50,
      truncated: false,
    });
  });

  it('keeps the longest prefix that fits with its ellipsis', () => {
    expect(fitTextToWidth('abcdefghij', 55, tenPerGrapheme)).toEqual({
      text: `abcd${ELLIPSIS}`,
      width: 50,
      truncated: true,
    });
  });

  it('never splits an emoji and never exceeds the width, even for a long hostile name', () => {
    const hostile = `${'span name '.repeat(24)}\u{1F680} tail`;
    const fit = fitTextToWidth(hostile, 916, tenPerGrapheme);

    expect(fit?.truncated).toBe(true);
    expect(fit?.text.endsWith(ELLIPSIS)).toBe(true);
    expect(fit?.width).toBeLessThanOrEqual(916);
    expect(tenPerGrapheme(fit?.text ?? '')).toBe(fit?.width);
    expect(splitGraphemes(fit?.text ?? '').every((g) => g !== '\uD83D')).toBe(true);
  });

  it('trims whitespace before the ellipsis', () => {
    expect(fitTextToWidth('ab   cdefgh', 60, tenPerGrapheme)?.text).toBe(`ab${ELLIPSIS}`);
  });

  it('draws nothing when not even the shortest acceptable prefix fits', () => {
    expect(fitTextToWidth('abcdef', 15, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abcdef', 30, tenPerGrapheme, { minGraphemes: 3 })).toBeUndefined();
    expect(fitTextToWidth('abcdef', 40, tenPerGrapheme, { minGraphemes: 3 })?.text).toBe(
      `abc${ELLIPSIS}`,
    );
  });

  it('draws nothing for empty text or an unusable width', () => {
    expect(fitTextToWidth('', 100, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abc', 0, tenPerGrapheme)).toBeUndefined();
    expect(fitTextToWidth('abc', Number.NaN, tenPerGrapheme)).toBeUndefined();
  });

  it('treats a measure that answers NaN as never fitting', () => {
    expect(fitTextToWidth('abc', 100, () => Number.NaN)).toBeUndefined();
  });

  it('fits with the estimate identically on every call, so a chart is a pure function of its data', () => {
    const measure = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);
    const room = estimateTextWidth('abcdef', DEFAULT_LABEL_FONT_SIZE);

    expect(fitTextToWidth('abcdefghijkl', room, measure)).toEqual(
      fitTextToWidth('abcdefghijkl', room, measure),
    );
    expect(fitTextToWidth('abcdef', room, measure)?.truncated).toBe(false);
  });
});
