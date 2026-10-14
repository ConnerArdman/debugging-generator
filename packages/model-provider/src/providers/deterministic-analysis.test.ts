/**
 * The deterministic provider's analysis and source link over **service-shaped**
 * captures: the rows `apps/local-service/src/analysis/summarize.ts` hands the
 * analyze stage (`captureSummary.topSpans`, `captureSummary.queries[]` with
 * `occurrences[]` and `callers[]`, every citable row keyed by its own
 * `eventId`), and the panel context `apps/local-service/src/panels/generate.ts`
 * hands the panel stage (the stored analysis, and capture rows whose queries and
 * requests carry no location).
 *
 * `./deterministic.test.ts` pins the provider's general properties over
 * evidence-list fixtures; this file pins what a developer sees for the
 * questions the product demonstrates:
 *
 * - the repeated statement shape that cost the interaction the most time leads
 *   the facts and the causes, and a cheap one that merely ran as often never
 *   reads as a confident cause;
 * - the cause is located where its executions were issued;
 * - the interaction's own root span is never named as the operation that
 *   dominates it;
 * - equally strong causes are ordered by the time they account for;
 * - the timing panel's source link follows the first cause that cites timing
 *   evidence, and passes over a shared helper's line when it falls back;
 * - every answer is byte-identical across runs.
 *
 * Every fixture is built in code, invented and generic: no demo identifier, no
 * demo route path and no secret-shaped literal appears below. Only the
 * provider's public surface is driven.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DebuggenError, Result } from '@debuggen/shared';

import { CONFIDENCE_LEVELS } from '../deterministic/rules.js';
import type { ModelProvider } from '../provider.js';
import type { JsonObject, JsonValue, ModelRequest, PromptStage } from '../types.js';
import { createDeterministicProvider } from './deterministic.js';

/* -------------------------------------------------------------------------------------------------
 * harness
 * ---------------------------------------------------------------------------------------------- */

/** The unit under test; it holds no state between calls. */
const provider: ModelProvider = (() => {
  const created = createDeterministicProvider();
  if (!created.ok) {
    throw new Error(`the deterministic provider refused construction: ${created.error.code}`);
  }
  return created.value;
})();

/** Unwraps an `Ok`, reporting the failure's code otherwise. */
function okValue<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Narrows an unknown output tree to a plain object, failing the test otherwise. */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Narrows an unknown output member to an array, failing the test otherwise. */
function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** Narrows an unknown output member to a string, failing the test otherwise. */
function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`expected a string, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** One request for `stage` over `input`, with neutral prose the rules never read. */
function requestFor(stage: PromptStage, input: JsonObject): ModelRequest {
  return {
    prompt: `Answer the ${stage} stage in the requested shape.`,
    system: 'Answer only in the requested shape and cite evidence.',
    messages: [{ role: 'user', content: 'The developer asked about this interaction.' }],
    input,
    metadata: { stage, promptVersion: 'v001' },
  };
}

/* -------------------------------------------------------------------------------------------------
 * mirrors
 *
 * `@debuggen/panel-schema` and `@debuggen/protocol` are not dependencies of
 * this package, so the analyze stage's strict findings schema is mirrored here
 * with the refinements this file relies on: an `EventRef` is strict, its `kind`
 * is a member of the telemetry kind vocabulary (restated, as the rules restate
 * it), and its `label` is a bounded, non-blank caption.
 * ---------------------------------------------------------------------------------------------- */

/** `@debuggen/telemetry`'s `TELEMETRY_KINDS`, restated. */
const TELEMETRY_KIND_MIRROR = [
  'interaction',
  'render',
  'commit',
  'fetch',
  'xhr',
  'navigation',
  'perf.longtask',
  'perf.entry',
  'error',
  'state',
  'http.server',
  'route.handler',
  'function',
  'db.query',
  'http.client',
  'server.error',
  'log',
] as const;

/** `EventRef`: the id, and the optional coordinates and display sugar. */
const eventRefMirror = z.strictObject({
  eventId: z.string().min(1),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  kind: z.enum(TELEMETRY_KIND_MIRROR).optional(),
  label: z.string().min(1).max(200).regex(/\S/).optional(),
});

/** `SourceLocation`. */
const sourceLocationMirror = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  symbol: z.string().min(1).optional(),
  endLine: z.number().int().positive().optional(),
  resolvedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

/** `AnalysisFindings`, strict like protocol's `analysisFindingsSchema`. */
const findingsMirror = z.strictObject({
  observed: z.array(
    z.strictObject({
      statement: z.string().min(1).max(300),
      evidence: z.array(eventRefMirror).min(1),
    }),
  ),
  likelyCauses: z.array(
    z.strictObject({
      statement: z.string().min(1).max(300),
      evidence: z.array(eventRefMirror).min(1),
      confidence: z.enum(CONFIDENCE_LEVELS),
      suggestedLocation: sourceLocationMirror.optional(),
    }),
  ),
});

/** `PanelSpecInput`, with the one leaf this file reads. */
const panelMirror = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  layout: z.array(
    z.object({
      type: z.string().min(1),
      location: sourceLocationMirror.optional(),
    }),
  ),
});

/** The analysis the provider answers for `input`, validated against the strict mirror. */
async function analysisOf(input: JsonObject): Promise<z.infer<typeof findingsMirror>> {
  const attempt = okValue(
    await provider.generateStructured(findingsMirror, requestFor('analyze', input)),
  );
  if (attempt.value === undefined) {
    throw new Error('the provider answered without a value');
  }
  return attempt.value;
}

/** The panel the provider answers for `input`. */
async function panelOf(input: JsonObject): Promise<z.infer<typeof panelMirror>> {
  const attempt = okValue(
    await provider.generateStructured(panelMirror, requestFor('generate-panel', input)),
  );
  if (attempt.value === undefined) {
    throw new Error('the provider answered without a value');
  }
  return attempt.value;
}

/* -------------------------------------------------------------------------------------------------
 * service-shaped fixtures
 * ---------------------------------------------------------------------------------------------- */

const TRACE_ID = 'c0ffee00c0ffee00c0ffee00c0ffee00';

const ROUTE_FILE = 'src/routes/tally/handler.ts';
const STORE_FILE = 'src/services/tally-store.ts';
const HELPER_FILE = 'src/lib/request-helper.ts';
const BADGE_FILE = 'src/widgets/tally-badge.tsx';

/** A statement shape that ran often and cost almost nothing; it sorts first by text. */
const CHEAP_STATEMENT = 'INSERT INTO tally_log (bucket) VALUES ($1)';
/** A statement shape that ran as often and cost most of the interaction's database time. */
const COSTLY_STATEMENT = 'SELECT id FROM tally_rows WHERE bucket = $1';

/** Events of the fixture's root span and of its server span. */
const PRESS_EVENT = 'ev-press-01';
const ROUTE_EVENT = 'ev-route-01';

/** A source location as the service's resolvers report it. */
function location(file: string, line: number, resolvedBy = 'code-graph'): JsonObject {
  return { file, line, column: 3, resolvedBy, confidence: 0.8 };
}

/** The events of the `group`-th query shape's executions. */
function queryEvents(group: string, executions: number): readonly string[] {
  return Array.from(
    { length: executions },
    (_, ordinal) => `ev-${group}-${String(ordinal + 1).padStart(2, '0')}`,
  );
}

/** How one service-shaped query group may be built. */
interface QueryGroupOptions {
  readonly group: string;
  readonly statement: string;
  readonly executions: number;
  /** Summed duration; omitted leaves the group's time unknown. */
  readonly totalMs?: number;
  /** One location per execution; omitted leaves every execution unlocated. */
  readonly sources?: readonly (JsonObject | undefined)[];
  readonly callers?: readonly JsonObject[];
  /** The issuing function every execution names, as the service's occurrence rows do. */
  readonly callerName?: string;
}

/** One `captureSummary.queries[]` row, with its executions as `occurrences[]`. */
function queryGroup(options: QueryGroupOptions): JsonObject {
  const events = queryEvents(options.group, options.executions);
  const each = options.totalMs === undefined ? undefined : options.totalMs / options.executions;
  return {
    id: `qry:g:${options.group}`,
    statement: options.statement,
    executionCount: options.executions,
    ...(options.totalMs === undefined ? {} : { totalDurationMs: options.totalMs }),
    callers: [...(options.callers ?? [])],
    occurrences: events.map((eventId, ordinal) => {
      const source = options.sources?.[ordinal];
      return {
        eventId,
        spanId: `${String(ordinal + 1).padStart(2, '0')}aa00aa00aa00aa`,
        traceId: TRACE_ID,
        startTime: 1_000 + ordinal,
        ...(each === undefined ? {} : { durationMs: each }),
        ...(options.callerName === undefined ? {} : { callerName: options.callerName }),
        ...(source === undefined ? {} : { source }),
      };
    }),
  };
}

/** How the service-shaped analyze input may be varied. */
interface AnalyzeOptions {
  /** The interaction's total, reported as the `total_duration` metric. */
  readonly totalMs?: number;
  /**
   * The database tier's time, reported as the `database_duration` metric;
   * 560 ms by default, and `null` leaves the metric out of the capture.
   */
  readonly databaseMs?: number | null;
  /** The server span's duration. */
  readonly routeMs?: number;
  /** Replaces the query groups. */
  readonly queries?: readonly JsonObject[];
  /** Extra top-span rows. */
  readonly extraSpans?: readonly JsonObject[];
  /** Render statistics; none by default. */
  readonly renders?: readonly JsonObject[];
  /** Request groups; none by default. */
  readonly requests?: readonly JsonObject[];
}

/** One `captureSummary.topSpans[]` row. */
function topSpan(
  eventId: string,
  kind: string,
  tier: string,
  name: string,
  durationMs: number,
  source?: JsonObject,
): JsonObject {
  return {
    eventId,
    spanId: 'ab00ab00ab00ab00',
    traceId: TRACE_ID,
    kind,
    tier,
    name,
    startTime: 1_000,
    durationMs,
    status: 'ok',
    ...(source === undefined ? {} : { source }),
  };
}

/** The costly shape as a slow interaction's capture carries it: every execution at one call site. */
function costlyGroup(executions = 12, totalMs = 550): JsonObject {
  return queryGroup({
    group: 'costly',
    statement: COSTLY_STATEMENT,
    executions,
    totalMs,
    sources: Array.from({ length: executions }, () => location(STORE_FILE, 42)),
    callerName: 'loadTallyRows',
    callers: [
      {
        name: 'loadTallyRows',
        kind: 'function',
        executionCount: executions,
        totalDurationMs: totalMs,
        source: location(STORE_FILE, 30),
      },
    ],
  });
}

/**
 * The cheap shape: as many executions, 9 ms between them, no location; with
 * `timed` false it reports no time at all.
 */
function cheapGroup(timed = true): JsonObject {
  return queryGroup({
    group: 'cheap',
    statement: CHEAP_STATEMENT,
    executions: 12,
    ...(timed ? { totalMs: 9 } : {}),
  });
}

/**
 * The analyze stage's structured input for a slow interaction, as the service
 * builds it: `{ understanding, captureSummary, codeExcerpts }`.
 */
function analyzeInput(options: AnalyzeOptions = {}): JsonObject {
  const total = options.totalMs ?? 2_000;
  return {
    understanding: { category: 'slow-interaction', signalsNeeded: [], entities: [] },
    captureSummary: {
      captureId: 'cap_tally_capture01',
      metrics: [
        {
          id: 'total_duration',
          label: 'Total duration',
          unit: 'ms',
          available: true,
          value: total,
        },
        ...(options.databaseMs === null
          ? []
          : [
              {
                id: 'database_duration',
                label: 'Database',
                unit: 'ms',
                available: true,
                value: options.databaseMs ?? 560,
              },
            ]),
      ],
      traces: [],
      topSpans: [
        topSpan(PRESS_EVENT, 'interaction', 'browser', 'click submit', total),
        topSpan(
          ROUTE_EVENT,
          'http.server',
          'server',
          'POST /tally',
          options.routeMs ?? 1_300,
          location(ROUTE_FILE, 9, 'route-map'),
        ),
        ...(options.extraSpans ?? []),
      ],
      renders: [...(options.renders ?? [])],
      requests: [...(options.requests ?? [])],
      queries: [...(options.queries ?? [cheapGroup(), costlyGroup()])],
      stateTransitions: [],
      errors: [],
      factCandidates: [],
    },
    codeExcerpts: [],
  };
}

/** The ids a finding cites. */
function cited(finding: { readonly evidence: readonly { readonly eventId: string }[] }): string[] {
  return finding.evidence.map((reference) => reference.eventId);
}

/** The likely cause citing any of `events`, failing the test when there is none. */
function causeCiting(
  analysis: z.infer<typeof findingsMirror>,
  events: readonly string[],
): z.infer<typeof findingsMirror>['likelyCauses'][number] {
  const cause = analysis.likelyCauses.find((entry) =>
    cited(entry).some((eventId) => events.includes(eventId)),
  );
  if (cause === undefined) {
    throw new Error(`no likely cause cites ${events.join(', ')}`);
  }
  return cause;
}

/* -------------------------------------------------------------------------------------------------
 * repeated statement shapes
 * ---------------------------------------------------------------------------------------------- */

describe('the costliest repeated statement shape leads the analysis', () => {
  it('names the costlier shape as the cause, not a same-count cheaper one that sorts first', async () => {
    const analysis = await analysisOf(analyzeInput());

    const cause = causeCiting(analysis, [
      ...queryEvents('costly', 12),
      ...queryEvents('cheap', 12),
    ]);
    expect(cause.statement).toContain('tally_rows');
    expect(cause.statement).not.toContain('tally_log');
    expect(cited(cause).every((eventId) => eventId.startsWith('ev-costly-'))).toBe(true);
  });

  it('states the costlier shape before the cheaper one among the observed facts', async () => {
    const analysis = await analysisOf(analyzeInput());
    const statements = analysis.observed.map((fact) => fact.statement);

    const costly = statements.findIndex((statement) => statement.includes('tally_rows'));
    const cheap = statements.findIndex((statement) => statement.includes('tally_log'));
    expect(costly).toBeGreaterThanOrEqual(0);
    expect(cheap === -1 || costly < cheap).toBe(true);
  });

  it('keeps the costlier shape in the capped facts when cheaper shapes ran more often', async () => {
    const groups = [
      cheapGroup(),
      queryGroup({
        group: 'filler-a',
        statement: 'SELECT 1 FROM tally_a',
        executions: 30,
        totalMs: 4,
      }),
      queryGroup({
        group: 'filler-b',
        statement: 'SELECT 1 FROM tally_b',
        executions: 20,
        totalMs: 3,
      }),
      costlyGroup(),
    ];
    const analysis = await analysisOf(analyzeInput({ queries: groups }));

    expect(analysis.observed.some((fact) => fact.statement.includes('tally_rows'))).toBe(true);
  });
});

describe('the repeated-statement cause is located where its executions were issued', () => {
  it('suggests the call site every execution shares', async () => {
    const cause = causeCiting(await analysisOf(analyzeInput()), queryEvents('costly', 12));

    expect(cause.suggestedLocation?.file).toBe(STORE_FILE);
    expect(cause.suggestedLocation?.line).toBe(42);
    expect(cause.statement).toContain(`${STORE_FILE}:42`);
  });

  it("falls back to the costliest caller's location when the executions disagree", async () => {
    const disagreeing = queryGroup({
      group: 'costly',
      statement: COSTLY_STATEMENT,
      executions: 4,
      totalMs: 550,
      sources: [location(STORE_FILE, 42), location(STORE_FILE, 60), undefined, undefined],
      callers: [
        {
          name: 'aCheapCaller',
          executionCount: 3,
          totalDurationMs: 50,
          source: location(HELPER_FILE, 5),
        },
        {
          name: 'theCostlyCaller',
          executionCount: 1,
          totalDurationMs: 500,
          source: location(STORE_FILE, 30),
        },
      ],
    });
    const analysis = await analysisOf(analyzeInput({ queries: [disagreeing] }));
    const cause = causeCiting(analysis, queryEvents('costly', 4));

    expect(cause.suggestedLocation?.file).toBe(STORE_FILE);
    expect(cause.suggestedLocation?.line).toBe(30);
    expect(cause.statement).toContain(`${STORE_FILE}:30`);
    expect(cause.statement).not.toContain('theCostlyCaller');
  });
});

describe('an immaterial repeated shape is never a confident cause', () => {
  it('caps a shape costing a negligible share of the interaction at low', async () => {
    const analysis = await analysisOf(analyzeInput({ queries: [cheapGroup()] }));
    const cause = causeCiting(analysis, queryEvents('cheap', 12));

    expect(cause.confidence).toBe('low');
  });

  it('keeps the count-based confidence when the shape reports no time', async () => {
    const analysis = await analysisOf(analyzeInput({ queries: [cheapGroup(false)] }));
    const cause = causeCiting(analysis, queryEvents('cheap', 12));

    expect(cause.confidence).toBe('high');
  });

  it('keeps a material shape confident', async () => {
    const cause = causeCiting(await analysisOf(analyzeInput()), queryEvents('costly', 12));

    expect(cause.confidence).toBe('high');
  });

  it("weighs a shape against the database tier's time, which an idle capture window cannot dilute", async () => {
    // 550 ms is under a tenth of a 20 s capture but almost all of its 560 ms of
    // database time: the costly shape stays confident and leads the causes.
    const analysis = await analysisOf(
      analyzeInput({ totalMs: 20_000, queries: [cheapGroup(), costlyGroup()] }),
    );
    const cause = causeCiting(analysis, queryEvents('costly', 12));

    expect(cause.confidence).toBe('high');
    expect(analysis.likelyCauses[0]).toEqual(cause);
  });

  it("falls back to the interaction's total when the capture states no database time", async () => {
    const material = causeCiting(
      await analysisOf(analyzeInput({ databaseMs: null })),
      queryEvents('costly', 12),
    );
    const diluted = causeCiting(
      await analysisOf(analyzeInput({ databaseMs: null, totalMs: 20_000 })),
      queryEvents('costly', 12),
    );

    expect(material.confidence).toBe('high');
    expect(diluted.confidence).toBe('low');
  });
});

/* -------------------------------------------------------------------------------------------------
 * the envelope
 * ---------------------------------------------------------------------------------------------- */

describe('the interaction envelope is never the operation that dominates it', () => {
  it('names the longest operation inside the interaction, not its root span', async () => {
    const analysis = await analysisOf(analyzeInput({ routeMs: 1_700 }));

    for (const finding of [...analysis.observed, ...analysis.likelyCauses]) {
      expect(finding.statement).not.toContain('click submit');
    }
    const dominant = causeCiting(analysis, [ROUTE_EVENT]);
    expect(dominant.statement).toContain('POST /tally');
    expect(dominant.suggestedLocation?.file).toBe(ROUTE_FILE);
    expect(cited(dominant)).not.toContain(PRESS_EVENT);
  });

  it('excludes a navigation and any span as long as the total, whatever its kind', async () => {
    const analysis = await analysisOf(
      analyzeInput({
        routeMs: 400,
        extraSpans: [
          topSpan('ev-nav-01', 'navigation', 'browser', 'page navigation entry', 1_900),
          topSpan('ev-whole-01', 'function', 'server', 'whole interval wrapper', 2_000),
        ],
      }),
    );

    const citedEvents = [...analysis.observed, ...analysis.likelyCauses].flatMap(cited);
    for (const envelope of [PRESS_EVENT, 'ev-nav-01', 'ev-whole-01']) {
      expect(
        analysis.likelyCauses.some((cause) => cited(cause).includes(envelope)),
        `${envelope} is named as a cause`,
      ).toBe(false);
    }
    expect(citedEvents).toContain(ROUTE_EVENT);
  });
});

describe('equally strong causes are ordered by the time they account for', () => {
  it('puts the operation covering 1800 ms before a shape covering 550 ms of equal strength', async () => {
    // A 0.9 share of the total and five executions are both four steps of strength.
    const analysis = await analysisOf(
      analyzeInput({ routeMs: 1_800, queries: [costlyGroup(5, 550)] }),
    );

    const order = analysis.likelyCauses.map((cause) =>
      cited(cause).includes(ROUTE_EVENT) ? 'route' : 'query',
    );
    expect(order).toEqual(['route', 'query']);
    expect(analysis.likelyCauses[0]?.confidence).toBe(analysis.likelyCauses[1]?.confidence);
  });
});

/* -------------------------------------------------------------------------------------------------
 * evidence chips and operation names
 * ---------------------------------------------------------------------------------------------- */

/** Every reference an analysis cites, facts first. */
function allReferences(
  analysis: z.infer<typeof findingsMirror>,
): readonly z.infer<typeof eventRefMirror>[] {
  return [...analysis.observed, ...analysis.likelyCauses].flatMap((finding) => finding.evidence);
}

/** The reference citing `eventId`, failing the test when none does. */
function referenceTo(
  analysis: z.infer<typeof findingsMirror>,
  eventId: string,
): z.infer<typeof eventRefMirror> {
  const reference = allReferences(analysis).find((entry) => entry.eventId === eventId);
  if (reference === undefined) {
    throw new Error(`nothing cites ${eventId}`);
  }
  return reference;
}

/** Render statistics as the service carries them, with each render as an occurrence. */
function badgeRenders(): JsonObject {
  return {
    component: 'TallyBadge',
    renderCount: 3,
    unchangedRenderCount: 3,
    unknownTriggerCount: 0,
    totalDurationMs: 6,
    triggers: { props: 0, state: 0, context: 0, unchanged: 3, unknown: 0 },
    occurrences: ['ev-badge-01', 'ev-badge-02', 'ev-badge-03'].map((eventId, ordinal) => ({
      eventId,
      spanId: `${String(ordinal + 1).padStart(2, '0')}bb00bb00bb00bb`,
      traceId: TRACE_ID,
      startTime: 1_100 + ordinal,
      durationMs: 2,
      trigger: 'unchanged',
      changedPropNames: [],
    })),
  };
}

describe('a reference to an event the capture describes carries a kind and a caption', () => {
  it('labels a slowest-operation reference with its name, kind and duration', async () => {
    const reference = referenceTo(await analysisOf(analyzeInput()), ROUTE_EVENT);

    expect(Object.keys(reference)).toEqual(['eventId', 'kind', 'label']);
    expect(reference.kind).toBe('http.server');
    expect(reference.label).toBe('POST /tally (1.300 s)');
  });

  it("labels each execution of a query group by its statement's keyword, not its enclosing span", async () => {
    // The occurrences name `loadTallyRows` as their caller span; the caption says
    // which statement shape the execution belongs to instead.
    const cause = causeCiting(await analysisOf(analyzeInput()), queryEvents('costly', 12));

    expect(cause.evidence.length).toBeGreaterThan(0);
    for (const reference of cause.evidence) {
      expect(reference.kind).toBe('db.query');
      expect(reference.label).toBe('SELECT query (45.83 ms)');
    }
  });

  it("names each group's executions by that group's own statement", async () => {
    const analysis = await analysisOf(analyzeInput({ queries: [cheapGroup(), costlyGroup()] }));
    const costly = causeCiting(analysis, queryEvents('costly', 12));

    expect(
      costly.evidence.every((reference) => reference.label?.startsWith('SELECT ') === true),
    ).toBe(true);
    const fact = analysis.observed.find((entry) =>
      cited(entry).some((eventId) => queryEvents('cheap', 12).includes(eventId)),
    );
    expect(fact).toBeDefined();
    for (const reference of fact?.evidence ?? []) {
      expect(reference).toEqual({
        eventId: reference.eventId,
        kind: 'db.query',
        label: 'INSERT query (750 µs)',
      });
    }
  });

  it('falls back to the fixed noun for an execution whose statement has no keyword', async () => {
    const unworded = queryGroup({
      group: 'cheap',
      statement: '',
      executions: 12,
      totalMs: 9,
    });
    const analysis = await analysisOf(analyzeInput({ queries: [unworded] }));
    const cause = causeCiting(analysis, queryEvents('cheap', 12));

    for (const reference of cause.evidence) {
      expect(reference).toEqual({
        eventId: reference.eventId,
        kind: 'db.query',
        label: 'query (750 µs)',
      });
    }
  });

  it("labels each render of a component's statistics with the component", async () => {
    const analysis = await analysisOf(analyzeInput({ renders: [badgeRenders()] }));
    const reference = referenceTo(analysis, 'ev-badge-01');

    expect(reference.kind).toBe('render');
    expect(reference.label).toBe('TallyBadge render (2.00 ms)');
  });

  it('emits a kind only when it is a telemetry kind, and bounds a long caption', async () => {
    const longName = `tally ${'segment/'.repeat(30)}`;
    const analysis = await analysisOf(
      analyzeInput({
        routeMs: 400,
        extraSpans: [topSpan('ev-odd-01', 'custom.kind', 'server', longName, 1_500)],
      }),
    );
    const reference = referenceTo(analysis, 'ev-odd-01');

    expect(reference.kind).toBeUndefined();
    expect(reference.label?.length).toBeLessThanOrEqual(120);
    expect(reference.label?.endsWith(' (1.500 s)')).toBe(true);
  });

  it('keeps a reference known only from a bare evidence list to its id', async () => {
    const analysis = await analysisOf({
      captureSummary: {
        metrics: [{ id: 'total_duration', value: 2_000 }],
        spans: [
          {
            name: 'tally request handler',
            duration: 1_600,
            tier: 'server',
            evidence: ['ev-bare-01'],
          },
        ],
        queries: [
          { statement: COSTLY_STATEMENT, count: 6, totalDurationMs: 500, eventIds: ['ev-bare-02'] },
        ],
      },
    });

    const references = allReferences(analysis);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(Object.keys(reference)).toEqual(['eventId']);
    }
  });
});

/**
 * A duplicated request group: a seven-request window whose aggregate lists only
 * three occurrences (its occurrence list was capped), so four of the window's
 * events are known by id alone — citable, through the group's bare evidence
 * list, but not described.
 */
function truncatedDuplicateGroup(): JsonObject {
  const bare = ['ev-dup-a1', 'ev-dup-a2', 'ev-dup-a3', 'ev-dup-a4'];
  const described = ['ev-dup-b1', 'ev-dup-b2', 'ev-dup-b3'];
  return {
    id: 'req:g:0',
    groupedBy: 'request-key',
    method: 'GET',
    url: '/tally/rows',
    path: '/tally/rows',
    count: 7,
    duplicateCount: 6,
    hasDuplicates: true,
    duplicateWindows: [
      { startTime: 1_000, endTime: 1_030, count: 7, eventIds: [...bare, ...described] },
    ],
    totalDurationMs: 70,
    evidence: [...bare, ...described],
    occurrences: described.map((eventId, ordinal) => ({
      eventId,
      spanId: `${String(ordinal + 1).padStart(2, '0')}cc00cc00cc00cc`,
      traceId: TRACE_ID,
      startTime: 1_000 + ordinal,
      durationMs: 10,
      status: 'ok',
    })),
    occurrencesTruncated: true,
  };
}

describe('a finding with more references than it may cite prefers the ones it can caption', () => {
  it("cites a capped window's described occurrences before the ones known only by id", async () => {
    const analysis = await analysisOf(
      analyzeInput({ queries: [], requests: [truncatedDuplicateGroup()] }),
    );
    const fact = analysis.observed.find((entry) => cited(entry).includes('ev-dup-b1'));

    expect(fact).toBeDefined();
    expect(fact?.evidence.map((reference) => reference.eventId)).toEqual([
      'ev-dup-b1',
      'ev-dup-b2',
      'ev-dup-b3',
      'ev-dup-a1',
      'ev-dup-a2',
    ]);
    expect(fact?.evidence.slice(0, 3).map((reference) => reference.label)).toEqual([
      'GET /tally/rows request (10.00 ms)',
      'GET /tally/rows request (10.00 ms)',
      'GET /tally/rows request (10.00 ms)',
    ]);
  });
});

describe('an operation of a generically named kind is stated with its kind', () => {
  it('qualifies a performance entry in the slowest-operation fact and the dominant cause', async () => {
    const analysis = await analysisOf(
      analyzeInput({
        routeMs: 300,
        queries: [],
        extraSpans: [topSpan('ev-resource-01', 'perf.entry', 'browser', 'resource', 1_564.9)],
      }),
    );

    const fact = analysis.observed.find((entry) => cited(entry).includes('ev-resource-01'));
    expect(fact?.statement).toContain('resource (browser performance entry) took 1.565 s');
    const cause = causeCiting(analysis, ['ev-resource-01']);
    expect(cause.statement).toContain('resource (browser performance entry)');
    // The chip keeps the operation's own name.
    expect(referenceTo(analysis, 'ev-resource-01').label).toBe('resource (1.565 s)');
  });

  it('leaves an operation of any other kind named as captured', async () => {
    const analysis = await analysisOf(analyzeInput({ routeMs: 1_700, queries: [] }));
    const fact = analysis.observed.find((entry) => cited(entry).includes(ROUTE_EVENT));

    expect(fact?.statement.startsWith('POST /tally took 1.700 s')).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * the timing panel's source link
 * ---------------------------------------------------------------------------------------------- */

/** The node catalog entries a timing panel with a source link needs. */
const PANEL_CATALOG: readonly JsonObject[] = [
  { type: 'timeline', sources: ['trace', 'spans'], filters: ['traceId'], reads: ['startTime'] },
  { type: 'queryTable', sources: ['queries'], defaultSort: 'duration_desc', reads: ['statement'] },
  { type: 'renderTable', sources: ['renders'], defaultSort: 'count_desc', reads: ['component'] },
  { type: 'metricCards', sources: ['metrics'], reads: ['metrics'] },
  { type: 'sourceLink', sources: [], reads: ['source'] },
];

/** One panel-context span row: located, named, no event id (the panel context carries none). */
function panelSpan(kind: string, name: string, durationMs: number, source: JsonObject): JsonObject {
  return { traceId: TRACE_ID, kind, tier: 'browser', name, durationMs, status: 'ok', source };
}

/** Two differently-named browser requests issued through one helper line, and a located route. */
const HELPER_SPANS: readonly JsonObject[] = [
  panelSpan('fetch', 'POST /tally', 1_350, location(HELPER_FILE, 12, 'source-map')),
  panelSpan('fetch', 'GET /tally/rows', 90, location(HELPER_FILE, 12, 'source-map')),
  {
    ...panelSpan('http.server', 'POST /tally', 1_300, location(ROUTE_FILE, 9, 'route-map')),
    tier: 'server',
  },
];

/** The panel stage's structured input, shaped as `panels/generate.ts` builds it. */
function panelInput(likelyCauses: readonly JsonValue[], spans: readonly JsonObject[]): JsonObject {
  return {
    analysis: {
      observed: [{ statement: 'The route took 1300 ms.', evidence: [{ eventId: ROUTE_EVENT }] }],
      likelyCauses: [...likelyCauses],
      metrics: [],
    },
    nodeCatalog: [...PANEL_CATALOG],
    populatedSources: {
      trace: 2,
      spans: 40,
      events: 40,
      renders: 3,
      componentTree: 3,
      requests: 2,
      queries: 24,
      stateTransitions: 0,
      graph: 10,
      metrics: 4,
    },
    capture: {
      primaryTraceId: TRACE_ID,
      traceCount: 1,
      eventCount: 40,
      kindCounts: { interaction: 1, fetch: 2, 'http.server': 1, 'db.query': 24, render: 3 },
      metrics: [
        { id: 'total_duration', value: 2_000 },
        { id: 'database_duration', value: 560 },
        { id: 'query_count', value: 24 },
      ],
      spans: [...spans],
      renders: [{ component: 'TallyBadge', renderCount: 3, unchangedRenderCount: 0 }],
      requests: [{ method: 'POST', url: '/tally', count: 1, duplicateCount: 0 }],
      queries: [{ statement: COSTLY_STATEMENT, executionCount: 12, totalDurationMs: 550 }],
      errors: [],
    },
  };
}

/** A stored likely cause citing `evidence`, located at `file:line`. */
function storedCause(
  statement: string,
  evidence: readonly JsonObject[],
  file: string,
  line: number,
): JsonObject {
  return {
    statement,
    evidence: [...evidence],
    confidence: 'high',
    suggestedLocation: location(file, line),
  };
}

/** The file and line of a panel's source-link leaf. */
function sourceLinkOf(panel: z.infer<typeof panelMirror>): string {
  const link = panel.layout.find((node) => node.type === 'sourceLink');
  if (link?.location === undefined) {
    throw new Error('the panel carries no source link');
  }
  return `${link.location.file}:${String(link.location.line)}`;
}

describe("the timing panel's source link follows the analysis's timing evidence", () => {
  it('follows the first cause citing a database query, past a component cause before it', async () => {
    const panel = await panelOf(
      panelInput(
        [
          storedCause(
            'Renders with unchanged inputs follow a changing value.',
            [{ eventId: 'ev-badge-01', kind: 'render', label: 'TallyBadge render (2.00 ms)' }],
            BADGE_FILE,
            30,
          ),
          storedCause(
            'A statement repeated inside one interaction.',
            [{ eventId: 'ev-costly-01', kind: 'db.query', label: 'query (45.83 ms)' }],
            STORE_FILE,
            42,
          ),
        ],
        HELPER_SPANS,
      ),
    );

    expect(sourceLinkOf(panel)).toBe(`${STORE_FILE}:42`);
  });

  it('still classifies a cause citing no kind by line corroboration', async () => {
    const panel = await panelOf(
      panelInput(
        [
          storedCause(
            'One operation covers most of it.',
            [{ eventId: ROUTE_EVENT }],
            ROUTE_FILE,
            9,
          ),
        ],
        HELPER_SPANS,
      ),
    );

    expect(sourceLinkOf(panel)).toBe(`${ROUTE_FILE}:9`);
  });

  it("falls back past a helper line shared by differently-named operations to an operation's own", async () => {
    const panel = await panelOf(panelInput([], HELPER_SPANS));

    expect(sourceLinkOf(panel)).toBe(`${ROUTE_FILE}:9`);
  });

  it('keeps the first located operation when every located line is shared', async () => {
    const panel = await panelOf(panelInput([], HELPER_SPANS.slice(0, 2)));

    expect(sourceLinkOf(panel)).toBe(`${HELPER_FILE}:12`);
  });

  it('follows the leading cause of a capture that repeats identical requests to its initiating code', async () => {
    // Repeated identical requests admit the component work that initiates them,
    // so the leading duplicate-request cause — citing request events by id only
    // and located where nothing in the context corroborates — supplies the link
    // rather than the query cause behind it.
    const input = panelInput(
      [
        storedCause(
          'Repeated identical requests from a single call site.',
          [{ eventId: 'ev-dup-b1' }, { eventId: 'ev-dup-b2' }],
          BADGE_FILE,
          30,
        ),
        storedCause(
          'A statement repeated inside one interaction.',
          [{ eventId: 'ev-costly-01', kind: 'db.query', label: 'query (45.83 ms)' }],
          STORE_FILE,
          42,
        ),
      ],
      HELPER_SPANS,
    );
    const capture = asObject(input.capture);
    const duplicated: JsonObject = {
      ...input,
      capture: {
        ...capture,
        requests: [
          { method: 'GET', url: '/tally/rows', count: 7, duplicateCount: 6, hasDuplicates: true },
        ],
      },
    };

    expect(sourceLinkOf(await panelOf(duplicated))).toBe(`${BADGE_FILE}:30`);
    // Without the pattern, the same leading cause is not the timing panel's.
    expect(sourceLinkOf(await panelOf(input))).toBe(`${STORE_FILE}:42`);
  });
});

/* -------------------------------------------------------------------------------------------------
 * determinism
 * ---------------------------------------------------------------------------------------------- */

describe('service-shaped answers are byte-identical across runs', () => {
  it('answers the same analysis and the same panel twice', async () => {
    const input = analyzeInput();
    const first = JSON.stringify(await analysisOf(input));
    const second = JSON.stringify(await analysisOf(input));
    expect(second).toBe(first);

    const panel = panelInput([], HELPER_SPANS);
    expect(JSON.stringify(await panelOf(panel))).toBe(JSON.stringify(await panelOf(panel)));
  });

  it('does not depend on the order the query groups arrive in', async () => {
    const forward = await analysisOf(analyzeInput({ queries: [cheapGroup(), costlyGroup()] }));
    const reversed = await analysisOf(analyzeInput({ queries: [costlyGroup(), cheapGroup()] }));

    expect(
      asArray(reversed.likelyCauses).map((cause) => asString(asObject(cause).statement)),
    ).toEqual(asArray(forward.likelyCauses).map((cause) => asString(asObject(cause).statement)));
  });
});
