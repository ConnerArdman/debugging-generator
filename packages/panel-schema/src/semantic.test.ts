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
  TELEMETRY_KINDS,
  allowedTiersFor,
  attributeKeysFor,
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

import { catalogEntryFor } from './catalog.js';
import {
  SEMANTIC_ISSUE_CODES,
  SEMANTIC_ISSUE_CODE_BY_REASON,
  SEMANTIC_ISSUE_REASONS,
  SEMANTIC_ISSUE_SEVERITIES,
  SEMANTIC_ISSUE_SEVERITY_BY_REASON,
  SEMANTIC_VALIDATION_STATUSES,
  collectSemanticIssues,
  isSemanticIssueReason,
  tallyFieldPresence,
  toResult,
  validateAgainstCapture,
  type CaptureFieldPresence,
  type IdResolution,
  type SemanticIssue,
  type SemanticIssueSets,
  type SemanticValidationOptions,
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

/**
 * The attributes a record of `kind` must carry for a node of `type` to draw it:
 * a fixture value for every attribute key in the node's catalog `requiredReads`
 * that the kind declares.
 *
 * Derived from the catalog rather than written here, so a key the catalog comes
 * to require is supplied by every "evidence present" fixture without an edit,
 * and a case about *kinds* keeps testing kinds rather than tripping over a
 * field.
 */
function requiredAttributesFor(type: PanelNodeType, kind: TelemetryKind): Record<string, unknown> {
  const declared: readonly string[] = attributeKeysFor(kind);

  return Object.fromEntries(
    catalogEntryFor(type)
      .requiredReads.filter((key) => declared.includes(key))
      .map((key) => [key, `fixture ${key}`]),
  );
}

/** A query table, whose aggregate forms no group for a record without a statement. */
function queryTableNode(id = 'layout.0'): PanelNode {
  return { type: 'queryTable', id, query: { source: 'queries' } };
}

/**
 * Views over requests, queries, spans and events, for the case that a record
 * lacking only *optional* reads raises nothing: each of these still draws a
 * record with no status, size, resource timing, source location or parent.
 */
function optionalReadsLayout(): readonly PanelNode[] {
  return [
    { type: 'requestTable', id: 'layout.0', query: { source: 'requests' } },
    { type: 'waterfall', id: 'layout.1', query: { source: 'requests' } },
    queryTableNode('layout.2'),
    { type: 'timeline', id: 'layout.3', query: { source: 'spans' } },
    { type: 'table', id: 'layout.4', query: { source: 'events' } },
  ];
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

  it('builds valid specifications for the field-availability cases', () => {
    expect(isOk(validatePanelSpec(makeSpec({ layout: [queryTableNode()] })))).toBe(true);
    expect(isOk(validatePanelSpec(makeSpec({ layout: optionalReadsLayout() })))).toBe(true);
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
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unavailable-field']).toBe('advisory');
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unknown-event-id']).toBe('fatal');
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['unverifiable-event-id']).toBe('unverifiable');
  });

  it('places the field-availability reason beside the source one, under its own code', () => {
    // Records first, then the fields those records carry: the two advisories
    // are one question asked at two depths, so they sit together in the
    // vocabulary and a log reader can tell them apart by code.
    const sourceIndex = SEMANTIC_ISSUE_REASONS.indexOf('unavailable-source');

    expect(SEMANTIC_ISSUE_REASONS[sourceIndex + 1]).toBe('unavailable-field');
    expect(SEMANTIC_ISSUE_CODE_BY_REASON['unavailable-field']).toBe('panel_node_field_unavailable');
    expect(SEMANTIC_ISSUE_CODES).toContain('panel_node_field_unavailable');
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
     * first kind, carrying the attributes the node's catalog entry requires —
     * so its evidence is present — and asserts that every *other* node type,
     * whose groups that kind is not in, reports the advisory instead. That
     * crossing is what proves the decision follows the group and not merely
     * "the capture has some events".
     */
    for (const entry of KIND_BACKED_NODES) {
      const kind = firstKind(entry.kinds);
      const summary = summarize([
        makeEvent({ kind, attributes: requiredAttributesFor(entry.type, kind) }),
      ]);
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
 * Required field availability
 *
 * A node's kinds can all be present while the view is still empty: the query
 * aggregate forms no group for a record without a statement, so a capture of
 * statement-less queries holds `db.query` records and draws no query table.
 * These cases hold the check to the catalog's `requiredReads`, by both routes
 * — the caller's presence tally and the summary's bounded sections — and hold
 * it *away* from everything else: optional reads, clipped or unreadable
 * summaries, and a capture with no records at all.
 * ---------------------------------------------------------------------------
 */

/** A kind-valid query record carrying everything a query table reads except the statement. */
function statementlessQuery(): TelemetryEvent {
  return makeEvent({
    kind: QUERY_KIND,
    attributes: { 'db.system': 'postgresql', 'db.rowCount': 1 },
  });
}

/** A query record whose statement the query aggregate can group by. */
function statementQuery(): TelemetryEvent {
  return makeEvent({
    kind: QUERY_KIND,
    attributes: { 'db.statement': 'SELECT id FROM fixture_rows WHERE id = $1' },
  });
}

describe('required field availability', () => {
  it('reports a query table over statement-less records from the summary alone, without failing the panel', () => {
    const summary = summarize([statementlessQuery()]);

    // The inference's preconditions, measured on the computed rollup rather
    // than staged: the capture holds a record of the node's kind, the
    // aggregate formed no group from it, and nothing was clipped.
    expect(summary.kindCounts[QUERY_KIND]).toBe(1);
    expect(summary.topQueries).toEqual([]);
    expect(summary.truncated).toBe(false);

    const spec = makeSpec({ layout: [queryTableNode()] });
    const sets = collectSemanticIssues(spec, summary);

    // Exactly the four structural fields, and the node's source as the place:
    // a missing field is a property of the records the source serves.
    expect(sets.advisory).toEqual([
      {
        path: ['layout', 0, 'query', 'source'],
        code: 'panel_node_field_unavailable',
        reason: 'unavailable-field',
        nodeType: 'queryTable',
      },
    ]);
    expect(sets.issues).toEqual([]);
    expect(sets.unverifiable).toEqual([]);
    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
  });

  it('escalates a missing required field only under requireVerifiable', () => {
    const summary = summarize([statementlessQuery()]);
    const spec = makeSpec({ layout: [queryTableNode()] });

    const outcome = validateAgainstCapture(spec, summary, { requireVerifiable: true });

    expect(outcome.status).toBe('invalid');
    expect(reasonsOf(issuesOf(outcome))).toEqual(['unavailable-field']);
  });

  it('reports statement-less queries in a capture whose clipped span section sets the global truncation flag', () => {
    // More spans than the section bound: the slowest-span section is clipped,
    // which sets the summary's global `truncated` flag although no query
    // group exists. The execution count is computed over the whole capture,
    // and it is what decides.
    const events = Array.from({ length: 11 }, () => statementlessQuery());
    const summary = summarize(events);
    const queryCount = summary.metrics.find((metric) => metric.id === 'query_count');

    expect(summary.kindCounts[QUERY_KIND]).toBe(events.length);
    expect(summary.topSpans.length).toBeLessThan(events.length);
    expect(summary.truncated).toBe(true);
    expect(summary.topQueries).toEqual([]);
    expect(queryCount?.available).toBe(true);
    expect(queryCount?.value).toBe(0);

    const spec = makeSpec({ layout: [queryTableNode()] });

    expect(collectSemanticIssues(spec, summary).advisory).toEqual([
      {
        path: ['layout', 0, 'query', 'source'],
        code: 'panel_node_field_unavailable',
        reason: 'unavailable-field',
        nodeType: 'queryTable',
      },
    ]);
    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
    expect(validateAgainstCapture(spec, summary, { requireVerifiable: true }).status).toBe(
      'invalid',
    );
  });

  it('accepts a clipped capture whose queries carry statements', () => {
    const events = Array.from({ length: 11 }, () => statementQuery());
    const summary = summarize(events);
    const spec = makeSpec({ layout: [queryTableNode()] });

    expect(summary.truncated).toBe(true);
    expect(collectSemanticIssues(spec, summary).advisory).toEqual([]);
    expect(validateAgainstCapture(spec, summary, { requireVerifiable: true }).status).toBe('valid');
  });

  it('decides from a field-presence tally only where the summary publishes no decisive aggregate result', () => {
    const events = [statementlessQuery()];
    // Clipped, and with its metric set withheld: no section, no execution
    // count and no clip-free emptiness speaks for the query aggregate.
    const undecided = makeCaptureSummary({ events, truncated: true, metrics: [] });
    const spec = makeSpec({ layout: [queryTableNode()] });
    const fieldPresence = tallyFieldPresence(events);

    // Such a rollup leaves the question open on its own…
    expect(collectSemanticIssues(spec, undecided).advisory).toEqual([]);

    // …and the tally over the records themselves settles it.
    const sets = collectSemanticIssues(spec, undecided, { fieldPresence });

    expect(reasonsOf(sets.advisory)).toEqual(['unavailable-field']);
    expect(sets.advisory[0]?.path).toEqual(['layout', 0, 'query', 'source']);
    expect(sets.advisory[0]?.nodeType).toBe('queryTable');
    expect(validateAgainstCapture(spec, undecided, { fieldPresence }).status).toBe('valid');
    expect(
      validateAgainstCapture(spec, undecided, { fieldPresence, requireVerifiable: true }).status,
    ).toBe('invalid');
  });

  it('accepts a query table whose records carry a statement, by either route', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [queryTableNode()] });

    expect(collectSemanticIssues(spec, summary).advisory).toEqual([]);
    expect(
      collectSemanticIssues(spec, summary, {
        fieldPresence: tallyFieldPresence(interaction.events),
      }).advisory,
    ).toEqual([]);
  });

  it('needs one carrier: a statement on any record of the kind is enough', () => {
    const events = [statementlessQuery(), statementQuery()];
    const summary = summarize(events);
    const spec = makeSpec({ layout: [queryTableNode()] });

    expect(collectSemanticIssues(spec, summary).advisory).toEqual([]);
    expect(
      collectSemanticIssues(spec, summary, { fieldPresence: tallyFieldPresence(events) }).advisory,
    ).toEqual([]);
  });

  it('reads the unbounded execution count before the bounded section', () => {
    // An emptied section beside an execution count of one: the count is
    // computed over every record, so the aggregate did form a group.
    const events = [statementQuery()];
    const emptied = makeCaptureSummary({ events, topQueries: [] });
    const spec = makeSpec({ layout: [queryTableNode()] });

    expect(emptied.truncated).toBe(false);
    expect(collectSemanticIssues(spec, emptied).advisory).toEqual([]);

    // With the count withheld, the clip-free empty section is what is left, and
    // it says no group formed.
    const withoutCount = makeCaptureSummary({ events, topQueries: [], metrics: [] });

    expect(reasonsOf(collectSemanticIssues(spec, withoutCount).advisory)).toEqual([
      'unavailable-field',
    ]);
  });

  it('never lets a tally overrule the verdict the summary publishes', () => {
    const spec = makeSpec({ layout: [queryTableNode()] });

    // The aggregate formed no group: a tally claiming a statement carrier does
    // not put a row back into the table.
    const contraryCarrier: CaptureFieldPresence = {
      [QUERY_KIND]: { events: 1, attributes: { 'db.statement': 1 }, text: { 'db.statement': 1 } },
    };

    expect(
      reasonsOf(
        collectSemanticIssues(spec, summarize([statementlessQuery()]), {
          fieldPresence: contraryCarrier,
        }).advisory,
      ),
    ).toEqual(['unavailable-field']);

    // The aggregate formed a group: a tally claiming no carrier does not empty
    // the table either.
    const contraryAbsence: CaptureFieldPresence = {
      [QUERY_KIND]: { events: 1, attributes: {}, text: {} },
    };

    expect(
      collectSemanticIssues(spec, summarize([statementQuery()]), {
        fieldPresence: contraryAbsence,
      }).advisory,
    ).toEqual([]);
  });

  it('agrees with the query aggregate on what counts as a statement', () => {
    const spec = makeSpec({ layout: [queryTableNode()] });

    // A number under the key is a carried value, but the aggregate groups only
    // by statement text, so it forms no row — by the summary and by the tally.
    const numeric = [makeEvent({ kind: QUERY_KIND, attributes: { 'db.statement': 42 } })];
    const numericPresence = tallyFieldPresence(numeric);

    expect(summarize(numeric).topQueries).toEqual([]);
    expect(numericPresence[QUERY_KIND]).toEqual({
      events: 1,
      attributes: { 'db.statement': 1 },
      text: {},
    });

    for (const options of [{}, { fieldPresence: numericPresence }]) {
      expect(reasonsOf(collectSemanticIssues(spec, summarize(numeric), options).advisory)).toEqual([
        'unavailable-field',
      ]);
      expect(
        validateAgainstCapture(spec, summarize(numeric), { ...options, requireVerifiable: true })
          .status,
      ).toBe('invalid');
    }

    const numericUndecided = makeCaptureSummary({ events: numeric, truncated: true, metrics: [] });

    expect(
      reasonsOf(
        collectSemanticIssues(spec, numericUndecided, { fieldPresence: numericPresence }).advisory,
      ),
    ).toEqual(['unavailable-field']);

    // A whitespace-only string is text of positive length, which the aggregate
    // does group, so nothing is missing — by the summary and by the tally.
    const blank = [makeEvent({ kind: QUERY_KIND, attributes: { 'db.statement': '  ' } })];
    const blankPresence = tallyFieldPresence(blank);

    expect(summarize(blank).topQueries).toHaveLength(1);
    expect(blankPresence[QUERY_KIND]?.text).toEqual({ 'db.statement': 1 });

    for (const options of [{}, { fieldPresence: blankPresence }]) {
      expect(collectSemanticIssues(spec, summarize(blank), options).advisory).toEqual([]);
      expect(
        validateAgainstCapture(spec, summarize(blank), { ...options, requireVerifiable: true })
          .status,
      ).toBe('valid');
    }

    const blankUndecided = makeCaptureSummary({ events: blank, truncated: true, metrics: [] });

    expect(
      collectSemanticIssues(spec, blankUndecided, { fieldPresence: blankPresence }).advisory,
    ).toEqual([]);
  });

  it('never reports a missing optional read', () => {
    // A request with no status, no size, no resource timing, no source location
    // and no parent, and a query with a statement and nothing else: every view
    // below still draws, and renders what is missing as unavailable.
    const events = [makeEvent({ kind: FETCH_KIND, attributes: {} }), statementQuery()];
    const summary = summarize(events);
    const fieldPresence = tallyFieldPresence(events);
    const spec = makeSpec({ layout: optionalReadsLayout() });

    // Measured, not assumed: the request record really carries no key at all.
    expect(fieldPresence[FETCH_KIND]).toEqual({ events: 1, attributes: {}, text: {} });
    expect(collectSemanticIssues(spec, summary).advisory).toEqual([]);
    expect(collectSemanticIssues(spec, summary, { fieldPresence }).advisory).toEqual([]);
  });

  it('leaves the question open when the summary cannot answer it', () => {
    const events = [statementlessQuery()];
    const summary = summarize(events);
    const spec = makeSpec({ layout: [queryTableNode()] });
    // Each is a rollup that did not publish something, which is not evidence
    // that it is absent: a clipped summary without its execution count, a
    // section that is not a list beside no count, an unreported clip beside no
    // count, an execution count the summary could not measure beside a clipped
    // section, and per-kind tallies that do not say.
    const unmeasuredCount = summary.metrics.map((metric) =>
      metric.id === 'query_count' ? { id: metric.id, available: false } : metric,
    );
    const undecidable: readonly CaptureSummary[] = [
      makeCaptureSummary({ events, truncated: true, metrics: [] }),
      { ...summary, topQueries: undefined, metrics: undefined } as unknown as CaptureSummary,
      { ...summary, truncated: undefined, metrics: [] } as unknown as CaptureSummary,
      { ...summary, truncated: true, metrics: unmeasuredCount } as unknown as CaptureSummary,
      { ...summary, kindCounts: {} } as unknown as CaptureSummary,
    ];

    for (const [position, candidate] of undecidable.entries()) {
      expect(collectSemanticIssues(spec, candidate).advisory, String(position)).toEqual([]);
    }
  });

  it('reports an empty capture as an unavailable source only, never also as a missing field', () => {
    const spec = makeSpec({ layout: [queryTableNode()] });

    for (const events of [[], [makeEvent({ kind: INTERACTION_KIND })]]) {
      const summary = summarize(events);

      expect(reasonsOf(collectSemanticIssues(spec, summary).advisory)).toEqual([
        'unavailable-source',
      ]);
      expect(
        reasonsOf(
          collectSemanticIssues(spec, summary, { fieldPresence: tallyFieldPresence(events) })
            .advisory,
        ),
      ).toEqual(['unavailable-source']);
    }
  });

  it('asks nothing of a node whose catalog entry requires no attribute key', () => {
    // A render record with no component, phase, trigger or count: the render
    // table labels it rather than dropping it, so nothing is reported even
    // from a tally that shows every render key missing.
    const events = [makeEvent({ kind: RENDER_KIND, attributes: {} })];
    const summary = summarize(events);
    const spec = makeSpec({ layout: [renderTableNode()] });

    expect(
      collectSemanticIssues(spec, summary, { fieldPresence: tallyFieldPresence(events) }).advisory,
    ).toEqual([]);
  });

  it('never throws on a malformed tally, and leaves the summary to decide', () => {
    const events = [statementlessQuery()];
    const summary = summarize(events);
    const undecided = makeCaptureSummary({ events, truncated: true, metrics: [] });
    const spec = makeSpec({ layout: [queryTableNode()] });
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const malformed: readonly unknown[] = [
      'not a tally',
      42,
      null,
      [],
      revoked,
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('trap');
          },
        },
      ),
      { [QUERY_KIND]: 'not a tally' },
      { [QUERY_KIND]: { events: -1, attributes: {}, text: {} } },
      { [QUERY_KIND]: { events: Number.NaN, attributes: {}, text: {} } },
      { [QUERY_KIND]: { events: 1 } },
      { [QUERY_KIND]: { events: 1, attributes: {} } },
      { [QUERY_KIND]: { events: 1, attributes: {}, text: [] } },
      { [QUERY_KIND]: { events: 1, attributes: {}, text: { 'db.statement': 'not a count' } } },
      { [QUERY_KIND]: { events: 1, attributes: {}, text: { 'db.statement': -1 } } },
    ];

    for (const [position, candidate] of malformed.entries()) {
      const fieldPresence = candidate as CaptureFieldPresence;

      // The summary publishes the aggregate's verdict, so it decides…
      expect(
        reasonsOf(collectSemanticIssues(spec, summary, { fieldPresence }).advisory),
        String(position),
      ).toEqual(['unavailable-field']);
      // …and where it cannot, a tally that cannot be read leaves it open.
      expect(
        collectSemanticIssues(spec, undecided, { fieldPresence }).advisory,
        String(position),
      ).toEqual([]);
    }
  });
});

describe('tallyFieldPresence', () => {
  it('counts, per kind, the records and the records carrying each key with a value', () => {
    const events = [
      makeEvent({
        kind: QUERY_KIND,
        attributes: { 'db.statement': 'SELECT 1', 'db.system': 'postgresql' },
      }),
      makeEvent({
        kind: QUERY_KIND,
        attributes: { 'db.statement': '   ', 'db.system': 'postgresql', 'db.rowCount': null },
      }),
      makeEvent({ kind: QUERY_KIND, attributes: { 'db.statement': '', 'db.rowCount': 0 } }),
      makeEvent({
        kind: FETCH_KIND,
        attributes: { 'http.method': 'GET', inFlight: false, transferSize: undefined },
      }),
    ];

    const presence = tallyFieldPresence(events);

    // The empty string, `null` and `undefined` are absent; `0`, `false` and a
    // whitespace-only string are values. Text counts strings of positive
    // length only — the predicate the query aggregate groups a statement by.
    expect(presence).toEqual({
      [QUERY_KIND]: {
        events: 3,
        attributes: { 'db.rowCount': 1, 'db.statement': 2, 'db.system': 2 },
        text: { 'db.statement': 2, 'db.system': 2 },
      },
      [FETCH_KIND]: {
        events: 1,
        attributes: { 'http.method': 1, inFlight: 1 },
        text: { 'http.method': 1 },
      },
    });
  });

  it('orders kinds by the vocabulary and keys by code unit, and freezes throughout', () => {
    const events = [
      makeEvent({ kind: QUERY_KIND, attributes: { 'db.system': 'postgresql', 'db.rowCount': 1 } }),
      makeEvent({ kind: FETCH_KIND, attributes: { url: '/fixture', 'http.method': 'GET' } }),
    ];

    const presence = tallyFieldPresence(events);
    const queries = presence[QUERY_KIND];

    expect(Object.keys(presence)).toEqual(
      TELEMETRY_KINDS.filter((kind) => kind === QUERY_KIND || kind === FETCH_KIND),
    );
    expect(Object.keys(queries?.attributes ?? {})).toEqual(['db.rowCount', 'db.system']);
    expect(Object.keys(queries?.text ?? {})).toEqual(['db.system']);
    expect(Object.isFrozen(presence)).toBe(true);
    expect(Object.isFrozen(queries)).toBe(true);
    expect(Object.isFrozen(queries?.attributes)).toBe(true);
    expect(Object.isFrozen(queries?.text)).toBe(true);

    // The same records in another order tally to the same bytes.
    expect(JSON.stringify(tallyFieldPresence([...events].reverse()))).toBe(
      JSON.stringify(presence),
    );
  });

  it('holds counts only: no attribute value, id or name reaches the tally', () => {
    const sentinel = 'SENTINEL-VALUE-THAT-MUST-NOT-LEAK';
    const event = makeEvent({
      kind: QUERY_KIND,
      name: 'SENTINEL-NAME-THAT-MUST-NOT-LEAK',
      attributes: { 'db.statement': sentinel },
    });

    const serialised = JSON.stringify(tallyFieldPresence([event]));

    expect(serialised).not.toContain(sentinel);
    expect(serialised).not.toContain('SENTINEL-NAME-THAT-MUST-NOT-LEAK');
    expect(serialised).not.toContain(event.id);
    expect(serialised).not.toContain(event.traceId);
  });

  it('tallies an empty or a non-array input to an empty record', () => {
    expect(tallyFieldPresence([])).toEqual({});

    for (const candidate of [undefined, null, 'events', 42, { length: 2 }]) {
      expect(tallyFieldPresence(candidate as unknown as readonly TelemetryEvent[])).toEqual({});
    }
  });

  it('skips what it cannot attribute and survives what throws', () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const candidates: readonly unknown[] = [
      null,
      42,
      'text',
      [],
      { kind: 'not-a-kind', attributes: { 'db.statement': 'SELECT 1' } },
      revoked,
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('trap');
          },
        },
      ),
      // A known kind whose bag throws while its keys are listed contributes
      // nothing, not even its record.
      {
        kind: QUERY_KIND,
        attributes: new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('trap');
            },
          },
        ),
      },
      // A known kind with no bag, or with something that is not one, is a
      // record carrying no key.
      { kind: QUERY_KIND },
      { kind: QUERY_KIND, attributes: ['db.statement'] },
      { kind: QUERY_KIND, attributes: 'db.statement' },
      statementQuery(),
    ];

    let presence: CaptureFieldPresence = {};

    expect(() => {
      presence = tallyFieldPresence(candidates as readonly TelemetryEvent[]);
    }).not.toThrow();
    expect(presence).toEqual({
      [QUERY_KIND]: { events: 4, attributes: { 'db.statement': 1 }, text: { 'db.statement': 1 } },
    });
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
    // Not thrown, and not passed either: a document whose claims cannot be read
    // has none this module could vouch for (the suite below covers the rule).
    expect(validateAgainstCapture(malformed, summary).status).toBe('invalid');
    expect(pathsOf(issuesOf(validateAgainstCapture(malformed, summary)))).toEqual([
      'layout',
      'summary',
    ]);
    expect(() => validateAgainstCapture(makeSpec(), {} as unknown as CaptureSummary)).not.toThrow();
    expect(() =>
      collectSemanticIssues({} as unknown as PanelSpec, {} as unknown as CaptureSummary),
    ).not.toThrow();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Values that are not specifications
 *
 * The module reads every field as `unknown`, and a tolerant reader of a value
 * with no readable claims finds none — which, unguarded, reads as `valid`, the
 * false pass this checkpoint exists to prevent. Every case below is a value a
 * caller holding an asserted rather than parsed document can hand in, and each
 * must be refused as `malformed-spec` rather than passed or thrown on.
 * ---------------------------------------------------------------------------
 */

/** The code the malformed-document reason is reported under. */
const MALFORMED_SPEC_CODE = 'panel_spec_malformed';

/** One value that is not a readable specification, and where it fails. */
interface MalformedCase {
  /** What the case is, for assertion messages. */
  readonly label: string;
  /** The value handed in as a specification. */
  readonly spec: unknown;
  /** The value handed in as the capture. */
  readonly summary: unknown;
  /** The paths the rejection must name, in sorted order. */
  readonly paths: readonly (readonly (string | number)[])[];
}

/**
 * The five inputs the QA report found passing as `valid`: each against a real
 * capture, except the first, which is the report's `(null, null)` call.
 *
 * The three built from a document start from a well-formed specification with
 * a checkable citation and trace filter, so each differs from a valid panel
 * only in the one root it breaks.
 */
function reportedNonSpecs(): readonly MalformedCase[] {
  const interaction = makeInteraction();
  const summary = summarize(interaction.events);
  const spec = makeSpec({
    observed: [fact([ref(interaction.slowestSpan.id)])],
    layout: [timelineNode(interaction.traceId)],
  });

  return [
    { label: 'null against a null capture', spec: null, summary: null, paths: [[]] },
    { label: 'an empty object', spec: {}, summary, paths: [['layout'], ['summary']] },
    { label: 'a string', spec: 'garbage', summary, paths: [[]] },
    {
      label: 'a layout that is a string',
      spec: { ...spec, layout: 'x' },
      summary,
      paths: [['layout']],
    },
    {
      label: 'a summary that is undefined',
      spec: { ...spec, summary: undefined },
      summary,
      paths: [['summary']],
    },
  ];
}

/** Runs one malformed case through the outcome-returning entry point. */
function validateCase(
  candidate: MalformedCase,
  options?: SemanticValidationOptions,
): SemanticValidationOutcome {
  return validateAgainstCapture(
    candidate.spec as PanelSpec,
    candidate.summary as CaptureSummary,
    options,
  );
}

/** A copy of `base` whose `key` is an own field that throws when read. */
function withThrowingField(base: object, key: string): object {
  return Object.defineProperty({ ...base }, key, {
    enumerable: true,
    get: () => {
      throw new Error('unreadable field');
    },
  });
}

describe('values that are not specifications', () => {
  it('declares the malformed-specification reason fatal, under its own code, last', () => {
    expect(SEMANTIC_ISSUE_REASONS[SEMANTIC_ISSUE_REASONS.length - 1]).toBe('malformed-spec');
    expect(isSemanticIssueReason('malformed-spec')).toBe(true);
    expect(SEMANTIC_ISSUE_SEVERITY_BY_REASON['malformed-spec']).toBe('fatal');
    expect(SEMANTIC_ISSUE_CODE_BY_REASON['malformed-spec']).toBe(MALFORMED_SPEC_CODE);
    expect(SEMANTIC_ISSUE_CODES).toContain(MALFORMED_SPEC_CODE);
  });

  it('rejects each non-specification the QA report found passing, under every option', () => {
    const optionSets: readonly (SemanticValidationOptions | undefined)[] = [
      undefined,
      { requireVerifiable: true },
      { requireVerifiable: false, allowEmptyObserved: false },
    ];

    for (const candidate of reportedNonSpecs()) {
      for (const options of optionSets) {
        const outcome = validateCase(candidate, options);
        const label = `${candidate.label} ${JSON.stringify(options ?? {})}`;

        expect(outcome.status, label).toBe('invalid');
        expect(
          issuesOf(outcome).map((issue) => issue.path),
          label,
        ).toEqual(candidate.paths);
        expect(reasonsOf(issuesOf(outcome)), label).toEqual(
          candidate.paths.map(() => 'malformed-spec'),
        );
        expect(
          issuesOf(outcome).map((issue) => issue.code),
          label,
        ).toEqual(candidate.paths.map(() => MALFORMED_SPEC_CODE));
        expect(unverifiableOf(outcome), label).toEqual([]);
      }
    }
  });

  it('reports the same issues from collectSemanticIssues, and nothing else', () => {
    for (const candidate of reportedNonSpecs()) {
      const sets = collectSemanticIssues(
        candidate.spec as PanelSpec,
        candidate.summary as CaptureSummary,
        { requireVerifiable: true },
      );

      expect(sets.issues, candidate.label).toEqual(issuesOf(validateCase(candidate)));
      expect(sets.unverifiable, candidate.label).toEqual([]);
      expect(sets.advisory, candidate.label).toEqual([]);
      expect(sets.informational, candidate.label).toEqual([]);

      // Path, code and reason, and no fourth field: there is no node to name.
      for (const issue of sets.issues) {
        expect(Object.keys(issue).sort(), candidate.label).toEqual(['code', 'path', 'reason']);
      }
    }
  });

  it('rejects every value that is not a non-array object at the document root', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec();
    const candidates: readonly unknown[] = [
      undefined,
      42,
      0,
      true,
      '',
      Symbol('specification'),
      () => spec,
      [],
      [spec],
    ];

    for (const [position, candidate] of candidates.entries()) {
      const outcome = validateAgainstCapture(candidate as PanelSpec, summary);

      expect(
        issuesOf(outcome).map((issue) => issue.path),
        String(position),
      ).toEqual([[]]);
      expect(reasonsOf(issuesOf(outcome)), String(position)).toEqual(['malformed-spec']);
    }
  });

  it('rejects a statement list that is present but not an array', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [timelineNode(interaction.traceId)] });
    // A fact keyed rather than listed carries a citation the walk would never
    // reach, so passing the panel would vouch for evidence nobody checked.
    const unreadable = {
      ...spec,
      summary: { observed: { 0: fact([ref(ABSENT_EVENT_ID)]) }, likelyCauses: 'none' },
    } as unknown as PanelSpec;

    expect(pathsOf(issuesOf(validateAgainstCapture(unreadable, summary)))).toEqual([
      'summary.likelyCauses',
      'summary.observed',
    ]);
    expect(
      pathsOf(
        issuesOf(
          validateAgainstCapture(
            { ...spec, summary: { observed: [], likelyCauses: null } } as unknown as PanelSpec,
            summary,
          ),
        ),
      ),
    ).toEqual(['summary.likelyCauses']);
  });

  it('reads an omitted statement list as empty, exactly as the summary schema defaults it', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({ layout: [timelineNode(interaction.traceId)] });
    const omitted = { ...spec, summary: {} } as unknown as PanelSpec;
    const headlined = { ...spec, summary: { headline: 'Prose only.' } } as unknown as PanelSpec;

    expect(validateAgainstCapture(spec, summary).status).toBe('valid');
    expect(validateAgainstCapture(omitted, summary)).toEqual(validateAgainstCapture(spec, summary));
    expect(collectSemanticIssues(omitted, summary)).toEqual(collectSemanticIssues(spec, summary));
    expect(validateAgainstCapture(headlined, summary).status).toBe('valid');

    // Including when a caller requires findings: an omitted observed list is
    // an empty one, not a way around the requirement…
    const required = { allowEmptyObserved: false } as const;

    expect(reasonsOf(issuesOf(validateAgainstCapture(omitted, summary, required)))).toEqual([
      'empty-observed',
    ]);
    expect(validateAgainstCapture(omitted, summary, required)).toEqual(
      validateAgainstCapture(spec, summary, required),
    );

    // …and a fallback panel stays exempt either way.
    const fallback = { ...makeSpec({ fallback: true }), summary: {} } as unknown as PanelSpec;

    expect(validateAgainstCapture(fallback, summary, required).status).toBe('valid');

    // An empty layout is a legitimate one too: there was nothing to draw.
    expect(validateAgainstCapture(makeSpec({ layout: [] }), summary).status).toBe('valid');
  });

  it('reads own fields only, exactly as the claim walk does', () => {
    const summary = summarize(makeInteraction().events);
    // A `layout` reached through a prototype is one the walk would never read,
    // so it is reported as missing rather than trusted.
    const inherited: unknown = Object.create({
      layout: [],
      summary: { observed: [], likelyCauses: [] },
    });

    expect(pathsOf(issuesOf(validateAgainstCapture(inherited as PanelSpec, summary)))).toEqual([
      'layout',
      'summary',
    ]);
  });

  it('never throws on a document whose roots cannot be read, and names each one', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec();
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const trapping = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    const cases: readonly { readonly spec: unknown; readonly paths: readonly string[] }[] = [
      { spec: revoked, paths: [''] },
      { spec: trapping, paths: ['layout', 'summary'] },
      { spec: withThrowingField(spec, 'layout'), paths: ['layout'] },
      { spec: withThrowingField(spec, 'summary'), paths: ['summary'] },
      { spec: { ...spec, layout: revoked }, paths: ['layout'] },
      { spec: { ...spec, summary: revoked }, paths: ['summary'] },
      {
        spec: { ...spec, summary: withThrowingField(spec.summary, 'observed') },
        paths: ['summary.observed'],
      },
    ];

    for (const [position, candidate] of cases.entries()) {
      const run = (): SemanticValidationOutcome =>
        validateAgainstCapture(candidate.spec as PanelSpec, summary, { requireVerifiable: true });

      expect(run, String(position)).not.toThrow();
      expect(pathsOf(issuesOf(run())), String(position)).toEqual(candidate.paths);
      expect(reasonsOf(issuesOf(run())), String(position)).toEqual(
        candidate.paths.map(() => 'malformed-spec'),
      );
    }
  });

  it('asks no resolver and reads nothing of the capture for a malformed specification', () => {
    const resolveEventIds = vi.fn<(ids: readonly string[]) => IdResolution>(() => ({
      known: new Set<string>(),
      unknown: new Set<string>(),
    }));
    const resolveTraceIds = vi.fn<(ids: readonly string[]) => IdResolution>(() => ({
      known: new Set<string>(),
      unknown: new Set<string>(),
    }));
    // A capture that throws on any read: getting through without an exception
    // proves the capture was never indexed for a document with no readable
    // claims — there is nothing to check it against.
    const { proxy: unreadableCapture, revoke } = Proxy.revocable({}, {});
    revoke();

    for (const candidate of reportedNonSpecs()) {
      const outcome = validateAgainstCapture(
        candidate.spec as PanelSpec,
        unreadableCapture as unknown as CaptureSummary,
        { resolveEventIds, resolveTraceIds, requireVerifiable: true },
      );

      expect(outcome.status, candidate.label).toBe('invalid');
    }

    expect(resolveEventIds).not.toHaveBeenCalled();
    expect(resolveTraceIds).not.toHaveBeenCalled();
  });

  it('maps a malformed specification onto PANEL_SEMANTIC_INVALID with its own message and hint', () => {
    const summary = summarize(makeInteraction().events);
    const empty = {} as unknown as PanelSpec;
    const result = toResult(validateAgainstCapture(empty, summary), empty);

    // Refused by the strict mapping too: a malformed value is invalid, not
    // merely unverifiable.
    expect(
      isErr(
        toResult(validateAgainstCapture(empty, summary, { requireVerifiable: true }), empty, {
          requireVerifiable: true,
        }),
      ),
    ).toBe(true);

    if (isOk(result)) {
      throw new Error('a malformed specification must map to an error');
    }

    const { error } = result;

    expect(error).toBeInstanceOf(DebuggenError);
    expect(error.code).toBe('PANEL_SEMANTIC_INVALID');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.message).toContain('not a readable panel specification');
    expect(error.message).toContain('2 checks failed');
    expect(error.message).toContain(
      `layout (${MALFORMED_SPEC_CODE}), summary (${MALFORMED_SPEC_CODE})`,
    );
    // The hint says what shape is required and what to do, and not the
    // evidence advice, which would point at citations the value never had.
    expect(error.hint).toContain('validatePanelSpec');
    expect(error.hint).not.toContain('event-id resolver');
    expect(error.details?.schema).toBe('panelSpec');
    expect(error.details?.check).toBe('semantic');
    expect(error.details?.issueCount).toBe(2);
    expect(error.details?.unverifiableCount).toBe(0);
    expect(error.details?.issues).toEqual([
      { path: 'layout', code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
      { path: 'summary', code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
    ]);
    expect(Object.keys(error.toPayload()).sort()).toEqual(['code', 'hint', 'message']);

    // A value that is not an object at all is named by the root label.
    const root = null as unknown as PanelSpec;
    const rootResult = toResult(validateAgainstCapture(root, summary), root);

    if (isOk(rootResult)) {
      throw new Error('a non-object must map to an error');
    }

    expect(rootResult.error.message).toContain(`1 check failed: (panel) (${MALFORMED_SPEC_CODE})`);
    expect(rootResult.error.details?.issues).toEqual([
      { path: '', code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
    ]);
  });

  it('never carries a rejected value into a malformed-specification report', () => {
    const summary = summarize(makeInteraction().events);
    const titled = makeSpec({ title: SENTINEL_PANEL_TITLE });
    const sentinels = [
      SENTINEL_PANEL_TITLE,
      SENTINEL_NODE_TITLE,
      SENTINEL_STATEMENT,
      SENTINEL_LABEL,
      SENTINEL_EVENT_ID,
    ];
    const candidates: readonly unknown[] = [
      SENTINEL_PANEL_TITLE,
      { [SENTINEL_LABEL]: SENTINEL_STATEMENT },
      { ...titled, layout: SENTINEL_NODE_TITLE, summary: SENTINEL_STATEMENT },
      {
        ...titled,
        summary: {
          observed: { [SENTINEL_LABEL]: fact([ref(SENTINEL_EVENT_ID)], SENTINEL_STATEMENT) },
          likelyCauses: SENTINEL_STATEMENT,
        },
      },
    ];

    for (const [position, candidate] of candidates.entries()) {
      const spec = candidate as PanelSpec;
      const outcome = validateAgainstCapture(spec, summary);
      const result = toResult(outcome, spec);

      expect(outcome.status, String(position)).toBe('invalid');

      if (isOk(result)) {
        throw new Error('a malformed specification must map to an error');
      }

      const reported = JSON.stringify({
        issues: issuesOf(outcome),
        collected: collectSemanticIssues(spec, summary),
        error: {
          message: result.error.message,
          hint: result.error.hint,
          details: result.error.details,
          payload: result.error.toPayload(),
        },
      });

      for (const sentinel of sentinels) {
        expect(reported, `${String(position)} ${sentinel}`).not.toContain(sentinel);
      }
    }
  });

  it('leaves every outcome of a well-formed specification as it was', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const emptyCapture = makeCaptureSummary();
    const verified = makeSpec({
      observed: [fact([ref(interaction.slowestSpan.id)])],
      layout: [timelineNode(interaction.traceId)],
    });
    const undecided = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });
    const withoutEvidence = makeSpec({ layout: [renderTableNode()] });

    // Valid, including after the JSON round trip a stored panel makes.
    expect(validateAgainstCapture(verified, summary)).toEqual({ status: 'valid' });
    expect(validateAgainstCapture(jsonClone(verified), jsonClone(summary))).toEqual({
      status: 'valid',
    });
    expect(isOk(toResult(validateAgainstCapture(verified, summary), verified))).toBe(true);

    // Unverifiable without a resolver, refuted with one.
    expect(validateAgainstCapture(undecided, summary).status).toBe('unverifiable');
    expect(
      reasonsOf(
        issuesOf(
          validateAgainstCapture(undecided, summary, {
            resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
          }),
        ),
      ),
    ).toEqual(['unknown-event-id']);

    // A node with no evidence is advisory by default and escalated on request.
    expect(validateAgainstCapture(withoutEvidence, emptyCapture).status).toBe('valid');
    expect(
      reasonsOf(
        issuesOf(
          validateAgainstCapture(withoutEvidence, emptyCapture, { requireVerifiable: true }),
        ),
      ),
    ).toEqual(['unavailable-source']);

    // And no well-formed fixture raises the malformed reason in any partition.
    for (const [spec, capture] of [
      [verified, summary],
      [undecided, summary],
      [withoutEvidence, emptyCapture],
    ] as const) {
      const sets = collectSemanticIssues(spec, capture, { requireVerifiable: true });

      expect(
        reasonsOf([...sets.issues, ...sets.unverifiable, ...sets.advisory, ...sets.informational]),
      ).not.toContain('malformed-spec');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Elements that cannot be read
 *
 * A document's roots can all read while an element below them does not: a
 * statement that is a bare string, a citation that names no event, a node
 * whose type the catalog does not carry, a getter that throws. Each hides the
 * claims inside it, so each must be refused where it stands — and each must
 * cost only its own claims: the elements beside it, and every node after it,
 * are checked exactly as though it were not there.
 * ---------------------------------------------------------------------------
 */

/** A specification whose layout holds these values, which need not be nodes. */
function withLayout(layout: readonly unknown[]): PanelSpec {
  return { ...makeSpec(), layout } as unknown as PanelSpec;
}

/** A specification whose observed list holds these values, which need not be facts. */
function withObserved(observed: readonly unknown[]): PanelSpec {
  const spec = makeSpec();

  return { ...spec, summary: { ...spec.summary, observed } } as unknown as PanelSpec;
}

/** A copy of `elements` whose element at `position` throws when read. */
function withThrowingElement(elements: readonly unknown[], position: number): unknown[] {
  const list = [...elements];

  Object.defineProperty(list, position, {
    enumerable: true,
    get: () => {
      throw new Error('unreadable element');
    },
  });

  return list;
}

/**
 * A copy of `base` whose listed fields each answer their value on the first
 * read and throw on every later one: a document a reader must read once.
 */
function readableOnce(base: object, fields: Readonly<Record<string, unknown>>): object {
  const copy = { ...base };

  for (const [key, value] of Object.entries(fields)) {
    let reads = 0;

    Object.defineProperty(copy, key, {
      enumerable: true,
      get: () => {
        reads += 1;

        if (reads > 1) {
          throw new Error('read twice');
        }

        return value;
      },
    });
  }

  return copy;
}

/** An array `Array.isArray` accepts, but whose length cannot be read. */
function withUnreadableLength(): unknown[] {
  return new Proxy<unknown[]>([], {
    get: (target, key, receiver): unknown => {
      if (key === 'length') {
        throw new Error('unreadable length');
      }

      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

/** A proxy that throws on every operation, the least readable value there is. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  return proxy;
}

describe('elements that cannot be read', () => {
  it('rejects a statement that is not an object, and checks the statements beside it', () => {
    const summary = summarize(makeInteraction().events);

    // A bare string in the observed list is not a fact to check: the panel is
    // invalid, with `malformed-spec` at that string's own index.
    expect(validateAgainstCapture(withObserved(['fabricated']), summary)).toEqual({
      status: 'invalid',
      issues: [
        { path: ['summary', 'observed', 0], code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
      ],
      unverifiable: [],
    });

    const outcome = validateAgainstCapture(
      withObserved([null, fact([ref(ABSENT_EVENT_ID)]), [], 42]),
      summary,
      { resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]) },
    );

    expect(pathsOf(issuesOf(outcome))).toEqual([
      'summary.observed.0',
      'summary.observed.1.evidence.0.eventId',
      'summary.observed.2',
      'summary.observed.3',
    ]);
    expect(reasonsOf(issuesOf(outcome))).toEqual([
      'malformed-spec',
      'unknown-event-id',
      'malformed-spec',
      'malformed-spec',
    ]);

    const causes = {
      ...makeSpec(),
      summary: { observed: [], likelyCauses: ['a cause stated as prose'] },
    } as unknown as PanelSpec;

    expect(pathsOf(issuesOf(validateAgainstCapture(causes, summary)))).toEqual([
      'summary.likelyCauses.0',
    ]);
  });

  it('rejects a citation that is not an object or names no event, and checks the citations beside it', () => {
    const summary = summarize(makeInteraction().events);

    // A citation written as a bare id rather than an EventRef object is
    // refused as `malformed-spec` at its own evidence path.
    expect(
      issuesOf(
        validateAgainstCapture(
          withObserved([{ statement: 'A claim.', evidence: [ABSENT_EVENT_ID] }]),
          summary,
        ),
      ),
    ).toEqual([
      {
        path: ['summary', 'observed', 0, 'evidence', 0],
        code: MALFORMED_SPEC_CODE,
        reason: 'malformed-spec',
      },
    ]);

    const resolveEventIds = vi.fn<(ids: readonly string[]) => IdResolution>(() => ({
      known: new Set<string>(),
      unknown: new Set([ABSENT_EVENT_ID]),
    }));
    const spec = withObserved([
      {
        statement: 'A claim.',
        evidence: [
          ABSENT_EVENT_ID,
          {},
          { eventId: '   ' },
          { eventId: 42 },
          null,
          ref(ABSENT_EVENT_ID),
        ],
      },
    ]);
    const outcome = validateAgainstCapture(spec, summary, { resolveEventIds });

    expect(pathsOf(issuesOf(outcome))).toEqual([
      'summary.observed.0.evidence.0',
      'summary.observed.0.evidence.1.eventId',
      'summary.observed.0.evidence.2.eventId',
      'summary.observed.0.evidence.3.eventId',
      'summary.observed.0.evidence.4',
      'summary.observed.0.evidence.5.eventId',
    ]);
    expect(reasonsOf(issuesOf(outcome))).toEqual([
      'malformed-spec',
      'malformed-spec',
      'malformed-spec',
      'malformed-spec',
      'malformed-spec',
      'unknown-event-id',
    ]);
    // The readable citation was still decided, and it is the only id a
    // resolver was asked about: a citation of nothing names nothing to ask.
    expect(resolveEventIds.mock.calls).toEqual([[[ABSENT_EVENT_ID]]]);
  });

  it('reports an unknown node type at its type and still checks every node after it', () => {
    const summary = summarize(makeInteraction().events);
    const later = timelineNode(ABSENT_TRACE_ID, 'layout.1');

    // The same filter alone is refuted by the capture's complete trace list…
    expect(
      issuesOf(
        validateAgainstCapture(makeSpec({ layout: [timelineNode(ABSENT_TRACE_ID)] }), summary),
      ),
    ).toEqual([
      {
        path: ['layout', 0, 'query', 'filter', 'traceId'],
        code: 'panel_trace_unknown',
        reason: 'unknown-trace-id',
        nodeType: 'timeline',
      },
    ]);

    // …and an unrecognised node before it does not hide it: both are reported.
    expect(
      validateAgainstCapture(withLayout([{ type: 'gauge', id: 'layout.0' }, later]), summary),
    ).toEqual({
      status: 'invalid',
      issues: [
        { path: ['layout', 0, 'type'], code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
        {
          path: ['layout', 1, 'query', 'filter', 'traceId'],
          code: 'panel_trace_unknown',
          reason: 'unknown-trace-id',
          nodeType: 'timeline',
        },
      ],
      unverifiable: [],
    });

    // A missing or non-string type, and a node that is not an object at all.
    const assorted = withLayout([
      { id: 'layout.0' },
      { type: 7, id: 'layout.1' },
      'timeline',
      null,
      [],
      timelineNode(ABSENT_TRACE_ID, 'layout.5'),
    ]);

    expect(pathsOf(issuesOf(validateAgainstCapture(assorted, summary)))).toEqual([
      'layout.0.type',
      'layout.1.type',
      'layout.2',
      'layout.3',
      'layout.4',
      'layout.5.query.filter.traceId',
    ]);

    // Inside a catalogued container, the unknown child is reported and its
    // sibling checked; an unknown node's own fields are never walked, since
    // nothing says which of them hold children.
    const nested = withLayout([
      {
        type: 'section',
        id: 'layout.0',
        title: 'Fixture section',
        children: [
          {
            type: 'gauge',
            id: 'layout.0.children.0',
            children: [timelineNode(ABSENT_TRACE_ID, 'layout.0.children.0.children.0')],
          },
          timelineNode(ABSENT_TRACE_ID, 'layout.0.children.1'),
        ],
      },
    ]);

    expect(pathsOf(issuesOf(validateAgainstCapture(nested, summary)))).toEqual([
      'layout.0.children.0.type',
      'layout.0.children.1.query.filter.traceId',
    ]);
  });

  it('never throws on a node whose fields cannot be read, and reports it where it stands', () => {
    const summary = summarize(makeInteraction().events);
    const later = timelineNode(ABSENT_TRACE_ID, 'layout.1');
    const cases: readonly {
      readonly node: unknown;
      readonly path: readonly (string | number)[];
      readonly nodeType?: PanelNodeType;
    }[] = [
      // A node whose `type` getter throws is reported at
      // `['layout', 0, 'type']` with no node type, and the walk still checks
      // the node after it.
      { node: withThrowingField({ id: 'layout.0' }, 'type'), path: ['layout', 0, 'type'] },
      {
        node: withThrowingField({ type: 'timeline', id: 'layout.0' }, 'query'),
        path: ['layout', 0],
        nodeType: 'timeline',
      },
      {
        node: {
          type: 'timeline',
          id: 'layout.0',
          query: withThrowingField({ source: 'trace' }, 'filter'),
        },
        path: ['layout', 0],
        nodeType: 'timeline',
      },
      {
        node: withThrowingField(
          { type: 'metricCards', id: 'layout.0', query: { source: 'metrics' } },
          'metrics',
        ),
        path: ['layout', 0],
        nodeType: 'metricCards',
      },
      { node: revokedProxy(), path: ['layout', 0] },
      {
        node: withThrowingField({ type: 'section', id: 'layout.0', title: 'S' }, 'children'),
        path: ['layout', 0, 'children'],
        nodeType: 'section',
      },
      {
        node: { type: 'stack', id: 'layout.0', children: 'not a list' },
        path: ['layout', 0, 'children'],
        nodeType: 'stack',
      },
      {
        node: { type: 'split', id: 'layout.0' },
        path: ['layout', 0, 'children'],
        nodeType: 'split',
      },
      {
        node: { type: 'stack', id: 'layout.0', children: withUnreadableLength() },
        path: ['layout', 0, 'children'],
        nodeType: 'stack',
      },
    ];

    for (const [position, candidate] of cases.entries()) {
      const spec = withLayout([candidate.node, later]);
      const run = (): SemanticValidationOutcome =>
        validateAgainstCapture(spec, summary, { requireVerifiable: true });

      expect(run, String(position)).not.toThrow();

      const issues = issuesOf(run());
      const expected: SemanticIssue =
        candidate.nodeType === undefined
          ? { path: candidate.path, code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' }
          : {
              path: candidate.path,
              code: MALFORMED_SPEC_CODE,
              reason: 'malformed-spec',
              nodeType: candidate.nodeType,
            };

      expect(issues[0], String(position)).toEqual(expected);
      expect(pathsOf(issues.slice(1)), String(position)).toEqual(['layout.1.query.filter.traceId']);
    }

    // A layout element whose own read throws is reported at its position.
    const unreadable = withLayout(withThrowingElement([timelineNode(ABSENT_TRACE_ID), later], 0));

    expect(pathsOf(issuesOf(validateAgainstCapture(unreadable, summary)))).toEqual([
      'layout.0',
      'layout.1.query.filter.traceId',
    ]);
  });

  it('still walks a readable child of a container whose own fields threw', () => {
    const summary = summarize(makeInteraction().events);
    const section = withThrowingField(
      {
        type: 'section',
        id: 'layout.0',
        title: 'Fixture section',
        children: [timelineNode(ABSENT_TRACE_ID, 'layout.0.children.0')],
      },
      'query',
    );
    const issues = issuesOf(validateAgainstCapture(withLayout([section]), summary));

    expect(pathsOf(issues)).toEqual(['layout.0', 'layout.0.children.0.query.filter.traceId']);
    expect(issues.map((issue) => issue.nodeType)).toEqual(['section', 'timeline']);
  });

  it('reports a layout that contains itself once, and terminates', () => {
    const summary = summarize(makeInteraction().events);
    const children: unknown[] = [];
    const cyclic = { type: 'section', id: 'layout.0', title: 'Fixture section', children };

    children.push(cyclic, timelineNode(ABSENT_TRACE_ID, 'layout.0.children.1'));

    expect(pathsOf(issuesOf(validateAgainstCapture(withLayout([cyclic]), summary)))).toEqual([
      'layout.0.children.0',
      'layout.0.children.1.query.filter.traceId',
    ]);

    // One node object placed twice is not a cycle, and is checked at both places.
    const shared = timelineNode(ABSENT_TRACE_ID);

    expect(
      pathsOf(issuesOf(validateAgainstCapture(withLayout([shared, shared]), summary))),
    ).toEqual(['layout.0.query.filter.traceId', 'layout.1.query.filter.traceId']);
  });

  it('never throws on a statement or a citation whose fields cannot be read', () => {
    const summary = summarize(makeInteraction().events);
    const refuted = fact([ref(ABSENT_EVENT_ID)]);
    const cases: readonly { readonly statement: unknown; readonly path: string }[] = [
      // An evidence getter that throws is reported at the evidence path; the
      // validator itself does not throw, and still checks the next statement.
      {
        statement: withThrowingField({ statement: 'A claim.' }, 'evidence'),
        path: 'summary.observed.0.evidence',
      },
      {
        statement: { statement: 'A claim.', evidence: revokedProxy() },
        path: 'summary.observed.0.evidence',
      },
      {
        statement: { statement: 'A claim.', evidence: withUnreadableLength() },
        path: 'summary.observed.0.evidence',
      },
      {
        statement: {
          statement: 'A claim.',
          evidence: [withThrowingField({ label: 'chip' }, 'eventId')],
        },
        path: 'summary.observed.0.evidence.0',
      },
      {
        statement: {
          statement: 'A claim.',
          evidence: withThrowingElement([ref(ABSENT_EVENT_ID)], 0),
        },
        path: 'summary.observed.0.evidence.0',
      },
      { statement: revokedProxy(), path: 'summary.observed.0' },
    ];

    for (const [position, candidate] of cases.entries()) {
      const run = (): SemanticValidationOutcome =>
        validateAgainstCapture(withObserved([candidate.statement, refuted]), summary, {
          resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
        });

      expect(run, String(position)).not.toThrow();
      expect(pathsOf(issuesOf(run())), String(position)).toEqual([
        candidate.path,
        'summary.observed.1.evidence.0.eventId',
      ]);
      expect(reasonsOf(issuesOf(run())), String(position)).toEqual([
        'malformed-spec',
        'unknown-event-id',
      ]);
    }

    // A statement element whose own read throws is reported at its position.
    const unreadable = withObserved(withThrowingElement([refuted, refuted], 0));

    expect(
      pathsOf(
        issuesOf(
          validateAgainstCapture(unreadable, summary, {
            resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]),
          }),
        ),
      ),
    ).toEqual(['summary.observed.0', 'summary.observed.1.evidence.0.eventId']);
  });

  it('treats a root list whose length cannot be read as an unreadable root', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec();

    expect(
      pathsOf(issuesOf(validateAgainstCapture(withLayout(withUnreadableLength()), summary))),
    ).toEqual(['layout']);
    expect(
      pathsOf(
        issuesOf(
          validateAgainstCapture(
            {
              ...spec,
              summary: { observed: withUnreadableLength(), likelyCauses: [] },
            } as unknown as PanelSpec,
            summary,
          ),
        ),
      ),
    ).toEqual(['summary.observed']);
  });

  it('reads each root once, so a getter that answers differently later changes nothing', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)])],
      layout: [timelineNode(ABSENT_TRACE_ID)],
    });
    const options = { resolveEventIds: makeResolver([], [ABSENT_EVENT_ID]) };
    // Built afresh per call: each getter answers once.
    const once = (): PanelSpec =>
      readableOnce(spec, {
        layout: spec.layout,
        summary: readableOnce(spec.summary, {
          observed: spec.summary.observed,
          likelyCauses: spec.summary.likelyCauses,
        }),
      }) as PanelSpec;

    expect(validateAgainstCapture(once(), summary, options)).toEqual(
      validateAgainstCapture(spec, summary, options),
    );
    expect(collectSemanticIssues(once(), summary, options)).toEqual(
      collectSemanticIssues(spec, summary, options),
    );
  });

  it('reports a fallback flag that cannot be read, only where a caller requires findings', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    const required = { allowEmptyObserved: false } as const;
    const metaThrows = withThrowingField(makeSpec(), 'meta') as PanelSpec;
    const flagThrows = {
      ...makeSpec(),
      meta: withThrowingField({}, 'fallback'),
    } as unknown as PanelSpec;

    expect(pathsOf(issuesOf(validateAgainstCapture(metaThrows, summary, required)))).toEqual([
      'meta',
    ]);
    expect(pathsOf(issuesOf(validateAgainstCapture(flagThrows, summary, required)))).toEqual([
      'meta.fallback',
    ]);
    expect(reasonsOf(issuesOf(validateAgainstCapture(flagThrows, summary, required)))).toEqual([
      'malformed-spec',
    ]);

    // Never read otherwise: the flag decides nothing a caller did not ask for,
    // nor anything about a panel that has findings.
    expect(validateAgainstCapture(metaThrows, summary).status).toBe('valid');
    expect(
      validateAgainstCapture(
        withThrowingField(
          makeSpec({ observed: [fact([ref(interaction.slowestSpan.id)])] }),
          'meta',
        ) as PanelSpec,
        summary,
        required,
      ).status,
    ).toBe('valid');
  });

  it('maps unreadable elements onto the ordinary message, with their own hint', () => {
    const summary = summarize(makeInteraction().events);
    const spec = withLayout([
      { type: 'gauge', id: 'layout.0' },
      timelineNode(ABSENT_TRACE_ID, 'layout.1'),
    ]);
    const result = toResult(validateAgainstCapture(spec, summary), spec);

    if (isOk(result)) {
      throw new Error('a panel with an unreadable element must map to an error');
    }

    const { error } = result;

    expect(error.code).toBe('PANEL_SEMANTIC_INVALID');
    // The rest of the document was checked, so the message does not say
    // otherwise: it is the ordinary one, naming both findings.
    expect(error.message).toBe(
      `A panel specification failed semantic validation against its capture in 2 checks: layout.0.type (${MALFORMED_SPEC_CODE}), layout.1.query.filter.traceId (panel_trace_unknown).`,
    );
    expect(error.message).not.toContain('not a readable panel specification');
    expect(error.hint).toContain('node catalog');
    expect(error.hint).toContain('validatePanelSpec');
    expect(error.hint).not.toContain('nothing else in the value was checked');
    expect(error.details?.issues).toEqual([
      { path: 'layout.0.type', code: MALFORMED_SPEC_CODE, reason: 'malformed-spec' },
      {
        path: 'layout.1.query.filter.traceId',
        code: 'panel_trace_unknown',
        reason: 'unknown-trace-id',
        nodeType: 'timeline',
      },
    ]);
    expect(Object.keys(error.toPayload()).sort()).toEqual(['code', 'hint', 'message']);
  });

  it('never carries a rejected value into a report about an unreadable element', () => {
    const summary = summarize(makeInteraction().events);
    const sentinels = [
      SENTINEL_PANEL_TITLE,
      SENTINEL_NODE_TITLE,
      SENTINEL_STATEMENT,
      SENTINEL_EVENT_ID,
      SENTINEL_TRACE_ID,
      SENTINEL_LABEL,
    ];
    const spec = {
      ...makeSpec({ title: SENTINEL_PANEL_TITLE }),
      summary: {
        observed: [
          SENTINEL_STATEMENT,
          {
            statement: SENTINEL_STATEMENT,
            evidence: [SENTINEL_EVENT_ID, { label: SENTINEL_LABEL }],
          },
        ],
        likelyCauses: [],
      },
      layout: [
        { type: SENTINEL_NODE_TITLE, id: 'layout.0', title: SENTINEL_NODE_TITLE },
        {
          type: 'timeline',
          id: 'layout.1',
          title: SENTINEL_NODE_TITLE,
          query: { source: 'trace', filter: { traceId: SENTINEL_TRACE_ID } },
        },
      ],
    } as unknown as PanelSpec;
    const options = { resolveTraceIds: makeResolver([], [SENTINEL_TRACE_ID]) };
    const outcome = validateAgainstCapture(spec, summary, options);
    const result = toResult(outcome, spec);

    expect(pathsOf(issuesOf(outcome))).toEqual([
      'layout.0.type',
      'layout.1.query.filter.traceId',
      'summary.observed.0',
      'summary.observed.1.evidence.0',
      'summary.observed.1.evidence.1.eventId',
    ]);

    if (isOk(result)) {
      throw new Error('a panel with unreadable elements must map to an error');
    }

    const reported = JSON.stringify({
      issues: issuesOf(outcome),
      collected: collectSemanticIssues(spec, summary, options),
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
});

/*
 * ---------------------------------------------------------------------------
 * Inputs beside the specification that cannot be read
 *
 * The capture and a resolver's answer arrive from outside this module too. A
 * read of either that throws must neither throw out of the validator nor
 * decide anything: a capture that cannot be read in full vouches for nothing
 * and refutes nothing, and an answer that cannot be read is one that declined.
 * ---------------------------------------------------------------------------
 */

describe('inputs beside the specification that cannot be read', () => {
  it('reads a capture whose reads throw as one that publishes nothing: never valid, never thrown', () => {
    const interaction = makeInteraction();
    const summary = summarize(interaction.events);
    // Checkable claims the readable capture attests to in full.
    const spec = makeSpec({
      observed: [fact([ref(interaction.slowestSpan.id)])],
      layout: [timelineNode(interaction.traceId)],
    });

    expect(validateAgainstCapture(spec, summary)).toEqual({ status: 'valid' });

    const trapping = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    const unreadable: readonly unknown[] = [
      // A capture whose `traceIds` getter throws vouches for nothing: the
      // validator returns an outcome rather than throwing, and leaves the
      // claims it would have checked unverifiable.
      withThrowingField(summary, 'traceIds'),
      revokedProxy(),
      trapping,
      { ...summary, topSpans: withThrowingElement(summary.topSpans, 0) },
      { ...summary, metrics: withThrowingElement(summary.metrics, 0) },
      { ...summary, kindCounts: trapping },
    ];

    for (const [position, candidate] of unreadable.entries()) {
      const capture = candidate as CaptureSummary;
      const run = (options?: SemanticValidationOptions): SemanticValidationOutcome =>
        validateAgainstCapture(spec, capture, options);

      expect(() => run(), String(position)).not.toThrow();
      // Nothing is attested, so the claims are undecided rather than passed…
      expect(run().status, String(position)).toBe('unverifiable');
      expect(pathsOf(unverifiableOf(run())), String(position)).toEqual([
        'layout.0.query.filter.traceId',
        'summary.observed.0.evidence.0.eventId',
      ]);
      // …a caller demanding certainty is refused…
      expect(run({ requireVerifiable: true }).status, String(position)).toBe('invalid');
      // …and a resolver still decides them, either way.
      expect(
        run({
          resolveEventIds: makeResolver([interaction.slowestSpan.id], []),
          resolveTraceIds: makeResolver([interaction.traceId], []),
        }).status,
        String(position),
      ).toBe('valid');
      expect(
        reasonsOf(
          issuesOf(
            run({
              resolveEventIds: makeResolver([], [interaction.slowestSpan.id]),
              resolveTraceIds: makeResolver([], [interaction.traceId]),
            }),
          ),
        ),
        String(position),
      ).toEqual(['unknown-trace-id', 'unknown-event-id']);
    }
  });

  it('never lets a partly readable capture refute anything on its own', () => {
    // An empty capture refutes every citation and — with its complete, empty
    // trace list — every trace filter…
    const empty = makeCaptureSummary();
    const spec = makeSpec({
      observed: [fact([ref(ABSENT_EVENT_ID)])],
      layout: [timelineNode(ABSENT_TRACE_ID), metricCardsNode([OBSERVABLE_METRIC], 'layout.1')],
    });

    expect(reasonsOf(issuesOf(validateAgainstCapture(spec, empty)))).toEqual([
      'unknown-trace-id',
      'unknown-event-id',
    ]);

    // …but the same capture with one field that cannot be read vouches for
    // nothing, so it refutes nothing: not the citation, not the trace, and not
    // the metric tile whose values it could not be read for.
    for (const key of ['primaryTraceId', 'metrics', 'tierCounts']) {
      const capture = withThrowingField(empty, key) as CaptureSummary;
      const sets = collectSemanticIssues(spec, capture);

      expect(sets.issues, key).toEqual([]);
      expect(reasonsOf(sets.unverifiable), key).toEqual([
        'unverifiable-trace-id',
        'unverifiable-event-id',
      ]);
      expect(sets.advisory, key).toEqual([]);
      expect(sets.informational, key).toEqual([]);
    }

    // A document with nothing to check is valid against any capture.
    expect(validateAgainstCapture(makeSpec(), revokedProxy() as CaptureSummary)).toEqual({
      status: 'valid',
    });
  });

  it('treats a resolver whose answer throws while being read as one that declined', () => {
    const summary = summarize(makeInteraction().events);
    const spec = makeSpec({ observed: [fact([ref(ABSENT_EVENT_ID)])] });
    const answers: readonly unknown[] = [
      withThrowingField({ unknown: new Set([ABSENT_EVENT_ID]) }, 'known'),
      {
        known: new Set<string>(),
        unknown: {
          [Symbol.iterator]: () => {
            throw new Error('unreadable iterator');
          },
        },
      },
      revokedProxy(),
    ];

    for (const [position, answer] of answers.entries()) {
      const run = (): SemanticValidationOutcome =>
        validateAgainstCapture(spec, summary, {
          resolveEventIds: () => answer as IdResolution,
        });

      expect(run, String(position)).not.toThrow();
      expect(run().status, String(position)).toBe('unverifiable');
    }
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
