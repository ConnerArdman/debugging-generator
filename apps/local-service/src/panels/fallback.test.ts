/**
 * Colocated tests for `./fallback.ts`: the deterministic fallback panel.
 *
 * The fallback is what the developer sees when a generated panel is rejected
 * (AAP 0.5.3, 0.5.5), so this suite holds it to the standard a model-generated
 * panel is held to. If a change lets the fallback emit an uncatalogued node, an
 * unvalidated specification or a fabricated fact, a block below fails:
 *
 * 1. **Harness.** The builders produce a valid `CaptureSummary` (computed by
 *    `@debuggen/telemetry` from synthetic events, one `MetricValue` per
 *    `METRIC_IDS` member in order) and a valid `AnalysisResult` (assembled by
 *    `@debuggen/protocol` and re-parsed), so no test runs on a malformed input.
 * 2. **The three load-bearing guarantees.** Every built spec carries
 *    `meta.fallback === true` and that flag flows only from
 *    `NormalizeContext.fallback`; every built spec passes `validatePanelSpec`,
 *    conforms node by node to `PANEL_NODE_CATALOG`, and passes the real
 *    validator's semantic step against the capture; and the summary's facts and
 *    likely causes are exactly the analysis's — nothing is invented to fill an
 *    empty analysis, and the failure reason never becomes a statement.
 * 3. **Evidence-gated selection.** Each per-concern view appears exactly when
 *    the capture holds its evidence — from its bounded section or from the
 *    catalog's kind tally — the overview and the slowest-operations table are
 *    unconditional for a capture with events, a timeline names only a real
 *    trace, and an empty capture still yields a valid, non-blank layout.
 * 4. **Determinism, purity and privacy.** Equal inputs give byte-identical
 *    output whatever the clock or the random source says; frozen inputs are
 *    neither written nor changed; the banner sentence is the AAP's verbatim; no
 *    planted fact statement, trace id, captured attribute or credential-shaped
 *    value reaches an error or a log record on a failed build; every failure is
 *    a typed `Err` with a closed-vocabulary code and a named stage; and the
 *    module does not import the fact candidates of `../analysis/facts.ts`.
 *
 * ## Fixture conventions
 *
 * The same as the sibling suites: in-file synthetic builders and in-file
 * structural fakes, no fixture files, no module mocking, no store, no socket and
 * no timer. The validator is the real one from `./validate.ts`, over a stub
 * evidence port that knows exactly the event and trace ids planted here. Ids are
 * minted from explicit ordinals in the formats `@debuggen/shared` mints, so a
 * run is identical whichever tests are selected or in which order they run.
 * Every node type, data source, sort and metric id an assertion depends on is
 * read from the imported vocabularies rather than restated. Names are invented
 * and generic — nothing names a symbol or route of any real project (AAP 0.5.4)
 * — and the credential-shaped sentinel is assembled at run time from fragments,
 * so the tracked file holds no token literal (AAP 0.3.4).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
  PANEL_NODE_CATALOG,
  PANEL_NODE_TYPES,
  normalizePanel,
  parsePanelSpecInput,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  Fact,
  Hypothesis,
  IdResolution,
  PanelNode,
  PanelNodeType,
  PanelSectionNode,
  PanelSpec,
} from '@debuggen/panel-schema';
import {
  ANALYSIS_VERSION_START,
  createAnalysisResult,
  parseAnalysisResult,
} from '@debuggen/protocol';
import type { AnalysisResult } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  ID_PREFIXES,
  createConsoleLogger,
  err,
  isTraceId,
  ok,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogRecord,
  PanelId,
  ProducerId,
  Result,
  SessionId,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import {
  DEFAULT_TOP_N,
  METRIC_IDS,
  TELEMETRY_TIERS,
  computeCaptureSummary,
  isTierAllowedForKind,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  MetricId,
  MetricValue,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
} from '@debuggen/telemetry';

import {
  FALLBACK_BANNER_MESSAGE,
  FALLBACK_BUILD_STAGES,
  FALLBACK_HEADLINES,
  FALLBACK_REASONS,
  FALLBACK_SECTION_TITLES,
  FALLBACK_TITLE,
  buildFallbackInput,
  createFallbackPanelBuilder,
  fallbackMetricIds,
  isFallbackReason,
  selectFallbackNodes,
} from './fallback.js';
import type {
  FallbackBuildRequest,
  FallbackNodeType,
  FallbackPanelBuilder,
  FallbackReason,
  FallbackSelection,
} from './fallback.js';
import { PANEL_FAILURE_CLASSES, createPanelValidator } from './validate.js';
import type { CaptureSummaryPort, PanelEvidenceResolverPort, PanelValidator } from './validate.js';

/* -------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/** The element at `index`, failing the test loudly rather than yielding `undefined`. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`fixture has no element at index ${String(index)}`);
  }
  return item;
}

/** Freezes `value` and everything reachable from it, so any write by the unit under test throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/** The value of `result`, failing the test with the error's code and message otherwise. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of `result`, failing the test when it succeeded. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('expected an error, got ok');
  }
  return result.error;
}

/** A copy of `value` whose properties may be deleted, for removing an optional field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/* -------------------------------------------------------------------------------------------------
 * Deterministic identities
 * ---------------------------------------------------------------------------------------------- */

/** Characters after the prefix and underscore of an opaque id, as `newId` mints it. */
const OPAQUE_SUFFIX_LENGTH = 16;

/** Hex width of a W3C trace id. */
const TRACE_ID_WIDTH = 32;

/** Hex width of a W3C span id. */
const SPAN_ID_WIDTH = 16;

/** An opaque id of the minted shape — `<prefix>_<16 base-36 characters>` — for `ordinal`. */
function opaqueId(prefix: string, ordinal: number): string {
  return `${prefix}_${ordinal.toString(36).padStart(OPAQUE_SUFFIX_LENGTH, '0')}`;
}

/** A lowercase hex id of `width` characters for `ordinal`; never all zero. */
function hexId(ordinal: number, width: number): string {
  return (ordinal + 1).toString(16).padStart(width, '0');
}

/** The session every fixture belongs to. */
const SESSION: SessionId = opaqueId(ID_PREFIXES.session, 1);

/** A second session, for the scope refusal. */
const OTHER_SESSION: SessionId = opaqueId(ID_PREFIXES.session, 2);

/** The capture every fixture belongs to. */
const CAPTURE: CaptureId = opaqueId(ID_PREFIXES.capture, 1);

/** A second capture, for the scope refusal. */
const OTHER_CAPTURE: CaptureId = opaqueId(ID_PREFIXES.capture, 2);

/** The id of the analysis fixture. */
const ANALYSIS_ID = opaqueId(ID_PREFIXES.analysis, 1);

/** The id the injected factory mints for every panel. */
const PANEL_ID: PanelId = opaqueId(ID_PREFIXES.panel, 1);

/** The id of the panel a regeneration supersedes. */
const PREVIOUS_PANEL_ID: PanelId = opaqueId(ID_PREFIXES.panel, 7);

/** The producer every fixture event is emitted by. */
const PRODUCER: ProducerId = opaqueId(ID_PREFIXES.producer, 1);

/** The longest trace of the rich capture: the one a timeline must name. */
const TRACE_MAIN: TraceId = hexId(1, TRACE_ID_WIDTH);

/** A short second trace of the rich capture. */
const TRACE_SHORT: TraceId = hexId(2, TRACE_ID_WIDTH);

/**
 * The epoch millisecond every offset is measured from — fractional, because
 * event times are doubles with sub-millisecond precision.
 */
const BASE_TIME = 1_768_000_000_000.375;

/** When the analysis fixture was produced: injected, so no clock is read. */
const ANALYSIS_CREATED_AT = 1_768_000_100_000;

/** `offsetMs` after {@link BASE_TIME}. */
function time(offsetMs: number): number {
  return BASE_TIME + offsetMs;
}

/** A fixed panel-id factory: every build mints the same id. */
const fixedPanelId = (): PanelId => PANEL_ID;

/** The panel version every default request builds. */
const FIRST_PANEL_VERSION = 1;

/** The reason every default request names; a member of the failure taxonomy. */
const DEFAULT_REASON: FallbackReason = 'semantic';

/* -------------------------------------------------------------------------------------------------
 * Sentinels — planted values that must never reach an error or a log record
 * ---------------------------------------------------------------------------------------------- */

/** Invented segments, searched for individually so a partial leak is caught too. */
const SENTINEL_SEGMENTS: readonly string[] = ['bramblewick', 'tesserafold', 'quonsetlark'];

/** The planted plain-text sentinel. */
const SENTINEL = `${SENTINEL_SEGMENTS.join('-')}-never-log-me`;

/**
 * A credential-shaped value — three base64url segments joined by dots, the
 * shape of a signed token — assembled from fragments so no token literal is
 * tracked, and searched for by its distinctive middle segment.
 */
const SECRET_SEGMENT = ['c2VudGluZWw', 'ZmFsbGJhY2s'].join('');
const SECRET_SENTINEL = [['ey', 'J'].join('') + 'hbGciOiJub25lIn0', SECRET_SEGMENT, 'ZmFrZQ'].join(
  '.',
);

/** A distinctive, valid trace id: the primary trace of the leak capture. */
const SENTINEL_TRACE: TraceId = ['feedface', 'feedface', 'feedface', 'c0ffee42'].join('');

/** Every fragment the privacy checks search for. */
const LEAK_MARKERS: readonly string[] = [...SENTINEL_SEGMENTS, SECRET_SEGMENT, SENTINEL_TRACE];

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The first tier of `TELEMETRY_TIERS` the kind/tier table permits for `kind`. */
function tierFor(kind: TelemetryKind): TelemetryTier {
  const tier = TELEMETRY_TIERS.find((candidate) => isTierAllowedForKind(kind, candidate));
  if (tier === undefined) {
    throw new Error(`no tier is allowed for kind ${kind}`);
  }
  return tier;
}

/** What a fixture may vary about one persisted event. */
interface EventOverrides {
  readonly kind: TelemetryKind;
  readonly traceId: TraceId;
  readonly name: string;
  readonly startOffsetMs: number;
  readonly durationMs: number;
  readonly parentSpanId?: SpanId;
  readonly attributes?: Record<string, unknown>;
}

/** Mints persisted events from `firstOrdinal` upwards, independently of every other factory. */
type EventFactory = (overrides: EventOverrides) => TelemetryEvent;

/**
 * An event factory with its own counter, so a fixture list is the same
 * whichever tests run and in whichever order. Distinct `firstOrdinal`s keep the
 * ids of two lists disjoint.
 */
function eventFactory(firstOrdinal: number): EventFactory {
  let ordinal = firstOrdinal;
  return (overrides) => {
    ordinal += 1;
    return {
      id: opaqueId(ID_PREFIXES.event, ordinal),
      traceId: overrides.traceId,
      spanId: hexId(ordinal, SPAN_ID_WIDTH),
      ...(overrides.parentSpanId === undefined ? {} : { parentSpanId: overrides.parentSpanId }),
      kind: overrides.kind,
      name: overrides.name,
      startTime: time(overrides.startOffsetMs),
      duration: overrides.durationMs,
      tier: tierFor(overrides.kind),
      attributes: overrides.attributes ?? {},
      status: 'ok',
      producerId: PRODUCER,
      seq: ordinal,
      sessionId: SESSION,
      captureId: CAPTURE,
      ingestSeq: ordinal,
    };
  };
}

/** Request attributes carrying the ingest-assigned grouping key and an already-masked URL. */
function requestAttributes(url: string, requestKey: string): Record<string, unknown> {
  return { 'http.method': 'GET', url, 'http.status_code': 200, request_key: requestKey };
}

/** Database attributes with a parameterised statement. */
function queryAttributes(statement: string): Record<string, unknown> {
  return { 'db.system': 'postgresql', 'db.statement': statement };
}

/** Render attributes for `component`. */
function renderAttributes(component: string): Record<string, unknown> {
  return { component, phase: 'update', trigger: 'props' };
}

/** Hook-state transition attributes for `component`. */
function stateAttributes(component: string): Record<string, unknown> {
  return {
    component,
    hookIndex: 0,
    previousValue: { type: 'number', preview: '1', truncated: false },
    nextValue: { type: 'number', preview: '2', truncated: false },
  };
}

const richEvent = eventFactory(0);

/** The slow interaction every other span of the main trace descends from. */
const RICH_INTERACTION = richEvent({
  kind: 'interaction',
  traceId: TRACE_MAIN,
  name: 'click',
  startOffsetMs: 0,
  durationMs: 400,
});

/** The handler the interaction ran. */
const RICH_HANDLER = richEvent({
  kind: 'function',
  traceId: TRACE_MAIN,
  name: 'handleSubmit',
  startOffsetMs: 2,
  durationMs: 380,
  parentSpanId: RICH_INTERACTION.spanId,
});

/** The first of two byte-identical requests. */
const RICH_REQUEST_A = richEvent({
  kind: 'fetch',
  traceId: TRACE_MAIN,
  name: 'GET',
  startOffsetMs: 5,
  durationMs: 300,
  parentSpanId: RICH_HANDLER.spanId,
  attributes: requestAttributes('/v1/items?page=?', 'rk-items'),
});

/** The duplicate of {@link RICH_REQUEST_A}. */
const RICH_REQUEST_B = richEvent({
  kind: 'fetch',
  traceId: TRACE_MAIN,
  name: 'GET',
  startOffsetMs: 12,
  durationMs: 290,
  parentSpanId: RICH_HANDLER.spanId,
  attributes: requestAttributes('/v1/items?page=?', 'rk-items'),
});

/** The server span the first request produced. */
const RICH_SERVER = richEvent({
  kind: 'http.server',
  traceId: TRACE_MAIN,
  name: 'GET /v1/items',
  startOffsetMs: 8,
  durationMs: 280,
  parentSpanId: RICH_REQUEST_A.spanId,
});

/** The statement that dominates the server span. */
const RICH_QUERY = richEvent({
  kind: 'db.query',
  traceId: TRACE_MAIN,
  name: 'SELECT',
  startOffsetMs: 10,
  durationMs: 200,
  parentSpanId: RICH_SERVER.spanId,
  attributes: queryAttributes('SELECT * FROM ledger_items WHERE shelf = $1'),
});

/** Two renders of one component and a state transition between them. */
const RICH_RENDER_A = richEvent({
  kind: 'render',
  traceId: TRACE_MAIN,
  name: 'LedgerTile',
  startOffsetMs: 320,
  durationMs: 4,
  parentSpanId: RICH_INTERACTION.spanId,
  attributes: renderAttributes('LedgerTile'),
});
const RICH_STATE = richEvent({
  kind: 'state',
  traceId: TRACE_MAIN,
  name: 'state',
  startOffsetMs: 325,
  durationMs: 0,
  parentSpanId: RICH_INTERACTION.spanId,
  attributes: stateAttributes('LedgerTile'),
});
const RICH_RENDER_B = richEvent({
  kind: 'render',
  traceId: TRACE_MAIN,
  name: 'LedgerTile',
  startOffsetMs: 330,
  durationMs: 3,
  parentSpanId: RICH_INTERACTION.spanId,
  attributes: renderAttributes('LedgerTile'),
});

/** A short, unrelated interaction on a second trace. */
const RICH_SHORT_INTERACTION = richEvent({
  kind: 'interaction',
  traceId: TRACE_SHORT,
  name: 'keydown',
  startOffsetMs: 600,
  durationMs: 20,
});

/** A capture holding evidence for every per-concern view the fallback can draw. */
const RICH_EVENTS: readonly TelemetryEvent[] = Object.freeze([
  RICH_INTERACTION,
  RICH_HANDLER,
  RICH_REQUEST_A,
  RICH_REQUEST_B,
  RICH_SERVER,
  RICH_QUERY,
  RICH_RENDER_A,
  RICH_STATE,
  RICH_RENDER_B,
  RICH_SHORT_INTERACTION,
]);

const leakEvent = eventFactory(1_000);

/** The leak capture: every row that can carry captured text carries a sentinel. */
const LEAK_INTERACTION = leakEvent({
  kind: 'interaction',
  traceId: SENTINEL_TRACE,
  name: 'click',
  startOffsetMs: 0,
  durationMs: 500,
});
const LEAK_REQUEST = leakEvent({
  kind: 'fetch',
  traceId: SENTINEL_TRACE,
  name: 'GET',
  startOffsetMs: 4,
  durationMs: 300,
  parentSpanId: LEAK_INTERACTION.spanId,
  attributes: requestAttributes(`/v1/lookup/${SENTINEL}?token=?`, 'rk-lookup'),
});
const LEAK_QUERY = leakEvent({
  kind: 'db.query',
  traceId: SENTINEL_TRACE,
  name: 'SELECT',
  startOffsetMs: 20,
  durationMs: 150,
  parentSpanId: LEAK_REQUEST.spanId,
  attributes: queryAttributes(`SELECT * FROM notes WHERE body = '${SECRET_SENTINEL}'`),
});
const LEAK_RENDER = leakEvent({
  kind: 'render',
  traceId: SENTINEL_TRACE,
  name: SENTINEL,
  startOffsetMs: 320,
  durationMs: 6,
  parentSpanId: LEAK_INTERACTION.spanId,
  attributes: renderAttributes(SENTINEL),
});

const LEAK_EVENTS: readonly TelemetryEvent[] = Object.freeze([
  LEAK_INTERACTION,
  LEAK_REQUEST,
  LEAK_QUERY,
  LEAK_RENDER,
]);

/** Every event id and trace id the stub evidence port confirms. */
const PLANTED_EVENT_IDS: ReadonlySet<string> = new Set(
  [...RICH_EVENTS, ...LEAK_EVENTS].map((event) => event.id),
);
const PLANTED_TRACE_IDS: ReadonlySet<string> = new Set(
  [...RICH_EVENTS, ...LEAK_EVENTS].map((event) => event.traceId),
);

/* -------------------------------------------------------------------------------------------------
 * Summary and analysis builders
 * ---------------------------------------------------------------------------------------------- */

/** What a case may vary about a capture summary: the events it is computed from, then any field. */
interface SummaryOverrides extends Partial<CaptureSummary> {
  /** The events the summary is computed from; none by default (an empty capture). */
  readonly events?: readonly TelemetryEvent[];
}

/**
 * A valid `CaptureSummary`, computed by `@debuggen/telemetry` itself from
 * `events` for {@link CAPTURE} of {@link SESSION} — capture identity, window,
 * per-tier and per-kind counts, one metric value per `METRIC_IDS` member in
 * order, the bounded sections and their `truncated` flag — then overlaid with
 * any field a case names.
 */
function makeCaptureSummary(overrides: SummaryOverrides = {}): CaptureSummary {
  const { events = [], ...fields } = overrides;
  return {
    ...computeCaptureSummary(events, { captureId: CAPTURE, sessionId: SESSION }),
    ...fields,
  };
}

/** The summary of the rich capture. */
const RICH_SUMMARY: CaptureSummary = deepFreeze(makeCaptureSummary({ events: RICH_EVENTS }));

/** The summary of the leak capture. */
const LEAK_SUMMARY: CaptureSummary = deepFreeze(makeCaptureSummary({ events: LEAK_EVENTS }));

/** The summary of a capture that recorded nothing. */
const EMPTY_SUMMARY: CaptureSummary = deepFreeze(makeCaptureSummary());

/** The default observed facts: each cites events of the rich capture. */
const DEFAULT_OBSERVED: readonly Fact[] = [
  {
    statement: 'The longest interaction took 400 ms from input to its last span.',
    evidence: [{ eventId: RICH_INTERACTION.id, traceId: TRACE_MAIN, kind: 'interaction' }],
  },
  {
    statement: 'Two byte-identical requests started 7 ms apart.',
    evidence: [{ eventId: RICH_REQUEST_A.id }, { eventId: RICH_REQUEST_B.id }],
  },
];

/** The default likely cause: cites the dominant statement. */
const DEFAULT_LIKELY_CAUSES: readonly Hypothesis[] = [
  {
    statement: 'The database statement accounts for most of the server time.',
    evidence: [{ eventId: RICH_QUERY.id, kind: 'db.query' }],
    confidence: 'medium',
  },
];

/** What a case may vary about an analysis. */
interface AnalysisOverrides {
  readonly observed?: readonly Fact[];
  readonly likelyCauses?: readonly Hypothesis[];
  readonly sessionId?: SessionId;
  readonly captureId?: CaptureId;
  readonly metrics?: readonly MetricValue[];
}

/**
 * A valid `AnalysisResult`, assembled by `@debuggen/protocol`'s one constructor
 * with an injected id and timestamp, so no clock is read and no id is minted.
 */
function makeAnalysisResult(overrides: AnalysisOverrides = {}): AnalysisResult {
  return createAnalysisResult(
    {
      observed: [...(overrides.observed ?? DEFAULT_OBSERVED)],
      likelyCauses: [...(overrides.likelyCauses ?? DEFAULT_LIKELY_CAUSES)],
    },
    {
      id: ANALYSIS_ID,
      sessionId: overrides.sessionId ?? SESSION,
      captureId: overrides.captureId ?? CAPTURE,
      analysisVersion: ANALYSIS_VERSION_START,
      createdAt: ANALYSIS_CREATED_AT,
      metrics: overrides.metrics ?? RICH_SUMMARY.metrics,
    },
  );
}

/** The default analysis: two facts and one likely cause about the rich capture. */
const DEFAULT_ANALYSIS: AnalysisResult = deepFreeze(makeAnalysisResult());

/** An analysis that established nothing. */
const EMPTY_ANALYSIS: AnalysisResult = deepFreeze(
  makeAnalysisResult({ observed: [], likelyCauses: [], metrics: EMPTY_SUMMARY.metrics }),
);

/** An analysis whose facts carry the plain-text and credential-shaped sentinels. */
const LEAK_ANALYSIS: AnalysisResult = deepFreeze(
  makeAnalysisResult({
    observed: [
      {
        statement: `The request to ${SENTINEL} carried ${SECRET_SENTINEL}.`,
        evidence: [{ eventId: LEAK_REQUEST.id, traceId: SENTINEL_TRACE }],
      },
    ],
    likelyCauses: [
      {
        statement: `A render of ${SENTINEL} followed the statement.`,
        evidence: [{ eventId: LEAK_RENDER.id }],
        confidence: 'low',
      },
    ],
    metrics: LEAK_SUMMARY.metrics,
  }),
);

/* -------------------------------------------------------------------------------------------------
 * Fakes and the harness
 * ---------------------------------------------------------------------------------------------- */

/** Answers an id lookup from a known set: every id is decided, known or unknown. */
function resolveFrom(known: ReadonlySet<string>): (ids: readonly string[]) => IdResolution {
  return (ids) => ({
    known: new Set(ids.filter((id) => known.has(id))),
    unknown: new Set(ids.filter((id) => !known.has(id))),
  });
}

/** One `createEvidenceResolvers` call the stub port received. */
interface ResolverCall {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId | undefined;
}

/**
 * The stub evidence port: it confirms exactly the event and trace ids planted
 * by this file's fixtures, and records who asked.
 */
function createEvidencePort(calls: ResolverCall[]): PanelEvidenceResolverPort {
  return {
    createEvidenceResolvers: (sessionId, captureId) => {
      calls.push({ sessionId, captureId });
      return {
        resolveEventIds: resolveFrom(PLANTED_EVENT_IDS),
        resolveTraceIds: resolveFrom(PLANTED_TRACE_IDS),
      };
    },
  };
}

/** A capture-summary port answering from a fixed result, recording each load. */
interface FakeSummaryPort extends CaptureSummaryPort {
  readonly loads: { readonly sessionId: string; readonly captureId: string }[];
}

/** A summary port that answers `answer` (or throws it, when `throws` is set). */
function createSummaryPort(
  answer: Result<CaptureSummary, DebuggenError>,
  options: { readonly throws?: boolean } = {},
): FakeSummaryPort {
  const loads: { readonly sessionId: string; readonly captureId: string }[] = [];
  return {
    loads,
    loadCaptureSummary: (sessionId, captureId) => {
      loads.push({ sessionId, captureId });
      if (options.throws === true) {
        return Promise.reject(new Error('the summary store is unreadable'));
      }
      return Promise.resolve(answer);
    },
  };
}

/** A builder over the real validator, with every log record kept for the privacy checks. */
interface Harness {
  readonly builder: FallbackPanelBuilder;
  /** The real validator, over the stub evidence port and the same log sink. */
  readonly validator: PanelValidator;
  readonly records: LogRecord[];
  readonly resolverCalls: ResolverCall[];
}

/** What a harness may replace. */
interface HarnessOptions {
  /** Replaces the real validator as the builder's syntactic gate. */
  readonly gate?: (real: PanelValidator) => Pick<PanelValidator, 'validateSpec'>;
  readonly captures?: CaptureSummaryPort;
  readonly newId?: () => PanelId;
}

/** Builds a fallback builder over the real validator, a stable id factory and a capturing logger. */
function harness(options: HarnessOptions = {}): Harness {
  const records: LogRecord[] = [];
  const resolverCalls: ResolverCall[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  const validator = createPanelValidator({
    evidence: createEvidencePort(resolverCalls),
    logger,
  });
  const builder = createFallbackPanelBuilder({
    validator: options.gate === undefined ? validator : options.gate(validator),
    captures: options.captures,
    logger,
    newId: options.newId ?? fixedPanelId,
  });
  return { builder, validator, records, resolverCalls };
}

/** The request most cases build: the rich capture, the default analysis, a first panel. */
function buildRequest(overrides: Partial<FallbackBuildRequest> = {}): FallbackBuildRequest {
  return {
    sessionId: SESSION,
    captureId: CAPTURE,
    analysis: DEFAULT_ANALYSIS,
    summary: RICH_SUMMARY,
    panelVersion: FIRST_PANEL_VERSION,
    reason: DEFAULT_REASON,
    ...overrides,
  };
}

/** Builds and fails the test unless a spec came back. */
async function built(
  overrides: Partial<FallbackBuildRequest> = {},
  options: HarnessOptions = {},
): Promise<PanelSpec> {
  return expectOk(await harness(options).builder.build(buildRequest(overrides)));
}

/* -------------------------------------------------------------------------------------------------
 * Spec inspection
 * ---------------------------------------------------------------------------------------------- */

/** Every node of a layout in walk order, through the package's one traversal. */
function allNodes(spec: PanelSpec): readonly PanelNode[] {
  const nodes: PanelNode[] = [];
  walkPanelNodes(spec.layout, (node) => {
    nodes.push(node);
  });
  return nodes;
}

/** The top-level sections of a fallback spec; any other top-level node fails the test. */
function sectionsOf(spec: PanelSpec): readonly PanelSectionNode[] {
  return spec.layout.map((node) => {
    if (node.type !== 'section') {
      throw new Error(`expected a top-level section, got ${node.type}`);
    }
    return node;
  });
}

/** The single view inside each top-level section, in layout order. */
function viewsOf(spec: PanelSpec): readonly PanelNode[] {
  return sectionsOf(spec).map((section) => {
    expect(section.children).toHaveLength(1);
    return nth(section.children, 0);
  });
}

/** The view node types of a spec, in layout order. */
function viewTypesOf(spec: PanelSpec): readonly PanelNodeType[] {
  return viewsOf(spec).map((node) => node.type);
}

/** The node types a selection chose, in order. */
function selectedTypes(selection: FallbackSelection): readonly FallbackNodeType[] {
  return selection.nodes.map((choice) => choice.type);
}

/** The data request of a node, when its type carries one. */
function queryOf(node: PanelNode): DataQuery | undefined {
  return 'query' in node ? node.query : undefined;
}

/** The first view of `type` in a spec, failing the test when there is none. */
function viewOfType(spec: PanelSpec, type: FallbackNodeType): PanelNode {
  const view = viewsOf(spec).find((node) => node.type === type);
  if (view === undefined) {
    throw new Error(`expected a ${type} view`);
  }
  return view;
}

/**
 * Asserts, node by node through `walkPanelNodes`, everything the catalog says
 * about a node: its type is catalogued, a query-backed type carries a query
 * whose source that entry allows, a source link carries none, only container
 * types carry children, and every node id is unique.
 */
function expectCatalogConformance(spec: PanelSpec): void {
  const ids = new Set<string>();
  let visited = 0;
  walkPanelNodes(spec.layout, (node) => {
    visited += 1;
    expect(PANEL_NODE_TYPES).toContain(node.type);
    expect(Object.hasOwn(PANEL_NODE_CATALOG, node.type)).toBe(true);
    const entry = PANEL_NODE_CATALOG[node.type];
    const query = queryOf(node);

    if (entry.requiresQuery) {
      expect(query).toBeDefined();
      expect(entry.sources).toContain(query?.source);
      expect(DATA_QUERY_SOURCES).toContain(query?.source);
    } else {
      expect(query).toBeUndefined();
    }
    if (node.type === 'sourceLink') {
      expect(query).toBeUndefined();
    }
    if ('children' in node) {
      expect(entry.supportsChildren).toBe(true);
    } else {
      expect(entry.supportsChildren).toBe(false);
    }

    expect(ids.has(node.id)).toBe(false);
    ids.add(node.id);
  });
  expect(visited).toBeGreaterThan(0);
}

/** Every statement of a spec's summary. */
function summaryStatements(spec: PanelSpec): readonly string[] {
  return [
    ...spec.summary.observed.map((fact) => fact.statement),
    ...spec.summary.likelyCauses.map((cause) => cause.statement),
  ];
}

/** Every message along an error's `cause` chain. */
function causeMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    if (DebuggenError.is(current) && current.hint !== undefined) {
      messages.push(current.hint);
    }
    current = current.cause;
  }
  return messages;
}

/** Asserts that none of the planted markers occurs in `text`. */
function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

/** A summary without its `primaryTraceId`. */
function withoutPrimaryTrace(summary: CaptureSummary): CaptureSummary {
  const copy: Mutable<CaptureSummary> = { ...summary };
  delete copy.primaryTraceId;
  return copy;
}

/** The bounded summary sections a per-concern view's evidence may come from. */
type RowSection = 'topRenders' | 'topRequests' | 'topQueries';

/** `summary` with `rows` emptied (when named) and the kind tally of `type` zeroed (when asked). */
function strippedOf(
  summary: CaptureSummary,
  type: FallbackNodeType,
  strip: { readonly rows?: RowSection | undefined; readonly kinds: boolean },
): CaptureSummary {
  const kindCounts: Record<TelemetryKind, number> = { ...summary.kindCounts };
  if (strip.kinds) {
    for (const kind of PANEL_NODE_CATALOG[type].telemetryKinds) {
      kindCounts[kind] = 0;
    }
  }
  const copy: Mutable<CaptureSummary> = { ...summary, kindCounts };
  switch (strip.rows) {
    case 'topRenders':
      copy.topRenders = [];
      break;
    case 'topRequests':
      copy.topRequests = [];
      break;
    case 'topQueries':
      copy.topQueries = [];
      break;
    case undefined:
      break;
  }
  return copy;
}

/** The metric values of `summary`, with exactly the ids in `available` measurable. */
function metricsWith(summary: CaptureSummary, available: ReadonlySet<MetricId>): MetricValue[] {
  return summary.metrics.map((metric): MetricValue =>
    available.has(metric.id)
      ? { id: metric.id, label: metric.label, unit: metric.unit, available: true, value: 1 }
      : { id: metric.id, label: metric.label, unit: metric.unit, available: false },
  );
}

/** The source text of the unit under test, for the import and literal audits. */
const FALLBACK_SOURCE = readFileSync(new URL('./fallback.ts', import.meta.url), 'utf8');

/** Every module specifier the source imports or re-exports from. */
function moduleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+'([^']+)';/gms)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * The per-concern views and the bounded summary section each may draw its
 * evidence from (`undefined`: the kind tally is its only evidence). The kinds
 * that count as evidence are read from each type's catalog entry, never listed
 * here.
 */
const EVIDENCE_CASES: readonly {
  readonly type: FallbackNodeType;
  readonly rows: RowSection | undefined;
}[] = [
  { type: 'renderTable', rows: 'topRenders' },
  { type: 'requestTable', rows: 'topRequests' },
  { type: 'queryTable', rows: 'topQueries' },
  { type: 'stateTransitions', rows: undefined },
];

/** The rich summary with every per-concern view's evidence removed: events remain, concerns do not. */
const BARE_SUMMARY: CaptureSummary = EVIDENCE_CASES.reduce(
  (summary, { type, rows }) => strippedOf(summary, type, { rows, kinds: true }),
  RICH_SUMMARY,
);

/** Every capture shape the unconditional guarantees are checked over. */
const CAPTURE_SHAPES: readonly { readonly name: string; readonly summary: CaptureSummary }[] = [
  { name: 'rich capture', summary: RICH_SUMMARY },
  { name: 'capture without per-concern evidence', summary: BARE_SUMMARY },
  { name: 'capture without a primary trace', summary: withoutPrimaryTrace(RICH_SUMMARY) },
  { name: 'empty capture', summary: EMPTY_SUMMARY },
  ...EVIDENCE_CASES.map(({ type, rows }) => ({
    name: `capture without ${type} evidence`,
    summary: strippedOf(RICH_SUMMARY, type, { rows, kinds: true }),
  })),
];

/* -------------------------------------------------------------------------------------------------
 * Phase 1 — the builders themselves
 * ---------------------------------------------------------------------------------------------- */

describe('fixture builders', () => {
  it('compute summaries with one metric value per METRIC_IDS member, in order', () => {
    for (const summary of [RICH_SUMMARY, LEAK_SUMMARY, EMPTY_SUMMARY]) {
      expect(summary.metrics.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
      expect(summary.captureId).toBe(CAPTURE);
      expect(summary.sessionId).toBe(SESSION);
      expect(summary.endTime).toBeGreaterThanOrEqual(summary.startTime);
      expect(typeof summary.truncated).toBe('boolean');
    }
    expect(RICH_SUMMARY.eventCount).toBe(RICH_EVENTS.length);
    expect(LEAK_SUMMARY.eventCount).toBe(LEAK_EVENTS.length);
    expect(EMPTY_SUMMARY.eventCount).toBe(0);
    expect(EMPTY_SUMMARY.primaryTraceId).toBeUndefined();
  });

  it('give the rich capture evidence for every per-concern view the fallback can draw', () => {
    expect(RICH_SUMMARY.primaryTraceId).toBe(TRACE_MAIN);
    expect(RICH_SUMMARY.traceIds).toEqual(expect.arrayContaining([TRACE_MAIN, TRACE_SHORT]));
    expect(RICH_SUMMARY.topSpans.length).toBeGreaterThan(0);
    for (const { type, rows } of EVIDENCE_CASES) {
      const kinds = PANEL_NODE_CATALOG[type].telemetryKinds;
      expect(kinds.length).toBeGreaterThan(0);
      expect(
        kinds.reduce((total, kind) => total + RICH_SUMMARY.kindCounts[kind], 0),
      ).toBeGreaterThan(0);
      if (rows !== undefined) {
        expect(RICH_SUMMARY[rows].length).toBeGreaterThan(0);
      }
    }
  });

  it('plant a sentinel in the trace id, the attribute-bearing rows and the facts of the leak capture', () => {
    expect(LEAK_SUMMARY.primaryTraceId).toBe(SENTINEL_TRACE);
    expect(isTraceId(SENTINEL_TRACE)).toBe(true);
    expect(JSON.stringify(LEAK_SUMMARY.topRequests)).toContain(SENTINEL);
    expect(JSON.stringify(LEAK_SUMMARY.topRenders)).toContain(SENTINEL);
    const statements = LEAK_ANALYSIS.observed.map((fact) => fact.statement).join('\n');
    expect(statements).toContain(SENTINEL);
    expect(statements).toContain(SECRET_SEGMENT);
  });

  it('assemble analyses the protocol accepts, every finding citing at least one event', () => {
    for (const analysis of [DEFAULT_ANALYSIS, EMPTY_ANALYSIS, LEAK_ANALYSIS]) {
      expect(parseAnalysisResult(analysis).ok).toBe(true);
      for (const finding of [...analysis.observed, ...analysis.likelyCauses]) {
        expect(finding.evidence.length).toBeGreaterThan(0);
      }
    }
    expect(DEFAULT_ANALYSIS.observed.length).toBeGreaterThan(0);
    expect(DEFAULT_ANALYSIS.likelyCauses.length).toBeGreaterThan(0);
    expect(EMPTY_ANALYSIS.observed).toEqual([]);
    expect(EMPTY_ANALYSIS.likelyCauses).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 2 — the three load-bearing guarantees
 * ---------------------------------------------------------------------------------------------- */

describe('the fallback flag', () => {
  it('is true on every spec build returns, for every reason and every capture shape', async () => {
    const { builder } = harness();
    for (const reason of FALLBACK_REASONS) {
      for (const { summary } of CAPTURE_SHAPES) {
        const spec = expectOk(await builder.build(buildRequest({ reason, summary })));
        expect(spec.meta?.fallback).toBe(true);
      }
    }
  });

  it('flows only from NormalizeContext.fallback: the same input normalised without it has no meta', async () => {
    const selection = selectFallbackNodes(RICH_SUMMARY);
    const authored = buildFallbackInput({
      selection,
      analysis: DEFAULT_ANALYSIS,
      summary: RICH_SUMMARY,
    });
    expect(Object.hasOwn(authored, 'meta')).toBe(false);
    const parsed = expectOk(parsePanelSpecInput(authored));
    const context = { id: PANEL_ID, sessionId: SESSION, panelVersion: FIRST_PANEL_VERSION };

    const plain = normalizePanel(parsed, DEFAULT_ANALYSIS, context);
    expect(Object.hasOwn(plain, 'meta')).toBe(false);
    expect(validatePanelSpec(plain).ok).toBe(true);

    const flagged = normalizePanel(parsed, DEFAULT_ANALYSIS, { ...context, fallback: true });
    expect(flagged.meta?.fallback).toBe(true);

    // The builder's output is exactly the flagged normalisation: nothing is added after it.
    expect(await built()).toEqual(flagged);
  });

  it('is never written as a meta literal in the module source', () => {
    expect(FALLBACK_SOURCE).not.toMatch(/\bmeta\s*:/);
  });
});

describe('the fallback passes the validation a generated panel must pass', () => {
  it.each(CAPTURE_SHAPES)(
    'validates and conforms to the node catalog for the $name',
    async ({ summary }) => {
      const spec = await built({ summary });
      expect(validatePanelSpec(spec).ok).toBe(true);
      expectCatalogConformance(spec);
    },
  );

  it('passes the real validator’s syntactic and semantic steps against the capture it shows', async () => {
    const cases = [
      { summary: RICH_SUMMARY, analysis: DEFAULT_ANALYSIS },
      { summary: EMPTY_SUMMARY, analysis: EMPTY_ANALYSIS },
    ];
    for (const { summary, analysis } of cases) {
      const h = harness();
      const spec = expectOk(await h.builder.build(buildRequest({ summary, analysis })));
      const checked = await h.validator.validateGenerated({
        spec,
        sessionId: SESSION,
        captureId: CAPTURE,
        summary,
      });
      expect(checked.ok ? 'accepted' : checked.error.class).toBe('accepted');
      expect(h.resolverCalls).toEqual([{ sessionId: SESSION, captureId: CAPTURE }]);
    }
  });

  it('lays out one titled section per selected view, carrying the selection’s query', async () => {
    const selection = selectFallbackNodes(RICH_SUMMARY);
    const spec = await built();
    expect(spec.title).toBe(FALLBACK_TITLE);
    expect(viewTypesOf(spec)).toEqual(selectedTypes(selection));
    sectionsOf(spec).forEach((section, index) => {
      const choice = nth(selection.nodes, index);
      expect(section.title).toBe(FALLBACK_SECTION_TITLES[choice.section]);
      expect(queryOf(nth(section.children, 0))).toEqual(choice.query);
    });
  });

  it('takes its identity and versioning from the request and the injected id factory', async () => {
    const spec = await built({ panelVersion: 3, supersedes: PREVIOUS_PANEL_ID });
    expect(spec.id).toBe(PANEL_ID);
    expect(spec.sessionId).toBe(SESSION);
    expect(spec.panelVersion).toBe(3);
    expect(spec.supersedes).toBe(PREVIOUS_PANEL_ID);

    const first = await built();
    expect(Object.hasOwn(first, 'supersedes')).toBe(false);
  });
});

describe('the fallback invents no findings', () => {
  it('copies the analysis’s observed facts and likely causes unchanged', async () => {
    const spec = await built();
    expect(spec.summary.observed).toEqual(DEFAULT_ANALYSIS.observed);
    expect(spec.summary.likelyCauses).toEqual(DEFAULT_ANALYSIS.likelyCauses);
    expect(spec.summary.headline).toBe(FALLBACK_HEADLINES.withFindings);
  });

  it('leaves an empty analysis empty rather than filling the space', async () => {
    for (const summary of [RICH_SUMMARY, EMPTY_SUMMARY]) {
      const spec = await built({ summary, analysis: EMPTY_ANALYSIS });
      expect(validatePanelSpec(spec).ok).toBe(true);
      expect(spec.summary.observed).toEqual([]);
      expect(spec.summary.likelyCauses).toEqual([]);
      expect(spec.summary.headline).toBe(FALLBACK_HEADLINES.withoutFindings);
      expect(spec.layout.length).toBeGreaterThan(0);
    }
  });

  it('never turns the failure reason into a statement or a headline', async () => {
    const { builder } = harness();
    for (const reason of FALLBACK_REASONS) {
      const spec = expectOk(await builder.build(buildRequest({ reason })));
      for (const statement of summaryStatements(spec)) {
        expect(statement).not.toContain(reason);
      }
      expect(spec.summary.headline ?? '').not.toContain(reason);
      expect(summaryStatements(spec)).toEqual([
        ...DEFAULT_ANALYSIS.observed.map((fact) => fact.statement),
        ...DEFAULT_ANALYSIS.likelyCauses.map((cause) => cause.statement),
      ]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 3 — evidence-gated node selection
 * ---------------------------------------------------------------------------------------------- */

describe('evidence-gated node selection', () => {
  it.each(EVIDENCE_CASES)(
    'draws $type exactly when the capture holds its evidence',
    async ({ type, rows }) => {
      const withEvidence = selectedTypes(selectFallbackNodes(RICH_SUMMARY));
      expect(withEvidence).toContain(type);

      // Otherwise identical, minus this concern's evidence: only this view disappears.
      const stripped = strippedOf(RICH_SUMMARY, type, { rows, kinds: true });
      expect(selectedTypes(selectFallbackNodes(stripped))).toEqual(
        withEvidence.filter((candidate) => candidate !== type),
      );
      const spec = await built({ summary: stripped });
      expect(viewTypesOf(spec)).not.toContain(type);
      expect(validatePanelSpec(spec).ok).toBe(true);

      if (rows !== undefined) {
        // Rows alone are evidence …
        const rowsOnly = strippedOf(RICH_SUMMARY, type, { kinds: true });
        expect(selectedTypes(selectFallbackNodes(rowsOnly))).toContain(type);
        // … and so is the kind tally of a section clipped to zero rows.
        const tallyOnly = strippedOf(RICH_SUMMARY, type, { rows, kinds: false });
        expect(selectedTypes(selectFallbackNodes(tallyOnly))).toContain(type);
      }

      const view = viewOfType(await built(), type);
      expect(PANEL_NODE_CATALOG[type].sources).toContain(queryOf(view)?.source);
    },
  );

  it('draws an event log whenever the capture holds any events, and not otherwise', () => {
    for (const { summary } of CAPTURE_SHAPES) {
      const types = selectedTypes(selectFallbackNodes(summary));
      if (summary.eventCount > 0) {
        expect(types).toContain('eventLog');
      } else {
        expect(types).not.toContain('eventLog');
      }
    }
    const bareTypes = selectedTypes(selectFallbackNodes(BARE_SUMMARY));
    for (const { type } of EVIDENCE_CASES) {
      expect(bareTypes).not.toContain(type);
    }
    expect(bareTypes).toContain('eventLog');
  });

  it('always draws the metric overview, and the slowest-operations table for any capture with events', async () => {
    for (const { summary } of CAPTURE_SHAPES) {
      const spec = await built({ summary });
      const views = viewsOf(spec);
      expect(nth(views, 0).type).toBe('metricCards');
      const overview = viewOfType(spec, 'metricCards');
      expect('metrics' in overview ? overview.metrics : undefined).toEqual(
        fallbackMetricIds(summary),
      );

      if (summary.eventCount === 0) {
        continue;
      }
      const table = viewOfType(spec, 'table');
      const query = queryOf(table);
      expect(query?.source).toBe('spans');
      expect(query?.sort).toBe('duration_desc');
      expect(DATA_QUERY_SORTS).toContain(query?.sort);
      expect(query?.limit).toBe(DEFAULT_TOP_N);
    }
  });

  it('draws a timeline only for a real trace the summary names, filtered to that trace', async () => {
    const spec = await built();
    const timelines = viewsOf(spec).filter((node) => node.type === 'timeline');
    expect(timelines).toHaveLength(1);
    const traceId = queryOf(nth(timelines, 0))?.filter?.traceId;
    expect(traceId).toBe(RICH_SUMMARY.primaryTraceId);
    expect(traceId).toBe(TRACE_MAIN);
    expect(isTraceId(traceId)).toBe(true);
    expect(RICH_SUMMARY.traceIds).toContain(traceId);

    const placeholder: CaptureSummary = { ...RICH_SUMMARY, primaryTraceId: '...' };
    for (const summary of [withoutPrimaryTrace(RICH_SUMMARY), placeholder, EMPTY_SUMMARY]) {
      const untraced = await built({ summary });
      expect(viewTypesOf(untraced)).not.toContain('timeline');
      for (const node of allNodes(untraced)) {
        expect(queryOf(node)?.filter?.traceId).toBeUndefined();
      }
    }
  });

  it('gives an empty capture a valid, non-blank layout: the overview alone', async () => {
    const selection = selectFallbackNodes(EMPTY_SUMMARY);
    expect(selection.empty).toBe(true);
    expect(selection.captureId).toBe(CAPTURE);

    const spec = await built({ summary: EMPTY_SUMMARY, analysis: EMPTY_ANALYSIS });
    expect(validatePanelSpec(spec).ok).toBe(true);
    expect(spec.layout.length).toBeGreaterThan(0);
    expect(viewTypesOf(spec)).toEqual(selectedTypes(selection));
    expect(viewTypesOf(spec)).toEqual(['metricCards']);
    expectCatalogConformance(spec);
  });

  it('shows every measurable metric in vocabulary order, or the whole vocabulary when none is', () => {
    const none = { ...RICH_SUMMARY, metrics: metricsWith(RICH_SUMMARY, new Set()) };
    expect(fallbackMetricIds(none)).toEqual([...METRIC_IDS]);

    const everyOther = new Set(METRIC_IDS.filter((_, index) => index % 2 === 0));
    const some = { ...RICH_SUMMARY, metrics: metricsWith(RICH_SUMMARY, everyOther) };
    expect(fallbackMetricIds(some)).toEqual(METRIC_IDS.filter((id) => everyOther.has(id)));

    const measured = RICH_SUMMARY.metrics.filter((metric) => metric.available).map((m) => m.id);
    expect(fallbackMetricIds(RICH_SUMMARY)).toEqual(
      measured.length > 0 ? METRIC_IDS.filter((id) => measured.includes(id)) : [...METRIC_IDS],
    );
    for (const summary of [none, some, RICH_SUMMARY, EMPTY_SUMMARY]) {
      const ids = fallbackMetricIds(summary);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(METRIC_IDS).toContain(id);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 4 — determinism, purity and privacy
 * ---------------------------------------------------------------------------------------------- */

describe('determinism and purity', () => {
  it('selects deep-equal, frozen node choices from equal summaries', () => {
    const first = selectFallbackNodes(RICH_SUMMARY);
    const second = selectFallbackNodes(makeCaptureSummary({ events: RICH_EVENTS }));
    expect(second).toEqual(first);
    expect(selectFallbackNodes(RICH_SUMMARY)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    for (const choice of first.nodes) {
      expect(Object.isFrozen(choice)).toBe(true);
      expect(Object.isFrozen(choice.query)).toBe(true);
    }
  });

  it('builds byte-identical JSON from equal inputs, whatever the clock or random source says', async () => {
    const request = buildRequest();
    const first = harness();
    const second = harness();
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    try {
      now.mockReturnValue(BASE_TIME);
      random.mockReturnValue(0.125);
      const a = expectOk(await first.builder.build(request));
      now.mockReturnValue(BASE_TIME + 86_400_000);
      random.mockReturnValue(0.875);
      const b = expectOk(await first.builder.build(request));
      const c = expectOk(await second.builder.build(request));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });

  it('neither writes nor changes its inputs', async () => {
    const summary = makeCaptureSummary({ events: RICH_EVENTS });
    const analysis = makeAnalysisResult();
    const summaryBefore = structuredClone(summary);
    const analysisBefore = structuredClone(analysis);
    deepFreeze(summary);
    deepFreeze(analysis);

    const selection = selectFallbackNodes(summary);
    fallbackMetricIds(summary);
    buildFallbackInput({ selection, analysis, summary });
    expectOk(await harness().builder.build(buildRequest({ summary, analysis })));

    expect(summary).toEqual(summaryBefore);
    expect(analysis).toEqual(analysisBefore);
  });
});

describe('vocabulary', () => {
  it('states the AAP 0.5.5 banner sentence verbatim', () => {
    expect(FALLBACK_BANNER_MESSAGE).toBe(
      'Generated panel failed validation; showing a fallback view built from captured data.',
    );
  });

  it('takes its reasons from the validator’s failure taxonomy rather than restating them', () => {
    expect(FALLBACK_REASONS).toBe(PANEL_FAILURE_CLASSES);
    for (const reason of FALLBACK_REASONS) {
      expect(isFallbackReason(reason)).toBe(true);
    }
    expect(isFallbackReason(SENTINEL)).toBe(false);
    expect(isFallbackReason(undefined)).toBe(false);
  });

  it('draws only catalogued, query-backed view types whose sources the catalog allows', () => {
    for (const { summary } of CAPTURE_SHAPES) {
      for (const choice of selectFallbackNodes(summary).nodes) {
        const entry = PANEL_NODE_CATALOG[choice.type];
        expect(entry.kind).toBe('visualization');
        expect(entry.requiresQuery).toBe(true);
        expect(entry.sources).toContain(choice.query.source);
      }
    }
  });
});

/** A copy of a document whose layout holds a node type no catalog entry describes. */
function withUncataloguedView(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return { ...value, layout: [{ type: 'uncatalogued-view', id: 'layout.node-0' }] };
}

/** Everything a failed build exposes, flattened to text for the leak search. */
function exposedText(error: DebuggenError, records: readonly LogRecord[]): readonly string[] {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
    ...causeMessages(error),
    JSON.stringify(
      records.map((record) => ({
        level: record.level,
        message: record.message,
        fields: record.fields,
      })),
    ),
  ];
}

/** Asserts a failed build's shape: a closed-vocabulary code and a named stage. */
function expectStage(error: DebuggenError, stage: (typeof FALLBACK_BUILD_STAGES)[number]): void {
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(FALLBACK_BUILD_STAGES).toContain(error.details?.['fallbackStage']);
  expect(error.details?.['fallbackStage']).toBe(stage);
}

describe('privacy', () => {
  it('keeps planted content out of a rejected build’s error and log records', async () => {
    const h = harness({
      gate: (real) => ({
        validateSpec: (value, scope) => real.validateSpec(withUncataloguedView(value), scope),
      }),
    });
    const error = expectErr(
      await h.builder.build(buildRequest({ summary: LEAK_SUMMARY, analysis: LEAK_ANALYSIS })),
    );

    expectStage(error, 'internal-schema');
    expect(error.details?.['fallbackReason']).toBe(DEFAULT_REASON);
    expect(error.details?.['issueCount']).toBeGreaterThan(0);
    expect(error.details?.['nodeTypes']).toEqual(selectedTypes(selectFallbackNodes(LEAK_SUMMARY)));
    expect(h.records.some((record) => record.level === 'error')).toBe(true);
    for (const text of exposedText(error, h.records)) {
      expectNoLeak(text);
    }
  });

  it('keeps planted content out of the log records of a successful build', async () => {
    const h = harness();
    const spec = expectOk(
      await h.builder.build(buildRequest({ summary: LEAK_SUMMARY, analysis: LEAK_ANALYSIS })),
    );
    // The panel itself legitimately carries the capture's trace filter and the analysis's facts.
    expect(JSON.stringify(spec)).toContain(SENTINEL_TRACE);
    expect(h.records.some((record) => record.level === 'info')).toBe(true);
    expectNoLeak(
      JSON.stringify(
        h.records.map((record) => ({ message: record.message, fields: record.fields })),
      ),
    );
  });

  it('refuses a spec that lost its fallback flag, naming the flag by path only', async () => {
    const h = harness({
      gate: (real) => ({
        validateSpec: (value, scope) => {
          const validated = real.validateSpec(value, scope);
          if (!validated.ok) {
            return validated;
          }
          const unflagged: Mutable<PanelSpec> = { ...validated.value };
          delete unflagged.meta;
          return ok(unflagged);
        },
      }),
    });
    const error = expectErr(
      await h.builder.build(buildRequest({ summary: LEAK_SUMMARY, analysis: LEAK_ANALYSIS })),
    );
    expectStage(error, 'internal-schema');
    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details?.['issuePaths']).toEqual(['meta.fallback']);
    for (const text of exposedText(error, h.records)) {
      expectNoLeak(text);
    }
  });

  it('refuses an unrecognised reason without echoing it', async () => {
    const h = harness();
    const unrecognised: string = SENTINEL;
    const error = expectErr(
      await h.builder.build(buildRequest({ reason: unrecognised as FallbackReason })),
    );
    expectStage(error, 'request');
    expect(Object.hasOwn(error.details ?? {}, 'fallbackReason')).toBe(false);
    for (const text of exposedText(error, h.records)) {
      expectNoLeak(text);
    }
  });
});

describe('failure stages', () => {
  it('refuses a summary or analysis of another capture or session, by field name only', async () => {
    const { builder } = harness();
    const foreignAnalysis = expectErr(
      await builder.build(
        buildRequest({ analysis: makeAnalysisResult({ captureId: OTHER_CAPTURE }) }),
      ),
    );
    expectStage(foreignAnalysis, 'scope');
    expect(foreignAnalysis.details?.['mismatches']).toEqual(['analysis.captureId']);

    const foreignSession = expectErr(
      await builder.build(
        buildRequest({ analysis: makeAnalysisResult({ sessionId: OTHER_SESSION }) }),
      ),
    );
    expect(foreignSession.details?.['mismatches']).toEqual(['analysis.sessionId']);

    const foreignSummary = expectErr(
      await builder.build(
        buildRequest({
          summary: makeCaptureSummary({ events: RICH_EVENTS, captureId: OTHER_CAPTURE }),
        }),
      ),
    );
    expectStage(foreignSummary, 'scope');
    expect(foreignSummary.details?.['mismatches']).toEqual(['summary.captureId']);
    expect(JSON.stringify(foreignSummary.details)).not.toContain(OTHER_CAPTURE);
  });

  it('loads the summary through the injected port when the request carries none', async () => {
    const captures = createSummaryPort(ok(RICH_SUMMARY));
    const loaded = await built({ summary: undefined }, { captures });
    expect(captures.loads).toEqual([{ sessionId: SESSION, captureId: CAPTURE }]);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(await built()));
  });

  it('reports a missing summary port as a wiring defect', async () => {
    const error = expectErr(await harness().builder.build(buildRequest({ summary: undefined })));
    expectStage(error, 'summary');
    expect(error.code).toBe('INTERNAL');
  });

  it('forwards the code of a summary the port could not load', async () => {
    const captures = createSummaryPort(
      err(new DebuggenError('STORE_ERROR', 'The capture row could not be read.')),
    );
    const error = expectErr(
      await harness({ captures }).builder.build(buildRequest({ summary: undefined })),
    );
    expectStage(error, 'summary');
    expect(error.code).toBe('STORE_ERROR');
  });

  it('turns a throwing summary port into STORE_ERROR rather than a rejection', async () => {
    const captures = createSummaryPort(ok(RICH_SUMMARY), { throws: true });
    const error = expectErr(
      await harness({ captures }).builder.build(buildRequest({ summary: undefined })),
    );
    expectStage(error, 'summary');
    expect(error.code).toBe('STORE_ERROR');
  });

  it('reports a failing panel-id factory', async () => {
    const newId = (): PanelId => {
      throw new Error('the id source is exhausted');
    };
    const error = expectErr(await harness({ newId }).builder.build(buildRequest()));
    expectStage(error, 'panel-id');
    expect(error.code).toBe('INTERNAL');
  });
});

describe('module boundaries', () => {
  it('does not import the fact candidates of ../analysis/facts.ts', () => {
    const specifiers = moduleSpecifiers(FALLBACK_SOURCE);
    // The audit reads real import statements: the validator module is one of them.
    expect(specifiers).toContain('./validate.js');
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(?:^|\/)analysis\/facts(?:\.js)?$/);
    }
  });
});
