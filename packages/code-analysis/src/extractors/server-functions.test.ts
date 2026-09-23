/**
 * Unit suite for `./server-functions.ts` — the extractor that owns the
 * `server-function` node kind and the `calls` edges that point *into* those
 * nodes.
 *
 * ## Why the counts in this file are exact
 *
 * Those edges are the only thing that makes a cross-tier path traversable.
 * `../graph/query.ts`'s `whoCalls` reports a service function's fan-in **from
 * the static `calls` edges alone** — it consults no reference resolver for that
 * question — and both of its cross-tier `pathBetween` chains (browser handler →
 * request → route → service → database, and page → service → database) step
 * through exactly this hop. A missing edge is therefore not a smaller answer
 * but a silently deleted tier boundary, and an edge too many is a caller the
 * developer never wrote. So every fan-in below is asserted as an **exact
 * number together with the exact set of origin files**: three, two, one and
 * one. The corpus is built to make those four numbers true, and its modules say
 * so in their own headers.
 *
 * One of the three callers of the multi-caller service function is a **page
 * component**, not an HTTP handler. That is what the component step of the
 * owner cascade exists for, and it is why "a caller" may not be assumed to be a
 * route handler.
 *
 * ## The invariants pinned here
 *
 * 1. **Which modules yield a node.** One node per exported module-level
 *    function of a module that is neither a component module nor a route/page
 *    module; `isAsync` and `exported` as declared; no node for a non-exported
 *    helper, for an exported value that is not a function, or for a component,
 *    route, page, barrel, driver-handle or stub module.
 * 2. **Where a node can be opened.** Every node's `file`/`line`/`column` is a
 *    1-based, project-relative POSIX location that `parseSourceLocation`
 *    accepts as a `code-graph` resolution — verified against positions this
 *    file computes from raw source text rather than from the syntax tree, so a
 *    change of anchor inside the extractor cannot agree with itself.
 * 3. **The exact caller fan-outs**, with the origin node of every edge resolved
 *    in the assembled graph and its kind checked against the documented owner
 *    cascade (`api-route` for an HTTP-method export, `component` for a page,
 *    `handler` for a markup-bound callback).
 * 4. **The route-to-service linkage**, and the direction it runs in.
 * 5. **Resolution without type resolution**: through a `paths` alias, through a
 *    barrel, at and past the documented re-export hop bound, across a re-export
 *    cycle, on the original name of an aliased specifier, and within one file.
 * 6. **Purity, determinism and failure**: two runs are byte-identical, nothing
 *    is written, a broken module costs its own contribution and nothing else,
 *    no diagnostic quotes source text, and no `references` edge is invented.
 *
 * ## Two reconciliations, both resolved towards the code
 *
 * - **`routes-to` is not emitted here, and this suite asserts that it is
 *   not.** This file's brief asked for a `routes-to` edge from an `api-route`
 *   node to a `server-function` node. `../graph/types.ts` is the contract for
 *   edge semantics and it fixes `routes-to` as `api-call` → `api-route`, "the
 *   one edge kind an extractor cannot emit on its own"; `./server-functions.ts`
 *   records the same reconciliation in its header and implements it. The
 *   brief's own wording defers to both ("assert the direction matches the
 *   semantics documented in `../graph/types.js` and implemented by
 *   `./server-functions.ts`"), so the route-to-service linkage asserted below
 *   is the shape the reachability invariant on `CODE_EDGE_KINDS` sanctions: a
 *   **`calls` edge straight from the `api-route` node**, with the counts the
 *   brief fixes (two from the two-method module, one each from the dynamic,
 *   catch-all and legacy modules). That an `api-route` node has such an
 *   outgoing edge at all is the load-bearing part: `./symbols.ts` is the only
 *   emitter of `declares`, so without this extractor a route node has no
 *   outgoing edge and every path through it stops dead.
 * - **`isDefaultExport` is asserted as an observable, because no field of that
 *   name exists.** `ServerFunctionNodeData` carries `isAsync` and `exported`,
 *   and `CodeNodeBase` carries no default-export flag. What a default export
 *   would change is the node's **name**: an anonymous `export default function`
 *   is recorded under the reserved name `default`. So "not a default export" is
 *   asserted as "named by its own declared identifier, never `default`", which
 *   is the property a consumer can actually read.
 *
 * ## How the cases are driven
 *
 * Two inputs, and they answer different questions.
 *
 * - **The committed corpus** at `../../test/fixtures/sample-next-app`, opened
 *   once through the real `openProject`, is where the fan-outs live. Each file
 *   is handed to the extractor through a per-file `ExtractorContext` built
 *   exactly as `../indexer.ts` builds it, and the whole project is indexed once
 *   with `buildIndex` + `CodeGraph.fromIndex` so that every edge endpoint can be
 *   *resolved* rather than parsed — node ids are opaque by contract — and so
 *   that a dropped edge would show up as a `dangling-edge` diagnostic instead of
 *   as a passing assertion. The corpus is **read only**: its file set, sizes,
 *   modification times and content digests are snapshotted before it is opened
 *   and re-checked afterwards.
 * - **An `os.mkdtemp` scratch project**, written in `beforeAll` and removed in
 *   `afterAll`, carries the shapes the corpus deliberately does not hold: a
 *   non-exported helper, a function-valued exported constant, a barrel chain at
 *   and past the hop bound, a re-export cycle, an unresolvable specifier, an
 *   import that is never called, a same-file call, and a syntactically broken
 *   module. Its identifiers are neutral (`loadPrimary`, `helperOnly`) because
 *   the syntax is the subject.
 *
 * Nothing here reaches the network, writes to `$DEBUGGEN_HOME`, or touches a
 * file outside the scratch root.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isOk,
  isSafeRelativePath,
  noopLogger,
  parseSourceLocation,
} from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { SourceFile } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeGraph } from '../graph/graph.js';
import { isIndexDiagnosticCode } from '../graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { routeEntryForFile } from './api-routes.js';
import { eventHandlersExtractor } from './event-handlers.js';
import { SERVER_FUNCTIONS_EXTRACTOR_ID, serverFunctionsExtractor } from './server-functions.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus, named
 *
 * Every path and identifier below is fixture-invented test data. None of it
 * appears in `./server-functions.ts`, which derives rather than recognises, and
 * `scripts/check-no-hardcoding.mjs` skips test suites for exactly that reason.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed indexing corpus, resolved through `realpath` so it matches the
 * normalisation `openProject` applies — on a platform whose temporary or
 * checkout directory is reached through a link, an unresolved root makes every
 * project-relative path disagree by a prefix.
 */
const FIXTURE_ROOT = realpathSync(
  fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url)),
);

/** The corpus' service layer: three exported async functions, no component, no route. */
const SERVICE_MODULE = 'src/lib/station-service.ts';

/** The corpus' library-level fetch helper: one exported async function that calls `fetch`. */
const FETCH_HELPER_MODULE = 'src/lib/http.ts';

/** The static App Router handler module, the corpus' only two-method route. */
const STATIC_ROUTE_MODULE = 'app/api/gauges/route.ts';

/** The dynamic App Router handler module (`[id]`), one method. */
const DYNAMIC_ROUTE_MODULE = 'app/api/gauges/[id]/route.ts';

/** The route-group catch-all App Router handler module, one method. */
const CATCH_ALL_ROUTE_MODULE = 'app/(observatory)/api/basins/[...segments]/route.ts';

/** The grouped dynamic **page** module — a caller that is not an HTTP handler. */
const GROUPED_PAGE_MODULE = 'app/(observatory)/basins/[id]/page.tsx';

/** The legacy `pages/api` module whose default export *is* the route. */
const LEGACY_API_MODULE = 'pages/api/gauge-log.ts';

/** The client component whose markup binds a named click handler. */
const CLIENT_WIDGET_MODULE = 'src/widgets/GaugeReadout.tsx';

/** The service function three different callers reach. */
const MULTI_CALLER_FUNCTION = 'summarizeBasin';

/** The service function the two `GET` handlers reach. */
const TWO_HANDLER_FUNCTION = 'listBasinGauges';

/** The service function only the static module's `POST` handler reaches. */
const WRITE_ONLY_FUNCTION = 'recordGaugeReading';

/** The fetch helper's exported function: the corpus' one-hop caller case. */
const FETCH_HELPER_FUNCTION = 'fetchGaugeIndex';

/** The name the corpus' click handler is declared under. */
const CLICK_HANDLER_NAME = 'handleReadoutClick';

/**
 * Every exported function of the corpus' service module, in source order.
 *
 * Source order is the extractor's documented emission order, so this tuple is
 * both the membership assertion and the ordering assertion.
 */
const SERVICE_FUNCTIONS: readonly string[] = [
  TWO_HANDLER_FUNCTION,
  WRITE_ONLY_FUNCTION,
  MULTI_CALLER_FUNCTION,
];

/**
 * The corpus modules that must contribute no `server-function` node, each with
 * the reason it is disqualified — the reason is in the table because a module
 * that stopped being disqualified for its stated reason should fail here rather
 * than quietly lose a node.
 */
const MODULES_WITHOUT_NODES: readonly (readonly [string, string])[] = [
  [STATIC_ROUTE_MODULE, 'a request-handler route module'],
  [DYNAMIC_ROUTE_MODULE, 'a request-handler route module'],
  [CATCH_ALL_ROUTE_MODULE, 'a request-handler route module'],
  [LEGACY_API_MODULE, 'a legacy request-handler module'],
  [GROUPED_PAGE_MODULE, 'a page module'],
  ['app/page.tsx', 'a page module'],
  ['app/layout.tsx', 'a component module'],
  [CLIENT_WIDGET_MODULE, 'a component module'],
  ['src/widgets/BasinSummary.tsx', 'a component module'],
  ['src/widgets/index.ts', 'a barrel that declares nothing'],
  ['src/lib/datastore.ts', 'a driver-handle module that exports constants, not functions'],
  ['src/lib/stubs/pg.ts', 'a stub module that exports a class and interfaces'],
  ['src/lib/stubs/prisma-client.ts', 'a stub module that exports a class and interfaces'],
];

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/** A 1-based position, on the `CodeNodeBase` convention. */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/** What one indexed project offers the cases below. */
interface IndexedProject {
  /** The opened project handle. */
  readonly loaded: LoadedProject;

  /** This extractor's result per project-relative file, in the loader's order. */
  readonly results: ReadonlyMap<string, ExtractorResult>;

  /** The index the whole extractor set produced. */
  readonly index: CodeIndex;

  /** The graph over that index, for resolving an edge's endpoints. */
  readonly graph: CodeGraph;
}

/** One file's identity on disk, for the "nothing was written" assertions. */
interface FileStamp {
  /** Byte length. */
  readonly size: number;

  /** Modification time in epoch milliseconds. */
  readonly mtimeMs: number;

  /** SHA-256 of the contents, hex — the check a coarse timestamp cannot make. */
  readonly digest: string;
}

/**
 * Opens a project and runs the extractor over every file of it, then indexes the
 * whole project with the default extractor set.
 *
 * Both halves matter and neither substitutes for the other: the per-file results
 * are *this* extractor's contribution in isolation, which is what a unit
 * assertion is about, while the graph is what resolves an edge's `from` and `to`
 * to nodes other extractors emitted — the only honest way to name an origin,
 * since `CodeNodeBase.id` is opaque by contract and must never be parsed.
 *
 * The context is assembled field for field as `../indexer.ts` assembles it, so a
 * behaviour proved here holds in a real indexing run.
 *
 * @param projectRoot The absolute, realpath-resolved project root.
 * @returns The handle, the per-file results, the index and the graph.
 */
async function indexProjectAt(projectRoot: string): Promise<IndexedProject> {
  const opened = openProject({ projectRoot, logger: noopLogger });

  expect(isOk(opened), `openProject must succeed for ${projectRoot}`).toBe(true);
  if (!isOk(opened)) {
    throw new Error(`openProject failed for ${projectRoot}`);
  }

  const loaded = opened.value;
  const results = new Map<string, ExtractorResult>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(sourceFile.getFilePath());

    if (file === undefined) {
      throw new Error(`a loaded source file lies outside ${projectRoot}`);
    }

    results.set(file, serverFunctionsExtractor.extract(contextFor(loaded, sourceFile, file)));
  }

  const built = await buildIndex(loaded, { logger: noopLogger });

  expect(isOk(built), `buildIndex must succeed for ${projectRoot}`).toBe(true);
  if (!isOk(built)) {
    throw new Error(`buildIndex failed for ${projectRoot}`);
  }

  return {
    loaded,
    results,
    index: built.value,
    graph: CodeGraph.fromIndex(built.value, { logger: noopLogger }),
  };
}

/**
 * The per-file {@link ExtractorContext} `../indexer.ts` builds.
 *
 * `noopLogger` rather than a recording stub: the extractor logs only when it
 * refuses a path that `LoadedProject.projectRelative` has already vouched for,
 * which cannot happen here, and every finding it reports is a value on its
 * result.
 *
 * @param loaded The opened project.
 * @param sourceFile The file being visited.
 * @param file Its project-relative POSIX path.
 * @returns The context.
 */
function contextFor(loaded: LoadedProject, sourceFile: SourceFile, file: string): ExtractorContext {
  return { loaded, sourceFile, file, projectRoot: loaded.projectRoot, logger: noopLogger };
}

/**
 * One file's result, or a failure naming the file — an absent entry means the
 * loader did not judge the file indexable, which would silently turn every
 * assertion about it into a vacuous truth.
 *
 * @param project The indexed project.
 * @param file The project-relative POSIX path.
 * @returns That file's extractor result.
 */
function resultFor(project: IndexedProject, file: string): ExtractorResult {
  const result = project.results.get(file);

  if (result === undefined) {
    throw new Error(`${file} was not indexed; the corpus or scratch project has moved`);
  }

  return result;
}

/**
 * The `server-function` nodes one file contributed, in emission order.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the kind is
 * narrowed here once rather than at every assertion.
 *
 * @param project The indexed project.
 * @param file The project-relative POSIX path.
 * @returns The nodes, in the order the extractor emitted them.
 */
function serverFunctionsOf(
  project: IndexedProject,
  file: string,
): readonly CodeNodeOf<'server-function'>[] {
  return resultFor(project, file).nodes.filter(
    (node): node is CodeNodeOf<'server-function'> => node.kind === 'server-function',
  );
}

/**
 * The one `server-function` node of a given name in the whole graph.
 *
 * Found by name and file rather than by a derived id, because the id derivation
 * is part of what is under test: a case that recomputed the id would agree with
 * the extractor by construction.
 *
 * @param project The indexed project.
 * @param file The declaring module.
 * @param name The declared name.
 * @returns The node.
 */
function serverFunctionNode(
  project: IndexedProject,
  file: string,
  name: string,
): CodeNodeOf<'server-function'> {
  const matched = project.graph
    .nodesByKind('server-function')
    .filter((node) => node.file === file && node.name === name);

  expect(matched.map((node) => `${node.file}#${node.name}`)).toHaveLength(1);

  const [only] = matched;

  if (only === undefined) {
    throw new Error(`no server-function node named ${name} in ${file}`);
  }

  return only;
}

/**
 * The node an edge endpoint id names, or a failure.
 *
 * `CodeGraph.nodeById` returning `undefined` is precisely the `dangling-edge`
 * condition, and construction has already dropped such an edge — so reaching
 * the throw means the graph handed back an edge whose endpoint it also dropped,
 * which is worth a loud failure rather than a skipped assertion.
 *
 * @param project The indexed project.
 * @param id The node id to resolve.
 * @returns The node.
 */
function nodeById(project: IndexedProject, id: string): CodeNode {
  const node = project.graph.nodeById(id);

  if (node === undefined) {
    throw new Error('an edge endpoint resolved to no node');
  }

  return node;
}

/**
 * The incoming `calls` edges of one server function, with each origin resolved.
 *
 * @param project The indexed project.
 * @param file The declaring module.
 * @param name The declared name.
 * @returns The edges paired with the nodes they start at.
 */
function callersOf(
  project: IndexedProject,
  file: string,
  name: string,
): readonly { readonly edge: CodeEdge; readonly origin: CodeNode }[] {
  const target = serverFunctionNode(project, file, name);

  return project.graph
    .incoming(target.id, 'calls')
    .map((edge) => ({ edge, origin: nodeById(project, edge.from) }));
}

/**
 * The loaded source file behind a project-relative path.
 *
 * Looked up through `LoadedProject.projectRelative` rather than by joining the
 * root, so the answer comes from the same bounded, deterministically ordered set
 * the index is defined over.
 *
 * @param project The indexed project.
 * @param file The project-relative POSIX path.
 * @returns The source file.
 */
function sourceFileOf(project: IndexedProject, file: string): SourceFile {
  const found = project.loaded
    .sourceFiles()
    .find((candidate) => project.loaded.projectRelative(candidate.getFilePath()) === file);

  if (found === undefined) {
    throw new Error(`${file} is not part of the opened project`);
  }

  return found;
}

/**
 * The distinct origin nodes of the `calls` edges one file's result emitted.
 *
 * Distinct, because one node legitimately owns several call sites — a route
 * module publishing two methods through one `api-route` node is the corpus'
 * case — and the question these assertions ask is *which node* an edge starts
 * at.
 *
 * @param project The indexed project.
 * @param file The project-relative POSIX path of the calling file.
 * @returns The origin nodes, in first-appearance order.
 */
function originsOfCallsFrom(project: IndexedProject, file: string): readonly CodeNode[] {
  const seen = new Map<string, CodeNode>();

  for (const edge of resultFor(project, file).edges) {
    if (edge.kind === 'calls' && !seen.has(edge.from)) {
      seen.set(edge.from, nodeById(project, edge.from));
    }
  }

  return [...seen.values()];
}

/**
 * The 1-based position of a character offset in a text, computed from the text
 * alone.
 *
 * Deliberately not ts-morph's conversion: the extractor anchors a node through
 * the same API, so a case that reused it would prove only that the API is
 * self-consistent. Counting newlines here makes the position an independent
 * statement about the source.
 *
 * @param text The whole file text.
 * @param offset A character offset into it.
 * @returns The 1-based line and column.
 */
function positionAtOffset(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');

  return { line: before.split('\n').length, column: offset - lastBreak };
}

/**
 * The 1-based position of a function declaration's identifier, located by text
 * search.
 *
 * The marker is `function <name>(`, which appears exactly once per declaration
 * in the modules this is used on; uniqueness is asserted rather than assumed,
 * because a second occurrence would make the expectation ambiguous instead of
 * wrong.
 *
 * @param text The whole file text.
 * @param name The declared function name.
 * @returns The 1-based position of the identifier.
 */
function declaredIdentifierPosition(text: string, name: string): Position {
  const keyword = 'function ';
  const marker = `${keyword}${name}(`;
  const at = text.indexOf(marker);

  expect(at, `${name} must be declared as a function in the module under test`).toBeGreaterThan(-1);
  expect(text.indexOf(marker, at + 1), `${name} must be declared exactly once`).toBe(-1);

  return positionAtOffset(text, at + keyword.length);
}

/** The diagnostic codes of a list, in order. */
function codesOf(diagnostics: readonly IndexDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/** Every text field a diagnostic carries, for the privacy assertions. */
function textsOf(diagnostics: readonly IndexDiagnostic[]): readonly string[] {
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.detail === undefined
      ? [diagnostic.message]
      : [diagnostic.message, diagnostic.detail],
  );
}

/**
 * Every file below a root, project-relative POSIX, sorted — the file *set* half
 * of the "nothing was written" assertion.
 *
 * @param root The absolute root to walk.
 * @param prefix The accumulated relative prefix.
 * @returns The relative paths, ascending.
 */
function filesUnder(root: string, prefix = ''): readonly string[] {
  const found: string[] = [];

  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...filesUnder(root, relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }

  return found.sort((left, right) => (left < right ? -1 : 1));
}

/**
 * The size, modification time and content digest of every file below a root.
 *
 * All three, because each catches something the others miss: a rewrite with the
 * same length moves the digest, a same-content rewrite moves the modification
 * time, and a truncation moves the size. Taken *before* the project is opened,
 * so the loader itself is inside the window under test.
 *
 * @param root The absolute root to stamp.
 * @returns The stamps, keyed by relative path.
 */
function stampTree(root: string): ReadonlyMap<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();

  for (const relative of filesUnder(root)) {
    const absolute = join(root, relative);
    const stats = statSync(absolute);

    stamps.set(relative, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    });
  }

  return stamps;
}

/** A stamp map as a plain, order-stable object, so a mismatch reports readably. */
function stampsAsObject(stamps: ReadonlyMap<string, FileStamp>): Record<string, FileStamp> {
  return Object.fromEntries(
    [...stamps.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/**
 * Writes a project into a fresh `mkdtemp` root.
 *
 * @param label The directory-name prefix, for a readable sandbox path.
 * @param files Module text keyed by project-relative POSIX path.
 * @returns The absolute, realpath-resolved root.
 */
function writeScratchProject(label: string, files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `debuggen-${label}-`)));

  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(root, relative);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }

  return root;
}

/* -------------------------------------------------------------------------------------------------
 * The scratch project
 *
 * The shapes the committed corpus deliberately does not hold. The corpus'
 * modules pin exact fan-outs and each one documents the counts it is part of, so
 * adding a declaration to it to cover a syntactic variant would break the
 * numbers this suite exists to protect. These modules live in an `os.mkdtemp`
 * root instead, and their identifiers are neutral because the syntax is the
 * subject.
 * ---------------------------------------------------------------------------------------------- */

/** How many module-specifier re-export hops `./server-functions.ts` documents as its bound. */
const REEXPORT_HOP_BOUND = 4;

/**
 * A string literal planted in the syntactically broken scratch module.
 *
 * The privacy constraint on `INDEX_DIAGNOSTIC_CODES` forbids a diagnostic from
 * embedding raw source text, and a syntax error is exactly the situation in
 * which a naive implementation quotes the offending line. This literal is what
 * a leak would look like, so no diagnostic text of the run may contain it.
 */
const SCRATCH_SOURCE_MARKER = 'scratch-source-text-that-no-diagnostic-may-quote';

/**
 * The scratch project, as module text keyed by project-relative POSIX path.
 *
 * `lib/hop1` … `lib/hop5` form a re-export chain of increasing length over one
 * declaring module, so a caller can be placed exactly at the documented hop
 * bound and exactly one step past it.
 */
const SCRATCH_PROJECT: Readonly<Record<string, string>> = {
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        paths: { '@lib/*': ['./lib/*'] },
      },
      include: ['**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  )}\n`,

  // The declaring server module: an exported async function calling an exported
  // sibling (the same-file case), a non-exported helper (no node), and the two
  // function-valued exported-constant spellings beside an exported value that is
  // not a function at all.
  'lib/service.ts': [
    'export async function loadPrimary(id: string): Promise<string> {',
    '  return helperOnly(id);',
    '}',
    '',
    'export function helperOnly(id: string): string {',
    '  return `${id}!`;',
    '}',
    '',
    'function notExported(id: string): string {',
    '  return id;',
    '}',
    '',
    'export const arrowShape = async (id: string): Promise<string> => notExported(id);',
    '',
    'export const expressionShape = function (id: string): string {',
    '  return id;',
    '};',
    '',
    'export const notAFunction = { primary: 1 };',
    '',
  ].join('\n'),

  'lib/barrel.ts': "export { loadPrimary } from './service';\n",
  'lib/hop1.ts': "export { loadPrimary } from './service';\n",
  'lib/hop2.ts': "export { loadPrimary } from './hop1';\n",
  'lib/hop3.ts': "export { loadPrimary } from './hop2';\n",
  'lib/hop4.ts': "export { loadPrimary } from './hop3';\n",
  'lib/hop5.ts': "export { loadPrimary } from './hop4';\n",

  // A star re-export cycle: neither module declares the name, and following the
  // clauses must terminate on the visited-file guard rather than recurse.
  'lib/cycle-a.ts': "export * from './cycle-b';\n",
  'lib/cycle-b.ts': "export * from './cycle-a';\n",

  'callers/through-barrel.ts': [
    "import { loadPrimary } from '../lib/barrel';",
    '',
    'export async function viaBarrel(): Promise<string> {',
    "  return loadPrimary('one');",
    '}',
    '',
  ].join('\n'),

  'callers/at-hop-bound.ts': [
    "import { loadPrimary } from '../lib/hop4';",
    '',
    'export async function viaBoundedChain(): Promise<string> {',
    "  return loadPrimary('two');",
    '}',
    '',
  ].join('\n'),

  'callers/past-hop-bound.ts': [
    "import { loadPrimary } from '../lib/hop5';",
    '',
    'export async function viaOverlongChain(): Promise<string> {',
    "  return loadPrimary('three');",
    '}',
    '',
  ].join('\n'),

  'callers/through-cycle.ts': [
    "import { loadPrimary } from '../lib/cycle-a';",
    '',
    'export function viaCycle(): unknown {',
    "  return loadPrimary('four');",
    '}',
    '',
  ].join('\n'),

  'callers/unresolvable.ts': [
    "import { loadPrimary } from 'a-package-this-project-never-installs';",
    '',
    'export function viaPackage(): unknown {',
    "  return loadPrimary('five');",
    '}',
    '',
  ].join('\n'),

  // The aliased specifier: bound locally as `renamed`, declared as `loadPrimary`,
  // and reached through the `paths` alias rather than a relative path.
  'callers/aliased.ts': [
    "import { loadPrimary as renamed } from '@lib/service';",
    '',
    'export async function viaAlias(): Promise<string> {',
    "  return renamed('six');",
    '}',
    '',
  ].join('\n'),

  // Imported, referenced in a type position, never called.
  'callers/import-only.ts': [
    "import { loadPrimary } from '@lib/service';",
    '',
    'export type Primary = typeof loadPrimary;',
    '',
    'export function countOnly(): number {',
    '  return 1;',
    '}',
    '',
  ].join('\n'),

  // A module whose only statement re-exports someone else's declaration.
  'callers/reexport-only.ts': "export { loadPrimary } from '@lib/service';\n",

  // Deliberately unparseable after its first statement. The literal above it is
  // what a diagnostic must not quote.
  'callers/broken.ts': [
    `export const readable = '${SCRATCH_SOURCE_MARKER}';`,
    '',
    'export async function brokenShape( {',
    '  return readable(',
    '',
  ].join('\n'),
};

/* -------------------------------------------------------------------------------------------------
 * Shared setup
 * ---------------------------------------------------------------------------------------------- */

/** The committed corpus, opened and indexed once. */
let corpus: IndexedProject;

/** The corpus' on-disk identity, stamped before it was opened. */
let corpusStamps: ReadonlyMap<string, FileStamp>;

/** The scratch project's root, removed in `afterAll`. */
let scratchRoot = '';

/** The scratch project, opened and indexed once. */
let scratch: IndexedProject;

/** The scratch project's on-disk identity, stamped before it was opened. */
let scratchStamps: ReadonlyMap<string, FileStamp>;

beforeAll(async () => {
  // Stamped first, so that opening the project and running every extractor over
  // it happens inside the window the purity assertions cover.
  corpusStamps = stampTree(FIXTURE_ROOT);
  corpus = await indexProjectAt(FIXTURE_ROOT);

  scratchRoot = writeScratchProject('server-functions', SCRATCH_PROJECT);
  scratchStamps = stampTree(scratchRoot);
  scratch = await indexProjectAt(scratchRoot);
});

afterAll(() => {
  if (scratchRoot !== '') {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------------------------------
 * The graph the fan-out assertions are read from
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: the corpus, indexed', () => {
  it('indexes the corpus with no diagnostic at all, and no dropped edge in particular', () => {
    // Every fan-out below reads the graph as authoritative, which it only is if
    // nothing was dropped on the way in. A `dangling-edge` is the failure that
    // matters here: this extractor *derives* the ids of the `api-route`,
    // `component`, `handler` and `symbol` nodes its edges start at, so an id
    // that disagrees with its emitter by one character is an edge construction
    // silently deletes — and a deleted route-to-service edge is invisible in
    // every other assertion.
    expect(codesOf(corpus.graph.diagnostics)).toStrictEqual([]);
    expect(
      corpus.graph.diagnostics.filter((entry) => entry.code === 'dangling-edge'),
    ).toStrictEqual([]);
  });

  it('contributes only server-function nodes and only calls edges', () => {
    const kinds = new Set<string>();
    const edgeKinds = new Set<string>();

    for (const result of corpus.results.values()) {
      for (const node of result.nodes) {
        kinds.add(node.kind);
      }
      for (const edge of result.edges) {
        edgeKinds.add(edge.kind);
      }
    }

    expect([...kinds].sort()).toStrictEqual(['server-function']);
    expect([...edgeKinds].sort()).toStrictEqual(['calls']);
  });

  it('reports no diagnostic from a clean file, absent rather than empty', () => {
    for (const [file, result] of corpus.results) {
      expect(result.diagnostics, `${file} must report no diagnostics`).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 1 — which modules yield a `server-function` node
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: server-function nodes', () => {
  it('yields one node per exported async function of the service module, three in source order', () => {
    const nodes = serverFunctionsOf(corpus, SERVICE_MODULE);

    expect(nodes.map((node) => node.name)).toStrictEqual([...SERVICE_FUNCTIONS]);

    for (const node of nodes) {
      expect(node.file, `${node.name} must be positioned in its declaring module`).toBe(
        SERVICE_MODULE,
      );
      expect(node.data.isAsync, `${node.name} is declared async`).toBe(true);
      expect(node.data.exported, `${node.name} is exported`).toBe(true);
      expect(node.exported, `${node.name} carries the base export flag too`).toBe(true);

      // "Not a default export", expressed as the property a consumer can read:
      // an anonymous `export default function` is recorded under the reserved
      // name `default`, so a node named by its own identifier is not one.
      expect(node.name, 'a named export is never recorded as the default one').not.toBe('default');

      // An `endLine` is what lets an editor reveal a whole function as a unit
      // and what the function-timing patcher reads to know the extent of the
      // body it would wrap. It may never precede the start line — an inverted
      // range makes a selection reveal the wrong region or throw.
      expect(node.endLine, `${node.name} carries an end line`).toBeTypeOf('number');
      expect(node.endLine ?? 0, `${node.name} ends at or after it starts`).toBeGreaterThanOrEqual(
        node.line,
      );
    }
  });

  it('anchors each service function at its identifier, on a position read from the raw text', () => {
    const text = readFileSync(join(FIXTURE_ROOT, SERVICE_MODULE), 'utf8');

    for (const node of serverFunctionsOf(corpus, SERVICE_MODULE)) {
      const expected = declaredIdentifierPosition(text, node.name);

      expect(
        { line: node.line, column: node.column },
        `${node.name} must be anchored at its declared identifier`,
      ).toStrictEqual(expected);
    }
  });

  it('yields one node for the fetch helper module, which is a server module structurally', () => {
    // The module calls `fetch`, which is what makes it interesting: nothing
    // about a network call disqualifies a module here. It is neither a component
    // module nor a route/page module, so its one exported async function
    // qualifies on structure alone — and it has to, because the corpus' one-hop
    // caller case depends on the node existing.
    const nodes = serverFunctionsOf(corpus, FETCH_HELPER_MODULE);
    const text = readFileSync(join(FIXTURE_ROOT, FETCH_HELPER_MODULE), 'utf8');

    expect(nodes.map((node) => node.name)).toStrictEqual([FETCH_HELPER_FUNCTION]);
    expect(text, 'the fetch helper is the module that issues the request').toContain('fetch(');

    const [helper] = nodes;

    if (helper === undefined) {
      throw new Error(`${FETCH_HELPER_MODULE} must declare ${FETCH_HELPER_FUNCTION}`);
    }

    expect(helper.data).toStrictEqual({ isAsync: true, exported: true });
    expect({ line: helper.line, column: helper.column }).toStrictEqual(
      declaredIdentifierPosition(text, FETCH_HELPER_FUNCTION),
    );
  });

  it.each(MODULES_WITHOUT_NODES)('yields no node from %s, being %s', (file) => {
    expect(serverFunctionsOf(corpus, file)).toStrictEqual([]);
  });

  it('holds exactly four server-function nodes across the whole corpus', () => {
    // The closing statement of the two lists above: every node the corpus can
    // produce is one of these four, so a module that started qualifying — or one
    // that stopped — fails here even if no per-file case named it.
    expect(
      corpus.graph
        .nodesByKind('server-function')
        .map((node) => `${node.file}#${node.name}`)
        .sort(),
    ).toStrictEqual(
      [
        `${FETCH_HELPER_MODULE}#${FETCH_HELPER_FUNCTION}`,
        `${SERVICE_MODULE}#${TWO_HANDLER_FUNCTION}`,
        `${SERVICE_MODULE}#${WRITE_ONLY_FUNCTION}`,
        `${SERVICE_MODULE}#${MULTI_CALLER_FUNCTION}`,
      ].sort(),
    );
  });

  it('yields no node for a non-exported module-level function', () => {
    // `notExported` is called from the same module, so it is not invisible to
    // the extractor — it is deliberately not addressable: an instrumentation
    // action names a `(file, symbol)` pair another module can reach.
    expect(serverFunctionsOf(scratch, 'lib/service.ts').map((node) => node.name)).not.toContain(
      'notExported',
    );
  });

  it('yields a node for a function-valued exported constant in both spellings', () => {
    const byName = new Map(
      serverFunctionsOf(scratch, 'lib/service.ts').map((node) => [node.name, node]),
    );

    expect([...byName.keys()].sort()).toStrictEqual([
      'arrowShape',
      'expressionShape',
      'helperOnly',
      'loadPrimary',
    ]);

    // The arrow form and the function-expression form are both functions the
    // export surface publishes; `isAsync` follows the declaration and not the
    // spelling, which is what a timing wrapper has to know.
    expect(byName.get('arrowShape')?.data).toStrictEqual({ isAsync: true, exported: true });
    expect(byName.get('expressionShape')?.data).toStrictEqual({ isAsync: false, exported: true });

    // An exported value that is not a function is `./symbols.ts`'s business.
    expect([...byName.keys()]).not.toContain('notAFunction');
  });

  it('exposes every node as a source location an editor can open unchanged', () => {
    for (const node of corpus.graph.nodesByKind('server-function')) {
      expect(isSafeRelativePath(node.file), `${node.file} must be a safe relative path`).toBe(true);

      const candidate: SourceLocation = {
        file: node.file,
        line: node.line,
        column: node.column,
        symbol: node.name,
        ...(node.endLine === undefined ? {} : { endLine: node.endLine }),
        resolvedBy: 'code-graph',
        confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
      };
      const parsed = parseSourceLocation(candidate);

      expect(isOk(parsed), `${node.file}#${node.name} must parse as a source location`).toBe(true);
      if (!isOk(parsed)) {
        continue;
      }

      expect(parsed.value.resolvedBy).toBe('code-graph');
      expect(parsed.value.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
      expect(parsed.value.file).toBe(node.file);
      expect(parsed.value.line).toBe(node.line);
      expect(parsed.value.column).toBe(node.column);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 2 — the `calls` fan-in, as exact numbers
 *
 * Each case resolves every incoming edge's `from` id in the assembled graph and
 * states the set of files those origins live in. The set is asserted, not the
 * count alone: three edges from the wrong three files would satisfy a count and
 * would mean the graph answers `whoCalls` with callers the developer never
 * wrote.
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: calls fan-in', () => {
  it('records exactly three callers of the multi-caller service function, from those three files', () => {
    const callers = callersOf(corpus, SERVICE_MODULE, MULTI_CALLER_FUNCTION);

    expect(callers).toHaveLength(3);
    expect(callers.map((caller) => caller.origin.file).sort()).toStrictEqual(
      [CATCH_ALL_ROUTE_MODULE, GROUPED_PAGE_MODULE, LEGACY_API_MODULE].sort(),
    );

    // The edge site is the call expression, which is the position `whoCalls`
    // reports for the caller — so it belongs to the calling file and never to
    // the declaring one.
    for (const { edge, origin } of callers) {
      expect(edge.file, 'the site of a call is the calling file').toBe(origin.file);
      expect(edge.line, 'a site carries a 1-based line').toBeGreaterThan(0);
      expect(edge.column, 'a site carries a 1-based column').toBeGreaterThan(0);
    }
  });

  it('records exactly two callers of the function both GET handlers reach', () => {
    const callers = callersOf(corpus, SERVICE_MODULE, TWO_HANDLER_FUNCTION);

    expect(callers).toHaveLength(2);
    expect(callers.map((caller) => caller.origin.file).sort()).toStrictEqual(
      [DYNAMIC_ROUTE_MODULE, STATIC_ROUTE_MODULE].sort(),
    );
    expect(callers.map((caller) => caller.origin.kind)).toStrictEqual(['api-route', 'api-route']);
  });

  it('records exactly one caller of the function only the POST handler reaches', () => {
    const callers = callersOf(corpus, SERVICE_MODULE, WRITE_ONLY_FUNCTION);
    const readCallers = callersOf(corpus, SERVICE_MODULE, TWO_HANDLER_FUNCTION).filter(
      (caller) => caller.origin.file === STATIC_ROUTE_MODULE,
    );

    expect(callers).toHaveLength(1);
    expect(readCallers, 'the same module reads through its other method').toHaveLength(1);

    const [write] = callers;
    const [read] = readCallers;

    if (write === undefined || read === undefined) {
      throw new Error('both handlers of the static route module must contribute an edge');
    }

    expect(write.origin.file).toBe(STATIC_ROUTE_MODULE);

    // Both methods of the static module are published by one `api-route` node,
    // so the write handler's edge starts at the same node the read handler's
    // does — and the two are told apart by their sites, which is why the site
    // is part of the edge id and why one owner calling two callees is two
    // edges rather than one.
    expect(write.origin.id).toBe(read.origin.id);
    expect(write.edge.line).not.toBe(read.edge.line);
    expect(write.edge.id).not.toBe(read.edge.id);
  });

  it('records exactly one caller of the fetch helper, at the named click handler', () => {
    const callers = callersOf(corpus, FETCH_HELPER_MODULE, FETCH_HELPER_FUNCTION);
    const [only] = callers;

    expect(callers).toHaveLength(1);

    if (only === undefined) {
      throw new Error(`${FETCH_HELPER_FUNCTION} must have exactly one caller`);
    }

    expect(only.origin.file).toBe(CLIENT_WIDGET_MODULE);
    expect(only.origin.kind, 'a markup-bound callback is a handler node').toBe('handler');
    expect(only.origin.name).toBe(CLICK_HANDLER_NAME);
  });

  it('attributes each corpus caller to the node kind the owner cascade selects', () => {
    const attributed = new Map<string, string>();

    for (const target of corpus.graph.nodesByKind('server-function')) {
      for (const { origin } of callersOf(corpus, target.file, target.name)) {
        attributed.set(`${origin.file}#${origin.name}`, origin.kind);
      }
    }

    // Step 2 for an HTTP-method export and a legacy default handler, step 3 for a
    // page component, step 1 for a callback the markup binds. The page entry is
    // the one that cannot be inferred from the others: a caller is not
    // necessarily an HTTP handler.
    expect(Object.fromEntries([...attributed.entries()].sort())).toStrictEqual({
      [`${CATCH_ALL_ROUTE_MODULE}#/api/basins/[...segments]`]: 'api-route',
      [`${CLIENT_WIDGET_MODULE}#${CLICK_HANDLER_NAME}`]: 'handler',
      [`${DYNAMIC_ROUTE_MODULE}#/api/gauges/[id]`]: 'api-route',
      [`${GROUPED_PAGE_MODULE}#BasinDetailPage`]: 'component',
      [`${LEGACY_API_MODULE}#/api/gauge-log`]: 'api-route',
      [`${STATIC_ROUTE_MODULE}#/api/gauges`]: 'api-route',
    });
  });

  it.each([STATIC_ROUTE_MODULE, DYNAMIC_ROUTE_MODULE, CATCH_ALL_ROUTE_MODULE, LEGACY_API_MODULE])(
    'starts %s edges at the very api-route node ./api-routes.ts emits',
    (file) => {
      // `./server-functions.ts` re-derives the `api-route` node's identity
      // locally — it may not import a sibling extractor — and its header carries
      // the standing obligation to keep that derivation in step with the
      // emitter. This is the case that enforces it: the route entry is derived
      // here through `routeEntryForFile`, which is what the emitter builds its
      // node from, and the origin node of the edges is checked against it field
      // by field.
      const entry = routeEntryForFile(sourceFileOf(corpus, file), file);

      if (entry === undefined) {
        throw new Error(`${file} must derive a route entry`);
      }

      const origins = originsOfCallsFrom(corpus, file);

      expect(origins).toHaveLength(1);
      expect(origins[0]?.kind).toBe('api-route');
      expect(origins[0]?.name).toBe(entry.routePath);
      expect(origins[0]?.file).toBe(entry.file);
      expect(origins[0]?.line).toBe(entry.location.line);
      expect(origins[0]?.column).toBe(entry.location.column);
    },
  );

  it('starts the click-handler edge at the very handler node ./event-handlers.ts emits', () => {
    const handlerIds = new Set(
      eventHandlersExtractor
        .extract(
          contextFor(
            corpus.loaded,
            sourceFileOf(corpus, CLIENT_WIDGET_MODULE),
            CLIENT_WIDGET_MODULE,
          ),
        )
        .nodes.filter((node) => node.kind === 'handler')
        .map((node) => node.id),
    );
    const [only] = callersOf(corpus, FETCH_HELPER_MODULE, FETCH_HELPER_FUNCTION);

    expect(handlerIds.size, 'the widget binds at least one handler').toBeGreaterThan(0);
    expect(
      only === undefined ? false : handlerIds.has(only.origin.id),
      'the derived handler id must be one the handler extractor emitted',
    ).toBe(true);
  });

  it('treats an import that is never called as an import', () => {
    const result = resultFor(scratch, 'callers/import-only.ts');

    // The module imports the declaration and mentions it in a type position, so
    // a name-based scan would find it. A call is a call expression.
    expect(result.edges.filter((edge) => edge.kind === 'calls')).toStrictEqual([]);
    expect(
      readFileSync(join(scratchRoot, 'callers/import-only.ts'), 'utf8'),
      'the case is only meaningful while the import is present',
    ).toContain('import { loadPrimary }');
  });

  it('never turns a re-export into a calls edge', () => {
    for (const file of ['callers/reexport-only.ts', 'lib/barrel.ts', 'lib/hop3.ts']) {
      const result = resultFor(scratch, file);

      expect(result.nodes, `${file} declares nothing`).toStrictEqual([]);
      expect(result.edges, `${file} calls nothing`).toStrictEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 3 — the route-to-service linkage
 *
 * Read the reconciliation in this file's header first: `../graph/types.ts`
 * reserves `routes-to` for `api-call` → `api-route` and states that it is the
 * one edge kind an extractor cannot emit on its own, so the linkage from a route
 * module into the service layer is the other shape the reachability invariant
 * sanctions — a `calls` edge straight from the `api-route` node. The counts
 * below are the ones the brief fixes; only the edge kind differs, and it differs
 * because the contract says so.
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: route modules reach the service layer', () => {
  it.each([
    [STATIC_ROUTE_MODULE, [TWO_HANDLER_FUNCTION, WRITE_ONLY_FUNCTION]],
    [DYNAMIC_ROUTE_MODULE, [TWO_HANDLER_FUNCTION]],
    [CATCH_ALL_ROUTE_MODULE, [MULTI_CALLER_FUNCTION]],
    [LEGACY_API_MODULE, [MULTI_CALLER_FUNCTION]],
  ] as const)('links %s to the server functions its handlers delegate to', (file, expected) => {
    const [origin] = originsOfCallsFrom(corpus, file);

    if (origin === undefined) {
      throw new Error(`${file} must contribute at least one calls edge`);
    }

    // Direction: the route node is the `from` and the service function is the
    // `to`. `whoCalls` is a backwards search along `calls`, which only works
    // because `from` is reliably the caller, and `pathBetween` traverses
    // outwards by default — so a reversed edge would leave an `api-route` node
    // with no outgoing edge at all.
    const reached = corpus.graph
      .outgoing(origin.id, 'calls')
      .map((edge) => nodeById(corpus, edge.to))
      .filter((node) => node.kind === 'server-function');

    expect(origin.kind).toBe('api-route');
    expect(reached.map((node) => node.name).sort()).toStrictEqual([...expected].sort());
    expect(
      reached.map((node) => node.file),
      'every target is declared in the service layer',
    ).toStrictEqual(reached.map(() => SERVICE_MODULE));
    expect(
      corpus.graph.incoming(origin.id, 'calls'),
      'a route is not called from code',
    ).toStrictEqual([]);
  });

  it('emits no routes-to edge, which ../graph/types.ts reserves for api-call → api-route', () => {
    for (const [file, result] of corpus.results) {
      expect(
        result.edges.filter((edge) => edge.kind === 'routes-to'),
        `${file} must contribute no routes-to edge`,
      ).toStrictEqual([]);
    }

    // And the extractor invents none from a URL string either: the corpus holds
    // request paths as literals in the client widget and the fetch helper, and
    // matching one to a route is `../graph/query.ts`'s business through
    // `matchRoute`, after both endpoints exist.
    const widget = readFileSync(join(FIXTURE_ROOT, CLIENT_WIDGET_MODULE), 'utf8');

    expect(widget, 'the widget writes request paths as literals').toContain('/api/gauges');
    expect(
      resultFor(corpus, CLIENT_WIDGET_MODULE).edges.map((edge) => edge.kind),
      'a URL literal produces no edge of this extractor beyond the service call',
    ).toStrictEqual(['calls']);
  });

  it('keeps every emitted edge id unique, and distinct from every node id', () => {
    const ids = [...corpus.results.values()].flatMap((result) =>
      result.edges.map((edge) => edge.id),
    );

    expect(new Set(ids).size, 'no two edges of one run may claim one id').toBe(ids.length);

    // Node ids and edge ids share no value either, so the two vocabularies
    // cannot collide inside one index.
    const nodeIds = new Set(
      [...corpus.results.values()].flatMap((result) => result.nodes.map((node) => node.id)),
    );

    expect(ids.filter((id) => nodeIds.has(id))).toStrictEqual([]);
  });

  it('coexists with every other edge kind of the index without an id collision', () => {
    // The whole index, not just this extractor's contribution: `routes-to` is
    // derived later from an `api-call` and an `api-route` node, and a
    // `duplicate-edge-id` between a derived edge and one of these would make
    // graph construction drop whichever arrived second. Construction reports
    // exactly that, and the corpus run reports nothing (asserted above), so the
    // statement here is the direct one.
    const edgeIds = corpus.index.edges.map((edge) => edge.id);
    const nodeIds = new Set(corpus.index.nodes.map((node) => node.id));

    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect(edgeIds.filter((id) => nodeIds.has(id))).toStrictEqual([]);
    expect(
      new Set(corpus.index.edges.map((edge) => edge.kind)).has('calls'),
      'the index holds the calls edges this extractor contributed',
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 4 — resolution mechanics, with nothing installed
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: resolution', () => {
  it('resolves every service-layer import of the corpus through the tsconfig paths alias', () => {
    // The corpus declares `next` and `react` and is never installed, which is
    // the ordinary state of a project indexed for the first time. Module
    // resolution is the only resolution step this extractor performs, and an
    // aliased specifier is what needs it.
    expect(
      existsSync(join(FIXTURE_ROOT, 'node_modules')),
      'the corpus must stay uninstalled, which is what makes this case meaningful',
    ).toBe(false);
    expect(corpus.loaded.tsConfigFilePath, 'the alias comes from the configuration').toBeDefined();

    const callers: readonly (readonly [string, string, string])[] = [
      [STATIC_ROUTE_MODULE, TWO_HANDLER_FUNCTION, SERVICE_MODULE],
      [STATIC_ROUTE_MODULE, WRITE_ONLY_FUNCTION, SERVICE_MODULE],
      [DYNAMIC_ROUTE_MODULE, TWO_HANDLER_FUNCTION, SERVICE_MODULE],
      [CATCH_ALL_ROUTE_MODULE, MULTI_CALLER_FUNCTION, SERVICE_MODULE],
      [LEGACY_API_MODULE, MULTI_CALLER_FUNCTION, SERVICE_MODULE],
      [GROUPED_PAGE_MODULE, MULTI_CALLER_FUNCTION, SERVICE_MODULE],
      [CLIENT_WIDGET_MODULE, FETCH_HELPER_FUNCTION, FETCH_HELPER_MODULE],
    ];

    for (const [file, imported, declaring] of callers) {
      const declaration = sourceFileOf(corpus, file)
        .getImportDeclarations()
        .find((candidate) =>
          candidate.getNamedImports().some((specifier) => specifier.getName() === imported),
        );

      expect(declaration, `${file} must import ${imported}`).toBeDefined();
      if (declaration === undefined) {
        continue;
      }

      expect(
        declaration.getModuleSpecifierValue(),
        `${file} must reach ${imported} through the alias`,
      ).toMatch(/^@\//);

      // Resolved by module resolution alone — the one resolution step this
      // extractor performs — and reaching the declaring module through the
      // alias is what proves the configuration's `paths` entry is honoured.
      const resolved = declaration.getModuleSpecifierSourceFile();

      expect(resolved, `${file}'s alias must resolve with nothing installed`).toBeDefined();
      expect(
        resolved === undefined ? undefined : corpus.loaded.projectRelative(resolved.getFilePath()),
      ).toBe(declaring);
      expect(
        resultFor(corpus, file)
          .edges.filter((edge) => edge.kind === 'calls')
          .map((edge) => nodeById(corpus, edge.to).name),
        `${file} must still resolve its aliased call`,
      ).toContain(imported);
    }
  });

  it('resolves a call through a barrel re-export to the declaring module', () => {
    const [origin] = originsOfCallsFrom(scratch, 'callers/through-barrel.ts');
    const reached = resultFor(scratch, 'callers/through-barrel.ts')
      .edges.filter((edge) => edge.kind === 'calls')
      .map((edge) => nodeById(scratch, edge.to));

    expect(origin?.file).toBe('callers/through-barrel.ts');
    expect(reached.map((node) => `${node.file}#${node.name}`)).toStrictEqual([
      'lib/service.ts#loadPrimary',
    ]);
  });

  it('follows a re-export chain at the documented hop bound and stops one step past it', () => {
    const atBound = resultFor(scratch, 'callers/at-hop-bound.ts').edges.filter(
      (edge) => edge.kind === 'calls',
    );
    const pastBound = resultFor(scratch, 'callers/past-hop-bound.ts').edges.filter(
      (edge) => edge.kind === 'calls',
    );

    // `lib/hop4` is four module-specifier hops above the declaration and
    // `lib/hop5` is five, so this pins the bound from both sides: a silent
    // change to it fails here rather than changing an unrelated answer.
    expect(REEXPORT_HOP_BOUND, 'the chain is built against the documented bound').toBe(4);
    expect(atBound.map((edge) => nodeById(scratch, edge.to).name)).toStrictEqual(['loadPrimary']);
    expect(
      pastBound,
      'a chain past the bound resolves to nothing rather than costing a stack',
    ).toStrictEqual([]);
  });

  it('terminates on a re-export cycle without an edge and without hanging', () => {
    // Reaching this assertion at all is half of it: an unguarded walk over two
    // modules that star-re-export each other does not return.
    expect(
      resultFor(scratch, 'callers/through-cycle.ts').edges.filter((edge) => edge.kind === 'calls'),
    ).toStrictEqual([]);
    expect(resultFor(scratch, 'lib/cycle-a.ts').edges).toStrictEqual([]);
    expect(resultFor(scratch, 'lib/cycle-b.ts').edges).toStrictEqual([]);
  });

  it('yields no edge and no diagnostic for an unresolvable specifier', () => {
    // A specifier that resolves to nothing is the ordinary state of a project
    // whose dependencies are not installed, so it is not a finding.
    const result = resultFor(scratch, 'callers/unresolvable.ts');

    expect(result.edges.filter((edge) => edge.kind === 'calls')).toStrictEqual([]);
    expect(result.diagnostics).toBeUndefined();
    expect(
      result.nodes.map((node) => node.name),
      'the module itself is still indexed',
    ).toStrictEqual(['viaPackage']);
  });

  it('resolves an aliased import specifier on the original name', () => {
    // Bound locally as `renamed`, declared as `loadPrimary`: a node is named as
    // its declaring file names it, which is what keeps one function to one node
    // across every module that imports it.
    const reached = resultFor(scratch, 'callers/aliased.ts')
      .edges.filter((edge) => edge.kind === 'calls')
      .map((edge) => nodeById(scratch, edge.to));

    expect(reached.map((node) => `${node.file}#${node.name}`)).toStrictEqual([
      'lib/service.ts#loadPrimary',
    ]);
  });

  it('records a same-file call between two exported functions of one server module', () => {
    const edges = resultFor(scratch, 'lib/service.ts').edges.filter(
      (edge) => edge.kind === 'calls',
    );
    const sameFile = edges
      .map((edge) => ({ from: nodeById(scratch, edge.from), to: nodeById(scratch, edge.to) }))
      .filter((pair) => pair.to.kind === 'server-function');

    expect(sameFile.map((pair) => `${pair.from.name} -> ${pair.to.name}`)).toStrictEqual([
      'loadPrimary -> helperOnly',
    ]);

    // The import hop is the only thing removed for a same-file call: the owner
    // is still the enclosing exported function's own `server-function` node.
    expect(sameFile[0]?.from.kind).toBe('server-function');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 5 — robustness, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

describe('serverFunctionsExtractor: robustness, purity and determinism', () => {
  it('produces identical, identically ordered output on two consecutive runs', () => {
    const second = new Map<string, ExtractorResult>();

    for (const sourceFile of corpus.loaded.sourceFiles()) {
      const file = corpus.loaded.projectRelative(sourceFile.getFilePath());

      if (file === undefined) {
        throw new Error('a loaded source file lies outside the corpus');
      }

      second.set(
        file,
        serverFunctionsExtractor.extract(contextFor(corpus.loaded, sourceFile, file)),
      );
    }

    // Deep equality first, so a mismatch reports the differing field, then the
    // serialised form, which is what `../indexer.ts`'s reproducibility promise
    // and the index cache actually rest on: a re-ordered array is deeply equal
    // to nothing and would otherwise pass a set comparison.
    expect([...second.entries()]).toStrictEqual([...corpus.results.entries()]);
    expect(JSON.stringify([...second.values()])).toBe(JSON.stringify([...corpus.results.values()]));
  });

  it('does not throw on a syntactically broken module and still contributes what it parsed', () => {
    const file = 'callers/broken.ts';
    const sourceFile = sourceFileOf(scratch, file);

    // Re-run here rather than reading the shared result, so that "does not
    // throw" is a statement this case makes rather than one it inherits from
    // the setup.
    expect(() =>
      serverFunctionsExtractor.extract(contextFor(scratch.loaded, sourceFile, file)),
    ).not.toThrow();

    const broken = resultFor(scratch, file);

    // The extractor is contractually total: a module it cannot fully read costs
    // its own unparsed region and nothing else. What it did parse — the
    // declaration the break interrupts — is still reported, which is a smaller
    // index rather than a wrong one.
    expect(serverFunctionsOf(scratch, file).map((node) => node.name)).toStrictEqual([
      'brokenShape',
    ]);
    expect(broken.nodes.every((node) => node.kind === 'server-function')).toBe(true);
    expect(broken.edges.filter((edge) => edge.kind === 'calls')).toStrictEqual([]);
  });

  it('leaves every other file of a project holding a broken module fully indexed', () => {
    expect(serverFunctionsOf(scratch, 'lib/service.ts').map((node) => node.name)).toContain(
      'loadPrimary',
    );
    expect(
      resultFor(scratch, 'callers/aliased.ts').edges.filter((edge) => edge.kind === 'calls'),
    ).toHaveLength(1);

    // The run reports the breakage as diagnostics from the closed vocabulary
    // rather than as a failure, and the graph is still built.
    const diagnostics = scratch.graph.diagnostics;

    expect(diagnostics.length, 'a broken module is a finding worth reporting').toBeGreaterThan(0);
    for (const code of codesOf(diagnostics)) {
      expect(
        isIndexDiagnosticCode(code),
        `${code} must belong to the closed diagnostic vocabulary`,
      ).toBe(true);
    }
    expect(
      diagnostics.filter((entry) => entry.code === 'dangling-edge'),
      'a broken module must not cost another file its edges',
    ).toStrictEqual([]);
  });

  it('quotes no source text in any diagnostic of a run over a broken module', () => {
    // A diagnostic is the one part of an index nobody thinks of as data, which
    // is exactly why a leak here would go unnoticed: it is logged, persisted
    // with a session and can reach model prompt context.
    const texts = textsOf(scratch.graph.diagnostics);

    expect(texts.length, 'there must be diagnostic text to inspect').toBeGreaterThan(0);

    for (const text of texts) {
      expect(text, 'a diagnostic names things; it quotes nothing').not.toContain(
        SCRATCH_SOURCE_MARKER,
      );
      expect(text).not.toContain('brokenShape(');
    }
    expect(
      textsOf(scratch.index.diagnostics ?? []).some((text) => text.includes(SCRATCH_SOURCE_MARKER)),
    ).toBe(false);
  });

  it('reports a read failure as an extractor-failed diagnostic naming only the error class', () => {
    // The extractor's own failure path, exercised by an injected project handle
    // whose `projectRelative` throws — the one call it makes into the handle
    // while resolving an imported call target. `extract` never throws, so the
    // observable outcome is an empty contribution plus one attributable
    // finding.
    const sourceFile = sourceFileOf(scratch, 'callers/aliased.ts');
    const hostile: LoadedProject = {
      project: scratch.loaded.project,
      projectRoot: scratch.loaded.projectRoot,
      tsConfigFilePath: scratch.loaded.tsConfigFilePath,
      sourceFiles: () => scratch.loaded.sourceFiles(),
      projectRelative: () => {
        throw new RangeError(SCRATCH_SOURCE_MARKER);
      },
    };

    let result: ExtractorResult | undefined;

    expect(() => {
      result = serverFunctionsExtractor.extract(
        contextFor(hostile, sourceFile, 'callers/aliased.ts'),
      );
    }, 'extract never throws').not.toThrow();

    const diagnostics = result?.diagnostics ?? [];
    const [only] = diagnostics;

    expect(result?.nodes).toStrictEqual([]);
    expect(result?.edges).toStrictEqual([]);
    expect(codesOf(diagnostics)).toStrictEqual(['extractor-failed']);
    expect(only?.severity).toBe('error');
    expect(only?.extractorId).toBe(SERVER_FUNCTIONS_EXTRACTOR_ID);
    expect(only?.file).toBe('callers/aliased.ts');

    // The thrown value's class, never its message — the message here *is* a
    // source-shaped string precisely so that quoting it would be visible.
    expect(only?.message).toContain('RangeError');
    expect(only?.message).not.toContain(SCRATCH_SOURCE_MARKER);
  });

  it('writes nothing: the scratch project is byte-identical after the run', () => {
    expect(filesUnder(scratchRoot)).toStrictEqual(
      Object.keys(SCRATCH_PROJECT).sort((left, right) => (left < right ? -1 : 1)),
    );
    expect(stampsAsObject(stampTree(scratchRoot))).toStrictEqual(stampsAsObject(scratchStamps));
  });

  it('leaves the committed corpus untouched, so a run changes no tracked file', () => {
    // The corpus is read-only input. Sizes, modification times and content
    // digests are compared against the stamps taken before it was opened, which
    // is the same statement as `git status --porcelain packages/code-analysis`
    // staying empty — made here, where a regression is attributable.
    expect(stampsAsObject(stampTree(FIXTURE_ROOT))).toStrictEqual(stampsAsObject(corpusStamps));
  });

  it('emits no references edge, so whoCalls is answerable from static edges alone', () => {
    // Reference resolution is deliberately lazy and belongs to
    // `../indexer.ts`'s `createReferenceResolver`; emitting references at index
    // time would force full type resolution over the whole program.
    // `../graph/query.ts`'s `whoCalls` is specified to answer a fan-out from
    // the `calls` edges above without consulting a resolver at all, which is
    // only true while this holds.
    for (const project of [corpus, scratch]) {
      for (const [file, result] of project.results) {
        expect(
          result.edges.filter((edge) => edge.kind === 'references'),
          `${file} must contribute no references edge`,
        ).toStrictEqual([]);
      }
    }
  });
});
