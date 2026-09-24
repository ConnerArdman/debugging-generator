/**
 * The committed `PanelSpec` fixture of the Playwright `browser` project, and the
 * synthetic capture its data queries are answered from.
 *
 * ## What this module is for
 *
 * `panel-render.spec.ts` proves that "a stored `PanelSpec` fixture renders
 * every catalogued node type in the panel page" (AAP 0.8.3). The deterministic
 * pipeline cannot produce such a document - its panels are derived from real
 * capture aggregates and never compose all sixteen node types at once - so the
 * spec is committed here, under `tests/browser/` (`tests/fixtures/` is reserved
 * for the generalization target `sample-next-app`).
 *
 * It is a TypeScript module rather than a JSON blob on purpose. A JSON document
 * *is* a hand-written list of node types, and it would go stale the day a node
 * type is added. Everything below is **derived**:
 *
 * - the node set comes from iterating `PANEL_NODE_CATALOG` at load time, so a
 *   catalog addition appears in the fixture - or fails the fixture loudly,
 *   naming itself - without an edit here, and {@link expectedRenderedNodeTypes}
 *   reads the same catalog, so the expectation grows with it;
 * - the document is produced by the product's own three steps: the authored
 *   candidate is parsed by `parsePanelSpecInput`, normalised by `normalizePanel`
 *   and validated by `validatePanelSpec`, so it can never drift from the schema;
 * - every data result is computed from one synthetic capture by the telemetry
 *   package's real aggregates (`correlateTrace`, `aggregateRenders`,
 *   `aggregateRequests`, `aggregateQueries`, ...) under the paging, sorting and
 *   filtering rules of `apps/local-service/src/panels/data.ts`, and is validated
 *   against the protocol's `POST /sessions/:id/panel-data` response schema
 *   (`parseDataResult`) before it is handed out;
 * - the summary's facts and hypotheses cite events of that same capture, and
 *   their statements are computed from the same aggregates the panel draws, so
 *   an evidence chip always selects a real event and a number in a sentence
 *   always agrees with the number in the table beside it.
 *
 * ## Why the data is synthetic
 *
 * The `browser` suite holds no server-agent credential, so `POST
 * /telemetry/ingest` is unavailable to it and the server and database tiers
 * genuinely have no live data there. The capture below therefore models what the
 * product would have stored for one click on the fixture app's `Run check`
 * button (`tests/fixtures/sample-next-app`), in that app's own vocabulary -
 * `PingWidget`, `PingPage`, `FixtureLayout`, `GET /api/ping`,
 * `buildPingPayload`. The two database spans are synthetic in the strictest
 * sense: the fixture app has no database, and they exist only so the
 * `waterfall` and `queryTable` nodes have a server/database pair to draw.
 *
 * ## The deliberately empty source
 *
 * The capture holds no hook-state record: its plan armed render tracking but
 * not `state-tracking`, which is an ordinary plan. So the `stateTransitions`
 * source resolves to an empty page *because the evidence is absent*, not
 * because a value was special-cased, and {@link EMPTY_DATA_SOURCES} is computed
 * by resolving every source and keeping the empty ones. The spec asserts that
 * the node reading such a source renders its `EmptyState` - the documented
 * behaviour of AAP 0.6.2, not a failure.
 *
 * ## Privacy (AAP 0.5.2)
 *
 * Every value models already-redacted telemetry: no header value, no request or
 * response body, no URL query value, SQL in parameterized form only (`$1`), and
 * prop values as short type summaries. No literal here resembles a credential:
 * ids are short, lowercase and obviously synthetic (`f17e…`, `…_fixture…`).
 *
 * ## Determinism
 *
 * No clock, no randomness, no generated id. Two calls of any builder return
 * deeply equal values, which `panel-render.spec.ts` asserts.
 *
 * ## Not a spec
 *
 * This file declares no `test(...)` block. The `browser` project collects
 * `tests/browser/**\/*.spec.ts` (`playwright.config.ts`), and the `.fixture.ts`
 * suffix keeps this module outside that pattern.
 *
 * ## Resolution
 *
 * `@debuggen/panel-schema`, `@debuggen/telemetry`, `@debuggen/shared` and
 * `@debuggen/protocol` resolve through `tests/tsconfig.json`'s `paths`, which
 * Playwright's loader honours at runtime, so the catalog, the normaliser, the
 * validator and the aggregates are the product's own values rather than copies.
 * `@debuggen/panel-renderer` is deliberately unmapped: rendering is asserted
 * through the panel page's DOM.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SOURCES,
  DEFAULT_SPLIT_DIRECTION,
  PANEL_NODE_CATALOG,
  SPLIT_DIRECTIONS,
  isKnownPanelNodeType,
  isSourceAllowedForNode,
  normalizePanel,
  parseDataQuery,
  parsePanelSpecInput,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
  EventRef,
  Fact,
  Hypothesis,
  NormalizeAnalysis,
  NormalizeContext,
  PanelNodeCatalogEntry,
  PanelNodeType,
  PanelSpec,
  PanelSpecInput,
} from '@debuggen/panel-schema';
import { parseDataResult } from '@debuggen/protocol';
import type { DataPage, DataResult, DataResultFor } from '@debuggen/protocol';
import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  assertNever,
} from '@debuggen/shared';
import type {
  CaptureId,
  EventId,
  PanelId,
  ProducerId,
  SessionId,
  SourceLocation,
  SourceResolvedBy,
  SpanId,
  TraceId,
} from '@debuggen/shared';
import {
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  DEFAULT_MAX_DEPTH,
  ERROR_KINDS,
  METRIC_IDS,
  PERF_KINDS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  aggregateQueries,
  aggregateRenders,
  aggregateRequests,
  aggregateStateTransitions,
  attributeKeysFor,
  buildComponentTreeSnapshot,
  buildDependencyGraph,
  computeMetrics,
  correlateTrace,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type {
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  TelemetryEvent,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';

/* -------------------------------------------------------------------------------------------------
 * Identity
 *
 * Fixed, schema-valid constants. The prefixed ids follow `@debuggen/shared`'s
 * `<three letters>_<16 of [0-9a-z]>` shape; the hex ids carry a recognisable
 * `f17e` prefix and are never all-zero, which the event schema refuses.
 * ---------------------------------------------------------------------------------------------- */

/** The session every fixture record and the fixture panel belong to. */
export const FIXTURE_SESSION_ID: SessionId = 'ses_fixturepanel0001';

/** The id {@link buildCatalogPanelSpec} gives the ordinary (non-fallback) panel. */
export const FIXTURE_PANEL_ID: PanelId = 'pnl_fixturecatalog01';

/**
 * The id {@link buildCatalogPanelSpec} gives a fallback panel when no id is
 * passed, so a spec that delivers the ordinary and the fallback document in turn
 * hands the panel two distinct documents rather than one id twice.
 */
export const FIXTURE_FALLBACK_PANEL_ID: PanelId = 'pnl_fixturefallbck01';

/** The capture window every fixture record was recorded in. */
export const FIXTURE_CAPTURE_ID: CaptureId = 'cap_fixturecapture01';

/** The browser agent's per-document producer id. */
export const FIXTURE_BROWSER_PRODUCER_ID: ProducerId = 'prd_fixturebrowser01';

/** The Node preload's per-process producer id; it also reports the database spans. */
export const FIXTURE_SERVER_PRODUCER_ID: ProducerId = 'prd_fixtureserver001';

/**
 * When the capture's first record started, in Unix epoch milliseconds
 * (2026-01-15T09:30:00Z). `Date.UTC` is arithmetic on its arguments, not a clock
 * read, so the value is the same on every run.
 */
export const FIXTURE_CAPTURE_START_MS: number = Date.UTC(2026, 0, 15, 9, 30, 0);

/** The recognisable prefix of every fixture trace and span id. */
const FIXTURE_HEX_PREFIX = 'f17e';

/**
 * A fixed hexadecimal id of `width` characters: {@link FIXTURE_HEX_PREFIX},
 * zero padding, then `ordinal` in hex.
 *
 * @param width The id width: 32 for a trace id, 16 for a span id.
 * @param ordinal A positive integer distinguishing ids of one width.
 * @param pattern The `@debuggen/shared` pattern the result must match.
 * @returns The id.
 * @throws RangeError when `ordinal` is not a positive safe integer or does not fit.
 */
function fixtureHexId(width: number, ordinal: number, pattern: RegExp): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`Fixture hex id ordinals are positive integers; got ${String(ordinal)}.`);
  }

  const digits = ordinal.toString(16);
  const padding = width - FIXTURE_HEX_PREFIX.length - digits.length;

  if (padding < 0) {
    throw new RangeError(
      `Fixture hex id ordinal ${String(ordinal)} does not fit ${String(width)} characters.`,
    );
  }

  const id = `${FIXTURE_HEX_PREFIX}${'0'.repeat(padding)}${digits}`;

  if (!pattern.test(id)) {
    throw new Error(`Fixture hex id "${id}" does not match ${String(pattern)}.`);
  }

  return id;
}

/**
 * A fixed, schema-valid W3C trace id: 32 lowercase hex characters, never all zero.
 *
 * @param ordinal A positive integer; `1` is {@link FIXTURE_TRACE_ID}.
 * @returns The trace id.
 */
export function fixtureTraceId(ordinal: number): TraceId {
  return fixtureHexId(32, ordinal, TRACE_ID_PATTERN);
}

/**
 * A fixed, schema-valid W3C span id: 16 lowercase hex characters, never all zero.
 *
 * @param ordinal A positive integer naming the span within the fixture capture.
 * @returns The span id.
 */
export function fixtureSpanId(ordinal: number): SpanId {
  return fixtureHexId(16, ordinal, SPAN_ID_PATTERN);
}

/**
 * A fixed event id in the `evt_<16 of [0-9a-z]>` shape: `evt_fixture` followed
 * by the ordinal zero-padded to nine digits.
 *
 * @param ordinal A positive integer; the capture numbers its events from 1.
 * @returns The event id.
 */
function fixtureEventId(ordinal: number): EventId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 999_999_999) {
    throw new RangeError(`Fixture event ordinals run from 1 to 999999999; got ${String(ordinal)}.`);
  }

  return `evt_fixture${String(ordinal).padStart(9, '0')}`;
}

/** The one correlated interaction the fixture capture holds. */
export const FIXTURE_TRACE_ID: TraceId = fixtureTraceId(1);

/**
 * The service-assigned `request_key` every occurrence of the fixture's
 * `GET /api/ping` shares, which is what makes them one duplicate group.
 *
 * In a real store this is an HMAC computed at ingest (AAP 0.5.2); here it is a
 * short, obviously synthetic label, because the aggregate only needs equal keys
 * to collide and no fixture value may look like key material.
 */
const FIXTURE_PING_REQUEST_KEY = 'rk_fixture_ping';

/* -------------------------------------------------------------------------------------------------
 * Source locations
 *
 * Real positions in `tests/fixtures/sample-next-app`, each with the confidence
 * `@debuggen/shared` assigns to the route that would have resolved it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A frozen {@link SourceLocation} with its route's default confidence.
 *
 * @param file Project-relative POSIX path inside the fixture app.
 * @param line 1-based line of the symbol.
 * @param column 1-based column of the symbol's name.
 * @param symbol The symbol at that position.
 * @param resolvedBy The resolution route that would have produced the location.
 * @returns The location.
 */
function fixtureLocation(
  file: string,
  line: number,
  column: number,
  symbol: string,
  resolvedBy: SourceResolvedBy,
): SourceLocation {
  return Object.freeze({
    file,
    line,
    column,
    symbol,
    resolvedBy,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE[resolvedBy],
  });
}

/**
 * Where the fixture capture's runtime items resolve in the fixture app.
 *
 * `handlePingClick` is also the `sourceLink` node's location
 * ({@link FIXTURE_SOURCE_LINK_LOCATION}), and `pingFetchCall` is the suggested
 * location of the hypothesis whose chip lands in `src/components/PingWidget.tsx`.
 */
export const FIXTURE_SOURCE_LOCATIONS = Object.freeze({
  pingWidget: fixtureLocation('src/components/PingWidget.tsx', 31, 17, 'PingWidget', 'code-graph'),
  handlePingClick: fixtureLocation(
    'src/components/PingWidget.tsx',
    48,
    18,
    'handlePingClick',
    'code-graph',
  ),
  pingFetchCall: fixtureLocation('src/components/PingWidget.tsx', 52, 25, 'fetch', 'source-map'),
  pingPage: fixtureLocation('app/page.tsx', 83, 25, 'PingPage', 'code-graph'),
  fixtureLayout: fixtureLocation('app/layout.tsx', 81, 25, 'FixtureLayout', 'code-graph'),
  pingRouteHandler: fixtureLocation('app/api/ping/route.ts', 107, 23, 'GET', 'route-map'),
  buildPingPayload: fixtureLocation('app/api/ping/route.ts', 93, 16, 'buildPingPayload', 'patch'),
});

/** The location the panel's `sourceLink` node points at. */
export const FIXTURE_SOURCE_LINK_LOCATION: SourceLocation =
  FIXTURE_SOURCE_LOCATIONS.handlePingClick;

/* -------------------------------------------------------------------------------------------------
 * The synthetic capture
 *
 * One click on `Run check`, as the product would have stored it: the
 * interaction, the commit and renders it caused, three identical `GET /api/ping`
 * requests, the server request, route handler and patched function the first
 * one reached, two executions of one parameterized statement, a long task, and
 * the commit and render that followed the response as an async continuation.
 * Every record shares {@link FIXTURE_TRACE_ID}, so the `trace`, `spans` and
 * `events` sources describe the same interaction.
 * ---------------------------------------------------------------------------------------------- */

/** Which of the two fixture producers emitted a record. */
type FixtureProducer = 'browser' | 'server';

/** The producer id of each fixture producer. */
const FIXTURE_PRODUCER_IDS: Readonly<Record<FixtureProducer, ProducerId>> = Object.freeze({
  browser: FIXTURE_BROWSER_PRODUCER_ID,
  server: FIXTURE_SERVER_PRODUCER_ID,
});

/**
 * One record of the fixture capture before the service's attribution: timing is
 * an offset from {@link FIXTURE_CAPTURE_START_MS} and spans are named by ordinal
 * (see {@link fixtureSpanId}).
 */
interface FixtureEventDraft {
  /** The record's name in {@link FIXTURE_EVENT_IDS}. */
  readonly key: string;
  readonly kind: TelemetryKind;
  readonly name: string;
  readonly tier: TelemetryTier;
  readonly producer: FixtureProducer;
  /** This record's span ordinal. */
  readonly span: number;
  /** The parent span's ordinal, when the record has a parent. */
  readonly parent?: number;
  /** Start, in milliseconds after {@link FIXTURE_CAPTURE_START_MS}. */
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly status: TelemetryStatus;
  /** Redaction-shaped attributes: names, counts, summaries and parameterized text only. */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly source?: SourceLocation;
}

/** The request attributes the three `GET /api/ping` occurrences share. */
const PING_FETCH_ATTRIBUTES = Object.freeze({
  'http.method': 'GET',
  url: '/api/ping',
  'http.status_code': 200,
  initiator: 'PingWidget',
  request_key: FIXTURE_PING_REQUEST_KEY,
  sameOrigin: true,
  traceparentInjected: true,
});

/** The statement both synthetic database spans execute, parameterized. */
const PING_CHECK_STATEMENT = 'SELECT reply FROM ping_checks WHERE id = $1';

/** The attributes both synthetic database spans share. */
const PING_CHECK_QUERY_ATTRIBUTES = Object.freeze({
  'db.system': 'postgresql',
  'db.statement': PING_CHECK_STATEMENT,
  'db.rowCount': 1,
  'db.operation': 'SELECT',
  'db.name': 'fixture',
});

/** A prop-value summary: a type and a short preview, never the value itself. */
const PROMISE_PROP_SUMMARY = Object.freeze({
  type: 'object',
  preview: 'Promise',
  truncated: false,
});

/**
 * The fixture capture, in the order the service ingested it.
 *
 * The `as const` keeps each `key` a literal so {@link FixtureEventKey} is the
 * closed set of names; the `satisfies` clause checks every draft against the
 * draft shape without widening it.
 */
const FIXTURE_EVENT_DRAFTS = [
  {
    key: 'interaction',
    kind: 'interaction',
    name: 'click button',
    tier: 'browser',
    producer: 'browser',
    span: 1,
    offsetMs: 0,
    durationMs: 16.8,
    status: 'ok',
    attributes: {
      'event.type': 'click',
      'target.selector': 'button[data-testid="ping-button"]',
      'target.tagName': 'BUTTON',
      'target.text': 'Run check',
      componentChain: ['PingWidget', 'PingPage', 'FixtureLayout'],
      inputDelay: 0.8,
    },
    source: FIXTURE_SOURCE_LOCATIONS.handlePingClick,
  },
  {
    key: 'clickCommit',
    kind: 'commit',
    name: 'React commit',
    tier: 'browser',
    producer: 'browser',
    span: 2,
    parent: 1,
    offsetMs: 1.9,
    durationMs: 3.4,
    status: 'ok',
    attributes: { phase: 'update', renderCount: 2, rootName: 'FixtureLayout' },
  },
  {
    key: 'pageRender',
    kind: 'render',
    name: 'PingPage',
    tier: 'browser',
    producer: 'browser',
    span: 3,
    parent: 2,
    offsetMs: 2,
    durationMs: 0.6,
    status: 'ok',
    attributes: {
      component: 'PingPage',
      phase: 'update',
      renderCount: 2,
      trigger: 'props',
      changedProps: [
        { key: 'searchParams', previous: PROMISE_PROP_SUMMARY, next: PROMISE_PROP_SUMMARY },
      ],
      actualDuration: 0.6,
      ownerChain: ['FixtureLayout'],
    },
    source: FIXTURE_SOURCE_LOCATIONS.pingPage,
  },
  {
    key: 'clickRender',
    kind: 'render',
    name: 'PingWidget',
    tier: 'browser',
    producer: 'browser',
    span: 4,
    parent: 2,
    offsetMs: 2.7,
    durationMs: 1.9,
    status: 'ok',
    attributes: {
      component: 'PingWidget',
      phase: 'update',
      renderCount: 2,
      trigger: 'state',
      changedProps: [],
      actualDuration: 1.9,
      ownerChain: ['PingPage', 'FixtureLayout'],
    },
    source: FIXTURE_SOURCE_LOCATIONS.pingWidget,
  },
  {
    key: 'pingFetch',
    kind: 'fetch',
    name: 'GET /api/ping',
    tier: 'browser',
    producer: 'browser',
    span: 5,
    parent: 1,
    offsetMs: 5.4,
    durationMs: 318.2,
    status: 'ok',
    attributes: PING_FETCH_ATTRIBUTES,
    source: FIXTURE_SOURCE_LOCATIONS.pingFetchCall,
  },
  {
    key: 'longTask',
    kind: 'perf.longtask',
    name: 'longtask',
    tier: 'browser',
    producer: 'browser',
    span: 6,
    parent: 1,
    offsetMs: 6.1,
    durationMs: 71.5,
    status: 'ok',
    attributes: { attribution: 'self', blockingTime: 21.5 },
  },
  {
    key: 'duplicatePingFetch',
    kind: 'fetch',
    name: 'GET /api/ping',
    tier: 'browser',
    producer: 'browser',
    span: 7,
    parent: 1,
    offsetMs: 21.9,
    durationMs: 301.7,
    status: 'ok',
    attributes: PING_FETCH_ATTRIBUTES,
    source: FIXTURE_SOURCE_LOCATIONS.pingFetchCall,
  },
  {
    key: 'secondDuplicatePingFetch',
    kind: 'fetch',
    name: 'GET /api/ping',
    tier: 'browser',
    producer: 'browser',
    span: 8,
    parent: 1,
    offsetMs: 37.3,
    durationMs: 288.4,
    status: 'ok',
    attributes: PING_FETCH_ATTRIBUTES,
    source: FIXTURE_SOURCE_LOCATIONS.pingFetchCall,
  },
  {
    key: 'serverRequest',
    kind: 'http.server',
    name: 'GET /api/ping',
    tier: 'server',
    producer: 'server',
    span: 9,
    parent: 5,
    offsetMs: 8.8,
    durationMs: 309.4,
    status: 'ok',
    attributes: {
      'http.method': 'GET',
      url: '/api/ping',
      'http.route': '/api/ping',
      'http.status_code': 200,
      'next.route': '/api/ping',
      'next.span_type': 'BaseServer.handleRequest',
    },
  },
  {
    key: 'routeHandler',
    kind: 'route.handler',
    name: 'executing api route (app) /api/ping',
    tier: 'server',
    producer: 'server',
    span: 10,
    parent: 9,
    offsetMs: 10.6,
    durationMs: 306.1,
    status: 'ok',
    attributes: {
      'http.method': 'GET',
      'http.route': '/api/ping',
      'next.route': '/api/ping',
      'next.span_type': 'AppRouteRouteHandlers.runHandler',
      symbol: 'GET',
    },
    source: FIXTURE_SOURCE_LOCATIONS.pingRouteHandler,
  },
  {
    key: 'payloadFunction',
    kind: 'function',
    name: 'buildPingPayload',
    tier: 'server',
    producer: 'server',
    span: 11,
    parent: 10,
    offsetMs: 11.3,
    durationMs: 303.8,
    status: 'ok',
    attributes: { symbol: 'buildPingPayload', module: 'app/api/ping/route.ts', async: true },
    source: FIXTURE_SOURCE_LOCATIONS.buildPingPayload,
  },
  // Synthetic: the fixture app has no database. These two spans give the
  // waterfall and the query table a server/database pair to draw.
  {
    key: 'pingCheckQuery',
    kind: 'db.query',
    name: 'SELECT ping_checks',
    tier: 'db',
    producer: 'server',
    span: 12,
    parent: 11,
    offsetMs: 13,
    durationMs: 11.6,
    status: 'ok',
    attributes: PING_CHECK_QUERY_ATTRIBUTES,
  },
  {
    key: 'repeatedPingCheckQuery',
    kind: 'db.query',
    name: 'SELECT ping_checks',
    tier: 'db',
    producer: 'server',
    span: 13,
    parent: 11,
    offsetMs: 26.2,
    durationMs: 8.9,
    status: 'ok',
    attributes: PING_CHECK_QUERY_ATTRIBUTES,
  },
  {
    key: 'replyCommit',
    kind: 'commit',
    name: 'React commit',
    tier: 'browser',
    producer: 'browser',
    span: 14,
    parent: 5,
    offsetMs: 324.9,
    durationMs: 2.9,
    status: 'ok',
    attributes: {
      phase: 'update',
      renderCount: 1,
      rootName: 'FixtureLayout',
      lineage: 'async-continuation',
    },
  },
  {
    key: 'replyRender',
    kind: 'render',
    name: 'PingWidget',
    tier: 'browser',
    producer: 'browser',
    span: 15,
    parent: 14,
    offsetMs: 325.1,
    durationMs: 2.3,
    status: 'ok',
    attributes: {
      component: 'PingWidget',
      phase: 'update',
      renderCount: 3,
      trigger: 'state',
      changedProps: [],
      actualDuration: 2.3,
      ownerChain: ['PingPage', 'FixtureLayout'],
      lineage: 'async-continuation',
    },
    source: FIXTURE_SOURCE_LOCATIONS.pingWidget,
  },
] as const satisfies readonly FixtureEventDraft[];

/** The name of one record of the fixture capture. */
export type FixtureEventKey = (typeof FIXTURE_EVENT_DRAFTS)[number]['key'];

/**
 * Deep-freezes a JSON-shaped value in place and returns it.
 *
 * @param value A value built from plain objects and arrays.
 * @returns The same value, frozen at every level.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }

  return value;
}

/**
 * Attributes the drafts to the fixture session and capture, assigns ids,
 * per-producer `seq` and store `ingestSeq`, and validates every record against
 * the persisted event schema.
 *
 * @param drafts The capture, in ingest order.
 * @returns The persisted events, frozen.
 * @throws Error when a draft is not a valid persisted event, repeats a span, or
 *   names a parent span the capture does not hold.
 */
function materializeFixtureEvents(drafts: readonly FixtureEventDraft[]): readonly TelemetryEvent[] {
  const spans = new Set<number>();

  for (const draft of drafts) {
    if (spans.has(draft.span)) {
      throw new Error(`Fixture event "${draft.key}" repeats span ordinal ${String(draft.span)}.`);
    }

    spans.add(draft.span);
  }

  const seqByProducer = new Map<FixtureProducer, number>();

  return Object.freeze(
    drafts.map((draft, index) => {
      if (draft.parent !== undefined && !spans.has(draft.parent)) {
        throw new Error(
          `Fixture event "${draft.key}" names a parent span the capture does not hold.`,
        );
      }

      const seq = seqByProducer.get(draft.producer) ?? 0;
      seqByProducer.set(draft.producer, seq + 1);

      const parsed = parseTelemetryEvent({
        id: fixtureEventId(index + 1),
        traceId: FIXTURE_TRACE_ID,
        spanId: fixtureSpanId(draft.span),
        ...(draft.parent === undefined ? {} : { parentSpanId: fixtureSpanId(draft.parent) }),
        kind: draft.kind,
        name: draft.name,
        startTime: FIXTURE_CAPTURE_START_MS + draft.offsetMs,
        duration: draft.durationMs,
        tier: draft.tier,
        attributes: structuredClone(draft.attributes),
        status: draft.status,
        producerId: FIXTURE_PRODUCER_IDS[draft.producer],
        seq,
        ...(draft.source === undefined ? {} : { source: draft.source }),
        sessionId: FIXTURE_SESSION_ID,
        captureId: FIXTURE_CAPTURE_ID,
        ingestSeq: index + 1,
      });

      if (!parsed.ok) {
        throw new Error(
          `Fixture event "${draft.key}" is not a valid persisted TelemetryEvent: ${parsed.error.message}`,
          { cause: parsed.error },
        );
      }

      return deepFreeze(parsed.value);
    }),
  );
}

/**
 * Every record of the fixture capture as the store holds it: persisted
 * `TelemetryEvent`s, validated and frozen, in ingest order.
 */
export const FIXTURE_EVENTS: readonly TelemetryEvent[] =
  materializeFixtureEvents(FIXTURE_EVENT_DRAFTS);

/**
 * A frozen record with one value per key.
 *
 * `Object.fromEntries` cannot carry the key type through, so the result is
 * asserted back to it; the assertion is sound because every key of `keys` is
 * mapped exactly once.
 *
 * @param keys The keys, in order.
 * @param valueOf The value of each key.
 * @returns The record.
 */
function recordFrom<K extends string, V>(
  keys: readonly K[],
  valueOf: (key: K) => V,
): Readonly<Record<K, V>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, valueOf(key)])) as Record<K, V>);
}

/** The persisted fixture event behind each name, for the lookups below. */
const FIXTURE_EVENT_BY_KEY: ReadonlyMap<FixtureEventKey, TelemetryEvent> = new Map(
  FIXTURE_EVENT_DRAFTS.map((draft, index) => {
    const event = FIXTURE_EVENTS[index];

    if (event === undefined) {
      throw new Error(`Fixture event "${draft.key}" was not materialized.`);
    }

    return [draft.key, event] as const;
  }),
);

/**
 * The persisted fixture event with this name.
 *
 * @param key The record's name.
 * @returns The event.
 */
export function fixtureEventFor(key: FixtureEventKey): TelemetryEvent {
  const event = FIXTURE_EVENT_BY_KEY.get(key);

  if (event === undefined) {
    throw new Error(`The fixture capture holds no event named "${key}".`);
  }

  return event;
}

/**
 * The event id of every named record of the fixture capture.
 *
 * `EventRef`-compatible: each value is the `eventId` a summary evidence chip
 * carries, so a spec can click a chip and assert that `EventDetails` shows the
 * event with this id.
 */
export const FIXTURE_EVENT_IDS: Readonly<Record<FixtureEventKey, EventId>> = recordFrom(
  FIXTURE_EVENT_DRAFTS.map((draft) => draft.key),
  (key) => fixtureEventFor(key).id,
);

/**
 * An evidence reference to a named fixture record, with every redundant
 * coordinate the reference schema allows filled from the event itself.
 *
 * @param key The record's name.
 * @param label Optional chip caption.
 * @returns The reference.
 */
export function fixtureEventRef(key: FixtureEventKey, label?: string): EventRef {
  const event = fixtureEventFor(key);

  return Object.freeze({
    eventId: event.id,
    traceId: event.traceId,
    spanId: event.spanId,
    kind: event.kind,
    ...(label === undefined ? {} : { label }),
  });
}

/* -------------------------------------------------------------------------------------------------
 * The panel-data resolver
 *
 * The documented semantics of `POST /sessions/:id/panel-data`
 * (`apps/local-service/src/panels/data.ts`, AAP 0.4.2), applied to the fixture
 * capture in memory: `filter` narrows, `sort` orders with the stable secondary
 * key `id`, `limit` (default 200, clamped to 5 000) and `offset` (default 0) page
 * the array-valued sources, and every page echoes `total` and `nextOffset`. The
 * route is an application module that `tests/tsconfig.json` does not map, so its
 * orderings and read plans are restated here as data; everything they feed -
 * the correlator and every aggregate - is the telemetry package's own function.
 * ---------------------------------------------------------------------------------------------- */

/** The sources whose result carries a `DataPage` echo, read off the protocol's union. */
type PagedDataSource = Extract<DataResult, { readonly nextOffset: unknown }>['source'];

/** The paged sources whose order a query may choose; `metrics` keeps `METRIC_IDS` order. */
type SortedDataSource = Exclude<PagedDataSource, 'metrics'>;

/** The payload field of one source's result. */
type PayloadOf<S extends DataQuerySource> =
  DataResultFor<S> extends infer R ? (S extends keyof R ? R[S] : never) : never;

/** One row of a paged source's payload. */
type DataRowOf<S extends PagedDataSource> =
  PayloadOf<S> extends readonly (infer Row)[] ? Row : never;

/** The required fields of `Row` that hold a number or a string. */
type ComparableField<Row> = {
  [K in keyof Row]-?: Row[K] extends number | string ? K : never;
}[keyof Row] &
  string;

/** One key of a comparator chain. */
interface SortKey<Row> {
  readonly field: ComparableField<Row>;
  readonly direction: 'asc' | 'desc';
}

/** A comparator chain that always ends in `id` ascending, the route's stable secondary key. */
type SortChain<Row> = readonly [
  ...SortKey<Row>[],
  SortKey<Row> & { readonly field: 'id'; readonly direction: 'asc' },
];

/** The route's comparator chains per sortable source (`SOURCE_SORT_KEYS` in the route). */
const SOURCE_SORT_CHAINS: {
  readonly [S in SortedDataSource]: Readonly<
    Partial<Record<DataQuerySort, SortChain<DataRowOf<S>>>>
  >;
} = Object.freeze({
  spans: {
    duration_desc: [
      { field: 'duration', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  events: {
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'duration', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  renders: {
    count_desc: [
      { field: 'renderCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  requests: {
    count_desc: [
      { field: 'count', direction: 'desc' },
      { field: 'duplicateCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  queries: {
    duration_desc: [
      { field: 'totalDurationMs', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    count_desc: [
      { field: 'executionCount', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ],
    start_asc: [
      { field: 'firstStartTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
  stateTransitions: {
    start_asc: [
      { field: 'startTime', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  },
});

/** The order a sortable source takes when a query names no sort, or one that does not apply. */
const DEFAULT_SORT_BY_SOURCE: Readonly<Record<SortedDataSource, DataQuerySort>> = Object.freeze({
  spans: 'duration_desc',
  events: 'start_asc',
  renders: 'count_desc',
  requests: 'count_desc',
  queries: 'duration_desc',
  stateTransitions: 'start_asc',
});

/**
 * Numbers numerically, strings by UTF-16 code unit (never `localeCompare`, whose
 * answer depends on the host), anything else after both.
 */
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const leftRank = typeof left === 'number' || typeof left === 'string' ? 0 : 1;
  const rightRank = typeof right === 'number' || typeof right === 'string' ? 0 : 1;
  return leftRank - rightRank;
}

/**
 * Orders `rows` of a sortable source by the chain of the sort that applies to
 * it, into a fresh array.
 *
 * @param source The sortable source.
 * @param rows The rows, never sorted in place.
 * @param requested The query's `sort`; an absent or inapplicable one falls back
 *   to the source's default, exactly as the route does.
 * @returns The ordered rows.
 */
function orderRows<S extends SortedDataSource>(
  source: S,
  rows: readonly DataRowOf<S>[],
  requested: DataQuerySort | undefined,
): DataRowOf<S>[] {
  const chains: (typeof SOURCE_SORT_CHAINS)[S] = SOURCE_SORT_CHAINS[source];
  const fallback = DEFAULT_SORT_BY_SOURCE[source];
  const chain = (requested === undefined ? undefined : chains[requested]) ?? chains[fallback];

  if (chain === undefined) {
    throw new Error(`No ordering is declared for the "${source}" source.`);
  }

  const keys: readonly SortKey<DataRowOf<S>>[] = chain;

  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const order = compareValues(left[key.field], right[key.field]);

      if (order !== 0) {
        return key.direction === 'desc' ? -order : order;
      }
    }

    return 0;
  });
}

/** The page window a query resolves to. */
interface ResolvedPaging {
  readonly limit: number;
  readonly offset: number;
}

/**
 * The window for a query: its own `limit`, or the default, clamped to the
 * ceiling; its own `offset`, or the default.
 */
function resolvePaging(query: Pick<DataQuery, 'limit' | 'offset'>): ResolvedPaging {
  return {
    limit: Math.min(query.limit ?? DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT),
    offset: query.offset ?? DATA_QUERY_DEFAULT_OFFSET,
  };
}

/**
 * The window over rows already in their final order, and its echo: `total`
 * before paging, and `nextOffset` equal to `offset` plus the page length while
 * the page returned something and more remain, `null` otherwise.
 */
function applyPage<Row>(
  rows: readonly Row[],
  paging: ResolvedPaging,
): { readonly items: Row[]; readonly page: DataPage } {
  const items = rows.slice(paging.offset, paging.offset + paging.limit);
  const following = paging.offset + items.length;

  return {
    items,
    page: {
      total: rows.length,
      limit: paging.limit,
      offset: paging.offset,
      nextOffset: items.length > 0 && following < rows.length ? following : null,
    },
  };
}

/** A narrowing of the capture's events, field for field the store's. */
interface EventNarrowing {
  readonly traceId?: string | undefined;
  readonly kinds?: readonly TelemetryKind[] | undefined;
  readonly tier?: TelemetryTier | undefined;
  readonly minDuration?: number | undefined;
  readonly component?: string | undefined;
}

/**
 * The capture's events a narrowing keeps, in capture order (start time, then
 * id). An empty `kinds` list selects nothing; `component` matches the
 * `component` attribute exactly; `minDuration` keeps durations at or above it.
 */
function narrowEvents(narrowing: EventNarrowing): TelemetryEvent[] {
  const { traceId, kinds, tier, minDuration, component } = narrowing;

  if (kinds !== undefined && kinds.length === 0) {
    return [];
  }

  return FIXTURE_EVENTS.filter(
    (event) =>
      (traceId === undefined || event.traceId === traceId) &&
      (kinds === undefined || kinds.includes(event.kind)) &&
      (tier === undefined || event.tier === tier) &&
      (minDuration === undefined || event.duration >= minDuration) &&
      (component === undefined || event.attributes['component'] === component),
  ).sort(
    (left, right) =>
      compareValues(left.startTime, right.startTime) || compareValues(left.id, right.id),
  );
}

/** A filter, whole, as a narrowing. */
function fullNarrowing(filter: DataQueryFilter | undefined): EventNarrowing {
  return {
    traceId: filter?.traceId,
    kinds: filter?.kinds,
    tier: filter?.tier,
    minDuration: filter?.minDuration,
    component: filter?.component,
  };
}

/** Whether a filter narrows by anything other than the trace. */
function narrowsSubjects(filter: DataQueryFilter | undefined): boolean {
  return (
    filter !== undefined &&
    (filter.kinds !== undefined ||
      filter.tier !== undefined ||
      filter.minDuration !== undefined ||
      filter.component !== undefined)
  );
}

/** Every kind in at least one group, in vocabulary order. */
function unionOfKinds(...groups: readonly (readonly TelemetryKind[])[]): readonly TelemetryKind[] {
  return TELEMETRY_KINDS.filter((kind) => groups.some((group) => group.includes(kind)));
}

/** The intersection of two kind narrowings, `undefined` meaning every kind. */
function intersectKinds(
  left: readonly TelemetryKind[] | undefined,
  right: readonly TelemetryKind[] | undefined,
): readonly TelemetryKind[] | undefined {
  if (left === undefined) {
    return right === undefined ? undefined : unionOfKinds(right);
  }

  if (right === undefined) {
    return left;
  }

  return left.filter((kind) => right.includes(kind));
}

/** The kinds the `spans` source reads: every kind except the instants (errors and state). */
const SPAN_SOURCE_KINDS: readonly TelemetryKind[] = TELEMETRY_KINDS.filter(
  (kind) => !ERROR_KINDS.includes(kind) && !STATE_KINDS.includes(kind),
);

/** The kinds whose declared attributes carry a component-tree snapshot. */
const COMPONENT_SNAPSHOT_KINDS: readonly TelemetryKind[] = TELEMETRY_KINDS.filter((kind) =>
  COMPONENT_TREE_ATTRIBUTE_KEYS.every((key) => attributeKeysFor(kind).includes(key)),
);

/** The sources computed from a slice of events rather than read as rows. */
type AggregateDataSource = Exclude<DataQuerySource, 'trace' | 'spans' | 'events'>;

/**
 * How an aggregate source reads its slice (`AGGREGATE_READ_PLANS` in the
 * route): the kinds read, and the kinds a filter narrows while the rest of the
 * slice stays whole as the context the aggregate resolves its subjects against.
 */
interface AggregateReadPlan {
  readonly sliceKinds: readonly TelemetryKind[] | undefined;
  readonly subjectKinds: readonly TelemetryKind[] | undefined;
}

/** The route's read plan per aggregate source. */
const AGGREGATE_READ_PLANS: Readonly<Record<AggregateDataSource, AggregateReadPlan>> =
  Object.freeze({
    renders: { sliceKinds: RENDER_KINDS, subjectKinds: undefined },
    componentTree: {
      sliceKinds: unionOfKinds(RENDER_KINDS, COMPONENT_SNAPSHOT_KINDS),
      subjectKinds: undefined,
    },
    requests: { sliceKinds: unionOfKinds(REQUEST_KINDS, PERF_KINDS), subjectKinds: REQUEST_KINDS },
    queries: { sliceKinds: undefined, subjectKinds: QUERY_KINDS },
    stateTransitions: { sliceKinds: undefined, subjectKinds: STATE_KINDS },
    graph: { sliceKinds: undefined, subjectKinds: undefined },
    metrics: { sliceKinds: undefined, subjectKinds: undefined },
  });

/** The events an aggregate source is computed from, per its read plan. */
function readAggregateSlice(
  source: AggregateDataSource,
  filter: DataQueryFilter | undefined,
): TelemetryEvent[] {
  const plan = AGGREGATE_READ_PLANS[source];
  const subjectKinds = plan.subjectKinds;

  if (subjectKinds === undefined) {
    return narrowEvents({
      ...fullNarrowing(filter),
      kinds: intersectKinds(plan.sliceKinds, filter?.kinds),
    });
  }

  const context = narrowEvents({ traceId: filter?.traceId, kinds: plan.sliceKinds });

  if (!narrowsSubjects(filter)) {
    return context;
  }

  const selected = new Set(
    narrowEvents({
      ...fullNarrowing(filter),
      kinds: intersectKinds(subjectKinds, filter?.kinds),
    }).map((event) => event.id),
  );

  return context.filter((event) => !subjectKinds.includes(event.kind) || selected.has(event.id));
}

/**
 * The trace a `trace` query resolves to: its `traceId`, or else the capture's
 * first trace in capture order.
 */
function traceIdFor(filter: DataQueryFilter | undefined): TraceId | undefined {
  return filter?.traceId ?? narrowEvents({})[0]?.traceId;
}

/** Metric values in `METRIC_IDS` order, the first value of an id kept. */
function orderMetrics(values: readonly MetricValue[]): MetricValue[] {
  const byId = new Map<MetricValue['id'], MetricValue>();

  for (const value of values) {
    if (!byId.has(value.id)) {
      byId.set(value.id, value);
    }
  }

  return METRIC_IDS.flatMap((id) => {
    const value = byId.get(id);
    return value === undefined ? [] : [value];
  });
}

/** Whether a filter sets any field at all. */
function filtersAnything(filter: DataQueryFilter | undefined): boolean {
  return filter !== undefined && Object.values(filter).some((value) => value !== undefined);
}

/**
 * Resolves one parsed query against the fixture capture.
 *
 * One branch per source, closed by `assertNever`, each answering with the
 * narrowed source as its discriminant.
 */
function resolveParsedQuery(query: DataQuery): DataResult {
  const paging = resolvePaging(query);
  const { filter, sort } = query;

  switch (query.source) {
    case 'trace': {
      const traceId = traceIdFor(filter);
      const trace =
        traceId === undefined
          ? undefined
          : correlateTrace(FIXTURE_EVENTS, traceId, { maxDepth: DEFAULT_MAX_DEPTH });
      return { source: query.source, trace: trace ?? null };
    }

    case 'spans': {
      const rows = narrowEvents({
        ...fullNarrowing(filter),
        kinds: intersectKinds(SPAN_SOURCE_KINDS, filter?.kinds),
      });
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, spans: items, ...page };
    }

    case 'events': {
      const rows = narrowEvents(fullNarrowing(filter));
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, events: items, ...page };
    }

    case 'renders': {
      const rows: readonly RenderStat[] = aggregateRenders(
        readAggregateSlice(query.source, filter),
      );
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, renders: items, ...page };
    }

    case 'componentTree': {
      const snapshot = buildComponentTreeSnapshot(readAggregateSlice(query.source, filter));
      return { source: query.source, componentTree: snapshot ?? null };
    }

    case 'requests': {
      const rows: readonly RequestGroup[] = aggregateRequests(
        readAggregateSlice(query.source, filter),
      );
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, requests: items, ...page };
    }

    case 'queries': {
      const rows: readonly QueryGroup[] = aggregateQueries(
        readAggregateSlice(query.source, filter),
      );
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, queries: items, ...page };
    }

    case 'stateTransitions': {
      const slice = readAggregateSlice(query.source, filter);
      const rows = aggregateStateTransitions(slice, { maxTransitions: slice.length });
      const { items, page } = applyPage(orderRows(query.source, rows, sort), paging);
      return { source: query.source, stateTransitions: items, ...page };
    }

    case 'graph':
      return {
        source: query.source,
        graph: buildDependencyGraph(readAggregateSlice(query.source, filter)),
      };

    case 'metrics': {
      // Unfiltered, the route serves the capture summary's metrics, which are
      // computed over the whole capture; filtered, it computes them over the
      // slice the filter selects. `sort` never applies: the order is fixed.
      const events = filtersAnything(filter)
        ? readAggregateSlice(query.source, filter)
        : FIXTURE_EVENTS;
      const { items, page } = applyPage(orderMetrics(computeMetrics(events)), paging);
      return { source: query.source, metrics: items, ...page };
    }

    default:
      return assertNever(query.source, 'Unhandled panel data source');
  }
}

/**
 * Answers one panel data query from the fixture capture, exactly as
 * `POST /sessions/:id/panel-data` would have answered it for the stored capture.
 *
 * The query is parsed first (a spec may hand over whatever the panel page
 * posted), and the answer is validated against the protocol's response schema
 * before it is returned, so a fixture result is by construction a response the
 * panel's data provider accepts.
 *
 * @param query The node's data query, or the request body the panel posted.
 * @returns The data result for the query's source.
 * @throws Error when the query is not a valid `DataQuery`, or when the computed
 *   result is not a valid `DataResult` (a fixture defect, reported by path).
 */
export function resolvePanelDataFixture(query: DataQuery): DataResult {
  const parsedQuery = parseDataQuery(query);

  if (!parsedQuery.ok) {
    throw new Error(`Not a panel data query: ${parsedQuery.error.message}`, {
      cause: parsedQuery.error,
    });
  }

  const result = resolveParsedQuery(parsedQuery.value);
  const validated = parseDataResult(result);

  if (!validated.ok) {
    throw new Error(
      `The fixture's "${result.source}" result is not a valid panel-data response: ${validated.error.message}`,
      { cause: validated.error },
    );
  }

  return result;
}

/* -------------------------------------------------------------------------------------------------
 * Per-source fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * The default answer of every data source: the result of `{ source }` with no
 * filter, the default sort and the default page - one `DataResult` member per
 * member of `DATA_QUERY_SOURCES`, keyed by that source.
 */
export type PanelDataFixtures = { readonly [S in DataQuerySource]: DataResultFor<S> };

/**
 * Whether a result answers `source`.
 *
 * @param result A data result.
 * @param source The source it should answer.
 * @returns `true`, narrowing `result`, when its discriminant is `source`.
 */
function isResultFor<S extends DataQuerySource>(
  result: DataResult,
  source: S,
): result is DataResultFor<S> {
  return result.source === source;
}

/**
 * Builds the default answer of every data source from the fixture capture.
 *
 * Iterates `DATA_QUERY_SOURCES`, so a source added to the vocabulary is answered
 * here - or fails here, loudly - without an edit.
 *
 * @returns One validated result per source; a fresh object on every call, deeply
 *   equal to the previous one.
 */
export function buildPanelDataFixtures(): PanelDataFixtures {
  const fixtures = Object.fromEntries(
    DATA_QUERY_SOURCES.map((source) => {
      const result = resolvePanelDataFixture({ source });
      const answered: DataQuerySource = result.source;

      if (!isResultFor(result, source)) {
        throw new Error(`The "${source}" query was answered as "${answered}".`);
      }

      return [source, result];
    }),
  );

  // Sound: every source of the vocabulary was mapped above, each to a result
  // whose discriminant was just checked to be that source.
  return Object.freeze(fixtures) as PanelDataFixtures;
}

/**
 * Whether a result holds nothing to draw: a `null` tree or snapshot, a graph
 * without nodes, or a page whose filtered source is empty.
 */
function isEmptyResult(result: DataResult): boolean {
  switch (result.source) {
    case 'trace':
      return result.trace === null;
    case 'componentTree':
      return result.componentTree === null;
    case 'graph':
      return result.graph.nodes.length === 0;
    case 'spans':
    case 'events':
    case 'renders':
    case 'requests':
    case 'queries':
    case 'stateTransitions':
    case 'metrics':
      return result.total === 0;
    default:
      return assertNever(result, 'Unhandled panel data result');
  }
}

/**
 * The sources whose default answer is empty, in vocabulary order.
 *
 * Computed, not listed: every source is resolved and the empty ones kept. With
 * the capture above that is `stateTransitions` - the capture holds no
 * hook-state record because its plan armed no state tracking - and the node
 * reading it must render its `EmptyState` rather than an error. The module
 * refuses to load when nothing is empty, because the spec's empty-state
 * assertion would then have nothing to assert.
 */
export const EMPTY_DATA_SOURCES: readonly DataQuerySource[] = Object.freeze(
  ((): DataQuerySource[] => {
    const fixtures = buildPanelDataFixtures();
    const empty = DATA_QUERY_SOURCES.filter((source) => isEmptyResult(fixtures[source]));

    if (empty.length === 0) {
      throw new Error('The fixture capture must leave at least one data source empty.');
    }

    return empty;
  })(),
);

/* -------------------------------------------------------------------------------------------------
 * The analysis the panel's summary is normalised from
 *
 * Facts and hypotheses cite fixture events only, and every number in a
 * statement is read from the same aggregate the panel's tables draw, so the
 * summary and the views beside it cannot disagree.
 * ---------------------------------------------------------------------------------------------- */

/** A duration in whole milliseconds, for a sentence. */
function wholeMs(value: number): string {
  return String(Math.round(value));
}

/**
 * The fixture key of a persisted fixture event.
 *
 * @param eventId An event id an aggregate reported.
 * @returns The key of the fixture record with that id.
 */
function fixtureKeyOf(eventId: EventId): FixtureEventKey {
  for (const [key, event] of FIXTURE_EVENT_BY_KEY) {
    if (event.id === eventId) {
      return key;
    }
  }

  throw new Error(
    `An aggregate reported an event id the fixture capture does not hold: ${eventId}.`,
  );
}

/** The single row a fixture aggregate is expected to produce for one subject. */
function onlyRow<Row>(rows: readonly Row[], what: string, matches: (row: Row) => boolean): Row {
  const matching = rows.filter(matches);
  const [row] = matching;

  if (row === undefined || matching.length !== 1) {
    throw new Error(
      `Expected exactly one ${what} in the fixture capture; found ${String(matching.length)}.`,
    );
  }

  return row;
}

/** The analysis inputs computed once from the capture's default answers. */
const FIXTURE_AGGREGATES = (() => {
  const fixtures = buildPanelDataFixtures();
  const pingRequests = onlyRow(
    fixtures.requests.requests,
    'duplicated GET /api/ping group',
    (group) => group.hasDuplicates,
  );
  const pingQueries = onlyRow(
    fixtures.queries.queries,
    'group of the ping_checks statement',
    (group) => group.executionCount > 1,
  );
  const widgetRenders = onlyRow(
    fixtures.renders.renders,
    'PingWidget render row',
    (stat) => stat.component === fixtureEventFor('clickRender').attributes['component'],
  );

  return Object.freeze({ pingRequests, pingQueries, widgetRenders });
})();

/**
 * Evidence references to the occurrences an aggregate row lists.
 *
 * @param eventIds The occurrences' event ids.
 * @param label The caption every chip carries.
 * @returns One reference per occurrence.
 */
function occurrenceRefs(eventIds: readonly EventId[], label: string): EventRef[] {
  return eventIds.map((eventId) => fixtureEventRef(fixtureKeyOf(eventId), label));
}

/** The fetch occurrences of the duplicated request group. */
const DUPLICATE_REQUEST_REFS: readonly EventRef[] = occurrenceRefs(
  FIXTURE_AGGREGATES.pingRequests.occurrences.map((occurrence) => occurrence.eventId),
  `${FIXTURE_AGGREGATES.pingRequests.method} ${FIXTURE_AGGREGATES.pingRequests.path}`,
);

/** The two executions of the synthetic statement. */
const STATEMENT_REFS: readonly EventRef[] = occurrenceRefs(
  FIXTURE_AGGREGATES.pingQueries.occurrences.map((occurrence) => occurrence.eventId),
  'ping_checks statement',
);

/** The renders of `PingWidget`. */
const WIDGET_RENDER_REFS: readonly EventRef[] = occurrenceRefs(
  FIXTURE_AGGREGATES.widgetRenders.occurrences.map((occurrence) => occurrence.eventId),
  'PingWidget render',
);

/**
 * What the fixture capture shows, each statement citing the events that show it.
 *
 * The first fact's first chip is the first `GET /api/ping` occurrence
 * (`FIXTURE_EVENT_IDS.pingFetch`), which is what a spec clicks to assert the
 * event-selection path.
 */
export const FIXTURE_FACTS: readonly Fact[] = deepFreeze([
  {
    statement: `${String(FIXTURE_AGGREGATES.pingRequests.count)} identical ${FIXTURE_AGGREGATES.pingRequests.method} ${FIXTURE_AGGREGATES.pingRequests.path} requests started within ${wholeMs(
      FIXTURE_AGGREGATES.pingRequests.lastStartTime -
        FIXTURE_AGGREGATES.pingRequests.firstStartTime,
    )} ms of each other during one click.`,
    evidence: [...DUPLICATE_REQUEST_REFS],
  },
  {
    statement: `GET /api/ping spent ${wholeMs(fixtureEventFor('payloadFunction').duration)} ms of its ${wholeMs(
      fixtureEventFor('serverRequest').duration,
    )} ms on the server inside buildPingPayload.`,
    evidence: [
      fixtureEventRef('serverRequest', 'GET /api/ping'),
      fixtureEventRef('payloadFunction', 'buildPingPayload'),
    ],
  },
  {
    statement: `One parameterized statement ran ${String(FIXTURE_AGGREGATES.pingQueries.executionCount)} times during the request, for ${wholeMs(
      FIXTURE_AGGREGATES.pingQueries.totalDurationMs,
    )} ms in total.`,
    evidence: [...STATEMENT_REFS],
  },
  {
    statement: `PingWidget rendered ${String(FIXTURE_AGGREGATES.widgetRenders.renderCount)} times during the interaction.`,
    evidence: [...WIDGET_RENDER_REFS],
  },
]);

/**
 * What may explain it, each ranked and evidence-backed.
 *
 * The first carries a suggested location in `src/components/PingWidget.tsx`, so
 * the summary's confidence badge and suggested-location chip are both
 * exercised; the last carries none, so the chip's absence is exercised too.
 */
export const FIXTURE_HYPOTHESES: readonly Hypothesis[] = deepFreeze([
  {
    statement:
      'handlePingClick issues a request every time it runs, so identical requests from one click suggest the handler ran more than once.',
    evidence: [...DUPLICATE_REQUEST_REFS],
    confidence: 'medium',
    suggestedLocation: FIXTURE_SOURCE_LOCATIONS.pingFetchCall,
  },
  {
    statement:
      'Most of the reply latency is the wait inside buildPingPayload rather than the database work it performs.',
    evidence: [fixtureEventRef('payloadFunction', 'buildPingPayload'), ...STATEMENT_REFS],
    confidence: 'high',
    suggestedLocation: FIXTURE_SOURCE_LOCATIONS.buildPingPayload,
  },
  {
    statement: 'The repeated execution of the same statement within one request may be redundant.',
    evidence: [...STATEMENT_REFS],
    confidence: 'low',
  },
]);

/** The validated analysis `normalizePanel` copies the summary's two lists from. */
export const FIXTURE_ANALYSIS: NormalizeAnalysis = Object.freeze({
  observed: FIXTURE_FACTS,
  likelyCauses: FIXTURE_HYPOTHESES,
});

/* -------------------------------------------------------------------------------------------------
 * The catalog-driven panel specification
 *
 * The node set is never listed. Every catalog entry is visited: each
 * visualization entry contributes exactly one leaf, and each container entry
 * becomes one level of a nested chain the leaves are distributed over. What a
 * leaf asks for is decided from its entry alone - its sources, its default
 * source, the telemetry kinds it draws and the option fields it declares.
 * ---------------------------------------------------------------------------------------------- */

/** Options for {@link buildCatalogPanelSpecInput}. */
export interface CatalogPanelSpecInputOptions {
  /** The panel title. Defaults to {@link FIXTURE_PANEL_TITLE}. */
  readonly title?: string | undefined;
  /** The authored summary sentence, which becomes `summary.headline`. */
  readonly headline?: string | undefined;
}

/** Options for {@link buildCatalogPanelSpec}: the authoring options plus the normalisation context. */
export interface CatalogPanelSpecOptions extends CatalogPanelSpecInputOptions {
  /**
   * The panel id. Defaults to {@link FIXTURE_PANEL_ID}, or to
   * {@link FIXTURE_FALLBACK_PANEL_ID} when `fallback` is set.
   */
  readonly id?: PanelId | undefined;
  /** The session the panel belongs to. Defaults to {@link FIXTURE_SESSION_ID}. */
  readonly sessionId?: SessionId | undefined;
  /** The panel generation, from 1. Defaults to 1. */
  readonly panelVersion?: number | undefined;
  /** The panel this one replaces, on a regeneration. */
  readonly supersedes?: PanelId | undefined;
  /** Mark the document as a deterministic fallback, which the panel shows under a banner. */
  readonly fallback?: boolean | undefined;
}

/** The fixture panel's title. */
export const FIXTURE_PANEL_TITLE = 'Panel catalog coverage: Run check click';

/** The fixture panel's authored summary, which normalisation keeps as prose only. */
export const FIXTURE_PANEL_HEADLINE =
  'One Run check click, drawn by every node type the panel catalog declares.';

/** The one data source a node reads when it draws a single correlated interaction. */
const TRACE_SOURCE: DataQuerySource = 'trace';

/**
 * The ranking refinement: a kind-indifferent view of the flat span records is a
 * ranking of work, so it is asked for the slowest few - the "slowest
 * operations" table - which also exercises the route's sort and page.
 */
const SPAN_RANKING = Object.freeze({
  source: 'spans' satisfies DataQuerySource,
  sort: 'duration_desc' satisfies DataQuerySort,
  limit: 5,
});

/**
 * The split direction the fixture writes: the one that is *not* the renderer's
 * default, so the node's explicit option carries information.
 */
const FIXTURE_SPLIT_DIRECTION =
  SPLIT_DIRECTIONS.find((direction) => direction !== DEFAULT_SPLIT_DIRECTION) ??
  DEFAULT_SPLIT_DIRECTION;

/** Every catalog entry, in the catalog's own key order. */
function catalogEntries(): readonly PanelNodeCatalogEntry[] {
  return Object.values(PANEL_NODE_CATALOG);
}

/**
 * The value of one of an entry's declared option fields.
 *
 * @param option The option name, from the entry's `options`.
 * @param entry The entry declaring it.
 * @returns The value the fixture writes.
 * @throws Error for an option this fixture does not know how to fill, so a new
 *   option fails here, naming itself, instead of being silently left out.
 */
function optionValueFor(option: string, entry: PanelNodeCatalogEntry): unknown {
  switch (option) {
    case 'metrics':
      // Every metric id, in vocabulary order - including the ones this capture
      // cannot measure, which the cards must show as unavailable.
      return [...METRIC_IDS];
    case 'location':
      return FIXTURE_SOURCE_LINK_LOCATION;
    case 'direction':
      return FIXTURE_SPLIT_DIRECTION;
    default:
      throw new Error(
        `Catalog entry "${entry.type}" declares the option "${option}", which the panel fixture does not know how to fill.`,
      );
  }
}

/**
 * The flat query fields one query-backed leaf is authored with.
 *
 * - The source is the entry's `defaultSource`, else its first listed source. A
 *   default source is **not** written, so the normaliser's default path is what
 *   supplies it; any other source is written flat on the node.
 * - `filter.traceId` names the fixture trace on every node that can read the
 *   correlated trace, and `filter.kinds` is the entry's own `telemetryKinds`
 *   whenever the entry declares a subject.
 * - The kind-indifferent span view gets {@link SPAN_RANKING}.
 *
 * @throws Error when the entry lists no source or the chosen source is refused
 *   by `isSourceAllowedForNode`.
 */
function queryFieldsFor(entry: PanelNodeCatalogEntry): Record<string, unknown> {
  const source = entry.defaultSource ?? entry.sources[0];

  if (source === undefined) {
    throw new Error(`Catalog entry "${entry.type}" requires a query but lists no source.`);
  }

  if (!isSourceAllowedForNode(entry.type, source)) {
    throw new Error(`Catalog entry "${entry.type}" does not allow its own source "${source}".`);
  }

  const fields: Record<string, unknown> = {};

  if (entry.defaultSource === undefined) {
    fields['source'] = source;
  }

  const filter: Record<string, unknown> = {};

  if (entry.sources.includes(TRACE_SOURCE)) {
    filter['traceId'] = FIXTURE_TRACE_ID;
  }

  if (entry.telemetryKinds.length > 0) {
    filter['kinds'] = [...entry.telemetryKinds];
  }

  if (Object.keys(filter).length > 0) {
    fields['filter'] = filter;
  }

  if (source === SPAN_RANKING.source && entry.telemetryKinds.length === 0) {
    fields['sort'] = SPAN_RANKING.sort;
    fields['limit'] = SPAN_RANKING.limit;
  }

  return fields;
}

/**
 * The authored candidate for one visualization entry: its type, its label as a
 * title, its query fields when it reads captured data, and its options.
 */
function leafCandidateFor(entry: PanelNodeCatalogEntry): Record<string, unknown> {
  const node: Record<string, unknown> = { type: entry.type, title: entry.label };

  if (entry.requiresQuery || entry.sources.length > 0) {
    Object.assign(node, queryFieldsFor(entry));
  }

  for (const option of entry.options ?? []) {
    node[option] = optionValueFor(option, entry);
  }

  return node;
}

/**
 * Nests the leaves in the containers: container `i` holds the `i`-th contiguous
 * share of the leaves and then container `i + 1`, so every container type is a
 * real, populated level and the tree is as deep as there are container types.
 *
 * @throws Error when a container entry cannot hold children.
 */
function nestInContainers(
  containers: readonly PanelNodeCatalogEntry[],
  leaves: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (containers.length === 0) {
    return [...leaves];
  }

  const share = Math.ceil(leaves.length / containers.length);
  let nested: Record<string, unknown> | undefined;

  for (let index = containers.length - 1; index >= 0; index -= 1) {
    const entry = containers[index];

    if (entry === undefined) {
      continue;
    }

    if (!entry.supportsChildren) {
      throw new Error(`Catalog container "${entry.type}" does not support children.`);
    }

    const children = leaves.slice(index * share, (index + 1) * share);
    const container: Record<string, unknown> = {
      type: entry.type,
      title: entry.label,
      children: nested === undefined ? children : [...children, nested],
    };

    for (const option of entry.options ?? []) {
      container[option] = optionValueFor(option, entry);
    }

    nested = container;
  }

  return nested === undefined ? [] : [nested];
}

/**
 * The fixture panel as a model would author it, derived by iterating
 * `PANEL_NODE_CATALOG`, and parsed by the product's authoring schema.
 *
 * @param options Title and headline overrides.
 * @returns The parsed authoring document.
 * @throws Error when the catalog holds a node type the schema cannot parse yet
 *   (the message names it), when the authoring schema refuses the candidate, or
 *   when two catalog labels collide.
 */
export function buildCatalogPanelSpecInput(
  options: CatalogPanelSpecInputOptions = {},
): PanelSpecInput {
  const entries = catalogEntries();
  const unknown = entries.filter((entry) => !isKnownPanelNodeType(entry.type));

  if (unknown.length > 0) {
    throw new Error(
      `PANEL_NODE_CATALOG holds ${unknown.map((entry) => `"${entry.type}"`).join(', ')}, which the panel schema cannot parse, validate or render yet.`,
    );
  }

  const containers = entries.filter((entry) => entry.kind === 'layout');
  const leaves = entries.filter((entry) => entry.kind === 'visualization').map(leafCandidateFor);
  const titles = entries.map((entry) => entry.label);

  if (new Set(titles).size !== titles.length) {
    throw new Error(
      'Catalog labels must be unique: the panel spec identifies each node by its title.',
    );
  }

  const parsed = parsePanelSpecInput({
    title: options.title ?? FIXTURE_PANEL_TITLE,
    summary: options.headline ?? FIXTURE_PANEL_HEADLINE,
    layout: nestInContainers(containers, leaves),
  });

  if (!parsed.ok) {
    throw new Error(
      `The catalog-driven panel is not a valid authored panel: ${parsed.error.message}${
        parsed.error.hint === undefined ? '' : ` ${parsed.error.hint}`
      }`,
      { cause: parsed.error },
    );
  }

  return parsed.value;
}

/** Every node type a layout contains, in document order. */
function nodeTypesIn(spec: PanelSpec): ReadonlySet<PanelNodeType> {
  const types = new Set<PanelNodeType>();
  walkPanelNodes(spec.layout, (node) => {
    types.add(node.type);
  });
  return types;
}

/**
 * The node types `panel-render.spec.ts` must find rendered: every key of
 * `PANEL_NODE_CATALOG`, read at call time, so a catalog addition joins the
 * expectation without an edit.
 *
 * @returns The catalog's node types.
 * @throws Error when the catalog holds a key that is not a node type this build
 *   can validate, which would otherwise be dropped silently.
 */
export function expectedRenderedNodeTypes(): ReadonlySet<PanelNodeType> {
  const expected = new Set<PanelNodeType>();

  for (const key of Object.keys(PANEL_NODE_CATALOG)) {
    if (!isKnownPanelNodeType(key)) {
      throw new Error(`PANEL_NODE_CATALOG holds "${key}", which is not a panel node type.`);
    }

    expected.add(key);
  }

  return expected;
}

/** The ids of every fixture event and trace, for the integrity checks below. */
const FIXTURE_EVENT_ID_SET: ReadonlySet<EventId> = new Set(FIXTURE_EVENTS.map((event) => event.id));
const FIXTURE_TRACE_ID_SET: ReadonlySet<TraceId> = new Set(
  FIXTURE_EVENTS.map((event) => event.traceId),
);

/**
 * Refuses a normalised spec that misses a catalog type, cites an event the
 * capture does not hold, or filters on a trace it does not hold.
 *
 * @throws Error naming the first defect.
 */
function assertFixtureIntegrity(spec: PanelSpec): void {
  const present = nodeTypesIn(spec);
  const missing = [...expectedRenderedNodeTypes()].filter((type) => !present.has(type));

  if (missing.length > 0) {
    throw new Error(`The fixture panel is missing catalogued node types: ${missing.join(', ')}.`);
  }

  for (const claim of [...spec.summary.observed, ...spec.summary.likelyCauses]) {
    for (const ref of claim.evidence) {
      const event = FIXTURE_EVENT_BY_KEY.get(fixtureKeyOf(ref.eventId));

      if (
        event === undefined ||
        !FIXTURE_EVENT_ID_SET.has(ref.eventId) ||
        (ref.traceId !== undefined && ref.traceId !== event.traceId) ||
        (ref.spanId !== undefined && ref.spanId !== event.spanId) ||
        (ref.kind !== undefined && ref.kind !== event.kind)
      ) {
        throw new Error(`Summary evidence ${ref.eventId} does not match a fixture event.`);
      }
    }
  }

  walkPanelNodes(spec.layout, (node, path) => {
    if ('query' in node) {
      const traceId = node.query.filter?.traceId;

      if (traceId !== undefined && !FIXTURE_TRACE_ID_SET.has(traceId)) {
        throw new Error(
          `Node ${path.join('.')} filters on a trace the fixture capture does not hold.`,
        );
      }
    }
  });
}

/**
 * The fixture panel, normalised by `normalizePanel` and validated by
 * `validatePanelSpec`: the stored `PanelSpec` `panel-render.spec.ts` delivers to
 * the panel page.
 *
 * Its summary's observed facts and likely causes are {@link FIXTURE_ANALYSIS}'s;
 * the authored headline is the only prose the document carries.
 *
 * @param options Title/headline overrides and the normalisation context. Pass
 *   `{ fallback: true }` for the fallback variant, which carries `meta.fallback`.
 * @returns The validated document; a fresh value on every call, deeply equal to
 *   the previous one for equal options.
 * @throws Error when normalisation produces a document the validator refuses,
 *   or one that fails the fixture's integrity checks.
 */
export function buildCatalogPanelSpec(options: CatalogPanelSpecOptions = {}): PanelSpec {
  const fallback = options.fallback === true;
  const context: NormalizeContext = {
    id: options.id ?? (fallback ? FIXTURE_FALLBACK_PANEL_ID : FIXTURE_PANEL_ID),
    sessionId: options.sessionId ?? FIXTURE_SESSION_ID,
    panelVersion: options.panelVersion ?? 1,
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    ...(fallback ? { fallback: true } : {}),
  };

  const validated = validatePanelSpec(
    normalizePanel(buildCatalogPanelSpecInput(options), FIXTURE_ANALYSIS, context),
  );

  if (!validated.ok) {
    throw new Error(
      `The normalised fixture panel failed validation: ${validated.error.message}${
        validated.error.hint === undefined ? '' : ` ${validated.error.hint}`
      }`,
      { cause: validated.error },
    );
  }

  assertFixtureIntegrity(validated.value);
  return validated.value;
}

/**
 * The node types actually present in the built fixture panel, walked with
 * `walkPanelNodes`. Equal to {@link expectedRenderedNodeTypes} by construction:
 * {@link buildCatalogPanelSpec} refuses to return a panel that misses one.
 */
export const CATALOG_NODE_TYPES: ReadonlySet<PanelNodeType> = nodeTypesIn(buildCatalogPanelSpec());
