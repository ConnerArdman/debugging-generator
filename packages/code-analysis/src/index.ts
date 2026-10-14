/**
 * `@debuggen/code-analysis` — how the Debug Generator reads a *target* project.
 *
 * This package is the product's static half. It opens a developer's React /
 * Next.js / TypeScript application with ts-morph, turns it into a queryable
 * code graph — files, imports, symbols, React components, event handlers,
 * `fetch` call sites, API routes, server functions and database calls — and
 * answers four kinds of question about it: *what kind of project is this*
 * (the Stage 1 {@link ProjectSummary}), *where is the thing the developer is
 * asking about* (the Stage 2 read-only query surface), *which file serves this
 * URL* (the route map), and *which line of TypeScript does this generated
 * dev-server chunk position correspond to* (the source-map resolver). It reads;
 * it never writes. Nothing in this package modifies the target project, spawns
 * a process, opens a socket or talks to a model — patching belongs to
 * `packages/instrumentation`, prompting to `packages/model-provider`, and
 * orchestration to `apps/local-service`, which are this package's only
 * consumers (AAP 0.2.2, 0.7.1 Group 1).
 *
 * ## One door
 *
 * `package.json` declares exactly one export condition, `"."`, and
 * `tsup.config.ts` declares exactly one entry — this file — so `dist/index.js`
 * and `dist/index.d.ts` are the whole published surface. **A symbol not
 * re-exported below does not exist for a consumer**, and a deep path
 * (`@debuggen/code-analysis/dist/...`, `.../src/graph/query.js`) is not a
 * supported import: Node's ESM resolver refuses any subpath the `exports` map
 * does not name. Adding a capability to this package therefore ends here, with
 * a line in one of the groups below.
 *
 * ## The Stage 2 contract this surface must not weaken
 *
 * The code-investigation stage (AAP 0.4.2) is built on one rule: *the model
 * proposes queries, deterministic code executes them; there is never a
 * repository dump.* {@link createCodeQueries} is that executor —
 * {@link CodeQueries.findByName}, {@link CodeQueries.whoCalls},
 * {@link CodeQueries.routeForUrl}, {@link CodeQueries.handlersFor},
 * {@link CodeQueries.componentsRendering}, {@link CodeQueries.pathBetween},
 * the `(file, symbol)` lookups {@link CodeQueries.findSymbol} /
 * {@link CodeQueries.hasSymbol} that `packages/instrumentation`'s feasibility
 * check consults before it agrees to patch anything, and the *bounded*
 * {@link CodeQueries.excerpt} that is the only way source text leaves this
 * package. Every one of them is capped by {@link CODE_QUERY_LIMITS}, and
 * {@link searchText} — the fallback for a name that is not a symbol — is
 * capped by {@link TEXT_SEARCH_LIMITS}. The caps are the contract, not a
 * tuning detail: an unbounded result is a repository dump with extra steps.
 *
 * ## The `SourceLocation.resolvedBy` values produced here
 *
 * A runtime item earns a project-relative `SourceLocation` (declared once, in
 * `@debuggen/shared`) through one of four routes. This package owns three of
 * them and names itself in each:
 *
 * - `code-graph` — a component display name, a server function or a
 *   `prisma.*` / `pool.query` call site resolved back to its declaration
 *   through {@link createCodeQueries} over a {@link CodeGraph}.
 * - `route-map` — a request path resolved to the `route.ts` / `page.tsx` that
 *   serves it through {@link buildRouteMap} and {@link matchRoute}.
 * - `source-map` — a frame of a browser `Error().stack` pointing into a
 *   generated chunk, resolved through {@link fetchSourceMap},
 *   {@link resolveStack} and {@link normalizeSourcePath}.
 *
 * The remaining two routes belong elsewhere and are deliberately absent here:
 * `patch` metadata is recorded by `packages/instrumentation` when it applies a
 * function-timing patch, and `react-owner` comes from the browser agent's
 * fiber owner chain in `packages/telemetry`.
 *
 * ## Node-only, by construction
 *
 * There is no browser half of this package and no second export condition to
 * keep honest. ts-morph walks a real filesystem, the project loader and the
 * index cache use `node:fs` / `node:path` / `node:crypto` directly, and the
 * source-map fetcher reaches the dev server over HTTP before handing a parsed
 * document to `@jridgewell/trace-mapping` — so `tsup.config.ts` states
 * `platform: 'node'` and `tsconfig.json` sets `types: ["node"]`. Nothing here
 * is importable from the MAIN-world telemetry agent, the DevTools panel, the
 * VS Code webview or `packages/panel-renderer`.
 *
 * Cached indexes live outside the developer's checkout: `createIndexCache`
 * writes one JSON entry per project under `$DEBUGGEN_HOME/index`
 * (`~/.debuggen/index` by default, resolved by {@link resolveIndexCacheDir}),
 * named by {@link computeIndexCacheEntryKey} over the project's identity and
 * overwritten on every save. Freshness is decided by the entry's state key —
 * {@link computeIndexCacheKey} over the modification time and size of every
 * file that was read — with a content-hash comparison for the files whose
 * metadata moved, so a tree restored byte for byte (as session cleanup does)
 * is served from the cache. A session therefore never shows up in
 * `git status`.
 *
 * ## Dependency boundary
 *
 * Among `@debuggen/*` this package may import `@debuggen/shared` and
 * `@debuggen/shared/node` — and nothing else. `packages/instrumentation` and
 * `apps/local-service` depend on *this* package, so an import of
 * `@debuggen/instrumentation`, `@debuggen/protocol`, `@debuggen/panel-schema`,
 * `@debuggen/panel-renderer`, `@debuggen/model-provider` or
 * `@debuggen/telemetry` from anywhere under `src/` would close a cycle in the
 * acyclic package graph (AAP 0.2.2). `tsc -b` would reject it (TS6202) and the
 * `no-restricted-imports` layering block of the root `eslint.config.js`
 * rejects it independently.
 *
 * ## Reading this file
 *
 * The groups below are in the package's internal dependency order, which is
 * also the order the pipeline uses them in: open a project, speak its
 * vocabulary, hold a graph, map its routes, query it, cache it, index it,
 * summarise it, search it, and resolve a generated position back to source.
 * Every specifier carries an explicit `.js` extension because this project is
 * type-checked under NodeNext resolution, and every group is an **explicit
 * named list** rather than `export *`: the published surface of the package is
 * meant to be reviewable in one file, and `verbatimModuleSyntax` needs the
 * type-only re-exports to stay type-only, which `export type { … }` states and
 * `export *` cannot.
 *
 * ## Deliberately absent
 *
 * - The eight modules under `src/extractors/` are internals of
 *   {@link indexProject}. Consumers reach them through
 *   {@link DEFAULT_EXTRACTORS} — narrowing a run by filtering that frozen array
 *   on an extractor's `id`, widening it by spreading the array with their own
 *   {@link Extractor} — so the set of built-in extractors can change without
 *   changing this surface.
 * - The colocated `*.test.ts` suites and the `test/fixtures/**` corpus (a
 *   generic Next.js app used as *indexing input*) are unreachable from here.
 *   `tsup`'s graph starts at this file, so nothing test-only can reach
 *   `dist/`, and `tsconfig.json` excludes the fixture corpus from this
 *   project's program.
 *
 * Importing this module has no side effect: every export is a declaration, the
 * manifest declares `"sideEffects": false`, and no module reached from here
 * constructs a ts-morph `Project`, touches the filesystem, reads an environment
 * variable or holds mutable state *at module scope* — which matters because
 * `apps/local-service` imports this package during start-up. Filesystem and
 * `$DEBUGGEN_HOME` reads happen inside the functions that are documented to do
 * them ({@link openProject}, {@link indexProject}, {@link createIndexCache},
 * {@link resolveIndexCacheDir}, {@link readTargetManifest}), never as a
 * consequence of the import. There is no default export.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// project — the one construction site for the ts-morph `Project`, and the
// module that guarantees the indexer never reads a developer's `.env*` file.
// `findWorkspaceRoot` is published beside it because a consumer that wants a
// fact about a monorepo member's root — the dev-server launcher deciding which
// package manager to form a relaunch command with (AAP 0.7.1 Group 2) — needs
// the same membership-checked lookup `summarizeProject` performs internally,
// and must not re-derive it by walking upwards to the nearest lockfile.
// ---------------------------------------------------------------------------
export {
  EXCLUDED_DIRECTORY_NAMES,
  INDEXABLE_EXTENSIONS,
  findWorkspaceRoot,
  isEnvFilePath,
  isIndexableFile,
  openProject,
  shouldExcludePath,
} from './project.js';
export type {
  FindWorkspaceRootOptions,
  LoadedProject,
  OpenProjectOptions,
  WorkspaceDeclarationKind,
  WorkspaceRoot,
} from './project.js';

// ---------------------------------------------------------------------------
// graph/types — the single vocabulary of the code graph: node and edge kinds,
// every node payload, the index envelope, diagnostics, the extractor contract
// and the project-summary shapes. A second definition of any of these,
// anywhere in the monorepo, is a defect (AAP 0.2.3).
// ---------------------------------------------------------------------------
export {
  API_ROUTE_KINDS,
  CODE_EDGE_KINDS,
  CODE_INDEX_SCHEMA_VERSION,
  CODE_NODE_KINDS,
  DATABASE_ACCESS_STYLES,
  DB_DRIVERS,
  FRAMEWORK_NAMES,
  HTTP_METHOD_NAMES,
  INDEX_DIAGNOSTIC_CODES,
  INDEX_DIAGNOSTIC_SEVERITIES,
  PACKAGE_MANAGERS,
  ROUTER_KINDS,
  ROUTER_STYLES,
  SYMBOL_DECLARATION_KINDS,
  isCodeEdgeKind,
  isCodeNodeKind,
  isIndexDiagnosticCode,
} from './graph/types.js';
export type {
  ApiCallNodeData,
  ApiRouteKind,
  ApiRouteNodeData,
  CodeEdge,
  CodeEdgeKind,
  CodeIndex,
  CodeNode,
  CodeNodeBase,
  CodeNodeKind,
  CodeNodeOf,
  ComponentNodeData,
  DatabaseAccessInfo,
  DatabaseAccessStyle,
  DbCallNodeData,
  DbDriver,
  ExternalImportRef,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  FileFingerprint,
  FileNodeData,
  FrameworkInfo,
  FrameworkName,
  HandlerNodeData,
  HttpMethodName,
  IndexDiagnostic,
  IndexDiagnosticCode,
  IndexDiagnosticSeverity,
  PackageManagerName,
  ProjectDependencyRef,
  ProjectSummary,
  ProjectSummaryCounts,
  ProjectSummaryRouteRef,
  ReferenceQuery,
  ReferenceResolver,
  RouterKind,
  RouterStyle,
  ServerFunctionNodeData,
  SymbolDeclarationKind,
  SymbolNodeData,
  TypeScriptInfo,
} from './graph/types.js';

// ---------------------------------------------------------------------------
// graph/graph — the in-memory container every consumer of an index reads
// through, plus the two deterministic identity constructors every producer of
// a node or an edge calls
// ---------------------------------------------------------------------------
export { CodeGraph, makeEdgeId, makeNodeId } from './graph/graph.js';
export type {
  CodeGraphOptions,
  CodeGraphSize,
  EdgeIdInput,
  NeighborDirection,
  NeighborOptions,
  NodeIdInput,
} from './graph/graph.js';

// ---------------------------------------------------------------------------
// route-map — the product's only URL <-> route-file mapper, and the source of
// the `route-map` resolution route. `RouterStyle` is declared in
// `./graph/types.js` and re-exported by `./route-map.js` beside the options
// that consume it; it is published above, from its declaration site, so the
// name appears exactly once in this surface.
// ---------------------------------------------------------------------------
export {
  buildRouteEntry,
  buildRouteMap,
  deriveRouteFromFile,
  matchRoute,
  routeMapFromIndex,
} from './route-map.js';
export type {
  BuildRouteMapOptions,
  DeriveRouteOptions,
  DerivedRoute,
  HttpMethod,
  RouteEntry,
  RouteEntryKind,
  RouteMap,
  RouteMatch,
  RouteSegment,
  RouteSegmentKind,
} from './route-map.js';

// ---------------------------------------------------------------------------
// graph/query — the read-only surface Stage 2 puts in front of a model, and
// the `(file, symbol)` existence lookup the instrumentation feasibility check
// consults. Every result is bounded by `CODE_QUERY_LIMITS`.
// ---------------------------------------------------------------------------
export { CODE_QUERY_LIMITS, createCodeQueries } from './graph/query.js';
export type {
  CallerProvenance,
  CallerRef,
  CodeExcerpt,
  CodeExcerptRegion,
  CodeExcerptTarget,
  CodeMatch,
  CodeNodeSelector,
  CodePath,
  CodePathDirection,
  CodePathEdge,
  CodePathEndpoint,
  CodeQueries,
  CodeQueryLimits,
  CodeQueryOptions,
  CodeSymbolMatch,
  ComponentRef,
  ComponentsRenderingOptions,
  ExcerptOptions,
  FindByNameOptions,
  HandlerRef,
  HandlersForOptions,
  PathBetweenOptions,
  RouteQueryResult,
  WhoCallsOptions,
  WhoCallsTarget,
} from './graph/query.js';

// ---------------------------------------------------------------------------
// cache — one JSON entry per project under `$DEBUGGEN_HOME/index`, named by
// project identity and kept fresh by file fingerprints plus content hashes, so
// a session never writes inside the developer's checkout
// ---------------------------------------------------------------------------
export {
  INDEX_CACHE_SCHEMA_VERSION,
  computeIndexCacheEntryKey,
  computeIndexCacheKey,
  createIndexCache,
  isCodeIndex,
  resolveIndexCacheDir,
} from './cache.js';
export type { IndexCache, IndexCacheKeyInput, IndexCacheOptions } from './cache.js';

// ---------------------------------------------------------------------------
// indexer — the orchestrator: a target project in, a queryable code graph out.
// `DEFAULT_EXTRACTORS` is the only handle on the eight extractor modules,
// which are internals of this stage.
// ---------------------------------------------------------------------------
export {
  DEFAULT_EXTRACTORS,
  INDEXER_VERSION,
  buildIndex,
  computeFileFingerprints,
  createReferenceResolver,
  indexProject,
} from './indexer.js';
export type { BuildIndexOptions, IndexProjectOptions, IndexResult, IndexStats } from './indexer.js';

// ---------------------------------------------------------------------------
// summary — what Stage 1 (problem understanding) is told about a target
// project, and nothing more: framework, router convention, package manager,
// database access style, entry points and route inventory, each bounded by
// `PROJECT_SUMMARY_LIMITS`. The detection helpers and the manifest reader are
// published beside it so the same answers can be obtained without building a
// whole summary, and so is `isToolingModulePath`, the seed/script/test/config
// classifier the database adapters use to skip modules that never run inside
// the dev server.
// ---------------------------------------------------------------------------
export {
  PROJECT_SUMMARY_LIMITS,
  createProjectProbe,
  detectDatabaseAccess,
  detectFramework,
  detectPackageManager,
  detectRouterStyle,
  isToolingModulePath,
  parseManifest,
  readTargetManifest,
  summarizeProject,
} from './summary.js';
export type {
  ProjectProbe,
  ProjectSummaryLimits,
  SummarizeProjectInput,
  TargetManifest,
  WorkspacePackageManagerFallback,
} from './summary.js';

// ---------------------------------------------------------------------------
// search/text-search — the bounded, deterministic fallback retrieval route for
// the name that is not a symbol (a config key, a SQL fragment, a header name)
// ---------------------------------------------------------------------------
export { TEXT_SEARCH_LIMITS, searchText } from './search/text-search.js';
export type { TextSearchHit, TextSearchOptions, TextSearchResult } from './search/text-search.js';

// ---------------------------------------------------------------------------
// source-map/normalize — the path half of the `source-map` route: a bundler
// `sources` URL (`webpack://_N_E/./src/...`, `turbopack://[project]/...`) in,
// a project-relative POSIX path out
// ---------------------------------------------------------------------------
export {
  REJECTED_PATH_SEGMENTS,
  SOURCE_URL_MARKERS,
  SOURCE_URL_SCHEMES,
  isWebpackInternalSource,
  normalizeSourcePath,
} from './source-map/normalize.js';
export type { NormalizeSourcePathOptions } from './source-map/normalize.js';

// ---------------------------------------------------------------------------
// source-map/fetch-map — the transport half: find the map that belongs to a
// dev-server chunk, parse it, cache it, and refuse anything that is not a
// loopback dev-server URL or is larger than the byte ceiling
// ---------------------------------------------------------------------------
export {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_MAP_BYTES,
  SOURCE_MAPPING_URL_TAIL_BYTES,
  createSourceMapCache,
  fetchSourceMap,
  isLoopbackDevServerUrl,
  isSectionedSourceMap,
  readSourceMappingUrlDirective,
} from './source-map/fetch-map.js';
export type {
  FetchSourceMapOptions,
  RawSourceMapDocument,
  SectionedSourceMapDocument,
  SourceMapCache,
  SourceMapDocument,
  SourceMapLookup,
} from './source-map/fetch-map.js';

// ---------------------------------------------------------------------------
// source-map/resolver — the mapping half, and the end of the route: a browser
// `Error().stack` in, project-relative `SourceLocation` values out, bounded by
// `DEFAULT_MAX_FRAMES` frames and `DEFAULT_MAX_MAPS` distinct maps per call
// ---------------------------------------------------------------------------
export {
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  parseStackFrames,
  resolveStack,
  resolveStackFrame,
} from './source-map/resolver.js';
export type { ResolveStackOptions, StackFrame } from './source-map/resolver.js';
