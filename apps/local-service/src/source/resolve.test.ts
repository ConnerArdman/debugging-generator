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
 * The one real collaborator is the journal's evidence: the patch route only
 * keeps a claim whose exact `meta` literal a record's diff adds, so the diffs
 * the patch cases corroborate against are rendered by `@debuggen/instrumentation`'s
 * own `createPatcher` over a temporary copy of the invented modules — the bytes
 * a live session journals, not a restatement of them.
 *
 * Expected confidences are always read from `DEFAULT_RESOLUTION_CONFIDENCE`
 * and expected precedence from `SOURCE_RESOLVED_BY` sorted by it, so a change
 * to the shared table moves the module and this suite together; the kinds and
 * attribute keys come from `@debuggen/telemetry`'s vocabularies and the patch
 * meta keys from `PATCH_META_KEYS`, each checked on use. The project vocabulary
 * (gauges, readings, an orbit console) is invented and shares no name with the
 * demo application.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_QUERY_LIMITS,
  CodeGraph,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  INDEXER_VERSION,
  deriveRouteFromFile,
  makeEdgeId,
  makeNodeId,
  matchRoute,
} from '@debuggen/code-analysis';
import type {
  CodeEdge,
  CodeEdgeKind,
  CodeMatch,
  CodeNode,
  CodeNodeKind,
  CodeNodeOf,
  CodeQueries,
  CodeSymbolMatch,
  DbDriver,
  FetchSourceMapOptions,
  RouteEntry,
  RouteMap,
  RouteQueryResult,
  SourceMapCache,
  SourceMapLookup,
  fetchSourceMap,
  resolveStack,
} from '@debuggen/code-analysis';
import {
  OPEN_MODIFICATION_STATUSES,
  PATCH_DIFF_TRUNCATION_NOTICE,
  PATCH_META_KEYS,
  buildSpanMetaLiteral,
  createBackupStore,
  createModificationRecord,
  createPatcher,
  parseSelectedTarget,
} from '@debuggen/instrumentation';
import type {
  ModificationJournal,
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
  isErr,
  isOk,
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
  MAX_PREVIEW_LENGTH,
  QUERY_KINDS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_KINDS,
  REQUEST_KINDS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  TRUNCATION_SUFFIX,
  allowedTiersFor,
  parseTelemetryEvent,
  truncate,
} from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind, TelemetryStatus } from '@debuggen/telemetry';

import {
  CORROBORATION_CACHE_TTL_MS,
  RESOLVE_YIELD_SLICE_MS,
  SOURCE_MAP_FAILURE_TTL_MS,
  SOURCE_MAP_SCOPE_IDLE_MS,
  SOURCE_RESOLUTION_MISS_REASONS,
  SOURCE_RESOLVE_LIMITS,
  SOURCE_ROUTE_ORDER,
  createCorroborationCache,
  createSourceMapScopes,
  createSourceResolver,
} from './resolve.js';
import type {
  ModificationCorroboration,
  ModificationCorroborationPort,
  ParentEventPort,
  ResolvableEvent,
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
  ormModel: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'model'),
  ormMethod: keyIn(DB_QUERY_ATTRIBUTE_KEYS, 'method'),
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

/* -------------------------------------------------------------------------------------------------
 * The real patch — what a live session's journal holds for the invented modules
 * ---------------------------------------------------------------------------------------------- */

/**
 * The invented module declaring `PROJECT.fn`. The declaration's name starts at
 * line 21, column 23 (`export async function ` is 22 characters), which is
 * where the patcher anchors its recorded position.
 */
const GAUGES_MODULE: string = [
  '/** Readings for the orbit console gauges. Invented for this suite. */',
  '',
  'export interface GaugeSample {',
  '  readonly gaugeId: string;',
  '  readonly value: number;',
  '}',
  '',
  '/** The smallest reading a gauge reports. */',
  'export const GAUGE_FLOOR = 0;',
  '',
  '/** The largest reading a gauge reports. */',
  'export const GAUGE_CEILING = 100;',
  '',
  '/** Clamps a raw reading into the gauge range. */',
  'export function clampReading(value: number): number {',
  '  return Math.min(GAUGE_CEILING, Math.max(GAUGE_FLOOR, value));',
  '}',
  '',
  '// The reading every gauge panel renders.',
  '/** Averages the samples of one gauge into a single reading. */',
  `export async function ${PROJECT.fn.name}(samples: readonly GaugeSample[]): Promise<number> {`,
  '  const total = samples.reduce((sum, sample) => sum + sample.value, 0);',
  '  return clampReading(samples.length === 0 ? GAUGE_FLOOR : total / samples.length);',
  '}',
  '',
].join('\n');

/**
 * A declaration whose name is longer than the span helpers' symbol bound
 * (`MAX_PREVIEW_LENGTH`) but inside the patcher's own, so the stamp a helper
 * sends for it carries a bounded symbol.
 */
const SERIES_FN: Declaration = {
  name: 'blendGaugeReadingSeriesAcrossOrbitalWindows'.repeat(4),
  file: 'src/lib/gauge-series.ts',
  line: 2,
  column: 17,
};

/** The invented module declaring {@link SERIES_FN} at line 2, column 17. */
const SERIES_MODULE: string = [
  '/** Series blending for the orbit console. Invented for this suite. */',
  `export function ${SERIES_FN.name}(values: readonly number[]): number {`,
  '  return values.reduce((sum, value) => sum + value, 0);',
  '}',
  '',
].join('\n');

/** What the real patcher journaled for one declaration. */
interface RealPatch {
  /** The record exactly as the patcher left it: `applied`, carrying the diff it rendered. */
  readonly record: ModificationRecord;
  /** The position the patcher recorded — the four values its `meta` literal carries. */
  readonly location: SourceLocation;
}

/** The real patches of {@link GAUGES_MODULE} and {@link SERIES_MODULE}, set once for the file. */
let patches: { readonly gauges: RealPatch; readonly series: RealPatch } | undefined;

/** Where {@link patches} were produced; removed after the file. */
let patchSandbox: string | undefined;

/** The real patches; a case that runs before they exist is a broken suite, not a skip. */
function realPatches(): { readonly gauges: RealPatch; readonly series: RealPatch } {
  if (patches === undefined) {
    throw new Error('the real patch fixtures are produced in beforeAll');
  }
  return patches;
}

/** The `ModificationJournal` port in memory: the service implements it over `node:sqlite`. */
function memoryJournal(): ModificationJournal {
  const rows: ModificationRecord[] = [];
  return {
    append: (record) => {
      rows.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus: (id, status, patch) => {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];
      if (current === undefined) {
        return Promise.resolve(
          err(new DebuggenError('STORE_ERROR', 'No modification record has that id.')),
        );
      }
      const updated: ModificationRecord = { ...current, ...patch, status };
      rows[index] = updated;
      return Promise.resolve(ok(updated));
    },
    listBySession: (sessionId) =>
      Promise.resolve(ok(rows.filter((row) => row.sessionId === sessionId))),
    listOpen: () => Promise.resolve(ok(rows.filter((row) => row.status !== 'reverted'))),
  };
}

/**
 * Patches both invented modules with `createPatcher` — the crash-safe write
 * sequence a session's installer runs — inside a temporary project, and keeps
 * the journaled records and recorded positions.
 */
async function producePatches(sandbox: string): Promise<{
  readonly gauges: RealPatch;
  readonly series: RealPatch;
}> {
  const projectRoot = join(sandbox, 'project');
  const debuggenHome = join(sandbox, 'home');
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  for (const [file, text] of [
    [PROJECT.fn.file, GAUGES_MODULE],
    [SERIES_FN.file, SERIES_MODULE],
  ] as const) {
    mkdirSync(dirname(join(projectRoot, file)), { recursive: true });
    writeFileSync(join(projectRoot, file), text);
  }

  const patcher = createPatcher({
    projectRoot,
    sessionId: SESSION,
    planVersion: 1,
    backups: createBackupStore({ debuggenHome, sessionId: SESSION }),
    journal: memoryJournal(),
  });
  const patch = async (declaration: Declaration): Promise<RealPatch> => {
    const outcome = await patcher.patchTarget({
      file: declaration.file,
      symbol: declaration.name,
    });
    if (!outcome.ok) {
      throw new Error(`the real patcher refused ${declaration.file}: ${outcome.error.code}`);
    }
    return { record: outcome.value.record, location: outcome.value.location };
  };
  return { gauges: await patch(PROJECT.fn), series: await patch(SERIES_FN) };
}

beforeAll(async () => {
  patchSandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-resolve-patch-')));
  patches = await producePatches(patchSandbox);
}, 60_000);

afterAll(() => {
  if (patchSandbox !== undefined) {
    rmSync(patchSandbox, { recursive: true, force: true });
    patchSandbox = undefined;
  }
});

/** The `meta` literal the patcher writes for `declaration`, from its own builder. */
function metaLiteral(declaration: Declaration): string {
  return unwrapOk(
    buildSpanMetaLiteral({
      file: declaration.file,
      line: declaration.line,
      column: declaration.column,
      symbol: declaration.name,
    }),
    'patch meta literal',
  );
}

/** The added lines of a unified diff's hunks, without their `+` prefix. */
function addedLines(diff: string): string[] {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  return lines
    .slice(firstHunk < 0 ? lines.length : firstHunk)
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1));
}

/**
 * A modification record built by the instrumentation package's own constructor.
 *
 * A record naming `PROJECT.fn`'s file carries, by default, the unified diff the
 * real patcher journaled for it, so it proves that declaration's exact
 * position the way a live session's journal does; a record naming any other
 * file carries an empty diff and proves nothing.
 */
function modification(
  file: string,
  status: ModificationStatus,
  appliedAt: number = BASE_TIME - 1_000,
  sessionId: string = SESSION,
  diff: string = file === PROJECT.fn.file ? realPatches().gauges.record.diff : '',
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
        diff,
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
  /** The model segment of a generated-client delegate call, as written in the source. */
  readonly model?: string;
  /** The last line of the call expression, when it spans several. */
  readonly endLine?: number;
}

/** A database call-site node, exactly as the db-call extractor shapes one. */
function dbCallNode(spec: DbCallSpec): CodeNodeOf<'db-call'> {
  const { name, file, line, column, symbol, driver, operation, model, endLine } = spec;
  return {
    id: makeNodeId({ kind: 'db-call', file, name, line, column }),
    kind: 'db-call',
    name,
    file,
    line,
    column,
    ...(endLine === undefined ? {} : { endLine }),
    symbol,
    data: { driver, operation, ...(model === undefined ? {} : { model }), dynamic: false },
  };
}

/** A declared symbol's node, as the symbols extractor shapes one. */
function symbolNode(declaration: Declaration): CodeNodeOf<'symbol'> {
  const { name, file, line, column } = declaration;
  return {
    id: makeNodeId({ kind: 'symbol', file, name, line, column }),
    kind: 'symbol',
    name,
    file,
    line,
    column,
    symbol: name,
  };
}

/** A React component's node spanning `declaration.line` to `endLine`, as the components extractor shapes one. */
function componentNode(declaration: Declaration, endLine: number): CodeNodeOf<'component'> {
  const { name, file, line, column } = declaration;
  return {
    id: makeNodeId({ kind: 'component', file, name, line, column }),
    kind: 'component',
    name,
    file,
    line,
    column,
    endLine,
    data: { isClient: true, isDefaultExport: false, displayName: name },
  };
}

/** An inline event handler's node spanning `declaration.line` to `endLine`. */
function handlerNode(declaration: Declaration, endLine: number): CodeNodeOf<'handler'> {
  const { name, file, line, column } = declaration;
  return {
    id: makeNodeId({ kind: 'handler', file, name, line, column }),
    kind: 'handler',
    name,
    file,
    line,
    column,
    endLine,
    data: { event: 'click', boundTo: 'button', inline: true },
  };
}

/** One edge of the hand-written graph, identified exactly as the indexer identifies one. */
function edgeOf(kind: CodeEdgeKind, from: CodeNode, to: CodeNode): CodeEdge {
  return {
    id: makeEdgeId({ kind, from: from.id, to: to.id, line: to.line, column: to.column }),
    kind,
    from: from.id,
    to: to.id,
  };
}

/** The declarations and edges of a hand-written graph beyond its database call sites. */
interface GraphStructure {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly CodeEdge[];
}

const NO_STRUCTURE: GraphStructure = Object.freeze({ nodes: [], edges: [] });

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

/**
 * A real `CodeGraph` over a hand-written index: no ts-morph project, no file
 * read. The call sites come first, in the order given, so a case can permute
 * them; `structure` adds the declarations and edges reachability walks.
 */
function graphOf(
  dbCalls: readonly CodeNodeOf<'db-call'>[],
  structure: GraphStructure = NO_STRUCTURE,
): CodeGraph {
  return CodeGraph.fromIndex({
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: PROJECT_ROOT,
    indexerVersion: INDEXER_VERSION,
    generatedAt: BASE_TIME,
    nodes: [...dbCalls, ...structure.nodes],
    edges: structure.edges,
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

interface QueryFixture {
  readonly matches?: readonly CodeMatch[];
  readonly symbols?: readonly CodeSymbolMatch[];
  readonly routes?: readonly RouteEntry[];
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
 * `pathBetween`, `excerpt`) answer nothing and are asserted unused — a query
 * owner's reach is searched over the injected graph's own edges.
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
  const pathBetween = vi.fn<CodeQueries['pathBetween']>(() => undefined);
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

/**
 * The modification journal, answering synchronously like the SQLite repository
 * does: the session's records for the metadata read, and a session's records
 * of one stored file for the patch-evidence read.
 */
function fakeJournal(records: readonly ModificationRecord[]): {
  readonly port: ModificationCorroborationPort;
  readonly listBySession: Mock<ModificationCorroborationPort['listBySession']>;
  readonly listPatchEvidence: Mock<ModificationCorroborationPort['listPatchEvidence']>;
} {
  const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>((sessionId) =>
    ok(records.filter((record) => record.sessionId === sessionId)),
  );
  const listPatchEvidence = vi.fn<ModificationCorroborationPort['listPatchEvidence']>(
    (sessionId, file) =>
      ok(records.filter((record) => record.sessionId === sessionId && record.file === file)),
  );
  return { port: { listBySession, listPatchEvidence }, listBySession, listPatchEvidence };
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
    model: 'reading',
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
  });

  // The calls behind those call sites: the function reaches the driver call
  // in two hops and the generated-client call in three; the route's `GET`
  // calls the function, so it reaches them in three and four. Nothing reaches
  // the audit call.
  const fnNode = symbolNode(PROJECT.fn);
  const getNode = symbolNode({ name: 'GET', file: PROJECT.routeFile, line: 5, column: 23 });
  const readingsFor = symbolNode({
    name: 'readingsFor',
    file: PROJECT.storeFile,
    line: 10,
    column: 23,
  });
  const summarize = symbolNode({
    name: 'summarizeReadings',
    file: PROJECT.fn.file,
    line: 30,
    column: 17,
  });
  const latestReading = symbolNode({
    name: 'latestReading',
    file: PROJECT.storeFile,
    line: 28,
    column: 23,
  });
  const writeAudit = symbolNode({
    name: 'writeAudit',
    file: PROJECT.auditFile,
    line: 6,
    column: 23,
  });
  // The dial component's declaration spans the lines its mapped frames land on.
  const dialNode = componentNode(PROJECT.component, 40);
  const structure: GraphStructure = {
    nodes: [fnNode, getNode, readingsFor, summarize, latestReading, writeAudit, dialNode],
    edges: [
      edgeOf('calls', getNode, fnNode),
      edgeOf('calls', fnNode, readingsFor),
      edgeOf('queries', readingsFor, readingsCall),
      edgeOf('calls', fnNode, summarize),
      edgeOf('calls', summarize, latestReading),
      edgeOf('queries', latestReading, latestCall),
      edgeOf('queries', writeAudit, auditCall),
    ],
  };
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
    declarations: { fnNode, getNode, readingsFor, summarize, latestReading, writeAudit },
    structure,
    graph: graphOf(dbCalls, structure),
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

/** The well-formed outcome of a call that must succeed, resolved or not. */
async function settled(
  pending: Promise<Result<SourceResolution, DebuggenError>>,
): Promise<SourceResolution> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(`expected Ok, got Err ${result.error.code}`);
  }
  expectWellFormed(result.value);
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

  it('patches the invented modules with the real patcher, whose diff adds the exact meta literal', () => {
    for (const [declaration, patch] of [
      [PROJECT.fn, realPatches().gauges],
      [SERIES_FN, realPatches().series],
    ] as const) {
      // The recorded position is the declaration the other fixtures place the function at…
      expect(patch.location).toMatchObject({
        file: declaration.file,
        line: declaration.line,
        column: declaration.column,
        symbol: declaration.name,
        resolvedBy: ROUTE.patch,
      });
      expect(patch.record.status).toBe('applied');
      expect(patch.record.file).toBe(declaration.file);
      // …and the journaled diff adds, byte for byte, the literal the patcher's own builder emits.
      const added = addedLines(patch.record.diff).filter((line) =>
        line.includes(metaLiteral(declaration)),
      );
      expect(added).toHaveLength(1);
    }
    expect(SERIES_FN.name.length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
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
      'kind-not-patchable',
      'no-initiator-stack',
      'dev-server-unknown',
      'unmapped-frame',
      'outside-project',
      'invalid-location',
      'aborted',
      'budget-expired',
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

    /** The stamp a span helper sends for a real patch: its recorded position, no end line. */
    const helperStamp = (patch: RealPatch): SourceLocation =>
      stampedLocation(ROUTE.patch, patch.location, patch.location.symbol);

    /**
     * Claims naming the file the session really instrumented, each with one
     * field the patch did not write — what a page script can hand the public
     * span helper as `meta`.
     */
    const inventedClaims: readonly (readonly [field: string, claim: Declaration])[] = [
      ['line', { ...PROJECT.fn, line: 999 }],
      ['column', { ...PROJECT.fn, column: 1 }],
      ['symbol', { ...PROJECT.fn, name: 'inventedGaugeReading' }],
    ];

    const notCorroborated = {
      route: ROUTE.patch,
      outcome: 'rejected',
      reason: reason('not-corroborated'),
    } as const;

    it('corroborates the stamp a span helper sends against the record the real patcher journaled', async () => {
      const { gauges } = realPatches();
      const stamp = helperStamp(gauges);
      const outcome = await resolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([gauges.record]).port,
        }).resolveEvent(patchedFunction({ source: stamp })),
      );

      expect(stamp).toEqual(patchStamp(PROJECT.fn));
      expect(outcome.route).toBe(ROUTE.patch);
      expect(outcome.location).toEqual(stamp);
      expect(outcome.attempted).toEqual([{ route: ROUTE.patch, outcome: 'hit' }]);
    });

    it('refuses a stamp on the instrumented file with an invented line, column or symbol, and falls through', async () => {
      for (const [field, claim] of inventedClaims) {
        const project = standardProject();
        const outcome = await resolved(
          resolverFor(project, {
            modifications: fakeJournal([realPatches().gauges.record]).port,
          }).resolveEvent(patchedFunction({ source: patchStamp(claim) })),
        );

        expect(outcome.attempted[0], field).toEqual(notCorroborated);
        // The later route computes its own location from the index; nothing of the claim survives.
        expect(outcome.route, field).toBe(ROUTE.codeGraph);
        expect(outcome.location, field).toEqual(project.fnSymbol.location);
        expect(outcome.location.confidence, field).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
      }
    });

    it('holds forwarded meta attributes to the same exact position and symbol', async () => {
      for (const [field, claim] of inventedClaims) {
        const project = standardProject();
        const outcome = await settled(
          resolverFor(project, {
            modifications: fakeJournal([realPatches().gauges.record]).port,
          }).resolveEvent(
            makeEvent({
              kind: KIND.function,
              name: PROJECT.fn.name,
              attributes: {
                [META_FILE]: claim.file,
                [META_LINE]: claim.line,
                [META_COLUMN]: claim.column,
                [META_SYMBOL]: claim.name,
              },
            }),
          ),
        );

        expect(outcome.attempted[0], field).toEqual(notCorroborated);
        // An invented position still names the indexed symbol, which the code graph places
        // itself; an invented symbol names nothing the index holds, so no location is kept.
        if (field === 'symbol') {
          expect(outcome.status).toBe('unresolved');
        } else {
          expect(outcome).toMatchObject({
            status: 'resolved',
            route: ROUTE.codeGraph,
            location: project.fnSymbol.location,
          });
        }
      }
    });

    it('refuses a claim checked against a diff clipped before its literal, and keeps one clipped after it', async () => {
      const diff = realPatches().gauges.record.diff;
      const literal = metaLiteral(PROJECT.fn);
      const at = diff.indexOf(literal);
      expect(at).toBeGreaterThan(0);
      const clipped = (end: number): ModificationRecord =>
        modification(
          PROJECT.fn.file,
          'applied',
          BASE_TIME - 1_000,
          SESSION,
          `${diff.slice(0, end)}${PATCH_DIFF_TRUNCATION_NOTICE}`,
        );

      const project = standardProject();
      const cutInside = await resolved(
        resolverFor(project, {
          modifications: fakeJournal([clipped(at + Math.floor(literal.length / 2))]).port,
        }).resolveEvent(patchedFunction()),
      );
      expect(cutInside.attempted[0]).toEqual(notCorroborated);
      expect(cutInside.route).toBe(ROUTE.codeGraph);
      expect(cutInside.location).toEqual(project.fnSymbol.location);

      const cutAfter = await resolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([clipped(at + literal.length)]).port,
        }).resolveEvent(patchedFunction()),
      );
      expect(cutAfter.route).toBe(ROUTE.patch);
    });

    it('never reads the literal off a line the diff does not add', async () => {
      const diff = realPatches().gauges.record.diff;
      // The same diff with every added line turned into context: the literal is
      // still in the text, but no longer written by the patch.
      const asContext = diff
        .split('\n')
        .map((line) =>
          line.startsWith('+') && !line.startsWith('+++') ? ` ${line.slice(1)}` : line,
        )
        .join('\n');
      expect(asContext).toContain(metaLiteral(PROJECT.fn));

      const outcome = await resolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([
            modification(PROJECT.fn.file, 'applied', BASE_TIME - 1_000, SESSION, asContext),
          ]).port,
        }).resolveEvent(patchedFunction()),
      );
      expect(outcome.attempted[0]).toEqual(notCorroborated);
      expect(outcome.route).toBe(ROUTE.codeGraph);
    });

    it('refuses a patch claim on a kind no patch emits, before reading the journal', async () => {
      const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
      const resolver = resolverFor(standardProject(), { modifications: journal.port });

      const stampedRender = await resolved(
        resolver.resolveEvent(
          makeEvent({
            kind: KIND.render,
            attributes: { [ATTR.component]: PROJECT.component.name },
            source: patchStamp(PROJECT.fn),
          }),
        ),
      );
      const metaOnRequest = await resolved(
        resolver.resolveEvent(
          makeEvent({
            kind: KIND.httpServer,
            attributes: {
              [ATTR.nextRoute]: PROJECT.routePath,
              [META_FILE]: PROJECT.fn.file,
              [META_LINE]: PROJECT.fn.line,
              [META_COLUMN]: PROJECT.fn.column,
              [META_SYMBOL]: PROJECT.fn.name,
            },
          }),
        ),
      );

      for (const outcome of [stampedRender, metaOnRequest]) {
        expect(outcome.attempted[0]).toEqual({
          route: ROUTE.patch,
          outcome: 'rejected',
          reason: reason('kind-not-patchable'),
        });
      }
      expect(stampedRender.route).toBe(ROUTE.codeGraph);
      expect(metaOnRequest.route).toBe(ROUTE.routeMap);
      expect(journal.listBySession).not.toHaveBeenCalled();
    });

    it('lets a reverted record applied before the span corroborate only the exact claim', async () => {
      const appliedAt = BASE_TIME + 10_000;
      const journal = fakeJournal([modification(PROJECT.fn.file, 'reverted', appliedAt)]);
      const resolver = resolverFor(standardProject(), { modifications: journal.port });

      const exact = await resolved(
        resolver.resolveEvent(patchedFunction({ startTime: appliedAt + 5 })),
      );
      expect(exact.route).toBe(ROUTE.patch);

      for (const [field, claim] of inventedClaims) {
        const invented = await resolved(
          resolver.resolveEvent(
            patchedFunction({ startTime: appliedAt + 5, source: patchStamp(claim) }),
          ),
        );
        expect(invented.attempted[0], field).toEqual(notCorroborated);
        expect(invented.route, field).toBe(ROUTE.codeGraph);
      }
    });

    it('never keeps a claimed end line, which no patch meta carries', async () => {
      const stamp = unwrapOk(
        parseSourceLocation({ ...patchStamp(PROJECT.fn), endLine: PROJECT.fn.line + 40 }),
        'stamp with an end line',
      );
      const outcome = await resolved(
        resolverFor(standardProject(), {
          modifications: fakeJournal([modification(PROJECT.fn.file, 'applied')]).port,
        }).resolveEvent(patchedFunction({ source: stamp })),
      );

      expect(outcome.route).toBe(ROUTE.patch);
      expect(outcome.location).toEqual(patchStamp(PROJECT.fn));
      expect(outcome.location).not.toHaveProperty('endLine');
    });

    it('corroborates a symbol a span helper bounded by its kept prefix, and no shorter or different one', async () => {
      const { series } = realPatches();
      const resolver = resolverFor(standardProject(), {
        modifications: fakeJournal([series.record]).port,
      });
      const claiming = (symbol: string): TelemetryEvent =>
        makeEvent({
          kind: KIND.function,
          name: 'blendGaugeReadingSeries',
          source: stampedLocation(ROUTE.patch, SERIES_FN, symbol),
        });

      // The bound both span helpers apply, from the telemetry package itself.
      const bounded = truncate(SERIES_FN.name, MAX_PREVIEW_LENGTH);
      expect(bounded.endsWith(TRUNCATION_SUFFIX)).toBe(true);
      for (const symbol of [SERIES_FN.name, bounded]) {
        const outcome = await resolved(resolver.resolveEvent(claiming(symbol)));
        expect(outcome.route).toBe(ROUTE.patch);
        expect(outcome.location.symbol).toBe(symbol);
      }

      const altered = `X${bounded.slice(1)}`;
      const tooShort = `${SERIES_FN.name.slice(0, 8)}${TRUNCATION_SUFFIX}`;
      for (const symbol of [altered, tooShort]) {
        const outcome = await unresolved(resolver.resolveEvent(claiming(symbol)));
        expect(outcome.attempted[0], symbol).toEqual(notCorroborated);
      }
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
        // Reachability is searched over the graph's own edges, once, rather
        // than asked of the pair query candidate by candidate.
        expect(project.fake.pathBetween).not.toHaveBeenCalled();
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
      });

      it('takes the handler from the request span when the route handler span names no method', async () => {
        // Next.js's route-handler span carries the route but not the method;
        // the `http.server` span above it carries both. Both spans arriving in
        // the query's own batch is the common case for a single request.
        const project = standardProject();
        const request = makeEvent({
          kind: KIND.httpServer,
          attributes: { [ATTR.httpMethod]: 'GET', [ATTR.httpRoute]: PROJECT.routePath },
        });
        const handler = makeEvent({
          kind: KIND.routeHandler,
          parentSpanId: request.spanId,
          attributes: { [ATTR.nextRoute]: PROJECT.routePath },
        });
        const outcome = await resolved(
          resolverFor(project, { events: fakeParents([handler, request]).port }).resolveEvent(
            pgQuery(handler.spanId),
          ),
        );
        expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        expect(project.fake.hasSymbol).toHaveBeenCalledWith(PROJECT.routeFile, 'GET');
      });

      it('keeps a method-less route handler as the owner when no ancestor names the handler', async () => {
        // The route module alone seeds the search from every node it holds,
        // so the call site its handler reaches first still answers.
        const project = standardProject();
        const handler = makeEvent({
          kind: KIND.routeHandler,
          attributes: { [ATTR.nextRoute]: PROJECT.routePath },
        });
        const outcome = await resolved(
          resolverFor(project, { events: fakeParents([handler]).port }).resolveEvent(
            pgQuery(handler.spanId),
          ),
        );
        expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        expect(project.fake.hasSymbol).not.toHaveBeenCalledWith(PROJECT.routeFile, 'GET');
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

      describe('statements an ORM issued', () => {
        /**
         * The invented project with more generated-client call sites behind
         * its function: `calibrate`'s transaction (lines 50–70), whose callback
         * also updates a gauge through the outer client; `archiveReadings`'
         * transaction, whose callback the index cannot see into; and a gauge
         * lookup. The audit module looks gauges up the same way, out of the
         * function's reach. The driver call `readingsFor` issues stays the
         * only driver call site the function reaches.
         */
        const ormProject = () => {
          const base = standardProject();
          const { fnNode, writeAudit } = base.declarations;
          const clientCall = (spec: Omit<DbCallSpec, 'driver'>): CodeNodeOf<'db-call'> =>
            dbCallNode({ ...spec, driver: 'prisma' });
          const calibrateTx = clientCall({
            name: 'prisma.$transaction',
            file: PROJECT.storeFile,
            line: 50,
            column: 12,
            endLine: 70,
            symbol: 'calibrate',
            operation: '$transaction',
          });
          const gaugeUpdate = clientCall({
            name: 'prisma.gauge.update',
            file: PROJECT.storeFile,
            line: 55,
            column: 11,
            symbol: 'calibrate',
            operation: 'update',
            model: 'gauge',
          });
          const archiveTx = clientCall({
            name: 'prisma.$transaction',
            file: PROJECT.storeFile,
            line: 90,
            column: 12,
            endLine: 110,
            symbol: 'archiveReadings',
            operation: '$transaction',
          });
          const gaugeLookup = clientCall({
            name: 'prisma.gauge.findUnique',
            file: PROJECT.storeFile,
            line: 120,
            column: 10,
            symbol: 'gaugeById',
            operation: 'findUnique',
            model: 'gauge',
          });
          const auditLookup = clientCall({
            name: 'prisma.gauge.findUnique',
            file: PROJECT.auditFile,
            line: 14,
            column: 10,
            symbol: 'writeAudit',
            operation: 'findUnique',
            model: 'gauge',
          });
          const calibrate = symbolNode({
            name: 'calibrate',
            file: PROJECT.storeFile,
            line: 48,
            column: 23,
          });
          const archive = symbolNode({
            name: 'archiveReadings',
            file: PROJECT.storeFile,
            line: 88,
            column: 23,
          });
          const gaugeById = symbolNode({
            name: 'gaugeById',
            file: PROJECT.storeFile,
            line: 118,
            column: 23,
          });
          const dbCalls = [
            ...base.dbCalls,
            calibrateTx,
            gaugeUpdate,
            archiveTx,
            gaugeLookup,
            auditLookup,
          ];
          const structure: GraphStructure = {
            nodes: [...base.structure.nodes, calibrate, archive, gaugeById],
            edges: [
              ...base.structure.edges,
              edgeOf('calls', fnNode, calibrate),
              edgeOf('queries', calibrate, calibrateTx),
              edgeOf('queries', calibrate, gaugeUpdate),
              edgeOf('calls', fnNode, archive),
              edgeOf('queries', archive, archiveTx),
              edgeOf('calls', fnNode, gaugeById),
              edgeOf('queries', gaugeById, gaugeLookup),
              edgeOf('queries', writeAudit, auditLookup),
            ],
          };
          const project: Project = {
            ...base,
            dbCalls,
            structure,
            graph: graphOf(dbCalls, structure),
            fake: fakeQueries({ matches: dbCalls.map(dbCallMatch), symbols: [base.fnSymbol] }),
          };
          return { project, calibrateTx, gaugeUpdate, archiveTx, gaugeLookup, auditLookup };
        };

        /** A function span standing for `symbol` of `file`: the owner of what it runs. */
        const ownerSpan = (symbol: string, file: string): TelemetryEvent =>
          makeEvent({
            kind: KIND.function,
            attributes: { [ATTR.symbol]: symbol, [ATTR.module]: file },
          });

        /** A query span of `client` below `parent`. */
        const querySpan = (
          client: DbDriver,
          parent: TelemetryEvent | undefined,
          attributes: Readonly<Record<string, unknown>> = {},
        ): TelemetryEvent =>
          makeEvent({
            kind: KIND.dbQuery,
            ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
            attributes: { [ATTR.dbClient]: client, ...attributes },
          });

        /** The ORM's operation span: `method`, on `model` when it is a delegate method. */
        const operationSpan = (
          parent: TelemetryEvent | undefined,
          model: string | undefined,
          method: string,
        ): TelemetryEvent =>
          querySpan('prisma', parent, {
            [ATTR.dbOperation]: 'operation',
            [ATTR.ormMethod]: method,
            ...(model === undefined ? {} : { [ATTR.ormModel]: model }),
          });

        /** The ORM's statement span below `operation`, and the driver's statement span below it. */
        const statementSpans = (operation: TelemetryEvent, verb: string) => {
          const orm = querySpan('prisma', operation, { [ATTR.dbOperation]: 'db_query' });
          const driver = querySpan('pg', orm, {
            [ATTR.dbSystem]: 'postgresql',
            [ATTR.dbOperation]: verb,
          });
          return { orm, driver };
        };

        it('locates a driver statement under an ORM operation at the ORM call, never the driver call in reach', async () => {
          const { project } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const operation = operationSpan(owner, 'Reading', 'findMany');
          const { orm, driver } = statementSpans(operation, 'SELECT');
          const resolver = resolverFor(project, {
            events: fakeParents([owner, operation, orm]).port,
          });

          // The model is matched case-insensitively: the runtime reports the
          // model's declared name, the source spells the delegate property.
          for (const span of [driver, orm, operation]) {
            const outcome = await resolved(resolver.resolveEvent(span));
            expect(outcome.location).toEqual(dbCallMatch(project.latestCall).location);
          }
        });

        it('keeps the driver call site for a driver statement no ORM span encloses', async () => {
          const { project } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const raw = querySpan('pg', owner, { [ATTR.dbOperation]: 'SELECT' });
          const outcome = await resolved(
            resolverFor(project, { events: fakeParents([owner]).port }).resolveEvent(raw),
          );
          expect(outcome.location).toEqual(dbCallMatch(project.readingsCall).location);
        });

        it('narrows a model method to the call site its owner reaches', async () => {
          const { project, gaugeLookup, auditLookup } = ormProject();
          const fnOwner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const auditOwner = ownerSpan('writeAudit', PROJECT.auditFile);
          const fromFn = operationSpan(fnOwner, 'Gauge', 'findUnique');
          const fromAudit = operationSpan(auditOwner, 'Gauge', 'findUnique');
          const resolver = resolverFor(project, {
            events: fakeParents([fnOwner, auditOwner]).port,
          });

          expect((await resolved(resolver.resolveEvent(fromFn))).location).toEqual(
            dbCallMatch(gaugeLookup).location,
          );
          expect((await resolved(resolver.resolveEvent(fromAudit))).location).toEqual(
            dbCallMatch(auditLookup).location,
          );
          // Without an owner both call sites answer, and neither is chosen.
          const orphan = operationSpan(undefined, 'Gauge', 'findUnique');
          expect((await unresolved(resolver.resolveEvent(orphan))).reason).toBe(
            reason('ambiguous'),
          );
        });

        it('settles an orphan ORM operation by the one call site of its model and method', async () => {
          const { project } = ormProject();
          const outcome = await resolved(
            resolverFor(project).resolveEvent(operationSpan(undefined, 'Reading', 'findMany')),
          );
          expect(outcome.location).toEqual(dbCallMatch(project.latestCall).location);
        });

        it('reports two reachable transactions as ambiguous rather than picking the nearer', async () => {
          const { project, calibrateTx } = ormProject();
          const fnOwner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const calibrateOwner = ownerSpan('calibrate', PROJECT.storeFile);
          const acrossBoth = operationSpan(fnOwner, undefined, '$transaction');
          const withinOne = operationSpan(calibrateOwner, undefined, '$transaction');
          const begin = querySpan('pg', acrossBoth, { [ATTR.dbOperation]: 'BEGIN' });
          const resolver = resolverFor(project, {
            events: fakeParents([fnOwner, calibrateOwner, acrossBoth, withinOne]).port,
          });

          for (const span of [acrossBoth, begin]) {
            expect((await unresolved(resolver.resolveEvent(span))).reason).toBe(
              reason('ambiguous'),
            );
          }
          expect((await resolved(resolver.resolveEvent(withinOne))).location).toEqual(
            dbCallMatch(calibrateTx).location,
          );
        });

        it('counts an operation inside a transaction only at call sites within that transaction', async () => {
          const { project, gaugeUpdate } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const transaction = operationSpan(owner, undefined, '$transaction');
          const update = operationSpan(transaction, 'Gauge', 'update');
          const { orm, driver } = statementSpans(update, 'UPDATE');
          const resolver = resolverFor(project, {
            events: fakeParents([owner, transaction, update, orm]).port,
          });
          for (const span of [driver, orm, update]) {
            expect((await resolved(resolver.resolveEvent(span))).location).toEqual(
              dbCallMatch(gaugeUpdate).location,
            );
          }
        });

        describe('a transaction told apart by the operations recorded under it', () => {
          /**
           * `ormProject` with both reachable transactions updating a gauge:
           * `calibrate`'s also reads a reading (line 60), `archiveReadings'`
           * does not — so an update inside a transaction matches a call site
           * in each, and only the operations its span recorded say which
           * transaction ran.
           */
          const twoUpdatingTransactions = () => {
            const built = ormProject();
            const { project } = built;
            const nodeNamed = (name: string): CodeNode => {
              const node = project.structure.nodes.find((candidate) => candidate.name === name);
              if (node === undefined) {
                throw new Error(`the ORM project declares no ${name}`);
              }
              return node;
            };
            const calibrateRead = dbCallNode({
              name: 'prisma.reading.findFirst',
              file: PROJECT.storeFile,
              line: 60,
              column: 11,
              symbol: 'calibrate',
              operation: 'findFirst',
              model: 'reading',
              driver: 'prisma',
            });
            const archiveUpdate = dbCallNode({
              name: 'prisma.gauge.update',
              file: PROJECT.storeFile,
              line: 95,
              column: 11,
              symbol: 'archiveReadings',
              operation: 'update',
              model: 'gauge',
              driver: 'prisma',
            });
            const dbCalls = [...project.dbCalls, calibrateRead, archiveUpdate];
            const structure: GraphStructure = {
              nodes: project.structure.nodes,
              edges: [
                ...project.structure.edges,
                edgeOf('queries', nodeNamed('calibrate'), calibrateRead),
                edgeOf('queries', nodeNamed('archiveReadings'), archiveUpdate),
              ],
            };
            const variant: Project = {
              ...project,
              dbCalls,
              structure,
              graph: graphOf(dbCalls, structure),
              fake: fakeQueries({
                matches: dbCalls.map(dbCallMatch),
                symbols: [project.fnSymbol],
              }),
            };
            return { ...built, project: variant, calibrateRead, archiveUpdate };
          };

          it('locates the transaction and the operations inside it from one batch', async () => {
            const { project, calibrateTx, gaugeUpdate, calibrateRead } = twoUpdatingTransactions();
            const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
            const transaction = operationSpan(owner, undefined, '$transaction');
            const begin = querySpan('pg', transaction, { [ATTR.dbOperation]: 'BEGIN' });
            const update = operationSpan(transaction, 'Gauge', 'update');
            const read = operationSpan(transaction, 'Reading', 'findFirst');
            const updateStatement = statementSpans(update, 'UPDATE');
            const batch = [
              owner,
              transaction,
              begin,
              update,
              read,
              ...Object.values(updateStatement),
            ];

            const locatedAt = unwrapOk(await resolverFor(project).resolveEvents(batch), 'batch');

            for (const span of [transaction, begin]) {
              expect(locatedAt.get(span.id)).toEqual(dbCallMatch(calibrateTx).location);
            }
            for (const span of [update, updateStatement.orm, updateStatement.driver]) {
              expect(locatedAt.get(span.id)).toEqual(dbCallMatch(gaugeUpdate).location);
            }
            expect(locatedAt.get(read.id)).toEqual(dbCallMatch(calibrateRead).location);
          });

          it('stays ambiguous when the batch holds no operation that tells the transactions apart', async () => {
            const { project } = twoUpdatingTransactions();
            const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
            const transaction = operationSpan(owner, undefined, '$transaction');
            const update = operationSpan(transaction, 'Gauge', 'update');
            const statement = statementSpans(update, 'UPDATE');

            const locatedAt = unwrapOk(
              await resolverFor(project).resolveEvents([owner, transaction, update, statement.orm]),
              'batch',
            );

            // Both transactions update a gauge: nothing recorded settles which ran.
            for (const span of [transaction, update, statement.orm]) {
              expect(locatedAt.has(span.id)).toBe(false);
            }
          });

          it('keeps every transaction when no body holds all the operations recorded under it', async () => {
            // An operation written in a helper outside the callback's range is
            // no evidence about the transactions, so neither is ruled out.
            const { project } = twoUpdatingTransactions();
            const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
            const transaction = operationSpan(owner, undefined, '$transaction');
            const update = operationSpan(transaction, 'Gauge', 'update');
            const elsewhere = operationSpan(transaction, 'Reading', 'count');

            const locatedAt = unwrapOk(
              await resolverFor(project).resolveEvents([owner, transaction, update, elsewhere]),
              'batch',
            );

            for (const span of [transaction, update]) {
              expect(locatedAt.has(span.id)).toBe(false);
            }
          });
        });

        it('answers with the enclosing transaction when the operation inside it has no call site', async () => {
          // Neither an operation made through the transaction's own client nor
          // a same-named call elsewhere is a call site of that operation.
          const { project, calibrateTx } = ormProject();
          const calibrateOwner = ownerSpan('calibrate', PROJECT.storeFile);
          const fnOwner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const inCalibrate = operationSpan(calibrateOwner, undefined, '$transaction');
          const inFn = operationSpan(fnOwner, undefined, '$transaction');
          const resolver = resolverFor(project, {
            events: fakeParents([calibrateOwner, fnOwner, inCalibrate, inFn]).port,
          });

          for (const [model, method] of [
            ['Reading', 'deleteMany'],
            ['Gauge', 'findUnique'],
          ] as const) {
            const operation = operationSpan(inCalibrate, model, method);
            const statement = statementSpans(operation, 'SELECT');
            const scoped = resolverFor(project, {
              events: fakeParents([calibrateOwner, inCalibrate, operation, statement.orm]).port,
            });
            for (const span of [operation, statement.orm, statement.driver]) {
              expect((await resolved(scoped.resolveEvent(span))).location).toEqual(
                dbCallMatch(calibrateTx).location,
              );
            }
          }
          const underBoth = operationSpan(inFn, 'Reading', 'deleteMany');
          expect((await unresolved(resolver.resolveEvent(underBoth))).reason).toBe(
            reason('ambiguous'),
          );
        });

        it('never falls back to a driver call site when the ORM recorded no operation', async () => {
          const { project } = ormProject();
          const fnOwner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const readerOwner = ownerSpan('latestReading', PROJECT.storeFile);
          const acrossMany = querySpan('prisma', fnOwner, { [ATTR.dbOperation]: 'db_query' });
          const withinOne = querySpan('prisma', readerOwner, { [ATTR.dbOperation]: 'db_query' });
          const driverOfMany = querySpan('pg', acrossMany, { [ATTR.dbOperation]: 'SELECT' });
          const driverOfOne = querySpan('pg', withinOne, { [ATTR.dbOperation]: 'SELECT' });
          const resolver = resolverFor(project, {
            events: fakeParents([fnOwner, readerOwner, acrossMany, withinOne]).port,
          });

          expect((await unresolved(resolver.resolveEvent(driverOfMany))).reason).toBe(
            reason('ambiguous'),
          );
          expect((await resolved(resolver.resolveEvent(driverOfOne))).location).toEqual(
            dbCallMatch(project.latestCall).location,
          );
        });

        it('reads the ORM evidence on the walk to the owner, without extra hops', async () => {
          const { project } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const operation = operationSpan(owner, 'Reading', 'findMany');
          const { orm, driver } = statementSpans(operation, 'SELECT');
          const parents = fakeParents([owner, operation, orm]);
          await resolved(resolverFor(project, { events: parents.port }).resolveEvent(driver));
          expect(parents.getBySpanId).toHaveBeenCalledTimes(3);
        });

        it("searches an owner's reach once for a whole batch", async () => {
          const { project } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const operation = operationSpan(owner, 'Reading', 'findMany');
          const first = statementSpans(operation, 'SELECT');
          const second = statementSpans(operation, 'SELECT');
          const outgoing = vi.spyOn(project.graph, 'outgoing');
          const resolver = resolverFor(project);

          await resolver.resolveEvents([owner, operation, first.orm]);
          const single = outgoing.mock.calls.length;
          outgoing.mockClear();
          const located = unwrapOk(
            await resolver.resolveEvents([
              owner,
              operation,
              first.orm,
              first.driver,
              second.orm,
              second.driver,
            ]),
            'batch',
          );

          expect(single).toBeGreaterThan(0);
          expect(outgoing.mock.calls.length).toBe(single);
          for (const span of [operation, first.orm, first.driver, second.orm, second.driver]) {
            expect(located.get(span.id)).toEqual(dbCallMatch(project.latestCall).location);
          }
        });

        it('proves nothing out of reach once the node budget cut the search short', async () => {
          const { project, gaugeLookup } = ormProject();
          const owner = ownerSpan(PROJECT.fn.name, PROJECT.fn.file);
          const lookup = operationSpan(owner, 'Gauge', 'findUnique');
          const events = fakeParents([owner]).port;

          expect(
            (await resolved(resolverFor(project, { events }).resolveEvent(lookup))).location,
          ).toEqual(dbCallMatch(gaugeLookup).location);
          const cut = resolverFor(project, { events, limits: { maxReachableNodes: 1 } });
          expect((await unresolved(cut.resolveEvent(lookup))).reason).toBe(reason('ambiguous'));
        });
      });
    });
  });

  describe('route 4 — source-map', () => {
    it('resolves a request initiator through the injected stack resolver, keeping its component frame', async () => {
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
        // The frame is the component's, and so is the name it carries: the
        // map's name at a call position is the callee, not the caller.
        expect(outcome.location).toEqual({
          ...first,
          symbol: PROJECT.component.name,
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

    it('resolves an attributed event the store has not ordered yet exactly as its persisted form', async () => {
      const first = mapped(PROJECT.component.file);
      const persisted = makeEvent({
        kind: KIND.fetch,
        attributes: { [ATTR.initiator]: CHUNK_STACK },
      });
      const attributed: ResolvableEvent = { ...persisted };
      delete attributed.ingestSeq;
      const resolver = resolverFor(standardProject(), {
        resolveStackImpl: stackResolver([first]),
        devServerOrigin: DEV_ORIGIN,
      });

      const before = await resolved(resolver.resolveEvent(attributed));
      const after = await resolved(resolver.resolveEvent(persisted));
      const batch = await resolver.resolveEvents([attributed]);

      expect(before).toEqual(after);
      expect(before.route).toBe(ROUTE.sourceMap);
      expect(isOk(batch) && batch.value.get(persisted.id)).toEqual(before.location);
    });

    it('still refuses a malformed attributed event', async () => {
      const attributed: ResolvableEvent = {
        ...makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
        spanId: 'not-a-span-id',
      };
      delete attributed.ingestSeq;
      const outcome = await resolverFor(standardProject(), {
        resolveStackImpl: stackResolver([mapped(PROJECT.component.file)]),
        devServerOrigin: DEV_ORIGIN,
      }).resolveEvent(attributed);

      expect(isErr(outcome)).toBe(true);
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

    describe('the frame that initiated a request', () => {
      /** The invented console's shared request helper, a feed loader, a hook and a panel with a click handler. */
      const HELPER = {
        name: 'consoleRequest',
        file: 'src/lib/console-request.ts',
        line: 10,
        column: 23,
      };
      const LOADER = { name: 'loadGaugeFeed', file: 'src/lib/gauge-feed.ts', line: 5, column: 23 };
      const HOOK = {
        name: 'useGaugeFeed',
        file: 'src/hooks/useGaugeFeed.ts',
        line: 12,
        column: 17,
      };
      const PANEL_FILE = 'src/components/GaugePanel.tsx';
      const PANEL = { name: 'GaugePanel', file: PANEL_FILE, line: 4, column: 17 };

      /**
       * `standardProject` with the helper, loader and hook declared, and a
       * panel component holding one inline click handler.
       */
      const initiatorProject = (): Project => {
        const project = standardProject();
        const hookNode: CodeNodeOf<'symbol'> = { ...symbolNode(HOOK), endLine: 48 };
        const helperNode: CodeNodeOf<'symbol'> = { ...symbolNode(HELPER), endLine: 60 };
        const loaderNode: CodeNodeOf<'symbol'> = { ...symbolNode(LOADER), endLine: 20 };
        const panelNode = componentNode(PANEL, 80);
        const clickNode = handlerNode(
          { name: 'onClick', file: PANEL_FILE, line: 30, column: 20 },
          33,
        );
        return {
          ...project,
          graph: graphOf(project.dbCalls, {
            nodes: [
              ...project.structure.nodes,
              hookNode,
              helperNode,
              loaderNode,
              panelNode,
              clickNode,
            ],
            edges: project.structure.edges,
          }),
        };
      };

      /** The source-map outcome of a `kind` span whose stack maps to `frames`, innermost first. */
      const initiatedAt = async (
        frames: readonly SourceLocation[],
        overrides: Partial<SourceResolverDeps> = {},
        kind: TelemetryKind = KIND.fetch,
      ): Promise<SourceLocation> => {
        const stackAttribute = kind === KIND.error ? ATTR.errorStack : ATTR.initiator;
        const outcome = await resolved(
          resolverFor(initiatorProject(), {
            resolveStackImpl: stackResolver(frames),
            devServerOrigin: DEV_ORIGIN,
            ...overrides,
          }).resolveEvent(makeEvent({ kind, attributes: { [stackAttribute]: CHUNK_STACK } })),
        );
        expect(outcome.route).toBe(ROUTE.sourceMap);
        return outcome.location;
      };

      it('passes over the shared request helper and its callers to the hook that started the request', async () => {
        const hookFrame = mapped(HOOK.file, 30);
        const location = await initiatedAt([
          mapped(HELPER.file, 20),
          mapped(HELPER.file, 41),
          mapped(LOADER.file, 9),
          hookFrame,
        ]);
        expect(location).toEqual({
          ...hookFrame,
          symbol: HOOK.name,
          confidence: DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.sourceMap],
        });
      });

      it('takes an event handler frame as the initiator, named by the innermost declaration', async () => {
        const location = await initiatedAt([mapped(HELPER.file, 20), mapped(PANEL_FILE, 31)]);
        expect(location.file).toBe(PANEL_FILE);
        expect(location.line).toBe(31);
        // Inside both the panel and its handler: the handler is the narrower.
        expect(location.symbol).toBe('onClick');
      });

      it('names a component frame outside every handler by the component', async () => {
        const location = await initiatedAt([mapped(HELPER.file, 20), mapped(PANEL_FILE, 52)]);
        expect(location.line).toBe(52);
        expect(location.symbol).toBe(PANEL.name);
      });

      it('keeps the mapped name of a frame chosen without a declaration to name it', async () => {
        const location = await initiatedAt([mapped(HELPER.file, 20), mapped(LOADER.file, 9)]);
        expect(location.file).toBe(LOADER.file);
        expect(location.symbol).toBe(mapped(LOADER.file, 9).symbol);
      });

      it('takes the nearest frame outside the module that called fetch when no frame is a component, handler or hook', async () => {
        const location = await initiatedAt([
          mapped(HELPER.file, 20),
          mapped(HELPER.file, 41),
          mapped(LOADER.file, 9),
          mapped(PROJECT.fn.file, 21),
        ]);
        expect(location.file).toBe(LOADER.file);
      });

      it('keeps the innermost frame when every frame is in the module that called fetch', async () => {
        const location = await initiatedAt([mapped(HELPER.file, 20), mapped(HELPER.file, 41)]);
        expect(location.line).toBe(20);
      });

      it('without a code graph, still passes over the module that called fetch', async () => {
        const location = await initiatedAt([mapped(HELPER.file, 20), mapped(HOOK.file, 30)], {
          graph: undefined,
        });
        expect(location.file).toBe(HOOK.file);
      });

      it('keeps the innermost frame of a browser error stack, where it was thrown', async () => {
        const location = await initiatedAt(
          [mapped(HELPER.file, 20), mapped(HOOK.file, 30)],
          {},
          KIND.error,
        );
        expect(location.file).toBe(HELPER.file);
        expect(location.line).toBe(20);
      });
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

    describe('a frame of a module the dev server re-evaluated after a patch', () => {
      /*
       * Turbopack's dev runtime re-evaluates a hot-updated module — for this
       * product, typically a file a patch just rewrote — with a `sourceURL` of
       * `<chunk>.js?id=<module id>`, redacted to `?id=?` before a stack is
       * stored, and that module's frames count lines and columns from the
       * module, not from the chunk. Every case here runs the real stack
       * resolver against a dev-server double serving one chunk and its index
       * map; nothing but the injected `fetch` is reached.
       */
      const HOT_CHUNK_NAME = 'src_components_GaugeDial_tsx_0q7b3._.js';
      const HOT_CHUNK = `${DEV_ORIGIN}/_next/static/chunks/${HOT_CHUNK_NAME}`;
      const HOT_MAP = `${HOT_CHUNK}.map`;

      /** The invented dial component: `fetch` starts at line 12, 0-based column 27. */
      const DIAL_SOURCE: string = [
        "'use client';",
        '',
        "import { useEffect, useState } from 'react';",
        '',
        '/** One gauge’s dial, polling its reading. Invented for this suite. */',
        '',
        `export function ${PROJECT.component.name}({ gaugeId }: { readonly gaugeId: string }) {`,
        '  const [reading, setReading] = useState<number | undefined>(undefined);',
        '',
        '  async function refresh(): Promise<void> {',
        '    setReading(undefined);',
        '    const response = await fetch(readingsUrlFor(gaugeId));',
        '    setReading(Number(await response.text()));',
        '  }',
        '',
        '  useEffect(() => {',
        '    void refresh();',
        '  });',
        '',
        "  return <output onClick={() => void refresh()}>{reading ?? '…'}</output>;",
        '}',
        '',
      ].join('\n');

      /**
       * The chunk's index map, shaped as Turbopack's dev server serves one
       * (`sources` empty beside `sections`). Each section's segments, decoded,
       * as `[generated column, source, original line, original column, name]`
       * on 0-based lines relative to the section:
       *
       * - a dependency at offset 0: `[0,0,n,0]` on lines 0–14, and line 14 also
       *   `[27,0,14,4,0]` — so the frame's position read **chunk-relative**
       *   lands here, outside the project;
       * - `GaugeDial` at offset 30: line 6 `[0,0,6,0] [16,0,6,16,0]` (the
       *   declaration) and line 11 `[4,0,11,4] [27,0,11,27,1]` (the `fetch`
       *   call);
       * - the gauges module at offset 60: line 11 `[0,0,21,2]`, and when
       *   `colliding` also `[27,0,21,24,1]` — a segment starting at the very
       *   position the frame names, mapped to `samples.reduce` on line 22.
       */
      const hotChunkMap = (gauges: 'apart' | 'colliding'): string =>
        JSON.stringify({
          version: 3,
          sources: [],
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: {
                version: 3,
                sources: [`file://${PROJECT_ROOT}/node_modules/gauge-kit/dist/index.js`],
                names: ['emit'],
                mappings:
                  'AAAA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA,2BAAIA',
              },
            },
            {
              offset: { line: 30, column: 0 },
              map: {
                version: 3,
                sources: [`file://${PROJECT_ROOT}/${PROJECT.component.file}`],
                sourcesContent: [DIAL_SOURCE],
                names: [PROJECT.component.name, 'fetch'],
                mappings: ';;;;;;AAMA,gBAAgBA;;;;;IAKZ,uBAAuBC',
              },
            },
            {
              offset: { line: 60, column: 0 },
              map: {
                version: 3,
                sources: [`file://${PROJECT_ROOT}/${PROJECT.fn.file}`],
                sourcesContent: [GAUGES_MODULE],
                names: [PROJECT.fn.name, 'reduce'],
                mappings: gauges === 'colliding' ? ';;;;;;;;;;;AAqBE,2BAAsBC' : ';;;;;;;;;;;AAqBE',
              },
            },
          ],
        });

      /** The dev server: the chunk, whose directive names its map, and the map; anything else is a 404. */
      function hotDevServer(gauges: 'apart' | 'colliding'): {
        readonly fetchImpl: Mock<typeof fetch>;
        readonly requested: string[];
      } {
        const requested: string[] = [];
        const fetchImpl = vi.fn<typeof fetch>((input) => {
          const url = input instanceof Request ? input.url : String(input);
          requested.push(url);
          if (url === HOT_CHUNK) {
            return Promise.resolve(
              new Response(`"use strict";\n//# sourceMappingURL=${HOT_CHUNK_NAME}.map\n`),
            );
          }
          if (url === HOT_MAP) {
            return Promise.resolve(new Response(hotChunkMap(gauges)));
          }
          return Promise.resolve(new Response('not found', { status: 404 }));
        });
        return { fetchImpl, requested };
      }

      /**
       * A request initiator with one frame in `fn`, at section line 12 plus
       * Turbopack's three-line module prelude and the 1-based form of column
       * 27. `query` is the module query the frame's URL carries — redacted as
       * stored, or `''` for the same position read as an ordinary frame.
       */
      const hotStack = (fn: string, query = '?id=?'): string =>
        ['Error', `    at ${fn} (${HOT_CHUNK}${query}:15:28)`].join('\n');

      /** The outcome for a fetch span initiated by `stack`, with the real stack resolver. */
      const hotResolution = (
        stack: string,
        server: ReturnType<typeof hotDevServer>,
        modifications: ModificationCorroborationPort,
        logger?: Logger,
      ): Promise<Result<SourceResolution, DebuggenError>> =>
        resolverFor(standardProject(), {
          fetchImpl: server.fetchImpl,
          devServerOrigin: DEV_ORIGIN,
          modifications,
          ...(logger === undefined ? {} : { logger }),
        }).resolveEvent(makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: stack } }));

      /** A source-map location at `where`, as route 4 answers one. */
      const hotLocation = (where: {
        readonly file: string;
        readonly line: number;
        readonly column: number;
        readonly symbol: string;
      }): SourceLocation => ({
        ...where,
        resolvedBy: ROUTE.sourceMap,
        confidence: DEFAULT_RESOLUTION_CONFIDENCE[ROUTE.sourceMap],
      });

      /** The `fetch` call in `GaugeDial`, named after the component it is in. */
      const DIAL_CALL = hotLocation({
        file: PROJECT.component.file,
        line: 12,
        column: 28,
        symbol: PROJECT.component.name,
      });

      /** The colliding segment's target in the gauges module, keeping the map's name. */
      const GAUGES_CALL = hotLocation({
        file: PROJECT.fn.file,
        line: 22,
        column: 25,
        symbol: 'reduce',
      });

      /** A journal whose metadata read fails, as a closed store's does. */
      const unreadableJournal = (): ModificationCorroborationPort => ({
        listBySession: () =>
          err(new DebuggenError('STORE_ERROR', 'The modification journal could not be read.')),
        listPatchEvidence: () => ok([]),
      });

      it('maps it within its own module’s section, where read against the whole chunk it lands in a dependency', async () => {
        const server = hotDevServer('apart');
        const journal = fakeJournal([modification(PROJECT.component.file, 'applied')]);
        const outcome = await resolved(hotResolution(hotStack('refresh'), server, journal.port));

        expect(outcome.route).toBe(ROUTE.sourceMap);
        expect(outcome.location).toEqual(DIAL_CALL);
        expect(journal.listBySession, 'one answer needs no tie-breaker').not.toHaveBeenCalled();
        // The chunk and its map are read at the chunk's own URL, without the module query.
        expect([...new Set(server.requested)].sort()).toEqual([HOT_CHUNK, HOT_MAP].sort());

        // The same position read as an ordinary, chunk-relative frame is the
        // dependency's, and refused: what every hot-updated frame used to get.
        const chunkRelative = await unresolved(
          hotResolution(hotStack('refresh', ''), hotDevServer('apart'), fakeJournal([]).port),
        );
        expect(chunkRelative.reason).toBe(reason('unmapped-frame'));
      });

      it('takes the module a patch in force had rewritten when two project modules match the position, ahead of the frame’s name', async () => {
        const cases: readonly (readonly [ModificationRecord, string, SourceLocation])[] = [
          [modification(PROJECT.component.file, 'applied'), 'refresh', DIAL_CALL],
          [modification(PROJECT.fn.file, 'applied'), 'refresh', GAUGES_CALL],
          // Reverted since, but applied before the span started: in force when it ran.
          [modification(PROJECT.fn.file, 'reverted'), 'refresh', GAUGES_CALL],
          // The gauges section names the frame's function; the journal still decides.
          [modification(PROJECT.component.file, 'applied'), PROJECT.fn.name, DIAL_CALL],
        ];
        for (const [record, fn, expected] of cases) {
          const journal = fakeJournal([record]);
          const outcome = await resolved(
            hotResolution(hotStack(fn), hotDevServer('colliding'), journal.port),
          );
          expect(outcome.location).toEqual(expected);
          expect(journal.listBySession).toHaveBeenCalledTimes(1);
          expect(journal.listBySession).toHaveBeenCalledWith(SESSION);
        }
      });

      it('skips the frame rather than guess when nothing tells the modules apart', async () => {
        const afterTheSpan = BASE_TIME + 1_000_000_000;
        const journals: readonly (readonly ModificationRecord[])[] = [
          [],
          [modification(PROJECT.storeFile, 'applied')],
          [modification(PROJECT.component.file, 'reverted', afterTheSpan)],
          [modification(PROJECT.component.file, 'applied', BASE_TIME - 1_000, OTHER_SESSION)],
        ];
        for (const records of journals) {
          const journal = fakeJournal(records);
          const outcome = await unresolved(
            hotResolution(hotStack('refresh'), hotDevServer('colliding'), journal.port),
          );
          expect(outcome.reason).toBe(reason('unmapped-frame'));
          expect(journal.listBySession).toHaveBeenCalledTimes(1);
        }
      });

      it('falls back to the section naming the frame’s function, and an unreadable journal only removes the hint', async () => {
        const named = await resolved(
          hotResolution(hotStack(PROJECT.fn.name), hotDevServer('colliding'), fakeJournal([]).port),
        );
        expect(named.location).toEqual(GAUGES_CALL);

        const entries: LogEntry[] = [];
        const unreadable = await resolved(
          hotResolution(
            hotStack(PROJECT.fn.name),
            hotDevServer('colliding'),
            unreadableJournal(),
            capturingLogger(entries),
          ),
        );
        expect(unreadable.location).toEqual(GAUGES_CALL);
        expect(entries).toContainEqual(
          expect.objectContaining({
            level: 'debug',
            message:
              'The modification journal could not be read; hot-updated frames get no tie-breaker',
          }),
        );

        const skipped = await unresolved(
          hotResolution(hotStack('refresh'), hotDevServer('colliding'), unreadableJournal()),
        );
        expect(skipped.reason).toBe(reason('unmapped-frame'));
      });
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
          listPatchEvidence: () => ok([]),
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
          listPatchEvidence: () => ok([]),
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
          listPatchEvidence: () => ok([]),
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

describe('SourceResolver.resolveEvents — the worker pool and the budget', () => {
  /** A request span whose initiator stack only the source-map route can place. */
  const fetchEvent = (): TelemetryEvent =>
    makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } });

  /**
   * A stack resolver that answers `locations` a macrotask later, recording how
   * many of its calls were outstanding at once.
   */
  function overlappingStack(locations: readonly SourceLocation[]) {
    let inFlight = 0;
    let peak = 0;
    const impl = vi.fn<typeof resolveStack>(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      inFlight -= 1;
      return [...locations];
    });
    return { impl, peak: (): number => peak };
  }

  /** A stack resolver that holds every call until the signal it was handed aborts. */
  function heldStack() {
    const signals: AbortSignal[] = [];
    const impl = vi.fn<typeof resolveStack>(
      (_stack, options) =>
        new Promise((resolve) => {
          const signal = options.signal;
          if (signal === undefined) {
            resolve([]);
            return;
          }
          signals.push(signal);
          signal.addEventListener(
            'abort',
            () => {
              resolve([]);
            },
            { once: true },
          );
        }),
    );
    return { impl, signals };
  }

  /** The fields of the one batch summary a resolver logged. */
  function batchSummary(entries: readonly LogEntry[]): LogFields | undefined {
    return entries.find((entry) => entry.message === 'source resolution batch finished')?.fields;
  }

  it('keeps at most maxConcurrentEvents events in flight and still answers in input order', async () => {
    const events = Array.from({ length: 10 }, fetchEvent);

    const pooled = overlappingStack([mapped(PROJECT.component.file)]);
    const page = await located(
      resolverFor(standardProject(), {
        resolveStackImpl: pooled.impl,
        devServerOrigin: DEV_ORIGIN,
      }).resolveEvents(events),
    );
    expect(pooled.impl).toHaveBeenCalledTimes(events.length);
    expect(pooled.peak()).toBe(SOURCE_RESOLVE_LIMITS.maxConcurrentEvents);
    expect([...page.keys()]).toEqual(events.map((event) => event.id));

    const narrowed = overlappingStack([]);
    await located(
      resolverFor(standardProject(), {
        resolveStackImpl: narrowed.impl,
        devServerOrigin: DEV_ORIGIN,
        limits: { maxConcurrentEvents: 2 },
      }).resolveEvents(events),
    );
    expect(narrowed.peak()).toBe(2);

    const raised = overlappingStack([]);
    await located(
      resolverFor(standardProject(), {
        resolveStackImpl: raised.impl,
        devServerOrigin: DEV_ORIGIN,
        limits: { maxConcurrentEvents: SOURCE_RESOLVE_LIMITS.maxConcurrentEvents * 4 },
      }).resolveEvents(events),
    );
    expect(raised.peak()).toBe(SOURCE_RESOLVE_LIMITS.maxConcurrentEvents);
  });

  it('shares one journal read between the concurrent events of a batch', async () => {
    const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
    const events = Array.from({ length: 6 }, () =>
      makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) }),
    );

    const page = await located(
      resolverFor(standardProject(), { modifications: journal.port }).resolveEvents(events),
    );

    expect(page.size).toBe(events.length);
    expect(journal.listBySession).toHaveBeenCalledTimes(1);
    expect(journal.listBySession).toHaveBeenCalledWith(SESSION);
  });

  it('stops starting events when the budget fires and answers Ok with the locations found so far', async () => {
    const entries: LogEntry[] = [];
    const budget = new AbortController();
    const events = Array.from({ length: 5 }, fetchEvent);
    let calls = 0;
    const resolveStackImpl = vi.fn<typeof resolveStack>(() => {
      calls += 1;
      if (calls === 2) {
        budget.abort();
      }
      return Promise.resolve([mapped(PROJECT.component.file)]);
    });

    const page = await located(
      resolverFor(standardProject(), {
        resolveStackImpl,
        devServerOrigin: DEV_ORIGIN,
        limits: { maxConcurrentEvents: 1 },
        logger: capturingLogger(entries),
      }).resolveEvents(events, { budget: budget.signal }),
    );

    // The second stack answered after the budget fired, and its answer is kept.
    expect([...page.keys()]).toEqual(events.slice(0, 2).map((event) => event.id));
    expect(resolveStackImpl).toHaveBeenCalledTimes(2);
    expect(batchSummary(entries)).toMatchObject({
      resolved: 2,
      unresolved: 3,
      budgetExpired: 3,
    });
  });

  it('lets work in flight see the budget, and counts the events it cut short as unresolved', async () => {
    const entries: LogEntry[] = [];
    const budget = new AbortController();
    const held = heldStack();
    const events = Array.from({ length: 6 }, fetchEvent);

    const pending = resolverFor(standardProject(), {
      resolveStackImpl: held.impl,
      devServerOrigin: DEV_ORIGIN,
      logger: capturingLogger(entries),
    }).resolveEvents(events, { budget: budget.signal });
    await vi.waitFor(() => {
      expect(held.impl).toHaveBeenCalledTimes(SOURCE_RESOLVE_LIMITS.maxConcurrentEvents);
    });
    budget.abort();

    const page = await located(pending);
    expect(page.size).toBe(0);
    expect(held.impl).toHaveBeenCalledTimes(SOURCE_RESOLVE_LIMITS.maxConcurrentEvents);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);
    expect(batchSummary(entries)).toMatchObject({
      resolved: 0,
      unresolved: events.length,
      budgetExpired: events.length,
    });
  });

  it('still fails the batch when a cancelling signal fires, budget or not', async () => {
    const cancel = new AbortController();
    const budget = new AbortController();
    const held = heldStack();

    const pending = resolverFor(standardProject(), {
      resolveStackImpl: held.impl,
      devServerOrigin: DEV_ORIGIN,
    }).resolveEvents([fetchEvent(), fetchEvent()], {
      signal: cancel.signal,
      budget: budget.signal,
    });
    await vi.waitFor(() => {
      expect(held.impl).toHaveBeenCalledTimes(2);
    });
    cancel.abort();
    budget.abort();

    const error = await failed(pending);
    expect(error.details).toMatchObject({ reason: reason('aborted') });
  });

  it('answers a single event whose budget already fired as budget-expired, consulting nothing', async () => {
    const project = standardProject();
    const journal = fakeJournal([modification(PROJECT.fn.file, 'applied')]);
    const budget = new AbortController();
    budget.abort();

    const result = await resolverFor(project, { modifications: journal.port }).resolveEvent(
      makeEvent({ kind: KIND.function, source: patchStamp(PROJECT.fn) }),
      { budget: budget.signal },
    );

    expect(result).toEqual({
      ok: true,
      value: { status: 'unresolved', reason: reason('budget-expired'), attempted: [] },
    });
    expect(project.fake.totalCalls()).toBe(0);
    expect(journal.listBySession).not.toHaveBeenCalled();
  });

  it('yields the event loop during a CPU-bound batch, so its budget stops it within about one slice', async () => {
    // Every query span's parent lies outside the batch, and the store port
    // answers it synchronously after `ITEM_MS` of CPU — the shape of the real
    // `node:sqlite` port. Nothing in the batch ever waits, so without a yield
    // the budget's timer could not fire until every event had been resolved.
    const ITEM_MS = 2;
    const BUDGET_MS = 40;
    const events = Array.from({ length: 400 }, () =>
      makeEvent({
        kind: KIND.dbQuery,
        parentSpanId: newSpanId(),
        attributes: { [ATTR.dbClient]: 'pg' },
      }),
    );
    const unboundedMs = events.length * ITEM_MS;
    let lookups = 0;
    let spins = 0;
    const slowParents: ParentEventPort = {
      getBySpanId: () => {
        lookups += 1;
        const until = performance.now() + ITEM_MS;
        while (performance.now() < until) {
          spins += 1;
        }
        return ok(undefined);
      },
    };
    const entries: LogEntry[] = [];
    const budget = new AbortController();
    let abortedAt = Number.POSITIVE_INFINITY;
    const timer = setTimeout(() => {
      abortedAt = performance.now();
      budget.abort();
    }, BUDGET_MS);

    const startedAt = performance.now();
    const page = await located(
      resolverFor(standardProject(), {
        events: slowParents,
        logger: capturingLogger(entries),
      }).resolveEvents(events, { budget: budget.signal }),
    );
    const settledAt = performance.now();
    clearTimeout(timer);

    // The budget fired during the batch and ended it: far fewer lookups than
    // events, well before the unbounded run would have finished, and the
    // overrun past the abort is about one slice plus the items in flight
    // (the slack absorbs a loaded host's scheduling, not a missing yield).
    expect(spins).toBeGreaterThan(0);
    expect(Number.isFinite(abortedAt)).toBe(true);
    expect(lookups).toBeLessThan(events.length / 2);
    expect(settledAt - startedAt).toBeLessThan(unboundedMs / 2);
    expect(settledAt - abortedAt).toBeLessThan(
      2 * RESOLVE_YIELD_SLICE_MS + SOURCE_RESOLVE_LIMITS.maxConcurrentEvents * ITEM_MS + BUDGET_MS,
    );
    expect(page.size).toBe(0);
    const summary = batchSummary(entries);
    expect(summary).toMatchObject({ resolved: 0, unresolved: events.length });
    expect(Number(summary?.['budgetExpired'])).toBe(events.length - lookups);
  }, 10_000);
});

describe('SourceResolver.resolveEvents — one reachability search per owner', () => {
  /** A `db.query` span under `parentSpanId` from the `client` driver. */
  const queryUnder = (parentSpanId: string, client: string): TelemetryEvent =>
    makeEvent({
      kind: KIND.dbQuery,
      parentSpanId,
      attributes: { [ATTR.dbClient]: client, [ATTR.dbSystem]: 'postgresql' },
    });

  /**
   * A batch of query spans under three owners — a function, a route handler
   * whose method only its request span names, and a function the graph
   * reaches nothing from — interleaved, with two drivers, and the owners'
   * own spans in the batch as their parents.
   */
  function mixedBatch(project: Project): {
    readonly owners: readonly TelemetryEvent[];
    readonly queries: readonly TelemetryEvent[];
  } {
    const fn = makeEvent({
      kind: KIND.function,
      name: PROJECT.fn.name,
      attributes: { [ATTR.symbol]: PROJECT.fn.name, [ATTR.module]: PROJECT.fn.file },
    });
    const request = makeEvent({
      kind: KIND.httpServer,
      attributes: { [ATTR.httpMethod]: 'GET', [ATTR.httpRoute]: PROJECT.routePath },
    });
    const handler = makeEvent({
      kind: KIND.routeHandler,
      parentSpanId: request.spanId,
      attributes: { [ATTR.nextRoute]: PROJECT.routePath },
    });
    const isolated = makeEvent({
      kind: KIND.function,
      name: 'renderIsolatedPanel',
      attributes: { [ATTR.symbol]: 'renderIsolatedPanel', [ATTR.module]: project.auditCall.file },
    });
    const queries: TelemetryEvent[] = [];
    for (let round = 0; round < 8; round += 1) {
      queries.push(
        queryUnder(fn.spanId, 'pg'),
        queryUnder(handler.spanId, 'pg'),
        queryUnder(fn.spanId, 'prisma'),
        queryUnder(isolated.spanId, 'pg'),
        queryUnder(handler.spanId, 'prisma'),
      );
    }
    return { owners: [fn, request, handler, isolated], queries };
  }

  /**
   * Each event resolved on its own, with a fresh scope per call — what every
   * event got before the batch shared its searches — keyed like a page.
   */
  async function individually(
    events: readonly TelemetryEvent[],
    overrides: Partial<SourceResolverDeps>,
  ): Promise<{ readonly page: Map<string, SourceLocation>; readonly searches: number }> {
    const project = standardProject();
    const outgoing = vi.spyOn(project.graph, 'outgoing');
    const resolver = resolverFor(project, overrides);
    const page = new Map<string, SourceLocation>();
    for (const event of events) {
      const outcome = await settled(resolver.resolveEvent(event));
      if (outcome.status === 'resolved') {
        page.set(event.id, outcome.location);
      }
    }
    return { page, searches: outgoing.mock.calls.length };
  }

  it.each([
    { label: 'the whole call-site pool', limits: {} },
    { label: 'a pool narrowed by driver first', limits: { maxDbCandidates: 2 } },
  ])(
    'answers a batch exactly as resolving each event alone does, searching once per owner — $label',
    async ({ limits }) => {
      const project = standardProject();
      const { owners, queries } = mixedBatch(project);
      const batch = [...owners, ...queries];
      const parents = fakeParents(owners);

      const expected = await individually(batch, { events: fakeParents(owners).port, limits });
      const outgoing = vi.spyOn(project.graph, 'outgoing');
      const page = await located(
        resolverFor(project, { events: parents.port, limits }).resolveEvents(batch),
      );

      expect([...page.keys()]).toEqual([...expected.page.keys()]);
      for (const [id, location] of expected.page) {
        expect(page.get(id)).toEqual(location);
      }
      // Not vacuous: most query spans are placed, and the owner the graph
      // reaches nothing from places none of its own.
      const [, , , isolated] = owners;
      const placedQueries = queries.filter((event) => page.has(event.id));
      expect(placedQueries.length).toBeGreaterThanOrEqual(queries.length / 2);
      expect(
        queries.filter((event) => event.parentSpanId === isolated?.spanId && page.has(event.id)),
      ).toEqual([]);

      // One reach search per distinct owner across the batch — each a walk of
      // the owner's outgoing edges — where the events alone searched once per
      // query span.
      expect(outgoing.mock.calls.length).toBeGreaterThan(0);
      expect(expected.searches).toBeGreaterThan(outgoing.mock.calls.length * 3);
      expect(parents.getBySpanId).not.toHaveBeenCalled();
    },
  );

  it('keeps each batch’s searches to itself', async () => {
    const project = standardProject();
    const { owners, queries } = mixedBatch(project);
    const resolver = resolverFor(project, { events: fakeParents(owners).port });
    const outgoing = vi.spyOn(project.graph, 'outgoing');

    await located(resolver.resolveEvents([...owners, ...queries]));
    const first = outgoing.mock.calls.length;
    await located(resolver.resolveEvents([...owners, ...queries]));

    expect(first).toBeGreaterThan(0);
    expect(outgoing.mock.calls.length).toBe(first * 2);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The metadata-only journal and the cross-batch corroboration cache
 * ---------------------------------------------------------------------------------------------- */

describe('metadata-first corroboration', () => {
  /** The patch evidence of `facts`: each fact with the diff the real patcher wrote for its file. */
  function evidenceOf(
    facts: readonly ModificationCorroboration[],
  ): Mock<ModificationCorroborationPort['listPatchEvidence']> {
    return vi.fn<ModificationCorroborationPort['listPatchEvidence']>((_sessionId, file) =>
      ok(
        facts
          .filter((fact) => fact.file === file)
          .map((fact) => ({
            ...fact,
            diff: fact.file === PROJECT.fn.file ? realPatches().gauges.record.diff : '',
          })),
      ),
    );
  }

  it('corroborates a patch stamp from the metadata, then reads the diff of that one file only', async () => {
    const facts: ModificationCorroboration[] = [
      { file: 'src/unrelated/module.ts', status: 'applied', appliedAt: BASE_TIME - 1_000 },
      { file: PROJECT.fn.file, status: 'applied', appliedAt: BASE_TIME - 1_000 },
    ];
    const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>(() => ok(facts));
    const listPatchEvidence = evidenceOf(facts);

    const resolution = await resolved(
      resolverFor(standardProject(), {
        modifications: { listBySession, listPatchEvidence },
      }).resolveEvent(
        makeEvent({ kind: KIND.function, name: PROJECT.fn.name, source: patchStamp(PROJECT.fn) }),
      ),
    );

    expect(resolution.route).toBe(ROUTE.patch);
    expect(resolution.location).toEqual(patchStamp(PROJECT.fn));
    expect(listBySession).toHaveBeenCalledWith(SESSION);
    expect(listPatchEvidence.mock.calls).toEqual([[SESSION, PROJECT.fn.file]]);
  });

  it('reads no diff for a stamp whose file the metadata never saw in force', async () => {
    const facts: ModificationCorroboration[] = [
      { file: 'src/unrelated/module.ts', status: 'applied', appliedAt: BASE_TIME - 1_000 },
    ];
    const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>(() => ok(facts));
    const listPatchEvidence = evidenceOf(facts);

    const resolution = await resolved(
      resolverFor(standardProject(), {
        modifications: { listBySession, listPatchEvidence },
      }).resolveEvent(
        makeEvent({ kind: KIND.function, name: PROJECT.fn.name, source: patchStamp(PROJECT.fn) }),
      ),
    );

    expect(resolution.route).not.toBe(ROUTE.patch);
    expect(listPatchEvidence).not.toHaveBeenCalled();
  });

  it('walks a long journal once per read, however many stamped events a batch carries', async () => {
    const appliedAt = BASE_TIME - 1_000;
    const unrelated = Array.from({ length: 5_000 }, (_, index): ModificationCorroboration => ({
      file: `src/unrelated/module-${String(index)}.ts`,
      status: index % 2 === 0 ? 'applied' : 'reverted',
      appliedAt,
    }));
    const facts: ModificationCorroboration[] = [
      ...unrelated,
      { file: PROJECT.fn.file, status: 'reverted', appliedAt: appliedAt + 500 },
      { file: `./${PROJECT.fn.file}`, status: 'reverted', appliedAt },
    ];
    let elementReads = 0;
    const counted = new Proxy(facts, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          elementReads += 1;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>(() => ok(counted));
    const listPatchEvidence = evidenceOf(facts);
    const resolver = resolverFor(standardProject(), {
      modifications: { listBySession, listPatchEvidence },
    });

    const stamped = Array.from({ length: 200 }, () =>
      makeEvent({ kind: KIND.function, name: PROJECT.fn.name, source: patchStamp(PROJECT.fn) }),
    );
    const early = makeEvent({
      kind: KIND.function,
      name: PROJECT.fn.name,
      source: patchStamp(PROJECT.fn),
      startTime: appliedAt - 1,
    });
    const placed = await resolver.resolveEvents([...stamped, early]);

    const placedBy = (id: string): string | undefined =>
      isOk(placed) ? placed.value.get(id)?.resolvedBy : undefined;
    expect(stamped.every((event) => placedBy(event.id) === ROUTE.patch)).toBe(true);
    expect(placedBy(early.id), 'reverted before the span ran: not corroborated').not.toBe(
      ROUTE.patch,
    );
    expect(listBySession).toHaveBeenCalledTimes(1);
    expect(elementReads, 'one pass over the journal').toBe(facts.length);
    // One diff read for the stamped file per batch, never one per event.
    expect(listPatchEvidence.mock.calls).toEqual([[SESSION, PROJECT.fn.file]]);

    // A second batch over the same read reuses its index.
    await resolver.resolveEvents(stamped.slice(0, 10));
    expect(elementReads).toBe(facts.length);
  });
});

describe('createCorroborationCache', () => {
  const CAPTURE_A = newCaptureId();
  const CAPTURE_B = newCaptureId();
  const FACTS: readonly ModificationCorroboration[] = Object.freeze([
    { file: PROJECT.fn.file, status: 'applied', appliedAt: BASE_TIME - 1_000 },
  ]);

  /** A journal answering {@link FACTS}, or what `answer` returns instead. */
  function countingJournal(
    answer: () => ReturnType<ModificationCorroborationPort['listBySession']> = () => ok(FACTS),
  ) {
    const listBySession = vi.fn<ModificationCorroborationPort['listBySession']>(() => answer());
    const listPatchEvidence = vi.fn<ModificationCorroborationPort['listPatchEvidence']>(() =>
      ok([]),
    );
    return { journal: { listBySession, listPatchEvidence }, listBySession, listPatchEvidence };
  }

  it('shares one read between the batches of a capture, and keeps captures apart', async () => {
    const { journal, listBySession } = countingJournal();
    const cache = createCorroborationCache({ journal, now: () => BASE_TIME });

    const first = await cache.forCapture(CAPTURE_A).listBySession(SESSION);
    const second = await cache.forCapture(CAPTURE_A).listBySession(SESSION);
    expect(first).toEqual(ok(FACTS));
    expect(second).toEqual(first);
    expect(listBySession).toHaveBeenCalledTimes(1);

    await cache.forCapture(CAPTURE_B).listBySession(SESSION);
    await cache.forCapture(CAPTURE_A).listBySession(OTHER_SESSION);
    expect(listBySession).toHaveBeenCalledTimes(3);
    expect(listBySession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      SESSION,
      SESSION,
      OTHER_SESSION,
    ]);
  });

  it('shares a read still in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { journal, listBySession } = countingJournal(() => gate.then(() => ok(FACTS)));
    const port = createCorroborationCache({ journal, now: () => BASE_TIME }).forCapture(CAPTURE_A);

    const first = port.listBySession(SESSION);
    const second = port.listBySession(SESSION);
    release?.();

    expect(await Promise.all([first, second])).toEqual([ok(FACTS), ok(FACTS)]);
    expect(listBySession).toHaveBeenCalledTimes(1);
  });

  it('reads again once the TTL has passed, or when the clock went backwards', async () => {
    let now = BASE_TIME;
    const { journal, listBySession } = countingJournal();
    const port = createCorroborationCache({ journal, now: () => now }).forCapture(CAPTURE_A);

    await port.listBySession(SESSION);
    now += CORROBORATION_CACHE_TTL_MS - 1;
    await port.listBySession(SESSION);
    expect(listBySession).toHaveBeenCalledTimes(1);

    now += 1;
    await port.listBySession(SESSION);
    expect(listBySession).toHaveBeenCalledTimes(2);

    now -= 5_000;
    await port.listBySession(SESSION);
    expect(listBySession).toHaveBeenCalledTimes(3);

    const short = countingJournal();
    let clock = BASE_TIME;
    const shortPort = createCorroborationCache({
      journal: short.journal,
      ttlMs: 50,
      now: () => clock,
    }).forCapture(CAPTURE_A);
    await shortPort.listBySession(SESSION);
    clock += 50;
    await shortPort.listBySession(SESSION);
    expect(short.listBySession).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failed or throwing read', async () => {
    let calls = 0;
    const { journal, listBySession } = countingJournal(() => {
      calls += 1;
      if (calls === 1) {
        return err(new DebuggenError('STORE_ERROR', 'The journal is closed.'));
      }
      if (calls === 2) {
        throw new Error('the journal handle was revoked');
      }
      return ok(FACTS);
    });
    const port = createCorroborationCache({ journal, now: () => BASE_TIME }).forCapture(CAPTURE_A);

    const refused = await port.listBySession(SESSION);
    expect(isErr(refused) && refused.error.code).toBe('STORE_ERROR');
    const thrown = await port.listBySession(SESSION);
    expect(isErr(thrown) && thrown.error.code).toBe('STORE_ERROR');
    expect(await port.listBySession(SESSION)).toEqual(ok(FACTS));
    expect(await port.listBySession(SESSION)).toEqual(ok(FACTS));
    expect(listBySession).toHaveBeenCalledTimes(3);
  });

  it('holds at most maxEntries reads, dropping the oldest first', async () => {
    const { journal, listBySession } = countingJournal();
    const cache = createCorroborationCache({ journal, maxEntries: 1, now: () => BASE_TIME });

    await cache.forCapture(CAPTURE_A).listBySession(SESSION);
    await cache.forCapture(CAPTURE_B).listBySession(SESSION);
    await cache.forCapture(CAPTURE_A).listBySession(SESSION);

    expect(listBySession).toHaveBeenCalledTimes(3);
  });

  it('keeps reading when the clock throws or answers nonsense', async () => {
    const { journal, listBySession } = countingJournal();
    const cache = createCorroborationCache({
      journal,
      now: () => {
        throw new Error('the clock is gone');
      },
    });

    expect(await cache.forCapture(CAPTURE_A).listBySession(SESSION)).toEqual(ok(FACTS));
    expect(await cache.forCapture(CAPTURE_A).listBySession(SESSION)).toEqual(ok(FACTS));
    expect(listBySession).toHaveBeenCalledTimes(1);

    const nonsense = countingJournal();
    const second = createCorroborationCache({ journal: nonsense.journal, now: () => Number.NaN });
    expect(await second.forCapture(CAPTURE_A).listBySession(SESSION)).toEqual(ok(FACTS));
    expect(nonsense.listBySession).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The cross-batch source-map scopes
 * ---------------------------------------------------------------------------------------------- */

describe('createSourceMapScopes', () => {
  const CHUNK_ONE = `${DEV_ORIGIN}/_next/static/chunks/app/gauges/page.js`;
  const CHUNK_TWO = `${DEV_ORIGIN}/_next/static/chunks/app/layout.js`;
  const CHUNK_THREE = `${DEV_ORIGIN}/_next/static/chunks/webpack.js`;
  const NO_MAP: Result<SourceMapLookup, DebuggenError> = ok({
    kind: 'none',
    reason: 'no-directive',
  });

  /** A lookup double answering `answer` (the chunk has no map, by default). */
  function countingLookup(
    answer: () => ReturnType<typeof fetchSourceMap> = () => Promise.resolve(NO_MAP),
  ): Mock<typeof fetchSourceMap> {
    return vi.fn<typeof fetchSourceMap>(() => answer());
  }

  /** A lookup double held until `release` is called. */
  function heldLookup(): { readonly lookup: Mock<typeof fetchSourceMap>; release(): void } {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      lookup: countingLookup(() => gate.then(() => NO_MAP)),
      release: () => release?.(),
    };
  }

  const pinned = (extra: Partial<FetchSourceMapOptions> = {}): FetchSourceMapOptions => ({
    devServerOrigin: DEV_ORIGIN,
    ...extra,
  });

  /** A one-source map document naming `src/<build>.ts`. */
  const mapFor = (build: string): string =>
    JSON.stringify({ version: 3, sources: [`src/${build}.ts`], names: [], mappings: 'AAAA' });

  /**
   * A dev-server double: each chunk URL serves `console.log("<build>")` with a
   * directive naming its sibling `.map`, which serves {@link mapFor} of the
   * chunk's current build. Every request is recorded, in order.
   */
  function devServer(builds: Record<string, string>): {
    readonly fetchImpl: typeof fetch;
    readonly requested: string[];
  } {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const chunkBuild = builds[url];
      if (chunkBuild !== undefined) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        return Promise.resolve(
          new Response(`console.log("${chunkBuild}");\n//# sourceMappingURL=${name}.map\n`),
        );
      }
      const mapBuild = url.endsWith('.map') ? builds[url.slice(0, -'.map'.length)] : undefined;
      if (mapBuild !== undefined) {
        return Promise.resolve(new Response(mapFor(mapBuild)));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };
    return { fetchImpl, requested };
  }

  /** The `sources` of the map a lookup found, or the lookup itself when it found none. */
  async function sourcesOf(found: ReturnType<typeof fetchSourceMap>): Promise<unknown> {
    const answer = await found;
    return answer.ok && answer.value.kind === 'found' && 'sources' in answer.value.map
      ? answer.value.map.sources
      : answer;
  }

  it('shares a lookup in flight, started without any caller’s signal, and reads again after', async () => {
    const held = heldLookup();
    const scope = createSourceMapScopes({
      fetchSourceMapImpl: held.lookup,
      now: () => BASE_TIME,
    }).scopeFor('document-one');
    const signal = new AbortController().signal;

    const first = scope.lookup(CHUNK_ONE, pinned({ signal }));
    const second = scope.lookup(CHUNK_ONE, pinned());
    // The pin is compared by origin.
    const third = scope.lookup(CHUNK_ONE, pinned({ devServerOrigin: `${DEV_ORIGIN}/gauges` }));
    held.release();

    expect(await Promise.all([first, second, third])).toEqual([NO_MAP, NO_MAP, NO_MAP]);
    expect(held.lookup).toHaveBeenCalledTimes(1);
    const [chunkUrl, request] = held.lookup.mock.calls[0] ?? [];
    expect(chunkUrl).toBe(CHUNK_ONE);
    expect(request).not.toHaveProperty('signal');
    expect(typeof request?.fetchImpl).toBe('function');
    expect(request?.cache).toBeDefined();

    // A settled success is never answered from memory: the chunk may have been rebuilt.
    await scope.lookup(CHUNK_ONE, pinned());
    expect(held.lookup).toHaveBeenCalledTimes(2);
    await scope.lookup(CHUNK_TWO, pinned());
    await scope.lookup(CHUNK_ONE, pinned({ devServerOrigin: 'http://127.0.0.1:20162' }));
    expect(held.lookup).toHaveBeenCalledTimes(4);
  });

  it('answers a failure from memory only for the failure TTL', async () => {
    let now = BASE_TIME;
    const refused: Result<SourceMapLookup, DebuggenError> = err(
      new DebuggenError('DEV_SERVER_UNAVAILABLE', 'The dev server did not answer.', {
        details: { reason: 'request-failed' },
      }),
    );
    const lookup = countingLookup(() => Promise.resolve(refused));
    const scope = createSourceMapScopes({ fetchSourceMapImpl: lookup, now: () => now }).scopeFor(
      'document-one',
    );

    expect(await scope.lookup(CHUNK_ONE, pinned())).toBe(refused);
    now += SOURCE_MAP_FAILURE_TTL_MS - 1;
    expect(await scope.lookup(CHUNK_ONE, pinned())).toBe(refused);
    expect(lookup).toHaveBeenCalledTimes(1);

    now += 1;
    await scope.lookup(CHUNK_ONE, pinned());
    expect(lookup).toHaveBeenCalledTimes(2);

    now -= 1;
    await scope.lookup(CHUNK_ONE, pinned());
    expect(lookup, 'a clock that stepped back ends the failure').toHaveBeenCalledTimes(3);
  });

  it('reads each chunk once per batch, and again for the next batch', async () => {
    const lookup = countingLookup();
    const scope = createSourceMapScopes({
      fetchSourceMapImpl: lookup,
      now: () => BASE_TIME,
    }).scopeFor('document-one');

    const batch = scope.forBatch();
    expect(await batch(CHUNK_ONE, pinned())).toBe(NO_MAP);
    await batch(CHUNK_ONE, pinned());
    await batch(CHUNK_ONE, pinned({ devServerOrigin: `${DEV_ORIGIN}/gauges` }));
    expect(lookup, 'one read for the batch').toHaveBeenCalledTimes(1);
    await batch(CHUNK_TWO, pinned());
    expect(lookup, 'another chunk is its own read').toHaveBeenCalledTimes(2);

    const next = scope.forBatch();
    await next(CHUNK_ONE, pinned());
    expect(lookup, 'the next batch reads the chunk itself').toHaveBeenCalledTimes(3);
  });

  it('maps a chunk rebuilt under the same chunk and map URLs on the first lookup after the rebuild', async () => {
    // The clock never moves: nothing here may depend on a window passing.
    const builds: Record<string, string> = { [CHUNK_ONE]: 'one' };
    const server = devServer(builds);
    const mapUrl = `${CHUNK_ONE}.map`;
    const scope = createSourceMapScopes({ now: () => BASE_TIME }).scopeFor('document-one');
    const look = (): ReturnType<typeof fetchSourceMap> =>
      scope.lookup(CHUNK_ONE, pinned({ fetchImpl: server.fetchImpl }));

    expect(await sourcesOf(look())).toEqual(['src/one.ts']);
    expect(server.requested).toEqual([CHUNK_ONE, mapUrl]);

    expect(await sourcesOf(look()), 'unchanged: the kept map').toEqual(['src/one.ts']);
    expect(server.requested, 'the map is spared').toEqual([CHUNK_ONE, mapUrl, CHUNK_ONE]);

    builds[CHUNK_ONE] = 'two'; // a hot update rebuilds the chunk; both URLs are kept
    expect(await sourcesOf(look()), 'the rebuilt map, at once').toEqual(['src/two.ts']);
    expect(server.requested.slice(3)).toEqual([CHUNK_ONE, mapUrl]);

    builds[CHUNK_ONE] = 'one'; // and back: the old map was dropped, not kept aside
    expect(await sourcesOf(look())).toEqual(['src/one.ts']);
    expect(server.requested.slice(5)).toEqual([CHUNK_ONE, mapUrl]);
  });

  it('maps a rebuild on the next batch, while a batch keeps the one read it made', async () => {
    const builds: Record<string, string> = { [CHUNK_ONE]: 'one' };
    const server = devServer(builds);
    const scope = createSourceMapScopes({ now: () => BASE_TIME }).scopeFor('document-one');
    const inBatch = (batch: typeof fetchSourceMap) => (): ReturnType<typeof fetchSourceMap> =>
      batch(CHUNK_ONE, pinned({ fetchImpl: server.fetchImpl }));

    const first = inBatch(scope.forBatch());
    expect(await sourcesOf(first())).toEqual(['src/one.ts']);
    builds[CHUNK_ONE] = 'two';
    expect(await sourcesOf(first()), 'the batch answers from its own read').toEqual(['src/one.ts']);
    expect(server.requested).toHaveLength(2);

    const second = inBatch(scope.forBatch());
    expect(await sourcesOf(second()), 'the next batch reads the rebuild').toEqual(['src/two.ts']);
    expect(await sourcesOf(second())).toEqual(['src/two.ts']);
    expect(server.requested).toHaveLength(4);
  });

  it('reuses an inline map, which fetchSourceMap keys by the chunk URL, only for its own chunk', async () => {
    let build = 'one';
    const requested: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      const inline = Buffer.from(mapFor(build)).toString('base64');
      return Promise.resolve(
        new Response(
          `console.log("${build}");\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
        ),
      );
    };
    const scope = createSourceMapScopes({ now: () => BASE_TIME }).scopeFor('document-one');
    const look = (): ReturnType<typeof fetchSourceMap> =>
      scope.lookup(CHUNK_ONE, pinned({ fetchImpl }));

    expect(await sourcesOf(look())).toEqual(['src/one.ts']);
    expect(await sourcesOf(look())).toEqual(['src/one.ts']);
    build = 'two';
    expect(await sourcesOf(look()), 'the rebuilt inline map').toEqual(['src/two.ts']);
    expect(requested).toEqual([CHUNK_ONE, CHUNK_ONE, CHUNK_ONE]);
  });

  it('never digests a chunk it could not read whole, and leaves fetchSourceMap to refuse it', async () => {
    const answerWith =
      (respond: () => Response): typeof fetch =>
      () =>
        Promise.resolve(respond());
    const detailsOf = async (found: ReturnType<typeof fetchSourceMap>): Promise<unknown> => {
      const answer = await found;
      return isErr(answer) ? answer.error.details?.['reason'] : answer;
    };
    const lookupOn = (fetchImpl: typeof fetch, extra: Partial<FetchSourceMapOptions> = {}) =>
      createSourceMapScopes({ now: () => BASE_TIME })
        .scopeFor('document-one')
        .lookup(CHUNK_ONE, pinned({ fetchImpl, ...extra }));

    const longChunk = `console.log("${'x'.repeat(64)}");\n//# sourceMappingURL=page.js.map\n`;
    expect(
      await detailsOf(
        lookupOn(
          answerWith(() => new Response(longChunk)),
          { maxBytes: 16 },
        ),
      ),
      'streamed past the bound',
    ).toBe('too-large');
    expect(
      await detailsOf(
        lookupOn(
          answerWith(
            () =>
              new Response(longChunk, { headers: { 'content-length': String(longChunk.length) } }),
          ),
          { maxBytes: 16 },
        ),
      ),
      'declared past the bound',
    ).toBe('too-large');
    expect(
      await detailsOf(lookupOn(answerWith(() => new Response('', { status: 404 })))),
      'not a success',
    ).toBe('http-status');

    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('console.log("one");'));
        controller.error(new Error('the connection was reset'));
      },
    });
    expect(
      await detailsOf(lookupOn(answerWith(() => new Response(broken)))),
      'failed mid-stream',
    ).toBe('request-failed');

    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('console.log("one");'));
      },
    });
    expect(
      await detailsOf(
        lookupOn(
          answerWith(() => new Response(endless)),
          { timeoutMs: 20 },
        ),
      ),
      'ended by the request timeout',
    ).toBe('request-failed');
  });

  it('answers a cancelled caller alone and never keeps the cancellation', async () => {
    const held = heldLookup();
    const scope = createSourceMapScopes({
      fetchSourceMapImpl: held.lookup,
      now: () => BASE_TIME,
    }).scopeFor('document-one');

    const spent = new AbortController();
    spent.abort();
    const refused = await scope.lookup(CHUNK_ONE, pinned({ signal: spent.signal }));
    expect(isErr(refused) && refused.error.details?.['reason']).toBe(reason('aborted'));
    const refusedInBatch = await scope.forBatch()(CHUNK_ONE, pinned({ signal: spent.signal }));
    expect(isErr(refusedInBatch) && refusedInBatch.error.details?.['reason']).toBe(
      reason('aborted'),
    );
    expect(held.lookup).not.toHaveBeenCalled();

    const batch = scope.forBatch();
    const budget = new AbortController();
    const cancelled = batch(CHUNK_ONE, pinned({ signal: budget.signal }));
    const patient = batch(CHUNK_ONE, pinned());
    const outside = scope.lookup(CHUNK_ONE, pinned());
    budget.abort();
    const early = await cancelled;
    expect(isErr(early) && early.error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(isErr(early) && early.error.details?.['reason']).toBe(reason('aborted'));

    held.release();
    expect(await patient).toBe(NO_MAP);
    expect(await outside).toBe(NO_MAP);
    expect(await batch(CHUNK_ONE, pinned()), 'the batch kept the read, not the cancellation').toBe(
      NO_MAP,
    );
    expect(held.lookup).toHaveBeenCalledTimes(1);
  });

  it('never rejects, even when the lookup it delegates to throws', async () => {
    let now = BASE_TIME;
    const lookup = countingLookup(() => {
      throw new Error('the chunk reader was revoked');
    });
    const scope = createSourceMapScopes({ fetchSourceMapImpl: lookup, now: () => now }).scopeFor(
      'document-one',
    );

    const answer = await scope.lookup(CHUNK_ONE, pinned());
    expect(isErr(answer) && answer.error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(JSON.stringify(isErr(answer) ? answer.error.toPayload() : {})).not.toContain('revoked');
    await scope.lookup(CHUNK_ONE, pinned());
    expect(lookup, 'kept as a failure').toHaveBeenCalledTimes(1);

    now += SOURCE_MAP_FAILURE_TTL_MS;
    await scope.lookup(CHUNK_ONE, pinned());
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('holds at most maxEntriesPerScope parsed maps, dropping the least recently written', async () => {
    const server = devServer({ [CHUNK_ONE]: 'one', [CHUNK_TWO]: 'two', [CHUNK_THREE]: 'three' });
    const scope = createSourceMapScopes({
      maxEntriesPerScope: 2,
      now: () => BASE_TIME,
    }).scopeFor('document-one');
    const mapsFetched = (): number => server.requested.filter((url) => url.endsWith('.map')).length;
    const look = (url: string): ReturnType<typeof fetchSourceMap> =>
      scope.lookup(url, pinned({ fetchImpl: server.fetchImpl }));

    expect(await sourcesOf(look(CHUNK_ONE))).toEqual(['src/one.ts']);
    await look(CHUNK_TWO);
    await look(CHUNK_THREE); // evicts CHUNK_ONE's map, the least recently written
    expect(mapsFetched()).toBe(3);

    await look(CHUNK_THREE);
    expect(mapsFetched(), 'kept').toBe(3);
    expect(await sourcesOf(look(CHUNK_ONE))).toEqual(['src/one.ts']);
    expect(mapsFetched(), 'dropped, so read again').toBe(4);
  });

  it('hands one scope per key while used, and retires the least recent and the idle', () => {
    let now = BASE_TIME;
    const scopes = createSourceMapScopes({ maxScopes: 2, now: () => now });

    const one = scopes.scopeFor('document-one');
    expect(scopes.scopeFor('document-one')).toBe(one);
    expect(scopes.scopeFor('document-two')).not.toBe(one);

    scopes.scopeFor('document-three'); // evicts document-one, the least recently used
    expect(scopes.scopeFor('document-one')).not.toBe(one);

    const three = scopes.scopeFor('document-three');
    now += SOURCE_MAP_SCOPE_IDLE_MS - 1;
    expect(scopes.scopeFor('document-three')).toBe(three);
    now += SOURCE_MAP_SCOPE_IDLE_MS;
    expect(scopes.scopeFor('document-three'), 'idle for the whole period').not.toBe(three);
  });

  it('is what the resolver hands resolveStack when injected, and nothing when not', async () => {
    const batch = createSourceMapScopes({
      fetchSourceMapImpl: countingLookup(),
      now: () => BASE_TIME,
    })
      .scopeFor('document-one')
      .forBatch();
    const resolveStackImpl = stackResolver([mapped(PROJECT.component.file)]);
    const resolver = resolverFor(standardProject(), {
      resolveStackImpl,
      devServerOrigin: DEV_ORIGIN,
      sourceMapLookup: batch,
    });

    await resolver.resolveEvent(
      makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }),
    );

    const [, options] = resolveStackImpl.mock.calls[0] ?? [];
    expect(options?.fetchSourceMapImpl).toBe(batch);

    const unscoped = stackResolver([]);
    await resolverFor(standardProject(), {
      resolveStackImpl: unscoped,
      devServerOrigin: DEV_ORIGIN,
    }).resolveEvent(makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } }));
    expect(unscoped.mock.calls[0]?.[1]).not.toHaveProperty('fetchSourceMapImpl');
  });

  it('spares the real stack resolver a second read of a chunk within one batch', async () => {
    const lookup = countingLookup();
    const scope = createSourceMapScopes({
      fetchSourceMapImpl: lookup,
      now: () => BASE_TIME,
    }).scopeFor('document-one');
    const initiated = (): TelemetryEvent =>
      makeEvent({ kind: KIND.fetch, attributes: { [ATTR.initiator]: CHUNK_STACK } });

    for (let batch = 0; batch < 2; batch += 1) {
      const located = await resolverFor(standardProject(), {
        devServerOrigin: DEV_ORIGIN,
        sourceMapLookup: scope.forBatch(),
      }).resolveEvents([initiated(), initiated(), initiated()]);
      expect(located.ok).toBe(true);
    }

    expect(lookup, 'one read per batch').toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]?.[0]).toBe(`${DEV_ORIGIN}/_next/static/chunks/app/gauges/page.js`);
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
    makeEvent({
      kind: KIND.dbQuery,
      attributes: {
        [ATTR.dbClient]: 'prisma',
        [ATTR.ormModel]: SENTINEL,
        [ATTR.ormMethod]: SENTINEL,
      },
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
            graph: graphOf(nodes, project.structure),
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
