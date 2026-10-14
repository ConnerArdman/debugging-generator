/**
 * Unit suite for `./api-routes.ts` — the extractor that owns the `api-route`
 * node kind, in **both** Next.js routers (AAP §0.8.3 names route extraction in
 * both routers as required code-analysis coverage).
 *
 * ## What is pinned here, and why each assertion is load-bearing
 *
 * The extractor is small on purpose: it asks `../route-map.ts` what URL a file
 * serves and what it answers, and turns that into exactly one node. So every
 * failure mode it has is a failure of *delegation* or of *completeness*, and
 * the groups below are one per mode:
 *
 * 1. **One node per route module, with the right methods.** An App Router
 *    `route.*` module reports one method per named handler export in source
 *    order; a legacy `pages/api/**` module reports the single dispatching
 *    `ANY`, derived from its default export; a `page.*` module reports the
 *    document `GET`. A module that serves no URL — `layout.*`, a private
 *    `_folder`, a component — reports nothing at all.
 * 2. **Nothing about a URL is re-derived here.** `deriveRouteFromFile` is
 *    called directly by this suite for every corpus file and the extractor's
 *    answer is required to agree with it exactly — route path, router, kind,
 *    and (through the index-rebuilt entry) segments, dynamic parameters and the
 *    two catch-all flags. The route-group-plus-catch-all module of the corpus
 *    is the case a locally re-implemented derivation gets wrong: its URL must
 *    omit the `(observatory)` group while keeping the `[...segments]`
 *    catch-all.
 * 3. **Locations are passed through, not re-minted.** Every `SourceLocation`
 *    the route map produced keeps `resolvedBy: 'route-map'` and that route's
 *    default confidence (`DEFAULT_RESOLUTION_CONFIDENCE['route-map']`), never
 *    the `code-graph` provenance the rest of this package stamps, and every one
 *    of them parses with `parseSourceLocation` from `@debuggen/shared`.
 * 4. **The node payload is complete enough to rebuild the route map from an
 *    index.** `routeMapFromIndex` has no compiler and no syntax: it reads
 *    `file`, `data.routePath`, `data.router`, `data.kind`, `data.methods` and
 *    the position fields off these nodes and nothing else. The round-trip group
 *    resolves every corpus URL through both `routeMapFromIndex(index)` and
 *    `buildRouteMap(loaded)` and requires identical answers — which is the only
 *    place an incomplete payload becomes visible, and the reason a reopened
 *    session in the local service resolves a captured `http.server` span the
 *    same way a fresh one does (AAP §0.4.2).
 * 5. **Router shapes the corpus does not hold** — the arrow-const handler, a
 *    module exporting every declarable method, a module exporting none,
 *    `export { handler as default }`, the optional catch-all, a private folder,
 *    a parallel slot, an `index` page, and every App Router special file — are
 *    exercised in a scratch project created under `os.mkdtemp` and removed
 *    afterwards. The committed corpus is opened **read-only**: nothing in this
 *    file writes inside `packages/code-analysis`, so a run leaves
 *    `git status --porcelain packages/code-analysis` empty.
 * 6. **Robustness, purity and determinism.** Two consecutive extractions
 *    produce deeply equal, identically ordered output; a syntactically broken
 *    route module neither throws nor stops its siblings from registering; a
 *    module that cannot be read at all becomes one `extractor-failed`
 *    diagnostic that quotes no source text; extraction writes nothing; and the
 *    extractor emits **no edges** of any kind — the `calls` linkage from a
 *    route into the service layer belongs to `./server-functions.ts`, and
 *    resolving references is the lazy resolver's job.
 *
 *    Those last two are *two* cases rather than one because ts-morph's parser
 *    is error-tolerant: a module with unparseable syntax is still walkable, so
 *    it produces the documented "no handler located" finding — a node with no
 *    methods — and no diagnostic at all. The diagnostic branch belongs to a
 *    module that cannot be read, which {@link unreadable} injects
 *    deterministically; asserting a diagnostic for the broken *file* would be
 *    asserting behaviour this extractor does not have.
 *
 * ## How the cases are driven
 *
 * The corpus at `../../test/fixtures/sample-next-app` is opened once, through
 * the real `openProject`, exactly as a consumer opens a developer's project,
 * and each case hands the extractor a per-file {@link ExtractorContext} built
 * exactly as `../indexer.ts` builds it. The full index is built once too
 * (`buildIndex`), because the round-trip group needs the nodes *this extractor*
 * contributed to a real index rather than hand-made ones.
 *
 * Positions are never hardcoded. Where a case asserts where a handler was
 * located, the expected line and column are computed by finding that export in
 * the file's own text and converting the offset, so reformatting the corpus
 * moves the expectation with it and a wrong position still fails.
 *
 * Fixture route names, symbols and URLs are fixture-invented test data. None of
 * them appears in `./api-routes.ts` or in `../route-map.ts`, and none should:
 * those modules derive, they do not recognise.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SourceFile } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isSafeRelativePath,
  joinPosix,
  noopLogger,
  parseSourceLocation,
  toPosix,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SourceLocation } from '@debuggen/shared';

import { makeNodeId } from '../graph/graph.js';
import {
  API_ROUTE_KINDS,
  HTTP_METHOD_NAMES,
  INDEX_DIAGNOSTIC_CODES,
  ROUTER_KINDS,
} from '../graph/types.js';
import type {
  CodeIndex,
  CodeNodeOf,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { DEFAULT_EXTRACTORS, buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { buildRouteMap, deriveRouteFromFile, routeMapFromIndex } from '../route-map.js';
import type { HttpMethod, RouteEntry, RouteMap } from '../route-map.js';
import { API_ROUTES_EXTRACTOR_ID, apiRoutesExtractor, routeEntryForFile } from './api-routes.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary, named rather than spelled
 * ---------------------------------------------------------------------------------------------- */

/**
 * The App Router member of `ROUTER_KINDS`, taken from the vocabulary rather
 * than written as a literal.
 *
 * Tuple indexing rather than a string: `ROUTER_KINDS` is the single declaration
 * of which router conventions exist, and a case that asserts "this is the App
 * Router" should fail if that member is ever renamed instead of quietly
 * comparing against a stale spelling.
 */
const APP_ROUTER = ROUTER_KINDS[0];

/** The Pages Router member of `ROUTER_KINDS`. */
const PAGES_ROUTER = ROUTER_KINDS[1];

/** The request-handler member of `API_ROUTE_KINDS`. */
const HANDLER_KIND = API_ROUTE_KINDS[0];

/** The page member of `API_ROUTE_KINDS`. */
const PAGE_KIND = API_ROUTE_KINDS[1];

/**
 * `ANY` — the single dispatching value a legacy Pages Router API module
 * reports, and the one member of `HTTP_METHOD_NAMES` that is *not* an HTTP
 * method and therefore cannot be exported as a handler.
 *
 * Its membership in the vocabulary is asserted below rather than assumed, which
 * is what ties this constant to `../graph/types.ts`.
 */
const ANY_METHOD: HttpMethod = 'ANY';

/** `GET`, the method a page answers and the first handler of the corpus. */
const GET_METHOD: HttpMethod = 'GET';

/** `POST`, the corpus' second handler on its two-method module. */
const POST_METHOD: HttpMethod = 'POST';

/**
 * Every method a route module can actually export a handler for: the
 * vocabulary minus {@link ANY_METHOD}, in vocabulary order.
 *
 * Derived rather than listed, so the scratch module that exports "every method"
 * exports whatever the vocabulary currently holds.
 */
const EXPORTABLE_METHODS: readonly HttpMethod[] = HTTP_METHOD_NAMES.filter(
  (method) => method !== ANY_METHOD,
);

/** The `extractor-failed` diagnostic code, the only one this extractor emits. */
const EXTRACTOR_FAILED = 'extractor-failed';

/* -------------------------------------------------------------------------------------------------
 * The corpus, and the files of it each group is about
 * ---------------------------------------------------------------------------------------------- */

/** The read-only indexing corpus, opened where it lives and never written. */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url)),
);

/** The corpus' App Router handler module exporting two methods. */
const MULTI_METHOD_HANDLER = 'app/api/gauges/route.ts';

/** The corpus' App Router handler module below a dynamic `[id]` segment. */
const DYNAMIC_HANDLER = 'app/api/gauges/[id]/route.ts';

/** The corpus' handler module inside a route group, below a catch-all segment. */
const GROUPED_CATCH_ALL_HANDLER = 'app/(observatory)/api/basins/[...segments]/route.ts';

/** The corpus' dynamic page inside the same route group. */
const GROUPED_DYNAMIC_PAGE = 'app/(observatory)/basins/[id]/page.tsx';

/** The corpus' root App Router page. */
const ROOT_PAGE = 'app/page.tsx';

/** The corpus' root layout: an App Router special file, which serves no URL. */
const ROOT_LAYOUT = 'app/layout.tsx';

/** The corpus' single legacy Pages Router API module. */
const LEGACY_HANDLER = 'pages/api/gauge-log.ts';

/** Every corpus file that serves a URL, which is the set the groups below cover. */
const CORPUS_ROUTE_FILES: readonly string[] = [
  MULTI_METHOD_HANDLER,
  DYNAMIC_HANDLER,
  GROUPED_CATCH_ALL_HANDLER,
  GROUPED_DYNAMIC_PAGE,
  ROOT_PAGE,
  LEGACY_HANDLER,
];

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * An opened project plus its file set keyed the way the indexer keys it.
 *
 * `../indexer.ts` prepares one entry per indexable file — the `SourceFile` and
 * its project-relative POSIX path — and builds one {@link ExtractorContext} from
 * each. This is that preparation, so a case can name a file by the path a node's
 * `file` field carries instead of reaching for an absolute one.
 */
interface PreparedProject {
  /** The project, as `../project.ts` opened it. */
  readonly loaded: LoadedProject;

  /**
   * Project-relative POSIX path to loaded module, in `sourceFiles()` order —
   * which is deterministic, so iteration order here is too.
   */
  readonly files: ReadonlyMap<string, SourceFile>;
}

/**
 * Prepares an opened project's file set.
 *
 * A file whose path cannot be expressed relative to the project root is skipped
 * for the same reason the indexer skips it: no node could point at it.
 *
 * @param loaded The opened project.
 * @returns The prepared project.
 */
function prepare(loaded: LoadedProject): PreparedProject {
  const files = new Map<string, SourceFile>();
  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));
    if (file !== undefined) {
      files.set(file, sourceFile);
    }
  }

  return { loaded, files };
}

/** The corpus, prepared once in {@link beforeAll}. */
let openedCorpus: PreparedProject | undefined;

/** The whole index of the corpus, built once with every default extractor. */
let corpusIndex: CodeIndex | undefined;

/** The corpus' route map, built once with the compiler. */
let corpusRouteMap: RouteMap | undefined;

/** The scratch project of the shapes the corpus lacks, created once. */
let scratchProject: PreparedProject | undefined;

/** The scratch project's root, so {@link afterAll} can remove exactly it. */
let scratchRoot: string | undefined;

/**
 * The prepared corpus, or a readable failure.
 *
 * An accessor rather than a non-null assertion: a case that runs before the
 * hook — a `describe`-level mistake — then says so instead of dereferencing
 * `undefined` three frames deeper.
 *
 * @returns The prepared corpus.
 */
function corpus(): PreparedProject {
  if (openedCorpus === undefined) {
    throw new Error('the corpus was not opened; the beforeAll hook did not run');
  }
  return openedCorpus;
}

/**
 * The corpus index.
 *
 * @returns The index built by `buildIndex` over the corpus.
 */
function index(): CodeIndex {
  if (corpusIndex === undefined) {
    throw new Error('the corpus index was not built; the beforeAll hook did not run');
  }
  return corpusIndex;
}

/**
 * The corpus route map built with the compiler.
 *
 * @returns The map `buildRouteMap` produced over the corpus.
 */
function routeMap(): RouteMap {
  if (corpusRouteMap === undefined) {
    throw new Error('the corpus route map was not built; the beforeAll hook did not run');
  }
  return corpusRouteMap;
}

/**
 * The scratch project.
 *
 * @returns The prepared scratch project.
 */
function scratch(): PreparedProject {
  if (scratchProject === undefined) {
    throw new Error('the scratch project was not created; the beforeAll hook did not run');
  }
  return scratchProject;
}

/**
 * Opens a project read-only and fails the run with the loader's own message when
 * it cannot be opened.
 *
 * @param projectRoot The absolute POSIX root.
 * @returns The prepared project.
 */
function openPrepared(projectRoot: string): PreparedProject {
  const opened = openProject({ projectRoot });
  if (!opened.ok) {
    throw new Error(`the project at ${projectRoot} did not open: ${opened.error.message}`);
  }
  return prepare(opened.value);
}

/**
 * The loaded module for one project-relative path, or a failure naming what the
 * project does hold.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The module.
 */
function moduleOf(project: PreparedProject, file: string): SourceFile {
  const sourceFile = project.files.get(file);
  if (sourceFile === undefined) {
    throw new Error(
      `${file} is not in the project's file set; it holds ${[...project.files.keys()].join(', ')}`,
    );
  }
  return sourceFile;
}

/**
 * The {@link ExtractorContext} for one file, built exactly as `../indexer.ts`
 * builds it: the same five fields, the project's own root, and the shared
 * logger.
 *
 * `noopLogger` rather than a recording stub in the general case — the
 * extractor's log lines are supplements to its result, never its contract. The
 * one case that is about a log line builds its own recording logger.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The context.
 */
function contextFor(project: PreparedProject, file: string): ExtractorContext {
  return {
    loaded: project.loaded,
    sourceFile: moduleOf(project, file),
    file,
    projectRoot: project.loaded.projectRoot,
    logger: noopLogger,
  };
}

/**
 * Runs the extractor over one file of a project.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The whole result: nodes, edges and any diagnostics.
 */
function extract(project: PreparedProject, file: string): ExtractorResult {
  return apiRoutesExtractor.extract(contextFor(project, file));
}

/**
 * The `api-route` nodes one file produced.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the kind is
 * narrowed here once instead of at every assertion — every node this extractor
 * emits is an `api-route`, and the filter is what tells the compiler so. A node
 * of any other kind would be dropped by this filter, which is why the callers
 * that care also assert the raw node count.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The nodes, in emission order.
 */
function routeNodes(project: PreparedProject, file: string): readonly CodeNodeOf<'api-route'>[] {
  return extract(project, file).nodes.filter(
    (node): node is CodeNodeOf<'api-route'> => node.kind === 'api-route',
  );
}

/**
 * The single `api-route` node one file must produce, or a failure naming how
 * many it produced instead.
 *
 * One node per route file — never one per method — is the invariant
 * `routeMapFromIndex` depends on, so every case that reaches for "the node"
 * enforces it on the way.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The node.
 */
function oneRouteNode(project: PreparedProject, file: string): CodeNodeOf<'api-route'> {
  const result = extract(project, file);
  const nodes = result.nodes.filter(
    (node): node is CodeNodeOf<'api-route'> => node.kind === 'api-route',
  );

  expect(result.nodes.length, `${file} emitted a node of another kind`).toBe(nodes.length);
  expect(nodes.length, `${file} must yield exactly one api-route node`).toBe(1);

  const node = nodes[0];
  if (node === undefined) {
    throw new Error(`${file} produced no api-route node`);
  }
  return node;
}

/**
 * The complete {@link RouteEntry} of one file, read through the extractor's own
 * exported entry point.
 *
 * `routeEntryForFile` is part of the unit under test and is the only channel
 * that carries per-method positions — a node holds one position, and
 * `ApiRouteNodeData` is closed at four fields — so the cases about *where each
 * method is declared* go through here.
 *
 * @param project The prepared project.
 * @param file The project-relative POSIX path.
 * @returns The entry.
 */
function entryOf(project: PreparedProject, file: string): RouteEntry {
  const entry = routeEntryForFile(moduleOf(project, file), file);
  if (entry === undefined) {
    throw new Error(`${file} produced no route entry`);
  }
  return entry;
}

/**
 * The recorded location of one method handler, or a failure naming the methods
 * that were located.
 *
 * `methodLocations` is a *partial* record — a route that exports only `GET` has
 * one key — so the lookup is `SourceLocation | undefined` under
 * `noUncheckedIndexedAccess` and is narrowed here once.
 *
 * @param entry The route entry.
 * @param method The method whose handler location is wanted.
 * @returns The location.
 */
function methodLocation(entry: RouteEntry, method: HttpMethod): SourceLocation {
  const locations = entry.methodLocations;
  const location = locations?.[method];
  if (location === undefined) {
    throw new Error(
      `${entry.file} recorded no location for ${method}; it located ${Object.keys(locations ?? {}).join(', ')}`,
    );
  }
  return location;
}

/**
 * The text of one corpus file, read from where it lives.
 *
 * Read-only, and the source of every position expectation in this suite: the
 * cases locate an export in these bytes and convert the offset, rather than
 * carrying a line number that silently rots when the fixture is reformatted.
 *
 * @param file The project-relative POSIX path.
 * @returns The file's text.
 */
function corpusText(file: string): string {
  return readFileSync(joinPosix(FIXTURE_ROOT, file), 'utf8');
}

/**
 * One line of a corpus file, by 1-based line number.
 *
 * @param file The project-relative POSIX path.
 * @param line The 1-based line number.
 * @returns The line's text, without its terminator.
 */
function corpusLine(file: string, line: number): string {
  const lines = corpusText(file).split('\n');
  const text = lines[line - 1];
  if (text === undefined) {
    throw new Error(`${file} has no line ${String(line)}; it has ${String(lines.length)}`);
  }
  return text;
}

/** A 1-based position in a file's text, converted from a character offset. */
interface TextPosition {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;

  /** The character offset the match starts at. */
  readonly offset: number;
}

/**
 * Locates the one occurrence of a needle in a file's text and converts its
 * offset to a 1-based line and column.
 *
 * Uniqueness is asserted rather than assumed: a needle that matches twice would
 * make the position expectation ambiguous and the case meaningless, and a needle
 * that matches nothing means the fixture changed shape and the case must be
 * re-read rather than silently passing.
 *
 * @param text The file's text.
 * @param needle The exact substring to locate.
 * @returns The position of the match.
 */
function positionOf(text: string, needle: string): TextPosition {
  const offset = text.indexOf(needle);
  expect(offset, `the fixture no longer contains ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(
    0,
  );
  expect(
    text.indexOf(needle, offset + 1),
    `${JSON.stringify(needle)} occurs more than once, so its position is ambiguous`,
  ).toBe(-1);

  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');

  return {
    line: before.split('\n').length,
    column: offset - lastBreak,
    offset,
  };
}

/**
 * Asserts that a location is one the route map produced and passed through
 * untouched.
 *
 * Three things at once, because they are one property: the provenance is
 * `route-map` and not the `code-graph` the rest of this package stamps, the
 * confidence is that route's default from `@debuggen/shared` rather than a
 * number invented here, and the whole value satisfies the shared schema — which
 * is what a panel's `sourceLink` and a captured event's `source` are validated
 * against downstream.
 *
 * @param location The location to check.
 * @param what What the location belongs to, for the failure message.
 */
function expectRouteMapLocation(location: SourceLocation, what: string): void {
  expect(location.resolvedBy, `${what} must keep the route-map provenance`).toBe('route-map');
  expect(location.confidence, `${what} must carry the route-map default confidence`).toBe(
    DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
  );

  const parsed = parseSourceLocation(location);
  expect(parsed.ok, `${what} must satisfy the shared SourceLocation schema`).toBe(true);
  expect(isSafeRelativePath(location.file), `${what} must name a safe relative path`).toBe(true);
  expect(location.line).toBeGreaterThanOrEqual(1);
  expect(location.column).toBeGreaterThanOrEqual(1);
}

/** One log record a {@link recordingLogger} captured. */
interface RecordedLog {
  /** The severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message text. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/**
 * A logger that records instead of printing, plus the list it records into.
 *
 * Used by the one case that is about a log line: a route module exporting no
 * handler is a *finding*, and the extractor's documented channel for it is a
 * `warn` beside the node — not an `IndexDiagnostic`, because the diagnostic
 * vocabulary is closed and none of its codes means "an extractor found
 * something odd".
 *
 * @returns The logger and the records it will collect.
 */
function recordingLogger(): { readonly logger: Logger; readonly records: readonly RecordedLog[] } {
  const records: RecordedLog[] = [];
  const capture =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
    child: () => logger,
  };

  return { logger, records };
}

/**
 * The single diagnostic a result must carry, or a failure naming what it
 * carried instead.
 *
 * @param result The extraction result.
 * @returns The diagnostic.
 */
function onlyDiagnostic(result: ExtractorResult): IndexDiagnostic {
  const diagnostics = result.diagnostics ?? [];
  expect(diagnostics.length, 'exactly one diagnostic was expected').toBe(1);

  const diagnostic = diagnostics[0];
  if (diagnostic === undefined) {
    throw new Error('the result carried no diagnostic');
  }
  return diagnostic;
}

/**
 * A module handle whose export reading throws, for the one failure path this
 * extractor has.
 *
 * Fault injection rather than a broken file, because ts-morph's parser is
 * error-tolerant: a module with unparseable syntax still answers
 * `getFunctions()` (with whatever it recovered), so a *file* cannot exercise
 * the `catch`. What can is a handle that refuses to be read, which is the
 * observable shape of every real cause of that branch.
 *
 * @param sourceFile The real module to wrap.
 * @param thrown The error reading must throw.
 * @returns A handle that behaves like the module until its functions are read.
 */
function unreadable(sourceFile: SourceFile, thrown: Error): SourceFile {
  return new Proxy(sourceFile, {
    get(target, property, receiver) {
      if (property === 'getFunctions') {
        return (): never => {
          throw thrown;
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** One file of a tree, with the two fields that change when something writes to it. */
interface FileStamp {
  /** The path, relative to the stamped root, POSIX. */
  readonly file: string;

  /** The size in bytes. */
  readonly size: number;

  /** The modification time in epoch milliseconds. */
  readonly mtimeMs: number;
}

/**
 * Stamps every file of a tree, recursively, in sorted order.
 *
 * The evidence for "extraction writes nothing": a run that created, removed,
 * rewrote or even touched a file changes this list.
 *
 * @param root The absolute root to walk.
 * @returns One stamp per file, sorted by path.
 */
function stampTree(root: string): readonly FileStamp[] {
  const stamps: FileStamp[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      const stats = statSync(absolute);
      stamps.push({ file: toPosix(relative), size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };

  walk(root, '');
  stamps.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));

  return stamps;
}

/* -------------------------------------------------------------------------------------------------
 * The scratch project: the router shapes the corpus does not hold
 * ---------------------------------------------------------------------------------------------- */

/** An App Router handler exporting its method as an arrow-const. */
const SCRATCH_ARROW_HANDLER = 'app/api/arrow/route.ts';

/** An App Router handler exporting one handler for every declarable method. */
const SCRATCH_EVERY_METHOD_HANDLER = 'app/api/every/route.ts';

/** An App Router handler module that exports no request handler at all. */
const SCRATCH_SILENT_HANDLER = 'app/api/silent/route.ts';

/** An App Router handler module whose syntax does not parse. */
const SCRATCH_BROKEN_HANDLER = 'app/api/broken/route.ts';

/** A legacy API module whose default export is spelled as an export clause. */
const SCRATCH_ALIASED_DEFAULT = 'pages/api/aliased.ts';

/** A page below an optional catch-all segment. */
const SCRATCH_OPTIONAL_CATCH_ALL = 'app/[[...slug]]/page.tsx';

/** A handler module below a private folder, which serves no URL. */
const SCRATCH_PRIVATE_FOLDER = 'app/_internals/route.ts';

/** A page below a parallel-route slot. */
const SCRATCH_PARALLEL_SLOT = 'app/@panel/page.tsx';

/** The legacy router's `index` page, which collapses to its parent path. */
const SCRATCH_INDEX_PAGE = 'pages/index.tsx';

/**
 * The App Router's special files and the Pages Router's reserved modules.
 *
 * None of them serves a URL, and the rule that says so lives in
 * `deriveRouteFromFile` — this list is the input that proves the extractor
 * respects it rather than re-implementing it.
 */
const SCRATCH_SPECIAL_FILES: readonly string[] = [
  'app/layout.tsx',
  'app/loading.tsx',
  'app/error.tsx',
  'app/not-found.tsx',
  'app/template.tsx',
  'app/default.tsx',
  'pages/_app.tsx',
  'pages/_document.tsx',
];

/**
 * A minimal page module: a default export and nothing else.
 *
 * Deliberately no JSX — the scratch project installs nothing, and the route
 * conventions under test are decided by the file's *path* and its export
 * names, never by what the component renders.
 */
const PAGE_MODULE = 'export default function Screen() {\n  return null;\n}\n';

/**
 * The scratch project's files, keyed by project-relative POSIX path.
 *
 * Every module is the smallest thing that has the shape under test, with
 * neutral identifiers: the shape is the subject, and a name borrowed from an
 * application under test would suggest otherwise.
 */
const SCRATCH_FILES: Readonly<Record<string, string>> = {
  // Its own minimal configuration, because `../project.ts` builds the ts-morph
  // program from the *target* project's tsconfig and the cases must exercise
  // that path rather than a synthesised in-memory one.
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        strict: true,
        noEmit: true,
        allowJs: true,
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    },
    undefined,
    2,
  )}\n`,

  [SCRATCH_ARROW_HANDLER]: `export const ${GET_METHOD} = async () => new Response(null);\n`,

  // Generated from the vocabulary rather than listed, so "every method" means
  // whatever `HTTP_METHOD_NAMES` currently holds — including `ANY`, which is a
  // report and not an export and must therefore be ignored.
  [SCRATCH_EVERY_METHOD_HANDLER]: HTTP_METHOD_NAMES.map(
    (method) => `export function ${method}() {\n  return new Response(null);\n}\n`,
  ).join('\n'),

  // Exports something, just never a handler: the documented finding is a node
  // with no methods, not a missing route.
  [SCRATCH_SILENT_HANDLER]: 'export const revalidate = 0;\n',

  // Truncated mid-signature: the parser recovers, so this must not throw.
  [SCRATCH_BROKEN_HANDLER]: `export async function ${GET_METHOD}(\n`,

  [SCRATCH_ALIASED_DEFAULT]:
    'async function handler() {\n  return undefined;\n}\n\nexport { handler as default };\n',

  [SCRATCH_OPTIONAL_CATCH_ALL]: PAGE_MODULE,
  [SCRATCH_PRIVATE_FOLDER]: `export function ${GET_METHOD}() {\n  return new Response(null);\n}\n`,
  [SCRATCH_PARALLEL_SLOT]: PAGE_MODULE,
  [SCRATCH_INDEX_PAGE]: PAGE_MODULE,

  ...Object.fromEntries(SCRATCH_SPECIAL_FILES.map((file) => [file, PAGE_MODULE])),
};

/**
 * Writes the scratch project into a fresh temporary directory.
 *
 * Outside every checkout and outside `$DEBUGGEN_HOME`: a suite must not leave
 * anything in either, and `afterAll` removes exactly the directory this
 * returned.
 *
 * @returns The absolute POSIX root of the new project.
 */
function createScratchProject(): string {
  const root = toPosix(mkdtempSync(join(tmpdir(), 'debuggen-api-routes-')));

  for (const [file, text] of Object.entries(SCRATCH_FILES)) {
    const absolute = join(root, file);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }

  return root;
}

/**
 * The scratch project's root.
 *
 * @returns The absolute POSIX root of the scratch project.
 */
function scratchRootPath(): string {
  if (scratchRoot === undefined) {
    throw new Error('the scratch project was not created; the beforeAll hook did not run');
  }
  return scratchRoot;
}

/**
 * The authored text of one scratch module.
 *
 * Read from the table above rather than back off disk: the table *is* the
 * source of truth for those files, and a position expectation computed from it
 * therefore cannot disagree with what was written.
 *
 * @param file The project-relative POSIX path.
 * @returns The module's text.
 */
function scratchTextOf(file: string): string {
  const text = SCRATCH_FILES[file];
  if (text === undefined) {
    throw new Error(`${file} is not one of the scratch project's files`);
  }
  return text;
}

/* -------------------------------------------------------------------------------------------------
 * Setup
 * ---------------------------------------------------------------------------------------------- */

/** Whether the corpus opened, asserted by the first case rather than assumed. */
let corpusOpened = false;

// A 30 s ceiling, not a budget: this hook parses a program, which a loaded
// machine can push past the 10 s hook default and so fail every case below.
beforeAll(async () => {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });
  corpusOpened = opened.ok;
  if (!opened.ok) {
    throw new Error(`the corpus did not open: ${opened.error.message}`);
  }
  openedCorpus = prepare(opened.value);

  // One full index, with every default extractor, because the round-trip group
  // needs the `api-route` nodes *this* extractor contributed to a real index —
  // a hand-made node would prove the round trip against itself.
  const built = await buildIndex(opened.value);
  if (!built.ok) {
    throw new Error(`the corpus index was not built: ${built.error.message}`);
  }
  corpusIndex = built.value;

  // The compiler-built map the index-rebuilt one must agree with.
  corpusRouteMap = buildRouteMap(opened.value);

  scratchRoot = createScratchProject();
  scratchProject = openPrepared(scratchRoot);
}, 30_000);

afterAll(() => {
  if (scratchRoot !== undefined) {
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  }
  scratchProject = undefined;
});

describe('the corpus this suite reads', () => {
  it('opens through openProject and holds every module the groups below name', () => {
    expect(corpusOpened, 'openProject must answer Ok for the committed corpus').toBe(true);
    expect(corpus().loaded.projectRoot).toBe(FIXTURE_ROOT);

    for (const file of [...CORPUS_ROUTE_FILES, ROOT_LAYOUT]) {
      expect(corpus().files.has(file), `${file} must be in the opened file set`).toBe(true);
    }
  });

  it('runs this extractor as part of the default set', () => {
    // The round-trip group resolves URLs out of an index built by `buildIndex`,
    // which runs `DEFAULT_EXTRACTORS`. If this extractor were not among them the
    // index would hold no `api-route` node and that group would be asserting
    // that two empty maps agree.
    expect(apiRoutesExtractor.id).toBe(API_ROUTES_EXTRACTOR_ID);
    expect(DEFAULT_EXTRACTORS.map((extractor) => extractor.id)).toContain(API_ROUTES_EXTRACTOR_ID);
    expect(HTTP_METHOD_NAMES).toContain(ANY_METHOD);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 1. App Router handler modules
 * ---------------------------------------------------------------------------------------------- */

describe('App Router handler modules', () => {
  it('yields one node per module, never one per method', () => {
    // `oneRouteNode` asserts the count itself, so reaching for the node of the
    // two-method module *is* the assertion: a second node for `POST` would make
    // the index-backed route map disagree with the freshly built one.
    const node = oneRouteNode(corpus(), MULTI_METHOD_HANDLER);

    expect(node.kind).toBe('api-route');
    expect(node.file).toBe(MULTI_METHOD_HANDLER);
    expect(node.name).toBe(node.data.routePath);
    expect(node.exported).toBe(true);
    expect(node.id).toBe(
      makeNodeId({
        kind: 'api-route',
        file: MULTI_METHOD_HANDLER,
        name: node.data.routePath,
        line: node.line,
        column: node.column,
      }),
    );
  });

  it('reports both exported methods, in source order', () => {
    const node = oneRouteNode(corpus(), MULTI_METHOD_HANDLER);
    const text = corpusText(MULTI_METHOD_HANDLER);
    const get = positionOf(text, `export async function ${GET_METHOD}(`);
    const post = positionOf(text, `export async function ${POST_METHOD}(`);

    // The documented order is the order the handlers are *exported in*, so the
    // expectation is computed from where they appear in the file rather than
    // written down: swapping the two declarations in the fixture must swap the
    // reported methods, and a run that sorted them alphabetically must fail.
    const bySourceOrder = [
      { method: GET_METHOD, offset: get.offset },
      { method: POST_METHOD, offset: post.offset },
    ]
      .sort((left, right) => left.offset - right.offset)
      .map((handler) => handler.method);

    expect(node.data.methods).toEqual(bySourceOrder);
    expect(node.data.methods).toEqual([GET_METHOD, POST_METHOD]);
  });

  it('locates every exported method at its own declaration', () => {
    const entry = entryOf(corpus(), MULTI_METHOD_HANDLER);
    const text = corpusText(MULTI_METHOD_HANDLER);
    const get = positionOf(text, `export async function ${GET_METHOD}(`);
    const post = positionOf(text, `export async function ${POST_METHOD}(`);
    const getLocation = methodLocation(entry, GET_METHOD);
    const postLocation = methodLocation(entry, POST_METHOD);

    expect(Object.keys(entry.methodLocations ?? {}).sort()).toEqual(
      [GET_METHOD, POST_METHOD].sort(),
    );

    expect(getLocation.line).toBe(get.line);
    expect(getLocation.column).toBe(get.column);
    expect(getLocation.symbol).toBe(GET_METHOD);

    expect(postLocation.line).toBe(post.line);
    expect(postLocation.column).toBe(post.column);
    expect(postLocation.symbol).toBe(POST_METHOD);

    // Its *own* position: one location shared by both methods would send a
    // developer who clicked "POST" to the wrong function.
    expect(getLocation.line).not.toBe(postLocation.line);

    // The declaration line is also the line the method identifier is written
    // on, which is what makes "where is the POST handler" answerable.
    expect(getLocation.line).toBe(positionOf(text, `function ${GET_METHOD}(`).line);
    expect(postLocation.line).toBe(positionOf(text, `function ${POST_METHOD}(`).line);

    expectRouteMapLocation(getLocation, `${MULTI_METHOD_HANDLER} ${GET_METHOD}`);
    expectRouteMapLocation(postLocation, `${MULTI_METHOD_HANDLER} ${POST_METHOD}`);
  });

  it('opens the node at the first handler declaration in source order', () => {
    const node = oneRouteNode(corpus(), MULTI_METHOD_HANDLER);
    const entry = entryOf(corpus(), MULTI_METHOD_HANDLER);
    const get = positionOf(
      corpusText(MULTI_METHOD_HANDLER),
      `export async function ${GET_METHOD}(`,
    );

    expect(node.line).toBe(get.line);
    expect(node.column).toBe(get.column);
    expect(node.symbol).toBe(GET_METHOD);
    expect(node.endLine).toBe(entry.location.endLine);
    expect(node.line).toBe(entry.location.line);
    expect(node.column).toBe(entry.location.column);
  });

  it('records the dynamic parameter of the [id] handler module', () => {
    const node = oneRouteNode(corpus(), DYNAMIC_HANDLER);
    const derived = deriveRouteFromFile(DYNAMIC_HANDLER);

    expect(node.data.methods).toEqual([GET_METHOD]);
    expect(derived?.dynamicParams).toEqual(['id']);
    expect(derived?.isCatchAll).toBe(false);
    expect(derived?.isOptionalCatchAll).toBe(false);

    // The route path carries the dynamic segment in exactly the bracket form
    // the derivation reports — this suite never spells a URL the derivation
    // owns.
    expect(node.data.routePath).toBe(derived?.routePath);
    expect(node.data.routePath).toContain('[id]');
  });

  it('drops the route group and keeps the catch-all of the grouped handler module', () => {
    const node = oneRouteNode(corpus(), GROUPED_CATCH_ALL_HANDLER);
    const derived = deriveRouteFromFile(GROUPED_CATCH_ALL_HANDLER);

    expect(node.data.methods).toEqual([GET_METHOD]);
    expect(node.data.routePath).toBe(derived?.routePath);

    // The case a locally re-implemented derivation gets wrong: the URL omits
    // the group while the file that serves it keeps the directory.
    expect(node.data.routePath).not.toContain('(observatory)');
    expect(node.data.routePath).not.toContain('(');
    expect(node.data.routePath).toContain('[...segments]');
    expect(node.file).toBe(GROUPED_CATCH_ALL_HANDLER);
    expect(node.file).toContain('(observatory)');

    expect(derived?.isCatchAll).toBe(true);
    expect(derived?.isOptionalCatchAll).toBe(false);
    expect(derived?.dynamicParams).toEqual(['segments']);
  });

  it('reports the App Router and the handler kind for every one of them', () => {
    for (const file of [MULTI_METHOD_HANDLER, DYNAMIC_HANDLER, GROUPED_CATCH_ALL_HANDLER]) {
      const node = oneRouteNode(corpus(), file);

      expect(node.data.router, `${file} router`).toBe(APP_ROUTER);
      expect(ROUTER_KINDS, `${file} router`).toContain(node.data.router);
      expect(node.data.kind, `${file} route kind`).toBe(HANDLER_KIND);
      expect(API_ROUTE_KINDS, `${file} route kind`).toContain(node.data.kind);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The legacy Pages Router module
 * ---------------------------------------------------------------------------------------------- */

describe('the legacy Pages Router API module', () => {
  it('reports the single dispatching method and invents no named handler', () => {
    const node = oneRouteNode(corpus(), LEGACY_HANDLER);

    // One default-exported function dispatching on `req.method` answers every
    // method through one entry point, so there is nothing per-method to
    // enumerate and `ANY` is the whole of it.
    expect(node.data.methods).toEqual([ANY_METHOD]);
    expect(node.data.router).toBe(PAGES_ROUTER);
    expect(ROUTER_KINDS).toContain(node.data.router);
    expect(node.data.kind).toBe(HANDLER_KIND);

    for (const method of EXPORTABLE_METHODS) {
      expect(node.data.methods, `${LEGACY_HANDLER} must not report ${method}`).not.toContain(
        method,
      );
    }

    // A named method export is not a convention of this router, so there is no
    // per-method position to record either.
    expect(entryOf(corpus(), LEGACY_HANDLER).methodLocations).toBeUndefined();
  });

  it('opens at the default export rather than at the top of the file', () => {
    const node = oneRouteNode(corpus(), LEGACY_HANDLER);
    const declaration = positionOf(corpusText(LEGACY_HANDLER), 'export default async function ');

    expect(node.line).toBe(declaration.line);
    expect(node.column).toBe(declaration.column);
    expect(node.line).toBeGreaterThan(1);

    // The recorded symbol is the function the module default-exports, read back
    // out of the line the node points at rather than written down here.
    const line = corpusLine(LEGACY_HANDLER, node.line);
    expect(node.symbol).toBeDefined();
    expect(line).toContain(`function ${node.symbol ?? ''}(`);
  });

  it('derives the legacy URL from the module path', () => {
    const node = oneRouteNode(corpus(), LEGACY_HANDLER);
    const derived = deriveRouteFromFile(LEGACY_HANDLER);

    expect(node.data.routePath).toBe(derived?.routePath);
    expect(derived?.router).toBe(PAGES_ROUTER);
    expect(derived?.kind).toBe(HANDLER_KIND);
    expect(derived?.dynamicParams).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. Page modules, and the special file that is not one
 * ---------------------------------------------------------------------------------------------- */

describe('page modules', () => {
  it('resolves the root App Router page to the root path', () => {
    const node = oneRouteNode(corpus(), ROOT_PAGE);
    const derived = deriveRouteFromFile(ROOT_PAGE);
    const declaration = positionOf(corpusText(ROOT_PAGE), 'export default function ');

    expect(node.data.kind).toBe(PAGE_KIND);
    expect(API_ROUTE_KINDS).toContain(node.data.kind);
    expect(node.data.router).toBe(APP_ROUTER);
    expect(node.data.routePath).toBe('/');
    expect(node.data.routePath).toBe(derived?.routePath);

    // A page answers a document request, which is a GET whether or not this
    // module could find the component that renders it.
    expect(node.data.methods).toEqual([GET_METHOD]);

    expect(node.line).toBe(declaration.line);
    expect(node.column).toBe(declaration.column);
    expect(corpusLine(ROOT_PAGE, node.line)).toContain(`function ${node.symbol ?? ''}(`);
  });

  it('drops the group and keeps the dynamic segment of the grouped page', () => {
    const node = oneRouteNode(corpus(), GROUPED_DYNAMIC_PAGE);
    const derived = deriveRouteFromFile(GROUPED_DYNAMIC_PAGE);

    expect(node.data.kind).toBe(PAGE_KIND);
    expect(node.data.router).toBe(APP_ROUTER);
    expect(node.data.methods).toEqual([GET_METHOD]);
    expect(node.data.routePath).toBe(derived?.routePath);
    expect(node.data.routePath).not.toContain('(observatory)');
    expect(node.data.routePath).toContain('[id]');
    expect(node.file).toContain('(observatory)');
    expect(derived?.dynamicParams).toEqual(['id']);
  });

  it('yields nothing at all for the root layout', () => {
    const result = extract(corpus(), ROOT_LAYOUT);

    // The special-file rule lives in `deriveRouteFromFile`, and this extractor's
    // whole response to it is to emit nothing: not a node with an empty method
    // list, not a diagnostic.
    expect(deriveRouteFromFile(ROOT_LAYOUT)).toBeUndefined();
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. Delegation to ../route-map.ts, and the index-backed round trip
 * ---------------------------------------------------------------------------------------------- */

/** One request the two route maps must answer identically. */
interface RoundTripRequest {
  /** The URL or bare pathname to resolve. */
  readonly url: string;

  /** The method to require, where the case is about method filtering. */
  readonly method?: HttpMethod;

  /** The corpus file that must answer it. */
  readonly file: string;
}

/**
 * One request per corpus route, including a catch-all with several trailing
 * segments and both methods of the two-method module.
 *
 * The URLs are fixture data — the corpus invented these paths — and each one is
 * pinned to the file that must answer it, so a typo fails loudly instead of
 * making both maps agree that nothing resolves.
 */
const ROUND_TRIP_REQUESTS: readonly RoundTripRequest[] = [
  { url: '/', file: ROOT_PAGE },
  { url: '/api/gauges', method: GET_METHOD, file: MULTI_METHOD_HANDLER },
  { url: '/api/gauges', method: POST_METHOD, file: MULTI_METHOD_HANDLER },
  { url: '/api/gauges/north-01', method: GET_METHOD, file: DYNAMIC_HANDLER },
  { url: '/api/basins/north/deep/west', method: GET_METHOD, file: GROUPED_CATCH_ALL_HANDLER },
  { url: '/basins/7', file: GROUPED_DYNAMIC_PAGE },
  // `ANY` matches every method, which is what makes a legacy module answer a
  // POST it dispatches internally.
  { url: '/api/gauge-log', method: POST_METHOD, file: LEGACY_HANDLER },
];

describe('delegation to ../route-map.ts', () => {
  it('covers exactly the corpus files that serve a URL', () => {
    // Without this case the delegation loop below could be vacuous: a corpus
    // file that started serving a URL, or stopped, would go unnoticed.
    const serving = [...corpus().files.keys()].filter(
      (file) => deriveRouteFromFile(file) !== undefined,
    );

    expect([...serving].sort()).toEqual([...CORPUS_ROUTE_FILES].sort());
  });

  it('agrees with deriveRouteFromFile on every file of the corpus', () => {
    for (const file of corpus().files.keys()) {
      const derived = deriveRouteFromFile(file);
      const result = extract(corpus(), file);

      if (derived === undefined) {
        // The derivation's `undefined` is final: a component, a service, a
        // configuration module, a special file.
        expect(result.nodes, `${file} serves no URL and must yield no node`).toEqual([]);
        expect(result.edges, `${file}`).toEqual([]);
        expect(result.diagnostics, `${file}`).toBeUndefined();
        continue;
      }

      const node = oneRouteNode(corpus(), file);

      expect(node.data.routePath, `${file} route path`).toBe(derived.routePath);
      expect(node.data.router, `${file} router`).toBe(derived.router);
      expect(node.data.kind, `${file} route kind`).toBe(derived.kind);
      expect(node.file, `${file} node file`).toBe(derived.file);
      expect(node.name, `${file} node name`).toBe(derived.routePath);
    }
  });

  it('passes every route-map location through unchanged', () => {
    for (const file of CORPUS_ROUTE_FILES) {
      const entry = entryOf(corpus(), file);
      const node = oneRouteNode(corpus(), file);

      // `resolvedBy: 'route-map'` with that route's default confidence — never
      // re-minted as `code-graph`, which is what the rest of this package
      // stamps — and valid against the shared schema.
      expectRouteMapLocation(entry.location, `${file} route location`);
      expect(entry.location.file).toBe(file);

      // The node's position fields are that location, field for field.
      expect(node.line, `${file} line`).toBe(entry.location.line);
      expect(node.column, `${file} column`).toBe(entry.location.column);
      expect(node.symbol, `${file} symbol`).toBe(entry.location.symbol);
      expect(node.endLine, `${file} end line`).toBe(entry.location.endLine);

      for (const [method, location] of Object.entries(entry.methodLocations ?? {})) {
        expectRouteMapLocation(location, `${file} ${method} location`);
        expect(location.file).toBe(file);
      }
    }
  });

  it('contributes to a real index exactly the nodes a direct extraction produces', () => {
    const indexed = index().nodes.filter(
      (node): node is CodeNodeOf<'api-route'> => node.kind === 'api-route',
    );
    const direct = CORPUS_ROUTE_FILES.map((file) => oneRouteNode(corpus(), file));

    expect([...indexed].map((node) => node.id).sort()).toEqual(
      [...direct].map((node) => node.id).sort(),
    );

    // Field for field, after the round trip through graph construction: an id
    // that survives while a payload is rewritten would still break the
    // index-backed route map.
    for (const node of direct) {
      expect(indexed.find((candidate) => candidate.id === node.id)).toEqual(node);
    }
  });

  it('re-derives segments, parameters and catch-all flags from the node payload alone', () => {
    const fromIndex = routeMapFromIndex(index());

    expect([...fromIndex.entries].map((entry) => entry.file).sort()).toEqual(
      [...CORPUS_ROUTE_FILES].sort(),
    );

    for (const file of CORPUS_ROUTE_FILES) {
      const derived = deriveRouteFromFile(file);
      const rebuilt = fromIndex.entries.find((entry) => entry.file === file);
      const node = oneRouteNode(corpus(), file);

      expect(rebuilt, `${file} must be rebuilt from the index`).toBeDefined();
      if (rebuilt === undefined) {
        continue;
      }

      expect(rebuilt.routePath, `${file} route path`).toBe(derived?.routePath);
      expect(rebuilt.router, `${file} router`).toBe(derived?.router);
      expect(rebuilt.kind, `${file} route kind`).toBe(derived?.kind);
      expect(rebuilt.methods, `${file} methods`).toEqual(node.data.methods);

      // Segments, parameters and the catch-all flags are *not* stored on the
      // node: they are re-parsed from the route path, which is only possible
      // because that path already had its groups stripped.
      expect(rebuilt.segments, `${file} segments`).toEqual(derived?.segments);
      expect(rebuilt.dynamicParams, `${file} dynamic parameters`).toEqual(derived?.dynamicParams);
      expect(rebuilt.isCatchAll, `${file} catch-all`).toBe(derived?.isCatchAll);
      expect(rebuilt.isOptionalCatchAll, `${file} optional catch-all`).toBe(
        derived?.isOptionalCatchAll,
      );

      // The whole location, not a field of it: this is where a position field
      // missing from the node payload becomes visible.
      expectRouteMapLocation(rebuilt.location, `${file} rebuilt location`);
      expect(rebuilt.location).toEqual(entryOf(corpus(), file).location);
    }
  });

  it('resolves every corpus request identically through both route maps', () => {
    const fromIndex = routeMapFromIndex(index());
    const fromProject = routeMap();

    expect([...fromIndex.entries].map((entry) => entry.routePath)).toEqual(
      [...fromProject.entries].map((entry) => entry.routePath),
    );

    for (const request of ROUND_TRIP_REQUESTS) {
      const expected = fromProject.resolve(request.url, request.method);
      const actual = fromIndex.resolve(request.url, request.method);

      expect(expected?.entry.file, `${request.url} must resolve to ${request.file}`).toBe(
        request.file,
      );
      expect(actual?.entry.file, `${request.url} through the index`).toBe(expected?.entry.file);
      expect(actual?.entry.routePath, `${request.url} route path`).toBe(expected?.entry.routePath);
      expect(actual?.entry.router, `${request.url} router`).toBe(expected?.entry.router);
      expect(actual?.entry.kind, `${request.url} route kind`).toBe(expected?.entry.kind);
      expect(actual?.entry.methods, `${request.url} methods`).toEqual(expected?.entry.methods);
      expect(actual?.params, `${request.url} parameters`).toEqual(expected?.params);
      expect(actual?.pathname, `${request.url} pathname`).toBe(expected?.pathname);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. Router shapes the corpus does not hold
 * ---------------------------------------------------------------------------------------------- */

describe('router shapes the corpus does not hold', () => {
  it('recognises a handler exported as an arrow-const', () => {
    const node = oneRouteNode(scratch(), SCRATCH_ARROW_HANDLER);
    const entry = entryOf(scratch(), SCRATCH_ARROW_HANDLER);
    const declaration = positionOf(
      scratchTextOf(SCRATCH_ARROW_HANDLER),
      `export const ${GET_METHOD} =`,
    );

    // What makes an export a handler is its *name*, not the shape of its
    // initialiser, so the arrow form is a handler exactly as a declaration is.
    expect(node.data.methods).toEqual([GET_METHOD]);
    expect(node.data.router).toBe(APP_ROUTER);
    expect(node.data.kind).toBe(HANDLER_KIND);
    expect(node.data.routePath).toBe(deriveRouteFromFile(SCRATCH_ARROW_HANDLER)?.routePath);

    // Located at the statement's `export` keyword, which is where a developer
    // who clicked the method expects to land.
    const location = methodLocation(entry, GET_METHOD);
    expect(location.line).toBe(declaration.line);
    expect(location.column).toBe(declaration.column);
    expectRouteMapLocation(location, `${SCRATCH_ARROW_HANDLER} ${GET_METHOD}`);
  });

  it('records every declarable method of the vocabulary, and never the dispatching report', () => {
    const node = oneRouteNode(scratch(), SCRATCH_EVERY_METHOD_HANDLER);
    const entry = entryOf(scratch(), SCRATCH_EVERY_METHOD_HANDLER);
    const text = scratchTextOf(SCRATCH_EVERY_METHOD_HANDLER);

    // The module exports one handler per member of `HTTP_METHOD_NAMES`,
    // including `ANY` — which is a report and not an HTTP method, so exporting
    // it declares nothing and must be ignored.
    expect(node.data.methods).toEqual(EXPORTABLE_METHODS);
    expect(node.data.methods).not.toContain(ANY_METHOD);
    expect(node.data.methods.length).toBe(HTTP_METHOD_NAMES.length - 1);

    expect([...Object.keys(entry.methodLocations ?? {})].sort()).toEqual(
      [...EXPORTABLE_METHODS].sort(),
    );

    for (const method of EXPORTABLE_METHODS) {
      const location = methodLocation(entry, method);
      expect(location.line, `${method} line`).toBe(
        positionOf(text, `export function ${method}(`).line,
      );
      expect(location.symbol, `${method} symbol`).toBe(method);
      expectRouteMapLocation(location, `${SCRATCH_EVERY_METHOD_HANDLER} ${method}`);
    }
  });

  it('still emits the node of a handler module that exports no handler', () => {
    expect(() => extract(scratch(), SCRATCH_SILENT_HANDLER)).not.toThrow();

    const node = oneRouteNode(scratch(), SCRATCH_SILENT_HANDLER);
    const derived = deriveRouteFromFile(SCRATCH_SILENT_HANDLER);

    // The documented finding: the module still serves its URL, so dropping the
    // node would hide the route instead of reporting the gap.
    expect(node.data.methods).toEqual([]);
    expect(node.data.routePath).toBe(derived?.routePath);
    expect(node.data.router).toBe(APP_ROUTER);
    expect(node.data.kind).toBe(HANDLER_KIND);

    // Its handler could not be located, so the route opens at the start of the
    // file and names no symbol.
    expect(node.line).toBe(1);
    expect(node.column).toBe(1);
    expect(node.symbol).toBeUndefined();
    expect(node.endLine).toBeUndefined();
    expect(entryOf(scratch(), SCRATCH_SILENT_HANDLER).methodLocations).toBeUndefined();
  });

  it('reports that gap as a log line rather than as a diagnostic', () => {
    const { logger, records } = recordingLogger();
    const result = apiRoutesExtractor.extract({
      ...contextFor(scratch(), SCRATCH_SILENT_HANDLER),
      logger,
    });

    expect(result.diagnostics).toBeUndefined();

    const warnings = records.filter((record) => record.level === 'warn');
    expect(warnings.length).toBe(1);

    const warning = warnings[0];
    expect(warning?.fields?.['file']).toBe(SCRATCH_SILENT_HANDLER);
    expect(warning?.fields?.['extractorId']).toBe(API_ROUTES_EXTRACTOR_ID);

    // Names things, quotes nothing: the same privacy constraint diagnostics
    // carry applies to an extractor's log fields.
    expect(warning?.message ?? '').not.toContain(scratchTextOf(SCRATCH_SILENT_HANDLER).trim());
  });

  it('recognises a legacy default export spelled as an export clause', () => {
    const node = oneRouteNode(scratch(), SCRATCH_ALIASED_DEFAULT);
    const declaration = positionOf(
      scratchTextOf(SCRATCH_ALIASED_DEFAULT),
      'async function handler(',
    );

    expect(node.data.methods).toEqual([ANY_METHOD]);
    expect(node.data.router).toBe(PAGES_ROUTER);
    expect(node.data.kind).toBe(HANDLER_KIND);
    expect(node.data.routePath).toBe(deriveRouteFromFile(SCRATCH_ALIASED_DEFAULT)?.routePath);

    // `export { handler as default }` makes the locally declared function the
    // module's default export, so the route opens at that declaration and the
    // recorded symbol is its name.
    expect(node.symbol).toBe('handler');
    expect(node.line).toBe(declaration.line);
    expect(node.column).toBe(declaration.column);
    expect(entryOf(scratch(), SCRATCH_ALIASED_DEFAULT).methodLocations).toBeUndefined();
  });

  it('follows the derivation for the optional catch-all, the private folder, the slot and index', () => {
    for (const file of [
      SCRATCH_OPTIONAL_CATCH_ALL,
      SCRATCH_PRIVATE_FOLDER,
      SCRATCH_PARALLEL_SLOT,
      SCRATCH_INDEX_PAGE,
    ]) {
      const derived = deriveRouteFromFile(file);
      const result = extract(scratch(), file);

      if (derived === undefined) {
        expect(result.nodes, `${file} serves no URL`).toEqual([]);
        expect(result.diagnostics, `${file}`).toBeUndefined();
        continue;
      }

      const node = oneRouteNode(scratch(), file);
      expect(node.data.routePath, `${file} route path`).toBe(derived.routePath);
      expect(node.data.router, `${file} router`).toBe(derived.router);
      expect(node.data.kind, `${file} route kind`).toBe(derived.kind);
      expect(node.name, `${file} node name`).toBe(derived.routePath);
      expect(node.file, `${file} node file`).toBe(file);
    }

    // The three properties the loop above is blind to, stated once and read
    // from the derivation rather than from an expectation of this suite: a
    // private folder serves nothing, the optional catch-all carries both flags,
    // and the parallel slot contributes no URL segment.
    expect(deriveRouteFromFile(SCRATCH_PRIVATE_FOLDER)).toBeUndefined();
    expect(deriveRouteFromFile(SCRATCH_OPTIONAL_CATCH_ALL)?.isCatchAll).toBe(true);
    expect(deriveRouteFromFile(SCRATCH_OPTIONAL_CATCH_ALL)?.isOptionalCatchAll).toBe(true);
    expect(oneRouteNode(scratch(), SCRATCH_OPTIONAL_CATCH_ALL).data.methods).toEqual([GET_METHOD]);
    expect(oneRouteNode(scratch(), SCRATCH_PARALLEL_SLOT).data.routePath).not.toContain('@');
  });

  it('yields no node for any App Router special file or reserved legacy module', () => {
    for (const file of SCRATCH_SPECIAL_FILES) {
      const result = extract(scratch(), file);

      expect(deriveRouteFromFile(file), `${file} must serve no URL`).toBeUndefined();
      expect(result.nodes, `${file} must yield no node`).toEqual([]);
      expect(result.edges, `${file}`).toEqual([]);
      expect(result.diagnostics, `${file}`).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6. Robustness, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

describe('robustness, purity and determinism', () => {
  it('produces deeply equal, identically ordered output on two consecutive runs', () => {
    for (const project of [corpus(), scratch()]) {
      for (const file of project.files.keys()) {
        const first = extract(project, file);
        const second = extract(project, file);

        expect(second, `${file} second run`).toEqual(first);
        // `toEqual` is blind to property and array order; the serialisation is
        // not, and an index whose node order drifts breaks its own cache key.
        expect(JSON.stringify(second), `${file} serialised`).toBe(JSON.stringify(first));
      }
    }
  });

  it('does not throw for a route module whose syntax does not parse', () => {
    expect(() => extract(scratch(), SCRATCH_BROKEN_HANDLER)).not.toThrow();

    const node = oneRouteNode(scratch(), SCRATCH_BROKEN_HANDLER);

    // The parser recovers rather than failing, and the truncated declaration is
    // not a handler it can offer — so the outcome is the documented "no handler
    // located" finding, at the start of the file, for a route that still exists.
    expect(node.data.methods).toEqual([]);
    expect(node.data.routePath).toBe(deriveRouteFromFile(SCRATCH_BROKEN_HANDLER)?.routePath);
    expect(node.line).toBe(1);

    // And its siblings are unaffected: one unreadable module must not cost the
    // index every other route of the project.
    expect(oneRouteNode(scratch(), SCRATCH_ARROW_HANDLER).data.methods).toEqual([GET_METHOD]);
    expect(oneRouteNode(scratch(), SCRATCH_EVERY_METHOD_HANDLER).data.methods).toEqual(
      EXPORTABLE_METHODS,
    );
    expect(oneRouteNode(scratch(), SCRATCH_ALIASED_DEFAULT).data.methods).toEqual([ANY_METHOD]);
  });

  it('reports a module it cannot read as one extractor-failed diagnostic that quotes no source', () => {
    // A message that embeds the offending source text is the leak nobody
    // notices: diagnostics are logged, persisted with a session and can reach
    // model prompt context (AAP §0.5.2).
    const thrown = new SyntaxError(`export async function ${GET_METHOD}(secretToken: string) {}`);
    const result = apiRoutesExtractor.extract({
      ...contextFor(scratch(), SCRATCH_ARROW_HANDLER),
      sourceFile: unreadable(moduleOf(scratch(), SCRATCH_ARROW_HANDLER), thrown),
    });
    const diagnostic = onlyDiagnostic(result);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);

    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe(EXTRACTOR_FAILED);
    expect(INDEX_DIAGNOSTIC_CODES).toContain(diagnostic.code);
    expect(diagnostic.file).toBe(SCRATCH_ARROW_HANDLER);
    expect(diagnostic.extractorId).toBe(API_ROUTES_EXTRACTOR_ID);

    // The error's class is named — that is what makes the finding actionable —
    // and its message, which is where source text lives, is not.
    expect(diagnostic.message).toContain('SyntaxError');
    expect(diagnostic.message).not.toContain(thrown.message);
    expect(diagnostic.message).not.toContain('secretToken');
    expect(diagnostic.message).not.toContain(scratchTextOf(SCRATCH_ARROW_HANDLER).trim());
    expect(diagnostic.detail).toBeUndefined();
  });

  it('writes nothing, in the scratch project or in the committed corpus', () => {
    const scratchBefore = stampTree(scratchRootPath());
    const corpusBefore = stampTree(FIXTURE_ROOT);

    for (const project of [corpus(), scratch()]) {
      for (const file of project.files.keys()) {
        extract(project, file);
      }
    }

    // Same file set, same sizes, same modification times: the extractor reads
    // one abstract syntax tree and touches nothing, which is also why a run of
    // this suite leaves `git status --porcelain packages/code-analysis` empty.
    expect(stampTree(scratchRootPath())).toEqual(scratchBefore);
    expect(stampTree(FIXTURE_ROOT)).toEqual(corpusBefore);
  });

  it('emits no edges at all, from any file of either project', () => {
    // The `calls` linkage from a route into the service layer belongs to
    // `./server-functions.ts`, `routes-to` is derived during graph assembly from
    // two nodes, and resolving `references` is the lazy resolver's job — so the
    // only correct edge list here is the empty one.
    for (const project of [corpus(), scratch()]) {
      for (const file of project.files.keys()) {
        expect(extract(project, file).edges, `${file}`).toEqual([]);
      }
    }

    expect(
      index().edges.filter((edge) => edge.kind === 'references').length,
      'no reference edge may be produced during a build',
    ).toBe(0);
  });

  it('gives every node a safe project-relative POSIX path', () => {
    for (const project of [corpus(), scratch()]) {
      for (const file of project.files.keys()) {
        for (const node of routeNodes(project, file)) {
          expect(isSafeRelativePath(node.file), `${node.file} must be a safe relative path`).toBe(
            true,
          );
          expect(node.file, `${node.file} must already be POSIX`).toBe(toPosix(node.file));
          expect(node.file.startsWith('/'), `${node.file} must not be absolute`).toBe(false);
          expect(node.file.includes('\\'), `${node.file} must carry no backslash`).toBe(false);

          // The context's `file`, never `sourceFile.getFilePath()`, which is
          // absolute and host-specific.
          expect(node.file).toBe(file);
        }
      }
    }
  });
});
