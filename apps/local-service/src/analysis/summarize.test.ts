/**
 * The analysis input's coverage: which events the analyze prompt's aggregates,
 * metrics and fact candidates are computed from.
 *
 * The panel data aggregates a capture from every one of its events up to
 * `MAX_AGGREGATE_INPUT_EVENTS` (`../panels/data.ts`). These suites pin the
 * analysis to the same events: one store scan of the whole capture under the
 * same bound, render rows and fact counts equal to `aggregateRenders` over that
 * whole set, a stored capture summary cited only when it was computed from
 * exactly those events, an honest truncation report for a capture above the
 * bound, the unchanged typed empty-capture outcome, and byte-identical,
 * JSON-round-trippable output.
 *
 * Every collaborator is an in-file fake: an in-memory telemetry store that
 * answers `scanEvents`, `query` and `countByKind` the way `TelemetryRepo` does
 * (capture order `start_time`, then `id`; an all-or-nothing scan; offset pages)
 * and records every call, and a session store holding one session and one
 * capture record. The upstream aggregates and the facts module are the real
 * ones.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { CaptureRecord, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import {
  TELEMETRY_KINDS,
  aggregateRenders,
  computeCaptureSummary,
  type CaptureSummary,
  type TelemetryEvent,
  type TelemetryKind,
} from '@debuggen/telemetry';

import { MAX_AGGREGATE_INPUT_EVENTS } from '../panels/data.js';
import type { FollowUpFocus } from '../pipeline/context-builder.js';
import { buildFactCandidates } from './facts.js';
import {
  ANALYSIS_INPUT_LIMITS,
  EMPTY_CAPTURE_MESSAGE,
  createAnalysisSummarizer,
  toRenderRow,
  type AnalysisRenderRow,
  type AnalysisStageInputBuild,
  type AnalysisStoredCapture,
  type AnalysisSummarizer,
  type AnalysisTelemetryPage,
  type AnalysisTelemetryPageRequest,
  type AnalysisTelemetryScan,
  type AnalysisTelemetryScanRequest,
  type CaptureLookupPort,
  type TelemetryQueryPort,
} from './summarize.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const SESSION_ID = 'session-summarize-suite';
const CAPTURE_ID = 'capture-summarize-suite';
const PRODUCER_ID = 'producer-summarize-suite';
const BASE_TIME = 1_767_225_600_000;
const QUESTION = 'Why does the list keep re-rendering?';

/** More events than the former 25 000-event analysis cap, and far fewer than the shared bound. */
const LARGE_CAPTURE_EVENTS = 25_600;

/** Components the fixture renders, several per commit. */
const COMPONENTS: readonly string[] = [
  'ListRow',
  'ListHeader',
  'FilterChip',
  'PriceTag',
  'StatusBadge',
  'ThumbnailImage',
  'RatingStars',
  'Pager',
];

/** The trigger of the `index`-th render of a commit: every trigger class occurs. */
const RENDER_TRIGGERS = ['props', 'unchanged', 'context', 'unchanged', 'state', 'unknown'] as const;

/** A fixed-width lower-case hexadecimal id. */
function hexId(ordinal: number, width: number): string {
  return ordinal.toString(16).padStart(width, '0');
}

/**
 * A render-heavy capture of `count` persisted events in the shapes the page
 * agent emits: per interaction one `interaction`, one `commit` and a burst of
 * `render` events under it, and a `fetch` every twentieth interaction. Every
 * event is a persisted row of {@link SESSION_ID} / {@link CAPTURE_ID} with a
 * store-assigned `ingestSeq`.
 */
function renderHeavyCapture(count: number): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  let interaction = 0;
  while (events.length < count) {
    interaction += 1;
    const traceId = hexId(interaction, 32);
    const interactionSpan = hexId(interaction * 64, 16);
    const commitSpan = hexId(interaction * 64 + 1, 16);
    const start = BASE_TIME + interaction * 50;
    const push = (
      kind: TelemetryKind,
      name: string,
      offset: number,
      duration: number,
      attributes: Record<string, unknown>,
      spanOrdinal: number,
      parentSpanId?: string,
    ): void => {
      if (events.length >= count) {
        return;
      }
      const ordinal = events.length + 1;
      events.push({
        id: `evt-${String(ordinal).padStart(7, '0')}`,
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        traceId,
        spanId: spanOrdinal === 0 ? interactionSpan : hexId(interaction * 64 + spanOrdinal, 16),
        ...(parentSpanId === undefined ? {} : { parentSpanId }),
        kind,
        tier: 'browser',
        name,
        startTime: start + offset,
        duration,
        attributes,
        status: 'ok',
        producerId: PRODUCER_ID,
        seq: ordinal,
        ingestSeq: ordinal,
      });
    };
    push('interaction', 'click', 0, 30, { type: 'click' }, 0);
    push('commit', 'commit', 1, 6, { phase: 'update', renderCount: 6, rootName: 'root' }, 1);
    for (let index = 0; index < RENDER_TRIGGERS.length; index += 1) {
      const component = COMPONENTS[(interaction + index * 3) % COMPONENTS.length] ?? 'ListRow';
      const trigger = RENDER_TRIGGERS[index] ?? 'unknown';
      push(
        'render',
        component,
        2 + index,
        0.5 + index * 0.25,
        {
          component,
          phase: 'update',
          trigger,
          changedProps: trigger === 'props' ? ['items'] : [],
          actualDuration: 0.5 + index * 0.25,
        },
        2 + index,
        commitSpan,
      );
    }
    if (interaction % 20 === 0) {
      push(
        'fetch',
        'GET',
        12,
        40,
        {
          'http.method': 'GET',
          url: '/api/items?page=?',
          'http.status_code': 200,
          request_key: `request-key-${String(interaction % 3)}`,
        },
        20,
        interactionSpan,
      );
    }
  }
  return events;
}

/** Capture order, as the store's scan and `start_asc` pages return it. */
function captureOrder(left: TelemetryEvent, right: TelemetryEvent): number {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A complete session record, as the sessions repository stores one. */
function sessionRecord(): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/home/dev/projects/storefront',
    projectName: 'storefront',
    devServerUrl: 'http://127.0.0.1:20231',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    status: 'analyzing',
    question: QUESTION,
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  };
}

/** A stopped capture record, carrying `summary` when one was stored at stop. */
function captureRecord(summary?: CaptureSummary): CaptureRecord {
  return {
    id: CAPTURE_ID,
    planVersion: 1,
    startedAt: BASE_TIME,
    stoppedAt: BASE_TIME + 3_600_000,
    ...(summary === undefined ? {} : { summary }),
  };
}

/** Every call the fake telemetry store answered. */
interface TelemetryCalls {
  readonly scans: { readonly filter: AnalysisTelemetryScanRequest; readonly maxRows: number }[];
  readonly pages: AnalysisTelemetryPageRequest[];
  counts: number;
}

/**
 * An in-memory telemetry store answering like `TelemetryRepo`: the selection
 * of a session and capture in capture order; a scan that is complete exactly
 * when the selection fits `maxRows` and otherwise answers from the count
 * alone; offset pages with a `nextOffset` while rows remain.
 */
function fakeTelemetry(events: readonly TelemetryEvent[]): {
  readonly port: TelemetryQueryPort;
  readonly calls: TelemetryCalls;
} {
  const calls: TelemetryCalls = { scans: [], pages: [], counts: 0 };
  const select = (sessionId: string, captureId: string): TelemetryEvent[] =>
    events
      .filter((event) => event.sessionId === sessionId && event.captureId === captureId)
      .sort(captureOrder);
  const port: TelemetryQueryPort = {
    scanEvents: (filter, maxRows): Result<AnalysisTelemetryScan, DebuggenError> => {
      calls.scans.push({ filter, maxRows });
      const selection = select(filter.sessionId, filter.captureId);
      if (selection.length > maxRows) {
        return ok({ rows: [], total: selection.length, complete: false });
      }
      return ok({ rows: selection, total: selection.length, complete: true });
    },
    query: (filter): Result<AnalysisTelemetryPage, DebuggenError> => {
      calls.pages.push(filter);
      const selection = select(filter.sessionId, filter.captureId);
      const rows = selection.slice(filter.offset, filter.offset + filter.limit);
      const next = filter.offset + rows.length;
      return ok({
        rows,
        total: selection.length,
        ...(next < selection.length ? { nextOffset: next } : {}),
      });
    },
    countByKind: (sessionId, captureId) => {
      calls.counts += 1;
      const counts = Object.fromEntries(TELEMETRY_KINDS.map((kind) => [kind, 0])) as Record<
        TelemetryKind,
        number
      >;
      for (const event of select(sessionId, captureId ?? CAPTURE_ID)) {
        counts[event.kind] += 1;
      }
      return ok(counts);
    },
  };
  return { port, calls };
}

/** A session store holding {@link sessionRecord} and one capture record. */
function fakeSessions(capture: CaptureRecord): CaptureLookupPort {
  return {
    get: (id) => ok(id === SESSION_ID ? sessionRecord() : undefined),
    getCapture: (captureId): Result<AnalysisStoredCapture | undefined, DebuggenError> =>
      ok(captureId === capture.id ? { sessionId: SESSION_ID, capture } : undefined),
  };
}

/** A summarizer over the fakes, with the calls the telemetry fake answered. */
function summarizerOver(
  events: readonly TelemetryEvent[],
  capture: CaptureRecord = captureRecord(),
): { readonly summarizer: AnalysisSummarizer; readonly calls: TelemetryCalls } {
  const telemetry = fakeTelemetry(events);
  return {
    summarizer: createAnalysisSummarizer({
      telemetry: telemetry.port,
      sessions: fakeSessions(capture),
    }),
    calls: telemetry.calls,
  };
}

/** Unwraps a result the case expects to succeed, failing with its code otherwise. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The render rows the analysis carries when it aggregates exactly `events`. */
function expectedRenderRows(events: readonly TelemetryEvent[]): AnalysisRenderRow[] {
  return aggregateRenders(events, {
    maxOccurrencesPerComponent: ANALYSIS_INPUT_LIMITS.maxRenderOccurrencesPerRow,
    includeOccurrences: true,
  })
    .slice(0, ANALYSIS_INPUT_LIMITS.maxRenderRows)
    .map((stat) => toRenderRow(stat));
}

/** The value of one metric of a metric list. */
function metricValue(
  metrics: readonly { readonly id: string; readonly value?: number | undefined }[],
  id: string,
): number | undefined {
  return metrics.find((metric) => metric.id === id)?.value;
}

/* -------------------------------------------------------------------------------------------------
 * The shared bound
 * ---------------------------------------------------------------------------------------------- */

describe('analysis input: one bound shared with the panel data', () => {
  it('considers as many events as the panel data aggregates, by construction', () => {
    expect(ANALYSIS_INPUT_LIMITS.maxEventsConsidered).toBe(MAX_AGGREGATE_INPUT_EVENTS);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A capture larger than the former analysis cap
 * ---------------------------------------------------------------------------------------------- */

describe('analysis input: a capture above the former 25 000-event cap is analysed in full', () => {
  const events = renderHeavyCapture(LARGE_CAPTURE_EVENTS);
  const all = [...events].sort(captureOrder);
  // A summary the capture stage stored while only part of the capture was summarised.
  const partial = computeCaptureSummary(all.slice(0, 10_000), {
    captureId: CAPTURE_ID,
    sessionId: SESSION_ID,
  });
  const storedPartial: CaptureSummary = {
    ...partial,
    coverage: {
      storedEvents: LARGE_CAPTURE_EVENTS,
      summarizedEvents: 10_000,
      producerDroppedEvents: 0,
      drain: 'quiescent',
      complete: false,
    },
  };
  let build: AnalysisStageInputBuild;
  let calls: TelemetryCalls;

  beforeAll(async () => {
    const over = summarizerOver(events, captureRecord(storedPartial));
    calls = over.calls;
    build = expectOk(
      await over.summarizer.buildStageInput({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        question: QUESTION,
      }),
    );
  }, 120_000);

  it('reads the whole capture with one scan under the shared bound, never an offset walk', () => {
    expect(calls.scans).toEqual([
      {
        filter: { sessionId: SESSION_ID, captureId: CAPTURE_ID },
        maxRows: MAX_AGGREGATE_INPUT_EVENTS,
      },
    ]);
    expect(calls.pages).toEqual([]);
    expect(build.input.capture).toMatchObject({
      eventCount: LARGE_CAPTURE_EVENTS,
      eventsConsidered: LARGE_CAPTURE_EVENTS,
      eventsExcluded: 0,
      eventsTruncated: false,
    });
    expect(build.input.truncated.sections).not.toContain('capture');
    expect(build.stats.eventsConsidered).toBe(LARGE_CAPTURE_EVENTS);
  });

  it('carries render rows equal to aggregateRenders over every event of the capture', () => {
    // Only each row's citable occurrences are capped; its counts cover every render.
    expect(build.stats.droppedForBudget).not.toContain('renders');
    expect(build.input.renders).toEqual(expectedRenderRows(all));
    const total = build.input.renders.reduce((sum, row) => sum + row.renderCount, 0);
    expect(total).toBe(all.filter((event) => event.kind === 'render').length);
  });

  it('draws the metrics and the window from the aggregated events, not the partial stored summary', () => {
    const full = computeCaptureSummary(all, { captureId: CAPTURE_ID, sessionId: SESSION_ID });
    expect(build.summary).not.toBe(storedPartial);
    expect(build.summary.eventCount).toBe(LARGE_CAPTURE_EVENTS);
    expect(metricValue(build.input.metrics, 'render_count')).toBe(
      metricValue(full.metrics, 'render_count'),
    );
    expect(metricValue(build.input.metrics, 'render_count')).not.toBe(
      metricValue(storedPartial.metrics, 'render_count'),
    );
    expect(metricValue(build.input.metrics, 'unchanged_render_count')).toBe(
      metricValue(full.metrics, 'unchanged_render_count'),
    );
    expect(build.input.capture.startTime).toBe(full.startTime);
    expect(build.input.capture.endTime).toBe(full.endTime);
    expect(build.input.capture.traceCount).toBe(full.traceCount);
    expect(build.summary.metrics.map((metric) => metric.value)).toEqual(
      build.input.metrics.map((metric) => metric.value),
    );
  });

  it('states fact counts that equal aggregateRenders over the full set', () => {
    const stats = aggregateRenders(all, { includeOccurrences: false });
    const byComponent = new Map(stats.map((stat) => [stat.component, stat]));
    const candidates = buildFactCandidates({ input: build.input, summary: build.summary });
    const outliers = candidates.filter((candidate) => candidate.kind === 'render-outlier');
    const unchanged = candidates.filter((candidate) => candidate.kind === 'unchanged-render-burst');
    expect(outliers.length).toBeGreaterThan(0);
    expect(unchanged.length).toBeGreaterThan(0);
    for (const candidate of outliers) {
      const component = candidate.statement.slice(0, candidate.statement.indexOf(' rendered '));
      expect(candidate.value).toBe(byComponent.get(component)?.renderCount);
    }
    for (const candidate of unchanged) {
      const component = candidate.statement.slice(0, candidate.statement.indexOf(' rendered '));
      const stat = byComponent.get(component);
      expect(candidate.value).toBe(stat?.unchangedRenderCount);
      expect(candidate.statement).toContain(`rendered ${String(stat?.renderCount)} times`);
    }
  });

  it('recomputes a missing capture summary over every event up to the shared bound', async () => {
    const over = summarizerOver(events);
    const summary = expectOk(await over.summarizer.loadCaptureSummary(SESSION_ID, CAPTURE_ID));
    expect(over.calls.scans).toEqual([
      {
        filter: { sessionId: SESSION_ID, captureId: CAPTURE_ID },
        maxRows: MAX_AGGREGATE_INPUT_EVENTS,
      },
    ]);
    expect(over.calls.pages).toEqual([]);
    expect(summary.eventCount).toBe(LARGE_CAPTURE_EVENTS);
  }, 120_000);
});

/* -------------------------------------------------------------------------------------------------
 * Which summary the input cites
 * ---------------------------------------------------------------------------------------------- */

describe('analysis input: the stored summary is cited only for exactly the aggregated events', () => {
  const events = renderHeavyCapture(400);
  const all = [...events].sort(captureOrder);

  it('uses a stored summary computed from every event of the capture as is', async () => {
    const stored = computeCaptureSummary(all, { captureId: CAPTURE_ID, sessionId: SESSION_ID });
    const { summarizer } = summarizerOver(events, captureRecord(stored));
    const build = expectOk(
      await summarizer.buildStageInput({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        question: QUESTION,
      }),
    );
    expect(build.summary).toBe(stored);
    expect(build.input.metrics.map((metric) => metric.value)).toEqual(
      stored.metrics.map((metric) => metric.value),
    );
  });

  it('leaves the stored summary out when a row fails the provenance check', async () => {
    const stored = computeCaptureSummary(all, { captureId: CAPTURE_ID, sessionId: SESSION_ID });
    const tampered = all.map((event, index) => (index === 7 ? { ...event, ingestSeq: 0 } : event));
    const { summarizer } = summarizerOver(tampered, captureRecord(stored));
    const build = expectOk(
      await summarizer.buildStageInput({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        question: QUESTION,
      }),
    );
    expect(build.input.capture.eventsExcluded).toBe(1);
    expect(build.input.capture.eventsConsidered).toBe(all.length - 1);
    expect(build.input.truncated.sections).toContain('capture');
    expect(build.summary).not.toBe(stored);
    expect(build.summary.eventCount).toBe(all.length - 1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A capture above the bound
 * ---------------------------------------------------------------------------------------------- */

describe('analysis input: a capture above the bound reports its truncation', () => {
  const events = renderHeavyCapture(1_500);
  const all = [...events].sort(captureOrder);
  const bound = 1_000;

  it('analyses the first events in capture order and says it covers part of the capture', async () => {
    // Even a stored summary of the same number of events is not cited for a truncated read.
    const stored = computeCaptureSummary(all.slice(0, bound), {
      captureId: CAPTURE_ID,
      sessionId: SESSION_ID,
    });
    const { summarizer, calls } = summarizerOver(events, captureRecord(stored));
    const build = expectOk(
      await summarizer.buildStageInput({
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        question: QUESTION,
        options: { limits: { maxEventsConsidered: bound } },
      }),
    );

    // The scan answers from its count alone; the first `bound` events are paged once each.
    expect(calls.scans).toEqual([
      { filter: { sessionId: SESSION_ID, captureId: CAPTURE_ID }, maxRows: bound },
    ]);
    expect(calls.pages.map((page) => [page.offset, page.limit, page.sort])).toEqual([
      [0, bound, 'start_asc'],
    ]);
    expect(build.input.capture).toMatchObject({
      eventCount: all.length,
      eventsConsidered: bound,
      eventsTruncated: true,
    });
    expect(build.input.truncated.sections).toContain('capture');
    expect(build.input.truncated.reason).toBe('row-limits');
    expect(build.stats.sectionsTruncated).toContain('capture');
    expect(build.summary).not.toBe(stored);
    expect(build.summary.eventCount).toBe(bound);
    expect(build.input.renders).toEqual(expectedRenderRows(all.slice(0, bound)));
  });
});

/* -------------------------------------------------------------------------------------------------
 * The empty capture, determinism and the one-pass candidate derivation
 * ---------------------------------------------------------------------------------------------- */

describe('analysis input: the empty capture is the typed CAPTURE_EMPTY outcome', () => {
  it('answers a capture without events before any row is read', async () => {
    const { summarizer, calls } = summarizerOver([]);
    const built = await summarizer.buildStageInput({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      question: QUESTION,
    });
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.error.code).toBe('CAPTURE_EMPTY');
    expect(built.error.message).toBe(EMPTY_CAPTURE_MESSAGE);
    expect(built.error.details).toMatchObject({ reason: 'no-events', eventsExcluded: 0 });
    expect(calls.scans).toEqual([]);
    expect(calls.pages).toEqual([]);
  });

  it('answers a capture without an interaction when one is required, before any row is read', async () => {
    const renders = renderHeavyCapture(40).filter((event) => event.kind !== 'interaction');
    const { summarizer, calls } = summarizerOver(renders);
    const built = await summarizer.buildStageInput({
      sessionId: SESSION_ID,
      captureId: CAPTURE_ID,
      question: QUESTION,
      options: { requireInteraction: true },
    });
    expect(!built.ok && built.error.code).toBe('CAPTURE_EMPTY');
    expect(!built.ok && built.error.details).toMatchObject({ reason: 'no-interaction' });
    expect(calls.scans).toEqual([]);
  });
});

describe('analysis input: deterministic, plain JSON, and one read per build', () => {
  const events = renderHeavyCapture(600);
  const request = { sessionId: SESSION_ID, captureId: CAPTURE_ID, question: QUESTION } as const;

  it('yields byte-identical JSON for identical inputs, unchanged by a round trip', async () => {
    const { summarizer } = summarizerOver(events);
    const first = expectOk(await summarizer.buildStageInput(request));
    const second = expectOk(await summarizer.buildStageInput(request));
    const serialised = JSON.stringify(first.input);
    expect(JSON.stringify(second.input)).toBe(serialised);
    expect(JSON.parse(serialised)).toStrictEqual(first.input);
    expect(JSON.parse(JSON.stringify(first.summary))).toStrictEqual(first.summary);
  });

  it('derives the fact candidates inside the build, from one read, exactly as two builds would', async () => {
    const derived = summarizerOver(events);
    const oneBuild = expectOk(
      await derived.summarizer.buildStageInput({
        ...request,
        options: { deriveFactCandidates: (evidence) => buildFactCandidates(evidence) },
      }),
    );
    expect(derived.calls.scans).toHaveLength(1);
    expect(oneBuild.input.factCandidates.length).toBeGreaterThan(0);

    const { summarizer } = summarizerOver(events);
    const plain = expectOk(await summarizer.buildStageInput(request));
    const candidates = buildFactCandidates({ input: plain.input, summary: plain.summary });
    const carried = expectOk(
      await summarizer.buildStageInput({ ...request, options: { factCandidates: candidates } }),
    );
    expect(JSON.stringify(oneBuild.input)).toBe(JSON.stringify(carried.input));
    expect(oneBuild.stats).toStrictEqual(carried.stats);
  });

  it('turns a throwing derivation into a typed error that quotes nothing of the capture', async () => {
    const { summarizer } = summarizerOver(events);
    const built = await summarizer.buildStageInput({
      ...request,
      options: {
        deriveFactCandidates: () => {
          throw new Error('ListRow rendered with a secret value');
        },
      },
    });
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.error.code).toBe('INTERNAL');
    expect(built.error.details).toMatchObject({ reason: 'fact-candidate-derivation-threw' });
    expect(
      JSON.stringify({ message: built.error.message, details: built.error.details }),
    ).not.toContain('secret');
  });

  it('refuses a scan that claims completeness with more rows than it was allowed', async () => {
    const { port } = fakeTelemetry(events);
    const summarizer = createAnalysisSummarizer({
      telemetry: {
        ...port,
        scanEvents: (filter) => {
          const whole = port.scanEvents(filter, Number.MAX_SAFE_INTEGER);
          return whole.ok ? ok({ ...whole.value, complete: true }) : err(whole.error);
        },
      },
      sessions: fakeSessions(captureRecord()),
    });
    const built = await summarizer.buildStageInput({
      ...request,
      options: { limits: { maxEventsConsidered: 10 } },
    });
    expect(!built.ok && built.error.code).toBe('STORE_ERROR');
    expect(!built.ok && built.error.details).toMatchObject({ reason: 'scan-inconsistent' });
  });

  it('propagates a store failure of the scan unchanged', async () => {
    const { port } = fakeTelemetry(events);
    const failure = new DebuggenError('STORE_ERROR', 'The store is unavailable.');
    const summarizer = createAnalysisSummarizer({
      telemetry: { ...port, scanEvents: () => err(failure) },
      sessions: fakeSessions(captureRecord()),
    });
    const built = await summarizer.buildStageInput(request);
    expect(!built.ok && built.error).toBe(failure);
  });

  it('carries a follow-up focus exactly when one is given, leaving every other section as it was', async () => {
    const focus: FollowUpFocus = {
      categoryHints: ['rendering'],
      declarations: [{ file: 'src/ledger/rows.tsx', symbol: 'ListRow', kind: 'component' }],
    };
    const plain = expectOk(await summarizerOver(events).summarizer.buildStageInput(request));
    expect(Object.hasOwn(plain.input, 'followUpFocus')).toBe(false);
    const unset = expectOk(
      await summarizerOver(events).summarizer.buildStageInput({
        ...request,
        followUpFocus: undefined,
      }),
    );
    expect(Object.hasOwn(unset.input, 'followUpFocus')).toBe(false);
    expect(JSON.stringify(unset.input)).toBe(JSON.stringify(plain.input));

    const focused = expectOk(
      await summarizerOver(events).summarizer.buildStageInput({ ...request, followUpFocus: focus }),
    );
    expect(focused.input.followUpFocus).toStrictEqual(focus);
    const serialised = JSON.stringify(focused.input);
    expect(JSON.parse(serialised)).toStrictEqual(focused.input);
    const { followUpFocus: carried, ...rest } = focused.input;
    expect(carried).toStrictEqual(focus);
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain.input));
    expect(focused.summary).toStrictEqual(plain.summary);
  });
});
