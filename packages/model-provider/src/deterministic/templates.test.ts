/**
 * The likely-cause frames stay within the statement bound.
 *
 * Every hypothesis the deterministic provider emits is validated against the
 * analyze stage's schema, whose `statement` is capped at
 * {@link STATEMENT_MAX_LENGTH} characters (`@debuggen/panel-schema`'s
 * `MAX_STATEMENT_LENGTH`). The cause frames carry long fixed wording, so a
 * label near {@link LABEL_MAX_LENGTH} — a deep call-site path, a long span name,
 * a parameterised SQL statement — used to push the sentence past that cap, and
 * the whole analyze stage then failed with a schema miss. These tests pin the
 * bound for every frame, and pin that a sentence which already fits is emitted
 * byte for byte.
 */
import { describe, expect, it } from 'vitest';

import {
  LABEL_MAX_LENGTH,
  STATEMENT_MAX_LENGTH,
  TRUNCATION_MARKER,
  dominantSpanCause,
  duplicateRequestCause,
  repeatedQueryShapeCause,
  unchangedInputRenderCause,
} from './templates.js';

/** A label at the cap every frame receives it at (`sanitizeLabel` never passes a longer one). */
function longLabel(prefix: string): string {
  return `${prefix}${'x'.repeat(LABEL_MAX_LENGTH)}`.slice(0, LABEL_MAX_LENGTH);
}

/** A call site the way a deep project reports one: `file:line`, far longer than the frame can hold. */
const DEEP_CALL_SITE = longLabel('src/features/storefront/widgets/panels/nested/area/‹file›.tsx:');

/** One cause frame rendered with maximum-length labels and large numbers. */
interface LongCase {
  readonly name: string;
  readonly sentence: string;
  /** The frame's closing clause, which only a shortened label — never a cut sentence — preserves. */
  readonly ending: string;
  /** Whether the labels at the cap overflow this frame, so a label must be shortened. */
  readonly overflows: boolean;
}

const LONG_CASES: readonly LongCase[] = [
  {
    name: 'duplicateRequestCause',
    sentence: duplicateRequestCause(123_456, 98_765.4, DEEP_CALL_SITE),
    ending: 'rebuilt on every render instead of being reused.',
    overflows: true,
  },
  {
    name: 'unchangedInputRenderCause',
    sentence: unchangedInputRenderCause(longLabel('‹component›'), 987_654),
    ending: 'whose own props and state did not change.',
    overflows: true,
  },
  {
    name: 'dominantSpanCause with a tier',
    sentence: dominantSpanCause(longLabel('‹operation›'), 98_765.4, 123_456.7, 'database'),
    ending: 'across the tiers the trace spans.',
    overflows: true,
  },
  {
    name: 'dominantSpanCause without a tier',
    sentence: dominantSpanCause(longLabel('‹operation›'), 98_765.4, 123_456.7),
    ending: 'across the tiers the trace spans.',
    overflows: true,
  },
  {
    name: 'repeatedQueryShapeCause with a caller',
    sentence: repeatedQueryShapeCause(
      4_321,
      longLabel('SELECT ‹columns› FROM ‹table› WHERE '),
      DEEP_CALL_SITE,
    ),
    ending: 'rather than once for the whole set.',
    overflows: true,
  },
  {
    name: 'repeatedQueryShapeCause without a caller',
    sentence: repeatedQueryShapeCause(4_321, longLabel('SELECT ‹columns› FROM ‹table› WHERE ')),
    ending: 'rather than once for the whole set.',
    overflows: false,
  },
];

describe('likely-cause frames: the statement bound', () => {
  it('restates the 300-character statement bound of the analysis schema', () => {
    expect(STATEMENT_MAX_LENGTH).toBe(300);
  });

  it.each(LONG_CASES)('$name fits the bound with labels at the label cap', ({ sentence }) => {
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
    expect(sentence.trim()).toBe(sentence);
  });

  it.each(LONG_CASES)(
    '$name keeps its whole fixed wording, shortening only a label',
    ({ sentence, ending, overflows }) => {
      expect(sentence.endsWith(ending)).toBe(true);
      expect(sentence.includes(TRUNCATION_MARKER)).toBe(overflows);
    },
  );

  it('keeps the start of a shortened call site, so the file is still recognisable', () => {
    const sentence = duplicateRequestCause(4, 22, DEEP_CALL_SITE);
    expect(sentence).toContain(' from src/features/storefront/');
    expect(sentence).toContain(`${TRUNCATION_MARKER} within 22 ms`);
  });

  it('shortens the longer of two labels first', () => {
    const sentence = repeatedQueryShapeCause(
      3,
      longLabel('SELECT ‹columns› FROM ‹table› '),
      'src/‹file›.ts:51',
    );
    expect(sentence).toContain('from src/‹file›.ts:51 (SELECT');
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
  });

  it('emits a sentence that already fits byte for byte', () => {
    expect(duplicateRequestCause(4, 22, 'src/‹file›.tsx:84')).toBe(
      'Repeated identical requests from a single call site — 4 identical requests from src/‹file›.tsx:84 within 22 ms — match the pattern of an effect that re-runs after each render, which is what happens when a value in its dependency list is rebuilt on every render instead of being reused.',
    );
    expect(dominantSpanCause('‹operation›', 640, 1175, 'database')).toBe(
      'One operation covers most of the interaction: ‹operation›, recorded in the database tier, accounts for 640 ms of the 1175 ms total, which concentrates the measured time in a single step rather than spreading it across the tiers the trace spans.',
    );
    expect(repeatedQueryShapeCause(3, 'SELECT id FROM ‹table› WHERE bucket = $1')).toBe(
      'A statement repeated inside one interaction — 3 database queries of the same shape (SELECT id FROM ‹table› WHERE bucket = $1) — matches the pattern of a lookup made once per item rather than once for the whole set.',
    );
  });

  it('stays within the bound even when the counts alone are extreme', () => {
    const sentence = duplicateRequestCause(Number.MAX_SAFE_INTEGER, 1e15, DEEP_CALL_SITE);
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
  });
});
