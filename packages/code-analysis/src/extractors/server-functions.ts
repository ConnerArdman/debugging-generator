/**
 * `server-functions` — the server-function extractor of `@debuggen/code-analysis`.
 *
 * One of the per-file abstract-syntax-tree extractors `../indexer.ts` runs over
 * every indexable module of a target project. It owns:
 *
 * - the **`server-function` node kind** — one node per exported module-level
 *   function of a module that is neither a React component module nor a
 *   route/page module, carrying the required {@link ServerFunctionNodeData}
 *   payload (`isAsync`, `exported`); and
 * - the **`calls` edges that point *into* those nodes** — from the route
 *   handler, page component, event handler, sibling service function or
 *   module-level declaration whose body contains the call.
 *
 * Those edges are what makes a cross-tier path traversable: without them
 * `../graph/query.ts`'s `pathBetween` cannot get from an `api-route` node into
 * the service layer, `whoCalls` cannot report a service function's fan-in from
 * static edges alone, and `packages/instrumentation` cannot justify a
 * `function-timing` action on a named service symbol. The service's progress
 * view reads the same chain when it reports that a route's downstream
 * dependency was found (AAP 0.7.1 Group 2).
 *
 * ## Reconciliation: `routes-to` is **not** emitted here
 *
 * This file's brief asked for a `routes-to` edge from an `api-route` node to a
 * `server-function` node, *unless* `../graph/types.ts` documents something
 * different — and it does. The edge table on `CODE_EDGE_KINDS` fixes
 * `routes-to` as `api-call` → `api-route`, "produced after both endpoints
 * exist, which is why it is the one edge kind an extractor cannot emit on its
 * own", and `./api-routes.ts` repeats that division of labour while assigning
 * *this* module "the `calls` linkage from a route into the service layer".
 * Emitting a `routes-to` edge between two other kinds would not produce a
 * slightly different graph: it would produce one whose route resolution means
 * something else than every consumer reads it as. So `types.ts` is followed —
 * no `routes-to` edge is produced here, and the route-to-service linkage is the
 * `calls` edge from the `api-route` node, which is the first of the two shapes
 * the reachability invariant on `CODE_EDGE_KINDS` sanctions ("a `calls` edge
 * straight from the `api-route` node, or a `declares` hop to the exported
 * method's `symbol` node which then `calls` the server function").
 *
 * That choice is load-bearing rather than cosmetic: `pathBetween` traverses
 * **outwards** by default, and `./symbols.ts` is the only emitter of `declares`
 * (`file` → `symbol`), so an `api-route` node has no outgoing edge at all
 * unless this module gives it one.
 *
 * ## The owner cascade
 *
 * A `calls` edge needs a `from`, and the node that best describes "where this
 * call was written" depends on what encloses it. The innermost **addressable**
 * owner wins, tried in this order for each enclosing function, innermost first:
 *
 * 1. the enclosing function is bound by an `on[A-Z]` markup attribute in this
 *    file → the **`handler`** node (`./event-handlers.ts`'s naming);
 * 2. else this file is a request-handler route module and the enclosing
 *    function is one of its HTTP-method exports (App Router) or its default
 *    export (legacy `pages/api/**`) → the **`api-route`** node
 *    (`./api-routes.ts`'s naming). Both are read off this module's **export
 *    surface** rather than off the `export` keyword, so a handler published by
 *    a clause (`export { handler as PUT }`) or by an `export default
 *    <identifier>` assignment is recognised as readily as one the keyword
 *    marks;
 * 3. else the enclosing function matches the component shape → the
 *    **`component`** node (`./react-components.ts`'s naming);
 * 4. else the enclosing function is a module-level function of a server module
 *    that the same export surface publishes under some name → its own
 *    **`server-function`** node, which is the node this extractor emits for it;
 * 5. else the enclosing declaration is module-level (or a member of a
 *    module-level class) → its **`symbol`** node (`./symbols.ts`'s naming);
 * 6. else → the **`file`** node (`./imports.ts`'s naming).
 *
 * `./api-calls.ts`'s brief documents the same cascade **without** step 3, so a
 * call written in a component body is attributed there to that component's
 * `symbol` node instead. Both spellings are non-dangling and no invariant
 * depends on which kind an edge starts at, so the difference is recorded here
 * and no sibling extractor is modified. The six-step form is kept because a
 * call can originate in a rendered page rather than in an HTTP handler, and a
 * `component` origin says so.
 *
 * {@link CodeEdge} has **no payload field**, so the owner kind cannot be
 * recorded on the edge itself; a cascade misjudgement is diagnosed from the
 * edge's `from` id together with its site (`file`, `line`, `column`), which is
 * the call expression's own position.
 *
 * ## Resolution, and its bounds
 *
 * A call is attributed to a `server-function` node only when this module can
 * prove that node exists — an edge to a node nobody emits is dropped by
 * `../graph/graph.ts` as `dangling-edge`, which silently deletes a tier
 * boundary. The proof is four steps, every one syntactic:
 *
 * 1. the callee is a plain identifier that no enclosing scope declares, and an
 *    import declaration of this file binds it (a type-only import binds
 *    nothing at run time and is ignored);
 * 2. the import's module specifier resolves to a file of this project through
 *    ts-morph's `getModuleSpecifierSourceFile()`, including a hop through a
 *    `paths` alias declared in the target project's configuration — which is
 *    how every service import of this package's own corpus arrives;
 * 3. if the resolved module re-exports the name rather than declaring it, the
 *    module-specifier re-export forms (`export { name } from`,
 *    `export { default as Name } from`, `export * from`) are followed to the
 *    declaring file, **bounded to {@link MAX_REEXPORT_HOPS} hops** with a
 *    visited-file guard so a cyclic barrel costs bounded work;
 * 4. the declaring file is one the indexer will visit, the name is an exported
 *    module-level function there, and that module qualifies as a server module
 *    — which together are exactly the conditions under which this extractor
 *    emits a node for it when its own turn comes.
 *
 * A same-file call is resolved by the same rule with the import hop removed:
 * the callee names an exported module-level function of this module, and this
 * module is a server module.
 *
 * **"Exported" always means the module's export surface**, never the `export`
 * keyword: {@link collectModuleExports} resolves the keyword, a local export
 * clause (`export { loadThing }`, `export { handler as PUT }`) and an
 * `export default <identifier>` assignment to the declaration each one names,
 * and every judgement in this module — which nodes it emits, which call target
 * it resolves, and which node a call is attributed to by steps 2 and 4 of the
 * cascade — is made against that one surface. That is what keeps the owner
 * steps and the emitter in agreement: a function the cascade attributes a call
 * to is a function this extractor has emitted a node for, so the edge cannot
 * dangle.
 *
 * Anything else yields no edge and no diagnostic: a member-access or namespace
 * callee (`lib.load()`) is a value question rather than a syntactic one, an
 * unresolvable specifier is the ordinary state of a project whose dependencies
 * are not installed, and an import that is never called is an import rather
 * than a call.
 *
 * ## What it deliberately does not emit
 *
 * - **No `file` node.** `./imports.ts` owns that kind and is its only emitter;
 *   this module only *derives* the file node's id so its fallback edges start
 *   at a node some other extractor provides.
 * - **No `symbol`, `component`, `handler` or `api-route` node.** Those kinds
 *   belong to the sibling extractors. This module only derives their ids, by
 *   the rules copied below, and a derived id that differs by one character is
 *   an edge `../graph/graph.ts` drops rather than a slightly wrong one.
 * - **No `references` edge.** Reference resolution is deliberately lazy and
 *   belongs to `../indexer.ts`'s `createReferenceResolver`; emitting references
 *   at index time would force full type resolution over the whole program, and
 *   `../graph/query.ts`'s `whoCalls` is specified to answer a fan-out from the
 *   static `calls` edges this module produces without consulting a resolver at
 *   all.
 * - **No `routes-to` edge**, per the reconciliation above.
 * - **No node for a non-exported helper.** Nothing downstream can address one:
 *   an instrumentation action names a `(file, symbol)` pair another module can
 *   reach. An exported value that is not a function is `./symbols.ts`'s
 *   business.
 *
 * ## Abstract-syntax-tree first, no type resolution
 *
 * Qualification and resolution read declaration syntax, markup-attribute shape
 * and file-path convention only. The one resolution step is **module**
 * resolution, which is what an aliased specifier needs and nothing more. No
 * type is consulted, no symbol is resolved through the checker and no
 * expression is evaluated, so a target project whose dependencies are not
 * installed — the ordinary state of a project indexed for the first time, and
 * the deliberate state of this package's corpus — is indexed exactly as fully
 * as one whose `node_modules` is warm.
 *
 * ## Purity, failure and determinism
 *
 * Synchronous and pure with respect to the project and the machine: it reads
 * the tree of the file it was handed plus the modules that file imports, writes
 * no file, opens no socket, caches nothing beyond the call it is inside,
 * mutates no node, adds no source file to the project and logs no source text.
 * `extract` never throws — a module it cannot read becomes an
 * `extractor-failed` diagnostic naming the file and the thrown value's class,
 * never its message, per the privacy constraint on `INDEX_DIAGNOSTIC_CODES` —
 * and every other file of the project is indexed regardless. Nodes and edges
 * are emitted in source order, so two runs over unchanged source serialise
 * byte-identically, which is the reproducibility property `../indexer.ts`
 * promises and the index cache depends on.
 *
 * ## The local route identity, and the obligation it carries
 *
 * This module imports nothing outside `../graph/` and `../project.ts`: its
 * dependency constraint forbids `../indexer.ts`, `../graph/query.ts`,
 * `../summary.ts`, `../route-map.ts`, `../cache.ts`, `../search/**`,
 * `../source-map/**` and every sibling extractor, because all of those sit at
 * or above the layer an extractor is run from — `../route-map.ts` is a
 * composition module that consumes a `LoadedProject` and a `CodeIndex`, so
 * importing it from here inverts the layering.
 *
 * Step 2 of the cascade nevertheless needs one thing that derivation knows: the
 * identity of the `api-route` node `./api-routes.ts` emits for this file. So
 * {@link routeModuleIdentityOf} re-derives **that one question and nothing
 * wider** — is this module a request handler, under which convention, and what
 * is its node's id — from the file path and the module's own syntax. It answers
 * about request-handler route modules only (`app/**\/route.*` and
 * `pages/api/**`); it derives no route map, matches no request, reports no
 * method list and reads no `page.*` module, all of which remain
 * `../route-map.ts`'s exclusively.
 *
 * It **refuses whatever it cannot vouch for**, and refusing is cheap: the
 * cascade then falls through to the component, server-function or symbol step,
 * whose nodes always exist, so a refusal costs *specificity* and never
 * correctness. Returning a wrong id would cost correctness — an `api-route` id
 * that differs from `./api-routes.ts`'s by one character is a `dangling-edge`
 * `../graph/graph.ts` drops, which silently deletes the route-to-service tier
 * boundary. Hence the refusals: an intercepting route, a private folder, a
 * malformed bracket segment, a misplaced catch-all, an unsupported extension,
 * an unsafe path, and a module containing an `export =` assignment (a form the
 * route map sees through the type checker and this abstract-syntax-tree-only
 * extractor cannot).
 *
 * **What a future editor has to keep in step.** The derivation is duplicated,
 * and a duplicate that drifts is worse than either copy. If `../route-map.ts`
 * changes any of the following, change it here in the same edit — and if the
 * two ever cannot be reconciled, make this helper refuse rather than let it
 * disagree:
 *
 * - the router roots, the routable file names, or the supported extensions
 *   ({@link APP_ROUTER_PREFIXES}, {@link PAGES_ROUTER_PREFIXES},
 *   {@link APP_HANDLER_STEM}, {@link APP_ROUTE_EXTENSIONS},
 *   {@link PAGES_ROUTE_EXTENSIONS});
 * - what a directory contributes to a URL, including route groups, parallel
 *   slots, private folders and intercepting routes
 *   ({@link classifyAppRouteDirectory});
 * - the dynamic-segment spellings, the legal parameter-name grammar or the
 *   catch-all-must-be-last rule ({@link classifyRouteSegment},
 *   {@link routePathOf});
 * - **where an entry is anchored** — the handler shapes it recognises and the
 *   position it reports for each ({@link appHandlerPosition},
 *   {@link pagesHandlerPosition}). This is the part that silently breaks:
 *   the position is half the node id, and the route map reaches it through
 *   ts-morph's checker-backed `isExported()` / `isDefaultExport()` while this
 *   helper reproduces the same answers from syntax
 *   ({@link LocalExportIntents});
 * - the id shape `./api-routes.ts` mints ({@link apiRouteNodeIdFor}).
 *
 * @module
 */

import {
  basenamePosix,
  extnamePosix,
  isSafeRelativePath,
  joinPosix,
  normalizePosix,
  toPosix,
} from '@debuggen/shared';
import { Node } from 'ts-morph';
import type {
  CallExpression,
  ClassDeclaration,
  ExportDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  SourceFile,
  VariableDeclaration,
} from 'ts-morph';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import { HTTP_METHOD_NAMES } from '../graph/types.js';
import type {
  CodeEdge,
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { isIndexableFile, shouldExcludePath } from '../project.js';

/* -------------------------------------------------------------------------------------------------
 * Identity and constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * This extractor's {@link Extractor.id}.
 *
 * Exported so `../indexer.ts`, a diagnostic consumer and a test can name it
 * without repeating a string literal — the convention `./api-routes.ts`
 * established. Stable across versions: renaming it would make previously
 * reported diagnostics untraceable to their source.
 */
export const SERVER_FUNCTIONS_EXTRACTOR_ID = 'server-functions';

/**
 * The result for a file that contributes nothing: no nodes, no edges, no
 * diagnostics.
 *
 * One frozen instance, shared. {@link ExtractorResult} requires `nodes` and
 * `edges` to be empty rather than absent so the indexer can concatenate without
 * a guard, and requires `diagnostics` to be absent rather than empty for a
 * clean extraction — both of which this value is.
 */
const NOTHING_FOUND: ExtractorResult = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
});

/**
 * How many module-specifier re-export hops are followed before a lookup gives
 * up.
 *
 * A barrel that re-exports a barrel is ordinary; four levels of them are not,
 * and an unbounded walk over a cyclic set of barrels would cost a stack rather
 * than a lookup. The visited-file guard makes a cycle terminate on its own;
 * this bound makes an acyclic chain terminate *cheaply*, and it is documented
 * because a silent bound is worse than a stated one.
 */
const MAX_REEXPORT_HOPS = 4;

/**
 * How many transparent wrappers are unwrapped while looking for the function a
 * declaration assigns.
 *
 * `(fn)`, `fn as T`, `fn satisfies T` and `fn!` change nothing about what is
 * assigned, and a real declaration nests at most a couple of them. The same
 * bound covers the component-wrapper unwrapping used for the component shape,
 * which is the rule `./react-components.ts` applies.
 */
const MAX_WRAPPER_DEPTH = 4;

/**
 * The name an anonymous default export is recorded under.
 *
 * The convention `./symbols.ts` fixes for the same situation, reused here so a
 * module whose service function is an unnamed `export default function` is
 * still addressable, and so that a `symbol`-node fallback derived for such a
 * declaration spells the same name that extractor spells.
 */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * The reserved member name a class constructor is recorded under by
 * `./symbols.ts`, needed when a call inside a constructor falls through to the
 * `symbol`-node step of the cascade.
 */
const CONSTRUCTOR_NAME = 'constructor';

/**
 * The markup-attribute shape that binds an event handler.
 *
 * The rule is the *shape* of the property name and never a list of event names,
 * which is what keeps any application's vocabulary out of this module
 * (AAP 0.5.4) and what makes a project's own `onSelect` prop behave exactly
 * like `onClick`. It is the rule `./event-handlers.ts` applies, restated here
 * because an extractor may not depend on a sibling.
 */
const HANDLER_ATTRIBUTE_PATTERN = /^on[A-Z]/;

/**
 * The React wrappers a component declaration may be assigned through.
 *
 * Matched by name only, bare (`memo`) or qualified (`React.memo`), exactly as
 * `./react-components.ts` matches them: no import is resolved and no type is
 * consulted, so the check keeps working in a project whose dependencies are not
 * installed.
 */
const COMPONENT_WRAPPER_NAMES: readonly string[] = Object.freeze(['memo', 'forwardRef']);

/**
 * The method a class component renders from.
 */
const RENDER_METHOD_NAME = 'render';

/**
 * The directory names a Next.js router tree can be rooted at, as path prefixes.
 *
 * Both conventional layouts, with and without a `src/` root, which are the same
 * four roots `../route-map.ts` derives a URL from by default, in the same probe
 * order. Read by {@link isRouteOrPageModule} to decide *module shape* and by
 * {@link routerRelativePath} to locate a module below its router root.
 */
const APP_ROUTER_PREFIXES: readonly string[] = Object.freeze(['app/', 'src/app/']);

/**
 * The directory prefixes of the legacy Pages Router, on the same terms as
 * {@link APP_ROUTER_PREFIXES}.
 */
const PAGES_ROUTER_PREFIXES: readonly string[] = Object.freeze(['pages/', 'src/pages/']);

/**
 * The file basenames, without extension, that make a module inside an App
 * Router tree a route or a page module rather than an ordinary one.
 */
const APP_ROUTER_MODULE_NAMES: readonly string[] = Object.freeze(['route', 'page']);

/**
 * The names an App Router route module can export a request handler under.
 *
 * Derived from {@link HTTP_METHOD_NAMES} minus `ANY`, on exactly the terms
 * `../route-map.ts` derives its own set: `ANY` is not an HTTP method and is
 * never exported — it is what a single dispatching entry point (a legacy
 * `pages/api/**` module) *reports*. Deriving it rather than spelling a method
 * list keeps one vocabulary, so a method added to `../graph/types.ts` is
 * recognised here in the same edit.
 */
const EXPORTABLE_HTTP_METHODS: ReadonlySet<string> = new Set<string>(
  HTTP_METHOD_NAMES.filter((method) => method !== 'ANY'),
);

/**
 * The URL separator, which is also the POSIX path separator, spelled once.
 */
const ROUTE_SEPARATOR = '/';

/**
 * The URL a route module with no segment below its router root serves.
 */
const ROOT_ROUTE_PATH = ROUTE_SEPARATOR;

/**
 * The extensions an App Router `route.*` module may carry.
 *
 * `../route-map.ts`'s set, which is the set `../project.ts` indexes: a route
 * module written in JavaScript is ordinary in a project that has not finished
 * migrating. Kept in step with that module — see the note on the local route
 * identity in this file's header.
 */
const APP_ROUTE_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * The extensions a Pages Router module may carry, narrower than
 * {@link APP_ROUTE_EXTENSIONS} on purpose: the framework's default page
 * extensions are `tsx`, `ts`, `jsx` and `js`, and a `.mjs`/`.cjs` file under
 * `pages/` is not served.
 */
const PAGES_ROUTE_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.tsx', '.js', '.jsx']);

/**
 * The App Router file name that makes a directory a request handler.
 *
 * A `page.*` module — and every other special file, now or later — is not a
 * request handler, which is why the test is against this one name rather than
 * against a list of names to exclude.
 */
const APP_HANDLER_STEM = 'route';

/** The Pages Router file name that collapses to its own directory. */
const PAGES_INDEX_STEM = 'index';

/**
 * The Pages Router file name that intercepts requests rather than answering
 * them.
 *
 * `_app`, `_document` and `_error` need no entry beside it: every name
 * beginning with `_` is refused as private.
 */
const PAGES_MIDDLEWARE_STEM = 'middleware';

/** The directory under a Pages Router tree whose modules answer requests. */
const PAGES_API_SEGMENT = 'api';

/**
 * An intercepting-route marker at the start of an App Router directory name:
 * `(.)`, `(..)`, `(...)` and, by the same prefix, `(..)(..)`.
 *
 * The URL such a route serves depends on where it is rendered from, which a
 * path cannot know, so a module below one is refused rather than guessed at.
 */
const INTERCEPTING_ROUTE_PREFIX = /^\(\.{1,3}\)/;

/**
 * A legal route-parameter name: anything that is not a separator, a bracket, a
 * dot or whitespace.
 *
 * Permissive on purpose, and `../route-map.ts`'s own grammar: a parameter name
 * reaches application code as an object key, so a hyphen or a non-ASCII letter
 * is legal there. What it must reject is a name that would make the segment
 * ambiguous — a nested bracket, an embedded separator, or the dots that spell a
 * catch-all.
 */
const ROUTE_PARAM_NAME = /^[^[\].\s/]+$/;

/**
 * The marker {@link classifyAppRouteDirectory} returns for a directory that is
 * legal but contributes nothing to the URL.
 *
 * A distinct sentinel rather than `undefined`, because `undefined` already
 * means "this module is not a route this helper can vouch for", and conflating
 * the two would turn every route group into a refusal.
 */
const SKIPPED_ROUTE_SEGMENT = Symbol('debuggen.server-functions.skipped-route-segment');

/**
 * The position a route module whose handler cannot be located is anchored at.
 *
 * `../route-map.ts`'s own fallback, and therefore the position
 * `./api-routes.ts` emits such a module's node at: opening the file at its
 * first line is a worse answer than opening it at the handler and a far better
 * one than refusing to open it, and the module still serves its path.
 */
const FILE_START_POSITION: Position = Object.freeze({ line: 1, column: 1 });

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/** A 1-based position in a file, on the {@link CodeNodeBase} convention. */
interface Position {
  /** The **1-based** line. */
  readonly line: number;
  /** The **1-based** column. */
  readonly column: number;
}

/**
 * One exported module-level function of a module: everything a
 * `server-function` node needs, plus the declaration node itself so a call site
 * can be matched to it by identity rather than by name.
 */
interface ExportedFunction {
  /**
   * The name the declaring module spells, which becomes
   * {@link CodeNodeBase.name}: the declared identifier, or
   * {@link DEFAULT_EXPORT_NAME} for an anonymous default export.
   *
   * The *declared* name and never the name an importer happens to bind it
   * under: a node positioned in a file is named as that file names it, which is
   * what keeps one function to one node across every module that imports it.
   */
  readonly declaredName: string;

  /** The **1-based** line of the declaration's identifier. */
  readonly line: number;

  /** The **1-based** column of the declaration's identifier. */
  readonly column: number;

  /** The last line of the whole declaration, never before {@link ExportedFunction.line}. */
  readonly endLine: number;

  /** Whether the function is declared `async`. */
  readonly isAsync: boolean;

  /**
   * The declaration the function belongs to: a function declaration, or the
   * variable declarator that assigns it.
   *
   * Compared by identity when the cascade asks "is the function this call sits
   * inside one of this module's exported functions", which is exact where a
   * name comparison would collide with a shadowing local of the same name.
   */
  readonly declaration: Node;
}

/**
 * One module-specifier re-export clause of a module, in source order.
 *
 * Only the forms that can carry a *value* are recorded: a type-only clause or
 * specifier re-exports nothing callable.
 */
interface ReexportClause {
  /** The declaration, kept so its specifier can be resolved lazily. */
  readonly declaration: ExportDeclaration;

  /**
   * The name this clause exports, or `undefined` for a star re-export, which
   * exports every name of its target under the same name.
   */
  readonly exportedAs: string | undefined;

  /**
   * The name to look for in the target module: the specifier's own name, which
   * differs from {@link ReexportClause.exportedAs} for
   * `export { local as Public } from` and is `'default'` for
   * `export { default as Public } from`. `undefined` for a star re-export,
   * where the looked-up name is whatever the caller asked for.
   */
  readonly sourceName: string | undefined;
}

/**
 * What one module exports, as far as syntax can tell.
 *
 * Computed once per module per `extract` call and cached: a route module and a
 * page module of the same project routinely import the same service module, and
 * re-reading its export list for each of them would multiply the cost of the
 * only expensive thing this extractor does.
 */
interface ModuleExports {
  /**
   * Export name → the function of this module it names.
   *
   * A function exported under two names appears twice, mapping to the same
   * {@link ExportedFunction} instance, which is what makes node de-duplication
   * by identity possible.
   */
  readonly functions: ReadonlyMap<string, ExportedFunction>;

  /** The module-specifier re-export clauses, in source order. */
  readonly reexports: readonly ReexportClause[];
}

/**
 * One local binding an import declaration of the file under extraction
 * introduces, and what it names in the module it comes from.
 */
interface ImportedBinding {
  /** The import declaration, kept so its specifier can be resolved lazily. */
  readonly declaration: ImportDeclaration;

  /**
   * The name to look for in the imported module: the specifier's imported name
   * for `import { X as Y }` (so `X`), and `'default'` for a default import.
   */
  readonly exportName: string;
}

/**
 * A resolved call target: the `server-function` node this extractor will emit
 * for it, described by the two fields its id is derived from beyond its kind.
 */
interface ResolvedTarget {
  /** The declaring module, project-relative POSIX. */
  readonly file: string;

  /** The function declared there. */
  readonly fn: ExportedFunction;
}

/**
 * The enclosing function of a call site, reduced to what the cascade asks about
 * it.
 *
 * Built for each function-like ancestor of a call expression, innermost first,
 * so that the first ancestor the cascade can address becomes the edge's `from`.
 */
interface FunctionCandidate {
  /** The function-like node itself: a declaration, an arrow or a function expression. */
  readonly fn: Node;

  /**
   * The declaration the function is addressable through: the function
   * declaration, the variable declarator that assigns it, the class member that
   * holds it, or the `export default` assignment that exports it.
   */
  readonly declaration: Node;

  /** The declared identifier, or `undefined` for an anonymous function. */
  readonly name: string | undefined;

  /**
   * Where a node for this declaration would be positioned: its identifier, or
   * the declaration itself when it has none — the rule every sibling extractor
   * applies.
   */
  readonly position: Position;

  /** Whether the declaration sits at module level. */
  readonly isModuleLevel: boolean;

  /** Whether the declaration leaves its module. */
  readonly exported: boolean;

  /** Whether the declaration is the module's default export. */
  readonly isDefaultExport: boolean;

  /**
   * The name of the module-level class that declares this member, for a class
   * method, and `undefined` for everything else.
   *
   * `./symbols.ts` records a member under its own name with the class in
   * {@link CodeNodeBase.symbol}, which does not participate in the node id — so
   * this field is what says "a `symbol` node exists for it" rather than what
   * names it.
   */
  readonly container: string | undefined;

  /**
   * The class that declares this member, for a class method, and `undefined`
   * for everything else.
   *
   * Kept because a class component renders from its `render` method: the
   * component node belongs to the *class*, so the component step of the cascade
   * needs the declaration the method sits in rather than the method.
   */
  readonly classDeclaration: ClassDeclaration | undefined;
}

/**
 * Which convention a request-handler route module declares its handlers by.
 *
 * - `app` — one export per HTTP method, named for the method.
 * - `pages` — one default export dispatching on the request method.
 *
 * The spelling matches `../graph/types.ts`'s `RouterKind` members, because it
 * describes the same two conventions; it is a local type rather than that one
 * because {@link routeModuleIdentityOf} answers only about request handlers and
 * therefore never has a third answer to give.
 */
type RouteHandlerConvention = 'app' | 'pages';

/**
 * What this extractor knows about the file under extraction when that file is a
 * **request-handler route module**: how its handlers are spelled, and the
 * identity of the `api-route` node `./api-routes.ts` emits for it.
 *
 * Absent for every other module — a page module, an App Router special file, a
 * component, a service — and absent for a route module whose identity this
 * extractor cannot vouch for. See {@link routeModuleIdentityOf} for what that
 * costs and why it costs nothing that matters.
 */
interface RouteModuleIdentity {
  /** How this module's handlers are declared. */
  readonly convention: RouteHandlerConvention;

  /** The id of the `api-route` node `./api-routes.ts` emits for this module. */
  readonly apiRouteNodeId: string;
}

/**
 * Everything the owner cascade needs about the file under extraction, computed
 * once per `extract` call.
 */
interface OwnerScope {
  /** The file under extraction, project-relative POSIX. */
  readonly file: string;

  /** The id of that file's `file` node, the cascade's last resort. */
  readonly fileNodeId: string;

  /**
   * This module's route identity, when it is a request-handler route module
   * whose `api-route` node this extractor can name exactly.
   */
  readonly route: RouteModuleIdentity | undefined;

  /**
   * The handlers this file binds in markup.
   *
   * The binding *site* of a named handler is what makes the handler step
   * *exact*: `./event-handlers.ts` resolves a bound name through the enclosing
   * scopes of that site, so the cascade re-runs the same scope walk and accepts
   * the handler step only when it lands on the very declaration the call sits
   * inside.
   */
  readonly handlers: HandlerBindings;

  /** Whether this module qualifies as a server module. */
  readonly isServerModule: boolean;

  /** What this module exports. */
  readonly exports: ModuleExports;

  /** The local bindings this module imports, by local name. */
  readonly imports: ReadonlyMap<string, ImportedBinding>;
}

/**
 * The per-call memoisation this extractor keeps, and the only state it has.
 *
 * Scoped to one `extract` call and discarded with it — the extractor caches
 * nothing across files, because `../indexer.ts` may visit files in any order
 * and a cache that outlived a call would make one file's result depend on
 * another's. Keyed by **absolute** path, which is the identity ts-morph hands
 * back from a resolved specifier.
 */
interface AnalysisCache {
  /** Absolute path → that module's export surface. */
  readonly exports: Map<string, ModuleExports>;

  /** Absolute path → whether that module qualifies as a server module. */
  readonly serverModule: Map<string, boolean>;

  /** Absolute path → its project-relative POSIX path, or `undefined` when out of bounds. */
  readonly indexable: Map<string, string | undefined>;
}

/* -------------------------------------------------------------------------------------------------
 * Positions and shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 1-based line and column a node starts at, excluding leading trivia.
 *
 * 1-based on both axes, which is the convention {@link CodeNodeBase.line} fixes
 * for the whole product and which `SourceLocation` shares; the single
 * conversion to an editor's 0-based position happens in the VS Code extension,
 * so nothing between here and there has to remember which convention it holds.
 *
 * @param node Any node — an identifier for a declaration, so that the recorded
 * position is the one a developer expects an editor to jump to.
 * @returns The node's 1-based position.
 */
function positionOf(node: Node): Position {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());

  return { line, column };
}

/**
 * Whether a name begins with an uppercase letter.
 *
 * The rule JSX applies in spirit — a lowercase-initial tag is a host element,
 * an uppercase-initial one is a value reference — implemented over the first
 * **code point** rather than the first UTF-16 unit, and rejecting a caseless
 * initial (`_`, `$`, a digit, a script without case) as well as a title-case
 * character whose uppercase form differs from itself. Byte-for-byte the rule
 * `./react-components.ts` and `./event-handlers.ts` apply, restated because an
 * extractor may not depend on a sibling.
 *
 * @param name The name to test.
 * @returns `true` when the first character is an uppercase letter.
 */
function startsWithUppercase(name: string): boolean {
  const first = name.codePointAt(0);
  if (first === undefined) {
    return false;
  }

  const initial = String.fromCodePoint(first);

  return initial !== initial.toLowerCase() && initial === initial.toUpperCase();
}

/**
 * Whether a node is one of the three JSX forms that render something.
 *
 * `<Row />`, `<Row>…</Row>` and `<>…</>`. A JSX attribute, expression container
 * or text node is not itself output.
 *
 * @param node Any node.
 * @returns `true` for a JSX element, self-closing element or fragment.
 */
function isJsxOutput(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/**
 * Whether a node is, or contains, JSX output.
 *
 * @param node The node to search.
 * @returns `true` when JSX output is found at or below it.
 */
function containsJsx(node: Node): boolean {
  if (isJsxOutput(node)) {
    return true;
  }

  let found = false;

  node.forEachDescendant((child, traversal) => {
    if (isJsxOutput(child)) {
      found = true;
      traversal.stop();
    }
  });

  return found;
}

/**
 * Whether any `return` statement belonging to a function returns JSX.
 *
 * The traversal skips the subtree of every nested function-like node, so only
 * this function's own returns are considered, and stops at the first match.
 *
 * @param fn The function whose body is walked.
 * @returns `true` when one of its own returns contains JSX.
 */
function returnsJsxFromOwnBody(fn: Node): boolean {
  let found = false;

  fn.forEachDescendant((node, traversal) => {
    // A nested function's returns are its own, not this function's.
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();

      return;
    }

    if (!Node.isReturnStatement(node)) {
      return;
    }

    const expression = node.getExpression();
    if (expression !== undefined && containsJsx(expression)) {
      found = true;
      traversal.stop();
    }
  });

  return found;
}

/**
 * Whether a function produces JSX in a returned position.
 *
 * A concise arrow body *is* the returned expression, so it is examined
 * directly; every other form is judged by its own `return` statements. The rule
 * `./react-components.ts` applies to decide the component shape, restated here.
 *
 * @param fn The function to judge.
 * @returns `true` when the function returns JSX.
 */
function producesJsx(fn: Node): boolean {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();

    if (!Node.isBlock(body)) {
      return containsJsx(body);
    }
  }

  return returnsJsxFromOwnBody(fn);
}

/**
 * The function an expression assigns, looking through everything that does not
 * change what is being assigned.
 *
 * Two transparency levels, and the difference matters to two different
 * questions:
 *
 * - `(fn)`, `fn as T`, `fn satisfies T` and `fn!` are transparent for **both**
 *   questions this module asks — what a server module exports, and whether a
 *   declaration is a component;
 * - a component wrapper call (`memo(fn)`, `React.forwardRef(fn)`) is
 *   transparent only for the **component** question, which is where
 *   `./react-components.ts` looks through it. A service export assigned through
 *   an arbitrary call is not a function-valued const as far as this module is
 *   concerned: what the call returns is a value question, and a node for it
 *   would claim a function that may not be one.
 *
 * @param expression The initialiser to unwrap.
 * @param throughWrapperCalls Whether to look through component-wrapper calls.
 * @param depth How many wrappers have already been unwrapped.
 * @returns The function node, or `undefined` when the expression assigns none.
 */
function assignedFunctionOf(
  expression: Node,
  throughWrapperCalls: boolean,
  depth = 0,
): Node | undefined {
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return expression;
  }

  if (depth >= MAX_WRAPPER_DEPTH) {
    return undefined;
  }

  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    return assignedFunctionOf(expression.getExpression(), throughWrapperCalls, depth + 1);
  }

  if (
    throughWrapperCalls &&
    Node.isCallExpression(expression) &&
    isComponentWrapperCallee(expression.getExpression())
  ) {
    const [first] = expression.getArguments();

    return first === undefined
      ? undefined
      : assignedFunctionOf(first, throughWrapperCalls, depth + 1);
  }

  return undefined;
}

/**
 * Whether a call's callee names one of the React component wrappers.
 *
 * Matched by name only, bare or qualified, exactly as `./react-components.ts`
 * matches it. The cost of the looseness is a false positive on an unrelated
 * local function called `memo`, whose result would still have to be an
 * uppercase-named declaration returning JSX before it changed any answer.
 *
 * @param callee The callee expression.
 * @returns `true` when the callee names a component wrapper.
 */
function isComponentWrapperCallee(callee: Node): boolean {
  if (Node.isIdentifier(callee)) {
    return COMPONENT_WRAPPER_NAMES.includes(callee.getText());
  }

  if (Node.isPropertyAccessExpression(callee)) {
    return COMPONENT_WRAPPER_NAMES.includes(callee.getName());
  }

  return false;
}

/**
 * Whether an `async` modifier is on a function node.
 *
 * Asked through the two node types that can carry one and answered `false` for
 * anything else, rather than through a cast: `ServerFunctionNodeData.isAsync`
 * decides how a timing wrapper must end its span, so a wrong answer here is the
 * difference between reporting the time to *start* the work and the time to
 * finish it.
 *
 * @param fn The function node.
 * @returns `true` when the function is declared `async`.
 */
function isAsyncFunction(fn: Node): boolean {
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isFunctionExpression(fn) ||
    Node.isArrowFunction(fn) ||
    Node.isMethodDeclaration(fn)
  ) {
    return fn.isAsync();
  }

  return false;
}

/* -------------------------------------------------------------------------------------------------
 * Module qualification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a path names a route or a page module, judged by **convention alone**.
 *
 * Three shapes, which are the ones the supported stack produces: `route.*` and
 * `page.*` inside an App Router tree, and any module of a Pages Router tree.
 * The roots are the conventional four (`app/`, `src/app/`, `pages/`,
 * `src/pages/`).
 *
 * This is a question about **module shape**, not about URLs: it decides whether
 * a module's exported functions are service functions or framework entry
 * points, and it is deliberately not an attempt to answer what a file serves.
 * What a file serves is asked of {@link routeModuleIdentityOf}, whose scope,
 * refusals and duty to track `../route-map.ts` are stated in this file's
 * header.
 *
 * @param file The module's project-relative POSIX path.
 * @returns `true` when the module is a route or page module.
 */
function isRouteOrPageModule(file: string): boolean {
  for (const prefix of PAGES_ROUTER_PREFIXES) {
    if (file.startsWith(prefix)) {
      return true;
    }
  }

  const insideAppRouter = APP_ROUTER_PREFIXES.some((prefix) => file.startsWith(prefix));
  if (!insideAppRouter) {
    return false;
  }

  const stem = basenamePosix(file, extnamePosix(file));

  return APP_ROUTER_MODULE_NAMES.includes(stem);
}

/**
 * Whether a module declares a React component, by the component shape
 * `./react-components.ts` owns.
 *
 * A module-level function declaration, a class declaration with a JSX-producing
 * `render` method, or a variable declarator assigned an arrow, a function
 * expression or a `memo`/`forwardRef` wrapper around one — named with an
 * initial capital or an anonymous default export — which produces JSX in a
 * returned position. The walk stops at the first one found: this is a question
 * about the module, not an inventory of its components.
 *
 * Only module-level statements are considered, because a component declared
 * inside a function body is not something another module can render and does
 * not make the file a component module.
 *
 * @param sourceFile The module to judge.
 * @returns `true` when the module declares at least one component.
 */
function declaresComponent(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      if (isComponentFunctionDeclaration(statement)) {
        return true;
      }

      continue;
    }

    if (Node.isClassDeclaration(statement)) {
      if (isComponentClassDeclaration(statement)) {
        return true;
      }

      continue;
    }

    if (!Node.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.getDeclarations()) {
      if (isComponentVariableDeclaration(declaration)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Whether a function declaration is a component: named with an initial capital
 * (or an anonymous default export), not a generator, and returning JSX.
 *
 * @param declaration The module-level function declaration.
 * @returns `true` when it declares a component.
 */
function isComponentFunctionDeclaration(declaration: FunctionDeclaration): boolean {
  const name = declaration.getNameNode()?.getText();
  const named = name === undefined ? declaration.hasDefaultKeyword() : startsWithUppercase(name);

  if (!named || declaration.isGenerator()) {
    return false;
  }

  return producesJsx(declaration);
}

/**
 * Whether a class declaration is a component: a `render` **instance** method
 * that produces JSX, under the same naming gate as a function declaration.
 *
 * @param declaration The module-level class declaration.
 * @returns `true` when it declares a component.
 */
function isComponentClassDeclaration(declaration: ClassDeclaration): boolean {
  const name = declaration.getNameNode()?.getText();
  const named = name === undefined ? declaration.hasDefaultKeyword() : startsWithUppercase(name);

  if (!named) {
    return false;
  }

  const render = declaration.getMethod(RENDER_METHOD_NAME);

  return render !== undefined && producesJsx(render);
}

/**
 * Whether a variable declarator is a component: an identifier name with an
 * initial capital, assigned a function — through a component wrapper if need be
 * — that produces JSX.
 *
 * A destructuring declarator is refused before anything else: its "name" is a
 * binding pattern rather than an identifier, so it cannot be a component
 * declaration.
 *
 * @param declaration The declarator.
 * @returns `true` when it declares a component.
 */
function isComponentVariableDeclaration(declaration: VariableDeclaration): boolean {
  const nameNode = declaration.getNameNode();
  if (!Node.isIdentifier(nameNode) || !startsWithUppercase(nameNode.getText())) {
    return false;
  }

  const initializer = declaration.getInitializer();
  if (initializer === undefined) {
    return false;
  }

  const fn = assignedFunctionOf(initializer, true);

  return fn !== undefined && producesJsx(fn);
}

/**
 * Whether a module qualifies as a **server/service module**, with the answer
 * memoised per `extract` call.
 *
 * A module qualifies when it is neither a React component module nor a
 * route/page module. That is the whole rule, and it is deliberately negative:
 * it keeps any application's vocabulary out of the judgement (AAP 0.5.4) — no
 * directory named after a service layer, no filename suffix, no framework
 * import — so an unremarkable library module of any project is recognised
 * exactly as readily as one a developer thinks of as "the backend". The client
 * fetch helper of a project is therefore a server function too, which is
 * correct: it is a named, exported, addressable function an instrumentation
 * plan can time, and this graph is about which functions a call reaches rather
 * than about which tier a developer files them under.
 *
 * @param cache The per-call memoisation.
 * @param sourceFile The module to judge.
 * @param file Its project-relative POSIX path.
 * @returns `true` when the module's exported functions are server functions.
 */
function qualifiesAsServerModule(
  cache: AnalysisCache,
  sourceFile: SourceFile,
  file: string,
): boolean {
  const key = sourceFile.getFilePath();
  const cached = cache.serverModule.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const qualifies = !isRouteOrPageModule(file) && !declaresComponent(sourceFile);
  cache.serverModule.set(key, qualifies);

  return qualifies;
}

/**
 * The project-relative POSIX path of a module, provided the indexer will visit
 * it — with the answer memoised per `extract` call.
 *
 * Four conditions, because a node this extractor promises for another file only
 * exists if that file is indexed: the module must be inside the project, its
 * path must satisfy the refinement every stored path does, it must be an
 * indexable file (which excludes a `.d.ts` declaration file) and it must not
 * sit under one of the generated or vendored directories the project loader
 * excludes.
 *
 * The check mirrors the loader's **default** rules rather than scanning the
 * loaded file list, which costs a few string operations instead of a scan per
 * resolution — the same mirror `./event-handlers.ts` and
 * `./react-components.ts` use, and for the same reason. The one rule it cannot
 * see is a caller's `extraExcludes`, which {@link ExtractorContext} does not
 * carry.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param cache The per-call memoisation.
 * @param sourceFile The module to locate.
 * @returns Its project-relative path, or `undefined` when it is out of bounds.
 */
function indexableFileOf(
  ctx: ExtractorContext,
  cache: AnalysisCache,
  sourceFile: SourceFile,
): string | undefined {
  const absolutePath = sourceFile.getFilePath();
  if (cache.indexable.has(absolutePath)) {
    return cache.indexable.get(absolutePath);
  }

  const relative = ctx.loaded.projectRelative(absolutePath);
  const usable =
    relative !== undefined &&
    isSafeRelativePath(relative) &&
    isIndexableFile(relative) &&
    !shouldExcludePath(ctx.projectRoot, absolutePath)
      ? relative
      : undefined;

  cache.indexable.set(absolutePath, usable);

  return usable;
}

/* -------------------------------------------------------------------------------------------------
 * What a module exports
 * ---------------------------------------------------------------------------------------------- */

/**
 * The export surface of a module, memoised per `extract` call.
 *
 * @param cache The per-call memoisation.
 * @param sourceFile The module to read.
 * @returns Its exported functions and re-export clauses.
 */
function moduleExportsOf(cache: AnalysisCache, sourceFile: SourceFile): ModuleExports {
  const key = sourceFile.getFilePath();
  const cached = cache.exports.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const collected = collectModuleExports(sourceFile);
  cache.exports.set(key, collected);

  return collected;
}

/**
 * Reads a module's export surface: every export name that resolves to a
 * function **declared in this module**, plus the module-specifier re-export
 * clauses a lookup may have to follow.
 *
 * Four statement forms contribute, and the two-pass shape is what makes the
 * third and fourth work: an `export { … }` clause and an `export default x`
 * statement can appear anywhere in a module — before the declaration they
 * export, thanks to hoisting — so both are collected as intents during the walk
 * and applied once it is over.
 *
 * - **Function declarations.** `export function load() {}`,
 *   `export async function load() {}`, `export default function load() {}` and
 *   the legal anonymous `export default function () {}`, recorded under
 *   {@link DEFAULT_EXPORT_NAME}. A declaration with neither a name nor the
 *   default keyword is broken source and is skipped rather than guessed at.
 * - **Variable statements.** `export const load = () => {}` and
 *   `export const load = async function () {}`, including through the
 *   transparent wrappers `assignedFunctionOf` looks past. A declarator assigned
 *   the *result of a call* is not a function-valued const here: what a call
 *   returns is a value question, and a node claiming it as a function could be
 *   claiming something that is not one.
 * - **Local export clauses.** `export { load }`, `export { load as read }` and
 *   `export { load as default }`, mapped to the declaration they name.
 * - **Re-exports and default assignments.** `export { load } from './x'`,
 *   `export { default as Load } from './x'` and `export * from './x'` are
 *   recorded for the resolver to follow; `export default load` marks the local
 *   declaration it names as the default export.
 *
 * Type-only declarations, clauses and specifiers contribute nothing: a type
 * vanishes at run time, so it can never be the callee of a call.
 * `export * as ns from './x'` is likewise not a re-export of individual names
 * — it binds one namespace object — so it is not followed. `export =` is a
 * TypeScript-only form an ES import cannot bind.
 *
 * @param sourceFile The module to read.
 * @returns Its export surface.
 */
function collectModuleExports(sourceFile: SourceFile): ModuleExports {
  /** Every module-level function of this file, by its declared name, exported or not. */
  const declared = new Map<string, ExportedFunction>();
  const functions = new Map<string, ExportedFunction>();
  const reexports: ReexportClause[] = [];
  const localClauses: { readonly localName: string; readonly exportedAs: string }[] = [];
  const defaultIntents: string[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      collectFunctionDeclaration(statement, declared, functions);

      continue;
    }

    if (Node.isVariableStatement(statement)) {
      const exported = statement.hasExportKeyword();

      for (const declaration of statement.getDeclarations()) {
        const fn = functionFromVariableDeclaration(declaration);
        if (fn === undefined) {
          continue;
        }

        declared.set(fn.declaredName, fn);

        if (exported) {
          functions.set(fn.declaredName, fn);
        }
      }

      continue;
    }

    if (Node.isExportDeclaration(statement)) {
      collectExportDeclaration(statement, localClauses, reexports);

      continue;
    }

    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      collectExportAssignment(statement.getExpression(), statement, functions, defaultIntents);
    }
  }

  // Second pass: an export clause and a default assignment are applied after
  // the whole module has been walked, because either may precede the
  // declaration it names.
  for (const clause of localClauses) {
    const fn = declared.get(clause.localName);

    if (fn !== undefined) {
      functions.set(clause.exportedAs, fn);
    }
  }

  for (const name of defaultIntents) {
    const fn = declared.get(name);

    if (fn !== undefined) {
      functions.set(DEFAULT_EXPORT_NAME, fn);
    }
  }

  return Object.freeze({ functions, reexports: Object.freeze(reexports) });
}

/**
 * Records one module-level function declaration: always as a local
 * declaration, and as an export under whichever name exports it.
 *
 * @param declaration The function declaration.
 * @param declared The module's local declarations, appended to.
 * @param functions The module's exports, appended to.
 */
function collectFunctionDeclaration(
  declaration: FunctionDeclaration,
  declared: Map<string, ExportedFunction>,
  functions: Map<string, ExportedFunction>,
): void {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode === undefined ? undefined : nonEmptyText(nameNode);
  const isDefaultExport = declaration.hasDefaultKeyword();

  // Nameless and not a default export: the parser produces this for broken
  // source (`export function {`), and a node with an empty name would be
  // unfindable by every query.
  if (declaredName === undefined && !isDefaultExport) {
    return;
  }

  const anchor = declaredName === undefined || nameNode === undefined ? declaration : nameNode;
  const position = positionOf(anchor);
  const fn: ExportedFunction = {
    declaredName: declaredName ?? DEFAULT_EXPORT_NAME,
    line: position.line,
    column: position.column,
    endLine: Math.max(declaration.getEndLineNumber(), position.line),
    isAsync: declaration.isAsync(),
    declaration,
  };

  if (declaredName !== undefined) {
    declared.set(declaredName, fn);
  }

  if (isDefaultExport) {
    functions.set(DEFAULT_EXPORT_NAME, fn);

    return;
  }

  if (declaration.hasExportKeyword() && declaredName !== undefined) {
    functions.set(declaredName, fn);
  }
}

/**
 * The function one variable declarator assigns, if it assigns one.
 *
 * @param declaration The declarator.
 * @returns The function it declares, or `undefined`.
 */
function functionFromVariableDeclaration(
  declaration: VariableDeclaration,
): ExportedFunction | undefined {
  const nameNode = declaration.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    return undefined;
  }

  const declaredName = nonEmptyText(nameNode);
  if (declaredName === undefined) {
    return undefined;
  }

  const initializer = declaration.getInitializer();
  if (initializer === undefined) {
    return undefined;
  }

  const fn = assignedFunctionOf(initializer, false);
  if (fn === undefined) {
    return undefined;
  }

  const position = positionOf(nameNode);

  return {
    declaredName,
    line: position.line,
    column: position.column,
    endLine: Math.max(declaration.getEndLineNumber(), position.line),
    isAsync: isAsyncFunction(fn),
    declaration,
  };
}

/**
 * Records one `export … from` or `export { … }` statement.
 *
 * @param declaration The export declaration.
 * @param localClauses Local clause intents, appended to.
 * @param reexports Module-specifier re-export clauses, appended to.
 */
function collectExportDeclaration(
  declaration: ExportDeclaration,
  localClauses: { readonly localName: string; readonly exportedAs: string }[],
  reexports: ReexportClause[],
): void {
  if (declaration.isTypeOnly()) {
    return;
  }

  const hasModuleSpecifier = declaration.getModuleSpecifier() !== undefined;
  const namedExports = declaration.getNamedExports();

  if (namedExports.length === 0) {
    // `export * from './x'` re-exports every name of its target under the same
    // name, so it is worth following. `export * as ns from './x'` binds one
    // namespace object instead, and a member access on it is not a resolvable
    // callee here.
    if (hasModuleSpecifier && declaration.getNamespaceExport() === undefined) {
      reexports.push(Object.freeze({ declaration, exportedAs: undefined, sourceName: undefined }));
    }

    return;
  }

  for (const specifier of namedExports) {
    if (specifier.isTypeOnly()) {
      continue;
    }

    const sourceName = specifier.getName();
    const exportedAs = specifier.getAliasNode()?.getText() ?? sourceName;

    if (hasModuleSpecifier) {
      reexports.push(Object.freeze({ declaration, exportedAs, sourceName }));

      continue;
    }

    localClauses.push(Object.freeze({ localName: sourceName, exportedAs }));
  }
}

/**
 * Records one `export default <expression>` statement.
 *
 * The expression either names a local declaration — recorded as an intent and
 * resolved after the walk — or *is* a function, in which case the module's
 * default export is that function, addressable under
 * {@link DEFAULT_EXPORT_NAME} and positioned at the expression, which is the
 * convention `./symbols.ts` applies to the same shape.
 *
 * @param expression The exported expression.
 * @param statement The statement, for its extent.
 * @param functions The module's exports, appended to.
 * @param defaultIntents Identifier intents, appended to.
 */
function collectExportAssignment(
  expression: Node,
  statement: Node,
  functions: Map<string, ExportedFunction>,
  defaultIntents: string[],
): void {
  if (Node.isIdentifier(expression)) {
    const name = nonEmptyText(expression);

    if (name !== undefined) {
      defaultIntents.push(name);
    }

    return;
  }

  const fn = assignedFunctionOf(expression, false);
  if (fn === undefined) {
    return;
  }

  const position = positionOf(expression);

  functions.set(DEFAULT_EXPORT_NAME, {
    declaredName: DEFAULT_EXPORT_NAME,
    line: position.line,
    column: position.column,
    endLine: Math.max(statement.getEndLineNumber(), position.line),
    isAsync: isAsyncFunction(fn),
    declaration: statement,
  });
}

/**
 * A node's text, or `undefined` when it is empty.
 *
 * An `Identifier` with empty text is what the parser produces for broken
 * source; it is not a name, and treating it as one would put an unfindable node
 * in the graph.
 *
 * @param node The node to read.
 * @returns Its text, or `undefined` when empty.
 */
function nonEmptyText(node: Node): string | undefined {
  const text = node.getText();

  return text.length === 0 ? undefined : text;
}

/**
 * Whether two wrapped nodes are the same syntax node.
 *
 * Compared by kind and start offset rather than by reference: ts-morph caches
 * its wrappers, so reference equality happens to hold today, and a comparison
 * that does not depend on that is one less thing a library upgrade can change
 * silently. Both nodes always come from the same file here.
 *
 * @param left The first node.
 * @param right The second node.
 * @returns `true` when they are the same node.
 */
function isSameNode(left: Node, right: Node): boolean {
  return left.getKind() === right.getKind() && left.getStart() === right.getStart();
}

/* -------------------------------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------------------------------- */

/**
 * The module a specifier resolves to, or `undefined` when it resolves to
 * nothing this project holds.
 *
 * The one place this extractor asks for module resolution, and the only reason
 * it needs the loaded project at all. Wrapped in a `try` because resolution is
 * the one step that can throw on an exotic specifier — a malformed path, an
 * unsupported protocol — and an unresolved specifier is a perfectly ordinary
 * state (every dependency of an uninstalled project is one), so it is treated
 * as "no module" rather than as a failure.
 *
 * @param declaration The import or re-export declaration to resolve.
 * @returns The resolved module, or `undefined`.
 */
function resolvedModuleOf(
  declaration: ImportDeclaration | ExportDeclaration,
): SourceFile | undefined {
  try {
    return declaration.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

/**
 * The local bindings the file under extraction imports, mapped to the name each
 * one has in the module it comes from.
 *
 * Named and default imports only. A namespace import binds an object whose
 * members are reached by property access, and a property-access callee is not
 * something this module resolves (see the header), so it contributes no
 * binding. A type-only import — whole declaration or single specifier — binds
 * nothing at run time and therefore cannot be a callee either.
 *
 * @param sourceFile The file under extraction.
 * @returns Local name → the binding it names.
 */
function importedBindingsOf(sourceFile: SourceFile): ReadonlyMap<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) {
      continue;
    }

    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) {
      const local = nonEmptyText(defaultImport);

      if (local !== undefined && !bindings.has(local)) {
        bindings.set(local, Object.freeze({ declaration, exportName: DEFAULT_EXPORT_NAME }));
      }
    }

    for (const specifier of declaration.getNamedImports()) {
      if (specifier.isTypeOnly()) {
        continue;
      }

      // `import { load as read }` — `load` is the name to look for in the
      // imported module, `read` is what this file calls it.
      const exportName = specifier.getName();
      const local = specifier.getAliasNode()?.getText() ?? exportName;

      if (local.length > 0 && !bindings.has(local)) {
        bindings.set(local, Object.freeze({ declaration, exportName }));
      }
    }
  }

  return bindings;
}

/**
 * The `server-function` node one export name resolves to, or `undefined` when
 * it resolves to something this extractor emits no node for.
 *
 * The four conditions of the header's resolution contract, in order, plus the
 * re-export walk. The walk is bounded twice over: by
 * {@link MAX_REEXPORT_HOPS}, and by a visited set keyed on **file and name
 * together** — a cyclic barrel therefore terminates, while two clauses of one
 * barrel that reach the same module looking for *different* names are both
 * still followed.
 *
 * Returning `undefined` is the safe answer and the common one. An edge to a
 * node nobody emits is dropped by `../graph/graph.ts` as `dangling-edge`, which
 * would silently delete a tier boundary from the graph, so this function is
 * deliberately conservative: it answers only when the same rules that make it
 * answer will make this extractor emit that node when the indexer reaches the
 * declaring file.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param cache The per-call memoisation.
 * @param module The module to look in.
 * @param exportName The export name to look for.
 * @param hops How many re-export hops have already been followed.
 * @param visited The file-and-name pairs already inspected.
 * @returns The declaring file and the function declared there, or `undefined`.
 */
function findServerFunction(
  ctx: ExtractorContext,
  cache: AnalysisCache,
  module: SourceFile,
  exportName: string,
  hops: number,
  visited: Set<string>,
): ResolvedTarget | undefined {
  const key = `${module.getFilePath()}\u0000${exportName}`;
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);

  // 1. The declaring file must be one the indexer visits, or the node this edge
  //    would point at is never emitted.
  const file = indexableFileOf(ctx, cache, module);
  if (file === undefined) {
    return undefined;
  }

  const exported = moduleExportsOf(cache, module);

  // 2. The name is declared here: the answer is final either way, because a
  //    module that declares a name does not also re-export it.
  const own = exported.functions.get(exportName);
  if (own !== undefined) {
    // 3. The declaring module must qualify, since qualification is what decides
    //    whether a `server-function` node exists for its exports at all.
    return qualifiesAsServerModule(cache, module, file)
      ? Object.freeze({ file, fn: own })
      : undefined;
  }

  if (hops >= MAX_REEXPORT_HOPS) {
    return undefined;
  }

  // 4. Otherwise follow the module-specifier re-exports that could carry the
  //    name: a matching named clause, or any star clause.
  for (const clause of exported.reexports) {
    if (clause.exportedAs !== undefined && clause.exportedAs !== exportName) {
      continue;
    }

    const target = resolvedModuleOf(clause.declaration);
    if (target === undefined) {
      continue;
    }

    const found = findServerFunction(
      ctx,
      cache,
      target,
      clause.sourceName ?? exportName,
      hops + 1,
      visited,
    );

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * The declaration a name resolves to in the enclosing scopes of a site,
 * innermost first, or `undefined` when no enclosing scope declares it.
 *
 * The language's own scoping order, and the reason a call to a *locally*
 * declared function is never mistaken for a call to an imported one of the same
 * name. At each ancestor two questions are asked, statements before parameters,
 * because a `const` in a function body shadows a parameter of the same name.
 *
 * The module scope is included — a `SourceFile` is statemented — so a name
 * declared at module level resolves here too, which is what the same-file
 * branch of the edge pass relies on. Import declarations are *not* statements
 * of this kind, so an imported binding correctly resolves to nothing and is
 * looked up in {@link importedBindingsOf} instead.
 *
 * Nothing here consults the type checker: only the declarations a scope
 * syntactically contains are considered, which is the same walk
 * `./event-handlers.ts` performs to position a bound handler at its
 * declaration — and re-running it is what lets the handler step of the cascade
 * confirm it is about to name the very declaration that extractor named.
 *
 * @param site The use site the walk starts at.
 * @param name The name to look for.
 * @returns The declaration node, or `undefined`.
 */
function declarationInScopes(site: Node, name: string): Node | undefined {
  for (const ancestor of site.getAncestors()) {
    if (Node.isStatemented(ancestor)) {
      const declared = declarationInStatements(ancestor.getStatements(), name);

      if (declared !== undefined) {
        return declared;
      }
    }

    if (Node.isParametered(ancestor)) {
      for (const parameter of ancestor.getParameters()) {
        if (bindsName(parameter.getNameNode(), name, 0)) {
          return parameter;
        }
      }
    }
  }

  return undefined;
}

/**
 * The declaration of a name among a scope's statements.
 *
 * Three statement forms declare a value a call can reach: a function
 * declaration, a class declaration and a variable statement — the last
 * including a destructured declarator, whose bound identifiers shadow an import
 * of the same name just as a plain one does. A type alias, an interface and an
 * enum are not callable functions this module resolves, and an `import` is
 * handled separately by design.
 *
 * @param statements The scope's statements.
 * @param name The name to look for.
 * @returns The declaration node, or `undefined`.
 */
function declarationInStatements(statements: readonly Node[], name: string): Node | undefined {
  for (const statement of statements) {
    if (Node.isFunctionDeclaration(statement) && statement.getName() === name) {
      return statement;
    }

    if (Node.isClassDeclaration(statement) && statement.getName() === name) {
      return statement;
    }

    if (!Node.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.getDeclarations()) {
      if (bindsName(declaration.getNameNode(), name, 0)) {
        return declaration;
      }
    }
  }

  return undefined;
}

/**
 * Whether a binding name — an identifier or a destructuring pattern — binds a
 * name.
 *
 * Recursive over object and array patterns so that `const { load } = deps` and
 * `const [load] = pair` shadow an import of `load`, with the same bounded depth
 * every other recursion here uses.
 *
 * @param nameNode The declaration's name node.
 * @param name The name to look for.
 * @param depth How deep the pattern walk already is.
 * @returns `true` when the name is bound.
 */
function bindsName(nameNode: Node, name: string, depth: number): boolean {
  if (Node.isIdentifier(nameNode)) {
    return nameNode.getText() === name;
  }

  if (depth >= MAX_WRAPPER_DEPTH) {
    return false;
  }

  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      if (Node.isBindingElement(element) && bindsName(element.getNameNode(), name, depth + 1)) {
        return true;
      }
    }
  }

  return false;
}

/* -------------------------------------------------------------------------------------------------
 * Markup bindings
 * ---------------------------------------------------------------------------------------------- */

/**
 * The handlers this file binds in markup, in the two forms
 * `./event-handlers.ts` distinguishes.
 *
 * Collected once per file, because the handler step of the cascade asks about
 * them for every call site.
 */
interface HandlerBindings {
  /**
   * The identifier a named binding names → the site it was written at.
   *
   * `onClick={handleSubmit}` and `onClick={makeHandler(id)}`, the second
   * classified by the **called** name, which is how that extractor classifies
   * it too. A member-access receiver (`props.onSelect`, `this.handleSelect`) is
   * deliberately absent: those nodes may be positioned at their binding site
   * rather than at a declaration, and a step that guessed which would produce
   * an edge the graph drops.
   */
  readonly named: ReadonlyMap<string, Node>;

  /**
   * The start offset of an inline handler function → the property name it is
   * bound to, which is the derived label that extractor names the node after.
   */
  readonly inline: ReadonlyMap<number, string>;
}

/**
 * Reads every `on[A-Z]` markup binding of one file.
 *
 * @param sourceFile The file under extraction.
 * @returns The named and inline bindings.
 */
function collectHandlerBindings(sourceFile: SourceFile): HandlerBindings {
  const named = new Map<string, Node>();
  const inline = new Map<number, string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isJsxAttribute(node)) {
      return;
    }

    const propName = node.getNameNode().getText();
    if (!HANDLER_ATTRIBUTE_PATTERN.test(propName)) {
      return;
    }

    const initializer = node.getInitializer();
    if (initializer === undefined || !Node.isJsxExpression(initializer)) {
      return;
    }

    const expression = initializer.getExpression();
    if (expression === undefined) {
      return;
    }

    const bound = boundHandlerOf(expression, 0);
    if (bound === undefined) {
      return;
    }

    if (bound.kind === 'inline') {
      inline.set(bound.fn.getStart(), propName);

      return;
    }

    // The first binding of a name is the one kept: a handler bound at several
    // places is one declaration at one position, so the site only has to be
    // good enough to re-run the scope walk from, and any of them is.
    if (!named.has(bound.name)) {
      named.set(bound.name, bound.site);
    }
  });

  return { named, inline };
}

/**
 * What one `on[A-Z]` attribute binds: an inline function, or a name.
 */
type BoundHandler =
  | { readonly kind: 'inline'; readonly fn: Node }
  | { readonly kind: 'named'; readonly name: string; readonly site: Node };

/**
 * Classifies a bound expression, looking through the transparent wrappers that
 * do not change what is bound.
 *
 * Anything else — a conditional, a logical expression, an element access, a
 * member access, a literal — yields `undefined`, which leaves the cascade to
 * try its next step rather than guess at a node another extractor may have
 * positioned somewhere else.
 *
 * @param expression The bound expression.
 * @param depth How many wrappers have already been peeled.
 * @returns The classification, or `undefined`.
 */
function boundHandlerOf(expression: Node, depth: number): BoundHandler | undefined {
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return { kind: 'inline', fn: expression };
  }

  if (Node.isIdentifier(expression)) {
    const name = nonEmptyText(expression);

    return name === undefined ? undefined : { kind: 'named', name, site: expression };
  }

  if (depth >= MAX_WRAPPER_DEPTH) {
    return undefined;
  }

  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    return boundHandlerOf(expression.getExpression(), depth + 1);
  }

  // `onClick={makeHandler(id)}` — the called name is the one the handler node
  // carries, so it is the one the cascade must compare against.
  if (Node.isCallExpression(expression)) {
    const callee = expression.getExpression();

    if (Node.isIdentifier(callee)) {
      const name = nonEmptyText(callee);

      return name === undefined ? undefined : { kind: 'named', name, site: callee };
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Enclosing functions
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a declaration sits directly at module level.
 *
 * @param node The declaration or statement to test.
 * @returns `true` when its parent is the module itself.
 */
function isModuleLevel(node: Node): boolean {
  const parent = node.getParent();

  return parent !== undefined && Node.isSourceFile(parent);
}

/**
 * The name a module-level class is recorded under, or `undefined` when the
 * class is not module-level or has no addressable name.
 *
 * @param declaration The class declaration.
 * @returns The class's recorded name, or `undefined`.
 */
function moduleLevelClassName(declaration: ClassDeclaration): string | undefined {
  if (!isModuleLevel(declaration)) {
    return undefined;
  }

  const nameNode = declaration.getNameNode();
  const declaredName = nameNode === undefined ? undefined : nonEmptyText(nameNode);

  if (declaredName !== undefined) {
    return declaredName;
  }

  return declaration.hasDefaultKeyword() ? DEFAULT_EXPORT_NAME : undefined;
}

/**
 * The functions enclosing a call site, innermost first.
 *
 * The order *is* the cascade's "innermost addressable owner" rule: the cascade
 * tries each candidate in turn and takes the first one it can name, so a call
 * inside an unaddressable inner function (an anonymous callback, say) is still
 * attributed to the handler, route, component or service function that contains
 * it rather than falling all the way to the file.
 *
 * @param call The call expression.
 * @returns The candidates, innermost first.
 */
function enclosingFunctionCandidates(call: Node): readonly FunctionCandidate[] {
  const candidates: FunctionCandidate[] = [];

  for (const ancestor of call.getAncestors()) {
    if (Node.isSourceFile(ancestor)) {
      break;
    }

    if (Node.isFunctionDeclaration(ancestor)) {
      candidates.push(candidateFromFunctionDeclaration(ancestor));

      continue;
    }

    if (Node.isConstructorDeclaration(ancestor)) {
      // A constructor's parent is a class declaration or a class expression;
      // only the former is inventoried by the symbol extractor, so only the
      // former can name an owner.
      const parent = ancestor.getParent();
      const classDeclaration = Node.isClassDeclaration(parent) ? parent : undefined;

      candidates.push({
        fn: ancestor,
        declaration: ancestor,
        name: CONSTRUCTOR_NAME,
        position: positionOf(ancestor),
        isModuleLevel: false,
        exported: false,
        isDefaultExport: false,
        container:
          classDeclaration === undefined ? undefined : moduleLevelClassName(classDeclaration),
        classDeclaration,
      });

      continue;
    }

    if (
      Node.isMethodDeclaration(ancestor) ||
      Node.isGetAccessorDeclaration(ancestor) ||
      Node.isSetAccessorDeclaration(ancestor)
    ) {
      candidates.push(candidateFromClassMember(ancestor, ancestor.getNameNode()));

      continue;
    }

    if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) {
      candidates.push(candidateFromFunctionExpression(ancestor));
    }
  }

  return candidates;
}

/**
 * The candidate for a function declaration.
 *
 * Positioned at its identifier, or at the declaration itself for the legal
 * anonymous `export default function () {}` — the rule every sibling extractor
 * applies, and the position `./symbols.ts` records such a declaration at.
 *
 * @param declaration The function declaration.
 * @returns The candidate.
 */
function candidateFromFunctionDeclaration(declaration: FunctionDeclaration): FunctionCandidate {
  const nameNode = declaration.getNameNode();
  const name = nameNode === undefined ? undefined : nonEmptyText(nameNode);
  const anchor = name === undefined || nameNode === undefined ? declaration : nameNode;
  const isDefaultExport = declaration.hasDefaultKeyword();

  return {
    fn: declaration,
    declaration,
    name,
    position: positionOf(anchor),
    isModuleLevel: isModuleLevel(declaration),
    exported: declaration.hasExportKeyword() || isDefaultExport,
    isDefaultExport,
    container: undefined,
    classDeclaration: undefined,
  };
}

/**
 * The candidate for a class member that holds a function: a method, an
 * accessor, or a property assigned one.
 *
 * @param member The member node.
 * @param nameNode Its name node, which may be computed and therefore nameless
 * as far as the graph is concerned.
 * @returns The candidate.
 */
function candidateFromClassMember(member: Node, nameNode: Node): FunctionCandidate {
  const parent = member.getParent();
  const classDeclaration =
    parent !== undefined && Node.isClassDeclaration(parent) ? parent : undefined;
  const name = Node.isIdentifier(nameNode) ? nonEmptyText(nameNode) : undefined;

  return {
    fn: member,
    declaration: member,
    name,
    position: positionOf(name === undefined ? member : nameNode),
    isModuleLevel: false,
    exported: false,
    isDefaultExport: false,
    container: classDeclaration === undefined ? undefined : moduleLevelClassName(classDeclaration),
    classDeclaration,
  };
}

/**
 * The candidate for an arrow function or function expression: the declaration
 * that assigns it, when there is one.
 *
 * The walk upwards looks through the transparent wrappers and through **any**
 * call the function is an argument of, because that is how a memoised handler
 * (`const onPick = useCallback(() => …)`) and a wrapped component
 * (`const Row = memo(() => …)`) reach their declarator — and both are ordinary.
 * Whether that declarator is a *component* is a separate question the component
 * step asks of the declaration itself, under the stricter rule
 * `./react-components.ts` applies, so looking through a hook call here cannot
 * make a memoised callback look like a component.
 *
 * With no declaration to reach — an inline markup handler, an immediately
 * invoked function, a callback argument — the candidate is the function itself.
 * It is then addressable only as an inline handler, and otherwise the cascade
 * simply moves outwards.
 *
 * @param fn The arrow function or function expression.
 * @returns The candidate.
 */
function candidateFromFunctionExpression(fn: Node): FunctionCandidate {
  let current: Node = fn;

  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH; depth += 1) {
    const parent: Node | undefined = current.getParent();
    if (parent === undefined) {
      break;
    }

    if (Node.isVariableDeclaration(parent)) {
      const nameNode = parent.getNameNode();
      const name = Node.isIdentifier(nameNode) ? nonEmptyText(nameNode) : undefined;
      if (name === undefined) {
        break;
      }

      const statement = parent.getVariableStatement();

      return {
        fn,
        declaration: parent,
        name,
        position: positionOf(nameNode),
        isModuleLevel: statement !== undefined && isModuleLevel(statement),
        exported: statement !== undefined && statement.hasExportKeyword(),
        isDefaultExport: false,
        container: undefined,
        classDeclaration: undefined,
      };
    }

    if (Node.isPropertyDeclaration(parent)) {
      return candidateFromClassMember(parent, parent.getNameNode());
    }

    if (Node.isExportAssignment(parent) && !parent.isExportEquals()) {
      // `export default () => …`, or a wrapped form of it: `./symbols.ts` mints
      // a node named `default` at the *exported expression*, so that is where
      // the position has to come from.
      return {
        fn,
        declaration: parent,
        name: undefined,
        position: positionOf(parent.getExpression()),
        isModuleLevel: isModuleLevel(parent),
        exported: true,
        isDefaultExport: true,
        container: undefined,
        classDeclaration: undefined,
      };
    }

    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      isArgumentOfCall(parent, current)
    ) {
      current = parent;

      continue;
    }

    break;
  }

  return {
    fn,
    declaration: fn,
    name: undefined,
    position: positionOf(fn),
    isModuleLevel: false,
    exported: false,
    isDefaultExport: false,
    container: undefined,
    classDeclaration: undefined,
  };
}

/**
 * Whether a node is an argument of a call expression, which is the shape a
 * wrapper call (`useCallback(fn)`, `memo(fn)`) presents from the inside.
 *
 * The callee position is deliberately excluded: `fn()` calls the function, it
 * does not declare it.
 *
 * @param parent The candidate call expression.
 * @param child The node to look for among its arguments.
 * @returns `true` when the child is one of the call's arguments.
 */
function isArgumentOfCall(parent: Node, child: Node): boolean {
  if (!Node.isCallExpression(parent)) {
    return false;
  }

  return parent.getArguments().some((argument) => isSameNode(argument, child));
}

/* -------------------------------------------------------------------------------------------------
 * The owner cascade
 * ---------------------------------------------------------------------------------------------- */

/**
 * The node a `calls` edge from one call site starts at: the innermost owner the
 * cascade can address, and the file node when it can address none.
 *
 * @param scope The file under extraction.
 * @param call The call expression.
 * @returns The `from` id of the edge.
 */
function ownerNodeIdFor(scope: OwnerScope, call: CallExpression): string {
  for (const candidate of enclosingFunctionCandidates(call)) {
    const id = addressableOwnerId(scope, candidate);

    if (id !== undefined) {
      return id;
    }
  }

  // No enclosing function at all, or none this module can name: a call in a
  // module-level initialiser belongs to that declaration, and anything left
  // belongs to the module.
  return moduleLevelOwnerId(scope, call) ?? scope.fileNodeId;
}

/**
 * The id of the node one enclosing function is addressable as, or `undefined`
 * when it is not addressable at all.
 *
 * The five steps of the cascade in order, each in its own helper so that the
 * order is readable as the contract it is.
 *
 * @param scope The file under extraction.
 * @param candidate One enclosing function.
 * @returns The node id, or `undefined`.
 */
function addressableOwnerId(scope: OwnerScope, candidate: FunctionCandidate): string | undefined {
  // 1. A handler bound in this file's markup — where a user interaction enters
  //    the application's own code, and the head of the cross-tier chain.
  const handler = handlerOwnerId(scope, candidate);
  if (handler !== undefined) {
    return handler;
  }

  // 2. An HTTP-method export of this route module, or its legacy default
  //    handler: the hop that makes a route traversable to the service layer.
  const route = scope.route;
  if (route !== undefined && isRouteHandlerExport(scope, route.convention, candidate)) {
    return route.apiRouteNodeId;
  }

  // 3. A component — a call can originate in a rendered page rather than in an
  //    HTTP handler, and the graph must still record where.
  const component = componentOwnerId(scope, candidate);
  if (component !== undefined) {
    return component;
  }

  // 4. A server function of this module calling another one.
  const serverFunction = serverFunctionOwnerId(scope, candidate);
  if (serverFunction !== undefined) {
    return serverFunction;
  }

  // 5. Any other declaration the symbol extractor inventories.
  return symbolOwnerId(scope, candidate);
}

/**
 * Step 1: the `handler` node this function is bound as, if it is bound at all.
 *
 * Both binding styles `./event-handlers.ts` distinguishes are covered, and each
 * is only claimed where its node's identity is reproducible exactly:
 *
 * - **inline** — the function *is* the attribute's expression, so the node is
 *   named for the property as written and positioned at the function;
 * - **named** — the attribute names an identifier, so the node is named for the
 *   declaration's own identifier and positioned there. The scope walk is re-run
 *   from the binding site and the step is claimed **only** when it lands on
 *   this very declaration, which is what rules out a same-named declaration in
 *   another scope being credited with the call.
 *
 * @param scope The file under extraction.
 * @param candidate One enclosing function.
 * @returns The handler node id, or `undefined`.
 */
function handlerOwnerId(scope: OwnerScope, candidate: FunctionCandidate): string | undefined {
  const inlineProp = scope.handlers.inline.get(candidate.fn.getStart());
  if (inlineProp !== undefined && isSameNode(candidate.declaration, candidate.fn)) {
    return makeNodeId({
      kind: 'handler',
      file: scope.file,
      name: inlineProp,
      line: candidate.position.line,
      column: candidate.position.column,
    });
  }

  if (candidate.name === undefined) {
    return undefined;
  }

  const site = scope.handlers.named.get(candidate.name);
  if (site === undefined) {
    return undefined;
  }

  const resolved = declarationInScopes(site, candidate.name);
  if (resolved === undefined || !isSameNode(resolved, candidate.declaration)) {
    return undefined;
  }

  return makeNodeId({
    kind: 'handler',
    file: scope.file,
    name: candidate.name,
    line: candidate.position.line,
    column: candidate.position.column,
  });
}

/**
 * Step 2: whether this function is the request handler of this route module.
 *
 * The judgement is a question about the module's **export surface**, not about
 * the `export` keyword. {@link collectModuleExports} has already resolved an
 * export clause (`export { handler as PUT }`) and an `export default
 * <identifier>` to the declaration each one names, and both spellings are
 * ordinary in a route module. A keyword-only gate rejected them — so a call
 * written inside such a handler lost its `api-route` origin and fell through to
 * a `symbol` node, which silently deletes the route-to-service tier boundary
 * `../graph/query.ts`'s `pathBetween` is traversed through.
 *
 * Two module conventions:
 *
 * - **App Router** — a module-level function the export surface publishes under
 *   the name of an exportable HTTP method, matched by **declaration identity**,
 *   which is exact where a name comparison would credit a same-named
 *   declaration in another scope. That covers `export async function GET`,
 *   `export const POST = …` and `export { handler as PUT }` alike. The one
 *   shape identity cannot see is an export whose initialiser is not *directly*
 *   a function — `export const POST = withTiming(handler)`, whose value is a
 *   call this module deliberately does not evaluate — so an exported
 *   **declarator** *named* for the method is accepted on that evidence
 *   instead. That fallback is bounded to the declarator shape on purpose: a
 *   default export is not a method export under this convention, so
 *   `export default function POST() {}` declares no `POST` handler — which is
 *   how `../route-map.ts` reads such a module (it reports no method at all)
 *   and how {@link appHandlerPosition} anchors it — and the name alone must
 *   not credit it with one.
 * - **Legacy Pages Router** — the module's default export, which *is* the
 *   route: one function dispatching on the request method. Either the
 *   declaration carries `export default` itself, or the export surface's
 *   `default` entry is this very declaration.
 *
 * A page module is deliberately not a case here, and cannot become one: the
 * route identity this step is gated on is derived for request-handler modules
 * only ({@link routeModuleIdentityOf} refuses a `page.*` module and a
 * rendering `pages/**` module outright). A page's default export renders a
 * document and the component step is what names it; reporting it as the
 * handler of the page's `GET` would conflate rendering with answering, which is
 * the same distinction `../graph/query.ts` draws.
 *
 * @param scope The file under extraction, for its export surface.
 * @param convention How this route module declares its handlers.
 * @param candidate One enclosing function.
 * @returns `true` when the function is this route's handler.
 */
function isRouteHandlerExport(
  scope: OwnerScope,
  convention: RouteHandlerConvention,
  candidate: FunctionCandidate,
): boolean {
  if (!candidate.isModuleLevel) {
    return false;
  }

  if (convention === 'pages') {
    if (candidate.isDefaultExport) {
      return true;
    }

    const defaultExport = scope.exports.functions.get(DEFAULT_EXPORT_NAME);

    return (
      defaultExport !== undefined && isSameNode(defaultExport.declaration, candidate.declaration)
    );
  }

  for (const method of EXPORTABLE_HTTP_METHODS) {
    // Published under the method's name: the export surface has already
    // resolved every spelling — the keyword, a clause, an alias — to the
    // declaration it names, so identity settles it.
    const published = scope.exports.functions.get(method);
    if (published !== undefined && isSameNode(published.declaration, candidate.declaration)) {
      return true;
    }

    // Declared for the method as an exported **declarator** whose initialiser
    // the export surface could not read as a function — `export const POST =
    // withTiming(handler)`, whose value is a call this module deliberately does
    // not evaluate. The declarator shape is what bounds this evidence to that
    // case: a declarator is never a module's default export, so a
    // default-exported function *named* for a method — which declares no method
    // at all under this convention, as {@link appHandlerPosition} and
    // `../route-map.ts` both read it — cannot reach here on its name.
    if (
      candidate.name === method &&
      candidate.exported &&
      Node.isVariableDeclaration(candidate.declaration)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Step 3: the `component` node this function is, if it is one.
 *
 * Judged from the *declaration* rather than from the function, under the rule
 * `./react-components.ts` owns, so a memoised callback cannot be mistaken for a
 * wrapped component. A class component is handled through its `render` method,
 * because that is the function a call sits inside while the component node
 * belongs to the class.
 *
 * @param scope The file under extraction.
 * @param candidate One enclosing function.
 * @returns The component node id, or `undefined`.
 */
function componentOwnerId(scope: OwnerScope, candidate: FunctionCandidate): string | undefined {
  const { classDeclaration } = candidate;

  if (
    classDeclaration !== undefined &&
    candidate.name === RENDER_METHOD_NAME &&
    isModuleLevel(classDeclaration) &&
    isComponentClassDeclaration(classDeclaration)
  ) {
    return componentNodeIdFor(scope.file, classDeclaration);
  }

  if (!candidate.isModuleLevel) {
    return undefined;
  }

  const declaration = candidate.declaration;

  if (Node.isFunctionDeclaration(declaration) && isComponentFunctionDeclaration(declaration)) {
    return componentNodeIdFor(scope.file, declaration);
  }

  if (Node.isVariableDeclaration(declaration) && isComponentVariableDeclaration(declaration)) {
    return componentNodeIdFor(scope.file, declaration);
  }

  return undefined;
}

/**
 * The id of the `component` node a declaration produces, by
 * `./react-components.ts`'s naming rule: the declared identifier, or the file's
 * basename without its extension for a truly anonymous default export, at the
 * 1-based position of the identifier or of the declaration itself.
 *
 * @param file The file under extraction, project-relative POSIX.
 * @param declaration The component's declaration.
 * @returns The node id.
 */
function componentNodeIdFor(file: string, declaration: Node): string {
  let nameNode: Node | undefined;

  if (Node.isFunctionDeclaration(declaration) || Node.isClassDeclaration(declaration)) {
    nameNode = declaration.getNameNode();
  } else if (Node.isVariableDeclaration(declaration)) {
    const declaredNameNode = declaration.getNameNode();
    nameNode = Node.isIdentifier(declaredNameNode) ? declaredNameNode : undefined;
  }

  const declaredName = nameNode === undefined ? undefined : nonEmptyText(nameNode);
  const anchor = declaredName === undefined || nameNode === undefined ? declaration : nameNode;
  const position = positionOf(anchor);

  return makeNodeId({
    kind: 'component',
    file,
    name: declaredName ?? basenamePosix(file, extnamePosix(file)),
    line: position.line,
    column: position.column,
  });
}

/**
 * Step 4: the `server-function` node this function is, if this module is a
 * server module and this is one of its exported functions.
 *
 * Matched by declaration identity rather than by name, so a local of the same
 * name in another scope cannot be credited with an exported function's calls.
 *
 * The identity match against `exports.functions` is the whole of the export
 * evidence, and deliberately so: that map is built from module-level
 * statements only, and a function enters it exactly when this module publishes
 * it under some name — by the `export` keyword, by an export clause
 * (`export { loadThing }`) or by an `export default <identifier>` assignment.
 * A match therefore already proves "module-level and exported", and it proves
 * the stronger thing this step actually needs: that
 * {@link serverFunctionNodes}, which is built from the same map, **emits** the
 * node whose id is returned here. Gating on the `export` keyword in front of
 * that loop rejected the clause and default-assignment spellings, and a call
 * inside such a service function lost its `server-function` origin even though
 * the same run had emitted that very node.
 *
 * @param scope The file under extraction.
 * @param candidate One enclosing function.
 * @returns The server-function node id, or `undefined`.
 */
function serverFunctionOwnerId(
  scope: OwnerScope,
  candidate: FunctionCandidate,
): string | undefined {
  if (!scope.isServerModule || !candidate.isModuleLevel) {
    return undefined;
  }

  for (const fn of scope.exports.functions.values()) {
    if (isSameNode(fn.declaration, candidate.declaration)) {
      return serverFunctionNodeId(scope.file, fn);
    }
  }

  return undefined;
}

/**
 * Step 5: the `symbol` node this declaration is inventoried as by
 * `./symbols.ts`.
 *
 * Module-level declarations and class members of module-level classes, which is
 * exactly that extractor's scope — a declaration nested in a function body is
 * deliberately not inventoried there, so naming one here would produce an edge
 * the graph drops.
 *
 * @param scope The file under extraction.
 * @param candidate One enclosing function.
 * @returns The symbol node id, or `undefined`.
 */
function symbolOwnerId(scope: OwnerScope, candidate: FunctionCandidate): string | undefined {
  if (candidate.isModuleLevel) {
    const name = candidate.name ?? (candidate.isDefaultExport ? DEFAULT_EXPORT_NAME : undefined);

    return name === undefined ? undefined : symbolNodeId(scope.file, name, candidate.position);
  }

  if (candidate.container !== undefined && candidate.name !== undefined) {
    return symbolNodeId(scope.file, candidate.name, candidate.position);
  }

  return undefined;
}

/**
 * Step 6's near miss: the module-level declaration a call outside every
 * function belongs to.
 *
 * A call in a module-level initialiser (`const routes = build();`), in a
 * module-level class member's initialiser, or in an `export default <call>`
 * expression is attributed to the declaration that holds it, which
 * `./symbols.ts` inventories. Anything left over — a bare top-level statement —
 * has no declaration to name, and the caller falls back to the file node.
 *
 * @param scope The file under extraction.
 * @param call The call expression.
 * @returns The symbol node id, or `undefined`.
 */
function moduleLevelOwnerId(scope: OwnerScope, call: Node): string | undefined {
  for (const ancestor of call.getAncestors()) {
    if (Node.isSourceFile(ancestor)) {
      return undefined;
    }

    if (Node.isVariableDeclaration(ancestor)) {
      const nameNode = ancestor.getNameNode();
      const statement = ancestor.getVariableStatement();
      const name = Node.isIdentifier(nameNode) ? nonEmptyText(nameNode) : undefined;

      if (name !== undefined && statement !== undefined && isModuleLevel(statement)) {
        return symbolNodeId(scope.file, name, positionOf(nameNode));
      }

      continue;
    }

    if (Node.isPropertyDeclaration(ancestor)) {
      const nameNode = ancestor.getNameNode();
      const parent = ancestor.getParent();
      const name = Node.isIdentifier(nameNode) ? nonEmptyText(nameNode) : undefined;

      if (
        name !== undefined &&
        Node.isClassDeclaration(parent) &&
        moduleLevelClassName(parent) !== undefined
      ) {
        return symbolNodeId(scope.file, name, positionOf(nameNode));
      }

      continue;
    }

    if (Node.isExportAssignment(ancestor) && !ancestor.isExportEquals()) {
      const expression = ancestor.getExpression();

      // An `export default <identifier>` cannot contain a call, so whatever is
      // here is the minted `default` node's expression.
      if (!Node.isIdentifier(expression) && isModuleLevel(ancestor)) {
        return symbolNodeId(scope.file, DEFAULT_EXPORT_NAME, positionOf(expression));
      }
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Node and edge construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * The id of the `server-function` node of one exported function.
 *
 * The single derivation, used both when this extractor emits the node for the
 * file it declares and when another file's call site points at it — so a target
 * id cannot drift from the id the node is emitted under.
 *
 * @param file The declaring module, project-relative POSIX.
 * @param fn The exported function.
 * @returns The node id.
 */
function serverFunctionNodeId(file: string, fn: ExportedFunction): string {
  return makeNodeId({
    kind: 'server-function',
    file,
    name: fn.declaredName,
    line: fn.line,
    column: fn.column,
  });
}

/**
 * The id of the `symbol` node `./symbols.ts` records a declaration under.
 *
 * @param file The file, project-relative POSIX.
 * @param name The declared name.
 * @param position The declaration's 1-based position.
 * @returns The node id.
 */
function symbolNodeId(file: string, name: string, position: Position): string {
  return makeNodeId({ kind: 'symbol', file, name, line: position.line, column: position.column });
}

/**
 * The id of the `file` node `./imports.ts` emits for a module.
 *
 * A file is not declared at a position, so its node is anchored at line 1,
 * column 1, and its name *is* its project-relative path — the convention
 * `../graph/types.ts` documents and `./imports.ts` implements. Spelled here
 * because the cascade's last resort points at it, and an id that disagreed by
 * one character would be an edge the graph drops.
 *
 * @param file The module, project-relative POSIX.
 * @returns The node id.
 */
function fileNodeIdFor(file: string): string {
  return makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 });
}

/**
 * The `server-function` nodes of one server module, in source order.
 *
 * A function exported under several names is **one** node: the declaration is
 * one function at one position, and a second node would be a second answer to
 * "where is this function". De-duplication is therefore by declaration
 * identity, and the order is the declarations' own — position first, which is
 * source order, with the name as a tie-breaker so the order is total and
 * reproducible rather than dependent on the sort's stability.
 *
 * @param file The module, project-relative POSIX.
 * @param exports The module's export surface.
 * @returns The nodes to emit.
 */
function serverFunctionNodes(
  file: string,
  exports: ModuleExports,
): readonly CodeNodeOf<'server-function'>[] {
  const unique = new Map<string, ExportedFunction>();

  for (const fn of exports.functions.values()) {
    const key = `${String(fn.line)}:${String(fn.column)}:${fn.declaredName}`;

    if (!unique.has(key)) {
      unique.set(key, fn);
    }
  }

  const ordered = [...unique.values()].sort(compareFunctions);

  return ordered.map((fn) => ({
    id: serverFunctionNodeId(file, fn),
    kind: 'server-function' as const,
    name: fn.declaredName,
    file,
    line: fn.line,
    column: fn.column,
    endLine: Math.max(fn.endLine, fn.line),
    // Only exported functions become nodes at all: an unexported helper is
    // reachable from nowhere else, so nothing downstream could address one.
    exported: true,
    data: { isAsync: fn.isAsync, exported: true },
  }));
}

/**
 * Orders two exported functions: by position, then by name.
 *
 * Byte-wise string comparison rather than a locale-aware one, so the serialised
 * index is identical on every machine — the reason `../graph/graph.ts` gives for
 * its own comparator, applied here for the same reason.
 *
 * @param left The first function.
 * @param right The second function.
 * @returns A negative number, zero, or a positive number.
 */
function compareFunctions(left: ExportedFunction, right: ExportedFunction): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  if (left.column !== right.column) {
    return left.column - right.column;
  }

  if (left.declaredName === right.declaredName) {
    return 0;
  }

  return left.declaredName < right.declaredName ? -1 : 1;
}

/**
 * The `calls` edges of one file, in source order.
 *
 * One edge per call site that resolves to a `server-function` node: the site's
 * line and column are part of the edge id, so the same caller calling the same
 * callee twice is two edges — which is both true to the source and what
 * `../graph/query.ts`'s `whoCalls` reports as two call sites. An id already
 * emitted is skipped, so `../graph/graph.ts` never has to drop a duplicate from
 * this extractor's contribution.
 *
 * The edge's **site** is the call expression, which is the position a developer
 * wants to be taken to when they ask why two things are connected, and the
 * position `whoCalls` reports for the caller.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param cache The per-call memoisation.
 * @param scope The file under extraction.
 * @returns The edges to emit.
 */
function callsEdges(
  ctx: ExtractorContext,
  cache: AnalysisCache,
  scope: OwnerScope,
): readonly CodeEdge[] {
  const edges: CodeEdge[] = [];
  const emitted = new Set<string>();

  ctx.sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const target = callTargetOf(ctx, cache, scope, node);
    if (target === undefined) {
      return;
    }

    const from = ownerNodeIdFor(scope, node);
    const to = serverFunctionNodeId(target.file, target.fn);
    const site = positionOf(node);
    const id = makeEdgeId({ kind: 'calls', from, to, line: site.line, column: site.column });

    if (emitted.has(id)) {
      return;
    }
    emitted.add(id);

    edges.push({
      id,
      kind: 'calls',
      from,
      to,
      file: scope.file,
      line: site.line,
      column: site.column,
    });
  });

  return edges;
}

/**
 * The `server-function` one call expression reaches, or `undefined` when it
 * reaches none this extractor emits a node for.
 *
 * The callee must be a plain identifier. A property-access callee
 * (`lib.load()`, `this.load()`) is a value question rather than a syntactic
 * one, and resolving it would need the type checker this package deliberately
 * does not run at index time; a database driver call is precisely that shape
 * and belongs to the data-access extractor anyway.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param cache The per-call memoisation.
 * @param scope The file under extraction.
 * @param call The call expression.
 * @returns The resolved target, or `undefined`.
 */
function callTargetOf(
  ctx: ExtractorContext,
  cache: AnalysisCache,
  scope: OwnerScope,
  call: CallExpression,
): ResolvedTarget | undefined {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) {
    return undefined;
  }

  const name = nonEmptyText(callee);
  if (name === undefined) {
    return undefined;
  }

  // A name any enclosing scope declares is not an imported binding, whatever
  // this module imports under the same spelling. Where that declaration is one
  // of this server module's own exported functions, the call is a same-file
  // hop worth an edge; where it is a local helper, a parameter or a
  // non-function, it is not.
  const local = declarationInScopes(call, name);
  if (local !== undefined) {
    return scope.isServerModule ? sameFileTarget(scope, local) : undefined;
  }

  const binding = scope.imports.get(name);
  if (binding === undefined) {
    return undefined;
  }

  const module = resolvedModuleOf(binding.declaration);
  if (module === undefined) {
    return undefined;
  }

  return findServerFunction(ctx, cache, module, binding.exportName, 0, new Set<string>());
}

/**
 * The exported function of this module a locally resolved declaration is, if it
 * is one.
 *
 * @param scope The file under extraction.
 * @param declaration The declaration the callee resolved to.
 * @returns The target, or `undefined`.
 */
function sameFileTarget(scope: OwnerScope, declaration: Node): ResolvedTarget | undefined {
  for (const fn of scope.exports.functions.values()) {
    if (isSameNode(fn.declaration, declaration)) {
      return Object.freeze({ file: scope.file, fn });
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Route identity, re-derived locally
 *
 * The bounded local re-derivation of one question: "is this module a request
 * handler, and what is the id of the `api-route` node `./api-routes.ts` emits
 * for it?" See this file's header for why it is local rather than imported,
 * and for the standing obligation to keep it in step with `../route-map.ts`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * One URL-contributing piece of a route module's path — an App Router
 * directory, a Pages Router directory, or a Pages Router file name —
 * classified as far as this helper needs it.
 *
 * Only two facts about a segment matter to a node id: the text it contributes
 * to the URL, which is the segment **exactly as the path spells it**, brackets
 * included, and whether it is a catch-all, which is the one cross-segment rule
 * that can refuse a whole module. The four-way segment kind
 * `../route-map.ts` carries exists for request *matching*, which is that
 * module's business and not this one's.
 */
interface ClassifiedRouteSegment {
  /** The segment as written on disk, brackets included. */
  readonly raw: string;

  /** Whether the segment consumes the remainder of a request path. */
  readonly isCatchAll: boolean;
}

/**
 * What a module's own `export` statements intend for the declarations it
 * declares locally.
 *
 * The reason this exists is stated in full in this file's header: the route map
 * asks ts-morph's `isExported()` / `isDefaultExport()`, which fall back to the
 * **type checker** and therefore see a declaration exported by a clause, while
 * this extractor is contractually abstract-syntax-tree-only. These two maps are
 * the syntactic equivalent — every `export { … }` clause of the module that
 * carries no module specifier, and every `export default <identifier>`
 * statement — and they reproduce the checker's answer for every shape this
 * helper is exercised against.
 *
 * A **type-only** clause is deliberately not filtered out: a type-only export
 * of a value declaration still enters the module's export symbol table, so
 * `isExported()` reports `true` for it, and filtering here would move the
 * anchor.
 */
interface LocalExportIntents {
  /**
   * Local name → the names a module-specifier-less `export { … }` clause
   * exports it under, in source order.
   *
   * A clause that carries a module specifier (`export { GET } from './x'`)
   * names *another* module's declaration and is therefore absent: it exports
   * nothing of this module, which is exactly what the checker reports.
   */
  readonly clauses: ReadonlyMap<string, readonly string[]>;

  /** The local names an `export default <identifier>` statement names. */
  readonly defaults: ReadonlySet<string>;
}

/**
 * The route identity of the file under extraction: its handler convention and
 * its `api-route` node id, or `undefined` when this helper will not vouch for
 * one.
 *
 * **Refusal is the safe answer and is used freely.** A refusal drops step 2 of
 * the cascade for this file, and the call is then attributed by the component,
 * server-function or symbol step — nodes that always exist, and the same, less
 * specific, attribution `./api-calls.ts` makes for every route handler. A
 * *wrong* id is not safe: an `api-route` id that differs from
 * `./api-routes.ts`'s by one character is a `dangling-edge`
 * `../graph/graph.ts` drops, which silently deletes the route-to-service tier
 * boundary. So every refusal below is deliberate, and every value returned is
 * one the derivation can account for.
 *
 * What is refused, beyond the module shapes {@link appRouteIdentity} and
 * {@link pagesRouteIdentity} state:
 *
 * - a path that does not normalise to a safe project-relative path;
 * - a module containing an `export =` assignment. That form is visible to the
 *   route map through the type checker and invisible to syntax, so this helper
 *   cannot reproduce the route map's reading of such a module and declines to
 *   guess. It is a CommonJS-only form no supported router serves.
 *
 * @param sourceFile The module under extraction, as loaded by `../project.ts`.
 * @param file The module's project-relative POSIX path.
 * @returns The identity, or `undefined` when this module is not a
 * request-handler route module this helper can name.
 */
function routeModuleIdentityOf(
  sourceFile: SourceFile,
  file: string,
): RouteModuleIdentity | undefined {
  // Normalised first and validated after, which is the order `../route-map.ts`
  // applies: the normalised path is what its entry carries, and therefore what
  // `./api-routes.ts` puts in the node id.
  const normalized = normalizePosix(toPosix(file));
  if (!isSafeRelativePath(normalized)) {
    return undefined;
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      return undefined;
    }
  }

  // The App Router is probed first and exclusively, as `../route-map.ts` probes
  // it: one path cannot belong to both trees, and a module below the first
  // matching root is judged by that root's convention alone.
  const appRest = routerRelativePath(normalized, APP_ROUTER_PREFIXES);
  if (appRest !== undefined) {
    return appRouteIdentity(sourceFile, normalized, appRest);
  }

  const pagesRest = routerRelativePath(normalized, PAGES_ROUTER_PREFIXES);
  if (pagesRest !== undefined) {
    return pagesRouteIdentity(sourceFile, normalized, pagesRest);
  }

  return undefined;
}

/**
 * The part of a path below the first of a router's roots that contains it.
 *
 * A segment-boundary test rather than a string-prefix test, because the roots
 * are spelled with their trailing separator: `application/page.tsx` is not
 * below `app/`.
 *
 * @param file The module's normalised project-relative POSIX path.
 * @param prefixes The router's roots, in probe order, each ending in a
 * separator.
 * @returns The remainder of the path with no leading separator, or `undefined`
 * when the file is below none of them.
 */
function routerRelativePath(file: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    if (file.startsWith(prefix)) {
      return file.slice(prefix.length);
    }
  }

  return undefined;
}

/**
 * The identity of an App Router module, or `undefined` when it is not a
 * request handler this helper can name.
 *
 * The URL is the *directory* the module sits in — `route.*` is a name that
 * marks a directory as routable rather than a name that appears in a URL — so
 * the file name contributes nothing beyond making the module a handler.
 *
 * Refused: any stem other than `route` (which covers `page.*` and every
 * special file the framework has now or adds later, because the rule is stated
 * positively), an unsupported extension, a private `_folder`, an intercepting
 * `(.)folder`, a malformed bracket segment and a catch-all that is not last.
 *
 * @param sourceFile The module.
 * @param file The module's normalised project-relative POSIX path.
 * @param rest The part of that path below the App Router root.
 * @returns The identity, or `undefined`.
 */
function appRouteIdentity(
  sourceFile: SourceFile,
  file: string,
  rest: string,
): RouteModuleIdentity | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);
  if (!APP_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  if (basenamePosix(base, extension) !== APP_HANDLER_STEM) {
    return undefined;
  }

  const segments: ClassifiedRouteSegment[] = [];
  for (const raw of pathSegmentsOf(rest).slice(0, -1)) {
    const classified = classifyAppRouteDirectory(raw);
    if (classified === undefined) {
      return undefined;
    }

    if (classified !== SKIPPED_ROUTE_SEGMENT) {
      segments.push(classified);
    }
  }

  const routePath = routePathOf(segments);
  if (routePath === undefined) {
    return undefined;
  }

  return Object.freeze({
    convention: 'app' as const,
    apiRouteNodeId: apiRouteNodeIdFor(
      file,
      routePath,
      appHandlerPosition(sourceFile) ?? FILE_START_POSITION,
    ),
  });
}

/**
 * The identity of a legacy Pages Router module, or `undefined` when it is not a
 * request handler this helper can name.
 *
 * Unlike the App Router, the *file name* is part of the URL here, `index`
 * collapses to its own directory, and only a module below `api/` answers
 * requests — everything else renders, which makes it a page and therefore not
 * this step's business. Parentheses carry no meaning in this convention, so a
 * parenthesised directory is an ordinary static segment rather than a group.
 *
 * Refused: an unsupported extension, a stem that is private (`_app`,
 * `_document`, `_error`, any `_`-prefixed name), a dotfile, `middleware.*`, a
 * module outside `api/`, a private directory, a malformed bracket segment and a
 * catch-all that is not last.
 *
 * @param sourceFile The module.
 * @param file The module's normalised project-relative POSIX path.
 * @param rest The part of that path below the Pages Router root.
 * @returns The identity, or `undefined`.
 */
function pagesRouteIdentity(
  sourceFile: SourceFile,
  file: string,
  rest: string,
): RouteModuleIdentity | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);
  if (!PAGES_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const stem = basenamePosix(base, extension);
  if (stem.startsWith('_') || stem.startsWith('.') || stem === PAGES_MIDDLEWARE_STEM) {
    return undefined;
  }

  const directories = pathSegmentsOf(rest).slice(0, -1);
  if (directories[0] !== PAGES_API_SEGMENT) {
    // A rendering module of the Pages Router is a page, and the cascade's step
    // 2 excludes a page whichever router it belongs to.
    return undefined;
  }

  const segments: ClassifiedRouteSegment[] = [];
  for (const raw of directories) {
    if (raw.startsWith('_')) {
      return undefined;
    }

    const classified = classifyRouteSegment(raw);
    if (classified === undefined) {
      return undefined;
    }

    segments.push(classified);
  }

  if (stem !== PAGES_INDEX_STEM) {
    const classified = classifyRouteSegment(stem);
    if (classified === undefined) {
      return undefined;
    }

    segments.push(classified);
  }

  const routePath = routePathOf(segments);
  if (routePath === undefined) {
    return undefined;
  }

  return Object.freeze({
    convention: 'pages' as const,
    apiRouteNodeId: apiRouteNodeIdFor(
      file,
      routePath,
      pagesHandlerPosition(sourceFile) ?? FILE_START_POSITION,
    ),
  });
}

/**
 * What one directory above an App Router module contributes to its URL.
 *
 * Four outcomes, which are `../route-map.ts`'s four: `undefined` for a
 * directory that makes the module unroutable (a private `_folder`, an
 * intercepting-route marker, a malformed bracket segment),
 * {@link SKIPPED_ROUTE_SEGMENT} for a route group `(group)` or a parallel-route
 * slot `@slot` — both of which organise the tree without appearing in the URL —
 * and otherwise the segment itself.
 *
 * @param raw The directory name, exactly as written on disk.
 * @returns The contribution, the skip marker, or `undefined`.
 */
function classifyAppRouteDirectory(
  raw: string,
): ClassifiedRouteSegment | typeof SKIPPED_ROUTE_SEGMENT | undefined {
  if (raw.startsWith('_')) {
    return undefined;
  }

  if (INTERCEPTING_ROUTE_PREFIX.test(raw)) {
    return undefined;
  }

  if (raw.startsWith('(') && raw.endsWith(')')) {
    return SKIPPED_ROUTE_SEGMENT;
  }

  if (raw.startsWith('@')) {
    return SKIPPED_ROUTE_SEGMENT;
  }

  return classifyRouteSegment(raw);
}

/**
 * Classifies one URL-contributing piece as static or as one of the three
 * dynamic forms, refusing a spelling it cannot read.
 *
 * The three legal dynamic spellings are recognised exactly, longest form first,
 * and anything else carrying a bracket is refused: a segment whose URL
 * contribution is not knowable would, if invented, attribute a captured request
 * to the wrong module. Brackets are read literally, because a file path carries
 * them literally.
 *
 * @param raw The piece, exactly as written on disk.
 * @returns The segment, or `undefined` when the spelling is not legal.
 */
function classifyRouteSegment(raw: string): ClassifiedRouteSegment | undefined {
  if (raw.length === 0) {
    return undefined;
  }

  if (raw.startsWith('[[...') && raw.endsWith(']]')) {
    return dynamicRouteSegment(raw, raw.slice('[[...'.length, -']]'.length), true);
  }

  if (raw.startsWith('[...') && raw.endsWith(']') && !raw.endsWith(']]')) {
    return dynamicRouteSegment(raw, raw.slice('[...'.length, -']'.length), true);
  }

  if (raw.startsWith('[') && raw.endsWith(']') && !raw.startsWith('[[')) {
    return dynamicRouteSegment(raw, raw.slice('['.length, -']'.length), false);
  }

  if (raw.includes('[') || raw.includes(']')) {
    return undefined;
  }

  return Object.freeze({ raw, isCatchAll: false });
}

/**
 * Builds a dynamic segment, refusing an unusable parameter name.
 *
 * @param raw The segment as written, brackets included.
 * @param param The captured name, already stripped of its brackets.
 * @param isCatchAll Whether the form consumes the remainder of a request path.
 * @returns The segment, or `undefined` when the name is not usable.
 */
function dynamicRouteSegment(
  raw: string,
  param: string,
  isCatchAll: boolean,
): ClassifiedRouteSegment | undefined {
  return ROUTE_PARAM_NAME.test(param) ? Object.freeze({ raw, isCatchAll }) : undefined;
}

/**
 * The URL path a list of segments spells, enforcing the one cross-segment rule:
 * a catch-all consumes every remaining segment, so anything after it could
 * never match and the framework rejects such a tree outright.
 *
 * Leading `/`, no trailing `/`, bracket forms preserved, and the root when
 * there are no segments. Built with `joinPosix` so the separator arithmetic is
 * the shared implementation's rather than this module's; nothing a segment can
 * hold makes that normalisation lossy, because {@link classifyRouteSegment} has
 * already established that a segment is non-empty, carries no separator and is
 * neither `.` nor `..`.
 *
 * @param segments The route's segments, in URL order.
 * @returns The route path, or `undefined` when a catch-all is misplaced.
 */
function routePathOf(segments: readonly ClassifiedRouteSegment[]): string | undefined {
  const lastIndex = segments.length - 1;

  for (const [index, segment] of segments.entries()) {
    if (segment.isCatchAll && index !== lastIndex) {
      return undefined;
    }
  }

  if (segments.length === 0) {
    return ROOT_ROUTE_PATH;
  }

  return joinPosix(ROUTE_SEPARATOR, ...segments.map((segment) => segment.raw));
}

/**
 * The non-empty segments of a POSIX path, in order.
 *
 * @param path A project-relative path, or the part of one below a router root.
 * @returns Its non-empty segments.
 */
function pathSegmentsOf(path: string): readonly string[] {
  return path.split(ROUTE_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * The id of the `api-route` node `./api-routes.ts` emits for a route module.
 *
 * The one derivation, spelled exactly as that extractor spells it: the
 * normalised project-relative path, the route path as the node's **name**, and
 * the position of the route entry's location. An id that disagreed by one
 * character would be an edge `../graph/graph.ts` drops.
 *
 * @param file The module's normalised project-relative POSIX path.
 * @param routePath The URL the module serves.
 * @param position The entry location's 1-based position.
 * @returns The node id.
 */
function apiRouteNodeIdFor(file: string, routePath: string, position: Position): string {
  return makeNodeId({
    kind: 'api-route',
    file,
    name: routePath,
    line: position.line,
    column: position.column,
  });
}

/**
 * Where an App Router handler module's route entry is located: the
 * earliest-positioned handler declaration in the module.
 *
 * Three declaration shapes contribute a position, because all three are
 * ordinary in real projects and `../route-map.ts` reads all three:
 *
 * - a module-level **function declaration** that is exported, is not the
 *   default export, and whose name is an exportable HTTP method — positioned at
 *   the declaration's own start, which is its `export` keyword;
 * - an exported **variable statement** whose declarator is named for a method —
 *   positioned at the statement's start when it declares exactly one
 *   declarator, and at the declarator's name otherwise, because a statement
 *   declaring several bindings has no single start that names one of them;
 * - an **export specifier** whose exported name (its alias when it has one) is
 *   a method — positioned at the specifier, so the location is inside the route
 *   module a developer clicked even for a re-export from elsewhere.
 *
 * The earliest of them is the answer. `../route-map.ts` sorts the declarations,
 * drops a later occurrence of a method it has already seen and reports the
 * first survivor; the earliest by offset *is* that survivor, because the first
 * element of a sorted list can never be the duplicate of an earlier one. The
 * per-method de-duplication matters to the method *list* that module also
 * reports, and this helper does not report one.
 *
 * Exported-ness and default-ness are judged syntactically through
 * {@link LocalExportIntents}; `sourceFile.getFunctions()` is used for the first
 * shape precisely because ts-morph narrows it to implementations and ambient
 * declarations, which is the set the route map iterates.
 *
 * @param sourceFile The module to read.
 * @returns The position, or `undefined` when the module declares no handler —
 * in which case the caller anchors at {@link FILE_START_POSITION}, which is
 * what the route map falls back to.
 */
function appHandlerPosition(sourceFile: SourceFile): Position | undefined {
  const intents = localExportIntentsOf(sourceFile);
  const offsets: number[] = [];

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();

    if (
      name !== undefined &&
      EXPORTABLE_HTTP_METHODS.has(name) &&
      !isDefaultExportedDeclaration(declaration, name, intents) &&
      isExportedDeclaration(declaration, name, intents)
    ) {
      offsets.push(declaration.getStart());
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.hasExportKeyword()) {
      // A variable statement is exported by its keyword alone: the route map's
      // `isExported()` finds no symbol on a statement, so an `export { GET }`
      // clause naming a `const` is credited to the *specifier* below.
      continue;
    }

    const declarations = statement.getDeclarations();
    const single = declarations.length === 1;

    for (const declaration of declarations) {
      if (!EXPORTABLE_HTTP_METHODS.has(declaration.getName())) {
        continue;
      }

      offsets.push(single ? statement.getStart() : declaration.getNameNode().getStart());
    }
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    for (const specifier of declaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();

      if (EXPORTABLE_HTTP_METHODS.has(exportedName)) {
        offsets.push(specifier.getStart());
      }
    }
  }

  return offsets.length === 0 ? undefined : positionAtOffset(sourceFile, Math.min(...offsets));
}

/**
 * Where a legacy Pages Router handler module's route entry is located: its
 * default export, wherever it is spelled.
 *
 * Four spellings, and the order they are probed in is `../route-map.ts`'s
 * **probe order rather than source order** — a function declaration wins over
 * an `export default <identifier>` statement that precedes it, because that is
 * the declaration the route map locates:
 *
 * 1. a default-exported function declaration;
 * 2. a default-exported class declaration;
 * 3. an `export default <expression>` statement, positioned at the statement;
 * 4. an export specifier whose exported name is `default`, positioned at the
 *    specifier — which is how a re-exported default is located inside this
 *    module.
 *
 * @param sourceFile The module to read.
 * @returns The position, or `undefined` when the module has no default export —
 * in which case the caller anchors at {@link FILE_START_POSITION}.
 */
function pagesHandlerPosition(sourceFile: SourceFile): Position | undefined {
  const intents = localExportIntentsOf(sourceFile);

  for (const declaration of sourceFile.getFunctions()) {
    if (isDefaultExportedDeclaration(declaration, declaration.getName(), intents)) {
      return positionAtOffset(sourceFile, declaration.getStart());
    }
  }

  for (const declaration of sourceFile.getClasses()) {
    if (isDefaultExportedDeclaration(declaration, declaration.getName(), intents)) {
      return positionAtOffset(sourceFile, declaration.getStart());
    }
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    // `export =` cannot reach here — `routeModuleIdentityOf` refuses a module
    // that spells one — and the guard is kept because the route map's own probe
    // carries it, so the two readings stay comparable line by line.
    if (!assignment.isExportEquals()) {
      return positionAtOffset(sourceFile, assignment.getStart());
    }
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    for (const specifier of declaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();

      if (exportedName === DEFAULT_EXPORT_NAME) {
        return positionAtOffset(sourceFile, specifier.getStart());
      }
    }
  }

  return undefined;
}

/**
 * What a module's `export` statements intend for its local declarations.
 *
 * @param sourceFile The module to read.
 * @returns The clause and default-assignment intents.
 */
function localExportIntentsOf(sourceFile: SourceFile): LocalExportIntents {
  const clauses = new Map<string, string[]>();
  const defaults = new Set<string>();

  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifier() !== undefined) {
      continue;
    }

    for (const specifier of declaration.getNamedExports()) {
      const localName = specifier.getName();
      const exportedAs = specifier.getAliasNode()?.getText() ?? localName;
      const existing = clauses.get(localName);

      if (existing === undefined) {
        clauses.set(localName, [exportedAs]);
      } else {
        existing.push(exportedAs);
      }
    }
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      continue;
    }

    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) {
      const name = nonEmptyText(expression);

      if (name !== undefined) {
        defaults.add(name);
      }
    }
  }

  return Object.freeze({ clauses, defaults });
}

/**
 * Whether a declaration leaves its module, judged from syntax alone.
 *
 * The `export` keyword, or a local export clause naming it under any name —
 * which is the pair of conditions under which the route map's checker-backed
 * `isExported()` answers `true` for a module-level declaration.
 *
 * @param declaration The function or class declaration.
 * @param name Its declared name, or `undefined` for an anonymous one.
 * @param intents The module's export intents.
 * @returns `true` when the declaration is exported.
 */
function isExportedDeclaration(
  declaration: FunctionDeclaration | ClassDeclaration,
  name: string | undefined,
  intents: LocalExportIntents,
): boolean {
  if (declaration.hasExportKeyword()) {
    return true;
  }

  return name !== undefined && intents.clauses.has(name);
}

/**
 * Whether a declaration is its module's default export, judged from syntax
 * alone.
 *
 * Three spellings: the `default` keyword, an `export default <identifier>`
 * statement naming it, and a local export clause aliasing it to `default`. All
 * three make the route map's `isDefaultExport()` answer `true`, which is what
 * excludes such a declaration from the App Router's per-method handlers and
 * what makes it the Pages Router's handler.
 *
 * @param declaration The function or class declaration.
 * @param name Its declared name, or `undefined` for an anonymous one.
 * @param intents The module's export intents.
 * @returns `true` when the declaration is the module's default export.
 */
function isDefaultExportedDeclaration(
  declaration: FunctionDeclaration | ClassDeclaration,
  name: string | undefined,
  intents: LocalExportIntents,
): boolean {
  if (declaration.hasDefaultKeyword()) {
    return true;
  }

  if (name === undefined) {
    return false;
  }

  return (
    intents.defaults.has(name) || (intents.clauses.get(name) ?? []).includes(DEFAULT_EXPORT_NAME)
  );
}

/**
 * The 1-based line and column of a character offset in a module.
 *
 * The offset-taking counterpart of {@link positionOf}, needed because the route
 * map anchors an entry at a declaration's **start offset** and this helper has
 * to convert the same offsets it does. ts-morph's conversion is already 1-based
 * on both axes and never reports a position below the first character, so the
 * route map's clamp of the same value is a no-op and is not repeated.
 *
 * @param sourceFile The module the offset belongs to.
 * @param offset The character offset.
 * @returns The 1-based position.
 */
function positionAtOffset(sourceFile: SourceFile, offset: number): Position {
  const { line, column } = sourceFile.getLineAndColumnAtPos(offset);

  return { line, column };
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * The class name of a thrown value, for a diagnostic that has to say *what*
 * failed without quoting anything.
 *
 * An error's `message` is deliberately unused: a syntax error raised while
 * walking a module routinely embeds the offending source text, and a diagnostic
 * is persisted with a session, written to logs and can reach model prompt
 * context. A class name is a name.
 *
 * @param cause The value a `catch` bound, which need not be an `Error`.
 * @returns The error's `name`, or the value's type for a non-error throw.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name.length > 0 ? cause.name : 'Error';
  }

  return typeof cause;
}

/**
 * The `extractor-failed` diagnostic for a module this extractor could not read.
 *
 * Severity `error` because a part of the index is missing: the file's server
 * functions and the calls into them are absent, so a query about that tier
 * boundary reports nothing rather than something wrong. `extractorId` is
 * stamped here rather than left to the indexer, so the finding stays
 * attributable even when a caller runs this extractor directly. It is the one
 * code in the closed diagnostic vocabulary that belongs to an extractor.
 *
 * @param file The module, project-relative POSIX.
 * @param cause The value the failure threw.
 * @returns The diagnostic, carrying no source text.
 */
function extractorFailedDiagnostic(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `Reading server functions failed; this module contributes no server-function node and no calls edge (${describeCause(cause)}).`,
    file,
    extractorId: SERVER_FUNCTIONS_EXTRACTOR_ID,
  };
}

/**
 * A fresh per-call memoisation.
 *
 * @returns The empty cache.
 */
function newAnalysisCache(): AnalysisCache {
  return {
    exports: new Map<string, ModuleExports>(),
    serverModule: new Map<string, boolean>(),
    indexable: new Map<string, string | undefined>(),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `server-functions` extractor: the `server-function` nodes of one module,
 * and the `calls` edges every call site in that module makes into a server
 * function of the project.
 *
 * Synchronous, and pure with respect to the project and the machine: it reads
 * the abstract syntax tree of the file it was handed and of the modules that
 * file imports, writes no file, opens no socket, keeps no state beyond the call
 * it is inside, mutates no node and adds no source file to the project. Its
 * output is deterministic — nodes in source order, edges in the order their
 * call sites appear — so two runs over unchanged source produce identical
 * results, which is what `../indexer.ts`'s reproducibility promise rests on.
 *
 * It never throws. A module that cannot be read becomes an `extractor-failed`
 * diagnostic and an empty contribution, which is the same observable outcome as
 * an escaping throw with the run continuing — and every other file of the
 * project is indexed regardless.
 *
 * @example
 * ```ts
 * const result = serverFunctionsExtractor.extract(ctx);
 * result.nodes[0]?.data.isAsync; // whether a timing wrapper must end on settle
 * result.edges.filter((edge) => edge.kind === 'calls'); // every hop into the service layer
 * ```
 */
export const serverFunctionsExtractor: Extractor = Object.freeze({
  id: SERVER_FUNCTIONS_EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    try {
      // Defence in depth on the invariant every node and edge field shares. The
      // indexer computes this path through `LoadedProject.projectRelative`, so
      // it cannot fail today; were it ever to, the graph would drop the
      // contribution anyway, and declining here keeps the reason attributable.
      if (!isSafeRelativePath(ctx.file)) {
        ctx.logger.warn('Module skipped: its path is not a safe project-relative path', {
          extractorId: SERVER_FUNCTIONS_EXTRACTOR_ID,
          file: ctx.file,
        });

        return NOTHING_FOUND;
      }

      const cache = newAnalysisCache();
      const exports = moduleExportsOf(cache, ctx.sourceFile);
      const isServerModule = qualifiesAsServerModule(cache, ctx.sourceFile, ctx.file);

      const scope: OwnerScope = {
        file: ctx.file,
        fileNodeId: fileNodeIdFor(ctx.file),
        route: routeModuleIdentityOf(ctx.sourceFile, ctx.file),
        handlers: collectHandlerBindings(ctx.sourceFile),
        isServerModule,
        exports,
        imports: importedBindingsOf(ctx.sourceFile),
      };

      // A module that is a component module or a route/page module contributes
      // no node of this kind, and still contributes every edge: a route handler
      // and a page component are exactly the call sites worth recording.
      const nodes = isServerModule ? serverFunctionNodes(ctx.file, exports) : [];
      const edges = callsEdges(ctx, cache, scope);

      if (nodes.length === 0 && edges.length === 0) {
        return NOTHING_FOUND;
      }

      return { nodes, edges };
    } catch (cause) {
      return {
        nodes: [],
        edges: [],
        diagnostics: [extractorFailedDiagnostic(ctx.file, cause)],
      };
    }
  },
});
