/**
 * `api-routes` — the route extractor of `@debuggen/code-analysis`, and the
 * fifth entry of `../indexer.ts`'s `DEFAULT_EXTRACTORS`.
 *
 * ## The node kind it owns
 *
 * `api-route`, in full: **request-handler modules and page modules, in both
 * Next.js routers**. One node per route file, named by the URL that file
 * answers, carrying which router convention it belongs to, whether it handles
 * requests or renders a document, and which HTTP methods it answers.
 *
 * These nodes are the server-side anchor of the product. `../graph/query.ts`
 * answers `routeForUrl` and `handlersFor` from them; `../route-map.ts`'s
 * `routeMapFromIndex` rebuilds a whole route map out of them when only a
 * cached index is available; `../summary.ts` reads the `router` field of the
 * set to report which router convention a project actually uses; and an
 * instrumentation plan's `server-span` action names the HTTP-method export
 * recorded here.
 *
 * ## The hard rule: URL derivation lives in `../route-map.ts`
 *
 * This module **derives nothing about a URL and reads no export list of its
 * own**. It calls {@link deriveRouteFromFile} for the path question and
 * {@link buildRouteEntry} for the syntax question, and builds its node payload
 * out of the answer. Both are exported from `../route-map.ts` for exactly this
 * reason — one implementation, two callers — and `buildRouteEntry`'s own
 * documentation names this file as the second one. Re-deriving either here
 * would be a second answer to "what path does this file serve, and what does
 * it answer", and the route-group-plus-catch-all case is the one a local
 * re-derivation gets wrong.
 *
 * Everything the convention involves therefore stays in one place and is
 * trusted here, including `undefined` for a file that serves no URL:
 * `[param]`, `[...param]`, `[[...param]]`, `(group)` stripping, private
 * `_folder`, `@slot`, `index` collapsing, the App Router's special files
 * (`layout`, `loading`, `error`, `not-found`, `template`, `default`, …), the
 * Pages Router's `_app`/`_document`, intercepting routes, malformed bracket
 * segments and unsupported extensions.
 *
 * ## Data-completeness obligation
 *
 * `routeMapFromIndex` reconstructs a `RouteEntry` from one of these nodes by
 * reading its `file`, `data.routePath`, `data.router`, `data.kind`,
 * `data.methods` and its position fields (`line`, `column`, `symbol`,
 * `endLine`) — and nothing else, because it has no syntax to read. Every one
 * of those is populated below from the very entry `buildRouteMap` would have
 * produced for the same file, which is what makes the index-backed map agree
 * with the freshly built one rather than merely resemble it. Segments,
 * dynamic parameters and the catch-all flags are deliberately not duplicated
 * into the payload: `routeMapFromIndex` re-parses them from the route path,
 * and a stored copy could only ever disagree with it.
 *
 * ## Where per-method positions live
 *
 * An App Router handler module may export several methods, and a consumer
 * needs to know *where each one is declared* — "which function serves POST on
 * this route, and where is it". That cannot live on the node: a `CodeNode`
 * carries one position, and `ApiRouteNodeData` is closed at four fields. Two
 * channels answer it instead, and this module adds nothing to them:
 *
 * - For a live project, {@link routeEntryForFile} — exported here — returns
 *   the complete `RouteEntry`, whose `methodLocations` maps each method name
 *   to its own `SourceLocation`.
 * - In an index, the exported method handlers are `symbol` nodes emitted by
 *   `./symbols.ts` in the same file. That is the pairing `../graph/query.ts`'s
 *   `handlersFor` is specified to make, and the `declares` hop that
 *   `../graph/types.ts`'s reachability invariant sanctions. Emitting those
 *   nodes from here as well would collide on id with the symbol extractor's
 *   and produce `duplicate-node-id` diagnostics.
 *
 * ## What it deliberately does not emit
 *
 * - **No `file` node.** `./imports.ts` owns that kind and is the only emitter.
 * - **No edges of any kind.** The `calls` linkage from a route into the
 *   service layer belongs to `./server-functions.ts`, and `routes-to` (an
 *   `api-call` pointing at a route) is derived during graph assembly from two
 *   nodes rather than read off a line of source — no single extractor can emit
 *   it.
 * - **No references.** Resolving who references a declaration is the lazy
 *   `ReferenceResolver`'s job and must not run during a build.
 *
 * ## Abstract-syntax-tree first, no type resolution
 *
 * The route conventions are *naming* conventions: a file's path decides the
 * URL and an export's name decides the method. Nothing here consults the type
 * checker, resolves a module specifier or reads a second file, so the cost of
 * this extractor is a walk of one module's export list — which is what lets
 * the indexer run all eight extractors over every file of a real project.
 *
 * ## Findings, and the one diagnostic code used
 *
 * A route module that exports no handler at all reports `methods: []`, which
 * `../graph/types.ts` documents as the finding channel for exactly this
 * situation — the node still serves its URL, so dropping it would hide the
 * route rather than report the gap — accompanied by a log line. No
 * `IndexDiagnostic` is raised for it: the diagnostic vocabulary is closed and
 * assigns every code to exactly one emitter, and none of them means "an
 * extractor found something odd".
 *
 * The single code this module does emit is `extractor-failed`, when reading a
 * module throws. {@link apiRoutesExtractor}'s `extract` never propagates a
 * throw, so the observable outcome matches what `../indexer.ts` would have
 * recorded for an escaping one — an attributable `error`, the file's route
 * node absent, every other file still indexed. Diagnostic text names the file
 * and the error's class and quotes no source, per the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES`.
 *
 * @packageDocumentation
 */

import { isSafeRelativePath } from '@debuggen/shared';
import type { SourceFile } from 'ts-morph';

import { makeNodeId } from '../graph/graph.js';
import { API_ROUTE_KINDS } from '../graph/types.js';
import type {
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { buildRouteEntry, deriveRouteFromFile } from '../route-map.js';
import type { DeriveRouteOptions, RouteEntry } from '../route-map.js';

/* -------------------------------------------------------------------------------------------------
 * Identity and constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * This extractor's {@link Extractor.id}.
 *
 * Exported so that `../indexer.ts`, a diagnostic consumer and a test can name
 * it without repeating a string literal. Stable across versions: renaming it
 * would make previously reported diagnostics untraceable to their source.
 */
export const API_ROUTES_EXTRACTOR_ID = 'api-routes';

/**
 * The route kinds this extractor accepts, widened to `readonly string[]`.
 *
 * `API_ROUTE_KINDS` is the vocabulary; the widened alias is what makes the
 * membership test below a real runtime check rather than one the compiler can
 * prove away from `DerivedRoute.kind`'s declared type. The check is defensive
 * on purpose: a route kind added to the vocabulary that this module has no
 * node shape for must be skipped, not emitted half-populated.
 */
const ACCEPTED_ROUTE_KINDS: readonly string[] = API_ROUTE_KINDS;

/**
 * The result for a file that serves no URL: no nodes, no edges, no
 * diagnostics.
 *
 * One frozen instance, shared. `ExtractorResult` requires `nodes` and `edges`
 * to be empty rather than absent so the indexer can concatenate without a
 * guard, and requires `diagnostics` to be absent rather than empty for a clean
 * extraction — both of which this value is.
 */
const NO_ROUTE: ExtractorResult = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
});

/**
 * The edge list every result of this extractor carries: empty, always.
 *
 * Stated once as a named constant so that "this extractor emits no edges" is a
 * property of the module rather than a coincidence of three literals.
 */
const NO_EDGES: ExtractorResult['edges'] = Object.freeze([]);

/* -------------------------------------------------------------------------------------------------
 * Route reading
 * ---------------------------------------------------------------------------------------------- */

/**
 * The complete route entry for one module, or `undefined` when the module
 * serves no URL.
 *
 * The composition of `../route-map.ts`'s two exported halves — the path
 * question and the syntax question — in the order this extractor asks them,
 * and the only route reading that happens in this file:
 *
 * 1. {@link deriveRouteFromFile} decides whether the path names a route at all
 *    and, if so, what URL it answers. Its `undefined` is final here.
 * 2. {@link buildRouteEntry} completes that route by reading the module's
 *    exports: which methods it answers, and where each one is declared.
 *
 * Exported because the entry carries two things a graph node cannot. Its
 * `location` is the `SourceLocation` of the route as a whole and its
 * `methodLocations` is the per-method map described on this module — both
 * produced by `../route-map.ts` and **passed through unchanged**, so both
 * carry `resolvedBy: 'route-map'` with that route's default confidence. A
 * caller that needs "where is the POST handler of this route" reads them from
 * here; nothing in this file re-mints a location or restamps a provenance.
 *
 * Reads syntax only — the `SourceFile` was already loaded by `../project.ts` —
 * and touches no path and writes nothing.
 *
 * @param sourceFile The module, as loaded by `../project.ts`.
 * @param projectRelativeFile The module's **project-relative POSIX** path,
 * exactly as {@link ExtractorContext.file} spells it. An absolute path is
 * refused by the derivation rather than repaired.
 * @param options Where the route trees live, when a project keeps them
 * somewhere other than the conventional `app/`, `src/app/`, `pages/` and
 * `src/pages/`. Forwarded verbatim to {@link deriveRouteFromFile}.
 * @returns The complete entry, or `undefined` when the file serves no URL.
 *
 * @example
 * ```ts
 * const entry = routeEntryForFile(sourceFile, 'app/api/<segment>/route.ts');
 * entry?.methods; // ['GET', 'POST']
 * entry?.methodLocations?.POST?.line; // where the POST handler is declared
 * ```
 */
export function routeEntryForFile(
  sourceFile: SourceFile,
  projectRelativeFile: string,
  options?: DeriveRouteOptions,
): RouteEntry | undefined {
  const derived = deriveRouteFromFile(projectRelativeFile, options);
  if (derived === undefined) {
    return undefined;
  }

  // A kind outside the vocabulary this module has a node shape for is skipped
  // rather than guessed at. Unreachable through today's derivation, which
  // only ever reports a member of `API_ROUTE_KINDS`; see
  // ACCEPTED_ROUTE_KINDS for why it is checked anyway.
  if (!ACCEPTED_ROUTE_KINDS.includes(derived.kind)) {
    return undefined;
  }

  // Three module conventions, one call: `buildRouteEntry` dispatches on the
  // derived route rather than on anything read here.
  //
  // - App Router `route.*` — one export per method it answers
  //   (`export async function GET`, `export const POST = …`,
  //   `export { handler as PUT }`), several to a module, each located
  //   separately.
  // - Legacy Pages Router `pages/api/**` — one default-exported function
  //   dispatching on `req.method`, so the whole module is the route and its
  //   methods are the single dispatching value; a named method export is not
  //   a convention of this router and is not invented.
  // - `page.*` in either router — a document request, whose method set is
  //   what the route map reports for a page rather than an empty list.
  return buildRouteEntry(sourceFile, derived);
}

/* -------------------------------------------------------------------------------------------------
 * Node construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the single `api-route` node for one route entry.
 *
 * One node per route file, never one per method: a route is one thing that
 * answers a set of methods, `routeMapFromIndex` rebuilds one entry from one
 * node, and several nodes for one file would make the index-backed route map
 * disagree with the freshly built one.
 *
 * Field by field, and every choice is something a consumer depends on:
 *
 * - `name` is the route path, which is what `CodeNodeBase.name` prescribes for
 *   this kind and what a name search must find a route by.
 * - `file` is the entry's path — project-relative POSIX, normalised by the
 *   derivation — and never the absolute path on the `SourceFile`.
 * - `line`/`column`/`symbol`/`endLine` come from the entry's route-map
 *   `location`, unchanged, so that the location `routeMapFromIndex` rebuilds
 *   from this node equals the one `buildRouteMap` produced. For a multi-method
 *   App Router module that is the first handler declaration in source order;
 *   for a page or a legacy handler it is the default export; and for a module
 *   whose handler could not be located it is line 1, column 1.
 * - `symbol` is included whenever the location names one. It cannot collide
 *   with `name` — a route path starts with `/` and a declared symbol is an
 *   identifier — so `CodeNodeBase.symbol`'s "only when it differs from `name`"
 *   rule holds by construction.
 * - `exported` is `true`: a route module's handler is reachable by the
 *   framework by definition, which is the question that flag answers.
 * - `data` carries the four fields `ApiRouteNodeData` declares, taken from the
 *   entry rather than re-read, so a node's methods and a route map's methods
 *   cannot disagree.
 *
 * Optional fields are **omitted** rather than set to `undefined`: a
 * `CodeIndex` must round-trip through JSON unchanged, which a
 * present-but-undefined property does not.
 *
 * @param entry The complete route entry for the module.
 * @returns The node, deterministic for a given entry.
 */
function nodeFromEntry(entry: RouteEntry): CodeNodeOf<'api-route'> {
  const { location } = entry;
  const name = entry.routePath;

  return {
    id: makeNodeId({
      kind: 'api-route',
      file: entry.file,
      name,
      line: location.line,
      column: location.column,
    }),
    kind: 'api-route',
    name,
    file: entry.file,
    line: location.line,
    column: location.column,
    ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
    ...(location.symbol === undefined ? {} : { symbol: location.symbol }),
    exported: true,
    data: {
      routePath: entry.routePath,
      router: entry.router,
      kind: entry.kind,
      methods: entry.methods,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * The class name of a thrown value, for a diagnostic that has to say *what*
 * failed without quoting anything.
 *
 * An error's `message` is deliberately not used: a syntax error raised while
 * walking a module routinely embeds the offending source text, and a
 * diagnostic is persisted with a session, written to logs and can reach model
 * prompt context. A class name is a name.
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
 * The `extractor-failed` diagnostic for a module this extractor could not
 * read.
 *
 * Severity `error` because a part of the index is missing: the file's route
 * node is absent, so a query about that URL will report nothing rather than
 * something wrong. `extractorId` is stamped here rather than left to the
 * indexer so the finding is attributable even when a caller runs this
 * extractor directly.
 *
 * @param file The module, project-relative POSIX.
 * @param cause The value the failure threw.
 * @returns The diagnostic, carrying no source text.
 */
function extractorFailedDiagnostic(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `Reading route exports failed; this module contributes no api-route node (${describeCause(cause)}).`,
    file,
    extractorId: API_ROUTES_EXTRACTOR_ID,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `api-routes` extractor: one `api-route` node for a module that serves a
 * URL, and nothing at all for a module that does not.
 *
 * Synchronous, and pure with respect to the project and the machine: it reads
 * the abstract syntax tree of the one file it was handed, writes no file,
 * opens no socket, caches nothing, mutates no node and adds no source file to
 * the project. Its output is deterministic — one node, built from the route
 * entry — so two runs over unchanged source produce identical results, which
 * is what `../indexer.ts`'s reproducibility promise rests on.
 *
 * It never throws. A module that cannot be read becomes an `extractor-failed`
 * diagnostic and an empty node list, which is the same observable outcome as
 * an escaping throw with the run continuing — and every other file of the
 * project is indexed regardless.
 *
 * @example
 * ```ts
 * const result = apiRoutesExtractor.extract(ctx);
 * result.nodes[0]?.data.methods; // ['GET', 'POST']
 * result.edges.length; // 0 — this extractor emits no edges
 * ```
 */
export const apiRoutesExtractor: Extractor = Object.freeze({
  id: API_ROUTES_EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    try {
      const entry = routeEntryForFile(ctx.sourceFile, ctx.file);

      // Not a route module: a component, a service, a configuration file, an
      // App Router special file, a private folder's module. The derivation
      // owns that judgement and this is the whole of the response to it.
      if (entry === undefined) {
        return NO_ROUTE;
      }

      // Defence in depth on the one invariant every node field shares. The
      // derivation already refuses an absolute, drive-lettered or escaping
      // path, so this cannot fire today; were it ever to, the indexer would
      // drop the node anyway, and dropping it here keeps the reason
      // attributable to this extractor.
      if (!isSafeRelativePath(entry.file)) {
        ctx.logger.warn('Route module skipped: its path is not a safe project-relative path', {
          extractorId: API_ROUTES_EXTRACTOR_ID,
          file: entry.file,
        });

        return NO_ROUTE;
      }

      // A route module exporting no handler still serves its URL, so the node
      // is emitted with the empty method list `ApiRouteNodeData` prescribes
      // for it. The log line is the supplement; no diagnostic code in the
      // closed vocabulary belongs to an extractor's finding.
      if (entry.methods.length === 0) {
        ctx.logger.warn('Route module exports no request handler', {
          extractorId: API_ROUTES_EXTRACTOR_ID,
          file: entry.file,
          routePath: entry.routePath,
          router: entry.router,
          routeKind: entry.kind,
        });
      }

      return { nodes: [nodeFromEntry(entry)], edges: NO_EDGES };
    } catch (cause) {
      return {
        nodes: [],
        edges: NO_EDGES,
        diagnostics: [extractorFailedDiagnostic(ctx.file, cause)],
      };
    }
  },
});
