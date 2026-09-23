/**
 * Colocated tests for `./semantic.ts` — the checkpoint that decides whether a
 * well-formed panel is **true of the capture it claims to describe**.
 *
 * ## What makes this suite load-bearing
 *
 * The module under test is the only place a fabricated citation can be caught
 * (AAP 0.2.3, AAP 0.8.4), and it is also a place where over-strictness is
 * expensive: its rejection path leads the service to replace a real answer with
 * the deterministic fallback panel (AAP 0.5.5). Both failure directions are
 * silent in production, so the three-way outcome — `valid`, `unverifiable`,
 * `invalid` — is asserted here explicitly, including the middle case that exists
 * because a {@link CaptureSummary} is a bounded rollup rather than an index of
 * every event id.
 *
 * ## Why the captures are computed rather than hand-written
 *
 * Every summary below comes from `computeCaptureSummary` over synthetic
 * telemetry events, built in-file with the builder convention the telemetry
 * package's own suites use (AAP 0.2.5 gives fixture *files* only to telemetry,
 * instrumentation and code-analysis). Two reasons:
 *
 * - a hand-written `CaptureSummary` literal would encode this suite's *belief*
 *   about which sections carry which event ids, which is exactly the belief the
 *   module under test must get right — for instance that renders are aggregated
 *   counts-only, so a fact citing a render is normally unverifiable;
 * - the availability and metric cases need real tallies. `transferred_bytes` is
 *   genuinely unavailable for a capture with no resource timing, so the "an
 *   unavailable metric must not fail a panel" case is measured rather than
 *   staged.
 *
 * Edge shapes a real capture cannot easily produce — an empty capture, a
 * clipped trace list — are made by overriding fields of a computed summary,
 * which stays type-checked against the declared interface.
 *
 * ## Privacy, asserted rather than assumed
 *
 * The last test places sentinel strings in every value a panel carries (title,
 * statements, event ids, trace ids, node titles) and asserts that none of them
 * reaches an issue, a rendered error message, a hint or an error's details —
 * the discipline `packages/shared/src/source-location.test.ts` and
 * `packages/telemetry/src/schema/event.test.ts` apply to their own reports
 * (AAP 0.5.2).
 *
 * No identifier below names a component, route or symbol of any application:
 * the fixtures use deliberately generic names, because `scripts/check-no-hardcoding.mjs`
 * scans this package and because a test that knew an application would be
 * evidence of the coupling AAP 0.5.4 forbids.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError } from '@debuggen/shared';
import {
  METRIC_IDS,
  allowedTiersFor,
  computeCaptureSummary,
  type CaptureSummary,
  type TelemetryEvent,
  type TelemetryKind,
  type TelemetryStatus,
  type TelemetryTier,
} from '@debuggen/telemetry';

import {
  SEMANTIC_ISSUE_CODES,
  SEMANTIC_ISSUE_CODE_BY_REASON,
  SEMANTIC_ISSUE_REASONS,
  SEMANTIC_ISSUE_SEVERITIES,
  SEMANTIC_ISSUE_SEVERITY_BY_REASON,
  SEMANTIC_VALIDATION_STATUSES,
  collectSemanticIssues,
  isSemanticIssueReason,
  toResult,
  validateAgainstCapture,
  type IdResolution,
  type SemanticIssue,
  type SemanticValidationOutcome,
} from './semantic.js';
import type { MetricCardsNode } from './nodes/viz.js';
import type { PanelNode, PanelSpec } from './spec.js';
import type { EventRef, Fact, Hypothesis } from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * Fixture identity
 * ---------------------------------------------------------------------------
 */

/** The capture every computed summary below describes. */
const CAPTURE_ID = 'cap_0000000000000001';

/** The session that owns it. */
const SESSION_ID = 'ses_0000000000000001';

/** The panel every specification below is. */
const PANEL_ID = 'pnl_0000000000000001';

/** The one producer the fixtures attribute events to. */
const PRODUCER_ID = 'prd_0000000000000001';

/** Unix epoch milliseconds the fixtures start at, so windows are deterministic. */
const BASE_TIME = 1_700_000_000_000;

/** A trace id the capture does not hold, in the right shape. */
const ABSENT_TRACE_ID = 'ffffffffffffffffffffffffffffffff';

/** An event id the capture does not hold, in the product's `evt_…` shape. */
const ABSENT_EVENT_ID = 'evt_ffffffffffffffff';

/** A span id the capture does not hold. */
const ABSENT_SPAN_ID = 'ffffffffffffffff';

/** The kinds the fixtures produce, named once so no literal is repeated. */
const INTERACTION_KIND: TelemetryKind = 'interaction';

/** See {@link INTERACTION_KIND}. */
const RENDER_KIND: TelemetryKind = 'render';

/** See {@link INTERACTION_KIND}. */
const FETCH_KIND: TelemetryKind = 'fetch';

/** See {@link INTERACTION_KIND}. */
const SERVER_KIND: TelemetryKind = 'http.server';

/** See {@link INTERACTION_KIND}. */
const QUERY_KIND: TelemetryKind = 'db.query';

/** The status a well-formed fixture event reports. */
const OK_STATUS: TelemetryStatus = 'ok';

/** The metric that is genuinely unobservable without resource timing. */
const UNOBSERVABLE_METRIC = 'transferred_bytes';

/** A metric every capture can measure. */
const OBSERVABLE_METRIC = 'render_count';

/*
 * ---------------------------------------------------------------------------
 * Telemetry builders
 *
 * The convention the telemetry package's own suites use: one ordinal counter, so
 * every id is distinct, deterministic within a run and derived rather than
 * repeated.
 * ---------------------------------------------------------------------------
 */

/** The running ordinal every generated id is derived from. */
let fixtureOrdinal = 0;

/** The next ordinal. */
function nextOrdinal(): number {
  fixtureOrdinal += 1;

  return fixtureOrdinal;
}

/** `ordinal` as exactly `length` lowercase hex digits, which the schema requires. */
function hexId(length: number, ordinal: number): string {
  const digits = ordinal.toString(16);

  if (digits.length > length) {
    throw new Error(`fixture ordinal ${String(ordinal)} exceeds ${String(length)} hex digits`);
  }

  return digits.padStart(length, '0');
}

/** The first tier the catalog permits for `kind`, so a fixture is well-formed. */
function defaultTierFor(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);

  if (tier === undefined) {
    throw new Error(`the kind "${kind}" permits no tier`);
  }

  return tier;
}

/** What an event fixture may override. */
interface EventOverrides {
  readonly kind?: TelemetryKind;
  readonly tier?: TelemetryTier;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly attributes?: Record<string, unknown>;
}

/** One persisted event with every required field populated. */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const kind = overrides.kind ?? INTERACTION_KIND;
  const ordinal = nextOrdinal();

  return {
    id: `evt_${hexId(16, ordinal)}`,
    traceId: overrides.traceId ?? hexId(32, ordinal),
    spanId: overrides.spanId ?? hexId(16, ordinal),
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: `fixture span ${String(ordinal)}`,
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? 1,
    tier: overrides.tier ?? defaultTierFor(kind),
    attributes: overrides.attributes ?? {},
    status: OK_STATUS,
    producerId: PRODUCER_ID,
    seq: ordinal,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: ordinal,
  };
}

/** The capture identity every computed summary carries. */
function captureContext(): { readonly captureId: string; readonly sessionId: string } {
  return { captureId: CAPTURE_ID, sessionId: SESSION_ID };
}

/** One interaction: a click, a render, a request, a server span and a query. */
interface InteractionFixture {
  /** The events, in the order they were produced. */
  readonly events: readonly TelemetryEvent[];
  /** The trace they share. */
  readonly traceId: string;
  /** The slowest span, which any summary publishes in `topSpans`. */
  readonly slowestSpan: TelemetryEvent;
  /** The render, which a summary publishes counts-only. */
  readonly render: TelemetryEvent;
  /** The database query, which a summary publishes as a group with occurrences. */
  readonly query: TelemetryEvent;
}

/**
 * Builds one correlated interaction across the three tiers.
 *
 * Shaped so that each assertion below has a distinct event to cite: the server
 * span is the slowest (so it heads `topSpans`), the query is the cheapest (so a
 * summary bounded to one row publishes it only through its query group), and the
 * render is present so that render-kind availability holds.
 */
function makeInteraction(): InteractionFixture {
  const traceId = hexId(32, nextOrdinal());
  const interaction = makeEvent({ kind: INTERACTION_KIND, traceId, duration: 40 });
  const render = makeEvent({
    kind: RENDER_KIND,
    traceId,
    parentSpanId: interaction.spanId,
    startTime: BASE_TIME + 4,
    duration: 6,
    attributes: { component: 'FixtureView', phase: 'update', trigger: 'props' },
  });
  const fetchSpan = makeEvent({
    kind: FETCH_KIND,
    traceId,
    parentSpanId: interaction.spanId,
    startTime: BASE_TIME + 8,
    duration: 30,
    attributes: { 'http.method': 'GET', url: '/fixture/resource', 'http.status_code': 200 },
  });
  const serverSpan = makeEvent({
    kind: SERVER_KIND,
    traceId,
    parentSpanId: fetchSpan.spanId,
    startTime: BASE_TIME + 10,
    duration: 120,
  });
  const query = makeEvent({
    kind: QUERY_KIND,
    traceId,
    parentSpanId: serverSpan.spanId,
    startTime: BASE_TIME + 12,
    duration: 2,
    attributes: {
      'db.system': 'postgresql',
      'db.statement': 'SELECT id FROM fixture_rows WHERE id = $1',
      'db.rowCount': 1,
    },
  });

  return {
    events: [interaction, render, fetchSpan, serverSpan, query],
    traceId,
    slowestSpan: serverSpan,
    render,
    query,
  };
}

/** Summarises events exactly as the service does, optionally bounded. */
function summarize(events: readonly TelemetryEvent[], topN?: number): CaptureSummary {
  return computeCaptureSummary(events, captureContext(), topN === undefined ? undefined : { topN });
}

/*
 * ---------------------------------------------------------------------------
 * Panel builders
 * ---------------------------------------------------------------------------
 */

/** A citation of one event, with whatever coordinates the case wants recorded. */
function ref(eventId: string, coordinates: Partial<Omit<EventRef, 'eventId'>> = {}): EventRef {
  return { eventId, ...coordinates };
}

/** An observed fact citing the given references. */
function fact(
  evidence: readonly EventRef[],
  statement = 'The capture recorded the cited work.',
): Fact {
  return { statement, evidence: [...evidence] };
}

/** A likely cause citing the given references. */
function hypothesis(evidence: readonly EventRef[]): Hypothesis {
  return {
    statement: 'The cited work accounts for most of the elapsed time.',
    evidence: [...evidence],
    confidence: 'medium',
  };
}

/** A timeline node scoped to one trace. */
function timelineNode(traceId: string, id = 'layout.0'): PanelNode {
  return { type: 'timeline', id, query: { source: 'trace', filter: { traceId } } };
}

/** A metric-tile node asking for the given ids. */
function metricCardsNode(metrics: readonly string[], id = 'layout.0'): PanelNode {
  return {
    type: 'metricCards',
    id,
    query: { source: 'metrics' },
    // A case that deliberately asks for an unrecognised id passes a string the
    // node schema would reject, which is exactly the value this module must
    // refuse without reading it back out of the panel.
    metrics: [...metrics] as MetricCardsNode['metrics'],
  };
}

/** A render table, which needs render-kind evidence to draw anything. */
function renderTableNode(id = 'layout.0'): PanelNode {
  return { type: 'renderTable', id, query: { source: 'renders' } };
}

/** What a specification fixture may override. */
interface SpecOverrides {
  readonly observed?: readonly Fact[];
  readonly likelyCauses?: readonly Hypothesis[];
  readonly layout?: readonly PanelNode[];
  readonly title?: string;
  readonly fallback?: boolean;
}

/** A normalized specification with every required field populated. */
function makeSpec(overrides: SpecOverrides = {}): PanelSpec {
  return {
    version: 1,
    id: PANEL_ID,
    sessionId: SESSION_ID,
    panelVersion: 1,
    title: overrides.title ?? 'Fixture panel',
    summary: {
      observed: [...(overrides.observed ?? [])],
      likelyCauses: [...(overrides.likelyCauses ?? [])],
    },
    layout: [...(overrides.layout ?? [])],
    ...(overrides.fallback === undefined ? {} : { meta: { fallback: overrides.fallback } }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Resolver builders
 * ---------------------------------------------------------------------------
 */

/** A resolver that reports exactly these verdicts and nothing else. */
function resolverFor(known: readonly string[], unknown: readonly string[]): () => IdResolution {
  return () => ({ known: new Set(known), unknown: new Set(unknown) });
}

/** Every reason the outcome reports, in the order the module returned them. */
function reasonsOf(issues: readonly SemanticIssue[]): readonly string[] {
  return issues.map((issue) => issue.reason);
}

/** The refutations of an outcome, or an empty list when it has none. */
function issuesOf(outcome: SemanticValidationOutcome): readonly SemanticIssue[] {
  return outcome.status === 'invalid' ? outcome.issues : [];
}

/** The unverifiable references of an outcome, or an empty list. */
function unverifiableOf(outcome: SemanticValidationOutcome): readonly SemanticIssue[] {
  return outcome.status === 'valid' ? [] : outcome.unverifiable;
}

/*
 * ---------------------------------------------------------------------------
 * The vocabularies
 * ---------------------------------------------------------------------------
 */

describe('the issue vocabulary', () => {
  it('maps every reason to a code and a severity', () => {
    expect(SEMANTIC_ISSUE_REASONS.length).toBeGreaterThan(0);

    for (const reason of SEMANTIC_ISSUE_REASONS) {
      const code = SEMANTIC_ISSUE_CODE_BY_REASON[reason];
      const severity = SEMANTIC_ISSUE_SEVERITY_BY_REASON[reason];

      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(SEMANTIC_ISSUE_SEVERITIES).toContain(severity);
    }
  });

  it('publishes one code per reason, in reason order', () => {
    expect(SEMANTIC_ISSUE_CODES).toEqual(
      SEMANTIC_ISSUE_REASONS.map((reason) => SEMANTIC_ISSUE_CODE_BY_REASON[reason]),
    );
    expect(new Set(SEMANTIC_ISSUE_CODES).size).toBe(SEMANTIC_ISSUE_CODES.length);
  });

  it('narrows a reason and rejects anything else', () => {
    for (const reason of SEMANTIC_ISSUE_REASONS) {
      expect(isSemanticIssueReason(reason)).toBe(true);
    }

    expect(isSemanticIssueReason('unknown-reason')).toBe(false);
    expect(isSemanticIssueReason(undefined)).toBe(false);
    expect(isSemanticIssueReason(42)).toBe(false);
  });

  it('keeps the availability reasons out of the failing severities', () => {
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unavailable-metric']).toBe('informational');
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unavailable-source']).toBe('advisory');
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unknown-event-id']).toBe('fatal');
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unverifiable-event-id']).toBe('unverifiable');
  });

  it('declares the three statuses the outcome is discriminated by', () => {
    expect(SEMANTIC_VALIDATION_STATUSES).toEqual(['valid', 'unverifiable', 'invalid']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Evidence references
 * ---------------------------------------------------------------------------
 */

describe('evidence references', () => {
  it('accepts a panel whose citations all appear in the summary sections', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      observed: [fact([ref(interaction.slowestSpan.id, { traceId: interaction.traceId })])],
      likelyCauses: [hypothesis([ref(interaction.slowestSpan.id)])],
    });

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
  });

  it('accepts a citation attested only through a published group occurrence', () => {
    const interaction = makeInteraction();
    // Bounded to one row per section: the query is the cheapest span, so it is
    // absent from `topSpans` and reachable only through the query group.
    const summary = summarize(interaction.events, 1);

    expect(summary.topSpans.map((span) => span.id)).not.toContain(interaction.query.id);
    expect(summary.topQueries.length).toBeGreaterThan(0);

    const spec = makeSpec({ observed: [fact([ref(interaction.query.id)])] });

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
  });

  it('reports an unattested citation as unverifiable rather than valid or invalid', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('unverifiable');
    expect(reasonsOf(unverifiableOf(outcome))).toEqual(['unverifiable-event-id']);
    expect(unverifiableOf(outcome)[0]?.path).toEqual([
      'summary',
      'observed',
      0,
      'evidence',
      0,
      'eventId',
    ]);
  });

  it('treats a render citation as unverifiable, because renders are summarised counts-only', () => {
    const interaction = makeInteraction();
    // Bounded to one row, so the render is out of `topSpans` and its component's
    // published statistics are the only section that could attest to it — and
    // they carry no occurrences, because `computeCaptureSummary` aggregates
    // renders counts-only. This is the case the middle status exists for.
    const summary = summarize(interaction.events, 1);

    expect(summary.topRenders.length).toBeGreaterThan(0);
    expect(summary.topRenders.every((stat) => stat.occurrences.length === 0)).toBe(true);
    expect(summary.topSpans.map((span) => span.id)).not.toContain(interaction.render.id);

    const spec = makeSpec({ observed: [fact([ref(interaction.render.id)])] });

    expect(validateAgainstCapture(spec, summary).status).toBe('unverifiable');
  });

  it('rejects a citation a resolver reports unknown', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([], [ABSENT_EVENT_ID]),
    });

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-event-id']);
    expect(issuesOf(outcome)[0]?.code).toBe(SEMANTIC_ISSUE_CODE_BY_REASON['unknown-event-id']);
    expect(issuesOf(outcome)[0]?.path).toEqual([
      'summary',
      'observed',
      0,
      'evidence',
      0,
      'eventId',
    ]);
  });

  it('accepts a citation a resolver reports known', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([ABSENT_EVENT_ID], []),
    });

    expect(outcome.status).toBe('valid');
  });

  it('asks a resolver once, with every distinct cited id', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const asked: string[][] = [];
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID), ref(ABSENT_EVENT_ID)])],
      likelyCauses: [hypothesis([ref(interaction.slowestSpan.id)])],
    });

    validateAgainstCapture(spec, summary, {
      resolveEventIds: (ids) => {
        asked.push([...ids]);

        return { known: new Set(ids), unknown: new Set<string>() };
      },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual([ABSENT_EVENT_ID, interaction.slowestSpan.id]);
  });

  it('refutes every citation when the capture holds no events at all', () => {
    const summary = summarize([]);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-event-id']);
  });

  it('rejects a citation whose recorded coordinates contradict the capture', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      observed: [
        fact([
          ref(interaction.slowestSpan.id, {
            traceId: ABSENT_TRACE_ID,
            spanId: ABSENT_SPAN_ID,
          }),
        ]),
      ],
    });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['event-ref-mismatch', 'event-ref-mismatch']);
    expect(issuesOf(outcome).map((issue) => issue.path.at(-1))).toEqual(['spanId', 'traceId']);
  });

  it('reports a statement that cites nothing, which the schema should already have refused', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unevidenced-fact']);
    expect(issuesOf(outcome)[0]?.path).toEqual(['summary', 'observed', 0, 'evidence']);
    expect(issuesOf(outcome)[0]?.code).toBe('panel_fact_evidence_empty');
  });

  it('checks the likely causes exactly as it checks the observed facts', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ likelyCauses: [hypothesis([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([], [ABSENT_EVENT_ID]),
    });

    expect(issuesOf(outcome)[0]?.path).toEqual([
      'summary',
      'likelyCauses',
      0,
      'evidence',
      0,
      'eventId',
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Trace filters
 * ---------------------------------------------------------------------------
 */

describe('trace filters', () => {
  it('accepts a filter naming a trace the capture holds', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [timelineNode(interaction.traceId)] });

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
  });

  it('refutes an absent trace from a complete trace list, with no resolver', () => {
    const summary = summarize(makeInteraction().events);

    expect(summary.traceIds).toHaveLength(summary.traceCount);

    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
    );

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-trace-id']);
    expect(issuesOf(outcome)[0]?.path).toEqual(['layout', 0, 'query', 'filter', 'traceId']);
    expect(issuesOf(outcome)[0]?.nodeType).toBe('timeline');
  });

  it('reports an absent trace as unverifiable when the trace list was clipped', () => {
    const summary = clippedTraceListSummary();
    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
    );

    expect(outcome.status).toBe('unverifiable');
    expect(reasonsOf(unverifiableOf(outcome))).toEqual(['unverifiable-trace-id']);
  });

  it('rejects an absent trace a resolver reports unknown', () => {
    const summary = clippedTraceListSummary();
    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
      { resolveTraceIds: resolverFor([], [ABSENT_TRACE_ID]) },
    );

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-trace-id']);
  });

  it('accepts an absent trace a resolver reports known', () => {
    const summary = clippedTraceListSummary();
    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
      { resolveTraceIds: resolverFor([ABSENT_TRACE_ID], []) },
    );

    expect(outcome.status).toBe('valid');
  });

  it('rejects the authoring placeholder against a real capture, which is correct', () => {
    // AAP 0.1.2's authoring example carries `"..."` as its trace id, and the
    // normaliser passes it through verbatim. A panel that still carries it is
    // one nothing filled in, and this checkpoint is where that is caught.
    const summary = summarize(makeInteraction().events);
    const outcome = validateAgainstCapture(makeSpec({ layout: [timelineNode('...')] }), summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-trace-id']);
  });
});

/**
 * A summary whose published trace list was clipped, so an absent trace cannot be
 * refuted from the summary alone.
 *
 * Built by overriding a computed summary's `traceCount`, which is exactly the
 * state a capture with more traces than the published bound is in.
 */
function clippedTraceListSummary(): CaptureSummary {
  const summary = summarize(makeInteraction().events);

  return { ...summary, traceCount: summary.traceIds.length + 4 };
}

/*
 * ---------------------------------------------------------------------------
 * Metrics
 * ---------------------------------------------------------------------------
 */

describe('metric availability', () => {
  it('does not fail a panel for a metric the capture could not measure', () => {
    const summary = summarize(makeInteraction().events);

    expect(summary.unavailableMetrics).toContain(UNOBSERVABLE_METRIC);

    const spec = makeSpec({ layout: [metricCardsNode([UNOBSERVABLE_METRIC, OBSERVABLE_METRIC])] });
    const outcome = validateAgainstCapture(spec, summary);
    const sets = collectSemanticIssues(spec, summary);

    expect(outcome.status).toBe('valid');
    expect(reasonsOf(sets.informational)).toEqual(['unavailable-metric']);
    expect(sets.informational[0]?.path).toEqual(['layout', 0, 'metrics', 0]);
    expect(sets.issues).toEqual([]);
  });

  it('does not fail an unavailable metric even under requireVerifiable', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ layout: [metricCardsNode([UNOBSERVABLE_METRIC])] });

    expect(validateAgainstCapture(spec, summary, { requireVerifiable: true }).status).toBe('valid');
  });

  it('rejects a metric id the capture cannot serve', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ layout: [metricCardsNode(['not_a_metric'])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['absent-metric']);
    expect(issuesOf(outcome)[0]?.path).toEqual(['layout', 0, 'metrics', 0]);
  });

  it('rejects a published id a summary omitted from its metric set', () => {
    const summary = summarize(makeInteraction().events);
    const withoutOne: CaptureSummary = {
      ...summary,
      metrics: summary.metrics.filter((metric) => metric.id !== OBSERVABLE_METRIC),
    };
    const spec = makeSpec({ layout: [metricCardsNode([OBSERVABLE_METRIC])] });

    expect(validateAgainstCapture(spec, withoutOne).status).toBe('invalid');
  });

  it('skips the presence check entirely when a summary publishes no metric list', () => {
    const summary = summarize(makeInteraction().events);
    const withoutMetrics = { ...summary, metrics: undefined } as unknown as CaptureSummary;
    const spec = makeSpec({ layout: [metricCardsNode([...METRIC_IDS])] });

    expect(validateAgainstCapture(spec, withoutMetrics).status).toBe('valid');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Node evidence availability
 * ---------------------------------------------------------------------------
 */

describe('node evidence availability', () => {
  it('accepts a node whose kinds the capture recorded', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ layout: [renderTableNode()] });

    expect(collectSemanticIssues(spec, summary).advisory).toEqual([]);
  });

  it('reports a node the capture has no evidence for, without failing the panel', () => {
    const summary = summarize([makeEvent({ kind: INTERACTION_KIND })]);
    const spec = makeSpec({ layout: [renderTableNode()] });

    const sets = collectSemanticIssues(spec, summary);

    expect(reasonsOf(sets.advisory)).toEqual(['unavailable-source']);
    expect(sets.advisory[0]?.path).toEqual(['layout', 0, 'query', 'source']);
    expect(sets.advisory[0]?.nodeType).toBe('renderTable');
    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
  });

  it('escalates an unavailable source only under requireVerifiable', () => {
    const summary = summarize([makeEvent({ kind: INTERACTION_KIND })]);
    const spec = makeSpec({ layout: [renderTableNode()] });

    const outcome = validateAgainstCapture(spec, summary, { requireVerifiable: true });

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unavailable-source']);
  });

  it('reports a filter that narrows a populated source to nothing', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      layout: [
        {
          type: 'eventLog',
          id: 'layout.0',
          query: { source: 'events', filter: { kinds: ['error'] } },
        },
      ],
    });

    const sets = collectSemanticIssues(spec, summary);

    expect(reasonsOf(sets.advisory)).toEqual(['unavailable-source']);
    expect(sets.advisory[0]?.path).toEqual(['layout', 0, 'query', 'filter', 'kinds']);
  });

  it('says nothing about a container or a source link, which read no telemetry', () => {
    const summary = summarize([]);
    const spec = makeSpec({
      layout: [
        {
          type: 'section',
          id: 'layout.0',
          title: 'Fixture section',
          children: [
            {
              type: 'sourceLink',
              id: 'layout.0.children.0',
              location: {
                file: 'src/fixture/module.ts',
                line: 1,
                column: 1,
                resolvedBy: 'patch',
                confidence: 1,
              },
            },
          ],
        },
      ],
    });

    const sets = collectSemanticIssues(spec, summary);

    expect(sets.advisory).toEqual([]);
    expect(sets.issues).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Strictness, determinism and robustness
 * ---------------------------------------------------------------------------
 */

describe('strictness and composition', () => {
  it('escalates an unverifiable reference under requireVerifiable', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    expect(validateAgainstCapture(spec, summary).status).toBe('unverifiable');

    const strict = validateAgainstCapture(spec, summary, { requireVerifiable: true });

    expect(strict.status).toBe('invalid');
    expect(reasonsOf(issuesOf(strict))).toEqual(['unverifiable-event-id']);
    expect(reasonsOf(unverifiableOf(strict))).toEqual(['unverifiable-event-id']);
  });

  it('works when called with two arguments', () => {
    const interaction = makeInteraction();
    const outcome: SemanticValidationOutcome = validateAgainstCapture(
      makeSpec({ observed: [fact([ref(interaction.slowestSpan.id)])] }),
      summarize(interaction.events),
    );

    expect(outcome.status).toBe('valid');
  });

  it('accepts an empty observed list by default and rejects it on request', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [timelineNode(interaction.traceId)] });

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');

    const strict = validateAgainstCapture(spec, summary, { allowEmptyObserved: false });

    expect(strict.status).toBe('invalid');
    expect(reasonsOf(issuesOf(strict))).toEqual(['empty-observed']);
    expect(issuesOf(strict)[0]?.path).toEqual(['summary', 'observed']);
  });

  it('exempts a fallback panel from the empty-observed requirement', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [timelineNode(interaction.traceId)], fallback: true });

    expect(validateAgainstCapture(spec, summary, { allowEmptyObserved: false }).status).toBe(
      'valid',
    );
  });

  it('sorts every issue array deterministically, by path', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)]), fact([])],
      likelyCauses: [hypothesis([ref(ABSENT_EVENT_ID)])],
      layout: [timelineNode(ABSENT_TRACE_ID, 'layout.0'), renderTableNode('layout.1')],
    });

    const first = collectSemanticIssues(spec, summary);
    const second = collectSemanticIssues(spec, summary);

    expect(first).toEqual(second);
    expect(first.issues.map((issue) => issue.path)).toEqual([
      ['layout', 0, 'query', 'filter', 'traceId'],
      ['summary', 'observed', 1, 'evidence'],
    ]);
    expect(first.unverifiable.map((issue) => issue.path)).toEqual([
      ['summary', 'likelyCauses', 0, 'evidence', 0, 'eventId'],
      ['summary', 'observed', 0, 'evidence', 0, 'eventId'],
    ]);
  });

  it('treats a resolver that throws as one that declined to answer', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: () => {
        throw new Error('resolver failure');
      },
    });

    expect(outcome.status).toBe('unverifiable');
  });

  it('treats a resolver answering with the wrong shape as one that declined', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: (() => ({ known: 'everything' })) as unknown as (
        ids: readonly string[],
      ) => IdResolution,
    });

    expect(outcome.status).toBe('unverifiable');
  });

  it('treats a resolver that contradicts itself as undecided', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([ABSENT_EVENT_ID], [ABSENT_EVENT_ID]),
    });

    expect(outcome.status).toBe('unverifiable');
  });

  it('never throws on a specification or a summary that was asserted rather than parsed', () => {
    const summary = summarize(makeInteraction().events);
    const malformed = {
      version: 1,
      id: PANEL_ID,
      sessionId: SESSION_ID,
      panelVersion: 1,
      title: 'Fixture panel',
      summary: 'not an object',
      layout: 'not an array',
    } as unknown as PanelSpec;

    expect(() => validateAgainstCapture(malformed, summary)).not.toThrow();
    expect(validateAgainstCapture(malformed, summary).status).toBe('valid');
    expect(() => validateAgainstCapture(makeSpec(), {} as unknown as CaptureSummary)).not.toThrow();
    expect(() =>
      collectSemanticIssues({} as unknown as PanelSpec, {} as unknown as CaptureSummary),
    ).not.toThrow();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The Result mapping
 * ---------------------------------------------------------------------------
 */

describe('toResult', () => {
  it('returns the specification for a valid outcome', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ observed: [fact([ref(interaction.slowestSpan.id)])] });
    const result = toResult(validateAgainstCapture(spec, summary), spec);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : undefined).toBe(spec);
  });

  it('accepts an unverifiable outcome by default and rejects it on request', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });
    const outcome = validateAgainstCapture(spec, summary);

    expect(toResult(outcome, spec).ok).toBe(true);

    const rejected = toResult(outcome, spec, { requireVerifiable: true });

    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? undefined : rejected.error).toBeInstanceOf(DebuggenError);
    expect(rejected.ok ? undefined : rejected.error.code).toBe('PANEL_SEMANTIC_INVALID');
  });

  it('rejects an invalid outcome with every issue in the error details', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)]), fact([])] });
    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([], [ABSENT_EVENT_ID]),
    });
    const result = toResult(outcome, spec);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    const { error } = result;

    expect(error.code).toBe('PANEL_SEMANTIC_INVALID');
    expect(error.details?.check).toBe('semantic');
    expect(error.details?.issueCount).toBe(issuesOf(outcome).length);
    expect(error.message).toContain('summary.observed.0.evidence.0.eventId');
    expect(error.hint).toContain(String(METRIC_IDS.length));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------
 */

describe('privacy', () => {
  it('never carries a rejected value into an issue, a message, a hint or details', () => {
    const sentinels = [
      'SENTINEL-PANEL-TITLE',
      'SENTINEL-NODE-TITLE',
      'SENTINEL-STATEMENT',
      'SENTINEL-EVENT-ID',
      'SENTINEL-TRACE-ID',
      'SENTINEL-LABEL',
      'SENTINEL-METRIC',
    ];

    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({
      title: 'SENTINEL-PANEL-TITLE',
      observed: [
        fact(
          [ref('SENTINEL-EVENT-ID', { traceId: 'SENTINEL-TRACE-ID', label: 'SENTINEL-LABEL' })],
          'SENTINEL-STATEMENT',
        ),
      ],
      layout: [
        {
          type: 'timeline',
          id: 'layout.0',
          title: 'SENTINEL-NODE-TITLE',
          query: { source: 'trace', filter: { traceId: 'SENTINEL-TRACE-ID' } },
        },
        metricCardsNode(['SENTINEL-METRIC'], 'layout.1'),
      ],
    });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: resolverFor([], ['SENTINEL-EVENT-ID']),
    });
    const result = toResult(outcome, spec);
    const reported = JSON.stringify({
      issues: issuesOf(outcome),
      unverifiable: unverifiableOf(outcome),
      error: result.ok
        ? null
        : {
            message: result.error.message,
            hint: result.error.hint,
            details: result.error.details,
            payload: result.error.toPayload(),
          },
    });

    expect(outcome.status).toBe('invalid');
    expect(issuesOf(outcome).length).toBeGreaterThan(0);

    for (const sentinel of sentinels) {
      expect(reported).not.toContain(sentinel);
    }
  });
});
