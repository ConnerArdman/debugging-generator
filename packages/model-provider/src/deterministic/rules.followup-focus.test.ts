/**
 * A follow-up's structured focus composes the analysis and the panel it
 * regenerates (AAP §0.4.2, Follow-up row; §0.5.4).
 *
 * The service places a `followUpFocus` section — closed-vocabulary category
 * hints and the declarations the follow-up named, resolved through the code
 * graph — at the top level of the analyze and generate-panel contexts whenever
 * a follow-up governs them. These cases pin what the rules make of it:
 *
 * - without a focus, or with one that carries nothing usable, both stages
 *   answer exactly as they do for a first question;
 * - a category focus ranks the facts and causes that answer it first, and
 *   composes the panel through its lens, its sources, its metrics, its title and
 *   a headline sentence naming it;
 * - a declaration focus adds a fact about the runs the capture measured of it,
 *   titles the panel by it, ranks the span table by the work it is measured as,
 *   narrows the trace views to the interaction holding its slowest run and
 *   points the source link at it;
 * - the answer depends on the structured focus only, never on any wording.
 *
 * The contexts are shaped as `apps/local-service` assembles them: the analysis
 * summary's `topSpans`, `traces`, `requests` and `queries` rows under
 * `captureSummary`, and the panel context's `capture` overview beside the node
 * catalog as the service serialises it. Every name is invented.
 */
import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue, ModelRequest, PromptStage } from '../types.js';
import { buildAnalysis, buildDeterministicOutput, buildPanelSpecInput } from './rules.js';

/* -------------------------------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The interaction's trace, and a second one a focused declaration also ran in. */
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const OTHER_TRACE_ID = '5b8aa5a2d2c872e8321cf37308d69df2';

const ROUTE_FILE = 'src/routes/heron/route.ts';
const LEDGER_FILE = 'src/services/heron-ledger.ts';

/** A one-word declaration, the shape of name the reported follow-up named. */
const PERCH = 'perch';

/** A declaration the capture never measured. */
const ROOST = 'roost';

/** The owner chain of the selected element, nearest owner first. */
const OWNER_CHAIN: readonly string[] = ['HeronSubmit', 'HeronForm'];

/** A resolver-reported source location. */
function location(file: string, line: number, symbol?: string): JsonObject {
  return {
    file,
    line,
    column: 1,
    ...(symbol !== undefined ? { symbol } : {}),
    resolvedBy: 'code-graph',
    confidence: 0.9,
  };
}

/** How one analysis-summary span row is described. */
interface SpanRowSpec {
  readonly eventId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceId?: string;
  readonly kind: string;
  readonly tier: string;
  readonly name: string;
  readonly durationMs: number;
  readonly source?: JsonObject;
}

/** A span row as the analysis summary's `topSpans` and trace sections carry it. */
function spanRow(spec: SpanRowSpec): JsonObject {
  return {
    eventId: spec.eventId,
    spanId: spec.spanId,
    ...(spec.parentSpanId !== undefined ? { parentSpanId: spec.parentSpanId } : {}),
    traceId: spec.traceId ?? TRACE_ID,
    kind: spec.kind,
    tier: spec.tier,
    name: spec.name,
    startTime: 1_700_000_000_000,
    durationMs: spec.durationMs,
    status: 'ok',
    ...(spec.source !== undefined ? { source: spec.source } : {}),
  };
}

/**
 * The interaction's spans: a route handler, the statement it issued, two runs
 * of {@link PERCH} (the second nested inside the first, so its time is already
 * inside its caller's) and the page's request.
 */
const SPANS: readonly JsonObject[] = [
  spanRow({
    eventId: 'ev-route-01',
    spanId: 'sp-route-01',
    kind: 'http.server',
    tier: 'server',
    name: 'POST /herons',
    durationMs: 900,
    source: location(ROUTE_FILE, 8),
  }),
  spanRow({
    eventId: 'ev-query-01',
    spanId: 'sp-query-01',
    parentSpanId: 'sp-route-01',
    kind: 'db.query',
    tier: 'db',
    name: 'SELECT herons',
    durationMs: 420,
    source: location(LEDGER_FILE, 30),
  }),
  spanRow({
    eventId: 'ev-perch-01',
    spanId: 'sp-perch-01',
    parentSpanId: 'sp-route-01',
    kind: 'function',
    tier: 'server',
    name: PERCH,
    durationMs: 300,
    source: location(LEDGER_FILE, 12, PERCH),
  }),
  spanRow({
    eventId: 'ev-perch-02',
    spanId: 'sp-perch-02',
    parentSpanId: 'sp-perch-01',
    kind: 'function',
    tier: 'server',
    name: PERCH,
    durationMs: 120,
    source: location(LEDGER_FILE, 12, PERCH),
  }),
  spanRow({
    eventId: 'ev-fetch-01',
    spanId: 'sp-fetch-01',
    kind: 'fetch',
    tier: 'browser',
    name: 'GET /api/herons',
    durationMs: 200,
  }),
];

/** The metrics both contexts report, in the service's list carrier. */
const METRICS: readonly JsonObject[] = [
  { id: 'total_duration', value: 1200 },
  { id: 'frontend_duration', value: 150 },
  { id: 'backend_duration', value: 900 },
  { id: 'database_duration', value: 520 },
  { id: 'request_count', value: 4 },
  { id: 'duplicate_request_count', value: 3 },
  { id: 'query_count', value: 6 },
  { id: 'transferred_bytes', value: 4096 },
];

/** A context with a `followUpFocus` section, or without one when `focus` is `undefined`. */
function withFocus(context: JsonObject, focus: JsonValue | undefined): JsonObject {
  return focus === undefined ? context : { ...context, followUpFocus: focus };
}

/**
 * The analyze context of a session framed as a request question: duplicated
 * requests, a statement shape repeated six times from inside {@link PERCH},
 * and the spans above (or `spans`), listed both as the slowest spans and as the
 * trace.
 */
function analyzeContext(focus?: JsonValue, spans: readonly JsonObject[] = SPANS): JsonObject {
  return withFocus(
    {
      understanding: { category: 'network' },
      captureSummary: {
        metrics: [...METRICS],
        topSpans: [...spans],
        traces: [{ traceId: TRACE_ID, primary: true, spans: [...spans] }],
        requests: [
          {
            id: 'req-01',
            method: 'GET',
            url: '/api/herons',
            path: '/api/herons',
            count: 4,
            duplicateCount: 3,
            hasDuplicates: true,
            totalDurationMs: 600,
            eventIds: ['ev-fetch-01', 'ev-fetch-02', 'ev-fetch-03', 'ev-fetch-04'],
          },
        ],
        queries: [
          {
            id: 'qry-01',
            statement: 'SELECT id FROM herons WHERE nest = $1',
            executionCount: 6,
            totalDurationMs: 420,
            occurrences: [
              { eventId: 'ev-query-01' },
              { eventId: 'ev-query-02' },
              { eventId: 'ev-query-03' },
            ],
            callers: [
              {
                name: PERCH,
                executionCount: 6,
                totalDurationMs: 420,
                source: location(LEDGER_FILE, 30, PERCH),
              },
            ],
          },
        ],
        renders: [],
        errors: [],
      },
    },
    focus,
  );
}

/** The node catalog as the service serialises it (`catalogEntryContext`). */
const CATALOG: readonly JsonObject[] = [
  { type: 'section', sources: [], telemetryKinds: [], supportsChildren: true },
  { type: 'timeline', sources: ['trace', 'spans'], telemetryKinds: [], requiresQuery: true },
  {
    type: 'waterfall',
    sources: ['spans', 'requests'],
    telemetryKinds: ['fetch', 'xhr', 'http.server', 'db.query', 'http.client'],
    requiresQuery: true,
  },
  { type: 'eventLog', sources: ['events'], telemetryKinds: [], requiresQuery: true },
  {
    type: 'metricCards',
    sources: ['metrics'],
    defaultSource: 'metrics',
    telemetryKinds: [],
    requiresQuery: true,
  },
  { type: 'flame', sources: ['trace'], telemetryKinds: [], requiresQuery: true },
  { type: 'table', sources: ['spans', 'events'], telemetryKinds: [], requiresQuery: true },
  {
    type: 'renderTable',
    sources: ['renders'],
    telemetryKinds: ['render', 'commit'],
    requiresQuery: true,
  },
  {
    type: 'componentTree',
    sources: ['componentTree'],
    telemetryKinds: ['render', 'commit'],
    requiresQuery: true,
  },
  {
    type: 'requestTable',
    sources: ['requests'],
    telemetryKinds: ['fetch', 'xhr'],
    requiresQuery: true,
  },
  { type: 'queryTable', sources: ['queries'], telemetryKinds: ['db.query'], requiresQuery: true },
  {
    type: 'stateTransitions',
    sources: ['stateTransitions'],
    telemetryKinds: ['state'],
    requiresQuery: true,
  },
  { type: 'dependencyGraph', sources: ['graph'], telemetryKinds: [], requiresQuery: true },
  { type: 'sourceLink', sources: [], telemetryKinds: [], carriesLocation: true },
];

/** A span as the panel context's capture overview lists it: no event or span identifier. */
function panelSpan(
  traceId: string,
  kind: string,
  tier: string,
  name: string,
  durationMs: number,
  source?: JsonObject,
): JsonObject {
  return {
    traceId,
    kind,
    tier,
    name,
    durationMs,
    selfTimeMs: durationMs,
    status: 'ok',
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * The generate-panel context of the same session: request, query and span
 * material, with {@link PERCH}'s longest run recorded in {@link OTHER_TRACE_ID}.
 */
function panelContext(focus?: JsonValue): JsonObject {
  return withFocus(
    {
      understanding: { category: 'network', signalsNeeded: ['fetch'] },
      target: { componentChain: [...OWNER_CHAIN], tagName: 'button' },
      analysis: {
        observed: [
          {
            statement: '4 requests to /api/herons occurred within 0.00 ms.',
            evidence: [{ eventId: 'ev-fetch-01' }],
          },
        ],
        likelyCauses: [],
      },
      nodeCatalog: [...CATALOG],
      populatedSources: {
        trace: 2,
        spans: 9,
        events: 13,
        renders: 0,
        componentTree: 0,
        requests: 4,
        queries: 6,
        stateTransitions: 0,
        graph: 13,
        metrics: 8,
      },
      capture: {
        primaryTraceId: TRACE_ID,
        traceCount: 2,
        eventCount: 13,
        kindCounts: { fetch: 4, 'http.server': 1, 'db.query': 6, function: 2 },
        tierCounts: { browser: 4, server: 3, db: 6 },
        spans: [
          panelSpan(
            TRACE_ID,
            'http.server',
            'server',
            'POST /herons',
            900,
            location(ROUTE_FILE, 8),
          ),
          panelSpan(TRACE_ID, 'db.query', 'db', 'SELECT herons', 420, location(LEDGER_FILE, 30)),
          panelSpan(
            OTHER_TRACE_ID,
            'function',
            'server',
            PERCH,
            300,
            location(LEDGER_FILE, 12, PERCH),
          ),
          panelSpan(TRACE_ID, 'function', 'server', PERCH, 120, location(LEDGER_FILE, 12, PERCH)),
          panelSpan(TRACE_ID, 'fetch', 'browser', 'GET /api/herons', 200),
        ],
        renders: [],
        requests: [{ method: 'GET', url: '/api/herons', count: 4, duplicateCount: 3 }],
        queries: [
          {
            statement: 'SELECT id FROM herons WHERE nest = $1',
            executionCount: 6,
            totalDurationMs: 420,
          },
        ],
        errors: [],
        metrics: [...METRICS],
      },
    },
    focus,
  );
}

/** A focus on categories alone. */
function categoryFocus(...categoryHints: readonly string[]): JsonObject {
  return { categoryHints: [...categoryHints], declarations: [] };
}

/** A focus on declarations, with optional category hints. */
function declarationFocus(
  symbols: readonly string[],
  categoryHints: readonly string[] = [],
): JsonObject {
  return {
    categoryHints: [...categoryHints],
    declarations: symbols.map((symbol) => ({ file: LEDGER_FILE, symbol, kind: 'symbol' })),
  };
}

/* -------------------------------------------------------------------------------------------------
 * readers of the builders' answers
 * ---------------------------------------------------------------------------------------------- */

/** An answer's object, failing the test when it is not one. */
function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** An answer's list, failing the test when it is not one. */
function listOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected a list, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** The analysis of an analyze context. */
function analysisOf(context: JsonObject): {
  readonly observed: readonly Record<string, unknown>[];
  readonly likelyCauses: readonly Record<string, unknown>[];
} {
  const answer = objectOf(buildAnalysis(context));
  return {
    observed: listOf(answer.observed).map(objectOf),
    likelyCauses: listOf(answer.likelyCauses).map(objectOf),
  };
}

/** The statements of a list of facts or causes. */
function statements(entries: readonly Record<string, unknown>[]): readonly unknown[] {
  return entries.map((entry) => entry.statement);
}

/** The event identifiers one fact or cause cites. */
function citedIds(entry: Record<string, unknown> | undefined): readonly unknown[] {
  return listOf(entry?.evidence).map((reference) => objectOf(reference).eventId);
}

/** The panel specification of a generate-panel context. */
function panelOf(context: JsonObject): {
  readonly title: unknown;
  readonly summary: unknown;
  readonly layout: readonly Record<string, unknown>[];
} {
  const answer = objectOf(buildPanelSpecInput(context));
  return {
    title: answer.title,
    summary: answer.summary,
    layout: listOf(answer.layout).map(objectOf),
  };
}

/** The node types of a panel's layout, in order. */
function layoutTypes(panel: ReturnType<typeof panelOf>): readonly unknown[] {
  return panel.layout.map((node) => node.type);
}

/** The first layout node of `type`, failing the test when there is none. */
function nodeOf(panel: ReturnType<typeof panelOf>, type: string): Record<string, unknown> {
  const node = panel.layout.find((candidate) => candidate.type === type);
  if (node === undefined) {
    throw new Error(`expected a ${type} node in ${layoutTypes(panel).join(', ')}`);
  }
  return node;
}

/** The metric ids of a panel's metric cards. */
function cardIds(panel: ReturnType<typeof panelOf>): readonly unknown[] {
  return listOf(nodeOf(panel, 'metricCards').metrics);
}

/** One request to the rules, worded after `variant`; only the stage and the context are read. */
function requestFor(stage: PromptStage, input: JsonObject, variant: string): ModelRequest {
  return {
    prompt: `${variant}: rendered prompt for the ${stage} stage.`,
    system: `${variant}: system instruction.`,
    messages: [{ role: 'user', content: `${variant}: the developer asked again.` }],
    input,
    metadata: { stage, promptVersion: 'v001' },
  };
}

/** The rules' answer to a request, serialised; a failure fails the test. */
function answeredJson(request: ModelRequest): string {
  const result = buildDeterministicOutput(request);
  if (!result.ok) {
    throw new Error(`the rules refused the request: ${result.error.message}`);
  }
  return JSON.stringify(result.value);
}

/* -------------------------------------------------------------------------------------------------
 * without a usable focus nothing changes
 * ---------------------------------------------------------------------------------------------- */

/** Focus sections that carry nothing a builder can use. */
const UNUSABLE_FOCI: readonly JsonValue[] = [
  null,
  'data',
  [],
  {},
  { categoryHints: [], declarations: [] },
  // Outside the closed vocabulary, or not a category of its own.
  { categoryHints: ['other', 'latency-ish', 42], declarations: [] },
  // A declaration names a symbol, or it names nothing.
  {
    categoryHints: [],
    declarations: [{ file: LEDGER_FILE, kind: 'symbol' }, { symbol: '   ' }, 7],
  },
];

describe('followUpFocus: absent or unusable, both stages answer as for a first question', () => {
  it('builds the analysis of a focus-less context byte for byte as before', () => {
    const first = JSON.stringify(buildAnalysis(analyzeContext()));
    for (const focus of UNUSABLE_FOCI) {
      expect(JSON.stringify(buildAnalysis(analyzeContext(focus)))).toBe(first);
    }
  });

  it('builds the panel of a focus-less context byte for byte as before', () => {
    const first = JSON.stringify(buildPanelSpecInput(panelContext()));
    for (const focus of UNUSABLE_FOCI) {
      expect(JSON.stringify(buildPanelSpecInput(panelContext(focus)))).toBe(first);
    }
  });

  it('adds no focus sentence and keeps the session framing without a focus', () => {
    const panel = panelOf(panelContext());
    expect(String(panel.title).startsWith('Network requests')).toBe(true);
    expect(panel.summary).not.toContain('Focused on');
    expect(layoutTypes(panel)).not.toContain('queryTable');
  });
});

/* -------------------------------------------------------------------------------------------------
 * a category focus
 * ---------------------------------------------------------------------------------------------- */

describe('followUpFocus: a category focus answers the category it names', () => {
  it('ranks the facts about database work first under a data focus, citing the capture', () => {
    const unfocused = analysisOf(analyzeContext());
    const focused = analysisOf(analyzeContext(categoryFocus('data')));

    // The first question leads with the slowest operation of any tier.
    expect(unfocused.observed[0]?.statement).toBe(
      'POST /herons took 900.00 ms of the 1.200 s recorded for the interaction.',
    );
    expect(statements(focused.observed).slice(0, 3)).toEqual([
      'SELECT herons took 420.00 ms of the 1.200 s recorded for the interaction.',
      '6 database queries of the same statement shape ran during the interaction (SELECT id FROM herons WHERE nest = $1).',
      'Time recorded in the database tier was 520.00 ms of the 1.200 s total.',
    ]);
    // The same facts, reordered: a focus ranks, it does not invent.
    expect([...statements(focused.observed)].sort()).toEqual(
      [...statements(unfocused.observed)].sort(),
    );
    for (const fact of focused.observed) {
      expect(citedIds(fact).length).toBeGreaterThan(0);
    }
  });

  it('orders the causes whose pattern answers the focus first', () => {
    const network = analysisOf(analyzeContext(categoryFocus('network')));
    const data = analysisOf(analyzeContext(categoryFocus('data')));
    const performance = analysisOf(analyzeContext(categoryFocus('performance')));

    expect(String(network.likelyCauses[0]?.statement)).toMatch(/^Repeated identical requests/u);
    expect(String(data.likelyCauses[0]?.statement)).toMatch(/^A statement repeated/u);
    expect(String(performance.likelyCauses[0]?.statement)).toMatch(/^One operation covers/u);
  });

  it('composes a database-query panel for a data follow-up of a request session', () => {
    const unfocused = panelOf(panelContext());
    const focused = panelOf(panelContext(categoryFocus('data')));

    expect(String(focused.title).startsWith('Database queries')).toBe(true);
    expect(focused.title).not.toBe(unfocused.title);
    // The views over the focus's own source come first, then the rest of its lens.
    expect(layoutTypes(focused)[0]).toBe('queryTable');
    expect(layoutTypes(unfocused)).not.toContain('queryTable');
    // The metrics that measure database work lead the cards and the headline.
    expect(cardIds(focused).slice(0, 2)).toEqual(['query_count', 'database_duration']);
    expect(focused.summary).toBe(
      'The capture recorded 6 database queries, 4 requests and 3 duplicate requests across 1.200 s. Focused on database queries.',
    );
  });

  it('keeps the lens of a focus that asks what the session asked, and still names it', () => {
    const unfocused = panelOf(panelContext());
    const focused = panelOf(panelContext(categoryFocus('network')));

    expect(focused.title).toBe(unfocused.title);
    expect([...layoutTypes(focused)].sort()).toEqual([...layoutTypes(unfocused)].sort());
    expect(layoutTypes(focused)[0]).toBe('requestTable');
    expect(String(focused.summary).endsWith(' Focused on network requests.')).toBe(true);
  });

  it('falls back to the session lens when the focus category has no material', () => {
    const focused = panelOf(panelContext(categoryFocus('rendering')));

    // Nothing rendered, so a render lens would be empty; the request lens stays.
    expect(layoutTypes(focused)).toContain('requestTable');
    expect(layoutTypes(focused)).not.toContain('renderTable');
    expect(String(focused.title).startsWith('Render activity')).toBe(true);
    expect(String(focused.summary).endsWith(' Focused on render activity.')).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * a declaration focus
 * ---------------------------------------------------------------------------------------------- */

describe('followUpFocus: a declaration focus answers about the declaration it names', () => {
  it('leads the analysis with what the capture measured of the declaration', () => {
    const { observed } = analysisOf(analyzeContext(declarationFocus([PERCH], ['performance'])));

    // Two runs; the nested one is counted as a run, but its time is inside its caller's.
    expect(observed[0]?.statement).toBe(
      'perch ran 2 times for 300.00 ms in total (25% of the 1.200 s recorded for the interaction).',
    );
    expect(citedIds(observed[0])).toEqual(['ev-perch-01', 'ev-perch-02']);
  });

  it('reads the runs from the span source symbol or from a qualified span name', () => {
    const renamed = (rename: (span: JsonObject) => JsonObject): readonly JsonObject[] =>
      SPANS.map((span) =>
        span.eventId === 'ev-perch-01' || span.eventId === 'ev-perch-02' ? rename(span) : span,
      );
    // The timing patch records the symbol it wrapped on the span's location,
    // whatever the span itself is called.
    const bySymbol = renamed((span) => ({ ...span, name: 'ledger step' }));
    // Without a recorded symbol, an owner-qualified span name still names it.
    const byName = renamed((span) => ({
      ...span,
      name: `HeronLedger.${PERCH}`,
      source: location(LEDGER_FILE, 12),
    }));

    for (const spans of [bySymbol, byName]) {
      const { observed } = analysisOf(analyzeContext(declarationFocus([PERCH]), spans));
      expect(String(observed[0]?.statement)).toMatch(/^perch ran 2 times for 300\.00 ms in total/u);
      expect(citedIds(observed[0])).toEqual(['ev-perch-01', 'ev-perch-02']);
    }
  });

  it('adds nothing about a declaration the capture never measured', () => {
    const unfocused = analysisOf(analyzeContext());
    const focused = analysisOf(analyzeContext(declarationFocus([ROOST])));

    expect(statements(focused.observed)).toEqual(statements(unfocused.observed));
  });

  it('never matches a run recorded in another file', () => {
    const elsewhere = {
      categoryHints: [],
      declarations: [{ file: 'src/services/egret-ledger.ts', symbol: PERCH, kind: 'symbol' }],
    };
    const { observed } = analysisOf(analyzeContext(elsewhere));

    expect(
      statements(observed).some((statement) => String(statement).startsWith('perch ran')),
    ).toBe(false);
  });

  it('orders a cause located in the focused declaration ahead of the category causes', () => {
    const { likelyCauses } = analysisOf(analyzeContext(declarationFocus([PERCH], ['performance'])));

    // The repeated statement is issued from inside the focused declaration.
    expect(String(likelyCauses[0]?.statement)).toMatch(/^A statement repeated/u);
    expect(String(likelyCauses[1]?.statement)).toMatch(/^One operation covers/u);
  });

  it('titles, headlines and composes the panel by the declaration', () => {
    const panel = panelOf(panelContext(declarationFocus([PERCH], ['performance'])));

    expect(panel.title).toBe('Latency — perch');
    expect(String(panel.summary).endsWith(' Focused on perch.')).toBe(true);
    // The span views lead: the declaration's runs are rows of the span list.
    expect(layoutTypes(panel).slice(0, 2)).toEqual(['waterfall', 'table']);
    // The kind-indifferent span ranking is narrowed to the work a declaration
    // is measured as, among the kinds the capture reports, longest first.
    expect(nodeOf(panel, 'table')).toMatchObject({
      source: 'spans',
      filter: { kinds: ['function', 'db.query'] },
      sort: 'duration_desc',
    });
    // The trace views show the interaction holding the declaration's slowest run.
    expect(nodeOf(panel, 'flame')).toMatchObject({ filter: { traceId: OTHER_TRACE_ID } });
    expect(nodeOf(panel, 'timeline')).toMatchObject({ filter: { traceId: OTHER_TRACE_ID } });
    // The source link opens where the run was recorded.
    expect(nodeOf(panel, 'sourceLink')).toMatchObject({
      location: { file: LEDGER_FILE, line: 12, symbol: PERCH },
    });
  });

  it('keeps the session category in the title when the focus names declarations only', () => {
    const panel = panelOf(panelContext(declarationFocus([PERCH])));

    expect(panel.title).toBe('Network requests — perch');
    // The measured declaration's span views join the session's own lens.
    expect(layoutTypes(panel)).toContain('requestTable');
    expect(nodeOf(panel, 'table')).toMatchObject({ sort: 'duration_desc' });
  });

  it('joins several declarations in the title and bounds the list', () => {
    const two = panelOf(panelContext(declarationFocus([PERCH, ROOST], ['performance'])));
    const four = panelOf(
      panelContext(declarationFocus([PERCH, ROOST, 'wade', 'preen'], ['performance'])),
    );

    expect(two.title).toBe('Latency — perch and roost');
    expect(four.title).toBe('Latency — perch, roost, wade and 1 more');
    expect(String(four.summary).endsWith(' Focused on perch, roost, wade and 1 more.')).toBe(true);
  });

  it('draws no trace filter and keeps the lens suggestion for an unmeasured declaration', () => {
    const unfocused = panelOf(panelContext(categoryFocus('performance')));
    const focused = panelOf(panelContext(declarationFocus([ROOST], ['performance'])));

    expect(focused.title).toBe('Latency — roost');
    expect(nodeOf(focused, 'flame')).not.toHaveProperty('filter');
    expect(nodeOf(focused, 'sourceLink')).toEqual(nodeOf(unfocused, 'sourceLink'));
  });
});

/* -------------------------------------------------------------------------------------------------
 * wording invariance
 * ---------------------------------------------------------------------------------------------- */

describe('followUpFocus: one structured focus, one answer, however it was worded', () => {
  const FOCI: readonly JsonObject[] = [
    categoryFocus('data'),
    declarationFocus([PERCH], ['performance']),
  ];

  it('answers both stages identically for two wordings of the same focus', () => {
    for (const focus of FOCI) {
      for (const [stage, context] of [
        ['analyze', analyzeContext(focus)],
        ['generate-panel', panelContext(focus)],
      ] as const) {
        const first = answeredJson(requestFor(stage, context, 'why does that query run twice'));
        const second = answeredJson(requestFor(stage, context, 'explain the repeated lookups'));
        expect(second).toBe(first);
      }
    }
  });

  it('reads the focus the same way in every spelling the context may carry it', () => {
    const canonicalPanel = JSON.stringify(
      buildPanelSpecInput(panelContext(declarationFocus([PERCH], ['performance']))),
    );
    const aliased = {
      categories: ['performance', 'performance', 'other'],
      symbols: [{ path: `./${LEDGER_FILE}`, name: PERCH, nodeKind: 'symbol' }],
    };
    const nested = {
      ...panelContext(),
      understanding: {
        category: 'network',
        signalsNeeded: ['fetch'],
        followUpFocus: declarationFocus([PERCH], ['performance']),
      },
    };

    expect(JSON.stringify(buildPanelSpecInput(panelContext(aliased)))).toBe(canonicalPanel);
    expect(JSON.stringify(buildPanelSpecInput(nested))).toBe(canonicalPanel);
  });

  it('bounds the declarations a focus names', () => {
    const many = Array.from({ length: 12 }, (_, index) => `wade${String(index)}`);
    const bounded = panelOf(panelContext(declarationFocus(many, ['performance'])));
    const eight = panelOf(panelContext(declarationFocus(many.slice(0, 8), ['performance'])));

    expect(bounded).toEqual(eight);
  });
});
