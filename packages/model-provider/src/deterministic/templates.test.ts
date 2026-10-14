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
  FOCUS_SUBJECT_MAX_ITEMS,
  HEADLINE_MAX_LENGTH,
  LABEL_MAX_LENGTH,
  METRIC_COUNT_NOUNS,
  OBJECTIVE_MAX_LENGTH,
  OBJECTIVE_MAX_ROUTES,
  PROBLEM_CATEGORY_FALLBACK_LABEL,
  STATEMENT_MAX_LENGTH,
  TELEMETRY_TIER_FALLBACK_LABEL,
  TRUNCATION_MARKER,
  UNNAMED_SYMBOL_LABEL,
  codeRelevanceReason,
  codeSymbolKindLabel,
  contextChangeRenderCause,
  contextTriggeredRenderFact,
  dominantSpanCause,
  duplicateRequestCause,
  duplicateRequestFact,
  evidencePatternLabel,
  focusSubjectLabel,
  focusedDeclarationFact,
  formatDurationMs,
  longTaskFact,
  metricCountNoun,
  panelFocusSentence,
  panelSummaryHeadline,
  panelTitle,
  planObjective,
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

describe('plan objective: structured facts, never a fixed tail', () => {
  it('restates the 500-character objective bound of the plan schema', () => {
    expect(OBJECTIVE_MAX_LENGTH).toBe(500);
    expect(OBJECTIVE_MAX_ROUTES).toBe(3);
  });

  it('reproduces an input-driven behaviour through an interaction with the target', () => {
    expect(
      planObjective(problemCategoryLabel('performance'), '‹component›', 'interaction', [
        'POST /‹route›',
      ]),
    ).toBe(
      'Determine what accounts for the latency recorded at ‹component› and POST /‹route› while an interaction with ‹component› is reproduced.',
    );
  });

  it('observes the page for a behaviour that shows without input', () => {
    expect(planObjective(problemCategoryLabel('rendering'), '‹component›')).toBe(
      'Determine what accounts for the render activity recorded at ‹component› while the page is observed.',
    );
    expect(
      planObjective(problemCategoryLabel('network'), undefined, 'page', ['GET /‹route›']),
    ).toBe(
      'Determine what accounts for the network requests recorded at GET /‹route› while the page is observed.',
    );
  });

  it('names no target and no location when there is nothing to name', () => {
    expect(planObjective(problemCategoryLabel('performance'), undefined, 'interaction')).toBe(
      'Determine what accounts for the latency recorded while the interaction is reproduced.',
    );
    expect(planObjective(problemCategoryLabel('performance'), '  ', 'interaction')).toBe(
      'Determine what accounts for the latency recorded while the interaction is reproduced.',
    );
    expect(planObjective(problemCategoryLabel('other'), '  ')).toBe(
      'Determine what accounts for the reported behaviour recorded while the page is observed.',
    );
  });

  it('names each traced route once, never the target twice, and counts the rest', () => {
    expect(
      planObjective(problemCategoryLabel('data'), '‹component›', 'interaction', [
        'GET /‹a›',
        ' ',
        'GET /‹a›',
        '‹component›',
        'GET /‹b›',
        'GET /‹c›',
        'GET /‹d›',
        'GET /‹e›',
      ]),
    ).toBe(
      'Determine what accounts for the database queries recorded at ‹component›, GET /‹a›, GET /‹b›, GET /‹c› and 2 more while an interaction with ‹component› is reproduced.',
    );
  });

  it('never carries the old fixed tail', () => {
    for (const reproduction of ['interaction', 'page'] as const) {
      expect(planObjective('latency', '‹component›', reproduction)).not.toContain(
        'reported behaviour is reproduced',
      );
    }
  });

  it('stays within the objective bound with every label at the label cap', () => {
    const target = longLabel('‹component›');
    const routes = ['GET /', 'POST /', 'PUT /', 'DELETE /'].map((method) => longLabel(method));
    const objective = planObjective('latency', target, 'interaction', routes);
    expect(objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX_LENGTH);
    expect(
      objective.startsWith('Determine what accounts for the latency recorded at ‹component›'),
    ).toBe(true);
    expect(objective.endsWith(' is reproduced.')).toBe(true);
    expect(objective).toContain(' and 1 more while an interaction with ‹component›');
  });
});

describe('follow-up focus: the fact about a focused declaration', () => {
  it('states the runs, their summed time and their share of the interaction byte for byte', () => {
    expect(focusedDeclarationFact('‹symbol›', 3, 900, 1200)).toBe(
      '‹symbol› ran 3 times for 900.00 ms in total (75% of the 1.200 s recorded for the interaction).',
    );
    expect(focusedDeclarationFact('‹symbol›', 1, 42.5)).toBe(
      '‹symbol› ran 1 time for 42.50 ms in total.',
    );
  });

  it('never states a share below one percent as zero, nor one above the whole', () => {
    expect(focusedDeclarationFact('‹symbol›', 2, 3, 1200)).toContain(
      '(less than 1% of the 1.200 s recorded',
    );
    expect(focusedDeclarationFact('‹symbol›', 2, 0, 1200)).toContain('(0% of the 1.200 s');
    expect(focusedDeclarationFact('‹symbol›', 2, 1500, 1200)).toContain('(100% of the 1.200 s');
    expect(focusedDeclarationFact('‹symbol›', 2, 5, 0)).toContain('(0% of the 0.00 ms');
  });

  it('reads a blank name with the unnamed-symbol wording', () => {
    expect(focusedDeclarationFact('  ', 2, 10)).toBe(
      `${UNNAMED_SYMBOL_LABEL} ran 2 times for 10.00 ms in total.`,
    );
  });

  it('stays within the statement bound with a name at the label cap', () => {
    const sentence = focusedDeclarationFact(longLabel('‹symbol›'), 9_999_999, 1e12, 1e12);
    expect(sentence.length).toBeLessThanOrEqual(STATEMENT_MAX_LENGTH);
    expect(sentence.endsWith('recorded for the interaction).')).toBe(true);
    expect(sentence.startsWith('‹symbol›')).toBe(true);
  });
});

describe('follow-up focus: the subject a focused panel is titled and headlined by', () => {
  it('joins up to three declarations and counts the rest', () => {
    expect(FOCUS_SUBJECT_MAX_ITEMS).toBe(3);
    expect(focusSubjectLabel(['‹a›'])).toBe('‹a›');
    expect(focusSubjectLabel(['‹a›', '‹b›'])).toBe('‹a› and ‹b›');
    expect(focusSubjectLabel(['‹a›', '‹b›', '‹c›'])).toBe('‹a›, ‹b› and ‹c›');
    expect(focusSubjectLabel(['‹a›', '‹b›', '‹c›', '‹d›', '‹e›'])).toBe('‹a›, ‹b›, ‹c› and 2 more');
  });

  it('drops blank names and reads an empty list with the unnamed-symbol wording', () => {
    expect(focusSubjectLabel(['‹a›', ' ', '‹b›'])).toBe('‹a› and ‹b›');
    expect(focusSubjectLabel([])).toBe(UNNAMED_SYMBOL_LABEL);
    expect(focusSubjectLabel(['', '  '])).toBe(UNNAMED_SYMBOL_LABEL);
  });

  it('titles a panel by the focus subject', () => {
    expect(panelTitle(problemCategoryLabel('performance'), focusSubjectLabel(['‹a›', '‹b›']))).toBe(
      'Latency — ‹a› and ‹b›',
    );
  });
});

describe('follow-up focus: the headline sentence naming the focus', () => {
  const counts = [{ count: 4, noun: metricCountNoun('request_count') }];

  it('names a focus category or a focus subject in one non-evidentiary sentence', () => {
    expect(panelFocusSentence(problemCategoryLabel('data'))).toBe('Focused on database queries.');
    expect(panelFocusSentence('‹symbol›')).toBe('Focused on ‹symbol›.');
    expect(panelFocusSentence(' ')).toBe(`Focused on ${PROBLEM_CATEGORY_FALLBACK_LABEL}.`);
  });

  it('closes the headline with the focus sentence, after any silent-tier sentence', () => {
    expect(panelSummaryHeadline(counts, 1175, [], '‹symbol›')).toBe(
      'The capture recorded 4 requests across 1.175 s. Focused on ‹symbol›.',
    );
    expect(panelSummaryHeadline(counts, 1175, [telemetryTierLabel('db')], '‹symbol›')).toBe(
      'The capture recorded 4 requests across 1.175 s. No database telemetry was recorded, so the views show no work in that tier. Focused on ‹symbol›.',
    );
  });

  it('keeps a focused headline within the headline bound, shortening only the focus', () => {
    expect(HEADLINE_MAX_LENGTH).toBe(500);
    const many = Array.from({ length: 6 }, (_, index) => ({
      count: Number.MAX_SAFE_INTEGER - index,
      noun: metricCountNoun('unchanged_render_count'),
    }));
    const focus = focusSubjectLabel([longLabel('‹a›'), longLabel('‹b›'), longLabel('‹c›')]);
    const headline = panelSummaryHeadline(
      many,
      1e15,
      [telemetryTierLabel('browser'), telemetryTierLabel('server'), telemetryTierLabel('db')],
      focus,
    );
    expect(headline.length).toBeLessThanOrEqual(HEADLINE_MAX_LENGTH);
    expect(headline).toContain('so the views show no work in those tiers. Focused on ‹a›');
    expect(headline.endsWith('.')).toBe(true);
  });

  it('leaves the headline unchanged without a focus, or with a blank one', () => {
    const unfocused = panelSummaryHeadline(counts, 1175, []);
    expect(panelSummaryHeadline(counts, 1175, [], undefined)).toBe(unfocused);
    expect(panelSummaryHeadline(counts, 1175, [], '   ')).toBe(unfocused);
  });
});

describe('code-relevance reasons: a relation the graph recorded, or none claimed', () => {
  it('names the related entity byte for byte', () => {
    expect(codeRelevanceReason(codeSymbolKindLabel('component'), '‹route›')).toBe(
      'The code graph associates this component with ‹route›.',
    );
    expect(codeRelevanceReason(codeSymbolKindLabel('file'), '  ‹looked-up name›\n')).toBe(
      'The code graph associates this file with ‹looked-up name›.',
    );
  });

  it('words a candidate nothing relates without an entity, never an unnamed one', () => {
    const expected = "The code graph returned this symbol in the investigation's query results.";
    for (const blank of ['', '   ', '\n\t']) {
      const reason = codeRelevanceReason(codeSymbolKindLabel('symbol'), blank);
      expect(reason).toBe(expected);
      expect(reason).not.toContain('unnamed');
    }
    expect(codeRelevanceReason(codeSymbolKindLabel('symbol'))).toBe(expected);
  });

  it('reads the code graph’s handler kind as an event handler, in both spellings', () => {
    expect(codeSymbolKindLabel('handler')).toBe('event handler');
    expect(codeSymbolKindLabel('event-handler')).toBe('event handler');
    expect(codeRelevanceReason(codeSymbolKindLabel('handler'), '‹route›')).toBe(
      'The code graph associates this event handler with ‹route›.',
    );
    expect(codeRelevanceReason(codeSymbolKindLabel('handler'), '')).toBe(
      "The code graph returned this event handler in the investigation's query results.",
    );
  });

  it('keeps the generic kind wording for a kind the graph does not report', () => {
    expect(codeRelevanceReason(codeSymbolKindLabel('‹newer kind›'), '‹route›')).toBe(
      'The code graph associates this symbol with ‹route›.',
    );
  });
});
