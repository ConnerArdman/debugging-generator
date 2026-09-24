/**
 * Unit suite for `./code-tools.ts`, the closed, budgeted, read-only dispatch
 * layer between the code queries a model proposes and the query engine of
 * `@debuggen/code-analysis` (AAP §0.4.2, Stage 2: "model proposes queries,
 * deterministic code executes them; no repository dump").
 *
 * ## What is under test
 *
 * - **Vocabulary** — the eight tool names, their descriptors and the per-tool
 *   methods agree, and the membership predicate is total.
 * - **Dispatch** — every tool delegates to exactly one `CodeQueries` method,
 *   once, with clamped arguments, and passes the engine's answer through
 *   unchanged (no re-derived route paths, no re-stamped source locations).
 * - **Malformed model output is data** — every refusal is an `Err` carrying a
 *   `CodeToolRejection` whose code is a member of `DEBUGGEN_ERROR_CODES`; no
 *   input makes a call throw or reach the engine.
 * - **Budgets** — per stage, per tool and per stage for excerpts, plus the
 *   result-count, serialized-size and excerpt caps, and the documented
 *   accounting rule (a slot is consumed only by a delegated call).
 * - **Privacy and read-only guarantees** (AAP §0.5.2, §0.5.3) — unsafe and
 *   environment-file paths never reach the engine, rejections and log records
 *   never repeat an argument value, and the module's own source imports no
 *   I/O capability.
 * - **Determinism, serialisability, the catalog text, cancellation and batch
 *   semantics.**
 * - **Real wiring** — one block drives the tools through the real
 *   `createCodeQueries` over an in-memory `CodeIndex`, which is the
 *   compatibility guard for the real `CodeQueries` signatures.
 *
 * ## Test data
 *
 * Hand-built stubs typed against the real `CodeQueries`, `RouteMap`,
 * `ProjectSummary` and `PipelineCodeHandles` declarations, and a small
 * hand-authored `CodeIndex` read through the real `CodeGraph.fromIndex`. Every
 * name is a neutral placeholder (`Alpha`, `Beta`, `loadDelta`, `/gamma/...`):
 * no application's identifiers appear here (AAP §0.5.4). Apart from reading
 * `code-tools.ts` itself for the static self-scan, the suite touches no
 * filesystem, opens no socket and reads no environment variable.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_QUERY_LIMITS,
  CodeGraph,
  createCodeQueries,
  makeEdgeId,
  makeNodeId,
  routeMapFromIndex,
} from '@debuggen/code-analysis';
import type {
  CallerRef,
  CodeEdge,
  CodeEdgeKind,
  CodeExcerpt,
  CodeIndex,
  CodeMatch,
  CodeNode,
  CodeNodeKind,
  CodeNodeOf,
  CodePath,
  CodeQueries,
  CodeQueryLimits,
  CodeSymbolMatch,
  ComponentRef,
  HandlerRef,
  LoadedProject,
  ProjectSummary,
  RouteEntry,
  RouteMap,
  RouteQueryResult,
} from '@debuggen/code-analysis';
import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  createConsoleLogger,
  parseSourceLocation,
} from '@debuggen/shared';
import type { LogRecord, Logger, SourceLocation } from '@debuggen/shared';

import type { PipelineCodeHandles } from '../context-builder.js';
import {
  CODE_TOOL_DESCRIPTORS,
  CODE_TOOL_LIMITS,
  CODE_TOOL_NAMES,
  CODE_TOOL_REJECTION_CODES,
  createCodeTools,
  describeCodeTools,
  isCodeToolName,
  parseCodeToolRequest,
  resolveCodeToolLimits,
} from './code-tools.js';
import type {
  CodeQueryMethodName,
  CodeToolArguments,
  CodeToolLimits,
  CodeToolName,
  CodeToolOutcome,
  CodeToolRejection,
  CodeToolRequestFor,
  CodeToolResult,
  CodeToolResultFor,
  CodeToolRun,
  CodeTools,
  CodeToolsOptions,
} from './code-tools.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------------------------------
 * Vocabulary constants of this suite
 * ---------------------------------------------------------------------------------------------- */

/** The eight documented tool names, in catalog order. */
const DOCUMENTED_TOOL_NAMES = [
  'findByName',
  'findSymbol',
  'whoCalls',
  'routeForUrl',
  'handlersFor',
  'componentsRendering',
  'pathBetween',
  'excerpt',
] as const;

/** Every `CodeQueries` method, as a runtime list; checked for completeness below. */
const QUERY_METHOD_NAMES = Object.freeze([
  'findByName',
  'findSymbol',
  'hasSymbol',
  'whoCalls',
  'routeForUrl',
  'handlersFor',
  'componentsRendering',
  'pathBetween',
  'excerpt',
] as const satisfies readonly CodeQueryMethodName[]);

/** Compiles only when {@link QUERY_METHOD_NAMES} lists every `CodeQueries` method. */
type EveryQueryMethodListed = [CodeQueryMethodName] extends [(typeof QUERY_METHOD_NAMES)[number]]
  ? true
  : never;
const EVERY_QUERY_METHOD_LISTED: EveryQueryMethodListed = true;

/** The rejection codes this module can report, as a set of values. */
const REJECTION_CODE_VALUES: readonly string[] = Object.values(CODE_TOOL_REJECTION_CODES);

/** The rejection codes a malformed or unsafe *argument* is reported with. */
const ARGUMENT_REJECTION_CODES: readonly string[] = [
  CODE_TOOL_REJECTION_CODES.malformed,
  CODE_TOOL_REJECTION_CODES.path,
];

/**
 * Which query-engine ceilings bound which stage limit, as `code-tools.ts`
 * documents on `resolveCodeToolLimits`. Stage-only keys have no entry.
 */
const ENGINE_CEILINGS: Readonly<
  Partial<Record<keyof CodeToolLimits, readonly (keyof CodeQueryLimits)[]>>
> = Object.freeze({
  maxResultsPerCall: ['maxResults', 'maxCallers'],
  maxExcerptLines: ['maxExcerptLines'],
  maxExcerptChars: ['maxExcerptChars'],
  maxPathDepth: ['maxPathDepth'],
  maxArgumentLength: ['maxNameLength'],
  maxUrlLength: ['maxUrlLength'],
});

/** Every stage-limit key, read from the defaults so a new key is covered automatically. */
const LIMIT_KEYS = Object.keys(CODE_TOOL_LIMITS) as readonly (keyof CodeToolLimits)[];

/**
 * The context lines the tools ask the engine for when a request names none:
 * the engine's documented default of three, lowered when the line cap cannot
 * hold it on both sides of the anchor.
 *
 * @param limits The effective limits.
 * @returns The default context-line count.
 */
function defaultContextLines(limits: CodeToolLimits): number {
  return Math.min(3, Math.floor((limits.maxExcerptLines - 1) / 2));
}

/* -------------------------------------------------------------------------------------------------
 * Canned engine payloads
 * ---------------------------------------------------------------------------------------------- */

/** The project-relative file every stub payload points at. */
const STUB_FILE = 'src/alpha.ts';

/** A second project-relative file, for payloads that must differ from the first. */
const STUB_ROUTE_FILE = 'app/omega/[slot]/route.ts';

/**
 * A valid `SourceLocation` in {@link STUB_FILE}.
 *
 * @param line The 1-based line.
 * @param overrides The fields a case varies.
 * @returns The location.
 */
function stubLocation(
  line: number,
  overrides: Partial<Pick<SourceLocation, 'file' | 'symbol' | 'resolvedBy' | 'confidence'>> = {},
): SourceLocation {
  return {
    file: STUB_FILE,
    line,
    column: 1,
    resolvedBy: 'code-graph',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    ...overrides,
  };
}

/**
 * A `CodeMatch` for a symbol node in {@link STUB_FILE}.
 *
 * @param name The node's name.
 * @param line The 1-based line it sits on.
 * @param overrides The fields a case varies.
 * @returns The match.
 */
function stubMatch(name: string, line = 1, overrides: Partial<CodeMatch> = {}): CodeMatch {
  return {
    nodeId: makeNodeId({ kind: 'symbol', file: STUB_FILE, name, line, column: 1 }),
    kind: 'symbol',
    name,
    file: STUB_FILE,
    location: stubLocation(line, { symbol: name }),
    score: 1,
    ...overrides,
  };
}

/** @returns The declaration `findSymbol` answers for `(STUB_FILE, 'alpha')`. */
function stubSymbolMatch(): CodeSymbolMatch {
  return { ...stubMatch('alpha', 2), symbol: 'alpha', exported: true };
}

/** @returns One call site of `alpha`. */
function stubCaller(): CallerRef {
  return { caller: stubMatch('caller', 10), via: 'edge', location: stubLocation(12) };
}

/**
 * A route answer whose route path no URL of this suite would derive: the
 * pass-through proof that the tools never compute a route themselves.
 *
 * @returns The route query result.
 */
function stubRouteResult(): RouteQueryResult {
  const location: SourceLocation = {
    file: STUB_ROUTE_FILE,
    line: 4,
    column: 1,
    symbol: 'GET',
    resolvedBy: 'route-map',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
  };
  const entry: RouteEntry = {
    routePath: '/omega/[slot]',
    router: 'app',
    kind: 'route-handler',
    file: STUB_ROUTE_FILE,
    segments: [
      { raw: 'omega', kind: 'static' },
      { raw: '[slot]', kind: 'dynamic', param: 'slot' },
    ],
    dynamicParams: ['slot'],
    isCatchAll: false,
    isOptionalCatchAll: false,
    methods: ['GET'],
    location,
  };
  return {
    match: { entry, params: { slot: '7' }, pathname: '/omega/7' },
    routePath: entry.routePath,
    router: entry.router,
    kind: entry.kind,
    methods: entry.methods,
    params: { slot: '7' },
    file: entry.file,
    location,
  };
}

/** @returns One handler of the stub route. */
function stubHandler(): HandlerRef {
  return {
    method: 'GET',
    symbol: 'GET',
    location: stubLocation(4, { file: STUB_ROUTE_FILE, symbol: 'GET' }),
  };
}

/** @returns One rendering parent. */
function stubComponentRef(): ComponentRef {
  return { component: stubMatch('Beta', 5, { kind: 'component' }), location: stubLocation(9) };
}

/** @returns A one-hop path between two stub matches. */
function stubPath(): CodePath {
  const from = stubMatch('alpha', 2);
  const to = stubMatch('beta', 20);
  return {
    nodes: [from, to],
    edges: [
      {
        kind: 'calls',
        from: from.nodeId,
        to: to.nodeId,
        traversedAgainstDirection: false,
        location: stubLocation(3),
      },
    ],
    depth: 1,
    undirected: false,
    truncated: false,
  };
}

/**
 * An excerpt of `lineCount` short, numbered lines.
 *
 * @param lineCount How many lines the text holds.
 * @param lineText The text of each line, before its number.
 * @returns The excerpt.
 */
function stubExcerpt(lineCount = 3, lineText = 'line'): CodeExcerpt {
  const lines = Array.from({ length: lineCount }, (_, index) => `${lineText} ${String(index + 1)}`);
  return {
    file: STUB_FILE,
    startLine: 1,
    endLine: lineCount,
    text: lines.join('\n'),
    truncated: false,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The in-memory code graph
 * ---------------------------------------------------------------------------------------------- */

/** The absolute root every synthetic index declares; it never reaches the catalog. */
const SYNTHETIC_ROOT = '/workspace/synthetic';

/** What a case varies about one built node. */
interface NodeSpec<K extends CodeNodeKind> {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly column?: number;
  readonly exported?: boolean;
  readonly data: CodeNodeOf<K>['data'];
}

/**
 * Builds one node with its id derived through the real `makeNodeId`.
 *
 * The one assertion is the narrow one `packages/code-analysis`'s own suites
 * make: the literal carries every field of the kind it names, but the compiler
 * cannot prove an object whose `kind` is the type parameter `K` inhabits
 * `CodeNodeOf<K>` while `K` is still generic.
 *
 * @param kind The node's kind.
 * @param spec Its name, position, payload and export status.
 * @returns The node.
 */
function graphNode<K extends CodeNodeKind>(kind: K, spec: NodeSpec<K>): CodeNodeOf<K> {
  const column = spec.column ?? 1;
  const base = {
    id: makeNodeId({ kind, file: spec.file, name: spec.name, line: spec.line, column }),
    kind,
    name: spec.name,
    file: spec.file,
    line: spec.line,
    column,
    data: spec.data,
  } as CodeNodeOf<K>;
  return spec.exported === undefined ? base : { ...base, exported: spec.exported };
}

/**
 * Builds one edge with its id derived through the real `makeEdgeId`.
 *
 * @param kind The relationship.
 * @param from The node it starts at.
 * @param to The node it points at.
 * @param site The edge site in `from`'s file, when the relationship has one.
 * @returns The edge.
 */
function graphEdge(
  kind: CodeEdgeKind,
  from: CodeNode,
  to: CodeNode,
  site?: { readonly line: number; readonly column: number },
): CodeEdge {
  if (site === undefined) {
    return { id: makeEdgeId({ kind, from: from.id, to: to.id }), kind, from: from.id, to: to.id };
  }
  return {
    id: makeEdgeId({ kind, from: from.id, to: to.id, line: site.line, column: site.column }),
    kind,
    from: from.id,
    to: to.id,
    file: from.file,
    line: site.line,
    column: site.column,
  };
}

/** The nodes of the synthetic project, by role. */
interface SyntheticNodes {
  readonly alpha: CodeNodeOf<'component'>;
  readonly beta: CodeNodeOf<'component'>;
  readonly route: CodeNodeOf<'api-route'>;
  readonly handler: CodeNodeOf<'symbol'>;
  readonly loader: CodeNodeOf<'server-function'>;
}

/** The file the synthetic route module lives in. */
const SYNTHETIC_ROUTE_FILE = 'app/gamma/[slot]/route.ts';

/** The file the synthetic server function lives in. */
const SYNTHETIC_SERVER_FILE = 'src/server/delta.ts';

/**
 * The nodes of a tiny synthetic project: a component `Beta` rendering a
 * component `Alpha`, a route module answering `/gamma/[slot]` whose `GET`
 * handler calls the server function `loadDelta`.
 *
 * @returns Fresh nodes.
 */
function syntheticNodes(): SyntheticNodes {
  return {
    alpha: graphNode('component', {
      file: 'src/widgets/Alpha.tsx',
      name: 'Alpha',
      line: 3,
      exported: true,
      data: { isClient: true, isDefaultExport: false, displayName: 'Alpha' },
    }),
    beta: graphNode('component', {
      file: 'src/widgets/Beta.tsx',
      name: 'Beta',
      line: 5,
      exported: true,
      data: { isClient: true, isDefaultExport: false, displayName: 'Beta' },
    }),
    route: graphNode('api-route', {
      file: SYNTHETIC_ROUTE_FILE,
      name: 'GET',
      line: 4,
      data: { routePath: '/gamma/[slot]', router: 'app', kind: 'route-handler', methods: ['GET'] },
    }),
    handler: graphNode('symbol', {
      file: SYNTHETIC_ROUTE_FILE,
      name: 'GET',
      line: 4,
      exported: true,
      data: { declaration: 'function', isDefaultExport: false },
    }),
    loader: graphNode('server-function', {
      file: SYNTHETIC_SERVER_FILE,
      name: 'loadDelta',
      line: 7,
      exported: true,
      data: { isAsync: true, exported: true },
    }),
  };
}

/**
 * The default edges of the synthetic project.
 *
 * @param nodes The nodes they connect.
 * @returns The edges.
 */
function syntheticEdges(nodes: SyntheticNodes): readonly CodeEdge[] {
  return [
    graphEdge('renders', nodes.beta, nodes.alpha, { line: 9, column: 7 }),
    graphEdge('routes-to', nodes.route, nodes.handler),
    graphEdge('calls', nodes.handler, nodes.loader, { line: 6, column: 10 }),
  ];
}

/**
 * A `CodeIndex` over the synthetic project, with its edges replaceable so a
 * case can vary one relationship.
 *
 * @param edges Builds the edges from the nodes; the defaults when absent.
 * @returns The index and its nodes.
 */
function syntheticIndex(edges: (nodes: SyntheticNodes) => readonly CodeEdge[] = syntheticEdges): {
  readonly index: CodeIndex;
  readonly nodes: SyntheticNodes;
} {
  const nodes = syntheticNodes();
  const index: CodeIndex = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: SYNTHETIC_ROOT,
    indexerVersion: 'test',
    generatedAt: 0,
    nodes: [nodes.alpha, nodes.beta, nodes.route, nodes.handler, nodes.loader],
    edges: edges(nodes),
    files: [],
  };
  return { index, nodes };
}

/* -------------------------------------------------------------------------------------------------
 * The harness: typed stubs for every injected handle
 * ---------------------------------------------------------------------------------------------- */

/** One `vi.fn` per `CodeQueries` method, typed against the real signature. */
type QueryMocks = { readonly [K in CodeQueryMethodName]: Mock<CodeQueries[K]> };

/**
 * The stand-in for a loaded ts-morph project. The tools only ever test whether
 * `handles.loaded` is present — source text is read by the engine, which the
 * stubs replace — so a frozen marker object is enough, and constructing a real
 * `Project` would pull the compiler into a unit suite for nothing.
 */
const LOADED_PROJECT: LoadedProject = Object.freeze({
  projectRoot: SYNTHETIC_ROOT,
  tsConfigFilePath: undefined,
}) as unknown as LoadedProject;

/** A complete, minimal project summary; the tools never read it. */
function stubProjectSummary(): ProjectSummary {
  return {
    projectRoot: SYNTHETIC_ROOT,
    projectName: 'synthetic',
    framework: { name: 'next' },
    routerStyle: 'app',
    typescript: { enabled: true },
    packageManager: 'pnpm',
    databaseAccess: { style: 'none', callSiteCount: 0 },
    entryPoints: [],
    routes: [],
    notableDirectories: [],
    dependencies: [],
    counts: {
      files: 0,
      symbols: 0,
      components: 0,
      handlers: 0,
      apiCalls: 0,
      apiRoutes: 0,
      serverFunctions: 0,
      dbCalls: 0,
    },
    truncated: false,
    generatedAt: 0,
  };
}

/** @returns Fresh query mocks answering with the canned payloads above. */
function defaultQueryMocks(): QueryMocks {
  return {
    findByName: vi.fn<CodeQueries['findByName']>(() => [stubMatch('alpha')]),
    findSymbol: vi.fn<CodeQueries['findSymbol']>((file, symbol) =>
      file === STUB_FILE && symbol === 'alpha' ? stubSymbolMatch() : undefined,
    ),
    hasSymbol: vi.fn<CodeQueries['hasSymbol']>(() => false),
    whoCalls: vi.fn<CodeQueries['whoCalls']>(() => [stubCaller()]),
    routeForUrl: vi.fn<CodeQueries['routeForUrl']>(() => stubRouteResult()),
    handlersFor: vi.fn<CodeQueries['handlersFor']>(() => [stubHandler()]),
    componentsRendering: vi.fn<CodeQueries['componentsRendering']>(() => [stubComponentRef()]),
    pathBetween: vi.fn<CodeQueries['pathBetween']>(() => stubPath()),
    excerpt: vi.fn<CodeQueries['excerpt']>(() => stubExcerpt()),
  };
}

/** What a case varies about the harness. */
interface HarnessOptions {
  /** Query mocks replacing the defaults. */
  readonly mocks?: Partial<QueryMocks>;
  /** Whether a loaded project is present, which `excerpt` requires. */
  readonly loaded?: boolean;
  /** The limits the stub engine reports. */
  readonly engineLimits?: CodeQueryLimits;
}

/** The handles and every spy behind them. */
interface Harness {
  readonly handles: PipelineCodeHandles;
  readonly mocks: QueryMocks;
  /** The route map's resolver, which the tools must never call. */
  readonly resolveRoute: Mock<RouteMap['resolve']>;
  /** Calls made to any query method so far. */
  readonly totalQueryCalls: () => number;
}

/**
 * Builds fresh handles: stubbed queries, a stubbed route map, a minimal
 * summary and a real `CodeGraph` over the synthetic index.
 *
 * @param options What the case varies.
 * @returns The harness.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const mocks: QueryMocks = { ...defaultQueryMocks(), ...options.mocks };
  const resolveRoute = vi.fn<RouteMap['resolve']>(() => undefined);
  const queries: CodeQueries = { limits: options.engineLimits ?? CODE_QUERY_LIMITS, ...mocks };
  const routeMap: RouteMap = { entries: Object.freeze([]), resolve: resolveRoute };
  const handles: PipelineCodeHandles = {
    graph: CodeGraph.fromIndex(syntheticIndex().index),
    queries,
    routeMap,
    projectSummary: stubProjectSummary(),
    ...(options.loaded === true ? { loaded: LOADED_PROJECT } : {}),
  };
  return {
    handles,
    mocks,
    resolveRoute,
    totalQueryCalls: () =>
      QUERY_METHOD_NAMES.reduce((sum, method) => sum + mocks[method].mock.calls.length, 0),
  };
}

/**
 * Code tools over a harness.
 *
 * @param harness The handles.
 * @param options Everything else `createCodeTools` takes.
 * @returns The tools.
 */
function toolsFor(harness: Harness, options: Omit<CodeToolsOptions, 'handles'> = {}): CodeTools {
  return createCodeTools({ handles: harness.handles, ...options });
}

/* -------------------------------------------------------------------------------------------------
 * Requests and outcome helpers
 * ---------------------------------------------------------------------------------------------- */

/** One valid set of arguments per tool, answered by the default mocks. */
const VALID_ARGUMENTS: { readonly [N in CodeToolName]: CodeToolArguments<N> } = Object.freeze({
  findByName: Object.freeze({ name: 'alpha' }),
  findSymbol: Object.freeze({ file: STUB_FILE, symbol: 'alpha' }),
  whoCalls: Object.freeze({ symbol: 'alpha' }),
  routeForUrl: Object.freeze({ url: '/omega/7' }),
  handlersFor: Object.freeze({ url: '/omega/7' }),
  componentsRendering: Object.freeze({ component: 'Beta' }),
  pathBetween: Object.freeze({
    from: 'node-alpha',
    to: Object.freeze({ file: STUB_FILE, symbol: 'beta' }),
  }),
  excerpt: Object.freeze({ nodeId: 'node-alpha' }),
});

/** The same arguments as complete requests, as a model would send them. */
const VALID_REQUESTS: { readonly [N in CodeToolName]: CodeToolRequestFor<N> } = Object.freeze({
  findByName: Object.freeze({ tool: 'findByName', ...VALID_ARGUMENTS.findByName }),
  findSymbol: Object.freeze({ tool: 'findSymbol', ...VALID_ARGUMENTS.findSymbol }),
  whoCalls: Object.freeze({ tool: 'whoCalls', ...VALID_ARGUMENTS.whoCalls }),
  routeForUrl: Object.freeze({ tool: 'routeForUrl', ...VALID_ARGUMENTS.routeForUrl }),
  handlersFor: Object.freeze({ tool: 'handlersFor', ...VALID_ARGUMENTS.handlersFor }),
  componentsRendering: Object.freeze({
    tool: 'componentsRendering',
    ...VALID_ARGUMENTS.componentsRendering,
  }),
  pathBetween: Object.freeze({ tool: 'pathBetween', ...VALID_ARGUMENTS.pathBetween }),
  excerpt: Object.freeze({ tool: 'excerpt', ...VALID_ARGUMENTS.excerpt }),
});

/**
 * Calls the per-tool method of one tool with its valid arguments. The switch
 * lets the compiler check each call against that method's own argument type.
 *
 * @param tools The tools.
 * @param name The tool.
 * @returns The method's outcome, widened to the common outcome type.
 */
function runToolMethod(tools: CodeTools, name: CodeToolName): Promise<CodeToolOutcome> {
  switch (name) {
    case 'findByName':
      return tools.findByName(VALID_ARGUMENTS.findByName);
    case 'findSymbol':
      return tools.findSymbol(VALID_ARGUMENTS.findSymbol);
    case 'whoCalls':
      return tools.whoCalls(VALID_ARGUMENTS.whoCalls);
    case 'routeForUrl':
      return tools.routeForUrl(VALID_ARGUMENTS.routeForUrl);
    case 'handlersFor':
      return tools.handlersFor(VALID_ARGUMENTS.handlersFor);
    case 'componentsRendering':
      return tools.componentsRendering(VALID_ARGUMENTS.componentsRendering);
    case 'pathBetween':
      return tools.pathBetween(VALID_ARGUMENTS.pathBetween);
    case 'excerpt':
      return tools.excerpt(VALID_ARGUMENTS.excerpt);
  }
}

/**
 * The arguments each tool's valid request reaches the engine with under the
 * default limits: the request's own values plus the clamped defaults the tools
 * fill in.
 */
const EXPECTED_ENGINE_ARGUMENTS: { readonly [N in CodeToolName]: readonly unknown[] } =
  Object.freeze({
    findByName: ['alpha', { limit: CODE_TOOL_LIMITS.maxResultsPerCall }],
    findSymbol: [STUB_FILE, 'alpha'],
    whoCalls: ['alpha', { limit: CODE_TOOL_LIMITS.maxResultsPerCall }],
    routeForUrl: ['/omega/7'],
    handlersFor: ['/omega/7'],
    componentsRendering: ['Beta', { limit: CODE_TOOL_LIMITS.maxResultsPerCall }],
    pathBetween: [
      'node-alpha',
      { file: STUB_FILE, symbol: 'beta' },
      { maxDepth: CODE_TOOL_LIMITS.maxPathDepth },
    ],
    excerpt: [
      'node-alpha',
      {
        contextLines: defaultContextLines(CODE_TOOL_LIMITS),
        maxChars: CODE_TOOL_LIMITS.maxExcerptChars,
      },
    ],
  });

/**
 * Narrows a result to one tool's shape.
 *
 * @param result Any result.
 * @param tool The tool to test for.
 * @returns `true` when the result belongs to `tool`.
 */
function isResultOf<N extends CodeToolName>(
  result: CodeToolResult,
  tool: N,
): result is CodeToolResultFor<N> {
  return result.tool === tool;
}

/**
 * The result of an outcome that must be `Ok` for a given tool.
 *
 * @param outcome The outcome.
 * @param tool The tool that must have answered.
 * @returns The typed result.
 */
function expectResult<N extends CodeToolName>(
  outcome: CodeToolOutcome,
  tool: N,
): CodeToolResultFor<N> {
  if (!outcome.ok) {
    throw new Error(
      `Expected ${tool} to answer Ok, got ${outcome.error.code}: ${outcome.error.message}`,
    );
  }
  const result = outcome.value;
  if (!isResultOf(result, tool)) {
    throw new Error(`Expected a ${tool} result, got a ${result.tool} result`);
  }
  return result;
}

/**
 * The rejection of an outcome that must be `Err`, with its code checked
 * against `DEBUGGEN_ERROR_CODES` and this module's own code table.
 *
 * @param outcome The outcome, typed loosely so every entry point's result fits.
 * @returns The rejection.
 */
function expectRejection(
  outcome: { readonly ok: true } | { readonly ok: false; readonly error: CodeToolRejection },
): CodeToolRejection {
  if (outcome.ok) {
    throw new Error('Expected a rejection, got Ok');
  }
  const rejection = outcome.error;
  expect(DEBUGGEN_ERROR_CODES).toContain(rejection.code);
  expect(REJECTION_CODE_VALUES).toContain(rejection.code);
  expect(typeof rejection.message).toBe('string');
  expect(rejection.message.length).toBeGreaterThan(0);
  return rejection;
}

/**
 * The UTF-8 size of a value's compact JSON form, the rule the tools budget by.
 *
 * @param value Any JSON value.
 * @returns Its size in bytes.
 */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The outcome of one batch entry, which must exist.
 *
 * @param runs The batch.
 * @param index The entry's position.
 * @returns Its outcome.
 */
function outcomeAt(runs: readonly CodeToolRun[], index: number): CodeToolOutcome {
  const run = runs[index];
  if (run === undefined) {
    throw new Error(`Expected a batch entry at index ${String(index)}`);
  }
  return run.outcome;
}

/* -------------------------------------------------------------------------------------------------
 * A. Vocabulary integrity
 * ---------------------------------------------------------------------------------------------- */

describe('A. tool vocabulary', () => {
  it('lists exactly the eight documented tools, once each, in the documented order', () => {
    expect([...CODE_TOOL_NAMES]).toStrictEqual([...DOCUMENTED_TOOL_NAMES]);
    expect(new Set(CODE_TOOL_NAMES).size).toBe(CODE_TOOL_NAMES.length);
  });

  it('is frozen, so neither a write nor a push can change the catalog', () => {
    expect(Object.isFrozen(CODE_TOOL_NAMES)).toBe(true);
    expect(Reflect.set(CODE_TOOL_NAMES, 0, 'renamed')).toBe(false);
    expect(Reflect.set(CODE_TOOL_NAMES, CODE_TOOL_NAMES.length, 'extra')).toBe(false);
    expect([...CODE_TOOL_NAMES]).toStrictEqual([...DOCUMENTED_TOOL_NAMES]);
  });

  it('gives every tool a deep-frozen descriptor that delegates to a real query method', () => {
    const harness = makeHarness();
    expect(Object.keys(CODE_TOOL_DESCRIPTORS)).toStrictEqual([...CODE_TOOL_NAMES]);
    expect(Object.isFrozen(CODE_TOOL_DESCRIPTORS)).toBe(true);
    for (const name of CODE_TOOL_NAMES) {
      const descriptor = CODE_TOOL_DESCRIPTORS[name];
      expect(descriptor.name).toBe(name);
      expect(QUERY_METHOD_NAMES).toContain(descriptor.delegatesTo);
      expect(typeof harness.handles.queries[descriptor.delegatesTo]).toBe('function');
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.args)).toBe(true);
      expect(Object.isFrozen(descriptor.budgetKeys)).toBe(true);
      for (const arg of descriptor.args) {
        expect(Object.isFrozen(arg)).toBe(true);
        if (arg.allowed !== undefined) {
          expect(Object.isFrozen(arg.allowed)).toBe(true);
        }
      }
      for (const key of descriptor.budgetKeys) {
        expect(LIMIT_KEYS).toContain(key);
      }
    }
  });

  it('gives every tool a method on the created tools, and the tools object is frozen', () => {
    const tools = toolsFor(makeHarness());
    expect(Object.isFrozen(tools)).toBe(true);
    for (const name of CODE_TOOL_NAMES) {
      expect(typeof tools[name]).toBe('function');
    }
  });

  it('lists every CodeQueries method in this suite (compile-time completeness check)', () => {
    expect(EVERY_QUERY_METHOD_LISTED).toBe(true);
    expect(new Set(QUERY_METHOD_NAMES).size).toBe(QUERY_METHOD_NAMES.length);
  });

  it.each(CODE_TOOL_NAMES.map((name) => [name]))('isCodeToolName accepts %s', (name) => {
    expect(isCodeToolName(name)).toBe(true);
  });

  const NOT_TOOL_NAMES: readonly (readonly [string, unknown])[] = [
    ['a different case', 'FindByName'],
    ['an upper-cased name', 'EXCERPT'],
    ['a trailing space', 'whoCalls '],
    ['a leading space', ' whoCalls'],
    ['a partial name', 'findBy'],
    ['a longer name', 'excerpts'],
    ['the empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['an object', {}],
    ['an array', []],
    ['an array holding a name', ['findByName']],
    ['a symbol', Symbol('findByName')],
    ['a boxed string', Object('findByName')],
    ['a function', () => 'findByName'],
  ];

  it.each(NOT_TOOL_NAMES)('isCodeToolName rejects %s without throwing', (_label, value) => {
    expect(() => isCodeToolName(value)).not.toThrow();
    expect(isCodeToolName(value)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * B. Dispatch and delegation
 * ---------------------------------------------------------------------------------------------- */

describe('B. dispatch and delegation', () => {
  it.each(CODE_TOOL_NAMES.map((name) => [name]))(
    '%s calls exactly its own query method, once, with the expected arguments',
    async (name) => {
      const harness = makeHarness({ loaded: true });
      const tools = toolsFor(harness);

      const result = expectResult(await tools.runCodeTool(VALID_REQUESTS[name]), name);

      expect(result.tool).toBe(name);
      expect(result.found).toBe(true);
      const delegate = CODE_TOOL_DESCRIPTORS[name].delegatesTo;
      expect(harness.mocks[delegate]).toHaveBeenCalledTimes(1);
      expect(harness.mocks[delegate]).toHaveBeenCalledWith(...EXPECTED_ENGINE_ARGUMENTS[name]);
      for (const method of QUERY_METHOD_NAMES) {
        if (method !== delegate) {
          expect(harness.mocks[method]).not.toHaveBeenCalled();
        }
      }
      expect(harness.resolveRoute).not.toHaveBeenCalled();
    },
  );

  it('each per-tool method runs the same pipeline as runCodeTool', async () => {
    for (const name of CODE_TOOL_NAMES) {
      const viaMethod = makeHarness({ loaded: true });
      const viaBoundary = makeHarness({ loaded: true });
      const methodOutcome = await runToolMethod(toolsFor(viaMethod), name);
      const boundaryOutcome = await toolsFor(viaBoundary).runCodeTool(VALID_REQUESTS[name]);
      expect(methodOutcome).toStrictEqual(boundaryOutcome);
      expect(viaMethod.totalQueryCalls()).toBe(1);
    }
  });

  it('a stray tool key among per-tool arguments cannot redirect the call', async () => {
    const harness = makeHarness({ loaded: true });
    const args = { name: 'alpha', tool: 'excerpt' };
    const result = expectResult(await toolsFor(harness).findByName(args), 'findByName');
    expect(result.request).toStrictEqual({ tool: 'findByName', name: 'alpha' });
    expect(harness.mocks.findByName).toHaveBeenCalledTimes(1);
    expect(harness.mocks.excerpt).not.toHaveBeenCalled();
  });

  it('clamps result-count arguments before they reach the engine and reports the clamp', async () => {
    const cases = [
      { tool: 'findByName', name: 'alpha', limit: 10_000 },
      { tool: 'whoCalls', symbol: 'alpha', limit: 10_000 },
      { tool: 'componentsRendering', component: 'Beta', limit: 10_000 },
    ] as const;
    for (const request of cases) {
      const harness = makeHarness();
      const outcome = await toolsFor(harness, { limits: { maxResultsPerCall: 4 } }).runCodeTool(
        request,
      );
      const result = expectResult(outcome, request.tool);
      expect(result.clamped).toStrictEqual(['limit']);
      expect(result.request).toMatchObject({ limit: 4 });
      const delegate = harness.mocks[CODE_TOOL_DESCRIPTORS[request.tool].delegatesTo];
      expect(delegate).toHaveBeenCalledWith(expect.anything(), { limit: 4 });
    }
  });

  it('clamps maxDepth into maxPathDepth before it reaches the engine and reports the clamp', async () => {
    const harness = makeHarness();
    const request = { ...VALID_REQUESTS.pathBetween, maxDepth: 999 };
    const result = expectResult(await toolsFor(harness).runCodeTool(request), 'pathBetween');
    expect(result.clamped).toStrictEqual(['maxDepth']);
    expect(result.request.maxDepth).toBe(CODE_TOOL_LIMITS.maxPathDepth);
    expect(harness.mocks.pathBetween).toHaveBeenCalledWith(
      VALID_REQUESTS.pathBetween.from,
      VALID_REQUESTS.pathBetween.to,
      { maxDepth: CODE_TOOL_LIMITS.maxPathDepth },
    );
  });

  it('clamps excerpt context and end line so the window fits maxExcerptLines', async () => {
    const harness = makeHarness({ loaded: true });
    const tools = toolsFor(harness);

    const byNode = expectResult(
      await tools.runCodeTool({ tool: 'excerpt', nodeId: 'node-alpha', contextLines: 999 }),
      'excerpt',
    );
    const maxContext = Math.floor((CODE_TOOL_LIMITS.maxExcerptLines - 1) / 2);
    expect(byNode.clamped).toStrictEqual(['contextLines']);
    expect(harness.mocks.excerpt).toHaveBeenLastCalledWith('node-alpha', {
      contextLines: maxContext,
      maxChars: CODE_TOOL_LIMITS.maxExcerptChars,
    });

    const byFile = expectResult(
      await tools.runCodeTool({ tool: 'excerpt', file: STUB_FILE, line: 10, endLine: 5_000 }),
      'excerpt',
    );
    expect(byFile.clamped).toStrictEqual(['endLine']);
    const endLine = byFile.request.endLine ?? Number.NaN;
    expect(endLine).toBeGreaterThanOrEqual(10);
    expect(endLine - 10 + 1).toBeLessThanOrEqual(CODE_TOOL_LIMITS.maxExcerptLines);
    expect(harness.mocks.excerpt).toHaveBeenLastCalledWith(
      { file: STUB_FILE, line: 10, endLine },
      {
        contextLines: defaultContextLines(CODE_TOOL_LIMITS),
        maxChars: CODE_TOOL_LIMITS.maxExcerptChars,
      },
    );
  });

  it('hands the engine line 1 for a file excerpt that names no line', async () => {
    const harness = makeHarness({ loaded: true });
    expectResult(
      await toolsFor(harness).runCodeTool({ tool: 'excerpt', file: STUB_FILE }),
      'excerpt',
    );
    expect(harness.mocks.excerpt).toHaveBeenCalledWith(
      { file: STUB_FILE, line: 1 },
      expect.objectContaining({ maxChars: CODE_TOOL_LIMITS.maxExcerptChars }),
    );
  });

  it('passes the engine route answer through unchanged and never derives a route itself', async () => {
    const sentinel = stubRouteResult();
    const harness = makeHarness({
      mocks: { routeForUrl: vi.fn<CodeQueries['routeForUrl']>(() => sentinel) },
    });
    // The request URL names a path the sentinel does not: any route derived by
    // the tools from the URL would disagree with the engine's answer.
    const result = expectResult(
      await toolsFor(harness).runCodeTool({ tool: 'routeForUrl', url: '/unrelated/path' }),
      'routeForUrl',
    );
    expect(result.payload).toBe(sentinel);
    expect(result.payload?.routePath).toBe('/omega/[slot]');
    expect(harness.mocks.routeForUrl).toHaveBeenCalledWith('/unrelated/path');
    expect(harness.resolveRoute).not.toHaveBeenCalled();
  });

  it('passes handler, component and path answers through by reference', async () => {
    const handler = stubHandler();
    const parent = stubComponentRef();
    const path = stubPath();
    const harness = makeHarness({
      mocks: {
        handlersFor: vi.fn<CodeQueries['handlersFor']>(() => [handler]),
        componentsRendering: vi.fn<CodeQueries['componentsRendering']>(() => [parent]),
        pathBetween: vi.fn<CodeQueries['pathBetween']>(() => path),
      },
    });
    const tools = toolsFor(harness);

    const handlers = expectResult(
      await tools.runCodeTool(VALID_REQUESTS.handlersFor),
      'handlersFor',
    );
    expect(handlers.payload).toHaveLength(1);
    expect(handlers.payload[0]).toBe(handler);

    const parents = expectResult(
      await tools.runCodeTool(VALID_REQUESTS.componentsRendering),
      'componentsRendering',
    );
    expect(parents.payload[0]).toBe(parent);

    const found = expectResult(await tools.runCodeTool(VALID_REQUESTS.pathBetween), 'pathBetween');
    expect(found.payload).toBe(path);
  });

  it('forwards a handlersFor method filter, normalised to the upstream vocabulary', async () => {
    const harness = makeHarness();
    const result = expectResult(
      await toolsFor(harness).runCodeTool({
        tool: 'handlersFor',
        url: '/omega/7',
        method: ' post ',
      }),
      'handlersFor',
    );
    expect(result.request.method).toBe('POST');
    expect(harness.mocks.handlersFor).toHaveBeenCalledWith('/omega/7', { method: 'POST' });
  });

  it('keeps every SourceLocation the engine produced byte for byte', async () => {
    const unusual = stubLocation(42, { resolvedBy: 'source-map', confidence: 0.125 });
    const harness = makeHarness({
      loaded: true,
      mocks: {
        findByName: vi.fn<CodeQueries['findByName']>(() => [
          stubMatch('alpha', 42, { location: unusual }),
        ]),
      },
    });
    const tools = toolsFor(harness);
    const locations: SourceLocation[] = [];

    const matches = expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    locations.push(...matches.payload.map((match) => match.location));
    const route = expectResult(await tools.runCodeTool(VALID_REQUESTS.routeForUrl), 'routeForUrl');
    locations.push(route.payload?.location ?? unusual);
    const callers = expectResult(await tools.runCodeTool(VALID_REQUESTS.whoCalls), 'whoCalls');
    locations.push(
      ...callers.payload.flatMap((caller) => [caller.location, caller.caller.location]),
    );

    expect(matches.payload[0]?.location).toBe(unusual);
    expect(route.payload?.location).toStrictEqual(stubRouteResult().location);
    for (const location of locations) {
      expect(parseSourceLocation(location).ok).toBe(true);
    }
    const first = matches.payload[0]?.location;
    expect(first?.resolvedBy).toBe('source-map');
    expect(first?.confidence).toBe(0.125);
    expect(route.payload?.location.resolvedBy).toBe('route-map');
    expect(route.payload?.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
  });

  it('hasSymbol agrees with findSymbol for a present and an absent symbol', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness);
    const present = { file: STUB_FILE, symbol: 'alpha' };
    const absent = { file: STUB_FILE, symbol: 'missing' };

    const presentAnswer = await tools.hasSymbol(present);
    const presentLookup = expectResult(await tools.findSymbol(present), 'findSymbol');
    const absentAnswer = await tools.hasSymbol(absent);
    const absentLookup = expectResult(await tools.findSymbol(absent), 'findSymbol');

    expect(presentAnswer).toStrictEqual({ ok: true, value: true });
    expect(presentLookup.found).toBe(true);
    expect(presentLookup.payload?.symbol).toBe('alpha');
    expect(absentAnswer).toStrictEqual({ ok: true, value: false });
    expect(absentLookup.found).toBe(false);
    expect(absentLookup).not.toHaveProperty('payload');
    expect(harness.mocks.findSymbol).toHaveBeenCalledTimes(4);
    expect(harness.mocks.hasSymbol).not.toHaveBeenCalled();
  });

  it('hasSymbol refuses a malformed request exactly as findSymbol does', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness);
    const rejection = expectRejection(
      await tools.hasSymbol({ file: '../outside.ts', symbol: 'a' }),
    );
    expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.path);
    expect(harness.totalQueryCalls()).toBe(0);
  });

  it('reports an engine failure as an internal rejection instead of throwing', async () => {
    const harness = makeHarness({
      mocks: {
        whoCalls: vi.fn<CodeQueries['whoCalls']>(() => {
          throw new Error('engine exploded while reading sentinel-engine-detail');
        }),
      },
    });
    const tools = toolsFor(harness);
    const rejection = expectRejection(await tools.runCodeTool(VALID_REQUESTS.whoCalls));
    expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.internal);
    expect(rejection.tool).toBe('whoCalls');
    expect(JSON.stringify(rejection)).not.toContain('sentinel-engine-detail');
    // Documented: a delegated call consumes its slot even when the engine fails.
    expect(tools.budget().callsUsed).toBe(1);
    expect(tools.budget().callsRejected).toBe(0);
  });

  it('treats a non-list engine answer as an empty list', async () => {
    const harness = makeHarness({
      mocks: {
        findByName: vi.fn<CodeQueries['findByName']>(
          () => 'not a list' as unknown as readonly CodeMatch[],
        ),
      },
    });
    const result = expectResult(
      await toolsFor(harness).runCodeTool(VALID_REQUESTS.findByName),
      'findByName',
    );
    expect(result.payload).toStrictEqual([]);
    expect(result.found).toBe(false);
    expect(result.total).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * C. Malformed model output is data, never a throw
 * ---------------------------------------------------------------------------------------------- */

/** A name one character over the argument-length cap. */
const LONG_NAME = 'n'.repeat(CODE_TOOL_LIMITS.maxArgumentLength + 1);

/** A URL one character over the URL-length cap. */
const LONG_URL = `/${'u'.repeat(CODE_TOOL_LIMITS.maxUrlLength)}`;

/** A node id one character over the node-id cap. */
const LONG_NODE_ID = 'i'.repeat(CODE_TOOL_LIMITS.maxNodeIdLength + 1);

/**
 * Whole requests that are not a readable tool request at all. Each entry is a
 * factory so class instances and proxies are built fresh for every case.
 */
const WHOLE_REQUEST_CASES: readonly (readonly [string, () => unknown])[] = [
  ['null', () => null],
  ['undefined', () => undefined],
  ['a string', () => 'findByName'],
  ['a number', () => 7],
  ['a boolean', () => true],
  ['an array', () => [{ tool: 'findByName', name: 'alpha' }]],
  ['a function', () => () => ({ tool: 'findByName', name: 'alpha' })],
  [
    'a class instance',
    () =>
      new (class SyntheticRequest {
        readonly tool = 'findByName';
        readonly name = 'alpha';
      })(),
  ],
  [
    'a request inheriting its keys',
    (): unknown => Object.create({ tool: 'findByName', name: 'alpha' }) as unknown,
  ],
  ['a missing tool', () => ({ name: 'alpha' })],
  ['a null tool', () => ({ tool: null, name: 'alpha' })],
  ['an unknown tool', () => ({ tool: 'listFiles', path: '.' })],
  ['a tool of a different case', () => ({ tool: 'FindByName', name: 'alpha' })],
  ['a tool with a trailing space', () => ({ tool: 'findByName ', name: 'alpha' })],
  ['a partial tool name', () => ({ tool: 'find', name: 'alpha' })],
  ['a numeric tool', () => ({ tool: 3, name: 'alpha' })],
  ['an array tool', () => ({ tool: ['findByName'], name: 'alpha' })],
  ['an object tool', () => ({ tool: { name: 'findByName' }, name: 'alpha' })],
  [
    'a tool behind a getter',
    () =>
      Object.defineProperty({ name: 'alpha' }, 'tool', {
        enumerable: true,
        get: () => 'findByName',
      }),
  ],
  [
    'a __proto__ key smuggling the tool',
    (): unknown => JSON.parse('{"__proto__":{"tool":"findByName","name":"alpha"}}'),
  ],
  [
    'a proxy whose traps throw',
    () =>
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('trap');
          },
          ownKeys: () => {
            throw new Error('trap');
          },
        },
      ),
  ],
];

/** Requests naming a catalog tool whose arguments are missing, mistyped or out of range. */
const ARGUMENT_CASES: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['findByName without name', { tool: 'findByName' }],
  ['findByName with a numeric name', { tool: 'findByName', name: 7 }],
  ['findByName with an empty name', { tool: 'findByName', name: '' }],
  ['findByName with a whitespace-only name', { tool: 'findByName', name: ' \t\n ' }],
  ['findByName with an over-long name', { tool: 'findByName', name: LONG_NAME }],
  ['findByName with a NaN limit', { tool: 'findByName', name: 'alpha', limit: Number.NaN }],
  [
    'findByName with an infinite limit',
    { tool: 'findByName', name: 'alpha', limit: Number.POSITIVE_INFINITY },
  ],
  ['findByName with a negative limit', { tool: 'findByName', name: 'alpha', limit: -1 }],
  ['findByName with a fractional limit', { tool: 'findByName', name: 'alpha', limit: 2.5 }],
  ['findByName with a string limit', { tool: 'findByName', name: 'alpha', limit: '5' }],
  [
    'findByName with an unsafe integer limit',
    { tool: 'findByName', name: 'alpha', limit: Number.MAX_SAFE_INTEGER + 1 },
  ],
  ['findByName with a string exact', { tool: 'findByName', name: 'alpha', exact: 'yes' }],
  ['findByName with an unknown kind', { tool: 'findByName', name: 'alpha', kinds: ['bogus'] }],
  ['findByName with an empty kinds list', { tool: 'findByName', name: 'alpha', kinds: [] }],
  ['findByName with a numeric kinds', { tool: 'findByName', name: 'alpha', kinds: 3 }],
  [
    'findByName with too many kinds',
    { tool: 'findByName', name: 'alpha', kinds: Array.from({ length: 33 }, () => 'file') },
  ],
  ['findSymbol without file', { tool: 'findSymbol', symbol: 'alpha' }],
  ['findSymbol without symbol', { tool: 'findSymbol', file: STUB_FILE }],
  ['findSymbol with a numeric file', { tool: 'findSymbol', file: 3, symbol: 'alpha' }],
  ['findSymbol with an array symbol', { tool: 'findSymbol', file: STUB_FILE, symbol: ['alpha'] }],
  ['findSymbol with a whitespace-only file', { tool: 'findSymbol', file: '   ', symbol: 'alpha' }],
  [
    'findSymbol with an over-long file',
    { tool: 'findSymbol', file: `src/${LONG_NAME}.ts`, symbol: 'alpha' },
  ],
  ['whoCalls without symbol', { tool: 'whoCalls' }],
  ['whoCalls with an object symbol', { tool: 'whoCalls', symbol: { name: 'alpha' } }],
  [
    'whoCalls with a numeric useReferences',
    { tool: 'whoCalls', symbol: 'alpha', useReferences: 1 },
  ],
  ['whoCalls with a negative limit', { tool: 'whoCalls', symbol: 'alpha', limit: -3 }],
  ['routeForUrl without url', { tool: 'routeForUrl' }],
  ['routeForUrl with an object url', { tool: 'routeForUrl', url: {} }],
  ['routeForUrl with an empty url', { tool: 'routeForUrl', url: '' }],
  ['routeForUrl with an over-long url', { tool: 'routeForUrl', url: LONG_URL }],
  ['handlersFor without url', { tool: 'handlersFor', method: 'GET' }],
  ['handlersFor with an unknown method', { tool: 'handlersFor', url: '/omega/7', method: 'FETCH' }],
  ['handlersFor with a numeric method', { tool: 'handlersFor', url: '/omega/7', method: 7 }],
  ['componentsRendering without component', { tool: 'componentsRendering' }],
  [
    'componentsRendering with a string limit',
    { tool: 'componentsRendering', component: 'Beta', limit: '3' },
  ],
  [
    'componentsRendering with an infinite limit',
    { tool: 'componentsRendering', component: 'Beta', limit: Number.NEGATIVE_INFINITY },
  ],
  ['pathBetween without from', { tool: 'pathBetween', to: 'node-beta' }],
  ['pathBetween without to', { tool: 'pathBetween', from: 'node-alpha' }],
  ['pathBetween with a numeric endpoint', { tool: 'pathBetween', from: 7, to: 'node-beta' }],
  [
    'pathBetween with an array endpoint',
    { tool: 'pathBetween', from: ['node-alpha'], to: 'node-beta' },
  ],
  ['pathBetween with an empty selector', { tool: 'pathBetween', from: {}, to: 'node-beta' }],
  [
    'pathBetween with an unknown selector kind',
    { tool: 'pathBetween', from: { kind: 'bogus' }, to: 'node-beta' },
  ],
  [
    'pathBetween with a mistyped selector name',
    { tool: 'pathBetween', from: { name: 5 }, to: 'node-beta' },
  ],
  ['pathBetween with an empty nodeId', { tool: 'pathBetween', from: '', to: 'node-beta' }],
  [
    'pathBetween with an over-long nodeId',
    { tool: 'pathBetween', from: LONG_NODE_ID, to: 'node-beta' },
  ],
  [
    'pathBetween with an unknown direction',
    { tool: 'pathBetween', from: 'node-alpha', to: 'node-beta', direction: 'sideways' },
  ],
  [
    'pathBetween with an unknown edge kind',
    { tool: 'pathBetween', from: 'node-alpha', to: 'node-beta', edgeKinds: ['teleports'] },
  ],
  [
    'pathBetween with a negative maxDepth',
    { tool: 'pathBetween', from: 'node-alpha', to: 'node-beta', maxDepth: -2 },
  ],
  [
    'pathBetween with a fractional maxDepth',
    { tool: 'pathBetween', from: 'node-alpha', to: 'node-beta', maxDepth: 1.5 },
  ],
  ['excerpt with neither nodeId nor file', { tool: 'excerpt' }],
  ['excerpt with both nodeId and file', { tool: 'excerpt', nodeId: 'node-alpha', file: STUB_FILE }],
  ['excerpt with nodeId and line', { tool: 'excerpt', nodeId: 'node-alpha', line: 3 }],
  ['excerpt with line zero', { tool: 'excerpt', file: STUB_FILE, line: 0 }],
  ['excerpt with a fractional line', { tool: 'excerpt', file: STUB_FILE, line: 2.5 }],
  ['excerpt with a NaN endLine', { tool: 'excerpt', file: STUB_FILE, endLine: Number.NaN }],
  [
    'excerpt with a negative contextLines',
    { tool: 'excerpt', nodeId: 'node-alpha', contextLines: -1 },
  ],
  ['excerpt with a numeric nodeId', { tool: 'excerpt', nodeId: 5 }],
];

/**
 * Asserts that a rejection repeats no string value of the request it refuses.
 *
 * @param rejection The rejection.
 * @param request The refused request.
 */
function expectNoEcho(
  rejection: CodeToolRejection,
  request: Readonly<Record<string, unknown>>,
): void {
  const serialized = JSON.stringify(rejection);
  for (const value of Object.values(request)) {
    if (typeof value === 'string' && value.trim().length >= 4 && !isCodeToolName(value)) {
      expect(serialized).not.toContain(value);
    }
  }
}

describe('C. malformed model output', () => {
  it.each(WHOLE_REQUEST_CASES)(
    'refuses %s as a malformed request, without throwing or delegating',
    async (_label, build) => {
      const harness = makeHarness({ loaded: true });
      const tools = toolsFor(harness);

      const outcome = await tools.runCodeTool(build());
      const rejection = expectRejection(outcome);
      expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.malformed);
      expect(rejection).not.toHaveProperty('tool');
      expect(rejection.hint).toEqual(expect.any(String));
      expect(harness.totalQueryCalls()).toBe(0);

      const parsed = expectRejection(parseCodeToolRequest(build()));
      expect(parsed.code).toBe(CODE_TOOL_REJECTION_CODES.malformed);
    },
  );

  it.each(ARGUMENT_CASES)(
    'refuses %s, naming the tool, without throwing or delegating',
    async (_label, request) => {
      const harness = makeHarness({ loaded: true });
      const tools = toolsFor(harness);

      const rejection = expectRejection(await tools.runCodeTool(request));
      expect(ARGUMENT_REJECTION_CODES).toContain(rejection.code);
      expect(rejection.tool).toBe(request['tool']);
      expect(rejection.hint).toEqual(expect.any(String));
      expectNoEcho(rejection, request);
      expect(harness.totalQueryCalls()).toBe(0);

      // The standalone parser refuses the same request with the same rejection.
      expect(expectRejection(parseCodeToolRequest(request))).toStrictEqual(rejection);
    },
  );

  it('never throws from any entry point, whatever the input', async () => {
    const tools = toolsFor(makeHarness({ loaded: true }));
    const inputs: unknown[] = [
      ...WHOLE_REQUEST_CASES.map(([, build]) => build()),
      ...ARGUMENT_CASES.map(([, request]) => request),
    ];
    for (const input of inputs) {
      await expect(tools.runCodeTool(input)).resolves.toBeDefined();
      expect(() => parseCodeToolRequest(input)).not.toThrow();
    }
    await expect(tools.runCodeTools(inputs)).resolves.toHaveLength(inputs.length);
  });

  it('refuses non-object per-tool arguments instead of throwing', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness);
    const notArguments = null as unknown as CodeToolArguments<'findByName'>;
    const rejection = expectRejection(await tools.findByName(notArguments));
    expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.malformed);
    expect(rejection.tool).toBe('findByName');
    expect(harness.totalQueryCalls()).toBe(0);
  });

  it('cannot be used to pollute Object.prototype', async () => {
    const tools = toolsFor(makeHarness());
    const hostile: unknown = JSON.parse(
      '{"tool":"findByName","name":"alpha","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
    );

    const result = expectResult(await tools.runCodeTool(hostile), 'findByName');
    expect(result.request).toStrictEqual({ tool: 'findByName', name: 'alpha' });
    expect(parseCodeToolRequest(hostile)).toStrictEqual({
      ok: true,
      value: { tool: 'findByName', name: 'alpha' },
    });
    const probe: Record<string, unknown> = {};
    expect(probe['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('tolerates unknown extra keys and never echoes them into the result', async () => {
    const harness = makeHarness();
    const request = {
      ...VALID_REQUESTS.findByName,
      commentary: 'sentinel-commentary-marker',
      reasoning: { detail: 'sentinel-reasoning-marker' },
    };
    const result = expectResult(await toolsFor(harness).runCodeTool(request), 'findByName');
    expect(result.request).toStrictEqual(VALID_REQUESTS.findByName);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sentinel-commentary-marker');
    expect(serialized).not.toContain('sentinel-reasoning-marker');
    expect(harness.mocks.findByName).toHaveBeenCalledWith('alpha', {
      limit: CODE_TOOL_LIMITS.maxResultsPerCall,
    });
  });

  it('treats JSON null as an omitted optional argument', async () => {
    const harness = makeHarness();
    const outcome = await toolsFor(harness).runCodeTool({
      tool: 'whoCalls',
      symbol: 'alpha',
      file: null,
      limit: null,
    });
    expect(expectResult(outcome, 'whoCalls').request).toStrictEqual(VALID_REQUESTS.whoCalls);
  });

  describe('parseCodeToolRequest', () => {
    const NORMALIZED_CASES: readonly (readonly [string, unknown, unknown])[] = [
      [
        'trims names, clamps a zero limit up and orders kinds canonically',
        {
          tool: 'findByName',
          name: '  alpha  ',
          limit: 0,
          exact: false,
          kinds: ['component', 'symbol', 'component'],
          note: 'dropped',
        },
        {
          tool: 'findByName',
          name: 'alpha',
          kinds: ['symbol', 'component'],
          exact: false,
          limit: 1,
        },
      ],
      [
        'accepts one bare kind where a list was declared',
        { tool: 'findByName', name: 'alpha', kinds: 'component' },
        { tool: 'findByName', name: 'alpha', kinds: ['component'] },
      ],
      [
        'clamps a limit above maxResultsPerCall',
        { tool: 'whoCalls', symbol: 'alpha', limit: 10_000, useReferences: true },
        {
          tool: 'whoCalls',
          symbol: 'alpha',
          limit: CODE_TOOL_LIMITS.maxResultsPerCall,
          useReferences: true,
        },
      ],
      [
        'upper-cases an HTTP method',
        { tool: 'handlersFor', url: ' /omega/7 ', method: 'get' },
        { tool: 'handlersFor', url: '/omega/7', method: 'GET' },
      ],
      [
        'normalises direction, depth, edge kinds and selector keys',
        {
          tool: 'pathBetween',
          from: { file: STUB_FILE, symbol: ' alpha ', comment: 'dropped' },
          to: 'node-beta',
          direction: 'BOTH',
          maxDepth: 100,
          edgeKinds: ['calls', 'renders'],
        },
        {
          tool: 'pathBetween',
          from: { file: STUB_FILE, symbol: 'alpha' },
          to: 'node-beta',
          edgeKinds: ['renders', 'calls'],
          direction: 'both',
          maxDepth: CODE_TOOL_LIMITS.maxPathDepth,
        },
      ],
      [
        'clamps excerpt context lines so the anchor survives the line cap',
        { tool: 'excerpt', nodeId: 'node-alpha', contextLines: 99 },
        {
          tool: 'excerpt',
          nodeId: 'node-alpha',
          contextLines: Math.floor((CODE_TOOL_LIMITS.maxExcerptLines - 1) / 2),
        },
      ],
      [
        'keeps node ids and file paths byte for byte',
        { tool: 'excerpt', file: STUB_FILE, line: 4 },
        { tool: 'excerpt', file: STUB_FILE, line: 4 },
      ],
    ];

    it.each(NORMALIZED_CASES)('%s', (_label, input, expected) => {
      const parsed = parseCodeToolRequest(input);
      expect(parsed).toStrictEqual({ ok: true, value: expected });
      if (parsed.ok) {
        expect(Object.isFrozen(parsed.value)).toBe(true);
      }
    });

    it('clamps against the limits it is given, which can never exceed the defaults', () => {
      const request = { tool: 'findByName', name: 'alpha', limit: 1_000 };
      expect(
        parseCodeToolRequest(request, resolveCodeToolLimits({ maxResultsPerCall: 5 })),
      ).toStrictEqual({
        ok: true,
        value: { tool: 'findByName', name: 'alpha', limit: 5 },
      });
      const widened: CodeToolLimits = { ...CODE_TOOL_LIMITS, maxResultsPerCall: 1_000 };
      expect(parseCodeToolRequest(request, widened)).toStrictEqual({
        ok: true,
        value: { tool: 'findByName', name: 'alpha', limit: CODE_TOOL_LIMITS.maxResultsPerCall },
      });
    });

    it('accepts every valid request of this suite unchanged', () => {
      for (const name of CODE_TOOL_NAMES) {
        expect(parseCodeToolRequest(VALID_REQUESTS[name])).toStrictEqual({
          ok: true,
          value: VALID_REQUESTS[name],
        });
      }
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * D. Budgets
 * ---------------------------------------------------------------------------------------------- */

describe('D. budgets', () => {
  it('refuses calls beyond maxCallsPerStage without delegating', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness, { limits: { maxCallsPerStage: 2 } });

    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    expectResult(await tools.runCodeTool(VALID_REQUESTS.whoCalls), 'whoCalls');
    const rejection = expectRejection(await tools.runCodeTool(VALID_REQUESTS.routeForUrl));

    expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.budget);
    expect(rejection.tool).toBe('routeForUrl');
    expect(rejection.budget?.callsRemaining).toBe(0);
    expect(harness.mocks.routeForUrl).not.toHaveBeenCalled();
    expect(tools.budget().callsRemaining).toBe(0);
    expect(tools.budget().callsUsed).toBe(2);
  });

  it('enforces maxCallsPerTool per tool while other tools keep their budget', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness, { limits: { maxCallsPerTool: 1 } });

    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    const second = expectRejection(await tools.runCodeTool(VALID_REQUESTS.findByName));
    expect(second.code).toBe(CODE_TOOL_REJECTION_CODES.budget);
    expect(second.budget?.perTool.findByName).toBe(1);
    expect(harness.mocks.findByName).toHaveBeenCalledTimes(1);

    expectResult(await tools.runCodeTool(VALID_REQUESTS.whoCalls), 'whoCalls');
    const snapshot = tools.budget();
    expect(snapshot.perTool.findByName).toBe(1);
    expect(snapshot.perTool.whoCalls).toBe(1);
    expect(snapshot.callsRemaining).toBe(snapshot.limits.maxCallsPerStage - 2);
  });

  it('enforces maxExcerptsPerStage independently of the call budget', async () => {
    const harness = makeHarness({ loaded: true });
    const tools = toolsFor(harness, { limits: { maxExcerptsPerStage: 2 } });

    expectResult(await tools.runCodeTool(VALID_REQUESTS.excerpt), 'excerpt');
    expectResult(await tools.runCodeTool(VALID_REQUESTS.excerpt), 'excerpt');
    const refused = expectRejection(await tools.runCodeTool(VALID_REQUESTS.excerpt));
    expect(refused.code).toBe(CODE_TOOL_REJECTION_CODES.budget);
    expect(refused.budget?.excerptsRemaining).toBe(0);
    expect(harness.mocks.excerpt).toHaveBeenCalledTimes(2);

    const snapshot = tools.budget();
    expect(snapshot.excerptsRemaining).toBe(0);
    expect(snapshot.callsRemaining).toBeGreaterThan(0);
    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
  });

  it('consumes a slot only for a delegated call, as createCodeTools documents', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness, { limits: { maxCallsPerTool: 1 } });

    expectRejection(await tools.runCodeTool({ tool: 'findByName' }));
    expectRejection(await tools.runCodeTool(VALID_REQUESTS.excerpt));
    expect(tools.budget()).toMatchObject({ callsUsed: 0, callsRejected: 2, excerptsUsed: 0 });

    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    expect(tools.budget()).toMatchObject({ callsUsed: 1, callsRejected: 2 });

    expectRejection(await tools.runCodeTool(VALID_REQUESTS.findByName));
    const snapshot = tools.budget();
    expect(snapshot).toMatchObject({ callsUsed: 1, callsRejected: 3 });
    expect(snapshot.callsRemaining).toBe(snapshot.limits.maxCallsPerStage - 1);
    expect(snapshot.perTool.findByName).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = toolsFor(makeHarness(), { signal: controller.signal });
    expectRejection(await cancelled.runCodeTool(VALID_REQUESTS.findByName));
    expect(cancelled.budget()).toMatchObject({ callsUsed: 0, callsRejected: 1 });
  });

  it('caps a longer list at maxResultsPerCall and reports total, returned and truncated', async () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      stubMatch(`alpha${String(index)}`, index + 1),
    );
    const harness = makeHarness({
      mocks: { findByName: vi.fn<CodeQueries['findByName']>(() => eight) },
    });
    const tools = toolsFor(harness, { limits: { maxResultsPerCall: 3 } });

    const result = expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    expect(result).toMatchObject({ found: true, total: 8, returned: 3, truncated: true });
    expect(result.payload).toStrictEqual(eight.slice(0, 3));
    expect(result.clamped).toStrictEqual([]);

    const whole = toolsFor(makeHarness({ mocks: { findByName: vi.fn(() => eight.slice(0, 2)) } }));
    const untouched = expectResult(
      await whole.runCodeTool(VALID_REQUESTS.findByName),
      'findByName',
    );
    expect(untouched).toMatchObject({ total: 2, returned: 2, truncated: false });
  });

  it('trims a fat list deterministically to maxSerializedResultBytes', async () => {
    const maxSerializedResultBytes = 2_000;
    const fat = (): readonly CodeMatch[] =>
      Array.from({ length: 20 }, (_, index) =>
        stubMatch(`${'w'.repeat(120)}${String(index)}`, index + 1),
      );
    const run = async (): Promise<CodeToolResultFor<'findByName'>> => {
      const harness = makeHarness({ mocks: { findByName: vi.fn(fat) } });
      const tools = toolsFor(harness, { limits: { maxSerializedResultBytes } });
      return expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    };

    const first = await run();
    const second = await run();
    expect(jsonBytes(fat())).toBeGreaterThan(maxSerializedResultBytes);
    expect(jsonBytes(first)).toBeLessThanOrEqual(maxSerializedResultBytes);
    expect(first.truncated).toBe(true);
    expect(first.total).toBe(20);
    expect(first.returned).toBe(first.payload.length);
    expect(first.returned).toBeGreaterThan(0);
    expect(first.returned).toBeLessThan(20);
    expect(first.payload).toStrictEqual(fat().slice(0, first.returned));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('withholds a single value that cannot fit maxSerializedResultBytes', async () => {
    const huge = stubMatch('alpha', 2, { name: 'h'.repeat(4_000) });
    const harness = makeHarness({
      mocks: {
        findSymbol: vi.fn<CodeQueries['findSymbol']>(() => ({
          ...huge,
          symbol: 'alpha',
          exported: true,
        })),
      },
    });
    const tools = toolsFor(harness, { limits: { maxSerializedResultBytes: 1_000 } });
    const result = expectResult(await tools.runCodeTool(VALID_REQUESTS.findSymbol), 'findSymbol');
    expect(result).toMatchObject({ found: true, total: 1, returned: 0, truncated: true });
    expect(result).not.toHaveProperty('payload');
    expect(jsonBytes(result)).toBeLessThanOrEqual(1_000);
  });

  it('enforces the excerpt line cap and flags the cut', async () => {
    const harness = makeHarness({
      loaded: true,
      mocks: { excerpt: vi.fn<CodeQueries['excerpt']>(() => stubExcerpt(12)) },
    });
    const tools = toolsFor(harness, { limits: { maxExcerptLines: 5 } });
    const result = expectResult(await tools.runCodeTool(VALID_REQUESTS.excerpt), 'excerpt');
    const text = result.payload?.text ?? '';
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toBe(stubExcerpt(5).text);
    expect(result.payload?.endLine).toBe(5);
    expect(result.payload?.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('enforces the excerpt character cap at a line boundary and flags the cut', async () => {
    const harness = makeHarness({
      loaded: true,
      mocks: { excerpt: vi.fn<CodeQueries['excerpt']>(() => stubExcerpt(10, 'line of text')) },
    });
    const tools = toolsFor(harness, { limits: { maxExcerptChars: 40 } });
    const result = expectResult(await tools.runCodeTool(VALID_REQUESTS.excerpt), 'excerpt');
    const text = result.payload?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.length).toBeGreaterThan(0);
    expect(stubExcerpt(10, 'line of text').text.startsWith(`${text}\n`)).toBe(true);
    expect(result.payload?.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(harness.mocks.excerpt).toHaveBeenCalledWith(
      'node-alpha',
      expect.objectContaining({ maxChars: 40 }),
    );
  });

  it('leaves an excerpt within both caps untouched', async () => {
    const excerpt = stubExcerpt(3);
    const harness = makeHarness({
      loaded: true,
      mocks: { excerpt: vi.fn<CodeQueries['excerpt']>(() => excerpt) },
    });
    const result = expectResult(
      await toolsFor(harness).runCodeTool(VALID_REQUESTS.excerpt),
      'excerpt',
    );
    expect(result.payload).toBe(excerpt);
    expect(result.truncated).toBe(false);
  });

  describe('resolveCodeToolLimits', () => {
    it('returns the defaults, frozen, when nothing is overridden', () => {
      const limits = resolveCodeToolLimits();
      expect(limits).toStrictEqual(CODE_TOOL_LIMITS);
      expect(Object.isFrozen(limits)).toBe(true);
      expect(Object.isFrozen(resolveCodeToolLimits({ maxCallsPerStage: 3 }))).toBe(true);
    });

    it('clamps an override above a default down to that default', () => {
      for (const key of LIMIT_KEYS) {
        expect(resolveCodeToolLimits({ [key]: CODE_TOOL_LIMITS[key] * 10 })[key]).toBe(
          CODE_TOOL_LIMITS[key],
        );
      }
    });

    it.each([
      ['zero', 0],
      ['a negative number', -5],
      ['NaN', Number.NaN],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('clamps %s up to 1', (_label, value) => {
      for (const key of LIMIT_KEYS) {
        expect(resolveCodeToolLimits({ [key]: value })[key]).toBe(1);
      }
    });

    it('floors a fractional override and honours a tighter one exactly', () => {
      expect(resolveCodeToolLimits({ maxCallsPerStage: 3.9 }).maxCallsPerStage).toBe(3);
      expect(resolveCodeToolLimits({ maxResultsPerCall: 7 }).maxResultsPerCall).toBe(7);
    });

    it('ignores unknown keys and non-numeric values, and never mutates its input', () => {
      const overrides: Partial<CodeToolLimits> & Record<string, unknown> = {
        maxCallsPerTool: 2,
        bogus: 5,
      };
      const before = structuredClone(overrides);
      const limits = resolveCodeToolLimits(overrides);
      expect(overrides).toStrictEqual(before);
      expect(Object.keys(limits)).toStrictEqual(LIMIT_KEYS);
      expect(limits).not.toHaveProperty('bogus');
      expect(limits.maxCallsPerTool).toBe(2);

      const mistyped = { maxCallsPerStage: '3' } as unknown as Partial<CodeToolLimits>;
      expect(resolveCodeToolLimits(mistyped).maxCallsPerStage).toBe(
        CODE_TOOL_LIMITS.maxCallsPerStage,
      );
    });

    it('can never exceed the query engine ceiling of CODE_QUERY_LIMITS', () => {
      const generous = Object.fromEntries(
        LIMIT_KEYS.map((key) => [key, Number.MAX_SAFE_INTEGER]),
      ) as unknown as CodeToolLimits;
      const widenedEngine: CodeQueryLimits = {
        maxResults: Number.MAX_SAFE_INTEGER,
        maxCallers: Number.MAX_SAFE_INTEGER,
        maxPathDepth: Number.MAX_SAFE_INTEGER,
        maxPathNodes: Number.MAX_SAFE_INTEGER,
        maxExcerptLines: Number.MAX_SAFE_INTEGER,
        maxExcerptChars: Number.MAX_SAFE_INTEGER,
        maxNameLength: Number.MAX_SAFE_INTEGER,
        maxUrlLength: Number.MAX_SAFE_INTEGER,
      };
      for (const limits of [
        resolveCodeToolLimits(),
        resolveCodeToolLimits(generous),
        resolveCodeToolLimits(generous, widenedEngine),
      ]) {
        for (const [key, engineKeys] of Object.entries(ENGINE_CEILINGS)) {
          for (const engineKey of engineKeys) {
            expect(limits[key as keyof CodeToolLimits]).toBeLessThanOrEqual(
              CODE_QUERY_LIMITS[engineKey],
            );
          }
        }
      }
    });

    it('is lowered further by a tighter engine, directly and through createCodeTools', () => {
      const tightEngine: CodeQueryLimits = {
        ...CODE_QUERY_LIMITS,
        maxResults: 5,
        maxCallers: 4,
        maxPathDepth: 2,
        maxExcerptLines: 9,
      };
      const direct = resolveCodeToolLimits(undefined, tightEngine);
      expect(direct.maxResultsPerCall).toBe(4);
      expect(direct.maxPathDepth).toBe(2);
      expect(direct.maxExcerptLines).toBe(9);

      const tools = toolsFor(makeHarness({ engineLimits: tightEngine }));
      expect(tools.budget().limits).toStrictEqual(direct);
    });
  });

  it('budget() returns a fresh, frozen snapshot that later calls do not change', async () => {
    const tools = toolsFor(makeHarness());
    const before = tools.budget();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.perTool)).toBe(true);
    expect(Object.isFrozen(before.limits)).toBe(true);
    expect(Reflect.set(before, 'callsUsed', 99)).toBe(false);
    expect(Reflect.set(before.perTool, 'findByName', 99)).toBe(false);

    const again = tools.budget();
    expect(again).not.toBe(before);
    expect(again).toStrictEqual(before);

    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    expect(before.callsUsed).toBe(0);
    expect(before.perTool.findByName).toBe(0);
    expect(tools.budget().callsUsed).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * E. Privacy and read-only guarantees
 * ---------------------------------------------------------------------------------------------- */

/** Text an engine excerpt would carry; it must never surface in a refusal. */
const EXCERPT_CONTENT_MARKER = 'sentinel-excerpt-content';

/** File arguments that must never reach the engine. */
const REFUSED_PATHS: readonly (readonly [string, string])[] = [
  ['an environment file', '.env'],
  ['a local environment file', 'config/.env.local'],
  ['an environment file variant', 'src/.env.production'],
  ['an absolute POSIX path', '/srv/synthetic/alpha.ts'],
  ['a Windows-absolute path', 'C:\\synthetic\\alpha.ts'],
  ['a UNC path', '\\\\host\\share\\alpha.ts'],
  ['a backslash-separated path', 'src\\alpha.ts'],
  ['a parent-directory traversal', '../outside/alpha.ts'],
  ['a nested traversal', 'src/../../outside/alpha.ts'],
  ['a NUL character', 'src/alpha\u0000.ts'],
  ['a control character', 'src/al\u0007pha.ts'],
];

/**
 * Every tool argument that carries a file path, as a request builder.
 *
 * @param file The file argument under test.
 * @returns One request per file-bearing argument.
 */
function fileBearingRequests(
  file: string,
): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    ['excerpt.file', { tool: 'excerpt', file }],
    ['findSymbol.file', { tool: 'findSymbol', file, symbol: 'alpha' }],
    ['whoCalls.file', { tool: 'whoCalls', symbol: 'alpha', file }],
    ['pathBetween.from.file', { tool: 'pathBetween', from: { file }, to: 'node-beta' }],
  ];
}

describe('E. privacy and read-only guarantees', () => {
  it.each(REFUSED_PATHS)(
    'refuses %s with a path rejection that neither reads nor repeats it',
    async (_label, file) => {
      for (const [where, request] of fileBearingRequests(file)) {
        const harness = makeHarness({
          loaded: true,
          mocks: {
            excerpt: vi.fn<CodeQueries['excerpt']>(() => ({
              ...stubExcerpt(),
              text: EXCERPT_CONTENT_MARKER,
            })),
          },
        });
        const rejection = expectRejection(await toolsFor(harness).runCodeTool(request));
        expect(rejection.code, where).toBe(CODE_TOOL_REJECTION_CODES.path);
        expect(harness.totalQueryCalls(), where).toBe(0);

        const serialized = JSON.stringify(rejection);
        expect(serialized, where).not.toContain(JSON.stringify(file).slice(1, -1));
        expect(serialized, where).not.toContain(EXCERPT_CONTENT_MARKER);
        expect(`${rejection.message} ${rejection.hint ?? ''}`, where).not.toContain(file);
      }
    },
  );

  it('degrades to an informative rejection when no project is loaded', async () => {
    const harness = makeHarness();
    const tools = toolsFor(harness);
    for (const request of [VALID_REQUESTS.excerpt, { tool: 'excerpt', file: STUB_FILE, line: 3 }]) {
      const rejection = expectRejection(await tools.runCodeTool(request));
      expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.excerptUnavailable);
      expect(rejection.tool).toBe('excerpt');
      expect(rejection.message).toMatch(/unavailable/i);
      expect(rejection.hint).toMatch(/not loaded/i);
    }
    expect(harness.mocks.excerpt).not.toHaveBeenCalled();
    expectResult(await tools.runCodeTool(VALID_REQUESTS.findSymbol), 'findSymbol');
  });

  it('logs structural fields only, never an argument value', async () => {
    const records: LogRecord[] = [];
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        records.push(record);
      },
    });
    const markers = {
      url: 'http://127.0.0.1:9/marker-url-kappa?token=marker-query-value',
      symbol: 'markerSymbolLambda',
      file: 'src/marker-path-mu.ts',
      escape: '../marker-escape-nu.ts',
      component: 'MarkerComponentXi',
      nodeId: 'marker-node-omicron',
    };
    const tools = toolsFor(makeHarness({ loaded: true }), { logger });

    await tools.runCodeTools([
      { tool: 'routeForUrl', url: markers.url },
      { tool: 'handlersFor', url: markers.url, method: 'GET' },
      { tool: 'findSymbol', file: markers.file, symbol: markers.symbol },
      { tool: 'whoCalls', symbol: markers.symbol, file: markers.escape },
      { tool: 'componentsRendering', component: markers.component },
      { tool: 'excerpt', nodeId: markers.nodeId },
      { tool: 'pathBetween', from: markers.nodeId, to: { file: markers.file } },
      { tool: 'findByName', name: markers.symbol, kinds: ['bogus'] },
      { tool: 'notATool', note: markers.symbol },
    ]);

    expect(records.length).toBe(9);
    const serialized = JSON.stringify(records);
    for (const marker of Object.values(markers)) {
      expect(serialized).not.toContain(marker);
    }
    for (const fragment of ['marker-url-kappa', 'marker-query-value', 'marker-path-mu']) {
      expect(serialized).not.toContain(fragment);
    }
    const structural = new Set([
      'tool',
      'ok',
      'code',
      'callsUsed',
      'returned',
      'total',
      'truncated',
      'bytes',
      'argumentCount',
      'argumentChars',
    ]);
    for (const record of records) {
      expect(record.level).toBe('debug');
      for (const [key, value] of Object.entries(record.fields)) {
        expect(structural.has(key), key).toBe(true);
        expect(['string', 'number', 'boolean']).toContain(typeof value);
        if (typeof value === 'string') {
          expect([...CODE_TOOL_NAMES, ...DEBUGGEN_ERROR_CODES]).toContain(value);
        }
      }
    }
  });

  it('never fails a query because the logger throws', async () => {
    const throwing: Logger = {
      ...createConsoleLogger({ level: 'silent' }),
      debug: () => {
        throw new Error('logger down');
      },
    };
    const tools = toolsFor(makeHarness(), { logger: throwing });
    expectResult(await tools.runCodeTool(VALID_REQUESTS.findByName), 'findByName');
    expectRejection(await tools.runCodeTool({ tool: 'findByName' }));
  });

  it('never calls a method outside the query surface', async () => {
    const harness = makeHarness({ loaded: true });
    const tools = toolsFor(harness);
    await tools.runCodeTools(CODE_TOOL_NAMES.map((name) => VALID_REQUESTS[name]));
    await tools.hasSymbol(VALID_ARGUMENTS.findSymbol);
    expect(harness.resolveRoute).not.toHaveBeenCalled();
    expect(harness.mocks.hasSymbol).not.toHaveBeenCalled();
  });

  describe('static self-scan of code-tools.ts', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'code-tools.ts'),
      'utf8',
    );
    const lines = source.split('\n');

    const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
      ['a node:fs import', /node:fs/],
      ['a child_process import', /child_process/],
      ['a node:process import', /node:process/],
      ['a require call', /\brequire\(/],
      ['a dynamic import', /\bimport\(/],
      ['an eval call', /\beval\(/],
      ['a Function constructor', /\bnew Function\b/],
      ['a zod import', /from\s+["']zod["']/],
      ['a renderer import', /@debuggen\/panel-renderer/],
      ['a demo-app reference', /apps\/demo-app/],
      ['an application route path', /\/api\//],
    ];

    it.each(FORBIDDEN)('contains no %s', (label, pattern) => {
      const offending = lines
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, number }) => `code-tools.ts:${String(number)}: ${line.trim()}`);
      expect(offending, `code-tools.ts must contain no ${label}`).toStrictEqual([]);
    });

    it('spells every relative module specifier with a .js extension', () => {
      const specifiers = [...source.matchAll(/(?:from|import)\s+['"](\.{1,2}\/[^'"]*)['"]/g)].map(
        (match) => match[1] ?? '',
      );
      expect(specifiers.length).toBeGreaterThan(0);
      const offending = specifiers.filter((specifier) => !specifier.endsWith('.js'));
      expect(offending, 'relative specifiers need an explicit .js extension').toStrictEqual([]);
    });

    it('imports only the two packages and the one sibling module it is allowed', () => {
      const specifiers = new Set(
        [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? ''),
      );
      expect([...specifiers].sort()).toStrictEqual(
        ['../context-builder.js', '@debuggen/code-analysis', '@debuggen/shared'].sort(),
      );
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * F. Determinism and serialisability
 * ---------------------------------------------------------------------------------------------- */

/** One valid request per tool, in catalog order. */
const VALID_BATCH: readonly unknown[] = CODE_TOOL_NAMES.map((name) => VALID_REQUESTS[name]);

describe('F. determinism and serialisability', () => {
  it('answers the same request twice with deep-equal, byte-identical results', async () => {
    const harness = makeHarness({ loaded: true });
    for (const name of CODE_TOOL_NAMES) {
      // One stage run per tool over the same stubs, so the pair is compared
      // without the stage budget of the other seven tools in play.
      const tools = toolsFor(harness);
      const first = await tools.runCodeTool(VALID_REQUESTS[name]);
      const second = await tools.runCodeTool(VALID_REQUESTS[name]);
      expect(second).toStrictEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it.each(CODE_TOOL_NAMES.map((name) => [name]))(
    '%s produces a result that survives a JSON round trip unchanged',
    async (name) => {
      const tools = toolsFor(makeHarness({ loaded: true }));
      const result = expectResult(await tools.runCodeTool(VALID_REQUESTS[name]), name);
      const parsed: unknown = JSON.parse(JSON.stringify(result));
      expect(parsed).toStrictEqual(result);
    },
  );

  it('rejections and batch entries survive a JSON round trip unchanged', async () => {
    const tools = toolsFor(makeHarness(), { limits: { maxCallsPerStage: 3 } });
    const runs = await tools.runCodeTools([...VALID_BATCH, null, { tool: 'findByName', name: '' }]);
    const parsed: unknown = JSON.parse(JSON.stringify(runs));
    expect(parsed).toStrictEqual(runs);
  });

  it('two independent instances over equal handles answer a batch identically', async () => {
    const first = await toolsFor(makeHarness({ loaded: true })).runCodeTools(VALID_BATCH);
    const second = await toolsFor(makeHarness({ loaded: true })).runCodeTools(VALID_BATCH);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toStrictEqual(first);
  });

  it('never mutates the caller request objects or the handles', async () => {
    const harness = makeHarness({ loaded: true });
    const requests: Record<string, unknown>[] = [
      ...CODE_TOOL_NAMES.map((name) => ({ ...VALID_REQUESTS[name], extra: { nested: [1, 2] } })),
      { tool: 'findByName', name: '  padded  ', kinds: ['component', 'symbol'], limit: 999 },
      { tool: 'pathBetween', from: { file: STUB_FILE, symbol: 'alpha' }, to: 'node-beta' },
    ];
    const requestsBefore = structuredClone(requests);
    const { handles } = harness;
    const handleKeys = Object.keys(handles);
    const summaryBefore = structuredClone(handles.projectSummary);
    const nodesBefore = JSON.stringify(handles.graph.nodes());
    const entriesBefore = handles.routeMap.entries;

    const tools = toolsFor(harness);
    await tools.runCodeTools(requests);
    for (const request of requests) {
      await tools.runCodeTool(request);
    }

    expect(requests).toStrictEqual(requestsBefore);
    expect(Object.keys(handles)).toStrictEqual(handleKeys);
    expect(handles.queries).toBe(harness.handles.queries);
    expect(handles.loaded).toBe(LOADED_PROJECT);
    expect(handles.projectSummary).toStrictEqual(summaryBefore);
    expect(JSON.stringify(handles.graph.nodes())).toBe(nodesBefore);
    expect(handles.routeMap.entries).toBe(entriesBefore);
    expect(handles.queries.limits).toBe(CODE_QUERY_LIMITS);
  });
});

/* -------------------------------------------------------------------------------------------------
 * G. describeCodeTools()
 * ---------------------------------------------------------------------------------------------- */

/** Camel-case and multi-word Pascal-case tokens: the shape of an application identifier. */
const IDENTIFIER_SHAPED = /\b(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g;

/**
 * Every identifier the catalog may legitimately contain, derived from the tool
 * vocabulary and the descriptors rather than written out.
 *
 * @returns The set.
 */
function catalogVocabulary(): ReadonlySet<string> {
  const vocabulary = new Set<string>(CODE_TOOL_NAMES);
  for (const name of CODE_TOOL_NAMES) {
    const descriptor = CODE_TOOL_DESCRIPTORS[name];
    vocabulary.add(descriptor.delegatesTo);
    for (const key of descriptor.budgetKeys) {
      vocabulary.add(key);
    }
    for (const arg of descriptor.args) {
      vocabulary.add(arg.name);
      for (const allowed of arg.allowed ?? []) {
        vocabulary.add(allowed);
      }
    }
  }
  return vocabulary;
}

/**
 * An override that moves every limit to a value no default and no other
 * override shares, and that appears nowhere else in the catalog text.
 */
const DISTINCTIVE_LIMITS: CodeToolLimits = Object.freeze({
  maxCallsPerStage: 11,
  maxCallsPerTool: 5,
  maxResultsPerCall: 17,
  maxExcerptsPerStage: 3,
  maxExcerptLines: 23,
  maxExcerptChars: 2_999,
  maxPathDepth: 2,
  maxArgumentLength: 157,
  maxUrlLength: 1_021,
  maxNodeIdLength: 509,
  maxSerializedResultBytes: 15_999,
});

/**
 * Whether a number appears in a text as a whole number.
 *
 * @param text The text.
 * @param value The number.
 * @returns `true` when `value` appears with no digit on either side.
 */
function mentionsNumber(text: string, value: number): boolean {
  return new RegExp(`(?<![0-9])${String(value)}(?![0-9])`).test(text);
}

describe('G. describeCodeTools()', () => {
  it('is byte-stable, and explicit default limits render exactly like no limits', () => {
    const text = describeCodeTools();
    expect(describeCodeTools()).toBe(text);
    expect(describeCodeTools({})).toBe(text);
    expect(describeCodeTools({ limits: undefined })).toBe(text);
    expect(describeCodeTools({ limits: CODE_TOOL_LIMITS })).toBe(text);
    expect(describeCodeTools({ limits: resolveCodeToolLimits() })).toBe(text);
    expect(text).not.toContain('\r');
    expect(toolsFor(makeHarness()).describe()).toBe(text);
  });

  it('introduces every tool once, in catalog order, exactly as its descriptor states it', () => {
    const text = describeCodeTools();
    let previous = -1;
    for (const name of CODE_TOOL_NAMES) {
      const descriptor = CODE_TOOL_DESCRIPTORS[name];
      const header = `\n${name}: ${descriptor.purpose}\n`;
      const at = text.indexOf(header);
      expect(at, name).toBeGreaterThan(previous);
      expect(text.indexOf(header, at + 1), name).toBe(-1);
      previous = at;

      for (const arg of descriptor.args) {
        const presence = arg.required ? 'required' : 'optional';
        expect(text).toContain(`  ${arg.name} (${arg.type}, ${presence}): ${arg.description}`);
      }
      expect(text).toContain(`  Returns: ${descriptor.returns}`);
    }
  });

  it('introduces no tool that is not in the catalog', () => {
    const headers = describeCodeTools()
      .split('\n')
      .map((line) => /^([A-Za-z][A-Za-z0-9]*): /.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(headers).toStrictEqual([...CODE_TOOL_NAMES]);
  });

  it('renders the effective limits, so the text cannot disagree with the behaviour', () => {
    const effective = resolveCodeToolLimits(DISTINCTIVE_LIMITS);
    expect(effective).toStrictEqual(DISTINCTIVE_LIMITS);
    const text = describeCodeTools({ limits: DISTINCTIVE_LIMITS });
    const defaults = describeCodeTools();
    expect(text).not.toBe(defaults);

    for (const key of LIMIT_KEYS) {
      expect(mentionsNumber(text, effective[key]), key).toBe(true);
      expect(mentionsNumber(defaults, CODE_TOOL_LIMITS[key]), key).toBe(true);
      expect(mentionsNumber(text, CODE_TOOL_LIMITS[key]), key).toBe(false);
    }

    const tools = toolsFor(makeHarness(), { limits: DISTINCTIVE_LIMITS });
    expect(tools.budget().limits).toStrictEqual(effective);
    expect(tools.describe()).toBe(text);
  });

  it('states the effective, clamped value when asked to render a limit above its ceiling', () => {
    const widened: CodeToolLimits = { ...CODE_TOOL_LIMITS, maxCallsPerStage: 9_999 };
    const text = describeCodeTools({ limits: widened });
    expect(mentionsNumber(text, 9_999)).toBe(false);
    expect(text).toBe(describeCodeTools());
  });

  it('states the prohibitions the investigate prompt relies on', () => {
    const text = describeCodeTools().toLowerCase();
    expect(text).toMatch(/no repository listing/);
    expect(text).toMatch(/no directory walk/);
    expect(text).toMatch(/no whole-file read/);
    expect(text).toMatch(/read-only/);
    expect(text).toMatch(/nothing is modified/);
    expect(text).toMatch(/bounded excerpt/);
  });

  it('names no application identifier, route, URL or absolute path', () => {
    for (const text of [describeCodeTools(), describeCodeTools({ limits: DISTINCTIVE_LIMITS })]) {
      expect(text).not.toContain('/api/');
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).not.toMatch(/(?:^|[\s"'(<[,=])(?:\/(?!\/)[\w.-]|~\/|[A-Za-z]:[\\/]|\\\\)/m);

      const vocabulary = catalogVocabulary();
      const unexpected = [...new Set(text.match(IDENTIFIER_SHAPED) ?? [])].filter(
        (token) => !vocabulary.has(token),
      );
      expect(unexpected).toStrictEqual([]);
    }
  });

  it('is a value for a template placeholder, not a template itself', () => {
    const text = describeCodeTools();
    expect(text).not.toMatch(/\{\{/);
    expect(text).not.toMatch(/\}\}/);
  });
});

/* -------------------------------------------------------------------------------------------------
 * H. Cancellation
 * ---------------------------------------------------------------------------------------------- */

describe('H. cancellation', () => {
  it.each(CODE_TOOL_NAMES.map((name) => [name]))(
    '%s is refused under a pre-aborted signal without delegating',
    async (name) => {
      const controller = new AbortController();
      controller.abort();
      const harness = makeHarness({ loaded: true });
      const tools = toolsFor(harness, { signal: controller.signal });

      const rejection = expectRejection(await tools.runCodeTool(VALID_REQUESTS[name]));
      expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.aborted);
      expect(rejection.tool).toBe(name);
      expectRejection(await runToolMethod(tools, name));
      expect(harness.totalQueryCalls()).toBe(0);
      expect(tools.budget().callsUsed).toBe(0);
    },
  );

  it('stops delegating once the signal aborts mid-batch, still answering every entry', async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      loaded: true,
      mocks: {
        findByName: vi.fn<CodeQueries['findByName']>(() => {
          controller.abort();
          return [stubMatch('alpha')];
        }),
      },
    });
    const tools = toolsFor(harness, { signal: controller.signal });

    const runs = await tools.runCodeTools([
      VALID_REQUESTS.findByName,
      VALID_REQUESTS.whoCalls,
      VALID_REQUESTS.excerpt,
      { tool: 'unknownTool' },
    ]);

    expect(runs).toHaveLength(4);
    expect(runs.map((run) => run.index)).toStrictEqual([0, 1, 2, 3]);
    expectResult(outcomeAt(runs, 0), 'findByName');
    expect(expectRejection(outcomeAt(runs, 1)).code).toBe(CODE_TOOL_REJECTION_CODES.aborted);
    expect(expectRejection(outcomeAt(runs, 2)).code).toBe(CODE_TOOL_REJECTION_CODES.aborted);
    expect(expectRejection(outcomeAt(runs, 3)).code).toBe(CODE_TOOL_REJECTION_CODES.malformed);
    expect(harness.mocks.whoCalls).not.toHaveBeenCalled();
    expect(harness.mocks.excerpt).not.toHaveBeenCalled();
    expect(harness.totalQueryCalls()).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * I. runCodeTools batch semantics
 * ---------------------------------------------------------------------------------------------- */

describe('I. runCodeTools batches', () => {
  it('returns one entry per request, in order, including malformed ones', async () => {
    const tools = toolsFor(makeHarness());
    const batch: unknown[] = [
      VALID_REQUESTS.findByName,
      null,
      { tool: 'findByName', name: '  alpha  ', limit: 999 },
      { tool: 'nope' },
      VALID_REQUESTS.routeForUrl,
      'findSymbol',
    ];
    const runs = await tools.runCodeTools(batch);

    expect(runs).toHaveLength(batch.length);
    expect(runs.map((run) => run.index)).toStrictEqual([0, 1, 2, 3, 4, 5]);
    expect(runs.map((run) => run.outcome.ok)).toStrictEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(runs[0]?.request).toStrictEqual(VALID_REQUESTS.findByName);
    expect(runs[2]?.request).toStrictEqual({
      tool: 'findByName',
      name: 'alpha',
      limit: CODE_TOOL_LIMITS.maxResultsPerCall,
    });
    for (const index of [1, 3, 5]) {
      expect(runs[index]).not.toHaveProperty('request');
    }
    expect(Object.isFrozen(runs)).toBe(true);
    expect(runs.every((run) => Object.isFrozen(run))).toBe(true);
  });

  it('never throws for any mixture of valid, invalid and over-budget requests', async () => {
    const tools = toolsFor(makeHarness(), { limits: { maxCallsPerStage: 4, maxCallsPerTool: 2 } });
    const mixture: unknown[] = [];
    for (let round = 0; round < 3; round += 1) {
      mixture.push(...VALID_BATCH, ...ARGUMENT_CASES.map(([, request]) => request));
      mixture.push(...WHOLE_REQUEST_CASES.map(([, build]) => build()));
    }
    const runs = await tools.runCodeTools(mixture);
    expect(runs).toHaveLength(mixture.length);
    for (const run of runs) {
      if (!run.outcome.ok) {
        expectRejection(run.outcome);
      }
    }
  });

  it('answers a non-list batch with an empty list', async () => {
    const tools = toolsFor(makeHarness());
    const notABatch = { length: 2, 0: VALID_REQUESTS.findByName } as unknown as readonly unknown[];
    await expect(tools.runCodeTools(notABatch)).resolves.toStrictEqual([]);
    await expect(tools.runCodeTools([])).resolves.toStrictEqual([]);
  });

  it('keeps answering with budget rejections once the budget is spent', async () => {
    const harness = makeHarness({ loaded: true });
    const tools = toolsFor(harness, { limits: { maxCallsPerStage: 2 } });
    const batch = [
      VALID_REQUESTS.findByName,
      { tool: 'findByName', name: '' },
      VALID_REQUESTS.whoCalls,
      VALID_REQUESTS.routeForUrl,
      VALID_REQUESTS.componentsRendering,
      VALID_REQUESTS.excerpt,
    ];
    const runs = await tools.runCodeTools(batch);

    expect(runs).toHaveLength(batch.length);
    const accepted = runs.filter((run) => run.outcome.ok);
    expect(accepted.map((run) => run.index)).toStrictEqual([0, 2]);
    expect(expectRejection(outcomeAt(runs, 1)).code).toBe(CODE_TOOL_REJECTION_CODES.malformed);
    for (const index of [3, 4, 5]) {
      const rejection = expectRejection(outcomeAt(runs, index));
      expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.budget);
      expect(rejection.budget?.callsRemaining).toBe(0);
    }
    const snapshot = tools.budget();
    expect(snapshot.callsUsed).toBe(accepted.length);
    expect(snapshot.callsRejected).toBe(batch.length - accepted.length);
    expect(snapshot.callsRemaining).toBe(0);
    expect(harness.totalQueryCalls()).toBe(accepted.length);
  });
});

/* -------------------------------------------------------------------------------------------------
 * J. Real wiring through createCodeQueries
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every value in a payload shaped like a `SourceLocation`.
 *
 * @param value Any JSON value.
 * @returns The location-shaped objects it contains, depth first.
 */
function collectLocations(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.flatMap((item) => collectLocations(item));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const own = Object.entries(value).flatMap(([, member]) => collectLocations(member));
  return 'resolvedBy' in value ? [value, ...own] : own;
}

/**
 * Code tools over the real query engine and an in-memory synthetic index. No
 * loaded project is supplied, exactly as for a session reopened from a cached
 * index.
 *
 * @param edges Builds the index's edges; the defaults when absent.
 * @returns The tools, the real queries and the synthetic nodes.
 */
function realWiring(edges?: (nodes: SyntheticNodes) => readonly CodeEdge[]): {
  readonly tools: CodeTools;
  readonly queries: CodeQueries;
  readonly nodes: SyntheticNodes;
} {
  const { index, nodes } = syntheticIndex(edges);
  const graph = CodeGraph.fromIndex(index);
  const routeMap = routeMapFromIndex(index);
  const queries = createCodeQueries(graph, { routes: routeMap.entries });
  const handles: PipelineCodeHandles = {
    graph,
    queries,
    routeMap,
    projectSummary: stubProjectSummary(),
  };
  return { tools: createCodeTools({ handles }), queries, nodes };
}

describe('J. real wiring through createCodeQueries', () => {
  it('answers every graph tool through the real engine with serialisable payloads', async () => {
    const { tools, nodes } = realWiring();
    const runs = await tools.runCodeTools([
      { tool: 'findByName', name: 'Alpha', limit: 999 },
      { tool: 'findSymbol', file: SYNTHETIC_SERVER_FILE, symbol: 'loadDelta' },
      { tool: 'whoCalls', symbol: 'loadDelta' },
      { tool: 'routeForUrl', url: '/gamma/7' },
      { tool: 'handlersFor', url: '/gamma/7', method: 'get' },
      { tool: 'componentsRendering', component: 'Alpha' },
      {
        tool: 'pathBetween',
        from: nodes.route.id,
        to: { file: SYNTHETIC_SERVER_FILE, symbol: 'loadDelta' },
      },
    ]);

    const byName = expectResult(outcomeAt(runs, 0), 'findByName');
    expect(byName.clamped).toStrictEqual(['limit']);
    expect(byName.payload[0]?.nodeId).toBe(nodes.alpha.id);

    const symbol = expectResult(outcomeAt(runs, 1), 'findSymbol');
    expect(symbol.found).toBe(true);
    expect(symbol.payload?.nodeId).toBe(nodes.loader.id);

    const callers = expectResult(outcomeAt(runs, 2), 'whoCalls');
    expect(callers.payload[0]?.caller.nodeId).toBe(nodes.handler.id);
    expect(callers.payload[0]?.location).toMatchObject({
      file: SYNTHETIC_ROUTE_FILE,
      line: 6,
      column: 10,
    });

    const route = expectResult(outcomeAt(runs, 3), 'routeForUrl');
    expect(route.payload?.routePath).toBe('/gamma/[slot]');
    expect(route.payload?.file).toBe(SYNTHETIC_ROUTE_FILE);
    expect(route.payload?.params).toStrictEqual({ slot: '7' });
    expect(route.payload?.location.resolvedBy).toBe('route-map');

    const handlers = expectResult(outcomeAt(runs, 4), 'handlersFor');
    expect(handlers.payload.map((handler) => handler.method)).toStrictEqual(['GET']);

    const parents = expectResult(outcomeAt(runs, 5), 'componentsRendering');
    expect(parents.payload[0]?.component.nodeId).toBe(nodes.beta.id);

    const path = expectResult(outcomeAt(runs, 6), 'pathBetween');
    expect(path.payload?.nodes[0]?.nodeId).toBe(nodes.route.id);
    expect(path.payload?.nodes.at(-1)?.nodeId).toBe(nodes.loader.id);
    expect(path.payload?.depth).toBe(2);

    for (const run of runs) {
      const result = expectOkResult(run.outcome);
      expect(result.found, result.tool).toBe(true);
      const parsed: unknown = JSON.parse(JSON.stringify(result));
      expect(parsed).toStrictEqual(result);
      const locations = collectLocations(result.payload);
      expect(locations.length, result.tool).toBeGreaterThan(0);
      for (const location of locations) {
        expect(parseSourceLocation(location).ok, result.tool).toBe(true);
      }
    }
  });

  it('refuses excerpt because no loaded project was supplied', async () => {
    const { tools, nodes } = realWiring();
    const rejection = expectRejection(
      await tools.runCodeTool({ tool: 'excerpt', nodeId: nodes.alpha.id }),
    );
    expect(rejection.code).toBe(CODE_TOOL_REJECTION_CODES.excerptUnavailable);
    expect(tools.budget()).toMatchObject({ callsUsed: 0, excerptsUsed: 0, callsRejected: 1 });
  });

  it('agrees with the real engine on hasSymbol', async () => {
    const { tools, queries } = realWiring();
    for (const [file, symbol] of [
      [SYNTHETIC_SERVER_FILE, 'loadDelta'],
      [SYNTHETIC_SERVER_FILE, 'missing'],
      ['src/widgets/Alpha.tsx', 'Alpha'],
    ] as const) {
      expect(await tools.hasSymbol({ file, symbol })).toStrictEqual({
        ok: true,
        value: queries.hasSymbol(file, symbol),
      });
    }
  });

  it('reports "not found" rather than failing when one relationship is missing', async () => {
    const { tools, nodes } = realWiring((built) =>
      syntheticEdges(built).filter((edge) => edge.kind !== 'calls'),
    );
    const callers = expectResult(
      await tools.runCodeTool({ tool: 'whoCalls', symbol: 'loadDelta' }),
      'whoCalls',
    );
    expect(callers).toMatchObject({ found: false, total: 0, returned: 0, payload: [] });

    const path = expectResult(
      await tools.runCodeTool({
        tool: 'pathBetween',
        from: nodes.route.id,
        to: { file: SYNTHETIC_SERVER_FILE, symbol: 'loadDelta' },
      }),
      'pathBetween',
    );
    expect(path.found).toBe(false);
    expect(path).not.toHaveProperty('payload');

    const route = expectResult(
      await tools.runCodeTool({ tool: 'routeForUrl', url: '/elsewhere' }),
      'routeForUrl',
    );
    expect(route).toMatchObject({ found: false, total: 0, returned: 0 });
  });
});

/**
 * The result of an outcome that must be `Ok`, whichever tool answered.
 *
 * @param outcome The outcome.
 * @returns The result.
 */
function expectOkResult(outcome: CodeToolOutcome): CodeToolResult {
  if (!outcome.ok) {
    throw new Error(`Expected Ok, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome.value;
}
