/**
 * The deterministic analysis of a context cascade.
 *
 * A render capture of a page with a ticking provider re-renders a great deal,
 * and the busiest rows are rarely the ones responsible: a framework's internal
 * components and the children of re-rendered cards outnumber the component
 * whose context keeps changing. These cases drive {@link buildAnalysis} with a
 * structured context shaped exactly as the analyze stage hands it over — the
 * service's analysis input (`apps/local-service/src/analysis/summarize.ts`)
 * under `captureSummary`, render rows carrying `triggers`, `changedContexts`
 * as `{ name, count }` records, `declaredInProject` and per-render
 * `occurrences` with `changedContextNames` — and assert that:
 *
 * - the project component whose renders mostly followed a context change is
 *   an observed fact, naming the provider of that context;
 * - the first likely cause names that consumer, its provider and the provider
 *   the chain traces back to, suggests the immediate provider's declaration
 *   and cites a render of every link;
 * - a framework component with a larger count is never chosen;
 * - the answer is a function of the evidence alone: byte-identical across
 *   runs, across row order and across the developer's wording.
 *
 * Every name is invented, generic vocabulary.
 */
import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../types.js';

import { buildAnalysis } from './rules.js';

/* -------------------------------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------------------------------- */

/** A well-formed 32-hex trace identifier. */
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** The consumer: a memoised card that reads the basket context. */
const TILE = 'ItemTile';
const TILE_FILE = 'src/catalog/item-tile.tsx';

/** The immediate provider: consumes the ticker and publishes a fresh value each render. */
const BASKET = 'BasketProvider';
const BASKET_FILE = 'src/state/basket-provider.tsx';

/** The origin: a provider whose own state ticks on a timer. */
const TICKER = 'TickerProvider';
const TICKER_FILE = 'src/state/ticker-provider.tsx';

/** A child of every card, re-rendered with it through unchanged or inline-callback props. */
const BUTTON = 'ActionButton';
const BUTTON_FILE = 'src/ui/action-button.tsx';

/** Framework components the project renders but does not declare. */
const MINIFIED = 'zQ';
const FRAMEWORK_LINK = 'FrameworkLink';

/** How one fixture render row is described. */
interface RowSpec {
  readonly component: string;
  readonly renderCount: number;
  readonly triggers: Readonly<Partial<Record<string, number>>>;
  readonly unchanged?: number;
  readonly contexts?: readonly (readonly [string, number])[];
  readonly declared?: boolean;
  readonly file?: string;
  readonly resolvedBy?: string;
  /** The trigger of the carried occurrences, and the contexts they name. */
  readonly occurrenceTrigger: string;
  readonly occurrenceContexts?: readonly string[];
  /** Event-id stem; five occurrences `‹stem›-1` … `‹stem›-5` are carried. */
  readonly stem: string;
}

/** A validated-shape source location. */
function location(file: string, line: number, resolvedBy = 'code-graph'): JsonObject {
  return { file, line, column: 1, symbol: 'component', resolvedBy, confidence: 0.9 };
}

/** One render row, shaped as `toRenderRow` emits it. */
function renderRow(spec: RowSpec): JsonObject {
  const occurrences: JsonObject[] = [];
  for (let index = 1; index <= 5; index += 1) {
    occurrences.push({
      eventId: `${spec.stem}-${String(index)}`,
      spanId: `00f067aa0ba902b${String(index)}`,
      traceId: TRACE_ID,
      startTime: 1_700_000_000_000 + index,
      durationMs: 0.4,
      phase: 'update',
      trigger: spec.occurrenceTrigger,
      changedPropNames: [],
      changedContextNames: [...(spec.occurrenceContexts ?? [])],
    });
  }
  return {
    component: spec.component,
    renderCount: spec.renderCount,
    totalDurationMs: spec.renderCount * 0.4,
    averageDurationMs: 0.4,
    maxDurationMs: 2,
    firstStartTime: 1_700_000_000_000,
    lastStartTime: 1_700_000_030_000,
    triggers: {
      props: spec.triggers.props ?? 0,
      state: spec.triggers.state ?? 0,
      context: spec.triggers.context ?? 0,
      unchanged: spec.unchanged ?? 0,
      unknown: spec.triggers.unknown ?? 0,
    },
    unchangedRenderCount: spec.unchanged ?? 0,
    unknownTriggerCount: spec.triggers.unknown ?? 0,
    phaseCounts: { mount: 1, update: spec.renderCount - 1 },
    changedProps: [],
    changedContexts: (spec.contexts ?? []).map(([name, count]) => ({ name, count })),
    ...(spec.declared === undefined ? {} : { declaredInProject: spec.declared }),
    ...(spec.file === undefined ? {} : { source: location(spec.file, 12, spec.resolvedBy) }),
    occurrences,
    occurrencesTruncated: true,
  };
}

/** The cascade of the module header, busiest row first as the service orders them. */
const CASCADE_ROWS: readonly RowSpec[] = [
  {
    component: MINIFIED,
    renderCount: 12_000,
    triggers: { props: 2_000 },
    unchanged: 10_000,
    declared: false,
    file: TILE_FILE,
    resolvedBy: 'react-owner',
    occurrenceTrigger: 'unchanged',
    stem: 'ev-min',
  },
  {
    component: TILE,
    renderCount: 9_000,
    triggers: { context: 8_800, props: 150, unknown: 2 },
    unchanged: 40,
    contexts: [[BASKET, 8_800]],
    declared: true,
    file: TILE_FILE,
    occurrenceTrigger: 'context',
    occurrenceContexts: [BASKET],
    stem: 'ev-tile',
  },
  {
    component: BUTTON,
    renderCount: 5_000,
    triggers: { props: 2_500 },
    unchanged: 2_500,
    declared: true,
    file: BUTTON_FILE,
    occurrenceTrigger: 'unchanged',
    stem: 'ev-button',
  },
  {
    component: FRAMEWORK_LINK,
    renderCount: 4_000,
    triggers: { context: 3_990 },
    contexts: [['FrameworkRouter', 3_990]],
    declared: false,
    file: TILE_FILE,
    resolvedBy: 'react-owner',
    occurrenceTrigger: 'context',
    occurrenceContexts: ['FrameworkRouter'],
    stem: 'ev-link',
  },
  {
    component: BASKET,
    renderCount: 186,
    triggers: { context: 184, state: 2 },
    contexts: [[TICKER, 184]],
    declared: true,
    file: BASKET_FILE,
    occurrenceTrigger: 'context',
    occurrenceContexts: [TICKER],
    stem: 'ev-basket',
  },
  {
    component: TICKER,
    renderCount: 186,
    triggers: { state: 186 },
    declared: true,
    file: TICKER_FILE,
    occurrenceTrigger: 'state',
    stem: 'ev-ticker',
  },
];

/** How a context may be varied. */
interface ContextOptions {
  /** Replaces the render rows. */
  readonly rows?: readonly RowSpec[];
  /** Rearranges the rows after they are built. */
  readonly reorder?: (rows: readonly JsonObject[]) => readonly JsonObject[];
  /** The developer's wording, which no builder may read. */
  readonly question?: string;
  /** Replaces the built rows entirely. */
  readonly renders?: readonly JsonObject[];
}

/** The analyze stage's structured context: the capture summary section plus understanding. */
function analyzeContext(options: ContextOptions = {}): JsonObject {
  const built = (options.rows ?? CASCADE_ROWS).map(renderRow);
  const renders =
    options.renders ?? (options.reorder === undefined ? built : options.reorder(built));
  const renderTotal = (options.rows ?? CASCADE_ROWS).reduce((sum, row) => sum + row.renderCount, 0);
  return {
    understanding: {
      categoryHint: 'excessive-renders',
      summary: options.question ?? 'Why does this card keep rendering?',
    },
    captureSummary: {
      sessionId: 'ses_0000000000000001',
      captureId: 'cap_0000000000000001',
      ...(options.question === undefined ? {} : { followUpQuestion: options.question }),
      capture: {
        captureId: 'cap_0000000000000001',
        planVersion: 1,
        startedAt: 1_700_000_000_000,
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_033_000,
        durationMs: 33_000,
        eventCount: renderTotal,
        eventsConsidered: renderTotal,
        eventsExcluded: 0,
        eventsTruncated: false,
        traceCount: 1,
        primaryTraceId: TRACE_ID,
        producerCount: 1,
      },
      metrics: [
        { id: 'total_duration', label: 'Total', unit: 'ms', available: true, value: 33_000 },
        {
          id: 'render_count',
          label: 'Renders',
          unit: 'count',
          available: true,
          value: renderTotal,
        },
        {
          id: 'unchanged_render_count',
          label: 'Unchanged',
          unit: 'count',
          available: true,
          value: 12_540,
        },
        {
          id: 'render_trigger_unknown_count',
          label: 'Unknown',
          unit: 'count',
          available: true,
          value: 2,
        },
      ],
      traces: [],
      topSpans: [
        {
          eventId: 'ev-nav-1',
          spanId: '00f067aa0ba90201',
          traceId: TRACE_ID,
          kind: 'navigation',
          tier: 'browser',
          name: 'navigation',
          startTime: 1_700_000_000_000,
          durationMs: 240,
          status: 'ok',
        },
        {
          eventId: 'ev-self-1',
          spanId: '00f067aa0ba90202',
          traceId: TRACE_ID,
          kind: 'longtask',
          tier: 'browser',
          name: 'self',
          startTime: 1_700_000_001_000,
          durationMs: 82,
          status: 'ok',
        },
      ],
      renders: [...renders],
      requests: [],
      queries: [],
      stateTransitions: [],
      errors: [],
      relevantFiles: [],
      factCandidates: [],
      truncated: { sections: [] },
    },
    codeExcerpts: [],
  };
}

/* -------------------------------------------------------------------------------------------------
 * readers
 * ---------------------------------------------------------------------------------------------- */

/** One observed fact or likely cause, as the tests read it. */
interface Finding {
  readonly statement: string;
  readonly evidence: readonly string[];
  readonly confidence: string | undefined;
  readonly file: string | undefined;
}

/** The value as an object, failing the case otherwise. */
function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** The value as an array, failing the case otherwise. */
function arrayOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, received ${JSON.stringify(value)}`);
  }
  return value as readonly unknown[];
}

/** One finding of the analysis. */
function findingOf(value: unknown): Finding {
  const record = objectOf(value);
  const suggested = record.suggestedLocation;
  return {
    statement: String(record.statement),
    evidence: arrayOf(record.evidence).map((ref) => String(objectOf(ref).eventId)),
    confidence: typeof record.confidence === 'string' ? record.confidence : undefined,
    file: suggested === undefined ? undefined : String(objectOf(suggested).file),
  };
}

/** The analysis of `context`, serialised: the bytes a run hands to the analyze stage. */
function analysisBytes(context: JsonObject): string {
  return JSON.stringify(buildAnalysis(context));
}

/** The analysis of `context`, read into findings. */
function analyze(context: JsonObject): {
  readonly observed: readonly Finding[];
  readonly causes: readonly Finding[];
} {
  const analysis = objectOf(buildAnalysis(context));
  return {
    observed: arrayOf(analysis.observed).map(findingOf),
    causes: arrayOf(analysis.likelyCauses).map(findingOf),
  };
}

/** Every event id the context's render rows carry. */
function carriedIds(context: JsonObject): ReadonlySet<string> {
  const ids = new Set<string>();
  const summary = objectOf(context.captureSummary);
  for (const row of arrayOf(summary.renders)) {
    for (const occurrence of arrayOf(objectOf(row).occurrences)) {
      ids.add(String(objectOf(occurrence).eventId));
    }
  }
  for (const span of arrayOf(summary.topSpans)) {
    ids.add(String(objectOf(span).eventId));
  }
  return ids;
}

/** Whether a statement names `component` as a whole word. */
function names(statement: string, component: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${component}([^A-Za-z0-9]|$)`).test(statement);
}

/* -------------------------------------------------------------------------------------------------
 * cases
 * ---------------------------------------------------------------------------------------------- */

describe('deterministic analysis: a context cascade', () => {
  it('reports the context-triggered consumer as an observed fact naming its provider', () => {
    const { observed } = analyze(analyzeContext());

    expect(observed.length).toBeLessThanOrEqual(8);
    const fact = observed.find((finding) => names(finding.statement, TILE));
    expect(fact?.statement).toBe(
      `8800 of 9000 renders of ${TILE} followed a change in the context provided by ${BASKET}.`,
    );
    // Cited by the consumer's context-triggered renders, not by any other row's.
    expect(fact?.evidence.length).toBeGreaterThan(0);
    for (const id of fact?.evidence ?? []) {
      expect(id.startsWith('ev-tile-')).toBe(true);
    }
  });

  it('leads the likely causes with the cascade, naming consumer, provider and origin', () => {
    const { causes } = analyze(analyzeContext());
    const first = causes[0];

    expect(first?.statement).toBe(
      `Renders after a context change — 8800 renders of ${TILE} followed a new value from the context of ${BASKET}, driven by state updates in ${TICKER} — match a provider that builds a new value on each render, which re-renders all its consumers, memoised or not.`,
    );
    expect(first?.confidence).toBe('high');
    // The immediate provider's declaration: where the changing value is built.
    expect(first?.file).toBe(BASKET_FILE);
    // A render of every link the sentence names.
    const evidence = first?.evidence ?? [];
    expect(evidence.some((id) => id.startsWith('ev-tile-'))).toBe(true);
    expect(evidence.some((id) => id.startsWith('ev-basket-'))).toBe(true);
    expect(evidence.some((id) => id.startsWith('ev-ticker-'))).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(5);
  });

  it('follows the unchanged-input cause to the named provider rather than to the state publisher', () => {
    const { causes } = analyze(analyzeContext());
    const position = causes.findIndex((cause) =>
      cause.statement.startsWith('Renders with unchanged inputs'),
    );
    const unchanged = causes[position];

    // After the cascade that explains it.
    expect(position).toBe(1);
    // The project component with the most unchanged renders relative to its
    // renders — not the framework row with more of them.
    expect(unchanged?.statement).toContain(`of ${BUTTON}`);
    // The provider the capture named, not the component with the most state
    // updates, which the counts-only guess would pick.
    expect(unchanged?.file).toBe(BASKET_FILE);
    // Its own renders are cited, alongside one of the provider's.
    expect(unchanged?.evidence.some((id) => id.startsWith('ev-button-'))).toBe(true);
    expect(unchanged?.evidence.some((id) => id.startsWith('ev-basket-'))).toBe(true);
  });

  it('never chooses a framework component, however often it rendered', () => {
    const { observed, causes } = analyze(analyzeContext());

    for (const finding of [...observed, ...causes]) {
      expect(names(finding.statement, MINIFIED)).toBe(false);
      expect(names(finding.statement, FRAMEWORK_LINK)).toBe(false);
      for (const id of finding.evidence) {
        expect(id.startsWith('ev-min-')).toBe(false);
        expect(id.startsWith('ev-link-')).toBe(false);
      }
    }
    // The busiest project component is the render outlier, not the busiest row.
    expect(observed.some((finding) => finding.statement.startsWith(`${TILE} rendered 9000`))).toBe(
      true,
    );
  });

  it('cites only event ids the context carries', () => {
    const context = analyzeContext();
    const carried = carriedIds(context);
    const { observed, causes } = analyze(context);

    for (const finding of [...observed, ...causes]) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      for (const id of finding.evidence) {
        expect(carried.has(id)).toBe(true);
      }
    }
  });

  it('keeps the cascade ahead of the unchanged-input cause without raising its confidence', () => {
    // A cascade with little evidence of its own beside a large unchanged-input
    // count; the providers' rows fell outside the input, so the small consumer
    // is the strongest context-triggered one.
    const rows: RowSpec[] = CASCADE_ROWS.filter(
      (row) => row.component !== BASKET && row.component !== TICKER,
    ).map((row) =>
      row.component === TILE
        ? {
            ...row,
            renderCount: 4,
            triggers: { context: 3 },
            unchanged: 0,
            contexts: [[BASKET, 3]],
          }
        : row,
    );
    const { causes } = analyze(analyzeContext({ rows }));

    expect(causes[0]?.statement.startsWith('Renders after a context change — 3 renders')).toBe(
      true,
    );
    expect(causes[0]?.confidence).toBe('medium');
    expect(causes[1]?.statement.startsWith('Renders with unchanged inputs')).toBe(true);
    expect(causes[1]?.confidence).toBe('high');
  });
});

describe('deterministic analysis: the provider chain', () => {
  it('stops at a provider cycle and names no origin', () => {
    const rows: RowSpec[] = CASCADE_ROWS.map((row) =>
      row.component === TICKER
        ? { ...row, triggers: { context: 180, state: 6 }, contexts: [[BASKET, 180]] }
        : row,
    );
    const { causes } = analyze(analyzeContext({ rows }));

    expect(causes[0]?.statement).toContain(`followed a new value from the context of ${BASKET} —`);
    expect(causes[0]?.statement).not.toContain('driven by');
    expect(causes[0]?.file).toBe(BASKET_FILE);
  });

  it('names a provider the capture carries no row for, suggesting the consumer', () => {
    const rows = CASCADE_ROWS.filter((row) => row.component !== BASKET && row.component !== TICKER);
    const { causes } = analyze(analyzeContext({ rows }));

    expect(causes[0]?.statement).toContain(
      `of ${TILE} followed a new value from the context of ${BASKET} —`,
    );
    expect(causes[0]?.file).toBe(TILE_FILE);
  });

  it('omits the origin clause when the immediate provider is itself state-driven', () => {
    const rows: RowSpec[] = CASCADE_ROWS.map((row) =>
      row.component === BASKET ? { ...row, triggers: { state: 186 }, contexts: [] } : row,
    );
    const { causes } = analyze(analyzeContext({ rows }));

    expect(causes[0]?.statement).toContain(`the context of ${BASKET} — match`);
    expect(causes[0]?.file).toBe(BASKET_FILE);
  });

  it('reads a plain list of provider names with a count map the same way', () => {
    const renders = CASCADE_ROWS.map(renderRow).map((row) => {
      const contexts = arrayOf(row.changedContexts).map((entry) => objectOf(entry));
      return {
        ...row,
        changedContexts: contexts.map((entry) => String(entry.name)),
        changedContextCounts: Object.fromEntries(
          contexts.map((entry) => [String(entry.name), Number(entry.count)]),
        ),
      };
    });

    expect(buildAnalysis(analyzeContext({ renders }))).toEqual(buildAnalysis(analyzeContext()));
  });
});

describe('deterministic analysis: ownership unknown', () => {
  it('considers every row when the context says nothing about ownership', () => {
    const renders = CASCADE_ROWS.map(renderRow).map((row): JsonObject =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'declaredInProject')),
    );
    const { observed } = analyze(analyzeContext({ renders }));

    expect(
      observed.some((finding) => finding.statement.startsWith(`${MINIFIED} rendered 12000`)),
    ).toBe(true);
  });
});

describe('deterministic analysis: determinism and wording invariance', () => {
  it('is byte-identical across runs', () => {
    expect(analysisBytes(analyzeContext())).toBe(analysisBytes(analyzeContext()));
  });

  it('does not depend on the order the rows arrive in', () => {
    const base = analysisBytes(analyzeContext());

    expect(analysisBytes(analyzeContext({ reorder: (rows) => [...rows].reverse() }))).toBe(base);
    expect(
      analysisBytes(analyzeContext({ reorder: (rows) => [...rows.slice(3), ...rows.slice(0, 3)] })),
    ).toBe(base);
  });

  it('does not depend on how the developer worded the question', () => {
    expect(
      analysisBytes(analyzeContext({ question: 'Why is this component rendering so many times?' })),
    ).toBe(analysisBytes(analyzeContext({ question: 'what makes the card re-render constantly' })));
  });
});

/** A declared panel whose carried renders have the given triggers (`undefined`: none reported). */
function mixedRow(stem: string, triggers: readonly (string | undefined)[]): JsonObject {
  const row = renderRow({
    component: 'StatusPanel',
    renderCount: 830,
    triggers: { props: 500, unknown: 20, context: 10 },
    unchanged: 300,
    declared: true,
    file: 'src/ui/status-panel.tsx',
    occurrenceTrigger: 'props',
    stem,
  });
  return {
    ...row,
    occurrences: triggers.map((trigger, index) => {
      const occurrence = objectOf(arrayOf(row.occurrences)[index]) as JsonObject;
      const { trigger: _dropped, ...rest } = occurrence;
      void _dropped;
      return trigger === undefined ? rest : { ...rest, trigger };
    }),
  };
}

describe('deterministic analysis: per-trigger render facts', () => {
  const UNCHANGED_FACT =
    '300 of 830 renders of StatusPanel had shallow-equal props, unchanged own hook state and no changed consumed context value.';
  const UNKNOWN_FACT = 'The trigger could not be determined for 20 of 830 renders of StatusPanel.';

  it('names the component and cites only renders of the trigger each fact counts', () => {
    const { observed } = analyze(
      analyzeContext({
        renders: [mixedRow('ev-mix', ['props', 'unchanged', 'unknown', 'props', 'context'])],
      }),
    );
    const unchanged = observed.find((fact) => fact.statement === UNCHANGED_FACT);
    const unknown = observed.find((fact) => fact.statement === UNKNOWN_FACT);

    expect(unchanged?.evidence).toEqual(['ev-mix-2']);
    expect(unknown?.evidence).toEqual(['ev-mix-3']);
    for (const fact of observed) {
      expect(fact.statement).not.toMatch(/^\d+ of \d+ renders had /u);
    }
  });

  it('drops a trigger fact none of whose renders were carried rather than cite other triggers', () => {
    const { observed } = analyze(
      analyzeContext({
        renders: [mixedRow('ev-props', ['props', 'props', 'props', 'props', 'props'])],
      }),
    );
    const statements = observed.map((fact) => fact.statement);

    expect(statements).not.toContain(UNCHANGED_FACT);
    expect(statements).not.toContain(UNKNOWN_FACT);
    expect(statements).toContain('StatusPanel rendered 830 times during the interaction.');
  });

  it("falls back to the statistic's renders when no carried render reports a trigger", () => {
    const { observed } = analyze(
      analyzeContext({
        renders: [mixedRow('ev-bare', [undefined, undefined, undefined])],
      }),
    );
    const unchanged = observed.find((fact) => fact.statement === UNCHANGED_FACT);

    expect(unchanged?.evidence).toEqual(['ev-bare-1', 'ev-bare-2', 'ev-bare-3']);
  });
});
