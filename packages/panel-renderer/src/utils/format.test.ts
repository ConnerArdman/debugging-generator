/**
 * `utils/format`: the duration formatters, the byte-size formatters, and the
 * label fitting every SVG view places its labels with.
 *
 * The duration formatters are what every bar, tick, cell, tooltip and sentence
 * that mentions time prints. What is pinned is how they answer an input that
 * is not a measurement: a negative duration is corrupt, not fast, so it reads
 * as unavailable rather than as `0.00 ms`; a value below zero only by
 * floating-point noise is still zero; and an offset — a subtraction, not a
 * measurement — keeps flooring at zero.
 *
 * The byte-size formatters are the split form a metric tile renders as a
 * figure and a unit, and the joined form every other surface shows.
 *
 * Two properties are pinned. The split form answers with the same
 * discriminated shape as the duration split, so a caller styles the unit on
 * its own and can never print `undefined` beside a figure. And the joined form
 * is exactly the split form's `text` for every input, so moving a surface from
 * one to the other can never change what a reader sees.
 *
 * The untrusted-text reveal is what keeps captured and model-authored text
 * from displaying a sequence it does not contain. Pinned: each of the twelve
 * Unicode bidirectional formatting controls becomes its exact `\uXXXX`
 * marker, and no other code point changes; text without a control comes back
 * as the same string; revealing is idempotent; and every display helper that
 * returns captured text — the one-line preview, the width fit, the compact
 * path, the source chip and its title, and the humanized label — reveals, with
 * a marker never split and a preview's privacy bound still counted in
 * captured code points. Every control below is written as an escape, never as
 * the character, so this suite is not itself a carrier of one.
 */

import type { SourceLocation } from '@debuggen/shared';
import type { TelemetryKind } from '@debuggen/telemetry';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LABEL_FONT_SIZE,
  ELLIPSIS,
  ESTIMATE_NARROW_ADVANCE_EM,
  ESTIMATE_WIDE_ADVANCE_EM,
  MAX_PREVIEW_LENGTH,
  NOT_AVAILABLE_LABEL,
  collapseWhitespace,
  containsDirectionControl,
  createEstimateMeasure,
  estimateTextWidth,
  fitTextToWidth,
  formatBytes,
  formatBytesParts,
  formatCompactPath,
  formatDuration,
  formatDurationCompact,
  formatDurationParts,
  formatKindLabel,
  formatMetric,
  formatOffset,
  formatSourceChipLabel,
  formatSourceTooltip,
  formatUntrustedText,
  humanizeLabel,
  oneLinePreview,
  splitGraphemes,
  truncate,
} from './format';
import type { TextMeasure } from './format';

/** An epoch instant the offset cases measure from, in milliseconds. */
const ORIGIN_MS = 1_767_225_600_000;

/**
 * A duration field as a malformed record carries it: `null` where the schema
 * promises a number, which is what a store round-trip gone wrong delivers.
 */
const NULL_DURATION: unknown = null;

describe('formatDurationParts', () => {
  it.each([
    { ms: 0.4, value: '400', unit: 'µs' },
    { ms: 46.9994, value: '47.00', unit: 'ms' },
    { ms: 999.9, value: '999.90', unit: 'ms' },
    { ms: 1175, value: '1.175', unit: 's' },
    { ms: 44_722.6, value: '44.723', unit: 's' },
    { ms: 0, value: '0.00', unit: 'ms' },
  ])('splits $ms ms into $value and $unit', ({ ms, value, unit }) => {
    expect(formatDurationParts(ms)).toEqual({
      available: true,
      value,
      unit,
      text: `${value} ${unit}`,
    });
  });

  it.each([
    { reading: 'a negative duration', ms: -5 },
    { reading: 'a negative duration one microsecond below zero', ms: -0.001 },
    { reading: 'NaN', ms: Number.NaN },
    { reading: 'Infinity', ms: Number.POSITIVE_INFINITY },
    { reading: '-Infinity', ms: Number.NEGATIVE_INFINITY },
    { reading: 'null in a malformed record', ms: NULL_DURATION as number },
    { reading: 'a magnitude fixed notation cannot express', ms: 1e40 },
  ])('answers the unavailable arm, with no unit, for $reading', ({ ms }) => {
    const parts = formatDurationParts(ms);

    expect(parts).toEqual({
      available: false,
      value: NOT_AVAILABLE_LABEL,
      text: NOT_AVAILABLE_LABEL,
    });
    expect('unit' in parts).toBe(false);
    // The one frozen answer, whichever reading produced it.
    expect(parts).toBe(formatDurationParts(Number.NaN));
    expect(Object.isFrozen(parts)).toBe(true);
  });

  it('reads a value below zero only by floating-point noise as the zero it is', () => {
    // Rounds to zero at the stored resolution of three decimals.
    expect(formatDurationParts(-0.0004)).toEqual(formatDurationParts(0));
    expect(formatDurationParts(-0)).toEqual(formatDurationParts(0));
    expect(formatDurationParts(-0.0004, 'compact')).toEqual(formatDurationParts(0, 'compact'));
    expect(formatDuration(-0)).toBe('0.00 ms');
  });
});

describe('formatDuration and formatDurationCompact', () => {
  it('keep their documented examples', () => {
    expect(formatDuration(0.4)).toBe('400 µs');
    expect(formatDuration(46.9994)).toBe('47.00 ms');
    expect(formatDuration(1175)).toBe('1.175 s');
    expect(formatDuration(Number.NaN)).toBe(NOT_AVAILABLE_LABEL);
    expect(formatDuration(-5)).toBe(NOT_AVAILABLE_LABEL);
    expect(formatDurationCompact(46.9994)).toBe('47 ms');
    expect(formatDurationCompact(1175)).toBe('1.2 s');
  });

  it('print a corrupt duration as unavailable at both precisions, never as a measured zero', () => {
    for (const ms of [-5, -0.001, NULL_DURATION as number]) {
      expect(formatDuration(ms)).toBe(NOT_AVAILABLE_LABEL);
      expect(formatDuration(ms, 'compact')).toBe(NOT_AVAILABLE_LABEL);
      expect(formatDurationCompact(ms)).toBe(NOT_AVAILABLE_LABEL);
    }
  });

  it('are exactly the split form joined, for every reading', () => {
    for (const ms of [0, 0.4, 46.9994, 1175, -0.0004, -5, Number.NaN, 1e40]) {
      expect(formatDuration(ms)).toBe(formatDurationParts(ms).text);
      expect(formatDurationCompact(ms)).toBe(formatDurationParts(ms, 'compact').text);
    }
  });
});

describe('formatOffset', () => {
  it('prints how far after the origin an instant is', () => {
    expect(formatOffset(ORIGIN_MS + 12.5, ORIGIN_MS)).toBe('12.50 ms');
    expect(formatOffset(ORIGIN_MS + 1175, ORIGIN_MS)).toBe('1.175 s');
    expect(formatOffset(ORIGIN_MS + 1175, ORIGIN_MS, 'compact')).toBe('1.2 s');
    expect(formatOffset(ORIGIN_MS, ORIGIN_MS)).toBe('0.00 ms');
  });

  it('still clamps an instant before the origin to zero: a subtraction, not a measurement', () => {
    expect(formatOffset(ORIGIN_MS - 5, ORIGIN_MS)).toBe('0.00 ms');
    expect(formatOffset(ORIGIN_MS - 5, ORIGIN_MS, 'compact')).toBe('0 ms');
  });

  it('answers n/a for an instant or an origin that is not finite', () => {
    expect(formatOffset(Number.NaN, ORIGIN_MS)).toBe(NOT_AVAILABLE_LABEL);
    expect(formatOffset(ORIGIN_MS, Number.POSITIVE_INFINITY)).toBe(NOT_AVAILABLE_LABEL);
  });
});

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

/*
 * The untrusted-text reveal. The controls and the QA payload are built from
 * escapes; an expected marker is the six printable characters `\uXXXX`,
 * written with a doubled backslash.
 */

/** The twelve Unicode bidirectional formatting controls, and the marker each becomes. */
const DIRECTION_CONTROLS = [
  { name: 'ALM', control: '\u061C', marker: '\\u061C' },
  { name: 'LRM', control: '\u200E', marker: '\\u200E' },
  { name: 'RLM', control: '\u200F', marker: '\\u200F' },
  { name: 'LRE', control: '\u202A', marker: '\\u202A' },
  { name: 'RLE', control: '\u202B', marker: '\\u202B' },
  { name: 'PDF', control: '\u202C', marker: '\\u202C' },
  { name: 'LRO', control: '\u202D', marker: '\\u202D' },
  { name: 'RLO', control: '\u202E', marker: '\\u202E' },
  { name: 'LRI', control: '\u2066', marker: '\\u2066' },
  { name: 'RLI', control: '\u2067', marker: '\\u2067' },
  { name: 'FSI', control: '\u2068', marker: '\\u2068' },
  { name: 'PDI', control: '\u2069', marker: '\\u2069' },
] as const;

/** The QA report's payload: an override that draws a script tag backwards. */
const QA_PAYLOAD = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** What the payload displays once revealed: both controls as printable markers. */
const QA_PAYLOAD_REVEALED = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

/** The right-to-left override on its own, and its marker. */
const RLO = '\u202E';
const RLO_MARKER = '\\u202E';

/** Unicode's own definition of the set, as an independent oracle for the scan below. */
const BIDI_CONTROL_PROPERTY = /\p{Bidi_Control}/u;

/** A validated source location whose file and symbol carry an override. */
const OVERRIDDEN_LOCATION: SourceLocation = {
  file: `src/features/${RLO}stx.tropxe/handler.ts`,
  line: 12,
  column: 3,
  symbol: `load${RLO}Orders`,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/**
 * A kind this build has no label for, as a producer newer than it would send
 * one: typed through `unknown` exactly as `NULL_DURATION` is above.
 */
const UNKNOWN_KIND: unknown = `custom.${RLO}kind`;

/**
 * Whether every backslash in `text` begins a complete marker — the property a
 * cut through a marker would break.
 */
function markersAreWhole(text: string): boolean {
  return text.split('\\').every((part, index) => index === 0 || /^u[0-9A-F]{4}/u.test(part));
}

describe('formatUntrustedText', () => {
  it.each(DIRECTION_CONTROLS)('reveals $name as $marker', ({ control, marker }) => {
    const revealed = formatUntrustedText(`a${control}b`);

    expect(revealed).toBe(`a${marker}b`);
    expect(containsDirectionControl(revealed)).toBe(false);
    expect(containsDirectionControl(`a${control}b`)).toBe(true);
  });

  it('reveals every control in a string, however many and wherever they sit', () => {
    const every = DIRECTION_CONTROLS.map(({ control }) => control).join('x');
    const expected = DIRECTION_CONTROLS.map(({ marker }) => marker).join('x');

    expect(formatUntrustedText(every)).toBe(expected);
    expect(formatUntrustedText(`${RLO}${RLO}`)).toBe(`${RLO_MARKER}${RLO_MARKER}`);
  });

  it('reveals the QA payload into its logical, printable text', () => {
    expect(formatUntrustedText(QA_PAYLOAD)).toBe(QA_PAYLOAD_REVEALED);
    expect(containsDirectionControl(formatUntrustedText(QA_PAYLOAD))).toBe(false);
  });

  it('changes exactly the twelve Bidi_Control code points, and no other code point', () => {
    // Collected rather than asserted per code point, so the scan of all
    // 1,114,112 code points costs one assertion rather than a million.
    const changed: number[] = [];
    const disagreements: number[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      const character = String.fromCodePoint(point);
      const isChanged = formatUntrustedText(character) !== character;

      if (isChanged) {
        changed.push(point);
      }
      if (isChanged !== BIDI_CONTROL_PROPERTY.test(character)) {
        disagreements.push(point);
      }
    }

    expect(disagreements).toEqual([]);
    expect(changed).toEqual(DIRECTION_CONTROLS.map(({ control }) => control.charCodeAt(0)));
  });

  it.each([
    { reading: 'plain text', text: 'SELECT id FROM orders WHERE id = $1' },
    { reading: 'the empty string', text: '' },
    { reading: 'whitespace and newlines', text: ' a\n\tb ' },
    { reading: 'right-to-left letters with no control', text: '\u05E9\u05DC\u05D5\u05DD abc' },
    { reading: 'an emoji ZWJ sequence', text: '\u{1F469}\u200D\u{1F4BB}' },
    {
      reading: 'a zero width non-joiner',
      text: '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
    },
    { reading: 'text that already shows a marker', text: QA_PAYLOAD_REVEALED },
  ])('returns $reading as the same string', ({ text }) => {
    expect(formatUntrustedText(text)).toBe(text);
    expect(containsDirectionControl(text)).toBe(false);
  });

  it('is idempotent', () => {
    const once = formatUntrustedText(QA_PAYLOAD);

    expect(formatUntrustedText(once)).toBe(once);
  });

  it('answers the same on every call, so no regular expression carries state between strings', () => {
    for (let call = 0; call < 3; call += 1) {
      expect(containsDirectionControl(QA_PAYLOAD)).toBe(true);
      expect(containsDirectionControl(`${RLO}`)).toBe(true);
      expect(formatUntrustedText(QA_PAYLOAD)).toBe(QA_PAYLOAD_REVEALED);
    }
  });
});

describe('the display helpers reveal what they return', () => {
  it('oneLinePreview collapses, truncates and then reveals', () => {
    expect(oneLinePreview(`SELECT\n  ${RLO}1`)).toBe(`SELECT ${RLO_MARKER}1`);
    expect(oneLinePreview(QA_PAYLOAD)).toBe(QA_PAYLOAD_REVEALED);
  });

  it('oneLinePreview counts a control as one captured code point of the privacy bound', () => {
    // 118 letters, the override, then three more: 122 captured code points,
    // so the bound keeps 119 of them and the ellipsis.
    const captured = `${'a'.repeat(118)}${RLO}bcd`;
    const preview = oneLinePreview(captured);

    expect(preview).toBe(`${'a'.repeat(118)}${RLO_MARKER}${ELLIPSIS}`);
    expect(preview).toBe(formatUntrustedText(truncate(collapseWhitespace(captured))));
    expect(containsDirectionControl(preview)).toBe(false);
    // Longer on screen than the bound, never longer in captured content.
    expect(Array.from(preview).length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
    expect(Array.from(truncate(captured)).length).toBe(MAX_PREVIEW_LENGTH);
  });

  it('oneLinePreview drops a control the bound cuts off whole, never half a marker', () => {
    const preview = oneLinePreview(`${'a'.repeat(119)}${RLO}b`);

    expect(preview).toBe(`${'a'.repeat(119)}${ELLIPSIS}`);
    expect(markersAreWhole(preview)).toBe(true);
  });

  it('fitTextToWidth reveals a label that fits whole, and it is not truncated', () => {
    expect(fitTextToWidth(`a${RLO}b`, 100, tenPerGrapheme)).toEqual({
      text: `a${RLO_MARKER}b`,
      width: 80,
      truncated: false,
    });
  });

  it('fitTextToWidth measures the marker, so a label that fits raw may not fit revealed', () => {
    const label = `ab${RLO}cdef`;

    // Seven graphemes raw (70 units), twelve revealed (120 units).
    expect(tenPerGrapheme(label)).toBe(70);
    const fit = fitTextToWidth(label, 100, tenPerGrapheme);

    expect(fit).toEqual({ text: `ab${RLO_MARKER}c${ELLIPSIS}`, width: 100, truncated: true });

    const estimate = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);
    const revealedWidth = estimateTextWidth(formatUntrustedText(label), DEFAULT_LABEL_FONT_SIZE);
    expect(fitTextToWidth(label, revealedWidth, estimate)).toEqual({
      text: formatUntrustedText(label),
      width: revealedWidth,
      truncated: false,
    });
  });

  it('fitTextToWidth never splits a marker and never exceeds the width, at any width', () => {
    const label = `ab${RLO}cdef${RLO}gh`;

    for (let room = 1; room <= 200; room += 1) {
      const fit = fitTextToWidth(label, room, tenPerGrapheme);
      if (fit === undefined) {
        continue;
      }

      expect(fit.width).toBeLessThanOrEqual(room);
      expect(tenPerGrapheme(fit.text)).toBe(fit.width);
      expect(markersAreWhole(fit.text)).toBe(true);
      expect(containsDirectionControl(fit.text)).toBe(false);
    }

    // Between the prefix before the marker and the prefix through it, nothing
    // in between is ever drawn.
    expect(fitTextToWidth(label, 89, tenPerGrapheme)?.text).toBe(`ab${ELLIPSIS}`);
    expect(fitTextToWidth(label, 90, tenPerGrapheme)?.text).toBe(`ab${RLO_MARKER}${ELLIPSIS}`);
  });

  it('fitTextToWidth counts a marker as one grapheme of minGraphemes', () => {
    expect(fitTextToWidth(`${RLO}abcdef`, 70, tenPerGrapheme, { minGraphemes: 1 })?.text).toBe(
      `${RLO_MARKER}${ELLIPSIS}`,
    );
    expect(fitTextToWidth(`${RLO}abcdef`, 70, tenPerGrapheme, { minGraphemes: 2 })).toBeUndefined();
  });

  it('formatCompactPath reveals after normalising, so a marker is not read as a separator', () => {
    expect(formatCompactPath(OVERRIDDEN_LOCATION.file)).toBe(
      `${ELLIPSIS}/${RLO_MARKER}stx.tropxe/handler.ts`,
    );
    expect(formatCompactPath(`src\\app\\${RLO}x.ts`, 3)).toBe(`src/app/${RLO_MARKER}x.ts`);
    expect(formatCompactPath(`${RLO}.ts`)).toBe(`${RLO_MARKER}.ts`);
  });

  it('formatSourceChipLabel and formatSourceTooltip reveal the file and the symbol', () => {
    const label = formatSourceChipLabel(OVERRIDDEN_LOCATION);
    const title = formatSourceTooltip(OVERRIDDEN_LOCATION);

    expect(label).toBe(`${ELLIPSIS}/${RLO_MARKER}stx.tropxe/handler.ts:12`);
    expect(title).toBe(
      `load${RLO_MARKER}Orders — src/features/${RLO_MARKER}stx.tropxe/handler.ts:12:3`,
    );
    expect(containsDirectionControl(label)).toBe(false);
    expect(containsDirectionControl(title)).toBe(false);
    // Presentation only: the location a click hands on keeps its raw value.
    expect(OVERRIDDEN_LOCATION.file).toContain(RLO);
  });

  it('humanizeLabel, and the vocabulary labels that fall back to it, reveal', () => {
    expect(humanizeLabel(`custom.${RLO}kind`)).toBe(`Custom ${RLO_MARKER}kind`);
    expect(humanizeLabel(`${RLO}kind`)).toBe(`${RLO_MARKER}kind`);
    expect(formatKindLabel(UNKNOWN_KIND as TelemetryKind)).toBe(`Custom ${RLO_MARKER}kind`);
    expect(humanizeLabel('perf.longtask')).toBe('Perf longtask');
  });

  it('leave truncate and collapseWhitespace as plain building blocks', () => {
    expect(truncate(`${RLO}abc`, 10)).toBe(`${RLO}abc`);
    expect(collapseWhitespace(` ${RLO} a `)).toBe(`${RLO} a`);
  });
});
