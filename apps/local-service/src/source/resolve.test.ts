/**
 * Unit tests for `./resolve.ts`, the service's source-location resolver.
 *
 * What is pinned here is the resolver's own contract, which nothing else in the
 * workspace covers colocated: which route answers an item, in which order the
 * routes are tried, that each route stamps its own `resolvedBy` and the shared
 * default confidence for it, that an item nothing can vouch for comes back
 * `unresolved` with a closed reason instead of a guess, that a candidate
 * escaping the project is dropped rather than repaired, that genuine faults are
 * `Err` values and never exceptions, that every loop honours
 * `SOURCE_RESOLVE_LIMITS`, and that logs and errors carry ids, kinds, routes and
 * counts only.
 *
 * Every injected dependency is an in-memory fake: a `CodeQueries` object whose
 * answers are hand-built and minted through `parseSourceLocation`, a real
 * `CodeGraph` constructed from a hand-written index (no ts-morph project, no
 * indexed fixture), a `RouteMap` over the pure `matchRoute`, modification
 * records built with `createModificationRecord`, a parent-span port, a stack
 * resolver spy, a `fetch` spy and a capturing logger. The global `fetch` is
 * replaced by a guard that fails the test if anything reaches it, so no case
 * can touch the network.
 *
 * Expected confidences are always read from `DEFAULT_RESOLUTION_CONFIDENCE`
 * and expected precedence from `SOURCE_RESOLVED_BY` sorted by it, so a change
 * to the shared table moves the module and this suite together; the kinds and
 * attribute keys come from `@debuggen/telemetry`'s vocabularies and the patch
 * meta keys from `PATCH_META_KEYS`, each checked on use. The project vocabulary
 * (gauges, readings, an orbit console) is invented and shares no name with the
 * demo application.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_QUERY_LIMITS,
  CodeGraph,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  INDEXER_VERSION,
  deriveRouteFromFile,
  makeNodeId,
  matchRoute,
} from '@debuggen/code-analysis';
import type {
  CodeMatch,
  CodeNodeKind,
  CodeNodeOf,
  CodePath,
  CodeQueries,
  CodeSymbolMatch,
  DbDriver,
  RouteEntry,
  RouteMap,
  RouteQueryResult,
  SourceMapCache,
  resolveStack,
} from '@debuggen/code-analysis';
import {
  OPEN_MODIFICATION_STATUSES,
  PATCH_META_KEYS,
  createModificationRecord,
  parseSelectedTarget,
} from '@debuggen/instrumentation';
import type {
  ModificationRecord,
  ModificationStatus,
  SelectedTarget,
} from '@debuggen/instrumentation';
import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  SOURCE_RESOLVED_BY,
  err,
  isSourceLocation,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  ok,
  parseSourceLocation,
  sourceLocationSchema,
} from '@debuggen/shared';
import type { LogFields, Logger, Result, SourceLocation, SourceResolvedBy } from '@debuggen/shared';
import {
  DB_QUERY_ATTRIBUTE_KEYS,
  ERROR_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  FUNCTION_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  KIND_ATTRIBUTE_KEYS,
  MAX_CALLER_LOOKUP_HOPS,
  QUERY_KINDS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_KINDS,
  REQUEST_KINDS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  allowedTiersFor,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind, TelemetryStatus } from '@debuggen/telemetry';

import {
  SOURCE_RESOLUTION_MISS_REASONS,
  SOURCE_RESOLVE_LIMITS,
  SOURCE_ROUTE_ORDER,
  createSourceResolver,
} from './resolve.js';
import type {
  ModificationCorroborationPort,
  ParentEventPort,
  SourceResolution,
  SourceResolutionMissReason,
  SourceResolver,
  SourceResolverDeps,
} from './resolve.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary — every kind, attribute key, route and reason is checked against its declaring tuple
 * ---------------------------------------------------------------------------------------------- */

/**
 * One attribute key, checked twice against the tuple that declares it: by the
 * compiler (the key must be a member of the tuple's type) and at run time.
 */
function keyIn<Tuple extends readonly string[], Key extends Tuple[number]>(
  tuple: Tuple,
  key: Key,
): Key {
  if (!tuple.includes(key)) {
    throw new Error(`attribute key "${key}" is not declared by its kind tuple`);
  }
  return key;
}

/** One telemetry kind, checked against the kind group (or the whole vocabulary) it belongs to. */
function kindIn<Kind extends TelemetryKind>(
  kind: Kind,
  group: readonly TelemetryKind[] = TELEMETRY_KINDS,
): Kind {
  if (!group.includes(kind)) {
    throw new Error(`telemetry kind "${kind}" is not a member of its group`);
  }
  return kind;
}

/** One resolution route, checked against the shared enumeration. */
function routeIn<Route extends SourceResolvedBy>(route: Route): Route {
  if (!SOURCE_RESOLVED_BY.includes(route)) {
    throw new Error(`resolution route "${route}" is not part of SOURCE_RESOLVED_BY`);
  }
  return route;
}

/** One miss reason, checked against the module's closed vocabulary. */
function reason(value: SourceResolutionMissReason): SourceResolutionMissReason {
  if (!SOURCE_RESOLUTION_MISS_REASONS.includes(value)) {
    throw new Error(`miss reason "${value}" is not part of SOURCE_RESOLUTION_MISS_REASONS`);
  }
  return value;
}

/** The attribute keys the fixtures write, each taken from its per-kind tuple. */
const ATTR = Object.freeze({
  component: keyIn(RENDER_ATTRIBUTE_KEYS, 'component'),
  ownerChain: keyIn(RENDER_ATTRIBUTE_KEYS, 'ownerChain'),
  changedProps: keyIn(RENDER_ATTRIBUTE_KEYS, 'changedProps'),
  componentChain: keyIn(INTERACTION_ATTRIBUTE_KEYS, 'componentChain'),
  initiator: keyIn(FETCH_ATTRIBUTE_KEYS, 'initiator'),
  fetchUrl: keyIn(FETCH_ATTRIBUTE_KEYS, 'url'),
  errorStack: keyIn(ERROR_ATTRIBUTE_KEYS, 'error.stack'),
  errorMessage: keyIn(ERROR_ATTRIBUTE_KEYS, 'error.message'),
  httpMethod: keyIn(HTTP_SERVER_ATTRIBUTE_KEYS, 'http.method'),
  url: keyIn(HTTP_SERVER_ATTRIBUTE_KEYS, 'url'),
  nextRoute: keyIn(ROUTE_HANDLER_ATTRIBUTE_KEYS, 'next.route'),
  httpRoute: keyIn(ROUTE_HANDLER_ATTRIBUTE_KEYS, 'http.route'),
  symbol: keyIn(FUNCTION_ATTRIBUTE_KEYS, 'symbol'),
  module: keyIn(FUNCTION_ATTRIBUTE_KEYS, 'module'),
  dbStatement: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'db.statement'),
  dbSystem: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'db.system'),
  dbClient: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'db.client'),
  dbOperation: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'db.operation'),
});

/** The four patch `meta` keys, destructured from the one tuple `wrap-template.ts` declares. */
const [META_FILE, META_LINE, META_COLUMN, META_SYMBOL] = PATCH_META_KEYS;

/** The kinds the fixtures emit, each taken from its kind group where one exists. */
const KIND = Object.freeze({
  render: kindIn('render', RENDER_KINDS),
  commit: kindIn('commit', RENDER_KINDS),
  state: kindIn('state', STATE_KINDS),
  dbQuery: kindIn('db.query', QUERY_KINDS),
  fetch: kindIn('fetch', REQUEST_KINDS),
  xhr: kindIn('xhr', REQUEST_KINDS),
  interaction: kindIn('interaction'),
  error: kindIn('error'),
  httpServer: kindIn('http.server'),
  routeHandler: kindIn('route.handler'),
  function: kindIn('function'),
  httpClient: kindIn('http.client'),
  navigation: kindIn('navigation'),
});

/** The kinds whose catalog declares a component display name (derived, never listed). */
const COMPONENT_KINDS: readonly TelemetryKind[] = TELEMETRY_KINDS.filter((kind) =>
  KIND_ATTRIBUTE_KEYS[kind].includes(ATTR.component),
);

/** The kinds whose catalog declares a framework route pattern (derived, never listed). */
const ROUTE_KINDS: readonly TelemetryKind[] = TELEMETRY_KINDS.filter((kind) =>
  KIND_ATTRIBUTE_KEYS[kind].includes(ATTR.nextRoute),
);

/** The five routes, each checked against the shared enumeration. */
const ROUTE = Object.freeze({
  patch: routeIn('patch'),
  routeMap: routeIn('route-map'),
  codeGraph: routeIn('code-graph'),
  sourceMap: routeIn('source-map'),
  reactOwner: routeIn('react-owner'),
});

/** Kinds no resolution route handles: no component, route, symbol, stack or chain in their catalog. */
const UNHANDLED_KINDS: readonly TelemetryKind[] = Object.freeze([KIND.navigation, KIND.commit]);

/* -------------------------------------------------------------------------------------------------
 * The invented project
 * ---------------------------------------------------------------------------------------------- */

/** An absolute root that does not exist on disk: every containment check here is lexical. */
const PROJECT_ROOT = '/work/orbit-console';

/** The dev-server origin the source-map cases pin; loopback, never contacted. */
const DEV_ORIGIN = 'http://127.0.0.1:20161';

/** A declaration in the invented project. */
interface Declaration {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

const PROJECT = Object.freeze({
  component: { name: 'GaugeDial', file: 'src/components/GaugeDial.tsx', line: 7, column: 17 },
  outerComponent: {
    name: 'GaugeFrame',
    file: 'src/components/GaugeFrame.tsx',
    line: 4,
    column: 17,
  },
  fn: { name: 'computeGaugeReading', file: 'src/lib/gauges.ts', line: 21, column: 23 },
  routeFile: 'app/api/gauges/[gaugeId]/readings/route.ts',
  routePath: '/api/gauges/[gaugeId]/readings',
  concretePath: '/api/gauges/g-17/readings',
  storeFile: 'src/lib/gauge-store.ts',
  auditFile: 'src/lib/audit-store.ts',
} satisfies Record<string, Declaration | string>);

const SESSION = newSessionId();
const OTHER_SESSION = newSessionId();
const CAPTURE = newCaptureId();
const PRODUCER = newProducerId();
const TRACE = newTraceId();
const BASE_TIME = 1_750_000_000_000;
const EVENT_STATUS: TelemetryStatus = 'ok';

/** A value planted in captured data: it must never surface in a log record or an error. */
const SENTINEL = 'sentinel-marker-7f3a';

/* -------------------------------------------------------------------------------------------------
 * Builders — every fixture value passes the schema that owns its shape
 * ---------------------------------------------------------------------------------------------- */

function unwrapOk<T>(result: Result<T, DebuggenError>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} did not satisfy its schema: ${result.error.code}`);
  }
  return result.value;
}

/** A location minted the way a producer of `route` mints one: through the shared schema. */
function stampedLocation(
  route: SourceResolvedBy,
  where: { readonly file: string; readonly line: number; readonly column: number },
  symbol?: string,
  confidence: number = DEFAULT_RESOLUTION_CONFIDENCE[route],
): SourceLocation {
  return unwrapOk(
    parseSourceLocation({
      file: where.file,
      line: where.line,
      column: where.column,
      ...(symbol === undefined ? {} : { symbol }),
      resolvedBy: route,
      confidence,
    }),
    'fixture location',
  );
}

/** The patch stamp the span helper puts on a function span for `declaration`. */
function patchStamp(declaration: Declaration): SourceLocation {
  return stampedLocation(ROUTE.patch, declaration, declaration.name);
}

interface EventSpec {
  readonly kind: TelemetryKind;
  readonly name?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly traceId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly source?: SourceLocation;
  readonly startTime?: number;
  readonly sessionId?: string;
}

let sequence = 0;

/** A persisted telemetry event, parsed by `parseTelemetryEvent` so it is schema-valid. */
function makeEvent(spec: EventSpec): TelemetryEvent {
  sequence += 1;
  const [tier] = allowedTiersFor(spec.kind);
  return unwrapOk(
    parseTelemetryEvent({
      id: newEventId(),
      traceId: spec.traceId ?? TRACE,
      spanId: spec.spanId ?? newSpanId(),
      ...(spec.parentSpanId === undefined ? {} : { parentSpanId: spec.parentSpanId }),
      kind: spec.kind,
      name: spec.name ?? `${spec.kind} span`,
      startTime: spec.startTime ?? BASE_TIME + sequence,
      duration: 3.25,
      tier,
      attributes: { ...spec.attributes },
      status: EVENT_STATUS,
      producerId: PRODUCER,
      seq: sequence,
      ...(spec.source === undefined ? {} : { source: spec.source }),
      sessionId: spec.sessionId ?? SESSION,
      captureId: CAPTURE,
      ingestSeq: sequence,
    }),
    'fixture event',
  );
}

/** A modification record built by the instrumentation package's own constructor. */
function modification(
  file: string,
  status: ModificationStatus,
  appliedAt: number = BASE_TIME - 1_000,
  sessionId: string = SESSION,
): ModificationRecord {
  const originalHash = 'a'.repeat(64);
  return unwrapOk(
    createModificationRecord(
      {
        sessionId,
        planVersion: 1,
        file,
        originalHash,
        backupPath: `/tmp/debuggen-backups/${sessionId}/${originalHash}`,
        instrumentedHash: 'b'.repeat(64),
        diff: '',
        status,
      },
      { now: () => appliedAt },
    ),
    'fixture modification record',
  );
}

/** A selected element, parsed by `parseSelectedTarget`. */
function selectedTarget(componentChain: readonly string[], text = 'Refresh'): SelectedTarget {
  return unwrapOk(
    parseSelectedTarget({
      selector: 'main > section:nth-of-type(2) > button',
      tagName: 'BUTTON',
      text,
      componentChain: [...componentChain],
      url: `${DEV_ORIGIN}/gauges`,
    }),
    'fixture target',
  );
}

/** A code-graph match whose location is minted exactly as `createCodeQueries` mints one. */
function codeMatch(kind: CodeNodeKind, declaration: Declaration, score = 1): CodeMatch {
  return {
    nodeId: makeNodeId({ kind, ...declaration }),
    kind,
    name: declaration.name,
    file: declaration.file,
    location: stampedLocation(ROUTE.codeGraph, declaration, declaration.name),
    score,
  };
}

/** A `(file, symbol)` match for `findSymbol` and `hasSymbol`. */
function symbolMatch(kind: CodeNodeKind, declaration: Declaration): CodeSymbolMatch {
  return { ...codeMatch(kind, declaration), symbol: declaration.name, exported: true };
}

interface DbCallSpec {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly symbol: string;
  readonly driver: DbDriver;
  readonly operation: string;
}

/** A database call-site node, exactly as the db-call extractor shapes one. */
function dbCallNode(spec: DbCallSpec): CodeNodeOf<'db-call'> {
  const { name, file, line, column, symbol, driver, operation } = spec;
  return {
    id: makeNodeId({ kind: 'db-call', file, name, line, column }),
    kind: 'db-call',
    name,
    file,
    line,
    column,
    symbol,
    data: { driver, operation, dynamic: false },
  };
}

/** The code-graph match `findByName` answers for a database call site. */
function dbCallMatch(node: CodeNodeOf<'db-call'>): CodeMatch {
  return {
    nodeId: node.id,
    kind: node.kind,
    name: node.name,
    file: node.file,
    location: stampedLocation(ROUTE.codeGraph, node, node.symbol),
    score: 1,
  };
}

/** A real `CodeGraph` over a hand-written index: no ts-morph project, no file read. */
function graphOf(nodes: readonly CodeNodeOf<'db-call'>[]): CodeGraph {
  return CodeGraph.fromIndex({
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: PROJECT_ROOT,
    indexerVersion: INDEXER_VERSION,
    generatedAt: BASE_TIME,
    nodes,
    edges: [],
    files: [],
  });
}

/**
 * The invented project's one route module. By default it declares `GET` and
 * `POST` with a per-method handler location for each; `stamp` lets a case
 * model a misbehaving route map whose locations carry another route's stamp.
 */
function gaugeRouteEntry(
  options: { readonly stamp?: SourceResolvedBy; readonly perMethod?: boolean } = {},
): RouteEntry {
  const derived = deriveRouteFromFile(PROJECT.routeFile);
  if (derived === undefined) {
    throw new Error('the fixture route file is not a route module');
  }
  const stamp = options.stamp ?? ROUTE.routeMap;
  const at = (line: number) => ({ file: derived.file, line, column: 23 });
  const entry: RouteEntry = {
    ...derived,
    methods: ['GET', 'POST'],
    location: stampedLocation(stamp, { file: derived.file, line: 1, column: 1 }),
  };
  if (options.perMethod === false) {
    return entry;
  }
  return {
    ...entry,
    methodLocations: {
      GET: stampedLocation(stamp, at(5), 'GET'),
      POST: stampedLocation(stamp, at(18), 'POST'),
    },
  };
}

/** The `routeForUrl` answer the code queries give for a URL, built from the pure matcher. */
function routeQueryResult(
  entries: readonly RouteEntry[],
  url: string,
): RouteQueryResult | undefined {
  const match = matchRoute(entries, url);
  if (match === undefined) {
    return undefined;
  }
  const { entry } = match;
  return {
    match,
    routePath: entry.routePath,
    router: entry.router,
    kind: entry.kind,
    methods: entry.methods,
    params: match.params,
    file: entry.file,
    location: entry.location,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Fakes for every injected dependency
 * ---------------------------------------------------------------------------------------------- */

interface PathFixture {
  readonly from: { readonly file: string; readonly symbol?: string };
  readonly to: string;
  readonly depth: number;
}

interface QueryFixture {
  readonly matches?: readonly CodeMatch[];
  readonly symbols?: readonly CodeSymbolMatch[];
  readonly routes?: readonly RouteEntry[];
  readonly paths?: readonly PathFixture[];
}

interface FakeQueries {
  readonly queries: CodeQueries;
  readonly findByName: Mock<CodeQueries['findByName']>;
  readonly findSymbol: Mock<CodeQueries['findSymbol']>;
  readonly hasSymbol: Mock<CodeQueries['hasSymbol']>;
  readonly whoCalls: Mock<CodeQueries['whoCalls']>;
  readonly routeForUrl: Mock<CodeQueries['routeForUrl']>;
  readonly handlersFor: Mock<CodeQueries['handlersFor']>;
  readonly componentsRendering: Mock<CodeQueries['componentsRendering']>;
  readonly pathBetween: Mock<CodeQueries['pathBetween']>;
  readonly excerpt: Mock<CodeQueries['excerpt']>;
  /** Calls made to any query, for short-circuit assertions. */
  readonly totalCalls: () => number;
}

/**
 * A `CodeQueries` over hand-built answers. `findByName` honours `exact`,
 * `kinds` and `limit` the way the real queries do; the methods the resolver
 * has no business calling (`whoCalls`, `handlersFor`, `componentsRendering`,
 * `excerpt`) answer nothing and are asserted unused.
 */
function fakeQueries(fixture: QueryFixture = {}): FakeQueries {
  const findByName = vi.fn<CodeQueries['findByName']>((name, options) => {
    const exact = options?.exact !== false;
    const kinds = options?.kinds;
    return (fixture.matches ?? [])
      .filter((match) =>
        exact ? match.name === name : match.name.toLowerCase().includes(name.toLowerCase()),
      )
      .filter((match) => kinds === undefined || kinds.includes(match.kind))
      .slice(0, options?.limit ?? CODE_QUERY_LIMITS.maxResults);
  });
  const findSymbol = vi.fn<CodeQueries['findSymbol']>((file, symbol) =>
    (fixture.symbols ?? []).find((match) => match.file === file && match.symbol === symbol),
  );
  const hasSymbol = vi.fn<CodeQueries['hasSymbol']>((file, symbol) =>
    (fixture.symbols ?? []).some((match) => match.file === file && match.symbol === symbol),
  );
  const whoCalls = vi.fn<CodeQueries['whoCalls']>(() => []);
  const routeForUrl = vi.fn<CodeQueries['routeForUrl']>((url) =>
    routeQueryResult(fixture.routes ?? [], url),
  );
  const handlersFor = vi.fn<CodeQueries['handlersFor']>(() => []);
  const componentsRendering = vi.fn<CodeQueries['componentsRendering']>(() => []);
  const pathBetween = vi.fn<CodeQueries['pathBetween']>((from, to, options) => {
    if (typeof from === 'string' || typeof to !== 'string') {
      return undefined;
    }
    const found = (fixture.paths ?? []).find(
      (path) => path.to === to && path.from.file === from.file && path.from.symbol === from.symbol,
    );
    if (found === undefined) {
      return undefined;
    }
    if (options?.maxDepth !== undefined && found.depth > options.maxDepth) {
      return undefined;
    }
    const path: CodePath = {
      nodes: [],
      edges: [],
      depth: found.depth,
      undirected: false,
      truncated: false,
    };
    return path;
  });
  const excerpt = vi.fn<CodeQueries['excerpt']>(() => undefined);

  const spies = [
    findByName,
    findSymbol,
    hasSymbol,
    whoCalls,
    routeForUrl,
    handlersFor,
    componentsRendering,
    pathBetween,
    excerpt,
  ];
  const queries: CodeQueries = {
    limits: CODE_QUERY_LIMITS,
    findByName,
    findSymbol,
    hasSymbol,
    whoCalls,
    routeForUrl,
    handlersFor,
    componentsRendering,
    pathBetween,
    excerpt,
  };
  return {
    queries,
    findByName,
    findSymbol,
    hasSymbol,
    whoCalls,
    routeForUrl,
    handlersFor,
    componentsRendering,
    pathBetween,
    excerpt,
    totalCalls: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0),
  };
}

/** A route map over the pure matcher, with its `resolve` observable. */
function fakeRouteMap(entries: readonly RouteEntry[]): {
  readonly routeMap: RouteMap;
  readonly resolve: Mock<RouteMap['resolve']>;
} {
  const resolve = vi.fn<RouteMap['resolve']>((urlOrPathname, method) =>
    matchRoute(entries, urlOrPathname, method),
  );
  return { routeMap: { entries, resolve }, resolve };
}

/** The modification journal, answering synchronously like the SQLite repository does. */
function fakeJournal(records: readonly ModificationRecord[]): {
  readonly port: ModificationCorroborationPort;
  readonly listBySession: Mock<ModificationCorroborationPort['listBySession']>;
} {
  const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>((sessionId) =>
    ok(records.filter((record) => record.sessionId === sessionId)),
  );
  return { port: { listBySession }, listBySession };
}

/** The telemetry store's parent-span lookup, answering asynchronously. */
function fakeParents(events: readonly TelemetryEvent[]): {
  readonly port: ParentEventPort;
  readonly getBySpanId: Mock<ParentEventPort['getBySpanId']>;
} {
  const getBySpanId = vi.fn<ParentEventPort['getBySpanId']>((sessionId, spanId) =>
    Promise.resolve(
      ok(events.find((event) => event.sessionId === sessionId && event.spanId === spanId)),
    ),
  );
  return { port: { getBySpanId }, getBySpanId };
}

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that records every call, children included, with their bindings merged. */
function capturingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (more: LogFields): Logger => capturingLogger(entries, { ...bindings, ...more }),
  };
}

/** A source-map cache whose every method is observable. */
function observableCache(): {
  readonly cache: SourceMapCache;
  readonly get: Mock<SourceMapCache['get']>;
  readonly set: Mock<SourceMapCache['set']>;
} {
  const get = vi.fn<SourceMapCache['get']>(() => undefined);
  const set = vi.fn<SourceMapCache['set']>(() => undefined);
  const cache: SourceMapCache = {
    get,
    set,
    delete: () => false,
    clear: () => undefined,
    size: 0,
  };
  return { cache, get, set };
}

/** A `fetch` handed to the resolver that must never be reached unless a case expects it. */
function forbiddenFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(() =>
    Promise.reject(new Error('network access is not allowed in unit tests')),
  );
}

/** A stack resolver spy answering `locations`. */
function stackResolver(locations: readonly SourceLocation[]): Mock<typeof resolveStack> {
  return vi.fn<typeof resolveStack>(() => Promise.resolve([...locations]));
}

/**
 * A location as the stack resolver mints one, carrying a producer confidence
 * (0.1) the source-map route must replace with its own default.
 */
function mapped(file: string, line = 21): SourceLocation {
  return stampedLocation(ROUTE.sourceMap, { file, line, column: 5 }, 'loadReadings', 0.1);
}

/* -------------------------------------------------------------------------------------------------
 * The wired project and the result helpers
 * ---------------------------------------------------------------------------------------------- */

/** The invented project behind one set of fresh fakes. */
function standardProject() {
  const component = codeMatch('component', PROJECT.component);
  const outerComponent = codeMatch('component', PROJECT.outerComponent);
  const fnSymbol = symbolMatch('server-function', PROJECT.fn);
  const routeEntry = gaugeRouteEntry();
  const handlerSymbols = [
    symbolMatch('symbol', { name: 'GET', file: PROJECT.routeFile, line: 5, column: 23 }),
    symbolMatch('symbol', { name: 'POST', file: PROJECT.routeFile, line: 18, column: 23 }),
  ];
  const readingsCall = dbCallNode({
    name: 'pool.query',
    file: PROJECT.storeFile,
    line: 12,
    column: 18,
    symbol: 'readingsFor',
    driver: 'pg',
    operation: 'query',
  });
  const latestCall = dbCallNode({
    name: 'prisma.reading.findMany',
    file: PROJECT.storeFile,
    line: 30,
    column: 10,
    symbol: 'latestReading',
    driver: 'prisma',
    operation: 'findMany',
  });
  const auditCall = dbCallNode({
    name: 'pool.query',
    file: PROJECT.auditFile,
    line: 8,
    column: 9,
    symbol: 'writeAudit',
    driver: 'pg',
    operation: 'query',
  });
  const dbCalls = [readingsCall, latestCall, auditCall];
  const fnEndpoint = { file: PROJECT.fn.file, symbol: PROJECT.fn.name };
  const fake = fakeQueries({
    matches: [component, outerComponent, fnSymbol, ...dbCalls.map(dbCallMatch)],
    symbols: [fnSymbol, ...handlerSymbols],
    routes: [routeEntry],
    paths: [
      { from: fnEndpoint, to: readingsCall.id, depth: 2 },
      { from: fnEndpoint, to: latestCall.id, depth: 3 },
      { from: { file: PROJECT.routeFile, symbol: 'GET' }, to: readingsCall.id, depth: 3 },
    ],
  });
  return {
    component,
    outerComponent,
    fnSymbol,
    routeEntry,
    readingsCall,
    latestCall,
    auditCall,
    dbCalls,
    fnEndpoint,
    graph: graphOf(dbCalls),
    fake,
    routes: fakeRouteMap([routeEntry]),
  };
}

type Project = ReturnType<typeof standardProject>;

/** A resolver over `project`'s fakes, an empty journal and a forbidden `fetch`. */
function resolverFor(
  project: Project,
  overrides: Partial<SourceResolverDeps> = {},
): SourceResolver {
  return createSourceResolver({
    projectRoot: PROJECT_ROOT,
    queries: project.fake.queries,
    routeMap: project.routes.routeMap,
    graph: project.graph,
    modifications: fakeJournal([]).port,
    fetchImpl: forbiddenFetch(),
    ...overrides,
  });
}

type Resolved = Extract<SourceResolution, { status: 'resolved' }>;
type Unresolved = Extract<SourceResolution, { status: 'unresolved' }>;

/**
 * The invariants every `SourceResolution` must satisfy, applied to every
 * outcome this suite observes:
 *
 * - attempts are frozen, name only shared routes, follow `SOURCE_ROUTE_ORDER`
 *   and carry a reason from the closed vocabulary unless they hit;
 * - a resolved outcome ends with its one hit, its location carries its own
 *   route's stamp and exactly that route's default confidence, and the
 *   location passes the shared schema unchanged;
 * - an unresolved outcome has no `location` property at all, no hit, and a
 *   reason from the vocabulary other than `aborted` (an `Err`-only reason).
 */
function expectWellFormed(resolution: SourceResolution): void {
  expect(resolution.attempted.length).toBeGreaterThan(0);
  expect(Object.isFrozen(resolution.attempted)).toBe(true);

  let previous = -1;
  for (const attempt of resolution.attempted) {
    expect(SOURCE_RESOLVED_BY).toContain(attempt.route);
    const position = SOURCE_ROUTE_ORDER.indexOf(attempt.route);
    expect(position).toBeGreaterThanOrEqual(previous);
    previous = position;
    if (attempt.outcome === 'hit') {
      expect(attempt).not.toHaveProperty('reason');
    } else {
      expect(SOURCE_RESOLUTION_MISS_REASONS).toContain(attempt.reason);
    }
  }

  if (resolution.status === 'resolved') {
    expect(Object.keys(resolution).sort()).toEqual(['attempted', 'location', 'route', 'status']);
    expect(resolution.location.resolvedBy).toBe(resolution.route);
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[resolution.route]);
    expect(isSourceLocation(resolution.location)).toBe(true);
    expect(sourceLocationSchema.parse(resolution.location)).toEqual(resolution.location);
    expect(unwrapOk(parseSourceLocation(resolution.location), 'resolved location')).toEqual(
      resolution.location,
    );
    expect(resolution.attempted.at(-1)).toEqual({ route: resolution.route, outcome: 'hit' });
    expect(resolution.attempted.filter((attempt) => attempt.outcome === 'hit')).toHaveLength(1);
  } else {
    expect(Object.keys(resolution).sort()).toEqual(['attempted', 'reason', 'status']);
    expect(resolution).not.toHaveProperty('location');
    expect(SOURCE_RESOLUTION_MISS_REASONS).toContain(resolution.reason);
    expect(resolution.reason).not.toBe(reason('aborted'));
    expect(resolution.attempted.some((attempt) => attempt.outcome === 'hit')).toBe(false);
  }
}

async function resolved(
  pending: Promise<Result<SourceResolution, DebuggenError>>,
): Promise<Resolved> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(`expected Ok, got Err ${result.error.code}`);
  }
  expectWellFormed(result.value);
  if (result.value.status !== 'resolved') {
    throw new Error(`expected a resolved outcome, got unresolved (${result.value.reason})`);
  }
  return result.value;
}

async function unresolved(
  pending: Promise<Result<SourceResolution, DebuggenError>>,
): Promise<Unresolved> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(`expected Ok, got Err ${result.error.code}`);
  }
  expectWellFormed(result.value);
  if (result.value.status !== 'unresolved') {
    throw new Error(`expected an unresolved outcome, got one resolved by ${result.value.route}`);
  }
  return result.value;
}

/** The `Err` of a call that must fail with a coded `DebuggenError`, never a throw. */
async function failed<T>(pending: Promise<Result<T, DebuggenError>>): Promise<DebuggenError> {
  const result = await pending;
  if (result.ok) {
    throw new Error('expected Err, got Ok');
  }
  expect(result.error).toBeInstanceOf(DebuggenError);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  return result.error;
}

/** The resolved map of a batch call that must succeed. */
async function located(
  pending: Promise<Result<ReadonlyMap<string, SourceLocation>, DebuggenError>>,
): Promise<ReadonlyMap<string, SourceLocation>> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(`expected Ok, got Err ${result.error.code}`);
  }
  for (const location of result.value.values()) {
    expect(isSourceLocation(location)).toBe(true);
    expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[location.resolvedBy]);
  }
  return result.value;
}

/** A browser stack whose frames point into dev-server chunks. */
const CHUNK_STACK = [
  'Error',
  `    at loadReadings (${DEV_ORIGIN}/_next/static/chunks/app/gauges/page.js:12:34)`,
  `    at onRefresh (${DEV_ORIGIN}/_next/static/chunks/app/gauges/page.js:40:9)`,
].join('\n');

/* -------------------------------------------------------------------------------------------------
 * No case may reach the network: the global `fetch` is a guard for the whole file
 * ---------------------------------------------------------------------------------------------- */

let globalFetch: Mock<typeof fetch>;

beforeEach(() => {
  globalFetch = forbiddenFetch();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------------------------------
 * The fixture vocabulary itself
 * ---------------------------------------------------------------------------------------------- */

describe('fixture vocabulary', () => {
  it('derives the component and route kinds from the attribute catalog', () => {
    expect(COMPONENT_KINDS).toContain(KIND.render);
    expect(COMPONENT_KINDS).toContain(KIND.state);
    expect(COMPONENT_KINDS).not.toContain(KIND.commit);
    expect(ROUTE_KINDS).toEqual(expect.arrayContaining([KIND.httpServer, KIND.routeHandler]));
    for (const kind of UNHANDLED_KINDS) {
      expect(KIND_ATTRIBUTE_KEYS[kind]).not.toContain(ATTR.component);
      expect(KIND_ATTRIBUTE_KEYS[kind]).not.toContain(ATTR.nextRoute);
      expect(KIND_ATTRIBUTE_KEYS[kind]).not.toContain(ATTR.initiator);
    }
  });

  it('builds every fixture through the schema that owns it', () => {
    const project = standardProject();
    for (const match of [project.component, project.fnSymbol]) {
      expect(isSourceLocation(match.location)).toBe(true);
      expect(match.location.resolvedBy).toBe(ROUTE.codeGraph);
      expect(match.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.codeGraph]);
    }
    expect(project.routeEntry.location.resolvedBy).toBe(ROUTE.routeMap);
    expect(project.graph.nodesByKind('db-call')).toHaveLength(project.dbCalls.length);
    expect(modification(PROJECT.fn.file, 'applied').file).toBe(PROJECT.fn.file);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ---------------------------------------------------------------------------------------------- */

describe('SOURCE_ROUTE_ORDER', () => {
  /** The precedence the shared table implies, computed here from the shared constants. */
  const expectedOrder = (): SourceResolvedBy[] =>
    [...SOURCE_RESOLVED_BY].sort(
      (left, right) => DEFAULT_RESOLUTION_CONFIDENCE[right] - DEFAULT_RESOLUTION_CONFIDENCE[left],
    );

  it('is SOURCE_RESOLVED_BY sorted by DEFAULT_RESOLUTION_CONFIDENCE, highest first', () => {
    expect(SOURCE_ROUTE_ORDER).toEqual(expectedOrder());
    expect(new Set(SOURCE_ROUTE_ORDER)).toEqual(new Set(SOURCE_RESOLVED_BY));
    expect(SOURCE_ROUTE_ORDER).toHaveLength(SOURCE_RESOLVED_BY.length);
    expect(Object.isFrozen(SOURCE_ROUTE_ORDER)).toBe(true);
  });

  it('is strictly descending in confidence, so no two routes tie today', () => {
    const confidences = SOURCE_ROUTE_ORDER.map((route) => DEFAULT_RESOLUTION_CONFIDENCE[route]);
    for (let index = 1; index < confidences.length; index += 1) {
      const higher = confidences[index - 1];
      const lower = confidences[index];
      if (higher === undefined || lower === undefined) {
        throw new Error('the route order has a hole');
      }
      expect(higher).toBeGreaterThan(lower);
    }
    const [first] = SOURCE_ROUTE_ORDER;
    expect(first === undefined ? undefined : DEFAULT_RESOLUTION_CONFIDENCE[first]).toBe(
      Math.max(...Object.values(DEFAULT_RESOLUTION_CONFIDENCE)),
    );
  });

  it('places patch, route-map, code-graph, source-map and react-owner where the table puts them', () => {
    const order = expectedOrder();
    for (const route of Object.values(ROUTE)) {
      expect(SOURCE_ROUTE_ORDER.indexOf(route)).toBe(order.indexOf(route));
    }
  });
});

describe('SOURCE_RESOLUTION_MISS_REASONS', () => {
  it('is a frozen, duplicate-free, closed vocabulary', () => {
    expect(Object.isFrozen(SOURCE_RESOLUTION_MISS_REASONS)).toBe(true);
    expect(new Set(SOURCE_RESOLUTION_MISS_REASONS).size).toBe(
      SOURCE_RESOLUTION_MISS_REASONS.length,
    );
    for (const value of SOURCE_RESOLUTION_MISS_REASONS) {
      expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('names every reason this suite asserts on', () => {
    for (const value of [
      'no-applicable-route',
      'index-unavailable',
      'symbol-not-found',
      'ambiguous',
      'not-corroborated',
      'no-initiator-stack',
      'dev-server-unknown',
      'unmapped-frame',
      'outside-project',
      'invalid-location',
      'aborted',
    ] as const) {
      expect(reason(value)).toBe(value);
    }
  });
});

describe('SOURCE_RESOLVE_LIMITS', () => {
  it('is frozen and derives its stack and parent-walk caps from the upstream constants', () => {
    expect(Object.isFrozen(SOURCE_RESOLVE_LIMITS)).toBe(true);
    expect(SOURCE_RESOLVE_LIMITS.maxStackFrames).toBe(DEFAULT_MAX_FRAMES);
    expect(SOURCE_RESOLVE_LIMITS.maxSourceMaps).toBe(DEFAULT_MAX_MAPS);
    expect(SOURCE_RESOLVE_LIMITS.maxParentHops).toBe(MAX_CALLER_LOOKUP_HOPS);
    expect(SOURCE_RESOLVE_LIMITS.maxNameCandidates).toBeLessThanOrEqual(
      CODE_QUERY_LIMITS.maxResults,
    );
    expect(SOURCE_RESOLVE_LIMITS.maxNameCandidates).toBeGreaterThanOrEqual(2);
    for (const value of Object.values(SOURCE_RESOLVE_LIMITS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('lets an override lower a cap but never raise it, and keeps the name cap at two or more', async () => {
    const lookup = async (limits: SourceResolverDeps['limits']): Promise<number | undefined> => {
      const project = standardProject();
      await resolverFor(project, { limits }).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      );
      return project.fake.findByName.mock.calls[0]?.[1]?.limit;
    };

    expect(await lookup(undefined)).toBe(SOURCE_RESOLVE_LIMITS.maxNameCandidates);
    expect(await lookup({ maxNameCandidates: 3 })).toBe(3);
    expect(await lookup({ maxNameCandidates: 1 })).toBe(2);
    expect(await lookup({ maxNameCandidates: SOURCE_RESOLVE_LIMITS.maxNameCandidates * 10 })).toBe(
      SOURCE_RESOLVE_LIMITS.maxNameCandidates,
    );
    expect(await lookup({ maxNameCandidates: 2.5 })).toBe(SOURCE_RESOLVE_LIMITS.maxNameCandidates);
    expect(await lookup({ maxNameCandidates: -4 })).toBe(SOURCE_RESOLVE_LIMITS.maxNameCandidates);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The factory
 * ---------------------------------------------------------------------------------------------- */

describe('createSourceResolver', () => {
  it('does no work at construction and returns a frozen three-method handle', () => {
    const project = standardProject();
    const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
    const parents = fakeParents([]);
    const resolveStackImpl = stackResolver([]);
    const fetchImpl = forbiddenFetch();

    const resolver = resolverFor(project, {
      modifications: journal.port,
      events: parents.port,
      resolveStackImpl,
      fetchImpl,
      devServerOrigin: DEV_ORIGIN,
    });

    expect(Object.isFrozen(resolver)).toBe(true);
    expect(Object.keys(resolver).sort()).toEqual([
      'resolveEvent',
      'resolveEvents',
      'resolveTarget',
    ]);
    expect(project.fake.totalCalls()).toBe(0);
    expect(project.routes.resolve).not.toHaveBeenCalled();
    expect(journal.listBySession).not.toHaveBeenCalled();
    expect(parents.getBySpanId).not.toHaveBeenCalled();
    expect(resolveStackImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers PROJECT_NOT_FOUND from every method when the project root is not absolute', async () => {
    for (const projectRoot of ['relative/orbit-console', '', './orbit-console']) {
      const project = standardProject();
      const journal = fakeJournal([]);
      const resolver = resolverFor(project, { projectRoot, modifications: journal.port });
      const event = makeEvent({
        kind: KIND.render,
        attributes: { [ATTR.component]: PROJECT.component.name },
      });

      expect((await failed(resolver.resolveEvent(event))).code).toBe('PROJECT_NOT_FOUND');
      expect(
        (await failed(resolver.resolveTarget(selectedTarget([PROJECT.component.name])))).code,
      ).toBe('PROJECT_NOT_FOUND');
      expect((await failed(resolver.resolveEvents([event]))).code).toBe('PROJECT_NOT_FOUND');
      expect(project.fake.totalCalls()).toBe(0);
      expect(journal.listBySession).not.toHaveBeenCalled();
    }
  });

  it('degrades to index-unavailable, never Err, when no index has been built yet', async () => {
    const resolver = createSourceResolver({
      projectRoot: PROJECT_ROOT,
      modifications: fakeJournal([]).port,
    });
    const cases: TelemetryEvent[] = [
      makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      makeEvent({ kind: KIND.state, attributes: { [ATTR.component]: PROJECT.component.name } }),
      makeEvent({
        kind: KIND.httpServer,
        attributes: { [ATTR.httpMethod]: 'GET', [ATTR.nextRoute]: PROJECT.routePath },
      }),
      makeEvent({
        kind: KIND.function,
        attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
      }),
      makeEvent({ kind: KIND.dbQuery, attributes: { [ATTR.dbClient]: 'pg' } }),
    ];
    for (const event of cases) {
      const outcome = await unresolved(resolver.resolveEvent(event));
      expect(outcome.reason).toBe(reason('index-unavailable'));
    }
    const target = await unresolved(
      resolver.resolveTarget(selectedTarget([PROJECT.component.name])),
    );
    expect(target.reason).toBe(reason('index-unavailable'));
  });
});

/* -------------------------------------------------------------------------------------------------
 * SourceResolver.resolveEvent — the routes, one by one
 * ---------------------------------------------------------------------------------------------- */

describe('SourceResolver.resolveEvent', () => {
  /** A function span the span helper stamped with the patch position of `PROJECT.fn`. */
  const patchedFunction = (overrides: Partial<EventSpec> = {}): TelemetryEvent =>
    makeEvent({
      kind: KIND.function,
      name: PROJECT.fn.name,
      source: patchStamp(PROJECT.fn),
      ...overrides,
    });

  describe('route 1 — patch', () => {
    it('keeps a patch stamp the session journal corroborates, at the patch confidence', async () => {
      const project = standardProject();
      const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
      const outcome = await resolved(
        resolverFor(project, { modifications: journal.port }).resolveEvent(patchedFunction()),
      );

      expect(outcome.route).toBe(ROUTE.patch);
      expect(outcome.location).toEqual(patchStamp(PROJECT.fn));
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
      expect(outcome.attempted).toEqual([{ route: ROUTE.patch, outcome: 'hit' }]);
      expect(journal.listBySession).toHaveBeenCalledTimes(1);
      expect(journal.listBySession).toHaveBeenCalledWith(SESSION);
    });

    it('is corroborated by a record in every open (non-reverted) status', async () => {
      for (const status of OPEN_MODIFICATION_STATUSES) {
        const outcome = await resolved(
          resolverFor(standardProject(), {
            modifications: fakeJournal([modification(PROJECT.fn.file, status)]).port,
          }).resolveEvent(patchedFunction()),
        );
        expect(outcome.route).toBe(ROUTE.patch);
      }
    });

    it('accepts a reverted record only when the patch was applied before the span ran', async () => {
      const appliedAt = BASE_TIME + 10_000;
      const journal = fakeJournal([modification(PROJECT.fn.file, 'reverted', appliedAt)]);

      const after = await resolved(
        resolverFor(standardProject(), { modifications: journal.port }).resolveEvent(
          patchedFunction({ startTime: appliedAt + 5 }),
        ),
      );
      expect(after.route).toBe(ROUTE.patch);

      const before = await resolved(
        resolverFor(standardProject(), { modifications: journal.port }).resolveEvent(
          patchedFunction({ startTime: appliedAt - 5 }),
        ),
      );
      expect(before.route).not.toBe(ROUTE.patch);
      expect(before.attempted[0]).toEqual({
        route: ROUTE.patch,
        outcome: 'rejected',
        reason: reason('not-corroborated'),
      });
    });

    it('builds the same patch location from the four forwarded meta keys alone', async () => {
      const event = makeEvent({
        kind: KIND.function,
        name: PROJECT.fn.name,
        attributes: {
          [META_FILE]: PROJECT.fn.file,
          [META_LINE]: PROJECT.fn.line,
          [META_COLUMN]: PROJECT.fn.column,
          [META_SYMBOL]: PROJECT.fn.name,
        },
      });
      expect(event).not.toHaveProperty('source');

      const outcome = await resolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
        }).resolveEvent(event),
      );
      expect(outcome.route).toBe(ROUTE.patch);
      expect(outcome.location).toEqual(patchStamp(PROJECT.fn));
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
    });

    it('refuses an uncorroborated stamp and falls through to a later route, never keeping confidence 1', async () => {
      const project = standardProject();
      const event = patchedFunction({
        attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
      });
      const outcome = await resolved(resolverFor(project).resolveEvent(event));

      expect(outcome.attempted[0]).toEqual({
        route: ROUTE.patch,
        outcome: 'rejected',
        reason: reason('not-corroborated'),
      });
      expect(outcome.route).toBe(ROUTE.codeGraph);
      expect(outcome.location).toEqual(project.fnSymbol.location);
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.codeGraph]);
      expect(outcome.location.confidence).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
    });

    it('reports not-corroborated when no later route can place an unindexed patched symbol', async () => {
      const unindexed: Declaration = {
        name: 'blendReadingSeries',
        file: PROJECT.fn.file,
        line: 44,
        column: 3,
      };
      const journal = fakeJournal([
        modification(PROJECT.auditFile, 'applied'),
        modification(PROJECT.fn.file, 'applied', BASE_TIME - 1_000, OTHER_SESSION),
      ]);
      const outcome = await unresolved(
        resolverFor(standardProject(), { modifications: journal.port }).resolveEvent(
          makeEvent({ kind: KIND.function, name: unindexed.name, source: patchStamp(unindexed) }),
        ),
      );

      expect(outcome.reason).toBe(reason('not-corroborated'));
      expect(outcome.attempted).toContainEqual({
        route: ROUTE.patch,
        outcome: 'rejected',
        reason: reason('not-corroborated'),
      });
      expect(journal.listBySession).toHaveBeenCalledWith(SESSION);
      expect(journal.listBySession).not.toHaveBeenCalledWith(OTHER_SESSION);
    });
  });

  describe('route 2 — route-map', () => {
    it('returns the matched entry location unchanged for every route-bearing kind', async () => {
      for (const kind of ROUTE_KINDS) {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project).resolveEvent(
            makeEvent({ kind, attributes: { [ATTR.nextRoute]: PROJECT.routePath } }),
          ),
        );
        expect(outcome.route).toBe(ROUTE.routeMap);
        expect(outcome.location).toEqual(project.routeEntry.location);
        expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.routeMap]);
        expect(outcome.attempted).toEqual([
          { route: ROUTE.patch, outcome: 'skipped', reason: reason('no-applicable-route') },
          { route: ROUTE.routeMap, outcome: 'hit' },
        ]);
      }
    });

    it("selects the per-method handler location for the span's http.method", async () => {
      for (const method of ['GET', 'POST'] as const) {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project).resolveEvent(
            makeEvent({
              kind: KIND.routeHandler,
              attributes: { [ATTR.httpMethod]: method, [ATTR.nextRoute]: PROJECT.routePath },
            }),
          ),
        );
        expect(outcome.location).toEqual(project.routeEntry.methodLocations?.[method]);
        expect(outcome.location.symbol).toBe(method);
      }
    });

    it('matches a concrete URL carrying a query and a hash through the route map', async () => {
      const project = standardProject();
      const url = `${PROJECT.concretePath}?window=?#tail`;
      const outcome = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            attributes: { [ATTR.httpMethod]: 'GET', [ATTR.url]: url },
          }),
        ),
      );
      expect(outcome.location).toEqual(project.routeEntry.methodLocations?.['GET']);
      expect(project.routes.resolve).toHaveBeenCalledWith(url, 'GET');
    });

    it('matches the request line of the span name, and a file-convention route pattern', async () => {
      const project = standardProject();
      const fromName = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            name: `POST ${PROJECT.concretePath}`,
            attributes: { [ATTR.httpMethod]: 'POST' },
          }),
        ),
      );
      expect(fromName.location).toEqual(project.routeEntry.methodLocations?.['POST']);

      const suffixed = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.routeHandler,
            attributes: { [ATTR.nextRoute]: `${PROJECT.routePath}/route` },
          }),
        ),
      );
      expect(suffixed.location).toEqual(project.routeEntry.location);
    });

    it('reports an unmatched path, and a method the route does not declare, as unresolved', async () => {
      const project = standardProject();
      const unmatched = await unresolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            attributes: { [ATTR.url]: '/api/elsewhere/nothing' },
          }),
        ),
      );
      expect(unmatched.reason).toBe(reason('symbol-not-found'));

      const wrongMethod = await unresolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            attributes: { [ATTR.httpMethod]: 'DELETE', [ATTR.url]: PROJECT.concretePath },
          }),
        ),
      );
      expect(wrongMethod.reason).toBe(reason('symbol-not-found'));
    });

    it('falls back to the code queries when no route map was injected', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project, { routeMap: undefined }).resolveEvent(
          makeEvent({ kind: KIND.httpServer, attributes: { [ATTR.url]: PROJECT.concretePath } }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.routeMap);
      expect(outcome.location).toEqual(project.routeEntry.location);
      expect(project.fake.routeForUrl).toHaveBeenCalledWith(PROJECT.concretePath);
    });

    it('refuses a route map location carrying another route’s stamp instead of re-labelling it', async () => {
      const project = standardProject();
      const misStamped = gaugeRouteEntry({ stamp: ROUTE.codeGraph, perMethod: false });
      const outcome = await unresolved(
        resolverFor(project, { routeMap: fakeRouteMap([misStamped]).routeMap }).resolveEvent(
          makeEvent({ kind: KIND.httpServer, attributes: { [ATTR.nextRoute]: PROJECT.routePath } }),
        ),
      );
      expect(outcome.reason).toBe(reason('invalid-location'));
      expect(outcome.attempted).toContainEqual({
        route: ROUTE.routeMap,
        outcome: 'rejected',
        reason: reason('invalid-location'),
      });
    });
  });

  describe('route 3 — code-graph', () => {
    it('locates every component-bearing kind by its component display name', async () => {
      for (const kind of COMPONENT_KINDS) {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project).resolveEvent(
            makeEvent({ kind, attributes: { [ATTR.component]: PROJECT.component.name } }),
          ),
        );
        expect(outcome.route).toBe(ROUTE.codeGraph);
        expect(outcome.location).toEqual(project.component.location);
        expect(project.fake.findByName).toHaveBeenCalledWith(PROJECT.component.name, {
          kinds: ['component'],
          exact: true,
          limit: SOURCE_RESOLVE_LIMITS.maxNameCandidates,
        });
      }
    });

    it('unwraps memo, forwardRef and higher-order display names', async () => {
      for (const component of [
        `Memo(${PROJECT.component.name})`,
        `ForwardRef(Memo(${PROJECT.component.name}))`,
      ]) {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project).resolveEvent(
            makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: component } }),
          ),
        );
        expect(outcome.location).toEqual(project.component.location);
      }
    });

    it('falls back to a plain symbol only when nothing is classified as a component', async () => {
      const layout = codeMatch('symbol', {
        name: 'DeckLayout',
        file: 'src/layout/deck.tsx',
        line: 3,
        column: 17,
      });
      const fake = fakeQueries({ matches: [layout] });
      const outcome = await resolved(
        resolverFor({ ...standardProject(), fake }).resolveEvent(
          makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: layout.name } }),
        ),
      );
      expect(outcome.location).toEqual(layout.location);
      expect(fake.findByName.mock.calls.map(([, options]) => options?.kinds)).toEqual([
        ['component'],
        ['symbol'],
      ]);
    });

    it('locates an unpatched function span by its declaring module and symbol', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.function,
            name: PROJECT.fn.name,
            attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.codeGraph);
      expect(outcome.location).toEqual(project.fnSymbol.location);
      expect(project.fake.findSymbol).toHaveBeenCalledWith(PROJECT.fn.file, PROJECT.fn.name);
      expect(project.fake.findByName).not.toHaveBeenCalled();
    });

    it('locates an unpatched function span by its symbol alone when it names no module', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({ kind: KIND.function, attributes: { [ATTR.symbol]: PROJECT.fn.name } }),
        ),
      );
      expect(outcome.location).toEqual(project.fnSymbol.location);
      expect(project.fake.findByName).toHaveBeenCalledWith(
        PROJECT.fn.name,
        expect.objectContaining({ kinds: ['server-function'], exact: true }),
      );
    });

    describe('database query call sites', () => {
      const pgQuery = (parentSpanId?: string): TelemetryEvent =>
        makeEvent({
          kind: KIND.dbQuery,
          ...(parentSpanId === undefined ? {} : { parentSpanId }),
          attributes: {
            [ATTR.dbSystem]: 'postgresql',
            [ATTR.dbClient]: 'pg',
            [ATTR.dbOperation]: 'query',
          },
        });

      it('narrows through the enclosing function span to the nearest reachable call site', async () => {
        const project = standardProject();
        const parent = makeEvent({
          kind: KIND.function,
          name: PROJECT.fn.name,
          attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
        });
        const parents = fakeParents([parent]);
        const outcome = await resolved(
          resolverFor(project, { events: parents.port }).resolveEvent(pgQuery(parent.spanId)),
        );

        expect(outcome.route).toBe(ROUTE.codeGraph);
        expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        expect(parents.getBySpanId).toHaveBeenCalledWith(SESSION, parent.spanId);
        expect(project.fake.pathBetween).toHaveBeenCalledWith(
          project.fnEndpoint,
          project.readingsCall.id,
          expect.objectContaining({ direction: 'out' }),
        );
        expect(project.fake.pathBetween.mock.calls.length).toBeLessThanOrEqual(
          project.dbCalls.length,
        );
        expect(project.fake.whoCalls).not.toHaveBeenCalled();
      });

      it('narrows rather than guessing: the same query without its parent is ambiguous', async () => {
        const project = standardProject();
        const outcome = await unresolved(resolverFor(project).resolveEvent(pgQuery()));
        expect(outcome.reason).toBe(reason('ambiguous'));
        expect(project.fake.pathBetween).not.toHaveBeenCalled();
      });

      it('narrows through a route handler span to the call site its handler reaches', async () => {
        const project = standardProject();
        const handler = makeEvent({
          kind: KIND.routeHandler,
          attributes: { [ATTR.httpMethod]: 'GET', [ATTR.nextRoute]: PROJECT.routePath },
        });
        const outcome = await resolved(
          resolverFor(project, { events: fakeParents([handler]).port }).resolveEvent(
            pgQuery(handler.spanId),
          ),
        );
        expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        expect(project.fake.hasSymbol).toHaveBeenCalledWith(PROJECT.routeFile, 'GET');
        expect(project.fake.pathBetween).toHaveBeenCalledWith(
          { file: PROJECT.routeFile, symbol: 'GET' },
          project.readingsCall.id,
          expect.objectContaining({ direction: 'out' }),
        );
      });

      it('takes the call site the enclosing function issues directly without a path search', async () => {
        const project = standardProject();
        const parent = makeEvent({
          kind: KIND.function,
          attributes: {
            [ATTR.symbol]: project.readingsCall.symbol,
            [ATTR.module]: project.readingsCall.file,
          },
        });
        const outcome = await resolved(
          resolverFor(project, { events: fakeParents([parent]).port }).resolveEvent(
            pgQuery(parent.spanId),
          ),
        );
        expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        expect(project.fake.pathBetween).not.toHaveBeenCalled();
      });

      it('lets the driver evidence settle an orphan query when only one call site matches it', async () => {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project).resolveEvent(
            makeEvent({ kind: KIND.dbQuery, attributes: { [ATTR.dbClient]: 'prisma' } }),
          ),
        );
        expect(outcome.location).toEqual(dbCallMatch(project.latestCall).location);
      });

      it('answers index-unavailable without the code graph', async () => {
        const outcome = await unresolved(
          resolverFor(standardProject(), { graph: undefined }).resolveEvent(pgQuery()),
        );
        expect(outcome.reason).toBe(reason('index-unavailable'));
      });
    });
  });

  describe('route 4 — source-map', () => {
    it('resolves a request initiator through the injected stack resolver, keeping its first location', async () => {
      for (const kind of REQUEST_KINDS) {
        const project = standardProject();
        const fetchImpl = forbiddenFetch();
        const first = mapped(PROJECT.component.file);
        const resolveStackImpl = stackResolver([first, mapped(PROJECT.fn.file)]);
        const outcome = await resolved(
          resolverFor(project, {
            fetchImpl,
            resolveStackImpl,
            devServerOrigin: DEV_ORIGIN,
          }).resolveEvent(makeEvent({ kind, attributes: { [ATTR.initiator]: CHUNK_STACK } })),
        );

        expect(outcome.route).toBe(ROUTE.sourceMap);
        expect(outcome.location).toEqual({
          ...first,
          confidence: DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.sourceMap],
        });
        expect(resolveStackImpl).toHaveBeenCalledTimes(1);
        const [stack, options] = resolveStackImpl.mock.calls[0] ?? [];
        expect(stack).toBe(CHUNK_STACK);
        expect(options?.projectRoot).toBe(PROJECT_ROOT);
        expect(options?.devServerOrigin).toBe(DEV_ORIGIN);
        expect(options?.fetchImpl).toBe(fetchImpl);
        expect(typeof options?.cache?.get).toBe('function');
        expect(options?.maxFrames).toBe(SOURCE_RESOLVE_LIMITS.maxStackFrames);
        expect(options?.maxMaps).toBe(SOURCE_RESOLVE_LIMITS.maxSourceMaps);
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });

    it('keeps the first frame that maps into the project, after refusing one that does not', async () => {
      const inside = mapped(PROJECT.component.file);
      // Built by override: the shared schema itself refuses a traversal.
      const outside = { ...mapped(PROJECT.fn.file), file: '../elsewhere/x.ts' };
      const outcome = await resolved(
        resolverFor(standardProject(), {
          resolveStackImpl: stackResolver([outside, inside]),
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.xhr, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.location.file).toBe(inside.file);
      expect(outcome.attempted.filter((attempt) => attempt.route === ROUTE.sourceMap)).toEqual([
        { route: ROUTE.sourceMap, outcome: 'rejected', reason: reason('outside-project') },
        { route: ROUTE.sourceMap, outcome: 'hit' },
      ]);
    });

    it('answers unmapped-frame when the stack resolver maps nothing', async () => {
      const resolveStackImpl = stackResolver([]);
      const outcome = await unresolved(
        resolverFor(standardProject(), {
          resolveStackImpl,
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.reason).toBe(reason('unmapped-frame'));
      expect(resolveStackImpl).toHaveBeenCalledTimes(1);
    });

    it('answers no-initiator-stack, and dev-server-unknown, without calling the stack resolver', async () => {
      const resolveStackImpl = stackResolver([mapped(PROJECT.component.file)]);
      const noStack = await unresolved(
        resolverFor(standardProject(), {
          resolveStackImpl,
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.fetchUrl]: PROJECT.concretePath } }),
        ),
      );
      expect(noStack.reason).toBe(reason('no-initiator-stack'));

      const noOrigin = await unresolved(
        resolverFor(standardProject(), { resolveStackImpl }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(noOrigin.reason).toBe(reason('dev-server-unknown'));
      expect(resolveStackImpl).not.toHaveBeenCalled();
    });

    it('maps a browser error stack the same way', async () => {
      const inside = mapped(PROJECT.component.file, 9);
      const resolveStackImpl = stackResolver([inside]);
      const outcome = await resolved(
        resolverFor(standardProject(), {
          resolveStackImpl,
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.error, attributes: { [ATTR.errorStack]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.sourceMap);
      expect(outcome.location.line).toBe(inside.line);
      expect(resolveStackImpl.mock.calls[0]?.[0]).toBe(CHUNK_STACK);
    });

    it('refuses a mapped location carrying another route’s stamp', async () => {
      const outcome = await unresolved(
        resolverFor(standardProject(), {
          resolveStackImpl: stackResolver([
            stampedLocation(ROUTE.codeGraph, { file: PROJECT.component.file, line: 3, column: 1 }),
          ]),
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.reason).toBe(reason('invalid-location'));
    });

    it('with the real stack resolver, reaches only the injected fetch and only the pinned origin', async () => {
      const requested: string[] = [];
      const fetchImpl = vi.fn<typeof fetch>((input) => {
        requested.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(new Response('not found', { status: 404 }));
      });
      const outcome = await unresolved(
        resolverFor(standardProject(), { fetchImpl, devServerOrigin: DEV_ORIGIN }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.reason).toBe(reason('unmapped-frame'));
      expect(fetchImpl).toHaveBeenCalled();
      for (const url of requested) {
        expect(url.startsWith(`${DEV_ORIGIN}/`)).toBe(true);
      }
    });
  });

  describe('precedence', () => {
    it('prefers a corroborated patch over the code graph, which is never consulted', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project, {
          modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
        }).resolveEvent(
          patchedFunction({
            attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.patch);
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
      expect(outcome.attempted).toEqual([{ route: ROUTE.patch, outcome: 'hit' }]);
      expect(project.fake.totalCalls()).toBe(0);
    });

    it('prefers the route map over a code-graph answer for the same request span', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            attributes: { [ATTR.nextRoute]: PROJECT.routePath },
            source: project.fnSymbol.location,
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.routeMap);
      expect(outcome.location).toEqual(project.routeEntry.location);
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.routeMap]);
      expect(outcome.attempted.map((attempt) => attempt.route)).toEqual([
        ROUTE.patch,
        ROUTE.routeMap,
      ]);
      expect(project.fake.totalCalls()).toBe(0);
    });

    it('prefers the code graph over the stack resolver for a browser error naming its component', async () => {
      const project = standardProject();
      const resolveStackImpl = stackResolver([mapped(PROJECT.fn.file)]);
      const outcome = await resolved(
        resolverFor(project, { resolveStackImpl, devServerOrigin: DEV_ORIGIN }).resolveEvent(
          makeEvent({
            kind: KIND.error,
            attributes: {
              [ATTR.component]: PROJECT.component.name,
              [ATTR.errorStack]: CHUNK_STACK,
            },
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.codeGraph);
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.codeGraph]);
      expect(resolveStackImpl).not.toHaveBeenCalled();
    });

    it('prefers the stack resolver over an owner chain carried by the same request span', async () => {
      const project = standardProject();
      const resolveStackImpl = stackResolver([mapped(PROJECT.fn.file)]);
      const outcome = await resolved(
        resolverFor(project, { resolveStackImpl, devServerOrigin: DEV_ORIGIN }).resolveEvent(
          makeEvent({
            kind: KIND.fetch,
            attributes: {
              [ATTR.initiator]: CHUNK_STACK,
              [ATTR.componentChain]: [PROJECT.component.name],
            },
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.sourceMap);
      expect(project.fake.findByName).not.toHaveBeenCalled();
    });

    it('prefers the component name over the owner chain of the same render', async () => {
      const project = standardProject();
      const outcome = await resolved(
        resolverFor(project).resolveEvent(
          makeEvent({
            kind: KIND.render,
            attributes: {
              [ATTR.component]: PROJECT.component.name,
              [ATTR.ownerChain]: [PROJECT.outerComponent.name],
            },
          }),
        ),
      );
      expect(outcome.route).toBe(ROUTE.codeGraph);
      expect(outcome.location).toEqual(project.component.location);
      expect(project.fake.findByName).not.toHaveBeenCalledWith(
        PROJECT.outerComponent.name,
        expect.anything(),
      );
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * SourceResolver.resolveTarget — route 5, react-owner
 * ---------------------------------------------------------------------------------------------- */

describe('SourceResolver.resolveTarget', () => {
  /** A second `GaugeDial` declared in another module, making the name ambiguous. */
  const twinComponent = (): CodeMatch =>
    codeMatch('component', { ...PROJECT.component, file: 'src/legacy/GaugeDial.tsx', line: 2 });

  it('walks the chain nearest-first and re-stamps the hit as react-owner at its own confidence', async () => {
    const project = standardProject();
    const outcome = await resolved(
      resolverFor(project).resolveTarget(
        selectedTarget(['UnknownShell', PROJECT.component.name, PROJECT.outerComponent.name]),
      ),
    );

    expect(outcome.route).toBe(ROUTE.reactOwner);
    expect(outcome.location.resolvedBy).toBe(ROUTE.reactOwner);
    expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.reactOwner]);
    expect(outcome.location.confidence).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.codeGraph]);
    expect(outcome.location).toEqual({
      ...project.component.location,
      resolvedBy: ROUTE.reactOwner,
      confidence: DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.reactOwner],
    });
    expect(outcome.attempted).toEqual([
      ...SOURCE_ROUTE_ORDER.filter((route) => route !== ROUTE.reactOwner).map((route) => ({
        route,
        outcome: 'skipped',
        reason: reason('no-applicable-route'),
      })),
      { route: ROUTE.reactOwner, outcome: 'hit' },
    ]);
    const asked = project.fake.findByName.mock.calls.map(([name]) => name);
    expect(asked).toContain('UnknownShell');
    expect(asked).toContain(PROJECT.component.name);
    expect(asked).not.toContain(PROJECT.outerComponent.name);
  });

  it('passes over an ambiguous name and keeps walking outward', async () => {
    const project = standardProject();
    const fake = fakeQueries({
      matches: [project.component, twinComponent(), project.outerComponent],
    });
    const outcome = await resolved(
      resolverFor({ ...project, fake }).resolveTarget(
        selectedTarget([PROJECT.component.name, PROJECT.outerComponent.name]),
      ),
    );
    expect(outcome.location.file).toBe(PROJECT.outerComponent.file);
    expect(outcome.location.resolvedBy).toBe(ROUTE.reactOwner);
  });

  it('reports a chain whose only names are ambiguous as ambiguous, and an empty chain as not applicable', async () => {
    const project = standardProject();
    const fake = fakeQueries({ matches: [project.component, twinComponent()] });
    const ambiguous = await unresolved(
      resolverFor({ ...project, fake }).resolveTarget(selectedTarget([PROJECT.component.name])),
    );
    expect(ambiguous.reason).toBe(reason('ambiguous'));

    const empty = await unresolved(
      resolverFor(standardProject()).resolveTarget(selectedTarget([])),
    );
    expect(empty.reason).toBe(reason('no-applicable-route'));
  });

  it('answers symbol-not-found when no name in the chain is declared', async () => {
    const outcome = await unresolved(
      resolverFor(standardProject()).resolveTarget(selectedTarget(['UnknownShell', 'UnknownRoot'])),
    );
    expect(outcome.reason).toBe(reason('symbol-not-found'));
  });

  it('serves events carrying a component chain or an owner chain through the same route', async () => {
    const project = standardProject();
    const interaction = await resolved(
      resolverFor(project).resolveEvent(
        makeEvent({
          kind: KIND.interaction,
          attributes: { [ATTR.componentChain]: [PROJECT.component.name] },
        }),
      ),
    );
    expect(interaction.route).toBe(ROUTE.reactOwner);

    const render = await resolved(
      resolverFor(standardProject()).resolveEvent(
        makeEvent({
          kind: KIND.render,
          attributes: { [ATTR.ownerChain]: [PROJECT.outerComponent.name] },
        }),
      ),
    );
    expect(render.route).toBe(ROUTE.reactOwner);
    expect(render.location.file).toBe(PROJECT.outerComponent.file);
  });

  it('answers Err for a malformed target', async () => {
    const valid = selectedTarget([PROJECT.component.name]);
    const error = await failed(
      resolverFor(standardProject()).resolveTarget({ ...valid, url: 'not a url' }),
    );
    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });
});

/* -------------------------------------------------------------------------------------------------
 * The SourceResolution union — no guessing, no invented values
 * ---------------------------------------------------------------------------------------------- */

describe('SourceResolution', () => {
  it('reaches every route, and each stamps its own resolvedBy and exactly its default confidence', async () => {
    const project = standardProject();
    const resolver = resolverFor(project, {
      modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
      resolveStackImpl: stackResolver([mapped(PROJECT.component.file)]),
      devServerOrigin: DEV_ORIGIN,
    });
    const outcomes = [
      await resolved(
        resolver.resolveEvent(makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) })),
      ),
      await resolved(
        resolver.resolveEvent(
          makeEvent({ kind: KIND.httpServer, attributes: { [ATTR.nextRoute]: PROJECT.routePath } }),
        ),
      ),
      await resolved(
        resolver.resolveEvent(
          makeEvent({ kind: KIND.state, attributes: { [ATTR.component]: PROJECT.component.name } }),
        ),
      ),
      await resolved(
        resolver.resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      ),
      await resolved(resolver.resolveTarget(selectedTarget([PROJECT.outerComponent.name]))),
    ];

    expect(new Set(outcomes.map((outcome) => outcome.route))).toEqual(new Set(SOURCE_RESOLVED_BY));
    for (const outcome of outcomes) {
      expect(SOURCE_RESOLVED_BY).toContain(outcome.location.resolvedBy);
      expect(outcome.location.resolvedBy).toBe(outcome.route);
      expect(outcome.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[outcome.route]);
      expect(unwrapOk(parseSourceLocation(outcome.location), 'resolved location')).toEqual(
        outcome.location,
      );
    }
  });

  it('answers an undeclared component with no location, a reason and every attempt', async () => {
    const outcome = await unresolved(
      resolverFor(standardProject()).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: 'UnknownWidget' } }),
      ),
    );
    expect(outcome.reason).toBe(reason('symbol-not-found'));
    expect(outcome).not.toHaveProperty('location');
    expect(outcome.attempted).toContainEqual({
      route: ROUTE.codeGraph,
      outcome: 'miss',
      reason: reason('symbol-not-found'),
    });
  });

  it('answers a kind no route handles as not applicable, recording every route as skipped', async () => {
    for (const kind of UNHANDLED_KINDS) {
      const project = standardProject();
      const outcome = await unresolved(
        resolverFor(project).resolveEvent(
          makeEvent({ kind, attributes: { [ATTR.component]: PROJECT.component.name } }),
        ),
      );
      expect(outcome.reason).toBe(reason('no-applicable-route'));
      expect(outcome.attempted).toEqual(
        SOURCE_ROUTE_ORDER.map((route) => ({
          route,
          outcome: 'skipped',
          reason: reason('no-applicable-route'),
        })),
      );
      expect(project.fake.totalCalls()).toBe(0);
    }
  });

  it('reports two same-name declarations as ambiguous instead of choosing one', async () => {
    const project = standardProject();
    const twin = codeMatch('component', { ...PROJECT.component, file: 'src/legacy/GaugeDial.tsx' });
    const sameNameSymbol = codeMatch('symbol', { ...PROJECT.component, file: 'src/other.ts' });
    const fake = fakeQueries({ matches: [project.component, twin, sameNameSymbol] });
    const outcome = await unresolved(
      resolverFor({ ...project, fake }).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      ),
    );
    expect(outcome.reason).toBe(reason('ambiguous'));
    expect(fake.findByName).toHaveBeenCalledTimes(1);
  });

  it('collapses several graph nodes at one position into a single answer', async () => {
    const project = standardProject();
    const sameDeclaration = {
      ...project.component,
      nodeId: `${project.component.nodeId}#memo`,
      score: 0.5,
    };
    const fake = fakeQueries({ matches: [project.component, sameDeclaration] });
    const outcome = await resolved(
      resolverFor({ ...project, fake }).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      ),
    );
    expect(outcome.location).toEqual(project.component.location);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Containment — a candidate escaping the project is dropped, never repaired
 * ---------------------------------------------------------------------------------------------- */

describe('containment filtering', () => {
  const escapes = [
    '../elsewhere/x.ts',
    '../orbit-console-evil/src/x.ts',
    `${PROJECT_ROOT}-evil/src/x.ts`,
    `${PROJECT_ROOT}/src/components/GaugeDial.tsx`,
    '/etc/hosts',
  ];

  /** A code-graph answer whose file is `file`: typed as a location, but not one the schema accepts. */
  const graphAnswer = (project: Project, file: string): CodeMatch => ({
    ...project.component,
    file,
    location: { ...project.component.location, file },
  });

  it('drops a code-graph answer outside the project, including a prefix sibling of the root', async () => {
    for (const file of escapes) {
      const project = standardProject();
      const fake = fakeQueries({ matches: [graphAnswer(project, file)] });
      const outcome = await unresolved(
        resolverFor({ ...project, fake }).resolveEvent(
          makeEvent({
            kind: KIND.render,
            attributes: { [ATTR.component]: PROJECT.component.name },
          }),
        ),
      );
      expect(outcome.reason).toBe(reason('outside-project'));
      expect(outcome.attempted).toContainEqual({
        route: ROUTE.codeGraph,
        outcome: 'rejected',
        reason: reason('outside-project'),
      });
    }
  });

  it('drops a mapped frame outside the project instead of re-rooting it', async () => {
    for (const file of ['../elsewhere/x.ts', '../orbit-console-evil/src/x.ts']) {
      const outcome = await unresolved(
        resolverFor(standardProject(), {
          resolveStackImpl: stackResolver([
            // Built by hand: the shared schema itself refuses a traversal, which is the point.
            { ...mapped(PROJECT.component.file), file },
          ]),
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      expect(outcome.reason).toBe(reason('outside-project'));
    }
  });

  it('drops forwarded patch meta naming a file outside the project', async () => {
    for (const file of escapes) {
      const outcome = await unresolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
        }).resolveEvent(
          makeEvent({
            kind: KIND.function,
            name: 'unindexedHelper',
            attributes: { [META_FILE]: file, [META_LINE]: 3, [META_COLUMN]: 1 },
          }),
        ),
      );
      expect(outcome.reason).toBe(reason('outside-project'));
      expect(outcome.attempted[0]).toEqual({
        route: ROUTE.patch,
        outcome: 'rejected',
        reason: reason('outside-project'),
      });
    }
  });

  it('refuses a malformed path as invalid rather than normalising it', async () => {
    const project = standardProject();
    const fake = fakeQueries({
      matches: [graphAnswer(project, 'src\\components\\GaugeDial.tsx')],
    });
    const outcome = await unresolved(
      resolverFor({ ...project, fake }).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      ),
    );
    expect(outcome.reason).toBe(reason('invalid-location'));
  });
});

/* -------------------------------------------------------------------------------------------------
 * Genuine faults are Err values, and the resolver never throws
 * ---------------------------------------------------------------------------------------------- */

describe('faults', () => {
  const render = (): TelemetryEvent =>
    makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } });
  const patched = (): TelemetryEvent =>
    makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) });

  it('passes a failing journal port through as an Err, and turns a throwing one into STORE_ERROR', async () => {
    const failing = await failed(
      resolverFor(standardProject(), {
        modifications: {
          listBySession: () =>
            err(new DebuggenError('STORE_ERROR', 'The modification journal could not be read.')),
        },
      }).resolveEvent(patched()),
    );
    expect(failing.code).toBe('STORE_ERROR');

    const throwing = await failed(
      resolverFor(standardProject(), {
        modifications: {
          listBySession: () => {
            throw new Error('journal handle closed');
          },
        },
      }).resolveEvent(patched()),
    );
    expect(throwing.code).toBe('STORE_ERROR');
  });

  it('passes a failing or rejecting parent-span port through as an Err', async () => {
    const query = makeEvent({ kind: KIND.dbQuery, parentSpanId: newSpanId() });
    const failing = await failed(
      resolverFor(standardProject(), {
        events: {
          getBySpanId: () =>
            err(new DebuggenError('STORE_ERROR', 'The telemetry store is closed.')),
        },
      }).resolveEvent(query),
    );
    expect(failing.code).toBe('STORE_ERROR');

    const rejecting = await failed(
      resolverFor(standardProject(), {
        events: { getBySpanId: () => Promise.reject(new Error('store connection lost')) },
      }).resolveEvent(query),
    );
    expect(rejecting.code).toBe('STORE_ERROR');
  });

  it('turns a throwing code query and a rejecting stack resolver into INTERNAL, never a throw', async () => {
    const project = standardProject();
    const fake = fakeQueries();
    fake.findByName.mockImplementation(() => {
      throw new Error('index handle closed');
    });
    const pending = resolverFor({ ...project, fake }).resolveEvent(render());
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect((await failed(pending)).code).toBe('INTERNAL');

    const rejecting = await failed(
      resolverFor(standardProject(), {
        resolveStackImpl: vi.fn<typeof resolveStack>(() =>
          Promise.reject(new Error('stack resolver crashed')),
        ),
        devServerOrigin: DEV_ORIGIN,
      }).resolveEvent(
        makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
      ),
    );
    expect(rejecting.code).toBe('INTERNAL');
  });

  it('answers a pre-aborted call with an aborted Err before consulting anything', async () => {
    const controller = new AbortController();
    controller.abort();

    const viaOptions = standardProject();
    const optionsJournal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
    const byCall = await failed(
      resolverFor(viaOptions, { modifications: optionsJournal.port }).resolveEvent(patched(), {
        signal: controller.signal,
      }),
    );
    expect(byCall.code).toBe('INTERNAL');
    expect(byCall.details).toMatchObject({ reason: reason('aborted') });
    expect(viaOptions.fake.totalCalls()).toBe(0);
    expect(optionsJournal.listBySession).not.toHaveBeenCalled();

    const viaDeps = standardProject();
    const resolver = resolverFor(viaDeps, { signal: controller.signal });
    for (const pending of [
      resolver.resolveEvent(render()),
      resolver.resolveTarget(selectedTarget([PROJECT.component.name])),
      resolver.resolveEvents([render()]),
    ]) {
      const error = await failed<unknown>(pending);
      expect(error.details).toMatchObject({ reason: reason('aborted') });
    }
    expect(viaDeps.fake.totalCalls()).toBe(0);
  });

  it('answers PROTOCOL_INVALID_MESSAGE for a malformed event', async () => {
    const error = await failed(
      resolverFor(standardProject()).resolveEvent({ ...render(), traceId: 'not-a-trace-id' }),
    );
    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Bounds — every loop honours SOURCE_RESOLVE_LIMITS
 * ---------------------------------------------------------------------------------------------- */

describe('SOURCE_RESOLVE_LIMITS bounds', () => {
  it('asks a name lookup for at most maxNameCandidates candidates', async () => {
    const project = standardProject();
    const crowd = Array.from({ length: SOURCE_RESOLVE_LIMITS.maxNameCandidates * 3 }, (_, index) =>
      codeMatch('component', { ...PROJECT.component, file: `src/clones/c${index}.tsx` }),
    );
    const fake = fakeQueries({ matches: crowd });
    const outcome = await unresolved(
      resolverFor({ ...project, fake }).resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      ),
    );
    expect(outcome.reason).toBe(reason('ambiguous'));
    for (const [, options] of fake.findByName.mock.calls) {
      expect(options?.limit).toBe(SOURCE_RESOLVE_LIMITS.maxNameCandidates);
    }
    for (const result of fake.findByName.mock.results) {
      expect(result.type === 'return' ? result.value.length : 0).toBeLessThanOrEqual(
        SOURCE_RESOLVE_LIMITS.maxNameCandidates,
      );
    }
  });

  it('walks at most maxChainNames names of an owner chain', async () => {
    const chain = Array.from(
      { length: SOURCE_RESOLVE_LIMITS.maxChainNames + 24 },
      (_, index) => `UnknownOwner${index}`,
    );
    const asked = async (limits?: SourceResolverDeps['limits']): Promise<Set<string>> => {
      const project = standardProject();
      await unresolved(
        resolverFor(project, { limits }).resolveEvent(
          makeEvent({ kind: KIND.interaction, attributes: { [ATTR.componentChain]: chain } }),
        ),
      );
      return new Set(project.fake.findByName.mock.calls.map(([name]) => name));
    };

    expect(await asked()).toEqual(new Set(chain.slice(0, SOURCE_RESOLVE_LIMITS.maxChainNames)));
    expect(await asked({ maxChainNames: 3 })).toEqual(new Set(chain.slice(0, 3)));
  });

  it('forwards the frame and map caps and vets at most maxStackFrames frames', async () => {
    const flood = Array.from({ length: SOURCE_RESOLVE_LIMITS.maxStackFrames + 10 }, (_, index) => ({
      ...mapped(PROJECT.component.file, index + 1),
      file: `../elsewhere/f${index}.ts`,
    }));
    const run = async (limits?: SourceResolverDeps['limits']) => {
      const resolveStackImpl = stackResolver(flood);
      const outcome = await unresolved(
        resolverFor(standardProject(), {
          resolveStackImpl,
          devServerOrigin: DEV_ORIGIN,
          limits,
        }).resolveEvent(
          makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        ),
      );
      return {
        vetted: outcome.attempted.filter((attempt) => attempt.route === ROUTE.sourceMap).length,
        options: resolveStackImpl.mock.calls[0]?.[1],
      };
    };

    const defaults = await run();
    expect(defaults.vetted).toBe(SOURCE_RESOLVE_LIMITS.maxStackFrames);
    expect(defaults.options?.maxFrames).toBe(SOURCE_RESOLVE_LIMITS.maxStackFrames);
    expect(defaults.options?.maxMaps).toBe(SOURCE_RESOLVE_LIMITS.maxSourceMaps);

    const lowered = await run({ maxStackFrames: 3, maxSourceMaps: 2 });
    expect(lowered.vetted).toBe(3);
    expect(lowered.options?.maxFrames).toBe(3);
    expect(lowered.options?.maxMaps).toBe(2);
  });

  it('walks at most maxParentHops parent spans, and stops at a cycle', async () => {
    const ladder = (length: number): { query: TelemetryEvent; chain: TelemetryEvent[] } => {
      const spanIds = Array.from({ length }, () => newSpanId());
      const chain = spanIds.map((spanId, index) => {
        const parentSpanId = spanIds[index + 1];
        return makeEvent({
          kind: KIND.httpClient,
          spanId,
          ...(parentSpanId === undefined ? {} : { parentSpanId }),
        });
      });
      const [first] = spanIds;
      return {
        query: makeEvent({
          kind: KIND.dbQuery,
          ...(first === undefined ? {} : { parentSpanId: first }),
        }),
        chain,
      };
    };
    const hops = async (limits?: SourceResolverDeps['limits']): Promise<number> => {
      const { query, chain } = ladder(SOURCE_RESOLVE_LIMITS.maxParentHops + 5);
      const parents = fakeParents(chain);
      await resolverFor(standardProject(), { events: parents.port, limits }).resolveEvent(query);
      return parents.getBySpanId.mock.calls.length;
    };

    expect(await hops()).toBe(SOURCE_RESOLVE_LIMITS.maxParentHops);
    expect(await hops({ maxParentHops: 2 })).toBe(2);

    const querySpan = newSpanId();
    const loop = makeEvent({ kind: KIND.httpClient, parentSpanId: querySpan });
    const query = makeEvent({ kind: KIND.dbQuery, spanId: querySpan, parentSpanId: loop.spanId });
    const parents = fakeParents([loop]);
    await resolverFor(standardProject(), { events: parents.port }).resolveEvent(query);
    expect(parents.getBySpanId).toHaveBeenCalledTimes(1);
  });

  it('reports ambiguity rather than searching beyond maxDbCandidates call sites', async () => {
    const project = standardProject();
    const parent = makeEvent({
      kind: KIND.function,
      attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
    });
    const outcome = await unresolved(
      resolverFor(project, {
        events: fakeParents([parent]).port,
        limits: { maxDbCandidates: project.dbCalls.length - 1 },
      }).resolveEvent(makeEvent({ kind: KIND.dbQuery, parentSpanId: parent.spanId })),
    );
    expect(outcome.reason).toBe(reason('ambiguous'));
    expect(project.fake.pathBetween).not.toHaveBeenCalled();
  });

  it('tries at most maxRouteCandidates route patterns and request targets', async () => {
    const event = makeEvent({
      kind: KIND.routeHandler,
      attributes: {
        [ATTR.nextRoute]: '/api/unmatched/pattern',
        [ATTR.httpRoute]: PROJECT.routePath,
      },
    });
    const withDefaults = standardProject();
    expect((await resolved(resolverFor(withDefaults).resolveEvent(event))).route).toBe(
      ROUTE.routeMap,
    );

    const capped = standardProject();
    const outcome = await unresolved(
      resolverFor(capped, { limits: { maxRouteCandidates: 1 } }).resolveEvent(event),
    );
    expect(outcome.reason).toBe(reason('symbol-not-found'));
    expect(capped.routes.resolve.mock.calls.map(([target]) => target)).toEqual([
      '/api/unmatched/pattern',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * SourceResolver.resolveEvents — one page, one scope
 * ---------------------------------------------------------------------------------------------- */

describe('SourceResolver.resolveEvents', () => {
  const fetchWith = (frame: string): TelemetryEvent =>
    makeEvent({
      kind: KIND.fetch,
      attributes: { [ATTR.initiator]: `${CHUNK_STACK}\n    at ${frame} (${DEV_ORIGIN}/x.js:1:1)` },
    });

  /** A stack resolver that records the source-map cache each call was handed. */
  const cacheRecordingStack = (
    caches: SourceMapCache[],
    locations: readonly SourceLocation[],
  ): Mock<typeof resolveStack> =>
    vi.fn<typeof resolveStack>((_stack, options) => {
      if (options.cache !== undefined) {
        caches.push(options.cache);
      }
      return Promise.resolve([...locations]);
    });

  it('keys only the resolved events by id, in input order, sharing one scope across the page', async () => {
    const project = standardProject();
    const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
    const parents = fakeParents([]);
    const caches: SourceMapCache[] = [];
    const resolveStackImpl = cacheRecordingStack(caches, [mapped(PROJECT.component.file)]);
    const resolver = resolverFor(project, {
      modifications: journal.port,
      events: parents.port,
      resolveStackImpl,
      devServerOrigin: DEV_ORIGIN,
    });

    const patchedA = makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) });
    const fetchA = fetchWith('first');
    const malformed = { ...makeEvent({ kind: KIND.render }), spanId: 'not-a-span-id' };
    const patchedB = makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) });
    const fetchB = fetchWith('second');
    const parent = makeEvent({
      kind: KIND.function,
      name: PROJECT.fn.name,
      attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
    });
    const query = makeEvent({
      kind: KIND.dbQuery,
      parentSpanId: parent.spanId,
      attributes: { [ATTR.dbClient]: 'pg' },
    });
    const unknown = makeEvent({
      kind: KIND.render,
      attributes: { [ATTR.component]: 'UnknownWidget' },
    });

    const page = await located(
      resolver.resolveEvents([
        patchedA,
        fetchA,
        malformed,
        patchedB,
        fetchB,
        query,
        parent,
        unknown,
      ]),
    );

    expect([...page.keys()]).toEqual([
      patchedA.id,
      fetchA.id,
      patchedB.id,
      fetchB.id,
      query.id,
      parent.id,
    ]);
    expect(page.get(patchedA.id)).toEqual(patchStamp(PROJECT.fn));
    expect(page.get(fetchA.id)?.resolvedBy).toBe(ROUTE.sourceMap);
    expect(page.get(query.id)).toEqual(dbCallMatch(project.readingsCall).location);
    expect(page.get(parent.id)).toEqual(project.fnSymbol.location);
    expect(page.has(unknown.id)).toBe(false);
    expect(page.has(malformed.id)).toBe(false);

    // One journal read for the session, the page's own events as parent spans,
    // and a single source-map cache for every stack on the page.
    expect(journal.listBySession).toHaveBeenCalledTimes(1);
    expect(parents.getBySpanId).not.toHaveBeenCalled();
    expect(resolveStackImpl).toHaveBeenCalledTimes(2);
    expect(new Set(caches).size).toBe(1);
  });

  it('primes a fresh source-map cache for each single call, but only one for a whole batch', async () => {
    const caches: SourceMapCache[] = [];
    const resolver = resolverFor(standardProject(), {
      resolveStackImpl: cacheRecordingStack(caches, []),
      devServerOrigin: DEV_ORIGIN,
    });

    await resolver.resolveEvent(fetchWith('one'));
    await resolver.resolveEvent(fetchWith('two'));
    expect(new Set(caches).size).toBe(2);

    caches.length = 0;
    await resolver.resolveEvents([fetchWith('three'), fetchWith('four'), fetchWith('five')]);
    expect(caches).toHaveLength(3);
    expect(new Set(caches).size).toBe(1);
  });

  it('hands an injected cross-call cache to every stack as given, without re-priming it', async () => {
    const shared = observableCache();
    const caches: SourceMapCache[] = [];
    const resolver = resolverFor(standardProject(), {
      resolveStackImpl: cacheRecordingStack(caches, []),
      devServerOrigin: DEV_ORIGIN,
      sourceMapCache: shared.cache,
    });

    await resolver.resolveEvent(fetchWith('one'));
    await resolver.resolveEvents([fetchWith('two'), fetchWith('three')]);
    expect(caches).toHaveLength(3);
    for (const cache of caches) {
      expect(cache).toBe(shared.cache);
    }
    expect(shared.set).not.toHaveBeenCalled();
  });

  it('resolves at most maxBatchEvents events, and each event id once', async () => {
    const renders = Array.from({ length: 4 }, () =>
      makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
    );
    const capped = await located(
      resolverFor(standardProject(), { limits: { maxBatchEvents: 2 } }).resolveEvents(renders),
    );
    expect([...capped.keys()]).toEqual(renders.slice(0, 2).map((event) => event.id));

    const [first] = renders;
    if (first === undefined) {
      throw new Error('no fixture render');
    }
    const project = standardProject();
    const repeated = await located(resolverFor(project).resolveEvents([first, first, first]));
    expect([...repeated.keys()]).toEqual([first.id]);
    expect(project.fake.findByName).toHaveBeenCalledTimes(1);

    expect((await located(resolverFor(standardProject()).resolveEvents([]))).size).toBe(0);
  });

  it('fails the page on a failed store port or a cancelled call, but not on a malformed event', async () => {
    const patched = makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) });
    const failing = await failed(
      resolverFor(standardProject(), {
        modifications: {
          listBySession: () => err(new DebuggenError('STORE_ERROR', 'The journal is closed.')),
        },
      }).resolveEvents([patched]),
    );
    expect(failing.code).toBe('STORE_ERROR');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await failed(
      resolverFor(standardProject()).resolveEvents([patched], { signal: controller.signal }),
    );
    expect(cancelled.details).toMatchObject({ reason: reason('aborted') });

    const onlyMalformed = await located(
      resolverFor(standardProject()).resolveEvents([{ ...patched, traceId: 'not-a-trace-id' }]),
    );
    expect(onlyMalformed.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy, filesystem and network hygiene, determinism
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  const statement = `SELECT id FROM readings WHERE note = '${SENTINEL}'`;
  const sentinelStack = `${CHUNK_STACK}\n    at ${SENTINEL} (${DEV_ORIGIN}/_next/static/chunks/${SENTINEL}.js:1:1)`;

  const capturedEvents = (): TelemetryEvent[] => [
    makeEvent({
      kind: KIND.dbQuery,
      attributes: { [ATTR.dbStatement]: statement, [ATTR.dbClient]: 'pg' },
    }),
    makeEvent({
      kind: KIND.httpServer,
      attributes: {
        [ATTR.httpMethod]: 'GET',
        [ATTR.url]: `${PROJECT.concretePath}?note=${SENTINEL}`,
      },
    }),
    makeEvent({
      kind: KIND.fetch,
      attributes: {
        [ATTR.initiator]: sentinelStack,
        [ATTR.fetchUrl]: `${PROJECT.concretePath}?note=${SENTINEL}`,
      },
    }),
    makeEvent({
      kind: KIND.render,
      attributes: { [ATTR.component]: SENTINEL, [ATTR.changedProps]: [SENTINEL] },
    }),
    makeEvent({
      kind: KIND.error,
      attributes: { [ATTR.errorMessage]: SENTINEL, [ATTR.errorStack]: sentinelStack },
    }),
    makeEvent({
      kind: KIND.function,
      source: patchStamp(PROJECT.fn),
      attributes: { [ATTR.symbol]: SENTINEL },
    }),
  ];

  it('logs ids, kinds, routes, reasons and counts only', async () => {
    const entries: LogEntry[] = [];
    const resolver = resolverFor(standardProject(), {
      logger: capturingLogger(entries),
      modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
      resolveStackImpl: stackResolver([mapped(PROJECT.component.file)]),
      devServerOrigin: DEV_ORIGIN,
    });
    const events = capturedEvents();

    for (const event of events) {
      await resolver.resolveEvent(event);
    }
    await resolver.resolveEvents(events);
    await resolver.resolveTarget(selectedTarget([SENTINEL], SENTINEL));

    expect(entries.length).toBeGreaterThan(events.length);
    const logged = JSON.stringify(entries);
    for (const forbidden of [SENTINEL, 'SELECT', '?note=', DEV_ORIGIN, PROJECT_ROOT, '_next']) {
      expect(logged).not.toContain(forbidden);
    }
    for (const entry of entries) {
      expect(entry.fields['subsystem']).toBe('source');
      for (const value of Object.values(entry.fields)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('returns errors whose message, hint, details and payload carry none of the captured values', async () => {
    const [query, , fetchEvent, renderEvent] = capturedEvents();
    if (query === undefined || fetchEvent === undefined || renderEvent === undefined) {
      throw new Error('the captured fixture events are missing');
    }
    const controller = new AbortController();
    controller.abort();
    const throwingQueries = fakeQueries();
    throwingQueries.findByName.mockImplementation(() => {
      throw new Error('index handle closed');
    });

    const errors = [
      await failed(
        resolverFor(standardProject(), { signal: controller.signal }).resolveEvent(query),
      ),
      await failed(
        resolverFor({ ...standardProject(), fake: throwingQueries }).resolveEvent(renderEvent),
      ),
      await failed(
        resolverFor(standardProject(), {
          resolveStackImpl: vi.fn<typeof resolveStack>(() =>
            Promise.reject(new Error('stack resolver crashed')),
          ),
          devServerOrigin: DEV_ORIGIN,
        }).resolveEvent(fetchEvent),
      ),
      await failed(
        resolverFor(standardProject()).resolveEvent({ ...query, traceId: 'not-a-trace-id' }),
      ),
    ];

    for (const error of errors) {
      const surface = JSON.stringify({
        message: error.message,
        hint: error.hint,
        details: error.details,
        payload: error.toPayload(),
      });
      for (const forbidden of [SENTINEL, 'SELECT', DEV_ORIGIN, PROJECT_ROOT]) {
        expect(surface).not.toContain(forbidden);
      }
    }
  });
});

describe('filesystem hygiene', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('opens no project file — not even a planted .env — and hands the stack resolver no file reader', async () => {
    root = mkdtempSync(join(tmpdir(), 'debuggen-resolve-'));
    const envMarker = 'env-marker-5c1d';
    writeFileSync(join(root, '.env'), `ORBIT_FIXTURE_MARKER=${envMarker}\n`);

    const entries: LogEntry[] = [];
    const resolveStackImpl = stackResolver([mapped(PROJECT.component.file)]);
    const resolver = resolverFor(standardProject(), {
      projectRoot: root,
      logger: capturingLogger(entries),
      resolveStackImpl,
      devServerOrigin: DEV_ORIGIN,
    });
    const outcomes = [
      await resolver.resolveEvent(
        makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      ),
      await resolver.resolveEvent(
        makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
      ),
      await resolver.resolveEvent(
        makeEvent({ kind: KIND.httpServer, attributes: { [ATTR.nextRoute]: PROJECT.routePath } }),
      ),
      await resolver.resolveTarget(selectedTarget([PROJECT.outerComponent.name])),
    ];

    expect(JSON.stringify({ outcomes, entries })).not.toContain(envMarker);
    expect(resolveStackImpl).toHaveBeenCalledTimes(1);
    for (const [, options] of resolveStackImpl.mock.calls) {
      expect(options).not.toHaveProperty('readSourceFile');
      expect(options).not.toHaveProperty('fetchSourceMapImpl');
    }

    // The module reaches no filesystem builtin at all: the code index owns
    // every file read, and it already refuses `.env*`.
    const moduleText = readFileSync(new URL('./resolve.ts', import.meta.url), 'utf8');
    expect(moduleText).not.toMatch(/from\s+['"](?:node:)?fs(?:\/promises)?['"]/);
    expect(moduleText).not.toMatch(/\brequire\s*\(/);
    expect(moduleText).not.toMatch(/\bimport\s*\(/);
  });
});

describe('determinism', () => {
  it('answers the same input with deep-equal outcomes', async () => {
    const project = standardProject();
    const parent = makeEvent({
      kind: KIND.function,
      attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
    });
    const resolver = resolverFor(project, {
      events: fakeParents([parent]).port,
      resolveStackImpl: stackResolver([mapped(PROJECT.component.file)]),
      devServerOrigin: DEV_ORIGIN,
    });
    const events = [
      makeEvent({ kind: KIND.render, attributes: { [ATTR.component]: PROJECT.component.name } }),
      makeEvent({ kind: KIND.httpServer, attributes: { [ATTR.url]: PROJECT.concretePath } }),
      makeEvent({ kind: KIND.dbQuery, parentSpanId: parent.spanId }),
      makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
      makeEvent({ kind: KIND.navigation }),
    ];
    for (const event of events) {
      expect(await resolver.resolveEvent(event)).toEqual(await resolver.resolveEvent(event));
    }
    expect(await resolver.resolveEvents(events)).toEqual(await resolver.resolveEvents(events));
  });

  it('picks the same answer whatever order the candidates arrive in', async () => {
    const project = standardProject();
    const sameDeclaration: CodeMatch = {
      ...project.component,
      nodeId: `${project.component.nodeId}#memo`,
      score: 0.4,
    };
    const escaped: CodeMatch = {
      ...project.component,
      nodeId: `${project.component.nodeId}#escaped`,
      file: '../outside/GaugeDial.tsx',
      location: { ...project.component.location, file: '../outside/GaugeDial.tsx' },
    };
    const twin = codeMatch('component', { ...PROJECT.component, file: 'src/legacy/GaugeDial.tsx' });
    const render = makeEvent({
      kind: KIND.render,
      attributes: { [ATTR.component]: PROJECT.component.name },
    });
    const resolveWith = (matches: readonly CodeMatch[]) =>
      resolverFor({ ...project, fake: fakeQueries({ matches }) }).resolveEvent(render);

    const picks = [
      await resolved(resolveWith([project.component, sameDeclaration, escaped])),
      await resolved(resolveWith([escaped, sameDeclaration, project.component])),
      await resolved(resolveWith([sameDeclaration, escaped, project.component])),
    ];
    for (const pick of picks) {
      expect(pick).toEqual(picks[0]);
      expect(pick.location).toEqual(project.component.location);
    }

    for (const order of [
      [project.component, twin],
      [twin, project.component],
    ]) {
      expect((await unresolved(resolveWith(order))).reason).toBe(reason('ambiguous'));
    }
  });

  it('narrows database call sites the same way whatever order the index lists them in', async () => {
    const parent = makeEvent({
      kind: KIND.function,
      attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
    });
    const query = makeEvent({ kind: KIND.dbQuery, parentSpanId: parent.spanId });
    const project = standardProject();
    const [readings, latest, audit] = project.dbCalls;
    if (readings === undefined || latest === undefined || audit === undefined) {
      throw new Error('the fixture call sites are missing');
    }

    const outcomes: Resolved[] = [];
    for (const nodes of [
      [readings, latest, audit],
      [audit, latest, readings],
      [latest, readings, audit],
    ]) {
      outcomes.push(
        await resolved(
          resolverFor(project, {
            graph: graphOf(nodes),
            events: fakeParents([parent]).port,
          }).resolveEvent(query),
        ),
      );
    }
    for (const outcome of outcomes) {
      expect(outcome).toEqual(outcomes[0]);
      expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
    }
  });
});
