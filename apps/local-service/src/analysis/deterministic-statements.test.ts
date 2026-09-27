/**
 * The deterministic provider's analysis validates against the real analyze
 * schema even when every captured label is long.
 *
 * `@debuggen/model-provider` may not import `@debuggen/panel-schema`, so its
 * likely-cause frames restate the 300-character statement
 * bound as `STATEMENT_MAX_LENGTH`. This service depends on both, which makes it
 * the one place the two can be held together: the real provider answers an
 * analyze request whose call sites, span names, SQL statements and component
 * names are all long, and the answer is parsed with protocol's
 * `analysisFindingsSchema` — the schema the analyze stage enforces — with no
 * repair allowed. Before the frames were fitted to the bound, a long call site
 * alone made the provider fail that schema and the whole analyze stage fail.
 * Fixtures use invented, generic vocabulary only.
 */
import { describe, expect, it } from 'vitest';

import {
  createDeterministicProvider,
  generateStructuredWithRepair,
  type JsonObject,
  type ModelRequest,
} from '@debuggen/model-provider';
import { MAX_STATEMENT_LENGTH } from '@debuggen/panel-schema';
import { analysisFindingsSchema } from '@debuggen/protocol';

/** A well-formed 32-hex trace identifier. */
const TRACE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** A project-relative path as deep as real feature folders get. */
const DEEP_FILE =
  'src/features/kestrel-workspace/panels/tally-overview/sections/summary-strip/widgets/kestrel-tally-refresh-control.tsx';

/** A span name as long as the label cap, as framework spans with a route in them can be. */
const LONG_SPAN_NAME = `executing tally route handler ${'segment/'.repeat(12)}`.slice(0, 120);

/** A parameterised statement longer than the label cap. */
const LONG_STATEMENT = `SELECT ${Array.from({ length: 20 }, (_, index) => `column_${String(index)}`).join(', ')} FROM tally_rows WHERE bucket = $1`;

/** A component display name at the label cap, as a generated wrapper name can be. */
const LONG_COMPONENT = `KestrelTallyRefreshControl${'Wrapped'.repeat(20)}`.slice(0, 120);

function sourceLocation(line: number, column: number, resolvedBy: string): JsonObject {
  return { file: DEEP_FILE, line, column, resolvedBy, confidence: 0.8 };
}

/** Capture aggregates shaped the way the deterministic rules read an analyze request. */
function longLabelAnalyzeInput(): JsonObject {
  const total = 1175;
  return {
    aggregates: {
      traceId: TRACE_ID,
      totalDurationMs: total,
      spans: [
        {
          name: LONG_SPAN_NAME,
          duration: 900,
          tier: 'server',
          evidence: ['ev-span-01'],
          source: sourceLocation(42, 7, 'code-graph'),
        },
        { name: 'tally row scan', duration: 120, tier: 'db', evidence: ['ev-span-02'] },
      ],
      requests: [
        {
          endpoint: `/tally/${'rows/'.repeat(30)}`,
          count: 4,
          windowMs: 22,
          evidence: ['ev-request-01', 'ev-request-02'],
          source: sourceLocation(84, 5, 'source-map'),
        },
      ],
      queries: [
        {
          statement: LONG_STATEMENT,
          count: 3,
          evidence: ['ev-query-01'],
          source: sourceLocation(51, 11, 'code-graph'),
        },
      ],
      renders: [
        {
          component: LONG_COMPONENT,
          renderCount: 60,
          unchangedRenderCount: 48,
          renderTriggerUnknownCount: 2,
          evidence: ['ev-render-01'],
        },
      ],
      metrics: {
        total_duration: total,
        frontend_duration: 120,
        backend_duration: 900,
        database_duration: 120,
        render_count: 60,
        unchanged_render_count: 48,
        request_count: 4,
        duplicate_request_count: 3,
        query_count: 3,
      },
    },
  };
}

function analyzeRequest(input: JsonObject): ModelRequest {
  return {
    prompt: 'Answer with the structured reply the schema describes.',
    input,
    metadata: { stage: 'analyze', promptVersion: 'v001' },
  };
}

describe('deterministic analysis statements against the analyze schema', () => {
  it('validates first time, every statement within the schema bound, when every label is long', async () => {
    const created = createDeterministicProvider();
    if (!created.ok) {
      throw new Error(`The deterministic provider refused construction: ${created.error.code}`);
    }

    const answered = await generateStructuredWithRepair(
      created.value,
      analysisFindingsSchema,
      analyzeRequest(longLabelAnalyzeInput()),
      { maxRepairs: 0 },
    );
    if (!answered.ok) {
      throw new Error(`Expected a validated analysis: ${answered.error.message}`);
    }

    const { observed, likelyCauses } = answered.value.value;
    expect(answered.value.repairs).toBe(0);
    expect(observed.length).toBeGreaterThan(0);
    expect(likelyCauses.length).toBeGreaterThan(0);
    for (const finding of [...observed, ...likelyCauses]) {
      expect(finding.statement.length).toBeLessThanOrEqual(MAX_STATEMENT_LENGTH);
    }
    // At least one cause needed a label shortened to fit, so the bound was exercised.
    expect(likelyCauses.some((cause) => cause.statement.includes('…'))).toBe(true);
  });
});
