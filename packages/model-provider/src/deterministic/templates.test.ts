/**
 * The likely-cause frames stay within the statement bound, and every frame
 * states a duration in the product's one canonical text.
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
 *
 * A duration in a sentence reads exactly as the panels print it — the precise
 * rule of `packages/panel-renderer`'s `formatDuration`: whole microseconds
 * below a millisecond, hundredths of a millisecond below a second, thousandths
 * of a second from there on, grouped with `,` — so a summary never says
 * "1564.9 ms" beside a table row that says "1.565 s". The cases below pin that
 * rule with the renderer's own documented examples, and pin that no frame
 * appends a second unit to the phrase it is handed.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTEXT_PROVIDER_LIST_MAX_ITEMS,
  EVIDENCE_PATTERN_FALLBACK_LABEL,
  LABEL_MAX_LENGTH,
  METRIC_COUNT_NOUNS,
  PROBLEM_CATEGORY_FALLBACK_LABEL,
  STATEMENT_MAX_LENGTH,
  TELEMETRY_TIER_FALLBACK_LABEL,
  TRUNCATION_MARKER,
  contextChangeRenderCause,
  contextTriggeredRenderFact,
  dominantSpanCause,
  duplicateRequestCause,
  duplicateRequestFact,
  evidencePatternLabel,
  formatDurationMs,
  longTaskFact,
  metricCountNoun,
  panelSummaryHeadline,
  panelTitle,
  problemCategoryLabel,
  repeatedQueryShapeCause,
  slowestSpanFact,
  telemetryTierLabel,
  tierTimeSplitFact,
  unchangedInputRenderCause,
  unchangedInputRenderFact,
  unknownTriggerRenderFact,
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
  {
    name: 'contextChangeRenderCause with a provider and an origin',
    sentence: contextChangeRenderCause(
      longLabel('‹consumer›'),
      987_654,
      longLabel('‹provider›'),
      longLabel('‹origin›'),
    ),
    ending: 'which re-renders all its consumers, memoised or not.',
    overflows: true,
  },
  {
    name: 'contextChangeRenderCause without a provider',
    sentence: contextChangeRenderCause(longLabel('‹consumer›'), 987_654),
    ending: 'which re-renders all its consumers, memoised or not.',
    overflows: true,
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
    expect(sentence).toContain(`${TRUNCATION_MARKER} within 22.00 ms`);
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
      'Repeated identical requests from a single call site — 4 identical requests from src/‹file›.tsx:84 within 22.00 ms — match the pattern of an effect that re-runs after each render, which is what happens when a value in its dependency list is rebuilt on every render instead of being reused.',
    );
    expect(dominantSpanCause('‹operation›', 640, 1175, 'database')).toBe(
      'One operation covers most of the interaction: ‹operation›, recorded in the database tier, accounts for 640.00 ms of the 1.175 s total, which concentrates the measured time in a single step rather than spreading it across the tiers the trace spans.',
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

describe('panel titles: the class of behaviour the understanding settled on', () => {
  it.each([
    ['performance', 'Latency'],
    ['rendering', 'Render activity'],
    ['network', 'Network requests'],
    ['data', 'Database queries'],
    ['state', 'State changes'],
    ['error', 'Runtime errors'],
    ['correctness', 'Incorrect behaviour'],
  ] as const)('titles an understanding category of %s as %j', (category, title) => {
    expect(panelTitle(problemCategoryLabel(category))).toBe(title);
    expect(panelTitle(problemCategoryLabel(category), '‹component›')).toBe(
      `${title} — ‹component›`,
    );
  });

  it('keeps the colourless wording for the unclassified category and for an unknown one', () => {
    expect(problemCategoryLabel('other')).toBe(PROBLEM_CATEGORY_FALLBACK_LABEL);
    expect(problemCategoryLabel('‹newer category›')).toBe(PROBLEM_CATEGORY_FALLBACK_LABEL);
    expect(panelTitle(problemCategoryLabel('other'))).toBe('Reported behaviour');
  });
});

describe('panel headline: the tiers a capture recorded nothing in', () => {
  const counts = [{ count: 4, noun: metricCountNoun('request_count') }];

  it('adds no second sentence when no tier is silent', () => {
    expect(panelSummaryHeadline(counts, 1175)).toBe(
      'The capture recorded 4 requests across 1.175 s.',
    );
    expect(panelSummaryHeadline(counts, 1175, [])).toBe(
      'The capture recorded 4 requests across 1.175 s.',
    );
  });

  it('names one, two or three silent tiers as alternatives', () => {
    expect(panelSummaryHeadline(counts, 1175, [telemetryTierLabel('db')])).toBe(
      'The capture recorded 4 requests across 1.175 s. No database telemetry was recorded, so the views show no work in that tier.',
    );
    expect(
      panelSummaryHeadline(counts, 1175, [telemetryTierLabel('server'), telemetryTierLabel('db')]),
    ).toBe(
      'The capture recorded 4 requests across 1.175 s. No server or database telemetry was recorded, so the views show no work in those tiers.',
    );
    expect(panelSummaryHeadline([], undefined, ['browser', 'server', 'database'])).toBe(
      'The capture recorded no measured activity. No browser, server or database telemetry was recorded, so the views show no work in those tiers.',
    );
  });

  it('bounds and sanitises the tiers it names', () => {
    const headline = panelSummaryHeadline(counts, 1175, ['browser', ' ', 'server', 'database']);
    // A blank label reads with the fallback wording, and no more than three tiers are named.
    expect(headline).toContain(`No browser, ${TELEMETRY_TIER_FALLBACK_LABEL} or server telemetry`);
    expect(headline).not.toContain('database telemetry');
    expect(headline).not.toContain('\n');
  });
});

describe('formatDurationMs: the canonical duration text', () => {
  it.each([
    { ms: 0.4, text: '400 µs' },
    { ms: 0.0004, text: '0 µs' },
    { ms: 0, text: '0.00 ms' },
    { ms: 22, text: '22.00 ms' },
    { ms: 46.9994, text: '47.00 ms' },
    { ms: 999.9, text: '999.90 ms' },
    // The unit comes from the measurement, never from its rounded digits.
    { ms: 999.999, text: '1,000.00 ms' },
    { ms: 1000, text: '1.000 s' },
    { ms: 1175, text: '1.175 s' },
    { ms: 1564.94, text: '1.565 s' },
    { ms: 44_722.6, text: '44.723 s' },
    { ms: 1_234_567_890, text: '1,234,567.890 s' },
    { ms: 1e15, text: '1,000,000,000,000.000 s' },
  ])('renders $ms ms as "$text"', ({ ms, text }) => {
    expect(formatDurationMs(ms)).toBe(text);
  });

  it.each([
    { reading: 'a negative duration', ms: -5 },
    { reading: 'NaN', ms: Number.NaN },
    { reading: 'Infinity', ms: Number.POSITIVE_INFINITY },
    { reading: '-Infinity', ms: Number.NEGATIVE_INFINITY },
  ])('renders $reading as the zero a sentence can state', ({ ms }) => {
    expect(formatDurationMs(ms)).toBe('0.00 ms');
  });

  it('keeps one finite token for a magnitude fixed notation cannot express', () => {
    const text = formatDurationMs(1e30);
    expect(text).toBe('1e+27 s');
    expect(text).not.toMatch(/NaN|Infinity/u);
  });
});

describe('observed-fact frames: one unit per duration', () => {
  it('states each duration once, in the canonical text, with no unit appended to it', () => {
    expect(slowestSpanFact('‹operation›', 1564.94, 44_722.6)).toBe(
      '‹operation› took 1.565 s of the 44.723 s recorded for the interaction.',
    );
    expect(tierTimeSplitFact('server', 640, 1175)).toBe(
      'Time recorded in the server tier was 640.00 ms of the 1.175 s total.',
    );
    expect(duplicateRequestFact(4, 22, '‹route›')).toBe(
      '4 requests to ‹route› occurred within 22.00 ms.',
    );
    expect(longTaskFact(2, 187.5)).toBe(
      'The capture recorded 2 long tasks during the interaction, the longest lasting 187.50 ms.',
    );
    expect(panelSummaryHeadline([{ count: 4, noun: METRIC_COUNT_NOUNS.request_count }], 1175)).toBe(
      'The capture recorded 4 requests across 1.175 s.',
    );
  });

  it('never doubles a unit, whatever the magnitude', () => {
    for (const ms of [0, 0.4, 22, 999.999, 1175, 44_722.6, 1e15]) {
      for (const sentence of [
        slowestSpanFact('‹operation›', ms, ms),
        tierTimeSplitFact('browser', ms, ms),
        duplicateRequestFact(3, ms),
        longTaskFact(1, ms),
        panelSummaryHeadline([], ms),
        duplicateRequestCause(3, ms, 'src/‹file›.tsx:84'),
        dominantSpanCause('‹operation›', ms, ms),
      ]) {
        expect(sentence).not.toMatch(/(?:µs|ms|s) (?:µs|ms|s)\b/u);
      }
    }
  });
});

describe('context-change frames', () => {
  it('states a context-triggered render fact byte for byte, naming the one provider', () => {
    expect(contextTriggeredRenderFact('‹consumer›', 40, 42, ['‹provider›'])).toBe(
      '40 of 42 renders of ‹consumer› followed a change in the context provided by ‹provider›.',
    );
  });

  it('joins several providers as alternatives, most frequent first, and caps the list', () => {
    const providers = ['‹a›', '‹b›', '‹c›', '‹d›'];
    expect(contextTriggeredRenderFact('‹consumer›', 9, 10, providers)).toBe(
      '9 of 10 renders of ‹consumer› followed a change in a context provided by ‹a›, ‹b› or ‹c›.',
    );
    expect(CONTEXT_PROVIDER_LIST_MAX_ITEMS).toBe(3);
  });

  it('leaves the context unnamed when no provider label is usable', () => {
    expect(contextTriggeredRenderFact('‹consumer›', 1, 1, ['  ', ''])).toBe(
      '1 of 1 render of ‹consumer› followed a change in a consumed context value.',
    );
    expect(contextTriggeredRenderFact('', 2, 3)).toBe(
      '2 of 3 renders of an unnamed component followed a change in a consumed context value.',
    );
  });

  it('keeps the fact within the statement bound when every label is at the cap', () => {
    const sentence = contextTriggeredRenderFact(longLabel('‹consumer›'), 987_654, 987_655, [
      longLabel('‹a›'),
      longLabel('‹b›'),
      longLabel('‹c›'),
    ]);
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
    expect(sentence.startsWith('987654 of 987655 renders of ‹consumer›')).toBe(true);
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence).toContain(' or ');
  });

  it('states the cause byte for byte with its provider and origin', () => {
    expect(contextChangeRenderCause('‹consumer›', 40, '‹provider›', '‹origin›')).toBe(
      'Renders after a context change — 40 renders of ‹consumer› followed a new value from the context of ‹provider›, driven by state updates in ‹origin› — match a provider that builds a new value on each render, which re-renders all its consumers, memoised or not.',
    );
  });

  it('drops an origin that is the provider itself, and a blank one', () => {
    const expected =
      'Renders after a context change — 1 render of ‹consumer› followed a new value from the context of ‹provider› — match a provider that builds a new value on each render, which re-renders all its consumers, memoised or not.';
    expect(contextChangeRenderCause('‹consumer›', 1, '‹provider›', '‹provider›')).toBe(expected);
    expect(contextChangeRenderCause('‹consumer›', 1, '‹provider›', ' ')).toBe(expected);
    expect(contextChangeRenderCause('‹consumer›', 1, '‹provider›')).toBe(expected);
  });

  it('reads without a provider name', () => {
    expect(contextChangeRenderCause('‹consumer›', 5)).toBe(
      'Renders after a context change — 5 renders of ‹consumer› followed a change in a consumed context value — match a provider that builds a new value on each render, which re-renders all its consumers, memoised or not.',
    );
  });

  it('fits typical names without shortening any of them', () => {
    const sentence = contextChangeRenderCause(
      'CatalogItemTileCard',
      123_456,
      'BasketStateProvider',
      'DeliveryWindowProvider',
    );
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
    expect(sentence.includes(TRUNCATION_MARKER)).toBe(false);
  });

  it('has display wording for the pattern', () => {
    expect(evidencePatternLabel('context-change-renders')).toBe(
      'renders following a changed context value',
    );
    expect(evidencePatternLabel('context-change-renders')).not.toBe(
      EVIDENCE_PATTERN_FALLBACK_LABEL,
    );
  });
});

describe('per-component trigger facts', () => {
  it('names the component whose renders had unchanged inputs', () => {
    expect(unchangedInputRenderFact(2_463, 4_977, 'StatusPanel')).toBe(
      '2463 of 4977 renders of StatusPanel had shallow-equal props, unchanged own hook state and no changed consumed context value.',
    );
  });

  it('names the component whose render triggers could not be determined', () => {
    expect(unknownTriggerRenderFact(12, 40, 'StatusPanel')).toBe(
      'The trigger could not be determined for 12 of 40 renders of StatusPanel.',
    );
  });

  it('keeps the capture-wide wording when no component is named, or the name is blank', () => {
    const unchanged =
      '20 of 50 renders had shallow-equal props, unchanged own hook state and no changed consumed context value.';
    expect(unchangedInputRenderFact(20, 50)).toBe(unchanged);
    expect(unchangedInputRenderFact(20, 50, '   ')).toBe(unchanged);
    expect(unknownTriggerRenderFact(3, 50)).toBe(
      'The trigger could not be determined for 3 of 50 renders.',
    );
    expect(unknownTriggerRenderFact(3, 50, '')).toBe(
      'The trigger could not be determined for 3 of 50 renders.',
    );
  });

  it('keeps both facts within the statement bound when the name is at the label cap', () => {
    const label = longLabel('Component');
    for (const sentence of [
      unchangedInputRenderFact(9_999_999, 9_999_999, label),
      unknownTriggerRenderFact(9_999_999, 9_999_999, label),
    ]) {
      expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
      expect(sentence.startsWith('Component') || sentence.includes(' of Component')).toBe(true);
    }
  });
});
