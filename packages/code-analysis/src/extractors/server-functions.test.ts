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
 * 7. **Every step of the owner cascade, and every refusal inside it**: markup
 *    handlers bound by name, by factory call, through a parenthesis, inline and
 *    through a nested callback — and not through a shadowing parameter, a
 *    conditional, a member access or past the wrapper depth; components through
 *    `memo`/`forwardRef` to the depth bound, class components through `render`,
 *    anonymous defaults named for their file; symbols for non-exported
 *    functions, class members (constructor, accessors, property arrows, static
 *    members) and module-level initialisers, and the declarator holding a class
 *    expression for that expression's members; and the file node for a computed
 *    or private member and for a destructured, bare or block-scoped top-level
 *    call.
 * 8. **The export surface and resolution edge cases**: clause renames, one node
 *    per declaration however many names publish it, the transparent wrappers
 *    and their depth bound, default-export intents, first-binding-wins imports,
 *    pattern shadowing to its depth bound, re-export clauses stepped over, and
 *    no edge into a declaration file, an excluded directory or a component
 *    module; same-file calls into module-level `symbol` targets only.
 * 9. **Route identities re-derived for step 2** agree with the entry
 *    `./api-routes.ts` builds its node from, field by field and against a
 *    position read from the raw text, for every handler spelling; every refused
 *    path and every function that is not the route's handler falls through to
 *    its symbol.
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
 * - **A second `os.mkdtemp` root, the cascade project**, carries invariants 7–9.
 *   It has its own configuration because markup needs `.tsx` modules, and every
 *   call site of interest in it is a `record('<label>')` with a project-unique
 *   label, so a case finds an edge by the position of that text in the raw
 *   source and asserts the owner and target the graph resolves it to.
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
import type { LogFields, LogLevel, Logger, SourceLocation } from '@debuggen/shared';
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
 * The cascade project
 *
 * A second `os.mkdtemp` root, for the shapes the scratch project above cannot
 * hold without disturbing the counts its cases pin: every owner the cascade can
 * select (and every one it must refuse), markup-bound handlers, component
 * wrappers, the export and re-export surface, same-file call targets, and the
 * route identities step 2 re-derives. It carries its own `tsconfig.json`
 * because markup needs `jsx` and `.tsx` modules, which the scratch project's
 * configuration deliberately leaves out.
 *
 * **Every call site of interest is spelled `record('<label>')` with a label
 * used exactly once in the project**, so a case locates an edge by the position
 * of that text — computed from the raw source, never from the syntax tree —
 * and asserts which node the extractor attributed it to. Identifiers are
 * neutral; the syntax is the subject.
 * ---------------------------------------------------------------------------------------------- */

/**
 * One module's text from its lines, newline-terminated.
 *
 * @param lines The module's lines, in order.
 * @returns The module text.
 */
function moduleText(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/**
 * An App Router handler module whose one `GET` export calls the shared
 * service function — the body every route-identity row below shares, so the
 * **path** is the only thing that varies between them.
 *
 * @param label The call site's unique label.
 * @returns The module text.
 */
function appHandlerModule(label: string): string {
  return moduleText(
    "import { record } from '@lib/core';",
    '',
    'export async function GET(): Promise<string> {',
    `  return record('${label}');`,
    '}',
  );
}

/**
 * A legacy Pages Router module whose default-exported `handler` calls the
 * shared service function, for the same reason as {@link appHandlerModule}.
 *
 * @param label The call site's unique label.
 * @returns The module text.
 */
function pagesHandlerModule(label: string): string {
  return moduleText(
    "import { record } from '@lib/core';",
    '',
    'export default function handler(): string {',
    `  return record('${label}');`,
    '}',
  );
}

/** The cascade project, as module text keyed by project-relative POSIX path. */
const CASCADE_PROJECT: Readonly<Record<string, string>> = {
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        jsx: 'preserve',
        paths: { '@lib/*': ['./lib/*'] },
      },
      include: ['**/*.ts', '**/*.tsx', '**/*.mts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  )}\n`,

  // The service module every call site below reaches: a named export, an
  // anonymous default export and a second named export.
  'lib/core.ts': moduleText(
    'export function record(label: string): string {',
    '  return label;',
    '}',
    '',
    'export default function (label: string): string {',
    '  return label;',
    '}',
    '',
    'export function other(label: string): string {',
    '  return label;',
    '}',
  ),

  // The export surface: a clause renaming a helper, a clause naming a value, a
  // function published under two names, the transparent wrappers, the wrapper
  // depth bound, a call-valued export, a destructured export, an uninitialised
  // export, two declarators on one line and a generator.
  'lib/surface.ts': moduleText(
    'function hidden(label: string): string {',
    '  return label;',
    '}',
    '',
    "const value = { label: 'value' };",
    '',
    'async function published(label: string): Promise<string> {',
    '  return label;',
    '}',
    '',
    'export { hidden as shown, value, published, published as republished };',
    '',
    'export const parenthesised = ((label: string): string => label) as (label: string) => string;',
    '',
    'export const checked = ((label: string): string => label) satisfies (label: string) => string;',
    '',
    'export const asserted = ((label: string): string => label)!;',
    '',
    "export const fourDeep = ((((() => 'four'))));",
    '',
    "export const fiveDeep = (((((() => 'five')))));",
    '',
    "export const wrapped = wrap(() => 'wrapped');",
    '',
    "export const { destructured } = { destructured: () => 'destructured' };",
    '',
    'export let pending: (() => string) | undefined;',
    '',
    "export const first = (): string => 'first', second = (): string => 'second';",
    '',
    'export function* series(): Generator<string> {',
    "  yield 'series';",
    '}',
    '',
    'function wrap<T>(fn: T): T {',
    '  return fn;',
    '}',
  ),

  'lib/default-intent.ts': moduleText(
    'function chosen(label: string): string {',
    '  return label;',
    '}',
    '',
    'export default chosen;',
  ),

  'lib/default-value.ts': moduleText(
    'const settings = { label: 1 };',
    '',
    'export default settings;',
  ),

  'lib/default-literal.ts': moduleText('export default 42;'),

  'lib/default-arrow.ts': moduleText('export default async (label: string) => label;'),

  // Every re-export clause shape the resolver has to step over before it
  // reaches the one that carries the name.
  'lib/types-only.ts': moduleText('export interface Shape {', '  readonly label: string;', '}'),
  'lib/barrels.ts': moduleText(
    "export type { Shape } from './types-only';",
    "export { type Shape as ShapeAlias, other } from './core';",
    "export * as everything from './core';",
    "export { record } from 'a-package-this-project-never-installs';",
    "export { record } from './core';",
    "export { default as recordDefault } from './core';",
  ),

  // Declared functions no server-function node exists for: a declaration file,
  // a module under an excluded directory, and a component module.
  'lib/ambient.d.ts': moduleText('export declare function declared(label: string): string;'),
  'lib/generated/helpers.ts': moduleText(
    'export function generatedHelper(label: string): string {',
    '  return label;',
    '}',
  ),
  'components/Labels.tsx': moduleText(
    'export function formatLabel(label: string): string {',
    '  return label.trim();',
    '}',
    '',
    'export function Label() {',
    '  return <span />;',
    '}',
  ),

  'callers/through-barrels.ts': moduleText(
    "import { everything, other, record, recordDefault } from '../lib/barrels';",
    "import type { Shape } from '../lib/types-only';",
    '',
    'export function viaBarrels(shape: Shape): string {',
    "  record('barrel-named');",
    "  recordDefault('barrel-default');",
    "  other('barrel-other');",
    "  everything.record('barrel-namespace');",
    '  return shape.label;',
    '}',
  ),

  'callers/imports.ts': moduleText(
    "import recordDefault from '../lib/core';",
    "import recordDefault from '../lib/default-intent';",
    "import type { Shape } from '../lib/types-only';",
    "import { type Shape as ShapeType, record } from '@lib/core';",
    "import { record as duplicate } from '../lib/core';",
    "import { other as duplicate } from '../lib/core';",
    "import * as core from '../lib/core';",
    "import { declared } from '../lib/ambient';",
    "import { generatedHelper } from '../lib/generated/helpers';",
    "import { formatLabel } from '../components/Labels';",
    '',
    'export function viaImports(shape: Shape, typed: ShapeType): string {',
    "  recordDefault('import-default');",
    "  record('import-named');",
    "  duplicate('import-duplicate');",
    "  core.record('import-namespace');",
    "  declared('import-declaration-file');",
    "  generatedHelper('import-excluded-directory');",
    "  formatLabel('import-component-module');",
    '  return shape.label + typed.label;',
    '}',
  ),

  // A destructured local shadows an import of the same name, to the documented
  // pattern depth and no deeper.
  'callers/patterns.ts': moduleText(
    "import { record } from '../lib/core';",
    '',
    'const nested = { a: { b: { c: { d: { record } } } } };',
    '',
    'export function withinPatternDepth(): string {',
    '  const { a: { b: { c: { record } } } } = { a: { b: { c: nested.a.b.c.d } } };',
    "  return record('within-pattern-depth');",
    '}',
    '',
    'export function pastPatternDepth(): string {',
    '  const { a: { b: { c: { d: { record } } } } } = nested;',
    "  return record('past-pattern-depth');",
    '}',
  ),

  'callers/surface.ts': moduleText(
    "import { asserted, checked, destructured, first, fiveDeep, fourDeep, parenthesised, published, republished, second, series, shown, wrapped } from '../lib/surface';",
    "import chosen from '../lib/default-intent';",
    "import settings from '../lib/default-value';",
    "import fromArrow from '../lib/default-arrow';",
    '',
    'export function viaSurface(): void {',
    "  shown('surface-shown');",
    "  published('surface-published');",
    "  republished('surface-republished');",
    "  parenthesised('surface-parenthesised');",
    "  checked('surface-checked');",
    "  asserted('surface-asserted');",
    '  fourDeep();',
    '  fiveDeep();',
    '  wrapped();',
    '  destructured();',
    '  first();',
    '  second();',
    '  series();',
    "  chosen('surface-default-intent');",
    '  settings();',
    "  fromArrow('surface-default-arrow');",
    '}',
  ),

  // Same-file call targets: which local declarations a call reaches.
  'lib/local-targets.ts': moduleText(
    "import { record } from './core';",
    '',
    'function helper(label: string): string {',
    '  return label;',
    '}',
    '',
    'const arrowHelper = (label: string): string => label;',
    '',
    "const computedValue = helper('module-initialiser-call');",
    '',
    'let unassigned: ((label: string) => string) | undefined;',
    '',
    'const { picked } = { picked: (label: string): string => label };',
    '',
    'const notAFunction = computedValue.length;',
    '',
    'class Klass {}',
    '',
    'export function entry(record: (label: string) => string): string {',
    "  record('shadowed-by-parameter');",
    "  helper('local-function');",
    "  arrowHelper('local-arrow');",
    "  unassigned?.('local-uninitialised');",
    "  picked('local-destructured');",
    '  notAFunction();',
    '  Klass();',
    '  function nested(label: string): string {',
    '    return label;',
    '  }',
    "  nested('local-nested');",
    "  return exported('local-exported');",
    '}',
    '',
    'export function exported(label: string): string {',
    "  return record('exported-calls-import');",
    '}',
  ),

  // Owners inside and around classes, and outside every function.
  'lib/owners.ts': moduleText(
    "import { record } from './core';",
    '',
    'export class Store {',
    "  total = record('property-initialiser');",
    "  #hidden = record('private-initialiser');",
    "  handle = (): string => record('property-arrow');",
    '',
    '  constructor() {',
    "    record('constructor');",
    '  }',
    '',
    '  load(): string {',
    "    return record('method');",
    '  }',
    '',
    '  get size(): string {',
    "    return record('getter');",
    '  }',
    '',
    '  set size(label: string) {',
    "    record('setter');",
    '  }',
    '',
    '  static make(): string {',
    "    return record('static-method');",
    '  }',
    '',
    "  ['computed'](): string {",
    "    return record('computed-name');",
    '  }',
    '',
    '  #secret(): string {',
    "    return record('private-method');",
    '  }',
    '}',
    '',
    'export const Maker = class {',
    '  constructor() {',
    "    record('class-expression-constructor');",
    '  }',
    '',
    '  run(): string {',
    "    return record('class-expression-method');",
    '  }',
    '};',
    '',
    'export function factory(): string {',
    '  class Local {',
    '    run(): string {',
    "      return record('function-local-class');",
    '    }',
    '  }',
    '',
    '  return new Local().run();',
    '}',
    '',
    'function internal(): string {',
    "  return record('non-exported-function');",
    '}',
    '',
    "const internalArrow = (): string => record('non-exported-arrow');",
    '',
    "export const cached = record('module-initialiser');",
    '',
    "const { destructuredResult } = { destructuredResult: record('destructured-initialiser') };",
    '',
    "record('bare-statement');",
    '',
    'if (cached.length > 0) {',
    "  const scoped = record('block-scoped');",
    '}',
    '',
    'export function outer(): string {',
    "  const inner = (): string => [1].map(() => record('nested-callback')).join();",
    '',
    '  return inner();',
    '}',
  ),

  'lib/default-class.ts': moduleText(
    "import { record } from './core';",
    '',
    'export default class {',
    '  load(): string {',
    "    return record('default-class-method');",
    '  }',
    '}',
  ),

  'lib/default-call.ts': moduleText(
    "import { record } from './core';",
    '',
    "export default record('default-expression');",
  ),

  'lib/export-equals.ts': moduleText(
    "import { record } from './core';",
    '',
    "export = record('export-equals');",
  ),

  // Component qualification. The first module holds only declarations the
  // component rule refuses — so, markup notwithstanding, it is a server module
  // and its exported function is a server function — and the second holds the
  // wrapper shapes the rule looks through.
  'components/NotComponents.tsx': moduleText(
    "import { memo } from 'react';",
    "import { record } from '../lib/core';",
    '',
    "const Label = 'static';",
    'let Pending: unknown;',
    'const { Picked } = { Picked: 1 };',
    'const Blank = memo();',
    "const Keyed = wrappers['memo'](() => <b />);",
    'const Plain = (): number => 1;',
    'function lower() {',
    '  return <i />;',
    '}',
    'function* Series() {',
    '  yield <u />;',
    '}',
    'class Holder {',
    '  render() {',
    '    return 1;',
    '  }',
    '}',
    'class Bare {}',
    '',
    'export const Unwrapped = useless(() => {',
    "  record('non-wrapper-call');",
    '  return <p />;',
    '});',
    '',
    "export const FiveMemos = memo(memo(memo(memo(memo(() => <b>{record('five-wrappers')}</b>)))));",
    '',
    'export function markupHelper(): string {',
    "  return record('markup-module-service');",
    '}',
  ),

  'components/Wrappers.tsx': moduleText(
    "import * as React from 'react';",
    "import { memo } from 'react';",
    "import { record } from '../lib/core';",
    '',
    'export const MemoRow = memo(function MemoRow() {',
    "  record('memo-wrapped');",
    '  return <li />;',
    '});',
    '',
    'export const RefField = React.forwardRef((props: unknown, ref: unknown) => {',
    "  record('forward-ref-wrapped');",
    '  return <input />;',
    '});',
    '',
    "export const FourMemos = memo(memo(memo(memo(() => <b>{record('four-wrappers')}</b>))));",
  ),

  'components/Board.tsx': moduleText(
    "import { Component } from 'react';",
    "import { record } from '../lib/core';",
    '',
    'export class Board extends Component {',
    '  refresh(): void {',
    "    record('class-component-method');",
    '  }',
    '',
    '  render() {',
    "    record('class-component-render');",
    '    return <section />;',
    '  }',
    '}',
    '',
    'export default class extends Component {',
    '  render() {',
    "    record('anonymous-class-render');",
    '    return <aside />;',
    '  }',
    '}',
  ),

  'components/Anonymous.tsx': moduleText(
    "import { record } from '../lib/core';",
    '',
    'export default function () {',
    "  record('anonymous-function-component');",
    '  return <main />;',
    '}',
  ),

  'components/Shapes.tsx': moduleText(
    "import { record } from '../lib/core';",
    '',
    "export const Tile = () => <span>{record('concise-component')}</span>;",
    '',
    "export const lowerTile = () => <span>{record('lowercase-arrow')}</span>;",
    '',
    'export function Panel() {',
    "  const rows = [1].map(() => record('component-callback'));",
    '',
    '  return <div>{rows}</div>;',
    '}',
  ),

  // Markup bindings, in every shape the handler step reads or refuses.
  'components/Handlers.tsx': moduleText(
    "import { record } from '../lib/core';",
    '',
    'function save(): void {',
    "  record('named-handler');",
    '}',
    '',
    'function makeHandler() {',
    "  return () => record('factory-handler');",
    '}',
    '',
    'function wrappedHandler(): void {',
    "  record('parenthesised-handler');",
    '}',
    '',
    'function deepHandler(): void {',
    "  record('too-deeply-wrapped-handler');",
    '}',
    '',
    'function submit(): void {',
    "  record('shadowed-handler');",
    '}',
    '',
    'function chooser(): void {',
    "  record('conditionally-bound');",
    '}',
    '',
    'export function Form(props: { readonly pick: () => void }, submit: () => void) {',
    '  return (',
    '    <form',
    '      onSubmit={submit}',
    '      onClick={save}',
    '      onBlur={save}',
    '      onFocus={makeHandler()}',
    '      onKeyDown={(wrappedHandler)}',
    '      onKeyUp={(((((deepHandler)))))}',
    '      onChange={props.pick}',
    "      onInput={maker.build('member-callee')}",
    '      onDrop={props.pick === undefined ? chooser : save}',
    "      onReset={() => record('inline-arrow')}",
    "      onScroll={function () { record('inline-function'); }}",
    "      onWheel={() => [1].forEach(() => record('inline-nested'))}",
    '      onCopy="literal"',
    "      className={String(record('non-handler-attribute'))}",
    '    />',
    '  );',
    '}',
  ),

  // App Router modules step 2 names, each in a different spelling.
  'app/(group)/@slot/items/[id]/route.ts': appHandlerModule('grouped-dynamic-route'),
  'app/route.ts': appHandlerModule('root-route'),
  'app/docs/[[...rest]]/route.ts': appHandlerModule('optional-catch-all-route'),
  'src/app/nested/route.ts': appHandlerModule('src-app-route'),
  'app/files/[...path]/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'async function handler(): Promise<string> {',
    "  return record('clause-published-route');",
    '}',
    '',
    'export { handler as PUT };',
  ),
  'app/multi/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    "export const GET = async (): Promise<string> => record('multi-declarator-get'),",
    "  POST = async (): Promise<string> => record('multi-declarator-post');",
  ),
  'app/wrapped/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'function withTiming<T>(fn: T): T {',
    '  return fn;',
    '}',
    '',
    "export const POST = withTiming(async (): Promise<string> => record('wrapped-route-handler'));",
  ),
  'app/clause-default/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'async function DELETE(): Promise<string> {',
    "  return record('default-intent-method');",
    '}',
    '',
    'function GET(): string {',
    "  return record('clause-exported-method');",
    '}',
    '',
    'export default DELETE;',
    'export { GET, GET as HEAD };',
  ),
  'app/aliased-default/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'function PATCH(): string {',
    "  return record('aliased-to-default');",
    '}',
    '',
    'export { PATCH as default };',
  ),
  'app/default-named/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'export default function POST(): string {',
    "  return record('default-function-named-for-method');",
    '}',
  ),
  'app/shared-handler.ts': moduleText(
    'export async function GET(): Promise<string> {',
    "  return 'shared';",
    '}',
  ),
  'app/reexported/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    "export { GET } from '../shared-handler';",
    '',
    'export async function POST(): Promise<string> {',
    "  return record('beside-a-reexport');",
    '}',
  ),
  'app/helpers/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    "const local = (): string => record('route-local-arrow');",
    '',
    'export function helper(): string {',
    "  return record('route-exported-helper');",
    '}',
    '',
    'export { local };',
    '',
    'export const limit = 10;',
    '',
    'export async function GET(): Promise<string> {',
    '  return local();',
    '}',
  ),
  'app/area/handler.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'export function relay(): string {',
    "  return record('app-tree-service-module');",
    '}',
  ),

  // App Router modules step 2 refuses, each for one reason.
  'app/_private/route.ts': appHandlerModule('private-folder-route'),
  'app/(.)intercepted/route.ts': appHandlerModule('intercepting-route'),
  'app/bad[segment]/route.ts': appHandlerModule('malformed-segment-route'),
  'app/[bad.name]/route.ts': appHandlerModule('illegal-parameter-route'),
  'app/[...all]/tail/route.ts': appHandlerModule('misplaced-catch-all-route'),
  'app/cjs/route.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'function GET(): string {',
    "  return record('export-equals-route');",
    '}',
    '',
    'export = { GET };',
  ),

  // Pages Router modules step 2 names, each spelling its default differently.
  'pages/api/index.ts': pagesHandlerModule('pages-index'),
  'pages/api/(grouped)/thing.ts': pagesHandlerModule('pages-parenthesised-directory'),
  'src/pages/api/rooted.ts': pagesHandlerModule('src-pages-route'),
  'pages/api/[slug].ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'class Store {}',
    '',
    "export default async (request: unknown) => record('pages-default-arrow');",
  ),
  'pages/api/clause.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'function handler(): string {',
    "  return record('pages-clause-default');",
    '}',
    '',
    'export { handler as default };',
  ),
  'pages/api/clause-arrow.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    "const handler = (): string => record('pages-clause-arrow');",
    '',
    'const limit = 10;',
    '',
    'export { limit };',
    'export { handler as default };',
  ),
  'pages/api/intent.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'async function handler(): Promise<string> {',
    "  return record('pages-default-intent');",
    '}',
    '',
    'export default handler;',
  ),
  'pages/api/class-handler.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'export default class Handler {',
    '  handle(): string {',
    "    return record('pages-class-member');",
    '  }',
    '}',
  ),
  'pages/api/no-default.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    'export function helper(): string {',
    "  return record('pages-without-default');",
    '}',
  ),

  // Pages Router modules step 2 refuses.
  'pages/api/_internal.ts': pagesHandlerModule('pages-private-stem'),
  'pages/api/_arrow.ts': moduleText(
    "import { record } from '@lib/core';",
    '',
    "export default async () => record('refused-default-arrow');",
  ),
  'pages/api/middleware.ts': pagesHandlerModule('pages-middleware'),
  'pages/about.ts': pagesHandlerModule('pages-rendering-module'),
  'pages/api/_private/thing.ts': pagesHandlerModule('pages-private-directory'),
  'pages/api/bad[dir]/thing.ts': pagesHandlerModule('pages-malformed-directory'),
  'pages/api/bad[stem].ts': pagesHandlerModule('pages-malformed-stem'),
  'pages/api/[...all]/more.ts': pagesHandlerModule('pages-misplaced-catch-all'),
  'pages/api/module.mts': pagesHandlerModule('pages-unsupported-extension'),
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

/** The cascade project's root, removed in `afterAll`. */
let cascadeRoot = '';

/** The cascade project, opened and indexed once. */
let cascade: IndexedProject;

/** The cascade project's on-disk identity, stamped before it was opened. */
let cascadeStamps: ReadonlyMap<string, FileStamp>;

beforeAll(async () => {
  // Stamped first, so that opening the project and running every extractor over
  // it happens inside the window the purity assertions cover.
  corpusStamps = stampTree(FIXTURE_ROOT);
  corpus = await indexProjectAt(FIXTURE_ROOT);

  scratchRoot = writeScratchProject('server-functions', SCRATCH_PROJECT);
  scratchStamps = stampTree(scratchRoot);
  scratch = await indexProjectAt(scratchRoot);

  cascadeRoot = writeScratchProject('server-functions-cascade', CASCADE_PROJECT);
  cascadeStamps = stampTree(cascadeRoot);
  cascade = await indexProjectAt(cascadeRoot);
});

afterAll(() => {
  for (const root of [scratchRoot, cascadeRoot]) {
    if (root !== '') {
      rmSync(root, { recursive: true, force: true });
    }
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

/* -------------------------------------------------------------------------------------------------
 * Phase 6 — the cascade project
 *
 * Every case below locates a call site by its text, computes the site's
 * position from the raw module source, and reads the one `calls` edge the
 * extractor recorded there — with both endpoints resolved in the assembled
 * graph, so an owner id that disagreed with its emitter by one character would
 * surface as a missing node rather than as a passing assertion.
 * ---------------------------------------------------------------------------------------------- */

/** One call site's `calls` edge, with both endpoints resolved. */
interface Attribution {
  /** The edge the extractor recorded at the site. */
  readonly edge: CodeEdge;

  /** The node the edge starts at: the owner the cascade selected. */
  readonly from: CodeNode;

  /** The node the edge ends at: the call target. */
  readonly to: CodeNode;
}

/**
 * The text an owner's position is read from: a marker that occurs exactly once
 * in the module, and the name inside it the node is anchored at.
 */
type OwnerAnchor = readonly [marker: string, name: string];

/**
 * One owner-table row: the module, the call site's label, the owner as
 * `<kind> <name>`, and where that owner is anchored — absent for the file node,
 * which is anchored at line 1, column 1 by convention.
 *
 * A mutable tuple on purpose: `it.each` spreads a row into the case's
 * parameters only when the row type extends `any[]`, which a `readonly` tuple
 * does not. The tables holding the rows are `readonly` instead.
 */
type OwnerRow = [file: string, label: string, owner: string, anchor?: OwnerAnchor];

/**
 * A cascade module's text, read back from disk.
 *
 * @param file The project-relative POSIX path.
 * @returns The module text.
 */
function cascadeText(file: string): string {
  return readFileSync(join(cascadeRoot, file), 'utf8');
}

/**
 * The offset of a marker that must occur exactly once in a text.
 *
 * Uniqueness is asserted rather than assumed, because a second occurrence would
 * make the expectation ambiguous instead of wrong.
 *
 * @param text The module text.
 * @param marker The text to find.
 * @returns Its offset.
 */
function uniqueOffset(text: string, marker: string): number {
  const at = text.indexOf(marker);

  expect(at, `${marker} must occur in the module under test`).toBeGreaterThan(-1);
  expect(text.indexOf(marker, at + 1), `${marker} must occur exactly once`).toBe(-1);

  return at;
}

/**
 * The 1-based position of a name inside a unique marker, computed from the text.
 *
 * @param text The module text.
 * @param anchor The marker and the name inside it.
 * @returns The name's position.
 */
function anchorPosition(text: string, [marker, name]: OwnerAnchor): Position {
  const within = marker.indexOf(name);

  expect(within, `${name} must be part of ${marker}`).toBeGreaterThan(-1);

  return positionAtOffset(text, uniqueOffset(text, marker) + within);
}

/** The call text of one labelled site of the cascade project. */
function recordCall(label: string): string {
  return `record('${label}')`;
}

/**
 * The `calls` edge a call site produced, or `undefined` when it produced none.
 *
 * The call text must begin where the call expression begins — its callee — so
 * that the position computed from the text is the edge's site.
 *
 * @param file The calling module.
 * @param callText The unique leading text of the call.
 * @returns The attribution, or `undefined`.
 */
function attributionAt(file: string, callText: string): Attribution | undefined {
  const text = cascadeText(file);
  const site = positionAtOffset(text, uniqueOffset(text, callText));
  const edges = resultFor(cascade, file).edges.filter(
    (edge) => edge.kind === 'calls' && edge.line === site.line && edge.column === site.column,
  );

  expect(edges.length, `${file} records at most one edge at ${callText}`).toBeLessThanOrEqual(1);

  const [edge] = edges;

  return edge === undefined
    ? undefined
    : { edge, from: nodeById(cascade, edge.from), to: nodeById(cascade, edge.to) };
}

/**
 * The `calls` edge a call site must have produced.
 *
 * @param file The calling module.
 * @param callText The unique leading text of the call.
 * @returns The attribution.
 */
function requiredAttribution(file: string, callText: string): Attribution {
  const found = attributionAt(file, callText);

  if (found === undefined) {
    throw new Error(`${file} recorded no calls edge at ${callText}`);
  }

  return found;
}

/** A node as `<kind> <name>`, the shorthand the owner tables compare. */
function kindAndName(node: CodeNode): string {
  return `${node.kind} ${node.name}`;
}

/** A node as `<file>#<name>`, the shorthand the target tables compare. */
function fileAndName(node: CodeNode): string {
  return `${node.file}#${node.name}`;
}

/** A node's own position. */
function positionOfNode(node: CodeNode): Position {
  return { line: node.line, column: node.column };
}

/**
 * Asserts one owner-table row: the labelled call reaches the shared service
 * function, starts at the expected owner, and that owner sits where the text
 * says it is declared.
 *
 * @param row The row.
 */
function expectOwner([file, label, owner, anchor]: OwnerRow): void {
  const { from, to } = requiredAttribution(file, recordCall(label));

  expect(kindAndName(from)).toBe(owner);
  expect(fileAndName(to)).toBe('lib/core.ts#record');
  expect(from.file).toBe(file);
  expect(positionOfNode(from)).toStrictEqual(
    anchor === undefined ? { line: 1, column: 1 } : anchorPosition(cascadeText(file), anchor),
  );
}

/** One recorded logger call. */
interface RecordedLog {
  /** The level it was logged at. */
  readonly level: LogLevel;

  /** The message. */
  readonly message: string;

  /** The structured fields, when the call passed any. */
  readonly fields: LogFields | undefined;
}

/**
 * A logger that records instead of printing, plus the list it records into.
 *
 * @returns The logger and its records.
 */
function recordingLogger(): { readonly logger: Logger; readonly records: RecordedLog[] } {
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

describe('serverFunctionsExtractor: the cascade project, indexed', () => {
  it('indexes the cascade project with no dropped edge and no finding of its own', () => {
    const diagnostics = cascade.graph.diagnostics;

    // Every owner below is an id this extractor *derives* for a node a sibling
    // emits, so a disagreement of one character is a `dangling-edge` the graph
    // drops — which would make every "no edge" assertion vacuously true.
    expect(diagnostics.filter((entry) => entry.code === 'dangling-edge')).toStrictEqual([]);
    expect(
      diagnostics.filter((entry) => entry.extractorId === SERVER_FUNCTIONS_EXTRACTOR_ID),
    ).toStrictEqual([]);
    for (const [file, result] of cascade.results) {
      expect(result.diagnostics, `${file} must report nothing`).toBeUndefined();
    }

    // The run's only findings belong to `./event-handlers.ts`: a member-access
    // binding (`props.pick`, `maker.build(…)`) has no declaration to position a
    // handler at. The handler step claims neither binding — see the markup
    // cases below — which is why they cost this extractor nothing.
    expect(
      diagnostics.map((entry) => [entry.severity, entry.code, entry.extractorId, entry.file]),
    ).toStrictEqual([
      ['info', 'extractor-failed', 'event-handlers', 'components/Handlers.tsx'],
      ['info', 'extractor-failed', 'event-handlers', 'components/Handlers.tsx'],
    ]);
  });

  it('contributes only server-function nodes and only calls edges from the cascade project', () => {
    const nodeKinds = new Set<string>();
    const edgeKinds = new Set<string>();

    for (const result of cascade.results.values()) {
      for (const node of result.nodes) {
        nodeKinds.add(node.kind);
      }
      for (const edge of result.edges) {
        edgeKinds.add(edge.kind);
      }
    }

    expect([...nodeKinds]).toStrictEqual(['server-function']);
    expect([...edgeKinds]).toStrictEqual(['calls']);
  });

  it('writes nothing: the cascade project is byte-identical after the run', () => {
    expect(filesUnder(cascadeRoot)).toStrictEqual(
      Object.keys(CASCADE_PROJECT).sort((left, right) => (left < right ? -1 : 1)),
    );
    expect(stampsAsObject(stampTree(cascadeRoot))).toStrictEqual(stampsAsObject(cascadeStamps));
  });
});

describe('serverFunctionsExtractor: the export surface a node is emitted for', () => {
  it('names each node for its declaration, once, in source order, whichever clause publishes it', () => {
    const file = 'lib/surface.ts';
    const text = cascadeText(file);
    const at = (marker: string, name: string): Position => anchorPosition(text, [marker, name]);

    // `hidden` is published only as `shown`, yet the node carries the declared
    // name; `published` is published twice and is still one node; `value` is
    // not a function; `wrapped` is a call result, `destructured` a binding
    // pattern, `pending` uninitialised, and `fiveDeep` sits one transparent
    // wrapper past the documented depth bound, so none of those four is a
    // function this module can vouch for. `wrap` is not exported.
    expect(
      serverFunctionsOf(cascade, file).map((node) => [
        node.name,
        positionOfNode(node),
        node.data.isAsync,
      ]),
    ).toStrictEqual([
      ['hidden', at('function hidden(', 'hidden'), false],
      ['published', at('async function published(', 'published'), true],
      ['parenthesised', at('const parenthesised', 'parenthesised'), false],
      ['checked', at('const checked', 'checked'), false],
      ['asserted', at('const asserted', 'asserted'), false],
      ['fourDeep', at('const fourDeep', 'fourDeep'), false],
      ['first', at('const first', 'first'), false],
      ['second', at(', second =', 'second'), false],
      ['series', at('function* series(', 'series'), false],
    ]);
  });

  it('records the anonymous default export under the reserved name at the declaration itself', () => {
    const text = cascadeText('lib/core.ts');

    expect(
      serverFunctionsOf(cascade, 'lib/core.ts').map((node) => [node.name, positionOfNode(node)]),
    ).toStrictEqual([
      ['record', anchorPosition(text, ['function record(', 'record'])],
      ['default', anchorPosition(text, ['export default function', 'export'])],
      ['other', anchorPosition(text, ['function other(', 'other'])],
    ]);
  });

  it('records an exported arrow under the reserved name at the exported expression', () => {
    const [only, ...rest] = serverFunctionsOf(cascade, 'lib/default-arrow.ts');

    expect(rest).toStrictEqual([]);
    expect(only?.name).toBe('default');
    expect(only?.data.isAsync).toBe(true);
    expect(only === undefined ? undefined : positionOfNode(only)).toStrictEqual(
      anchorPosition(cascadeText('lib/default-arrow.ts'), ['async (label', 'async']),
    );
  });

  it('names a function published by `export default <identifier>` for its own declaration', () => {
    expect(
      serverFunctionsOf(cascade, 'lib/default-intent.ts').map((node) => [
        node.name,
        positionOfNode(node),
      ]),
    ).toStrictEqual([
      [
        'chosen',
        anchorPosition(cascadeText('lib/default-intent.ts'), ['function chosen(', 'chosen']),
      ],
    ]);
  });

  it.each([
    ['lib/default-value.ts', 'a default export naming a value'],
    ['lib/default-literal.ts', 'a default export of a literal'],
    ['lib/barrels.ts', 'a module of re-export clauses only'],
    ['lib/types-only.ts', 'a module of types only'],
  ])('contributes nothing at all from %s, %s', (file) => {
    expect(resultFor(cascade, file)).toStrictEqual({ nodes: [], edges: [] });
  });

  it.each([
    ["shown('surface-shown')", 'lib/surface.ts#hidden'],
    ["published('surface-published')", 'lib/surface.ts#published'],
    ["republished('surface-republished')", 'lib/surface.ts#published'],
    ["parenthesised('surface-parenthesised')", 'lib/surface.ts#parenthesised'],
    ["checked('surface-checked')", 'lib/surface.ts#checked'],
    ["asserted('surface-asserted')", 'lib/surface.ts#asserted'],
    ['fourDeep()', 'lib/surface.ts#fourDeep'],
    ['first()', 'lib/surface.ts#first'],
    ['second()', 'lib/surface.ts#second'],
    ['series()', 'lib/surface.ts#series'],
    ["chosen('surface-default-intent')", 'lib/default-intent.ts#chosen'],
    ["fromArrow('surface-default-arrow')", 'lib/default-arrow.ts#default'],
    ['fiveDeep()', 'nothing'],
    ['wrapped()', 'nothing'],
    ['destructured()', 'nothing'],
    ['settings()', 'nothing'],
  ])('resolves the imported call %s to %s', (callText, target) => {
    const found = attributionAt('callers/surface.ts', callText);

    if (target === 'nothing') {
      // An edge to a node nobody emits would be dropped as `dangling-edge`, so
      // the extractor declines to record one at all.
      expect(found).toBeUndefined();

      return;
    }

    expect(found === undefined ? undefined : fileAndName(found.to)).toBe(target);
    expect(found === undefined ? undefined : kindAndName(found.from)).toBe(
      'server-function viaSurface',
    );
  });
});

describe('serverFunctionsExtractor: import bindings and re-export clauses', () => {
  it.each([
    // Two default imports bind `recordDefault` and two named imports bind
    // `duplicate`; in both cases the first one written is the binding.
    ['callers/imports.ts', "recordDefault('import-default')", 'lib/core.ts#default'],
    ['callers/imports.ts', "record('import-named')", 'lib/core.ts#record'],
    ['callers/imports.ts', "duplicate('import-duplicate')", 'lib/core.ts#record'],
    // A destructured local shadows the import to the documented pattern depth;
    // a pattern nested one level deeper is not searched, so the import is what
    // the name resolves to there.
    ['callers/patterns.ts', "record('within-pattern-depth')", 'nothing'],
    ['callers/patterns.ts', "record('past-pattern-depth')", 'lib/core.ts#record'],
    ['callers/imports.ts', "core.record('import-namespace')", 'nothing'],
    ['callers/imports.ts', "declared('import-declaration-file')", 'nothing'],
    ['callers/imports.ts', "generatedHelper('import-excluded-directory')", 'nothing'],
    ['callers/imports.ts', "formatLabel('import-component-module')", 'nothing'],
    // The barrel spells a type-only clause, a clause naming another export, a
    // namespace re-export and an unresolvable clause before the one that
    // carries `record`; the resolver steps over all four.
    ['callers/through-barrels.ts', "record('barrel-named')", 'lib/core.ts#record'],
    ['callers/through-barrels.ts', "recordDefault('barrel-default')", 'lib/core.ts#default'],
    ['callers/through-barrels.ts', "other('barrel-other')", 'lib/core.ts#other'],
    ['callers/through-barrels.ts', "everything.record('barrel-namespace')", 'nothing'],
  ])('in %s, resolves %s to %s', (file, callText, target) => {
    const found = attributionAt(file, callText);

    if (target === 'nothing') {
      expect(found).toBeUndefined();

      return;
    }

    expect(found === undefined ? undefined : fileAndName(found.to)).toBe(target);
    expect(found?.to.kind).toBe('server-function');
  });

  it('reaches no node in a declaration file, an excluded directory or a component module', () => {
    // The loader indexes neither a declaration file nor a module under an
    // excluded directory, so no node exists there for an edge to reach; a
    // component module is indexed but declares no server function.
    expect(cascade.results.has('lib/ambient.d.ts')).toBe(false);
    expect(cascade.results.has('lib/generated/helpers.ts')).toBe(false);
    expect(resultFor(cascade, 'components/Labels.tsx')).toStrictEqual({ nodes: [], edges: [] });
    expect(
      resultFor(cascade, 'callers/imports.ts')
        .edges.map((edge) => fileAndName(nodeById(cascade, edge.to)))
        .sort(),
    ).toStrictEqual(['lib/core.ts#default', 'lib/core.ts#record', 'lib/core.ts#record']);
  });
});

describe('serverFunctionsExtractor: same-file call targets', () => {
  it.each([
    [
      'lib/local-targets.ts',
      "helper('module-initialiser-call')",
      'symbol computedValue',
      'symbol helper',
    ],
    ['lib/local-targets.ts', "helper('local-function')", 'server-function entry', 'symbol helper'],
    [
      'lib/local-targets.ts',
      "arrowHelper('local-arrow')",
      'server-function entry',
      'symbol arrowHelper',
    ],
    [
      'lib/local-targets.ts',
      "exported('local-exported')",
      'server-function entry',
      'server-function exported',
    ],
    ['lib/surface.ts', "wrap(() => 'wrapped')", 'symbol wrapped', 'symbol wrap'],
    ['app/wrapped/route.ts', 'withTiming(async', 'symbol POST', 'symbol withTiming'],
    ['app/helpers/route.ts', 'local();', 'api-route /helpers', 'symbol local'],
    ['components/Handlers.tsx', 'makeHandler()}', 'component Form', 'symbol makeHandler'],
  ])('in %s, records %s from the %s node to the %s node', (file, callText, from, to) => {
    const found = requiredAttribution(file, callText);

    expect(kindAndName(found.from)).toBe(from);
    expect(kindAndName(found.to)).toBe(to);
    expect(found.to.file, 'a same-file target lives in the calling module').toBe(file);
  });

  it('positions a same-file symbol target at the declaration identifier, read from the raw text', () => {
    const file = 'lib/local-targets.ts';
    const text = cascadeText(file);

    expect(positionOfNode(requiredAttribution(file, "helper('local-function')").to)).toStrictEqual(
      anchorPosition(text, ['function helper(', 'helper']),
    );
    expect(
      positionOfNode(requiredAttribution(file, "arrowHelper('local-arrow')").to),
    ).toStrictEqual(anchorPosition(text, ['const arrowHelper', 'arrowHelper']));
  });

  it.each([
    ["record('shadowed-by-parameter')", 'a parameter shadowing the import of the same name'],
    ['unassigned?.(', 'a module-level binding with no initialiser'],
    ["picked('local-destructured')", 'a destructured module-level binding'],
    ['notAFunction()', 'a module-level binding initialised with a value'],
    ['Klass()', 'a class declaration'],
    ["nested('local-nested')", 'a function declared inside another function'],
  ])('records no edge for the call %s, whose callee is %s', (callText) => {
    expect(
      cascadeText('lib/local-targets.ts'),
      'the shadowing case is only meaningful while the import is present',
    ).toContain("import { record } from './core';");
    expect(attributionAt('lib/local-targets.ts', callText)).toBeUndefined();
  });

  it('still resolves the import the parameter shadows everywhere the parameter is out of scope', () => {
    expectOwner([
      'lib/local-targets.ts',
      'exported-calls-import',
      'server-function exported',
      ['function exported(', 'exported'],
    ]);
  });
});

/** Owners in and around classes, and of calls written outside every function. */
const CLASS_AND_MODULE_OWNERS: readonly OwnerRow[] = [
  ['lib/owners.ts', 'property-initialiser', 'symbol total', ['total = record', 'total']],
  ['lib/owners.ts', 'private-initialiser', 'file lib/owners.ts'],
  ['lib/owners.ts', 'property-arrow', 'symbol handle', ['handle = ()', 'handle']],
  [
    'lib/owners.ts',
    'constructor',
    'symbol constructor',
    ["constructor() {\n    record('constructor')", 'constructor'],
  ],
  ['lib/owners.ts', 'method', 'symbol load', ['load(): string {', 'load']],
  ['lib/owners.ts', 'getter', 'symbol size', ['get size()', 'size']],
  ['lib/owners.ts', 'setter', 'symbol size', ['set size(', 'size']],
  ['lib/owners.ts', 'static-method', 'symbol make', ['static make()', 'make']],
  ['lib/owners.ts', 'computed-name', 'file lib/owners.ts'],
  ['lib/owners.ts', 'private-method', 'file lib/owners.ts'],
  [
    'lib/owners.ts',
    'class-expression-constructor',
    'symbol Maker',
    ['const Maker = class', 'Maker'],
  ],
  ['lib/owners.ts', 'class-expression-method', 'symbol Maker', ['const Maker = class', 'Maker']],
  [
    'lib/owners.ts',
    'function-local-class',
    'server-function factory',
    ['function factory(', 'factory'],
  ],
  ['lib/owners.ts', 'non-exported-function', 'symbol internal', ['function internal(', 'internal']],
  [
    'lib/owners.ts',
    'non-exported-arrow',
    'symbol internalArrow',
    ['const internalArrow', 'internalArrow'],
  ],
  ['lib/owners.ts', 'module-initialiser', 'symbol cached', ['const cached', 'cached']],
  ['lib/owners.ts', 'destructured-initialiser', 'file lib/owners.ts'],
  ['lib/owners.ts', 'bare-statement', 'file lib/owners.ts'],
  ['lib/owners.ts', 'block-scoped', 'file lib/owners.ts'],
  ['lib/owners.ts', 'nested-callback', 'server-function outer', ['function outer(', 'outer']],
  ['lib/default-class.ts', 'default-class-method', 'symbol load', ['load(): string', 'load']],
  [
    'lib/default-call.ts',
    'default-expression',
    'symbol default',
    ["record('default-expression')", 'record'],
  ],
  ['lib/export-equals.ts', 'export-equals', 'file lib/export-equals.ts'],
];

describe('serverFunctionsExtractor: owners in and around classes, and outside every function', () => {
  // A member of a module-level class is inventoried as a symbol; a member with
  // no name the graph can carry (computed, private), a member of a class
  // expression and a call outside every addressable declaration fall outwards
  // — to the declarator that holds the class expression, or to the file.
  it.each(CLASS_AND_MODULE_OWNERS)(
    'in %s, attributes the call labelled %s to the %s node',
    (...row) => {
      expectOwner(row);
    },
  );

  it('emits a node only for the exported functions of a module whose calls sit in classes', () => {
    expect(serverFunctionsOf(cascade, 'lib/owners.ts').map((node) => node.name)).toStrictEqual([
      'factory',
      'outer',
    ]);
    expect(serverFunctionsOf(cascade, 'lib/default-class.ts')).toStrictEqual([]);
  });
});

/** Owners in modules that render. */
const COMPONENT_OWNERS: readonly OwnerRow[] = [
  ['components/Wrappers.tsx', 'memo-wrapped', 'component MemoRow', ['const MemoRow', 'MemoRow']],
  [
    'components/Wrappers.tsx',
    'forward-ref-wrapped',
    'component RefField',
    ['const RefField', 'RefField'],
  ],
  [
    'components/Wrappers.tsx',
    'four-wrappers',
    'component FourMemos',
    ['const FourMemos', 'FourMemos'],
  ],
  ['components/Board.tsx', 'class-component-render', 'component Board', ['class Board', 'Board']],
  [
    'components/Board.tsx',
    'class-component-method',
    'symbol refresh',
    ['refresh(): void', 'refresh'],
  ],
  [
    'components/Board.tsx',
    'anonymous-class-render',
    'component Board',
    ['export default class', 'export'],
  ],
  [
    'components/Anonymous.tsx',
    'anonymous-function-component',
    'component Anonymous',
    ['export default function', 'export'],
  ],
  ['components/Shapes.tsx', 'concise-component', 'component Tile', ['const Tile', 'Tile']],
  [
    'components/Shapes.tsx',
    'lowercase-arrow',
    'symbol lowerTile',
    ['const lowerTile', 'lowerTile'],
  ],
  ['components/Shapes.tsx', 'component-callback', 'component Panel', ['function Panel(', 'Panel']],
  [
    'components/NotComponents.tsx',
    'non-wrapper-call',
    'symbol Unwrapped',
    ['const Unwrapped', 'Unwrapped'],
  ],
  [
    'components/NotComponents.tsx',
    'five-wrappers',
    'symbol FiveMemos',
    ['const FiveMemos', 'FiveMemos'],
  ],
  [
    'components/NotComponents.tsx',
    'markup-module-service',
    'server-function markupHelper',
    ['function markupHelper(', 'markupHelper'],
  ],
];

describe('serverFunctionsExtractor: component owners and component modules', () => {
  // `memo` and `React.forwardRef` are looked through to the function they
  // wrap, to the documented depth; an anonymous default component is named for
  // its file; a class component owns only what its `render` method calls.
  it.each(COMPONENT_OWNERS)('in %s, attributes the call labelled %s to the %s node', (...row) => {
    expectOwner(row);
  });

  it.each([
    'components/Wrappers.tsx',
    'components/Board.tsx',
    'components/Anonymous.tsx',
    'components/Shapes.tsx',
    'components/Handlers.tsx',
  ])('emits no server-function node from the component module %s', (file) => {
    expect(serverFunctionsOf(cascade, file)).toStrictEqual([]);
  });

  it('treats a markup module none of whose declarations is a component as a server module', () => {
    // A string, an uninitialised and a destructured binding, a wrapper call with
    // no argument, an element-access callee, an arrow returning no markup, a
    // lowercase function, a generator, a class whose `render` returns no markup,
    // a class with no `render` at all, a non-wrapper call and a component past
    // the wrapper depth bound: each is refused, so the module qualifies and its
    // exported function is a server function.
    expect(
      serverFunctionsOf(cascade, 'components/NotComponents.tsx').map((node) => node.name),
    ).toStrictEqual(['markupHelper']);
  });
});

/** Owners in a module whose markup binds handlers, in every shape the handler step reads. */
const HANDLER_OWNERS: readonly OwnerRow[] = [
  ['components/Handlers.tsx', 'named-handler', 'handler save', ['function save(', 'save']],
  [
    'components/Handlers.tsx',
    'factory-handler',
    'handler makeHandler',
    ['function makeHandler(', 'makeHandler'],
  ],
  [
    'components/Handlers.tsx',
    'parenthesised-handler',
    'handler wrappedHandler',
    ['function wrappedHandler(', 'wrappedHandler'],
  ],
  [
    'components/Handlers.tsx',
    'too-deeply-wrapped-handler',
    'symbol deepHandler',
    ['function deepHandler(', 'deepHandler'],
  ],
  ['components/Handlers.tsx', 'shadowed-handler', 'symbol submit', ['function submit(', 'submit']],
  [
    'components/Handlers.tsx',
    'conditionally-bound',
    'symbol chooser',
    ['function chooser(', 'chooser'],
  ],
  [
    'components/Handlers.tsx',
    'inline-arrow',
    'handler onReset',
    ["() => record('inline-arrow')", '('],
  ],
  [
    'components/Handlers.tsx',
    'inline-function',
    'handler onScroll',
    ["function () { record('inline-function')", 'function'],
  ],
  ['components/Handlers.tsx', 'inline-nested', 'handler onWheel', ['() => [1].forEach', '(']],
  [
    'components/Handlers.tsx',
    'non-handler-attribute',
    'component Form',
    ['function Form(', 'Form'],
  ],
];

describe('serverFunctionsExtractor: markup-bound handlers', () => {
  // A handler is claimed only where its node's identity is reproducible: an
  // inline function, or a name whose scope walk from the binding site lands on
  // this very declaration. A parameter of the same name, a conditional, a
  // member access, a member-access callee, a string attribute and a binding
  // wrapped past the depth bound all leave the call to the next step.
  it.each(HANDLER_OWNERS)('in %s, attributes the call labelled %s to the %s node', (...row) => {
    expectOwner(row);
  });

  it('starts every handler-owned edge at a handler node ./event-handlers.ts emits', () => {
    const file = 'components/Handlers.tsx';
    const handlerIds = new Set(
      eventHandlersExtractor
        .extract(contextFor(cascade.loaded, sourceFileOf(cascade, file), file))
        .nodes.filter((node) => node.kind === 'handler')
        .map((node) => node.id),
    );
    const handlerOwned = resultFor(cascade, file).edges.filter(
      (edge) => nodeById(cascade, edge.from).kind === 'handler',
    );

    expect(handlerOwned.map((edge) => nodeById(cascade, edge.from).name)).toStrictEqual([
      'save',
      'makeHandler',
      'wrappedHandler',
      'onReset',
      'onScroll',
      'onWheel',
    ]);
    for (const edge of handlerOwned) {
      expect(
        handlerIds.has(edge.from),
        'a derived handler id must be one the handler extractor emitted',
      ).toBe(true);
    }
  });
});

/**
 * Route modules whose handler step 2 names, with the route path and the text
 * the route entry is anchored at — the earliest handler declaration of an App
 * Router module, the default export of a Pages Router one.
 */
const ROUTED_HANDLERS: readonly (readonly [
  file: string,
  label: string,
  routePath: string,
  anchor: OwnerAnchor,
])[] = [
  [
    'app/(group)/@slot/items/[id]/route.ts',
    'grouped-dynamic-route',
    '/items/[id]',
    ['export async function GET', 'export'],
  ],
  ['app/route.ts', 'root-route', '/', ['export async function GET', 'export']],
  [
    'app/docs/[[...rest]]/route.ts',
    'optional-catch-all-route',
    '/docs/[[...rest]]',
    ['export async function GET', 'export'],
  ],
  ['src/app/nested/route.ts', 'src-app-route', '/nested', ['export async function GET', 'export']],
  [
    'app/files/[...path]/route.ts',
    'clause-published-route',
    '/files/[...path]',
    ['handler as PUT', 'handler'],
  ],
  ['app/multi/route.ts', 'multi-declarator-get', '/multi', ['GET = async', 'GET']],
  ['app/multi/route.ts', 'multi-declarator-post', '/multi', ['GET = async', 'GET']],
  ['app/wrapped/route.ts', 'wrapped-route-handler', '/wrapped', ['export const POST', 'export']],
  [
    'app/clause-default/route.ts',
    'clause-exported-method',
    '/clause-default',
    ['function GET(', 'function'],
  ],
  ['app/reexported/route.ts', 'beside-a-reexport', '/reexported', ['{ GET } from', 'GET']],
  ['pages/api/index.ts', 'pages-index', '/api', ['export default function handler', 'export']],
  [
    'pages/api/(grouped)/thing.ts',
    'pages-parenthesised-directory',
    '/api/(grouped)/thing',
    ['export default function handler', 'export'],
  ],
  [
    'src/pages/api/rooted.ts',
    'src-pages-route',
    '/api/rooted',
    ['export default function handler', 'export'],
  ],
  ['pages/api/[slug].ts', 'pages-default-arrow', '/api/[slug]', ['export default async', 'export']],
  ['pages/api/clause.ts', 'pages-clause-default', '/api/clause', ['function handler(', 'function']],
  [
    'pages/api/clause-arrow.ts',
    'pages-clause-arrow',
    '/api/clause-arrow',
    ['handler as default', 'handler'],
  ],
  [
    'pages/api/intent.ts',
    'pages-default-intent',
    '/api/intent',
    ['async function handler', 'async'],
  ],
];

describe('serverFunctionsExtractor: route identities step 2 re-derives', () => {
  it.each(ROUTED_HANDLERS)(
    'attributes the handler call in %s (labelled %s) to the api-route node for %s',
    (file, label, routePath, anchor) => {
      const { from } = requiredAttribution(file, recordCall(label));
      const entry = routeEntryForFile(sourceFileOf(cascade, file), file);

      if (entry === undefined) {
        throw new Error(`${file} must derive a route entry`);
      }

      // Field by field against the entry `./api-routes.ts` builds its node from,
      // and against a position read from the raw text: the local re-derivation
      // must agree with both.
      expect(kindAndName(from)).toBe(`api-route ${routePath}`);
      expect(entry.routePath).toBe(routePath);
      expect(from.file).toBe(entry.file);
      expect(positionOfNode(from)).toStrictEqual({
        line: entry.location.line,
        column: entry.location.column,
      });
      expect(positionOfNode(from)).toStrictEqual(anchorPosition(cascadeText(file), anchor));
    },
  );

  it.each([
    ['app/_private/route.ts', 'private-folder-route', 'GET', 'a private folder'],
    ['app/(.)intercepted/route.ts', 'intercepting-route', 'GET', 'an intercepting route'],
    ['app/bad[segment]/route.ts', 'malformed-segment-route', 'GET', 'a malformed bracket segment'],
    ['app/[bad.name]/route.ts', 'illegal-parameter-route', 'GET', 'an illegal parameter name'],
    [
      'app/[...all]/tail/route.ts',
      'misplaced-catch-all-route',
      'GET',
      'a catch-all that is not last',
    ],
    ['pages/api/_internal.ts', 'pages-private-stem', 'handler', 'a private file name'],
    ['pages/api/middleware.ts', 'pages-middleware', 'handler', 'middleware'],
    ['pages/api/_private/thing.ts', 'pages-private-directory', 'handler', 'a private directory'],
    [
      'pages/api/bad[dir]/thing.ts',
      'pages-malformed-directory',
      'handler',
      'a malformed directory',
    ],
    ['pages/api/bad[stem].ts', 'pages-malformed-stem', 'handler', 'a malformed file name'],
    [
      'pages/api/[...all]/more.ts',
      'pages-misplaced-catch-all',
      'handler',
      'a catch-all that is not last',
    ],
    [
      'pages/api/module.mts',
      'pages-unsupported-extension',
      'handler',
      'an extension the router does not serve',
    ],
  ])('refuses %s (labelled %s) and names the %s symbol instead, for %s', (file, label, name) => {
    // Neither derivation routes the module, so step 2 is skipped and the call
    // falls through to the symbol the declaration always has.
    expect(routeEntryForFile(sourceFileOf(cascade, file), file)).toBeUndefined();
    expectOwner([file, label, `symbol ${name}`, [`function ${name}(`, name]]);
  });

  it.each([
    [
      'app/clause-default/route.ts',
      'default-intent-method',
      'DELETE',
      'is the default export, which is no method export',
    ],
    [
      'app/aliased-default/route.ts',
      'aliased-to-default',
      'PATCH',
      'is published only as the default export',
    ],
    [
      'app/default-named/route.ts',
      'default-function-named-for-method',
      'POST',
      'is a default export named for a method',
    ],
    ['app/helpers/route.ts', 'route-exported-helper', 'helper', 'is exported under no method name'],
    [
      'app/cjs/route.ts',
      'export-equals-route',
      'GET',
      'sits in a module with an export assignment syntax cannot read',
    ],
    [
      'pages/api/no-default.ts',
      'pages-without-default',
      'helper',
      'sits in a module with no default export',
    ],
    [
      'pages/about.ts',
      'pages-rendering-module',
      'handler',
      'sits in a module that renders rather than answers',
    ],
  ])(
    'does not credit the route of %s to the call labelled %s, whose function %s %s',
    (file, label, name) => {
      // The route map names a route for every one of these modules; what differs
      // is that the enclosing function is not its handler — or, for the export
      // assignment and the rendering module, that step 2 declines by design.
      expect(routeEntryForFile(sourceFileOf(cascade, file), file)).toBeDefined();
      expectOwner([file, label, `symbol ${name}`, [`function ${name}(`, name]]);
    },
  );

  it.each([
    [
      'app/helpers/route.ts',
      'route-local-arrow',
      'symbol local',
      'a clause-exported const not named for a method',
      ['const local', 'local'],
    ],
    [
      'pages/api/class-handler.ts',
      'pages-class-member',
      'symbol handle',
      'a member of the default-exported class',
      ['handle(): string', 'handle'],
    ],
    [
      'pages/api/_arrow.ts',
      'refused-default-arrow',
      'symbol default',
      'a default-exported arrow in a module step 2 refuses',
      ['async () =>', 'async'],
    ],
  ] as const)(
    'in %s, attributes the call labelled %s to the %s node, being %s',
    (file, label, owner, _reason, anchor) => {
      expectOwner([file, label, owner, anchor]);
    },
  );

  it('treats a module of the App Router tree that is neither route nor page as a server module', () => {
    expect(
      serverFunctionsOf(cascade, 'app/area/handler.ts').map((node) => node.name),
    ).toStrictEqual(['relay']);
    expectOwner([
      'app/area/handler.ts',
      'app-tree-service-module',
      'server-function relay',
      ['function relay(', 'relay'],
    ]);

    // A function named for a method is a plain service function outside a route
    // module, and re-exporting it from one records no call.
    expect(
      serverFunctionsOf(cascade, 'app/shared-handler.ts').map((node) => node.name),
    ).toStrictEqual(['GET']);
    expect(
      resultFor(cascade, 'app/reexported/route.ts').edges.map((edge) =>
        fileAndName(nodeById(cascade, edge.to)),
      ),
    ).toStrictEqual(['lib/core.ts#record']);
  });
});

describe('serverFunctionsExtractor: what it reports instead of throwing', () => {
  it('declines a file that is not a safe project-relative path, and logs why without quoting it', () => {
    const file = 'lib/core.ts';
    const { logger, records } = recordingLogger();
    const result = serverFunctionsExtractor.extract({
      ...contextFor(cascade.loaded, sourceFileOf(cascade, file), file),
      file: '../outside.ts',
      logger,
    });

    expect(result).toStrictEqual({ nodes: [], edges: [] });
    expect(records).toStrictEqual([
      {
        level: 'warn',
        message: 'Module skipped: its path is not a safe project-relative path',
        fields: { extractorId: SERVER_FUNCTIONS_EXTRACTOR_ID, file: '../outside.ts' },
      },
    ]);
  });

  it.each([
    ['a thrown string', 'string', (): unknown => SCRATCH_SOURCE_MARKER],
    [
      'an error with an empty name',
      'Error',
      (): unknown => Object.assign(new Error(SCRATCH_SOURCE_MARKER), { name: '' }),
    ],
  ])('names %s in an extractor-failed diagnostic as %s', (_label, described, thrown) => {
    const file = 'callers/imports.ts';
    const hostile: LoadedProject = {
      project: cascade.loaded.project,
      projectRoot: cascade.loaded.projectRoot,
      tsConfigFilePath: cascade.loaded.tsConfigFilePath,
      sourceFiles: () => cascade.loaded.sourceFiles(),
      projectRelative: () => {
        throw thrown();
      },
    };
    const result = serverFunctionsExtractor.extract(
      contextFor(hostile, sourceFileOf(cascade, file), file),
    );

    expect(result).toStrictEqual({
      nodes: [],
      edges: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'extractor-failed',
          message: `Reading server functions failed; this module contributes no server-function node and no calls edge (${described}).`,
          file,
          extractorId: SERVER_FUNCTIONS_EXTRACTOR_ID,
        },
      ],
    });
  });
});
