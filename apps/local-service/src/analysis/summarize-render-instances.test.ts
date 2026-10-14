/**
 * A coalesced render reaches the analysis input as the group it is.
 *
 * The browser agent coalesces the fibers of a component that rendered alike in
 * one commit into one render event; the `renders` aggregate carries the
 * group's size (`instanceCount`) and its slowest instance
 * (`maxInstanceDurationMs`) on the occurrence, with `durationMs` the group's
 * summed time. {@link toRenderRow} is what the analyze prompt and the
 * deterministic fact candidates read, so it must carry both fields — otherwise
 * a summed time is presented as the cost of one render. Fixtures use invented,
 * generic vocabulary only.
 */
import { describe, expect, it } from 'vitest';

import { computeCaptureSummary } from '@debuggen/telemetry';
import type { RenderOccurrence, RenderStat } from '@debuggen/telemetry';

import { buildFactCandidates } from './facts.js';
import { toRenderRow } from './summarize.js';
import type { AnalysisRenderRow, AnalysisStageInput } from './summarize.js';

/** A well-formed 32-hex trace identifier. */
const TRACE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** First render start, in epoch milliseconds. */
const START_MS = 1_790_000_000_000;

/**
 * One occurrence with the given instance fields.
 *
 * @param index Distinguishes ids and start times.
 * @param extra The instance fields, or none for a single render.
 * @returns A fresh occurrence.
 */
function occurrence(
  index: number,
  extra: Pick<RenderOccurrence, 'instanceCount' | 'maxInstanceDurationMs'> = {},
): RenderOccurrence {
  const id = `event-tile-${String(index).padStart(4, '0')}`;
  return {
    id,
    eventId: id,
    spanId: index.toString(16).padStart(16, '0'),
    traceId: TRACE_ID,
    startTime: START_MS + index * 250,
    durationMs: 12.5,
    trigger: 'context',
    phase: 'update',
    changedPropKeys: [],
    changedContexts: [],
    ...extra,
  };
}

/**
 * A render row holding the given occurrences.
 *
 * @param occurrences The listed renders.
 * @param renderCount The weighted render count.
 * @returns A fresh row.
 */
function stat(occurrences: readonly RenderOccurrence[], renderCount: number): RenderStat {
  return {
    id: 'TallyTile',
    component: 'TallyTile',
    renderCount,
    totalDurationMs: 25,
    averageDurationMs: 25 / renderCount,
    maxDurationMs: 4.25,
    firstStartTime: START_MS,
    lastStartTime: START_MS + 250,
    triggers: { props: 0, state: 0, context: renderCount, unchanged: 0, unknown: 0 },
    unchangedRenderCount: 0,
    unknownTriggerCount: 0,
    phaseCounts: { mount: 0, update: renderCount },
    changedPropKeys: [],
    changedPropCounts: {},
    changedContexts: [],
    changedContextCounts: {},
    declaredInProject: true,
    occurrences,
    occurrencesTruncated: false,
  };
}

describe('toRenderRow — coalesced render occurrences', () => {
  it('carries the group size and slowest instance of a coalesced render', () => {
    const row = toRenderRow(
      stat([occurrence(1, { instanceCount: 9, maxInstanceDurationMs: 4.25 }), occurrence(2)], 10),
    );

    expect(row.renderCount).toBe(10);
    expect(row.occurrences).toHaveLength(2);
    expect(row.occurrences[0]).toMatchObject({
      eventId: 'event-tile-0001',
      durationMs: 12.5,
      instanceCount: 9,
      maxInstanceDurationMs: 4.25,
    });
  });

  it('leaves a single render without instance fields', () => {
    const row = toRenderRow(stat([occurrence(1)], 1));

    expect(row.occurrences[0]).not.toHaveProperty('instanceCount');
    expect(row.occurrences[0]).not.toHaveProperty('maxInstanceDurationMs');
  });

  it('treats a malformed group size as one render', () => {
    const row = toRenderRow(
      stat(
        [
          occurrence(1, { instanceCount: 1, maxInstanceDurationMs: 3 }),
          occurrence(2, { instanceCount: 2.5, maxInstanceDurationMs: 3 }),
          occurrence(3, { instanceCount: Number.NaN }),
        ],
        3,
      ),
    );

    for (const listed of row.occurrences) {
      expect(listed).not.toHaveProperty('instanceCount');
      expect(listed).not.toHaveProperty('maxInstanceDurationMs');
    }
  });

  it('keeps the group size when the slowest instance is not a finite duration', () => {
    const row = toRenderRow(
      stat(
        [occurrence(1, { instanceCount: 4, maxInstanceDurationMs: Number.POSITIVE_INFINITY })],
        4,
      ),
    );

    expect(row.occurrences[0]).toMatchObject({ instanceCount: 4 });
    expect(row.occurrences[0]).not.toHaveProperty('maxInstanceDurationMs');
  });
});

/** The capture the fact-candidate cases describe. */
const CAPTURE_ID = 'cap_tallyinstances01';

/**
 * A minimal analysis input holding one render row and nothing else.
 *
 * @param renders The render rows.
 * @returns The input.
 */
function inputWith(renders: readonly AnalysisRenderRow[]): AnalysisStageInput {
  return {
    sessionId: 'ses_tallyinstances01',
    captureId: CAPTURE_ID,
    question: 'Why does this tile keep rendering?',
    capture: {
      captureId: CAPTURE_ID,
      planVersion: 1,
      startedAt: START_MS,
      stoppedAt: START_MS + 5_000,
      startTime: START_MS,
      endTime: START_MS + 1_000,
      durationMs: 1_000,
      eventCount: 2,
      eventsConsidered: 2,
      eventsExcluded: 0,
      eventsTruncated: false,
      traceCount: 1,
      primaryTraceId: TRACE_ID,
      producerCount: 1,
      tierCounts: { browser: 2, server: 0, db: 0 },
      kindCounts: {
        interaction: 0,
        render: 2,
        commit: 0,
        fetch: 0,
        xhr: 0,
        navigation: 0,
        'perf.longtask': 0,
        'perf.entry': 0,
        error: 0,
        state: 0,
        'http.server': 0,
        'route.handler': 0,
        function: 0,
        'db.query': 0,
        'http.client': 0,
        'server.error': 0,
        log: 0,
      },
      unavailableMetrics: [],
    },
    metrics: [],
    traces: [],
    topSpans: [],
    renders,
    requests: [],
    queries: [],
    stateTransitions: [],
    errors: [],
    relevantFiles: [],
    excerpts: [],
    factCandidates: [],
    truncated: { sections: [] },
  };
}

describe('render fact candidates — coalesced render evidence', () => {
  it('labels a coalesced render as the renders it stands for, and a single one as one', () => {
    const row = toRenderRow(
      stat([occurrence(1, { instanceCount: 9, maxInstanceDurationMs: 4.25 }), occurrence(2)], 10),
    );
    // A summary of another capture, so the candidates come from the input alone.
    const summary = computeCaptureSummary([], { captureId: 'cap_othercapture0001' });

    const outlier = buildFactCandidates({ input: inputWith([row]), summary }).find(
      (candidate) => candidate.kind === 'render-outlier',
    );

    expect(outlier?.statement).toContain('rendered 10 times');
    const labels = new Map(outlier?.evidence.map((ref) => [ref.eventId, ref.label]) ?? []);
    expect(labels.get('event-tile-0001')).toBe(
      'TallyTile ×9 renders in one commit (context, 12.5 ms total)',
    );
    expect(labels.get('event-tile-0002')).toBe('TallyTile render (context, 12.5 ms)');
  });
});
