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
 * clipped trace list, a metric set with a value removed — are made by
 * `makeCaptureSummary` overriding one published field of a computed summary,
 * which stays type-checked against the declared interface.
 *
 * ## The syntactic validator runs first
 *
 * This module is the *second* checkpoint, so the first suite below holds every
 * builder to `./validate.ts`: a fixture that would not pass it would make each
 * assertion afterwards ambiguous, because a rejection could be the semantic rule
 * firing or the document merely being malformed. The three cases that
 * deliberately carry values the schema rejects say so where they stand.
 *
 * ## Privacy, asserted rather than assumed
 *
 * The last two tests place sentinel strings in every value a panel carries
 * (title, node title, statements, event ids, trace ids, citation labels, a
 * filter's component, a suggested location's file, a metric id) **and one that
 * originates in the capture** — a summarised span's name — then assert that
 * none of them reaches an issue, a rendered error message, a hint, an error's
 * details or the wire payload, while the issues still carry a usable path, a
 * code and a closed reason. This is the discipline
 * `packages/shared/src/source-location.test.ts` and
 * `packages/telemetry/src/schema/event.test.ts` apply to their own reports
 * (AAP 0.5.2).
 *
 * No identifier below names a component, route or symbol of any application:
 * the fixtures use deliberately generic names, because `scripts/check-no-hardcoding.mjs`
 * scans this package and because a test that knew an application would be
 * evidence of the coupling AAP 0.5.4 forbids.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEBUGGEN_ERROR_CODES, DebuggenError, isErr, isOk } from '@debuggen/shared';
import {
  ERROR_KINDS,
  METRIC_IDS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  STATE_KINDS,
  allowedTiersFor,
  computeCaptureSummary,
  isMetricId,
  type CaptureSummary,
  type ErrorSummary,
  type MetricValue,
  type QueryGroup,
  type RenderStat,
  type RequestGroup,
  type SpanSummary,
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
  type SemanticIssueSets,
  type SemanticValidationOutcome,
} from './semantic.js';
import type { PanelNode, PanelNodeType, PanelSpec } from './spec.js';
import type { EventRef, Fact, Hypothesis } from './summary.js';
import { validatePanelSpec } from './validate.js';

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

/**
 * A second absent event id, for the case where a resolver answers about some
 * ids and not others.
 *
 * `IdResolution` is a partition report rather than a predicate precisely so a
 * resolver can decline on part of its input, and an id in neither half is a
 * third answer that must stay undecided.
 */
const UNDECIDED_EVENT_ID = 'evt_eeeeeeeeeeeeeeee';

/** A span id the capture does not hold. */
const ABSENT_SPAN_ID = 'ffffffffffffffff';

/**
 * The trace id AAP 0.1.2's authoring example carries, verbatim.
 *
 * Not a trace id at all: the example writes `"..."` because a trace id cannot
 * be known while a panel is being authored, `./input.ts` accepts it and the
 * normaliser passes it through. It reaches this module unchanged whenever the
 * panel-generation stage failed to substitute the capture's own trace.
 */
const AUTHORING_PLACEHOLDER_TRACE_ID = '...';

/**
 * The first kind of one of the telemetry package's own kind groups.
 *
 * Every kind a fixture below produces for a *group-backed* node type is taken
 * from the group the catalog entry itself declares, never written out here:
 * `packages/telemetry/src/schema/kinds.ts` is the single definition of the kind
 * vocabulary and states that no other module may hard-code a list of kind
 * strings. A kind renamed there therefore moves these fixtures with it, and a
 * group whose membership changes changes what these tests build — which is the
 * behaviour the catalog's own `telemetryKinds` has.
 */
function firstKind(group: readonly TelemetryKind[]): TelemetryKind {
  const [kind] = group;

  if (kind === undefined) {
    throw new Error('a telemetry kind group must name at least one kind');
  }

  return kind;
}

/**
 * The two kinds the fixtures need that no exported group names.
 *
 * `interaction` and `http.server` head no group in `kinds.ts` — the groups
 * exist for the node types that read them — so each is a single typed value
 * rather than a copied list, and the compiler checks the spelling against
 * {@link TelemetryKind}.
 */
const INTERACTION_KIND: TelemetryKind = 'interaction';

/** See {@link INTERACTION_KIND}. */
const SERVER_KIND: TelemetryKind = 'http.server';

/** The kind a `renderTable` node reads, from the catalog's own group. */
const RENDER_KIND: TelemetryKind = firstKind(RENDER_KINDS);

/** The kind a `requestTable` node reads, from the catalog's own group. */
const FETCH_KIND: TelemetryKind = firstKind(REQUEST_KINDS);

/** The kind a `queryTable` node reads, from the catalog's own group. */
const QUERY_KIND: TelemetryKind = firstKind(QUERY_KINDS);

/** The status a well-formed fixture event reports. */
const OK_STATUS: TelemetryStatus = 'ok';

/** The metric that is genuinely unobservable without resource timing. */
const UNOBSERVABLE_METRIC = 'transferred_bytes';

/** A metric every capture can measure. */
const OBSERVABLE_METRIC = 'render_count';

/**
 * A metric id the vocabulary does not hold, asserted rather than assumed.
 *
 * Spelled in the vocabulary's own style so the rejection is about membership
 * rather than about the shape of the string; `isMetricId` is what proves it is
 * outside the set, in the fixture setup above.
 */
const UNRECOGNISED_METRIC = 'unrecognised_metric';

/*
 * ---------------------------------------------------------------------------
 * Privacy sentinels
 *
 * One distinctive string per value a specification — or the capture behind it —
 * can carry into this module, so the leak assertion can search for each by
 * name. Deliberately generic: none names a component, a route, a symbol or a
 * file of any application, because a test that knew an application would be
 * evidence of the coupling AAP 0.5.4 forbids and `scripts/check-no-hardcoding.mjs`
 * scans this file.
 * ---------------------------------------------------------------------------
 */

/** The specification's own title. */
const SENTINEL_PANEL_TITLE = 'SENTINEL-PANEL-TITLE';

/** A node's title. */
const SENTINEL_NODE_TITLE = 'SENTINEL-NODE-TITLE';

/** An observed fact's statement. */
const SENTINEL_STATEMENT = 'SENTINEL-STATEMENT';

/** A likely cause's statement. */
const SENTINEL_HYPOTHESIS_STATEMENT = 'SENTINEL-HYPOTHESIS-STATEMENT';

/** A citation's event id, the value a refutation is *about*. */
const SENTINEL_EVENT_ID = 'SENTINEL-EVENT-ID';

/** A citation's and a filter's trace id. */
const SENTINEL_TRACE_ID = 'SENTINEL-TRACE-ID';

/** A citation's display label. */
const SENTINEL_LABEL = 'SENTINEL-LABEL';

/** A metric-tile row's requested id. */
const SENTINEL_METRIC = 'SENTINEL-METRIC';

/** A filter's component name, which is a captured display name. */
const SENTINEL_COMPONENT = 'SENTINEL-COMPONENT';

/** A suggested location's file, a project-relative POSIX path. */
const SENTINEL_FILE = 'src/sentinel-location-file.ts';

/**
 * A summarised span's name — a value from the **capture** rather than from the
 * panel, so that the summary is covered as a second possible source of a leak.
 */
const SENTINEL_SPAN_NAME = 'SENTINEL-SPAN-NAME';

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
  /**
   * The span name, which a summary republishes verbatim in `topSpans` and
   * `errors`.
   *
   * Overridable for one reason only: the privacy case needs a value that
   * originates in the **capture** rather than in the panel, so that "nothing
   * from the summary reaches an issue either" can be asserted rather than
   * assumed.
   */
  readonly name?: string;
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
    name: overrides.name ?? `fixture span ${String(ordinal)}`,
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

/**
 * What a capture fixture may replace.
 *
 * The first two fields describe a **real** capture — the events it holds and
 * how many rows each bounded section publishes — and are how nearly every case
 * below gets its summary: a computed rollup cannot encode this suite's beliefs
 * about which section carries which event id.
 *
 * The rest replace one published field of that computed object, for the three
 * shapes a real capture cannot easily be coaxed into: a trace list the capture
 * clipped (`traceCount` above the published length), a metric set with a value
 * removed, and a section emptied independently of the events. Each is typed as
 * the telemetry package's own declared field type, so a fixture that could not
 * exist does not compile.
 */
interface CaptureOverrides {
  /** The events the capture holds. Defaults to none, i.e. an empty capture. */
  readonly events?: readonly TelemetryEvent[];
  /** Rows per bounded section, and occurrence samples per group. */
  readonly topN?: number;
  /** How many traces the capture holds, whatever `traceIds` publishes. */
  readonly traceCount?: number;
  /** Whether the summary reports that something it published was clipped. */
  readonly truncated?: boolean;
  /** The published metric values. */
  readonly metrics?: readonly MetricValue[];
  /** The slowest spans. */
  readonly topSpans?: readonly SpanSummary[];
  /** The busiest components. */
  readonly topRenders?: readonly RenderStat[];
  /** The request groups. */
  readonly topRequests?: readonly RequestGroup[];
  /** The query groups. */
  readonly topQueries?: readonly QueryGroup[];
  /** The failures. */
  readonly errors?: readonly ErrorSummary[];
}

/**
 * A capture summary, computed by the telemetry package and then narrowed to the
 * shape a case needs.
 *
 * Each replacement is attached only when the case asked for it, because the
 * package compiles under `exactOptionalPropertyTypes`: an absent override must
 * leave the computed field in place rather than overwrite it with `undefined`.
 *
 * @param overrides The capture to build; see {@link CaptureOverrides}.
 * @returns A summary satisfying the telemetry package's declared interface.
 */
function makeCaptureSummary(overrides: CaptureOverrides = {}): CaptureSummary {
  const computed = computeCaptureSummary(
    overrides.events ?? [],
    captureContext(),
    overrides.topN === undefined ? undefined : { topN: overrides.topN },
  );

  return {
    ...computed,
    ...(overrides.traceCount === undefined ? {} : { traceCount: overrides.traceCount }),
    ...(overrides.truncated === undefined ? {} : { truncated: overrides.truncated }),
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
    ...(overrides.topSpans === undefined ? {} : { topSpans: overrides.topSpans }),
    ...(overrides.topRenders === undefined ? {} : { topRenders: overrides.topRenders }),
    ...(overrides.topRequests === undefined ? {} : { topRequests: overrides.topRequests }),
    ...(overrides.topQueries === undefined ? {} : { topQueries: overrides.topQueries }),
    ...(overrides.errors === undefined ? {} : { errors: overrides.errors }),
  };
}

/**
 * Summarises events exactly as the service does, optionally bounded.
 *
 * The shorthand the cases below read best with; {@link makeCaptureSummary} is
 * what they reach for when a published field has to be narrowed as well.
 */
function summarize(events: readonly TelemetryEvent[], topN?: number): CaptureSummary {
  return makeCaptureSummary(topN === undefined ? { events } : { events, topN });
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

/**
 * The metric-tile node, narrowed out of the node union `./spec.ts` declares.
 *
 * Derived from `PanelNode` rather than imported from the node-type module, so
 * this suite depends on the same public shape the validators and the renderer's
 * registry do, and on no module below it.
 */
type MetricCardsPanelNode = Extract<PanelNode, { readonly type: 'metricCards' }>;

/** A metric-tile node asking for the given ids. */
function metricCardsNode(metrics: readonly string[], id = 'layout.0'): PanelNode {
  return {
    type: 'metricCards',
    id,
    query: { source: 'metrics' },
    // A case that deliberately asks for an unrecognised id passes a string the
    // node schema would reject, which is exactly the value this module must
    // refuse without reading it back out of the panel.
    metrics: [...metrics] as MetricCardsPanelNode['metrics'],
  };
}

/** A render table, which needs render-kind evidence to draw anything. */
function renderTableNode(id = 'layout.0'): PanelNode {
  return { type: 'renderTable', id, query: { source: 'renders' } };
}

/**
 * One node per kind group the catalog declares, so the availability rule can be
 * exercised across all four rather than at one node type.
 *
 * The pairing is the catalog's own: a `renderTable` reads `RENDER_KINDS`, a
 * `requestTable` reads `REQUEST_KINDS`, a `queryTable` reads `QUERY_KINDS` and a
 * `stateTransitions` reads `STATE_KINDS`. Each entry carries the group it needs
 * rather than a kind list of this suite's own, so the fixtures follow the
 * telemetry package's vocabulary.
 */
const KIND_BACKED_NODES: readonly {
  readonly type: PanelNodeType;
  readonly node: PanelNode;
  readonly kinds: readonly TelemetryKind[];
}[] = Object.freeze([
  {
    type: 'renderTable',
    node: renderTableNode(),
    kinds: RENDER_KINDS,
  },
  {
    type: 'requestTable',
    node: { type: 'requestTable', id: 'layout.0', query: { source: 'requests' } },
    kinds: REQUEST_KINDS,
  },
  {
    type: 'queryTable',
    node: { type: 'queryTable', id: 'layout.0', query: { source: 'queries' } },
    kinds: QUERY_KINDS,
  },
  {
    type: 'stateTransitions',
    node: { type: 'stateTransitions', id: 'layout.0', query: { source: 'stateTransitions' } },
    kinds: STATE_KINDS,
  },
]);

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
function makeResolver(known: readonly string[], unknown: readonly string[]): () => IdResolution {
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

/** Every dotted path an issue array reports, for order-sensitive assertions. */
function pathsOf(issues: readonly SemanticIssue[]): readonly string[] {
  return issues.map((issue) => issue.path.join('.'));
}

/** Whether all four partitions of a collection are empty. */
function isSilent(sets: SemanticIssueSets): boolean {
  return (
    sets.issues.length === 0 &&
    sets.unverifiable.length === 0 &&
    sets.advisory.length === 0 &&
    sets.informational.length === 0
  );
}

/**
 * A deep copy through JSON, which is how a stored panel and a broadcast summary
 * actually travel.
 *
 * `structuredClone` is deliberately not used: this package's `tsconfig.json`
 * declares no ambient type set at all, so neither the Node nor the DOM global
 * exists here — and the two objects being copied are documented to be
 * JSON-safe, the summary explicitly so ("no `Map`, no `Set`, no class instance
 * and no cycle").
 */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/*
 * ---------------------------------------------------------------------------
 * The fixtures themselves
 *
 * This module is the *second* checkpoint: it is handed documents that already
 * passed `./validate.ts`. A fixture that would not pass it would make every
 * assertion below ambiguous — a rejection could be the semantic rule firing or
 * the specification being malformed — so the builders are held to the syntactic
 * validator first, here, once.
 *
 * Three cases below deliberately carry values the schema rejects (an
 * unrecognised metric id, a placeholder trace id, the privacy sentinels), and
 * each says so where it stands: those are exactly the values this module must
 * refuse *without reading them back out*, and the module documents that it
 * accepts a specification asserted rather than parsed.
 * ---------------------------------------------------------------------------
 */

describe('the fixture builders', () => {
  it('builds specifications the syntactic validator already accepts', () => {
    const interaction = makeInteraction();
    const spec = makeSpec({
      observed: [
        fact([
          ref(interaction.slowestSpan.id, {
            traceId: interaction.traceId,
            spanId: interaction.slowestSpan.spanId,
            kind: SERVER_KIND,
            label: 'Fixture evidence chip',
          }),
        ]),
      ],
      likelyCauses: [hypothesis([ref(interaction.query.id)])],
      layout: [
        timelineNode(interaction.traceId, 'layout.0'),
        metricCardsNode([OBSERVABLE_METRIC, UNOBSERVABLE_METRIC], 'layout.1'),
        renderTableNode('layout.2'),
      ],
    });

    expect(isOk(validatePanelSpec(spec))).toBe(true);
  });

  it('builds a valid single-node specification for every kind-backed node type', () => {
    for (const entry of KIND_BACKED_NODES) {
      const result = validatePanelSpec(makeSpec({ layout: [entry.node] }));

      expect(isOk(result), entry.type).toBe(true);
    }
  });

  it('builds a valid fallback specification', () => {
    expect(isOk(validatePanelSpec(makeSpec({ fallback: true })))).toBe(true);
  });

  it('summarises an empty capture without throwing, which AAP 0.5.5 relies on', () => {
    // The "capture yielded nothing" flow reaches this module with exactly this
    // object, so it is a fixture rather than an edge case.
    const empty = makeCaptureSummary();

    expect(empty.eventCount).toBe(0);
    expect(empty.traceCount).toBe(0);
    expect(empty.traceIds).toEqual([]);
    expect(empty.primaryTraceId).toBeUndefined();
    expect(empty.metrics).toHaveLength(METRIC_IDS.length);
    expect(empty.topSpans).toEqual([]);
    expect(() => collectSemanticIssues(makeSpec(), empty)).not.toThrow();
  });

  it('controls the bounded sections and the truncation flag it reports', () => {
    const interaction = makeInteraction();
    const whole = makeCaptureSummary({ events: interaction.events });
    const bounded = makeCaptureSummary({ events: interaction.events, topN: 1 });

    expect(whole.truncated).toBe(false);
    expect(whole.topSpans.length).toBeGreaterThan(1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.topSpans).toHaveLength(1);

    // A section replaced independently of the events: the shape a capture with
    // more traces than the published bound is in, and the only way to reach the
    // "could not be checked" branch of a trace filter.
    const clipped = makeCaptureSummary({
      events: interaction.events,
      traceCount: whole.traceIds.length + 4,
      truncated: true,
    });

    expect(clipped.traceIds).toEqual(whole.traceIds);
    expect(clipped.traceCount).toBeGreaterThan(clipped.traceIds.length);
    expect(makeCaptureSummary({ events: interaction.events, topSpans: [] }).topSpans).toEqual([]);
  });

  it('names only metric ids the telemetry vocabulary holds', () => {
    expect(isMetricId(UNOBSERVABLE_METRIC)).toBe(true);
    expect(isMetricId(OBSERVABLE_METRIC)).toBe(true);
    expect(isMetricId(UNRECOGNISED_METRIC)).toBe(false);
  });
});

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

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('valid');
    // A valid outcome carries no arrays at all, so "nothing was found" is
    // asserted through the collection the outcome is composed from.
    expect(isSilent(collectSemanticIssues(spec, summary))).toBe(true);
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
    /*
     * The least obvious behaviour in the package, and the one most likely to be
     * "simplified" into a boolean later. Both alternatives are wrong, and wrong
     * silently:
     *
     * - answering `valid` would be a FALSE PASS. A `CaptureSummary` is a
     *   bounded rollup — top-N sections, counts, the primary trace — and never
     *   an index of every event id, so "the summary does not name it" is not
     *   evidence that the capture does not hold it. Treating absence as
     *   confirmation would let a fabricated citation reach the screen as
     *   substantiated analysis, which is the one failure this checkpoint exists
     *   to prevent (AAP 0.2.3, 0.8.4).
     * - answering `invalid` would be a FALSE FAILURE, and an expensive one: a
     *   rejection here sends the service to the deterministic fallback panel
     *   (AAP 0.5.5), so every genuine panel whose facts cite a mid-ranked span
     *   — most of them — would have its real answer replaced by a summary.
     *
     * `unverifiable` is the only honest third answer: everything checkable
     * passed, and these references could not be checked. A caller that needs
     * certainty supplies `resolveEventIds`, which the next two cases do.
     */
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('unverifiable');
    expect(outcome.status).not.toBe('valid');
    expect(outcome.status).not.toBe('invalid');
    expect(reasonsOf(unverifiableOf(outcome))).toEqual(['unverifiable-event-id']);
    expect(unverifiableOf(outcome)[0]?.path).toEqual([
      'summary',
      'observed',
      0,
      'evidence',
      0,
      'eventId',
    ]);
    expect(unverifiableOf(outcome)[0]?.code).toBe(
      SEMANTIC_ISSUE_CODE_BY_REASON['unverifiable-event-id'],
    );
    // Nothing was refuted: the collection's fatal partition is empty, and it is
    // the unverifiable partition alone that produced this status.
    expect(collectSemanticIssues(spec, summary).issues).toEqual([]);
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
      resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
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
      resolveEventIds: makeResolver([ABSENT_EVENT_ID], []),
    });

    expect(outcome.status).toBe('valid');
  });

  it('asks a resolver once, with every distinct cited id', () => {
    // The service backs this callback with a single `telemetry_events` query, so
    // one call per citation would be a real performance defect rather than an
    // implementation detail — a panel citing fifty events would become fifty
    // round trips. The module's own documentation promises one call; this is the
    // assertion that holds it to the promise, including the de-duplication that
    // makes the promise worth anything.
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const resolveEventIds = vi.fn<(ids: readonly string[]) => IdResolution>((ids) => ({
      known: new Set(ids),
      unknown: new Set<string>(),
    }));
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID), ref(ABSENT_EVENT_ID)])],
      likelyCauses: [hypothesis([ref(interaction.slowestSpan.id)])],
    });

    validateAgainstCapture(spec, summary, { resolveEventIds });

    expect(resolveEventIds).toHaveBeenCalledTimes(1);
    expect(resolveEventIds).toHaveBeenCalledWith([ABSENT_EVENT_ID, interaction.slowestSpan.id]);
  });

  it('asks the trace resolver once, with the filters and the citations together', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const resolveTraceIds = vi.fn<(ids: readonly string[]) => IdResolution>((ids) => ({
      known: new Set(ids),
      unknown: new Set<string>(),
    }));
    const spec = makeSpec({
      observed: [fact([ref(interaction.slowestSpan.id, { traceId: interaction.traceId })])],
      layout: [timelineNode(ABSENT_TRACE_ID)],
    });

    validateAgainstCapture(spec, summary, { resolveTraceIds });

    expect(resolveTraceIds).toHaveBeenCalledTimes(1);
    expect(resolveTraceIds).toHaveBeenCalledWith([interaction.traceId, ABSENT_TRACE_ID]);
  });

  it('reports a refutation and an undecided reference from one pass, and rejects', () => {
    // Three citations, three fates: one the summary attests to, one the resolver
    // refutes, one the resolver simply did not speak for. The strictest
    // applicable outcome wins — a refutation is present, so the panel is
    // invalid — and the undecided reference is still reported in its own array
    // rather than folded into the rejection, because the caller's two follow-up
    // actions differ: fall back now, and supply a fuller resolver next time.
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      observed: [fact([ref(interaction.slowestSpan.id)]), fact([ref(ABSENT_EVENT_ID)])],
      likelyCauses: [hypothesis([ref(UNDECIDED_EVENT_ID)])],
    });

    const resolveEventIds = vi.fn<(ids: readonly string[]) => IdResolution>(() => ({
      known: new Set([interaction.slowestSpan.id]),
      unknown: new Set([ABSENT_EVENT_ID]),
    }));

    const outcome = validateAgainstCapture(spec, summary, { resolveEventIds });

    expect(resolveEventIds).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-event-id']);
    expect(pathsOf(issuesOf(outcome))).toEqual(['summary.observed.1.evidence.0.eventId']);
    expect(reasonsOf(unverifiableOf(outcome))).toEqual(['unverifiable-event-id']);
    expect(pathsOf(unverifiableOf(outcome))).toEqual(['summary.likelyCauses.0.evidence.0.eventId']);
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
      resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
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

    // The trace a generated timeline filters on by default is the capture's own
    // `primaryTraceId`, so the ordinary generated panel is the case asserted
    // here: it contributes nothing to any partition.
    expect(summary.primaryTraceId).toBe(interaction.traceId);
    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
    expect(isSilent(collectSemanticIssues(spec, summary))).toBe(true);
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
    expect(outcome.status).not.toBe('invalid');
    expect(reasonsOf(unverifiableOf(outcome))).toEqual(['unverifiable-trace-id']);
    expect(pathsOf(unverifiableOf(outcome))).toEqual(['layout.0.query.filter.traceId']);
    expect(unverifiableOf(outcome)[0]?.nodeType).toBe('timeline');
    expect(unverifiableOf(outcome)[0]?.code).toBe(
      SEMANTIC_ISSUE_CODE_BY_REASON['unverifiable-trace-id'],
    );
  });

  it('rejects an absent trace a resolver reports unknown', () => {
    const summary = clippedTraceListSummary();
    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
      { resolveTraceIds: makeResolver([], [ABSENT_TRACE_ID]) },
    );

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-trace-id']);
    expect(pathsOf(issuesOf(outcome))).toEqual(['layout.0.query.filter.traceId']);
    expect(issuesOf(outcome)[0]?.nodeType).toBe('timeline');
    expect(issuesOf(outcome)[0]?.code).toBe(SEMANTIC_ISSUE_CODE_BY_REASON['unknown-trace-id']);
  });

  it('accepts an absent trace a resolver reports known', () => {
    const summary = clippedTraceListSummary();
    const outcome = validateAgainstCapture(
      makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }),
      summary,
      { resolveTraceIds: makeResolver([ABSENT_TRACE_ID], []) },
    );

    expect(outcome.status).toBe('valid');
  });

  it('rejects the authoring placeholder against a real capture, which is correct', () => {
    /*
     * This is correct behaviour, not a bug, and it is worth pinning because it
     * looks like one. AAP 0.1.2's authoring example — the very example a model
     * is shown — carries `"..."` in `filter.traceId`, because a trace id cannot
     * be known while a panel is being authored. `./input.ts` deliberately
     * accepts it and the normaliser passes it through verbatim, so a
     * specification normalised straight from the example carries the
     * placeholder into this checkpoint. The panel-generation stage substitutes
     * the capture's `primaryTraceId` before validating; a panel that still
     * carries the placeholder is one nothing filled in, and this is where that
     * is caught rather than rendered as a view scoped to nothing.
     */
    const spec = makeSpec({ layout: [timelineNode(AUTHORING_PLACEHOLDER_TRACE_ID)] });
    const outcome = validateAgainstCapture(spec, summarize(makeInteraction().events));

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unknown-trace-id']);
    expect(pathsOf(issuesOf(outcome))).toEqual(['layout.0.query.filter.traceId']);

    // Against a capture whose trace list was clipped the placeholder cannot be
    // refuted from the summary alone — but it is never accepted either, which
    // is the half of this rule that matters.
    const clipped = validateAgainstCapture(spec, clippedTraceListSummary());

    expect(clipped.status).toBe('unverifiable');
    expect(clipped.status).not.toBe('valid');
    expect(
      validateAgainstCapture(spec, clippedTraceListSummary(), {
        resolveTraceIds: makeResolver([], [AUTHORING_PLACEHOLDER_TRACE_ID]),
      }).status,
    ).toBe('invalid');
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

  it('does not fail any metric the capture reports as unmeasured, not only the usual one', () => {
    // `MetricValue.available` is `false` for `transferred_bytes` in the fixture
    // above because resource timing is genuinely absent (AAP 0.6.6, and the card
    // shows "n/a"). The rule is about the flag rather than about that metric, so
    // the flag is forced here on one every capture normally measures: a panel
    // must not be replaced by a fallback for telling the truth about a
    // limitation, whichever metric the limitation is in.
    const measured = summarize(makeInteraction().events);
    const summary = makeCaptureSummary({
      events: makeInteraction().events,
      metrics: measured.metrics.map((metric) =>
        metric.id === OBSERVABLE_METRIC ? { ...metric, available: false } : metric,
      ),
    });
    const spec = makeSpec({ layout: [metricCardsNode([OBSERVABLE_METRIC])] });
    const sets = collectSemanticIssues(spec, summary);

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
    expect(validateAgainstCapture(spec, summary, { requireVerifiable: true }).status).toBe('valid');
    expect(reasonsOf(sets.informational)).toEqual(['unavailable-metric']);
    expect(sets.informational[0]?.code).toBe(SEMANTIC_ISSUE_CODE_BY_REASON['unavailable-metric']);
    expect(sets.issues).toEqual([]);
    expect(sets.advisory).toEqual([]);
  });

  it('rejects a metric id the capture cannot serve', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ layout: [metricCardsNode([UNRECOGNISED_METRIC])] });

    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['absent-metric']);
    expect(issuesOf(outcome)[0]?.path).toEqual(['layout', 0, 'metrics', 0]);
  });

  it('rejects a published id a summary omitted from its metric set', () => {
    // A member of `METRIC_IDS`, so `./validate.ts` accepts the tile — and still
    // fatal here, which is the severity the module documents for it: a
    // `CaptureSummary` publishes all fourteen values by invariant, so an id
    // missing from the set is a refutation rather than an unknown, and the tile
    // has nothing to render.
    const events = makeInteraction().events;
    const measured = summarize(events);

    expect(isMetricId(OBSERVABLE_METRIC)).toBe(true);

    const summary = makeCaptureSummary({
      events,
      metrics: measured.metrics.filter((metric) => metric.id !== OBSERVABLE_METRIC),
    });
    const spec = makeSpec({ layout: [metricCardsNode([OBSERVABLE_METRIC])] });
    const outcome = validateAgainstCapture(spec, summary);

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['absent-metric']);
    expect(pathsOf(issuesOf(outcome))).toEqual(['layout.0.metrics.0']);
    expect(issuesOf(outcome)[0]?.nodeType).toBe('metricCards');
    expect(issuesOf(outcome)[0]?.code).toBe(SEMANTIC_ISSUE_CODE_BY_REASON['absent-metric']);
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

  it('decides availability from the kind group each node type declares', () => {
    /*
     * The same rule at all four group-backed node types, and the counts are
     * built from the groups the catalog itself declares rather than from a kind
     * list written here: `packages/telemetry/src/schema/kinds.ts` owns the
     * vocabulary, and a suite that copied one would keep passing after a kind
     * was added to a group while the product stopped drawing it.
     *
     * Each pass builds a capture holding exactly one event of the node's own
     * first kind — so its evidence is present — and asserts that every *other*
     * node type, whose groups that kind is not in, reports the advisory
     * instead. That crossing is what proves the decision follows the group and
     * not merely "the capture has some events".
     */
    for (const entry of KIND_BACKED_NODES) {
      const summary = summarize([makeEvent({ kind: firstKind(entry.kinds) })]);
      const populated = collectSemanticIssues(makeSpec({ layout: [entry.node] }), summary);

      expect(populated.advisory, entry.type).toEqual([]);
      expect(populated.issues, entry.type).toEqual([]);

      for (const other of KIND_BACKED_NODES) {
        if (other.kinds.some((kind) => entry.kinds.includes(kind))) {
          continue;
        }

        const sets = collectSemanticIssues(makeSpec({ layout: [other.node] }), summary);

        expect(reasonsOf(sets.advisory), `${entry.type} -> ${other.type}`).toEqual([
          'unavailable-source',
        ]);
        expect(sets.advisory[0]?.nodeType, `${entry.type} -> ${other.type}`).toBe(other.type);
        // Advisory only: the node renders its own empty state, and the panel is
        // still an answer (AAP 0.6.2).
        expect(sets.issues, `${entry.type} -> ${other.type}`).toEqual([]);
      }
    }
  });

  it('reports a filter that narrows a populated source to nothing', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    // The failure kinds, imported: the fixture interaction succeeds, so an event
    // log narrowed to them renders empty however much the source holds.
    const spec = makeSpec({
      layout: [
        {
          type: 'eventLog',
          id: 'layout.0',
          query: { source: 'events', filter: { kinds: [...ERROR_KINDS] } },
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
    // Escalation reports the reference in *both* arrays: `issues` is what
    // rejected the panel, and `unverifiable` still says why it could not be
    // decided.
    expect(reasonsOf(unverifiableOf(strict))).toEqual(['unverifiable-event-id']);

    // The production default, stated explicitly rather than only by omission:
    // an undecided reference is a limit of the bounded summary, not a defect in
    // the panel, so `false` must behave exactly as an absent option does.
    expect(validateAgainstCapture(spec, summary, { requireVerifiable: false }).status).toBe(
      'unverifiable',
    );
    expect(validateAgainstCapture(spec, summary, {}).status).toBe('unverifiable');
  });

  it('reports through the collection exactly what the outcome reports', () => {
    // `validateAgainstCapture` composes `collectSemanticIssues`, and a caller
    // that wants every problem at once — or the advisory and informational
    // notes an outcome deliberately does not carry — reads the collection
    // instead. The two must never disagree about the same document.
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)]), fact([ref(UNDECIDED_EVENT_ID)])],
      likelyCauses: [hypothesis([ref(interaction.slowestSpan.id)])],
      layout: [
        timelineNode(interaction.traceId, 'layout.0'),
        metricCardsNode([UNOBSERVABLE_METRIC], 'layout.1'),
        renderTableNode('layout.2'),
      ],
    });
    const options = { resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]) };

    const outcome = validateAgainstCapture(spec, summary, options);
    const sets = collectSemanticIssues(spec, summary, options);

    expect(outcome.status).toBe('invalid');
    expect(issuesOf(outcome)).toEqual(sets.issues);
    expect(unverifiableOf(outcome)).toEqual(sets.unverifiable);
    // The notes are the collection's alone, and they are still populated for a
    // document that was rejected for an unrelated reason.
    expect(reasonsOf(sets.informational)).toEqual(['unavailable-metric']);

    const relaxed = makeSpec({ observed: [fact([ref(interaction.slowestSpan.id)])] });
    const relaxedOutcome = validateAgainstCapture(relaxed, summary);

    expect(relaxedOutcome.status).toBe('valid');
    expect(collectSemanticIssues(relaxed, summary).issues).toEqual(issuesOf(relaxedOutcome));
  });

  it('escalates the advisory and unverifiable severities together, and never the informational', () => {
    // The whole escalation rule in one document: an undecided citation, a node
    // with no evidence and a metric the capture could not measure. Two join the
    // refutations under `requireVerifiable`; the third never does, under any
    // option.
    const summary = summarize([makeEvent({ kind: INTERACTION_KIND })]);
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)])],
      layout: [renderTableNode('layout.0'), metricCardsNode([UNOBSERVABLE_METRIC], 'layout.1')],
    });

    const relaxed = validateAgainstCapture(spec, summary);
    const strict = validateAgainstCapture(spec, summary, { requireVerifiable: true });

    expect(relaxed.status).toBe('unverifiable');
    expect(strict.status).toBe('invalid');
    expect([...reasonsOf(issuesOf(strict))].sort()).toEqual([
      'unavailable-source',
      'unverifiable-event-id',
    ]);
    expect(reasonsOf(issuesOf(strict))).not.toContain('unavailable-metric');
    expect(reasonsOf(collectSemanticIssues(spec, summary).informational)).toEqual([
      'unavailable-metric',
    ]);
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
    // Deterministic to the byte, not merely deeply equal: a rejection is logged
    // and may be persisted with the session, so two runs over one document must
    // produce one report.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(validateAgainstCapture(spec, summary))).toBe(
      JSON.stringify(validateAgainstCapture(spec, summary)),
    );
  });

  it('decides the same way whichever order the facts were written in', () => {
    /*
     * Two facts failing the same way, swapped. The reports are byte-identical
     * — not because the module sorts the statements, but because an issue
     * carries a *path* and no value: the path indices follow the positions, and
     * the positions are the same two positions. The order the model happened to
     * list its findings in therefore cannot change a verdict.
     */
    const summary = summarize(makeInteraction().events);
    const first = fact([ref(ABSENT_EVENT_ID)], 'The first statement.');
    const second = fact([ref(UNDECIDED_EVENT_ID)], 'The second statement.');

    const forward = collectSemanticIssues(makeSpec({ observed: [first, second] }), summary);
    const reversed = collectSemanticIssues(makeSpec({ observed: [second, first] }), summary);

    expect(forward).toEqual(reversed);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(reasonsOf(forward.unverifiable)).toEqual([
      'unverifiable-event-id',
      'unverifiable-event-id',
    ]);

    // And where the two fail differently, the verdict and the findings are still
    // the same set — only the index each is reported at follows its fact, which
    // is what a path is for.
    const interaction = makeInteraction();
    const populated = summarize(interaction.events);
    const verified = fact([ref(interaction.slowestSpan.id)], 'A cited span the capture holds.');
    const before = validateAgainstCapture(makeSpec({ observed: [verified, first] }), populated);
    const after = validateAgainstCapture(makeSpec({ observed: [first, verified] }), populated);

    expect(after.status).toBe(before.status);
    expect(reasonsOf(unverifiableOf(after))).toEqual(reasonsOf(unverifiableOf(before)));
    expect(pathsOf(unverifiableOf(before))).toEqual(['summary.observed.1.evidence.0.eventId']);
    expect(pathsOf(unverifiableOf(after))).toEqual(['summary.observed.0.evidence.0.eventId']);
  });

  it('mutates neither the specification, nor the capture, nor the options', () => {
    // The caller keeps holding all three afterwards: the service stores the
    // specification it validated, reuses the summary for the fallback panel it
    // may have to build instead, and passes one options object to several
    // validations. A validator that edited any of them would corrupt the
    // fallback path from the failure path.
    const interaction = makeInteraction();
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)]), fact([ref(interaction.slowestSpan.id)])],
      likelyCauses: [hypothesis([ref(UNDECIDED_EVENT_ID)])],
      layout: [
        timelineNode(ABSENT_TRACE_ID, 'layout.0'),
        metricCardsNode([UNOBSERVABLE_METRIC, OBSERVABLE_METRIC], 'layout.1'),
        renderTableNode('layout.2'),
      ],
    });
    const summary = summarize(interaction.events);
    const options = {
      requireVerifiable: false,
      allowEmptyObserved: true,
      resolveEventIds: makeResolver([interaction.slowestSpan.id], [ABSENT_EVENT_ID]),
      resolveTraceIds: makeResolver([], [ABSENT_TRACE_ID]),
    };

    const specBefore = jsonClone(spec);
    const summaryBefore = jsonClone(summary);
    const optionsBefore = { ...options };

    const outcome = validateAgainstCapture(spec, summary, options);

    // A real verdict, so the no-mutation claim is about a code path that ran
    // every check rather than about an early return.
    expect(outcome.status).toBe('invalid');
    expect(jsonClone(spec)).toEqual(specBefore);
    expect(jsonClone(summary)).toEqual(summaryBefore);
    expect(options).toEqual(optionsBefore);

    // And the second call over the untouched inputs answers exactly as the
    // first did.
    expect(JSON.stringify(validateAgainstCapture(spec, summary, options))).toBe(
      JSON.stringify(outcome),
    );
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
      resolveEventIds: makeResolver([ABSENT_EVENT_ID], [ABSENT_EVENT_ID]),
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

    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    // The very specification that was validated, by identity: a valid outcome
    // carries none, which is why `toResult` takes one.
    expect(isOk(result) ? result.value : undefined).toBe(spec);
  });

  it('accepts an unverifiable outcome by default and rejects it on request', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });
    const outcome = validateAgainstCapture(spec, summary);
    const accepted = toResult(outcome, spec);

    expect(isOk(accepted)).toBe(true);
    expect(isOk(toResult(outcome, spec, { requireVerifiable: false }))).toBe(true);

    const rejected = toResult(outcome, spec, { requireVerifiable: true });

    expect(isErr(rejected)).toBe(true);

    if (isOk(rejected)) {
      throw new Error('an escalated unverifiable outcome must map to an error');
    }

    expect(rejected.error).toBeInstanceOf(DebuggenError);
    expect(rejected.error.code).toBe('PANEL_SEMANTIC_INVALID');
    // Mechanical proof that no code was invented here: the value is a member of
    // the shared vocabulary `@debuggen/shared` owns, which is the set both
    // extensions and the protocol validate against.
    expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.code);
    expect(DEBUGGEN_ERROR_CODES).toContain(rejected.error.toPayload().code);
    // Escalated rather than refuted, and the message says which.
    expect(rejected.error.message).toContain('could not be fully verified');
    expect(rejected.error.details?.unverifiableCount).toBe(unverifiableOf(outcome).length);
  });

  it('rejects an invalid outcome with every issue in the error details', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)]), fact([])] });
    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
    });
    const result = toResult(outcome, spec);

    expect(isErr(result)).toBe(true);

    if (isOk(result)) {
      throw new Error('an invalid outcome must map to an error');
    }

    const { error } = result;

    expect(error.code).toBe('PANEL_SEMANTIC_INVALID');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.details?.schema).toBe('panelSpec');
    expect(error.details?.check).toBe('semantic');
    expect(error.details?.issueCount).toBe(issuesOf(outcome).length);
    expect(error.message).toContain('summary.observed.0.evidence.0.eventId');
    expect(error.hint).toContain(String(METRIC_IDS.length));
    // Every reported issue reaches `details` as path, code and reason — the
    // three fields a caller needs to locate the problem, and no fourth.
    expect(error.details?.issues).toEqual(
      issuesOf(outcome).map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        reason: issue.reason,
      })),
    );
    // `toPayload` is the wire form, and it forwards neither the details nor the
    // issue list: the code, the message and the hint only.
    expect(Object.keys(error.toPayload()).sort()).toEqual(['code', 'hint', 'message']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------
 */

describe('privacy', () => {
  it('never carries a rejected value into an issue, a message, a hint or details', () => {
    /*
     * One sentinel in every value a specification can carry into this module,
     * and an `invalid` outcome forced so that the reporting path — issues, the
     * rendered message, the hint, the details and the wire payload — is the one
     * under assertion.
     *
     * Why this is asserted rather than assumed: a panel is model-authored prose
     * *about* captured runtime data, and an error built here is logged, may be
     * persisted with the session and travels to both user interfaces through
     * the protocol's `error` payload — passing through neither the redaction
     * layer nor the outbound model guard on the way (AAP 0.5.2). An issue must
     * therefore carry shape and nothing else.
     */
    const sentinels = [
      SENTINEL_PANEL_TITLE,
      SENTINEL_NODE_TITLE,
      SENTINEL_STATEMENT,
      SENTINEL_HYPOTHESIS_STATEMENT,
      SENTINEL_EVENT_ID,
      SENTINEL_TRACE_ID,
      SENTINEL_LABEL,
      SENTINEL_METRIC,
      SENTINEL_COMPONENT,
      SENTINEL_FILE,
      SENTINEL_SPAN_NAME,
    ];

    // The last sentinel originates in the CAPTURE rather than in the panel: a
    // summarised span republishes the name its producer reported, so the
    // summary is a second source an issue could leak from.
    const interaction = makeInteraction();
    const summary = summarize([
      ...interaction.events,
      makeEvent({
        kind: SERVER_KIND,
        traceId: interaction.traceId,
        name: SENTINEL_SPAN_NAME,
        duration: 900,
      }),
    ]);

    expect(summary.topSpans[0]?.name).toBe(SENTINEL_SPAN_NAME);

    const spec = makeSpec({
      title: SENTINEL_PANEL_TITLE,
      observed: [
        fact(
          [ref(SENTINEL_EVENT_ID, { traceId: SENTINEL_TRACE_ID, label: SENTINEL_LABEL })],
          SENTINEL_STATEMENT,
        ),
      ],
      likelyCauses: [
        {
          statement: SENTINEL_HYPOTHESIS_STATEMENT,
          evidence: [ref(SENTINEL_EVENT_ID)],
          confidence: 'low',
          suggestedLocation: {
            file: SENTINEL_FILE,
            line: 7,
            column: 3,
            resolvedBy: 'code-graph',
            confidence: 0.5,
          },
        },
      ],
      layout: [
        {
          type: 'timeline',
          id: 'layout.0',
          title: SENTINEL_NODE_TITLE,
          query: { source: 'trace', filter: { traceId: SENTINEL_TRACE_ID } },
        },
        metricCardsNode([SENTINEL_METRIC], 'layout.1'),
        {
          type: 'renderTable',
          id: 'layout.2',
          query: { source: 'renders', filter: { component: SENTINEL_COMPONENT } },
        },
      ],
    });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: makeResolver([], [SENTINEL_EVENT_ID]),
      resolveTraceIds: makeResolver([], [SENTINEL_TRACE_ID]),
    });
    const result = toResult(outcome, spec);

    expect(outcome.status).toBe('invalid');
    expect(issuesOf(outcome).length).toBeGreaterThan(0);

    if (isOk(result)) {
      throw new Error('an invalid outcome must map to an error');
    }

    const reported = JSON.stringify({
      issues: issuesOf(outcome),
      unverifiable: unverifiableOf(outcome),
      collected: collectSemanticIssues(spec, summary),
      error: {
        message: result.error.message,
        hint: result.error.hint,
        details: result.error.details,
        payload: result.error.toPayload(),
      },
    });

    for (const sentinel of sentinels) {
      expect(reported, sentinel).not.toContain(sentinel);
    }
  });

  it('still says where the problem is, and in which closed vocabulary', () => {
    // Withholding the value is only acceptable because the caller can still
    // locate the problem: it holds the specification, so a path, a code and a
    // closed reason are enough to recompute the offending value itself.
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({
      observed: [fact([ref(SENTINEL_EVENT_ID)], SENTINEL_STATEMENT)],
      layout: [metricCardsNode([SENTINEL_METRIC], 'layout.0')],
    });

    const outcome = validateAgainstCapture(spec, summary, {
      resolveEventIds: makeResolver([], [SENTINEL_EVENT_ID]),
    });
    const issues = issuesOf(outcome);

    expect(issues.length).toBeGreaterThan(1);

    for (const issue of issues) {
      expect(issue.path.length).toBeGreaterThan(0);
      expect(SEMANTIC_ISSUE_CODES).toContain(issue.code);
      expect(isSemanticIssueReason(issue.reason)).toBe(true);
      expect(SEMANTIC_ISSUE_CODE_BY_REASON[issue.reason]).toBe(issue.code);
      expect(SEMANTIC_ISSUE_SEVERITIES).toContain(SEMANTIC_ISSUE_SEVERITY_BY_REASON[issue.reason]);
      // An issue carries these four fields and no fifth: no `value`, no
      // `expected`, no per-issue `message`.
      expect(Object.keys(issue).sort()).toEqual(
        issue.nodeType === undefined
          ? ['code', 'path', 'reason']
          : ['code', 'nodeType', 'path', 'reason'],
      );
    }

    // And the paths are the ones a caller would walk.
    expect(pathsOf(issues)).toEqual([
      'layout.0.metrics.0',
      'summary.observed.0.evidence.0.eventId',
    ]);
  });
});
