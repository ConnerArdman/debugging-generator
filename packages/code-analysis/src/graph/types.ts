/**
 * The single vocabulary of the code graph: every node kind, edge kind, payload,
 * index envelope, diagnostic, extractor contract and project-summary shape
 * `@debuggen/code-analysis` speaks.
 *
 * ## One definition, package-wide
 *
 * `../indexer.ts` builds the graph, `./graph.ts` holds it, `./query.ts`
 * traverses it, `../route-map.ts` derives routes from it, `../summary.ts`
 * summarises it, `../cache.ts` persists it, and all eight modules under
 * `../extractors/` produce pieces of it. Every one of them imports its
 * vocabulary from here, and **a second definition of any shape declared in this
 * module — anywhere in this package or anywhere else in the monorepo — is a
 * defect** (AAP 0.2.3, which puts the same single-definition discipline on
 * every type that crosses a boundary, and AAP 0.9.1, which lists the schema
 * sources). A copied node-kind list or a re-declared `CodeIndex` does not fail
 * loudly; it drifts, and a graph whose producer and consumer disagree about a
 * kind string mis-attributes evidence rather than rejecting it.
 *
 * ## Position in the module graph
 *
 * This module is the root of this package's internal graph and imports only:
 *
 * - `@debuggen/shared` — `SourceLocation` (the return type of a reference
 *   lookup) and `Logger` (the extractor's log sink), both type-only. It is the
 *   sole `@debuggen/*` dependency this package may have: `eslint.config.js`
 *   enforces that with `no-restricted-imports`, and `packages/instrumentation`
 *   and `apps/local-service` depend on *this* package, so an upward import
 *   would close a cycle (AAP 0.2.2).
 * - `ts-morph` — the `SourceFile` type an extractor is handed.
 * - `../project.js` — the `LoadedProject` handle, **type-only**, so no runtime
 *   edge is created. `../project.ts` imports nothing from `./`, which is what
 *   keeps the pair acyclic; keep it that way.
 *
 * It must never import `../route-map.js`, `./graph.js` or `./query.js`: all
 * three import this module. That is precisely why the router, route-kind and
 * HTTP-method vocabularies live here rather than beside the route derivation
 * that consumes them — the derivation algorithm belongs to `../route-map.ts`
 * (`RouteEntry`, `RouteMap`, `matchRoute`, `deriveRouteFromFile`), and none of
 * it is declared here.
 *
 * No schema library either: `zod` is deliberately not a dependency of this
 * package. What crosses a *process* boundary is validated where it crosses one
 * — `@debuggen/protocol` for messages, `@debuggen/shared` for a source location
 * — while a code index crosses only a *file* boundary, the JSON cache under
 * `$DEBUGGEN_HOME/index`, whose shape guard (`isCodeIndex`) belongs to
 * `../cache.ts`. This module therefore contributes exactly three narrow
 * membership predicates, {@link isCodeNodeKind}, {@link isCodeEdgeKind} and
 * {@link isIndexDiagnosticCode}, so that a corrupt cache entry can be pruned
 * of unknown kinds without every caller spelling the vocabulary again.
 *
 * ## What is runtime and what is not
 *
 * Everything here is a type except the frozen vocabulary tuples, the schema
 * version constant and those three predicates. No AST work, no filesystem
 * access, no graph traversal, no default export. Importing this module has no
 * side effect beyond freezing its own tables.
 *
 * ## The persisted envelope
 *
 * {@link CodeIndex} is the serialisable form of the whole graph: what
 * `../indexer.ts` returns, what `../cache.ts` writes and reads back, and what
 * `./graph.ts` and `../route-map.ts` reconstruct their in-memory views from.
 * Its determinism contract — project-relative paths, sorted file list, one
 * timestamp field that legitimately varies — is documented on the interface and
 * is what makes an index reproducible across runs and checkouts.
 */

import type { Logger, SourceLocation } from '@debuggen/shared';
import type { SourceFile } from 'ts-morph';

import type { LoadedProject } from '../project.js';

/* -------------------------------------------------------------------------------------------------
 * Kind vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every kind of thing the code graph can hold, as a closed readonly tuple.
 *
 * Eight members, in this order, and the order is part of the contract: it is
 * the order `../summary.ts` reports counts in and the order a reader of a
 * serialised index sees. The list is closed — an extractor that wants to
 * describe something new adds a member here, which makes the compiler demand a
 * payload interface, a place in the {@link CodeNode} union, a counter field on
 * {@link ProjectSummaryCounts} and a decision about every edge kind that could
 * touch it, rather than inventing a string at a call site.
 *
 * The members, and what an extractor produces one for:
 *
 * - `file` — one indexable module of the target project. The anchor of every
 *   other node: whatever else a node is, it was declared in a file.
 * - `symbol` — a named declaration: a function, class, variable, type,
 *   interface, enum, method or property.
 * - `component` — a React component. A `component` is *not* also emitted as a
 *   `symbol`; it is the more specific kind, and `./query.ts` looks for it by
 *   name through the same lookup either way.
 * - `handler` — an event handler bound in JSX, which is where a user
 *   interaction enters the application's own code.
 * - `api-call` — one call site that reaches the network (`fetch`, an
 *   `XMLHttpRequest`, a client wrapper around either). A call *site*, not a
 *   URL: see {@link ApiCallNodeData}.
 * - `api-route` — a server-side route module that answers requests.
 * - `server-function` — a function that runs on the server and is not itself a
 *   route: the service layer a route handler delegates to.
 * - `db-call` — one call site that reaches the database.
 *
 * Frozen: a read-only vocabulary shared by every module of this package.
 */
export const CODE_NODE_KINDS = Object.freeze([
  'file',
  'symbol',
  'component',
  'handler',
  'api-call',
  'api-route',
  'server-function',
  'db-call',
] as const);

/**
 * One member of the closed node vocabulary.
 *
 * Derived from {@link CODE_NODE_KINDS} so the runtime list and the static type
 * cannot disagree — the same convention `@debuggen/shared`'s error codes and
 * `@debuggen/telemetry`'s event kinds follow.
 */
export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];

/**
 * Widened view of {@link CODE_NODE_KINDS} used by {@link isCodeNodeKind}.
 *
 * The annotation is the whole point: it lets an arbitrary `string` be tested
 * for membership without asserting anything about the value under test, which
 * is what keeps the predicate honest at a trust boundary.
 */
const CODE_NODE_KIND_VALUES: readonly string[] = CODE_NODE_KINDS;

/**
 * Whether a value is a {@link CodeNodeKind}.
 *
 * A membership test and nothing more: it says that a string names a known kind,
 * never that the object it came from is a well-formed {@link CodeNode}. That
 * distinction is deliberate and the division of labour is fixed —
 * `../cache.ts` owns the structural guard for a deserialised index
 * (`isCodeIndex`) and `./graph.ts` owns construction-time validation, and both
 * reach for *this* predicate for the kind field so the vocabulary is spelled
 * once. It exists because a cache entry read back from `$DEBUGGEN_HOME/index`
 * is untrusted input: it may have been written by an older version of this
 * package, or hand-edited, and an entry naming a kind this version does not
 * know is dropped with an `unknown-node-kind` diagnostic rather than crashing
 * a traversal.
 *
 * Total: it never throws, and a non-string — `undefined`, a number, an object
 * with a `toString` — is simply `false`.
 *
 * @param value Any value, typically a field of freshly parsed JSON.
 * @returns `true` when `value` is one of {@link CODE_NODE_KINDS}, narrowing it
 * to {@link CodeNodeKind}.
 */
export function isCodeNodeKind(value: unknown): value is CodeNodeKind {
  return typeof value === 'string' && CODE_NODE_KIND_VALUES.includes(value);
}

/**
 * Every kind of relationship the code graph can hold, as a closed readonly
 * tuple of nine members.
 *
 * ## Canonical edge semantics
 *
 * This table is the traversability contract. `./query.ts`'s traversals
 * (`whoCalls`, `componentsRendering`, `pathBetween`) are defined over it, so an
 * extractor that emits an edge with different endpoint kinds than the ones
 * listed does not produce a slightly different graph — it produces one whose
 * paths silently do not resolve. `from` and `to` are always
 * {@link CodeNode.id} values, and the node kinds each edge kind may join are:
 *
 * | Kind         | From → To |
 * | ------------ | --------- |
 * | `imports`    | `file` → `file` |
 * | `exports`    | `file` → `symbol` \| `component` \| `file` |
 * | `declares`   | `file` → `symbol` \| `component` \| `handler` \| `server-function` \| `api-route` |
 * | `references` | `symbol` → `symbol` |
 * | `renders`    | `component` → `component` |
 * | `handles`    | `component` → `handler` |
 * | `calls`      | `symbol` \| `component` \| `handler` \| `server-function` \| `api-route` → `symbol` \| `server-function` \| `api-call` |
 * | `routes-to`  | `api-call` → `api-route` |
 * | `queries`    | `symbol` \| `server-function` → `db-call` |
 *
 * What each kind is emitted for, in the same order:
 *
 * - `imports` — a module specifier that resolves to another file **inside** the
 *   project, including a hop through a `paths` alias declared in the target
 *   project's configuration.
 * - `exports` — a local export and every re-export form (named, `default as`,
 *   type-only), targeting the exported declaration; a star re-export targets
 *   the re-exported **file** instead.
 * - `declares` — every declaration a file contains. The edge that makes "what
 *   is in this file" answerable without a second pass over the source.
 * - `references` — one identifier reference site. Emitted only where an
 *   extractor already has the resolution in hand; deepening a reference set on
 *   demand is {@link ReferenceResolver}'s job, not an indexing-time edge.
 * - `renders` — a JSX element usage of one component inside another.
 * - `handles` — the component that binds the handler, whether the handler is
 *   inline or a named reference.
 * - `calls` — a call expression. An `api-call` node **is** a call site, so the
 *   enclosing function `calls` it: that is the edge carrying "this handler is
 *   what issues the request".
 * - `routes-to` — a call's URL matched against the route map. Produced after
 *   both endpoints exist, which is why it is the one edge kind an extractor
 *   cannot emit on its own.
 * - `queries` — a call expression that reaches the database, from the function
 *   that contains it.
 *
 * ## Reachability invariant
 *
 * Downstream extractors must preserve one property beyond the table: an
 * `api-route` node must be **traversable to the server functions its exported
 * method handlers call**. Two shapes satisfy it — a `calls` edge straight from
 * the `api-route` node, or a `declares` hop to the exported method's `symbol`
 * node which then `calls` the server function — and both are acceptable
 * because `./query.ts`'s `pathBetween` traverses every edge kind by default
 * precisely so either resolves. What is *not* acceptable is a route whose
 * handlers' calls are recorded against no node at all: the end-to-end path
 * from a user interaction to a database call runs through exactly this hop, and
 * a break here is invisible until an investigation returns a route with no
 * downstream.
 *
 * ## What is not an edge
 *
 * An import of a module **outside** the project — a package, or a specifier
 * that resolves to nothing — has no `to` node to point at, because
 * {@link CODE_NODE_KINDS} is closed and holds no external-module kind. Those
 * specifiers are recorded on the importing file itself, in
 * {@link FileNodeData.externalImports}; see the note there for why an edge is
 * the wrong shape for them.
 *
 * Frozen: a read-only vocabulary shared by every module of this package.
 */
export const CODE_EDGE_KINDS = Object.freeze([
  'imports',
  'exports',
  'declares',
  'references',
  'renders',
  'handles',
  'calls',
  'routes-to',
  'queries',
] as const);

/**
 * One member of the closed edge vocabulary.
 *
 * Derived from {@link CODE_EDGE_KINDS}, whose documentation carries the
 * endpoint-kind table and the reachability invariant every producer of an edge
 * must satisfy.
 */
export type CodeEdgeKind = (typeof CODE_EDGE_KINDS)[number];

/**
 * Widened view of {@link CODE_EDGE_KINDS} used by {@link isCodeEdgeKind}.
 *
 * Annotated for the same reason {@link CODE_NODE_KIND_VALUES} is: membership of
 * an untrusted string is testable without asserting anything about it.
 */
const CODE_EDGE_KIND_VALUES: readonly string[] = CODE_EDGE_KINDS;

/**
 * Whether a value is a {@link CodeEdgeKind}.
 *
 * The edge counterpart of {@link isCodeNodeKind}, with the same contract: a
 * membership test, total, never throwing, and never a statement about the
 * well-formedness of a {@link CodeEdge}. `./graph.ts` asks it while
 * reconstructing a graph from a cached index and drops an entry it rejects with
 * an `unknown-edge-kind` diagnostic, which keeps a stale cache a degraded
 * input rather than a fatal one.
 *
 * @param value Any value, typically a field of freshly parsed JSON.
 * @returns `true` when `value` is one of {@link CODE_EDGE_KINDS}, narrowing it
 * to {@link CodeEdgeKind}.
 */
export function isCodeEdgeKind(value: unknown): value is CodeEdgeKind {
  return typeof value === 'string' && CODE_EDGE_KIND_VALUES.includes(value);
}

/**
 * The two router conventions a target project can place server-side modules
 * under.
 *
 * - `app` — the App Router: a directory tree whose `route.*` modules export one
 *   function per HTTP method and whose `page.*` modules render.
 * - `pages` — the legacy Pages Router: a directory tree whose API modules
 *   default-export a single request handler.
 *
 * Declared here rather than in `../route-map.ts` because that module imports
 * *this* one, so the union has to live below it (see the module note on
 * acyclicity). `../route-map.ts` owns the derivation; `../summary.ts` reports
 * it; {@link ApiRouteNodeData} and {@link ProjectSummaryRouteRef} carry it.
 *
 * Frozen: a read-only vocabulary.
 */
export const ROUTER_KINDS = Object.freeze(['app', 'pages'] as const);

/**
 * Which router convention a route module belongs to.
 *
 * Derived from {@link ROUTER_KINDS}. Worth carrying per route rather than per
 * project: a project may use both at once, which is what
 * {@link RouterStyle}'s `hybrid` member describes, and the two conventions
 * differ in how their methods are declared.
 */
export type RouterKind = (typeof ROUTER_KINDS)[number];

/**
 * What kind of module a route node was found in.
 *
 * - `route-handler` — a `route.*` module that exports request handlers.
 * - `page` — a `page.*` module that renders a document.
 *
 * Both are reachable by URL, which is why both are `api-route` nodes, and they
 * are distinguished because only the first answers a `fetch`: a `routes-to`
 * edge from an {@link ApiCallNodeData} call site should land on a
 * `route-handler`, and one that lands on a `page` is a signal worth surfacing
 * rather than hiding. Consumed by `../route-map.ts` and `../summary.ts`.
 *
 * Frozen: a read-only vocabulary.
 */
export const API_ROUTE_KINDS = Object.freeze(['route-handler', 'page'] as const);

/**
 * Whether a route node is a request handler module or a page module.
 *
 * Derived from {@link API_ROUTE_KINDS}.
 */
export type ApiRouteKind = (typeof API_ROUTE_KINDS)[number];

/**
 * The HTTP methods a route can declare, plus the wildcard `ANY`.
 *
 * The seven method names are the ones a route module may export a handler for.
 * **`ANY` is mandatory and is not an HTTP method**: it is what a route reports
 * when it serves *every* method through one entry point, which is exactly the
 * shape of a legacy Pages-Router API module — a single default-exported
 * function, with no per-method export to enumerate. A route-map consumer that
 * wants to know "does this route answer a `POST`?" therefore has to treat
 * `ANY` as a match for every method, and a route that declares `ANY` never also
 * lists individual methods.
 *
 * Order is declaration order, not significance: the tuple is a vocabulary, and
 * a route's own `methods` array is ordered by whatever `../route-map.ts`
 * derives, which for an App Router module is the order the handlers are
 * exported in.
 *
 * Frozen: a read-only vocabulary.
 */
export const HTTP_METHOD_NAMES = Object.freeze([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'ANY',
] as const);

/**
 * One HTTP method name a route can declare, or `ANY` for a single handler that
 * serves all of them.
 *
 * Derived from {@link HTTP_METHOD_NAMES}, whose documentation explains why
 * `ANY` is a member.
 */
export type HttpMethodName = (typeof HTTP_METHOD_NAMES)[number];

/**
 * The database access mechanisms this indexer recognises at a call site.
 *
 * - `prisma` — a generated client call, `prisma.<model>.<operation>(…)`.
 * - `pg` — a driver call, whether issued directly on a pool or on a client
 *   borrowed from one.
 *
 * This is the field the rest of the product reads out of the graph to decide
 * what to instrument: `packages/instrumentation`'s Prisma and Postgres adapter
 * detection asks which drivers a project actually calls before it requires the
 * dev-server preload for either, and `../summary.ts` folds the same field into
 * {@link DatabaseAccessInfo.style} for the problem-understanding stage
 * (AAP 0.7.1 Group 1). Neither consumer should re-derive it from source text.
 *
 * Frozen: a read-only vocabulary.
 */
export const DB_DRIVERS = Object.freeze(['prisma', 'pg'] as const);

/**
 * Which database mechanism a `db-call` node was produced for.
 *
 * Derived from {@link DB_DRIVERS}.
 */
export type DbDriver = (typeof DB_DRIVERS)[number];

/**
 * The version of the node and edge vocabulary a {@link CodeIndex} was built
 * against, stamped into {@link CodeIndex.schemaVersion}.
 *
 * **Distinct from `../cache.ts`'s `INDEX_CACHE_SCHEMA_VERSION`, and the two
 * must never be conflated.** They answer different questions and change for
 * different reasons:
 *
 * - *This* constant versions the **contents** of an index — the kind
 *   vocabularies, the node payloads, the edge semantics. Bump it when one of
 *   those changes shape, because an index whose `schemaVersion` is not this
 *   value may hold nodes this code cannot interpret.
 * - `INDEX_CACHE_SCHEMA_VERSION` versions the **on-disk cache entry** that
 *   wraps an index: its key derivation, its envelope fields, its file layout
 *   under `$DEBUGGEN_HOME/index`. Bump that one when the storage changes, even
 *   if the graph inside is unchanged.
 *
 * Either version being stale invalidates a cache entry, and each has to be
 * able to do so without the other moving. Typed as a literal (`as const`) so a
 * comparison against a wrong constant is a compile error rather than a
 * silently-always-false check.
 */
export const CODE_INDEX_SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------------------------------
 * Node vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The fields every {@link CodeNode} carries, whatever its kind.
 *
 * Location comes first among the invariants: a node without a usable
 * `file`/`line`/`column` cannot be turned into a
 * {@link SourceLocation}, and a runtime item that cannot be pointed back at
 * source is the one thing this package exists to prevent. All properties are
 * `readonly` — a node is a record of what the source said at index time, and
 * mutating one in place would desynchronise it from the id derived from it.
 */
export interface CodeNodeBase {
  /**
   * The node's identity within one index.
   *
   * **Opaque: consumers must never parse it.** It is produced by `./graph.ts`'s
   * `makeNodeId` from the node's kind, file, position and name, and its only
   * guarantees are the two that matter to a graph — it is unique within an
   * index, and it is stable for the same declaration across runs of the same
   * indexer version over unchanged source. That stability is what makes a
   * cached index reusable and `../indexer.ts`'s reproducibility assertion hold,
   * and it is why nodes are keyed on project-relative paths rather than
   * absolute ones (see {@link CodeNodeBase.file}).
   *
   * To learn something about a node, read its fields; to find a node, ask
   * `./graph.ts`. Anything that splits this string on a separator is coupled to
   * an implementation detail that is free to change.
   */
  readonly id: string;

  /**
   * Which kind of thing this node is, and the discriminant of the
   * {@link CodeNode} union.
   *
   * A `switch` on this field narrows {@link CodeNode} to exactly one member and
   * therefore narrows its `data` to that member's payload, which is how every
   * consumer reaches a per-kind field without a cast.
   */
  readonly kind: CodeNodeKind;

  /**
   * The name this node is known by, as written in the source.
   *
   * What it holds depends on the kind: a declared identifier for a `symbol`, a
   * component's name for a `component`, the project-relative path for a `file`,
   * the route path for an `api-route`, the event-handler name (or a derived
   * label for an inline handler) for a `handler`. It is what `./query.ts`'s
   * name lookups match against, so it is the source spelling and never a
   * prettified or lower-cased form.
   */
  readonly name: string;

  /**
   * The file this node was found in: **project-relative, POSIX separators**.
   *
   * `'src/components/Widget.tsx'`, never `'/home/dev/app/src/components/Widget.tsx'`
   * and never a backslash path. Two independent contracts depend on it, and
   * both are load-bearing:
   *
   * - **Portability and determinism.** `./graph.ts` derives {@link CodeNodeBase.id}
   *   from this value, so two checkouts of the same commit at different paths
   *   produce byte-identical nodes and a cached index stays valid when a project
   *   moves.
   * - **Safety.** It satisfies `isSafeRelativePath` from `@debuggen/shared`
   *   — no absolute or drive-letter path, no `..` segment, no backslash, no
   *   control character — which is the same check the `SourceLocation` schema
   *   applies, so a node's location can become a location a user interface
   *   opens without a second sanitisation.
   *
   * Produce it with {@link ExtractorContext.file} or
   * `LoadedProject.projectRelative`, never by reading a path off the abstract
   * syntax tree.
   */
  readonly file: string;

  /**
   * The **1-based** line the node starts on.
   *
   * 1-based on both axes, matching the `SourceLocation` contract in
   * `packages/shared/src/source-location.ts` and every producer that feeds it:
   * ts-morph diagnostics, a stack frame, a resolved source-map position. The
   * single conversion to an editor's 0-based position happens in the VS Code
   * extension, so nothing between here and there has to remember which
   * convention it is holding.
   */
  readonly line: number;

  /**
   * The **1-based** column the node starts at.
   *
   * 1-based for the same reason {@link CodeNodeBase.line} is. An extractor that
   * knows the line but not the column records `1` — the start of the line —
   * rather than `0`, which would be out of range for a source location.
   */
  readonly column: number;

  /**
   * The last line of the declaration, when the node spans more than one line.
   *
   * Optional, and at least {@link CodeNodeBase.line} when present. Absent means
   * "a point, or an end this extractor did not determine" — never "ends on line
   * zero". It is what lets an editor reveal a whole function or route handler
   * as a unit instead of a single line, and what
   * `packages/instrumentation`'s feasibility check reads to know the extent of
   * the body it would wrap.
   */
  readonly endLine?: number;

  /**
   * Whether the declaration is exported from its file.
   *
   * Optional because it is not meaningful for every kind — a `file` node has no
   * export status, and an inline handler cannot be exported. Where it is
   * meaningful it is decisive: `packages/instrumentation` can only reason about
   * a symbol another module can reach, and `../summary.ts` prefers exported
   * declarations when it has to choose which to report.
   */
  readonly exported?: boolean;

  /**
   * The enclosing or declared symbol name, when it differs from
   * {@link CodeNodeBase.name}.
   *
   * The field that keeps a call site attributable. An `api-call` or `db-call`
   * node is named for what it calls, but what a developer needs to see is the
   * function it happens *inside* — `'handleSubmit'` for a request issued from a
   * submit handler — and that name goes here. For a declaration whose name
   * already *is* its symbol, the field is absent rather than duplicated.
   * `../summary.ts` and the panel-facing source resolution both read it when
   * building a `SourceLocation.symbol`.
   */
  readonly symbol?: string;
}

/**
 * One module specifier a file imports that resolves **outside** the project, or
 * does not resolve at all.
 *
 * Recorded on the importing file — see {@link FileNodeData.externalImports} for
 * why this is a payload field rather than an edge.
 */
export interface ExternalImportRef {
  /**
   * The specifier exactly as written: `'react'`, `'node:fs'`,
   * `'@scope/package/sub'`.
   *
   * Unresolved and unnormalised, which is the point — it is the evidence that
   * the module was asked for, and its spelling is what a dependency lookup in
   * the target project's manifest matches against.
   */
  readonly specifier: string;

  /**
   * Whether the whole import declaration was type-only (`import type … from`).
   *
   * A type-only import vanishes at runtime, so it tells you what the code was
   * *compiled* against rather than what it *loads*. That distinction decides
   * whether a dependency is worth reporting as a runtime one: a project that
   * only imports a package's types is not a project that runs it.
   */
  readonly typeOnly: boolean;

  /**
   * The local names bound by the import, in source order.
   *
   * Named bindings are recorded under their imported name, a default import
   * under `'default'`, a namespace import under `'*'`. A side-effect-only
   * import (`import 'some/polyfill'`) binds nothing and the array is empty —
   * empty rather than absent, so a consumer can iterate without a guard.
   */
  readonly names: readonly string[];
}

/**
 * The payload of a `file` node.
 *
 * Optional on the node (see {@link CodeNode}): a file is worth a node for its
 * own sake, as the anchor of every `declares`, `imports` and `exports` edge,
 * and an extractor that has nothing to add about it may omit the payload
 * entirely.
 */
export interface FileNodeData {
  /**
   * The file's extension, including the leading dot: `'.ts'`, `'.tsx'`.
   *
   * Recorded so a consumer does not have to parse
   * {@link CodeNodeBase.file} to ask the questions that depend on it — whether
   * a module can contain JSX, whether it is TypeScript at all — and so the
   * answer is the one the indexer used when it decided the file was indexable.
   */
  readonly extension: string;

  /**
   * Whether the module carries a `"use client"` directive at the top of the
   * file.
   *
   * `true` means every component declared here is a client component, and it is
   * the only reliable static signal for that: a component is *not* a client
   * component because it uses a hook or a handler, it is one because its
   * module — or a module that imports it into the client graph — says so. The
   * **absence** of the directive is what classifies a server component, which
   * is why this is a boolean on the file rather than an inference per
   * declaration; {@link ComponentNodeData.isClient} is the per-component copy
   * of the same fact.
   */
  readonly isClientModule: boolean;

  /**
   * Every module specifier this file imports that does not resolve to another
   * file **in** the project.
   *
   * **This is where external and unresolved imports live, and an edge is not an
   * option.** The reasoning is worth stating because it is load-bearing:
   * {@link CODE_NODE_KINDS} is a closed eight-member list with no
   * external-module kind, and `./graph.ts` drops any edge whose endpoint node
   * is missing rather than inventing one. So an `imports` edge to a package —
   * or to a specifier that resolves to nothing, which is what a package
   * declared in the target project's manifest but never installed looks like to
   * the compiler — would be dropped on construction and the fact that the
   * import exists would be lost. Recorded here, it survives.
   *
   * That case is not hypothetical: a target project is indexed as the developer
   * left it, with whatever its `node_modules` does or does not contain, and the
   * indexing test corpus deliberately contains specifiers that cannot resolve
   * for exactly this reason. Extractors therefore read imports **abstract
   * syntax tree first**, from the specifier text, and never require type
   * resolution to record one — resolution is what decides whether a specifier
   * becomes an `imports` edge or an entry in this array, and failing to resolve
   * is an answer rather than an error.
   *
   * Ordered as the import declarations appear in the file, and deduplicated
   * only when the same specifier appears twice with identical bindings.
   */
  readonly externalImports: readonly ExternalImportRef[];
}

/**
 * The forms a `symbol` node's declaration can take.
 *
 * Nine members, `unknown` among them: an extractor that finds a named
 * declaration it cannot classify records the symbol with `unknown` rather than
 * dropping it, because a name in the graph with an imprecise kind is still a
 * name `./query.ts` can find, while a missing node is a hole in every path
 * through it.
 *
 * The distinctions earn their place by being acted on. `function` versus
 * `variable` decides whether a declaration is a candidate for the
 * function-timing patch in `packages/instrumentation` — a default-exported
 * component and an exported literal object are both "the default export" and
 * only one of them has a body to wrap. `type`, `interface` and `enum` mark
 * declarations that vanish at runtime, so no amount of instrumentation will
 * ever produce a span for them. `method` and `property` mark class members,
 * whose call sites resolve differently from a free function's.
 *
 * Frozen: a read-only vocabulary.
 */
export const SYMBOL_DECLARATION_KINDS = Object.freeze([
  'function',
  'class',
  'variable',
  'type',
  'interface',
  'enum',
  'method',
  'property',
  'unknown',
] as const);

/**
 * What form a `symbol` node's declaration takes.
 *
 * Derived from {@link SYMBOL_DECLARATION_KINDS}.
 */
export type SymbolDeclarationKind = (typeof SYMBOL_DECLARATION_KINDS)[number];

/**
 * The payload of a `symbol` node.
 *
 * Optional on the node (see {@link CodeNode}), so an extractor that records a
 * name and a position without classifying it produces a usable node; an
 * extractor that *can* classify it always should, because both fields are read
 * by downstream feasibility checks.
 */
export interface SymbolNodeData {
  /**
   * The form of the declaration. See {@link SYMBOL_DECLARATION_KINDS}.
   */
  readonly declaration: SymbolDeclarationKind;

  /**
   * Whether this symbol is the file's default export.
   *
   * Separate from {@link CodeNodeBase.exported}, which says only *that* the
   * declaration is exported. The distinction is what makes the legacy
   * Pages-Router API module tractable — its single default-exported function is
   * the whole route — and what tells a re-export extractor which binding a
   * `default as` form actually points at.
   */
  readonly isDefaultExport: boolean;

  /**
   * The named declarations this one is nested inside, outermost first.
   *
   * **Present ⇒ the declaration is nested inside another declaration**, and can
   * therefore not be imported by another module: the name exists only within
   * the enclosing body. That is the fact a planner needs, because a
   * `(file, symbol)` instrumentation action *can* address such a declaration —
   * the function-timing patcher resolves it at any depth — while nothing may
   * treat it as an export, and a bare name occurring in two nested scopes of one
   * file has to be qualified (`CheckoutForm.submitOrder`) to name one of them.
   *
   * Each entry is the name of one enclosing declaration — a function, a class, a
   * class member, or the variable or property a function was assigned to —
   * ordered outermost → innermost, so the last entry is the innermost *named*
   * declaration containing this one. An anonymous scope in between contributes
   * nothing, which is why `[]` is a meaningful value rather than a gap: the
   * declaration *is* nested, and nothing enclosing it has a name to report (a
   * function declared inside an anonymous callback).
   *
   * **Absent ⇒ module scope or a class member** — the two forms that are
   * reachable from outside their own body: a module-level declaration under its
   * own name, a class member through the class {@link CodeNodeBase.symbol}
   * names.
   */
  readonly enclosing?: readonly string[];
}

/**
 * The payload of a `component` node. **Required**, because a component is
 * only distinguishable from a plain symbol by what this payload says about it.
 */
export interface ComponentNodeData {
  /**
   * Whether this is a client component.
   *
   * `true` **only** when the declaring module carries a `"use client"`
   * directive; the directive's **absence** is what classifies a server
   * component. Nothing else promotes a component to the client — not a hook
   * call, not an event handler, not a browser global — because nothing else
   * does so in the framework either, and guessing here would put the whole
   * render-side investigation on a false premise. Copied from
   * {@link FileNodeData.isClientModule} so a consumer holding one component
   * does not have to fetch its file node to ask.
   */
  readonly isClient: boolean;

  /**
   * Whether the component is its file's default export.
   *
   * The common shape for a route-level or page-level component, and the one
   * where {@link CodeNodeBase.name} may have been derived from the declaration
   * rather than from an export name.
   */
  readonly isDefaultExport: boolean;

  /**
   * The name the component appears under in a React tree.
   *
   * Usually identical to {@link CodeNodeBase.name}, and deliberately stored
   * anyway: it is the value a runtime render event carries, so the join between
   * a captured render and a declaration in the graph is a comparison against
   * this field rather than a heuristic. Where a component is wrapped — memo,
   * forward-ref — the runtime display name can differ from the declared
   * identifier, and this is the side of the pair that matches the runtime.
   */
  readonly displayName: string;

  /**
   * The name of the module-level declaration this component **wraps**, when it
   * is a wrapper around a separately declared function.
   *
   * Present only for the referenced wrapper form — `const Widget =
   * memo(WidgetBody)`, where `WidgetBody` is a declaration of the same module
   * and therefore has a `component` node of its own — and absent for every
   * other component, including a wrapper around an inline function
   * (`memo(() => …)`, `memo(function Inner() {…})`), whose body has no separate
   * declaration to name.
   *
   * It exists because a memoised component is known by two names and a runtime
   * render event carries only one of them: the exported binding is what other
   * modules render and what a `renders` edge points at, while the
   * implementation is what React falls back to for a display name when the
   * wrapper carries no explicit one. Recording the link lets
   * `./query.ts`'s `componentsRendering` answer for either name, so the
   * `'code-graph'` resolution route reaches the declaration whichever half the
   * evidence names.
   */
  readonly implementation?: string | undefined;
}

/**
 * The payload of a `handler` node. **Required**: an event handler with no
 * event is not a handler.
 */
export interface HandlerNodeData {
  /**
   * The event name, **without** the `on` prefix: `'click'`, `'submit'`,
   * `'change'`.
   *
   * Normalised this way so that the graph speaks the same vocabulary as the
   * runtime evidence, where an interaction is recorded under the DOM event
   * name. The prefix is a property of the property name in the markup, not of
   * the event.
   */
  readonly event: string;

  /**
   * The element or component the handler is bound to, as written: an intrinsic
   * element's tag name, or a component's name.
   *
   * What makes a handler identifiable to a developer — and what a target
   * selected in the browser is matched against when an interaction has to be
   * traced back to the code that answers it.
   */
  readonly boundTo: string;

  /**
   * Whether the handler is an arrow function written directly in the markup
   * attribute.
   *
   * `true` for an inline function, which has **no named declaration to patch**:
   * `packages/instrumentation`'s feasibility check needs a named symbol to wrap
   * with timing, so an inline handler is reported as infeasible for
   * function-level timing and covered by the runtime interaction hook instead.
   * `false` for a reference to a named function, which is the case that check
   * cares about — and in that case {@link CodeNodeBase.symbol} names the
   * function to look for, *where this file declares it*. Where the reference
   * resolved to a parameter or to a destructured binding instead — a handler
   * handed down as a prop (`onClick={props.onSelect}`) — the field is absent,
   * because the function is declared in the caller and no `(file, symbol)`
   * action naming this file could reach it; the node still records the binding,
   * its event and its position.
   */
  readonly inline: boolean;
}

/**
 * The payload of an `api-call` node. **Required**: a call site with nothing
 * recorded about its target is not evidence.
 *
 * An `api-call` node is a **call site**, not a URL. Two call sites that request
 * the same literal path are two distinct nodes and must never be merged: the
 * whole point of the duplicate-request investigation is to tell one initiator
 * from another, and a graph that collapses them has thrown away the answer
 * before the analysis starts.
 */
export interface ApiCallNodeData {
  /**
   * The request path or URL, set **only** when the argument is a fully static
   * string literal: `'/api/items'`.
   *
   * Absent whenever any part of the target is computed — see
   * {@link ApiCallNodeData.dynamic}. Absent rather than partial, because a
   * half-known URL matched against the route map produces a confident wrong
   * answer, and `routes-to` edges are built from this field.
   */
  readonly url?: string;

  /**
   * Whether the target was built from something other than a single string
   * literal: a template literal, a concatenation, a variable, a call.
   *
   * `true` means {@link ApiCallNodeData.url} is absent and
   * {@link ApiCallNodeData.urlExpression} holds the source text instead. A
   * dynamic call site is still worth a node — it is where a request comes from,
   * and the runtime evidence will supply the URL the code could not — it just
   * cannot be matched to a route statically.
   */
  readonly dynamic: boolean;

  /**
   * The HTTP method, when it is statically determinable.
   *
   * A plain string rather than {@link HttpMethodName} on purpose: this is what
   * a call site *wrote*, which may be any string the request API accepts and
   * may be cased however the author cased it, while
   * {@link HttpMethodName} is the closed vocabulary a *route* declares. Absent
   * when the call relies on the default method or computes it.
   */
  readonly method?: string;

  /**
   * The raw source text of the target expression, **capped at 200
   * characters**, present only when {@link ApiCallNodeData.dynamic} is `true`.
   *
   * A human-readable hint for the investigation — "the path is built from a
   * base and an identifier" — never something to parse or match. The cap is a
   * hard one: this text reaches prompt context and a user interface, and an
   * unbounded slice of source is both a cost and a privacy risk
   * (AAP 0.5.2). Truncation is silent; a consumer must not assume the string
   * is syntactically complete.
   */
  readonly urlExpression?: string;
}

/**
 * The payload of an `api-route` node. **Required**: a route is defined by its
 * path, its router and the methods it answers.
 */
export interface ApiRouteNodeData {
  /**
   * The URL path this route answers, with the App Router's route groups removed
   * and dynamic segments preserved in their bracket form: `'/api/items'`,
   * `'/api/items/[id]'`.
   *
   * **`../route-map.ts` owns the derivation** — the group stripping, the
   * segment forms, the index conventions, the match against a request path —
   * and it imports these types from here. This module declares the field and
   * must not implement or duplicate any part of that algorithm; a second
   * derivation would be a second answer to "what path is this file", which is
   * the one question the route map exists to answer.
   */
  readonly routePath: string;

  /**
   * Which router convention the module belongs to. See {@link ROUTER_KINDS}.
   */
  readonly router: RouterKind;

  /**
   * Whether the module is a request-handler module or a page module. See
   * {@link API_ROUTE_KINDS}.
   */
  readonly kind: ApiRouteKind;

  /**
   * The methods this route answers.
   *
   * For an App Router handler module, one member per exported method handler,
   * in export order. For a legacy Pages-Router API module, exactly
   * `['ANY']` — a single default-exported function serves every method and
   * there is nothing per-method to enumerate. A consumer asking whether a route
   * answers a given method must therefore treat `ANY` as matching all of them
   * (see {@link HTTP_METHOD_NAMES}).
   *
   * Empty only for a route module that exports no handler at all, which is a
   * finding rather than a normal state.
   */
  readonly methods: readonly HttpMethodName[];
}

/**
 * The payload of a `server-function` node. **Required**.
 *
 * A `server-function` is a function that runs on the server and is not itself a
 * route: the service layer a route handler delegates to, and the tier where the
 * time in a slow multi-tier interaction usually turns out to be spent. These
 * are the named symbols an instrumentation plan proposes function-level timing
 * for, which is why both fields below are about whether that is possible.
 */
export interface ServerFunctionNodeData {
  /**
   * Whether the function is declared `async`.
   *
   * Decides how a timing wrapper must end its span: a synchronous function ends
   * on return, an async one on settle. A wrapper that guesses wrong reports the
   * time to *start* the work instead of the time to finish it, which on this
   * tier is the difference between a millisecond and the whole latency being
   * investigated.
   */
  readonly isAsync: boolean;

  /**
   * Whether the function is exported from its module.
   *
   * Duplicated from {@link CodeNodeBase.exported} for this kind because it is
   * decisive here rather than incidental: a route handler can only call what
   * its module can import, so an unexported function is reachable only from
   * within its own file, and an investigation that proposes it as the boundary
   * between two tiers is proposing something that cannot be one.
   */
  readonly exported: boolean;
}

/**
 * The payload of a `db-call` node. **Required**: the driver is what makes the
 * call a database call.
 *
 * Both recognised call shapes for the driver mechanism produce
 * `driver: 'pg'` — a query issued directly on a pool, and a query issued on a
 * client borrowed from a pool and released afterwards. They are the same access
 * from the graph's point of view, and treating the borrowed-client form as
 * something else would leave exactly the queries a developer hand-wrote for
 * transactional work outside the analysis.
 */
export interface DbCallNodeData {
  /**
   * Which mechanism the call goes through. See {@link DB_DRIVERS}.
   */
  readonly driver: DbDriver;

  /**
   * The model the call targets, for `driver: 'prisma'`: the `<model>` of a
   * `prisma.<model>.<operation>(…)` call.
   *
   * Usually absent for `driver: 'pg'`, where the statement names its own
   * tables and no model layer is involved.
   */
  readonly model?: string;

  /**
   * The operation the call performs, for `driver: 'prisma'`: the
   * `<operation>` of a `prisma.<model>.<operation>(…)` call.
   *
   * Usually absent for `driver: 'pg'`. Pairs with
   * {@link DbCallNodeData.model} to make a call site comparable with the
   * runtime database span it produces.
   */
  readonly operation?: string;

  /**
   * The shape of the statement **as written in source**, for
   * `driver: 'pg'`: parameter placeholders preserved, every inline literal
   * replaced by `?`, and the whole string **capped at 512 characters**.
   *
   * Three constraints on this field, each for its own reason:
   *
   * - **It is static source text, not a runtime statement.** It is what the
   *   code contains, never what was executed, and it is therefore never
   *   evidence about a request. Runtime statements arrive as telemetry, already
   *   redacted by their own layer.
   * - **It must never carry credentials or a connection string.** Placeholders
   *   stay, literals go. That is the same rule the redaction layer applies to a
   *   runtime statement (AAP 0.5.2), applied here because this text reaches
   *   prompt context and a user interface, and a secret pasted into a query
   *   string in a developer's project must not be the thing that leaves the
   *   machine.
   * - **Row contents are never represented here, in any form.** Nothing in this
   *   payload describes data: a `db-call` node says a query exists and what it
   *   looks like, and nothing about what it returns.
   *
   * The cap is hard and truncation is silent, so a consumer must not assume the
   * text is a complete statement.
   */
  readonly statementShape?: string;

  /**
   * Whether the statement is built from a non-literal expression — a template
   * with substitutions, a concatenation, a variable, a helper call.
   *
   * `true` means {@link DbCallNodeData.statementShape} holds at best a partial
   * picture, so a consumer must not treat it as the statement. The node is
   * still worth having: a dynamically built query is a call site like any
   * other, and often the more interesting one.
   */
  readonly dynamic: boolean;
}

/**
 * One node of the code graph: {@link CodeNodeBase} plus the payload its kind
 * calls for, as a union discriminated on `kind`.
 *
 * A `switch (node.kind)` narrows `node.data` to exactly the matching payload,
 * with no cast and no optional chaining on the wrong type — the property
 * `types.test.ts` pins at compile time, and the reason the union is spelled out
 * per kind rather than declared as one interface with a union-typed `data`.
 *
 * `data` is **required** for `component`, `handler`, `api-call`, `api-route`,
 * `server-function` and `db-call`: each of those kinds is defined by what its
 * payload says, and a node of one of them without a payload carries no
 * information its kind promised. `data` is **optional** for `file` and
 * `symbol`, the two structural kinds: a file is worth a node as the anchor of
 * its edges, and a symbol is worth one as a name at a position, whether or not
 * an extractor had more to add.
 *
 * Use {@link CodeNodeOf} to name one member by its kind.
 *
 * @example
 * ```ts
 * function describe(node: CodeNode): string {
 *   switch (node.kind) {
 *     case 'component':
 *       return node.data.isClient ? 'client component' : 'server component';
 *     case 'api-route':
 *       return `${node.data.methods.join(', ')} ${node.data.routePath}`;
 *     case 'file':
 *       return node.data?.extension ?? 'file';
 *     default:
 *       return node.kind;
 *   }
 * }
 * ```
 */
export type CodeNode =
  | (CodeNodeBase & { readonly kind: 'file'; readonly data?: FileNodeData })
  | (CodeNodeBase & { readonly kind: 'symbol'; readonly data?: SymbolNodeData })
  | (CodeNodeBase & { readonly kind: 'component'; readonly data: ComponentNodeData })
  | (CodeNodeBase & { readonly kind: 'handler'; readonly data: HandlerNodeData })
  | (CodeNodeBase & { readonly kind: 'api-call'; readonly data: ApiCallNodeData })
  | (CodeNodeBase & { readonly kind: 'api-route'; readonly data: ApiRouteNodeData })
  | (CodeNodeBase & { readonly kind: 'server-function'; readonly data: ServerFunctionNodeData })
  | (CodeNodeBase & { readonly kind: 'db-call'; readonly data: DbCallNodeData });

/**
 * The {@link CodeNode} member for one kind.
 *
 * The way a per-kind result is typed without a cast: `./graph.ts`'s
 * `nodesByKind` returns `readonly CodeNodeOf<K>[]`, and `./query.ts`'s
 * kind-specific lookups do the same, so a caller that asked for components gets
 * nodes whose `data` is a {@link ComponentNodeData} — statically, not by
 * assertion. Passing the kind union itself yields {@link CodeNode} again, which
 * is the correct answer for "any kind".
 *
 * @typeParam K The node kind, or a union of kinds, to extract.
 *
 * @example
 * ```ts
 * type RouteNode = CodeNodeOf<'api-route'>;
 * const methods: readonly HttpMethodName[] = routeNode.data.methods;
 * ```
 */
export type CodeNodeOf<K extends CodeNodeKind> = Extract<CodeNode, { kind: K }>;

/* -------------------------------------------------------------------------------------------------
 * Edge vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * One directed relationship between two nodes of the code graph.
 *
 * The endpoint kinds each {@link CodeEdgeKind} may join, and the reachability
 * invariant every producer must preserve, are documented as a table on
 * {@link CODE_EDGE_KINDS}. Read that before emitting an edge: an edge with
 * unexpected endpoints does not make the graph slightly different, it makes
 * `./query.ts`'s paths stop resolving.
 *
 * One interface serves all nine kinds rather than a discriminated union,
 * because an edge is a relation and not a record: nothing varies by kind except
 * which optional provenance fields are meaningful, and a traversal reads
 * `from`, `to` and `kind` and nothing else. All properties are `readonly`.
 */
export interface CodeEdge {
  /**
   * The edge's identity within one index.
   *
   * **Opaque, like {@link CodeNodeBase.id}: consumers must never parse it.**
   * Derived by `./graph.ts` from the edge's kind, endpoints and site, unique
   * within an index and stable across runs over unchanged source. Its purpose
   * is deduplication and diagnostics — `duplicate-edge-id` is reported against
   * it — not description.
   */
  readonly id: string;

  /**
   * Which relationship this edge expresses. See {@link CODE_EDGE_KINDS} for the
   * endpoint kinds it implies.
   */
  readonly kind: CodeEdgeKind;

  /**
   * The {@link CodeNodeBase.id} of the node the relationship starts at.
   *
   * Direction is meaningful for every kind and never reversible by a consumer:
   * `whoCalls` is a search backwards along `calls`, which only works because
   * `from` is reliably the caller.
   */
  readonly from: string;

  /**
   * The {@link CodeNodeBase.id} of the node the relationship points at.
   *
   * Must name a node present in the same index. `./graph.ts` **drops** an edge
   * whose endpoint is missing and reports a `dangling-edge` diagnostic rather
   * than keeping a half-connected relation, which is why an import that
   * resolves outside the project is recorded in
   * {@link FileNodeData.externalImports} instead of as an edge.
   */
  readonly to: string;

  /**
   * The file the **edge site** is in: project-relative POSIX, like
   * {@link CodeNodeBase.file}.
   *
   * The site is where the relationship is written — the import statement, the
   * call expression, the markup element — which is not always either endpoint's
   * own file, and is the position a developer wants to be taken to when they
   * ask why two things are connected. Optional because a derived edge has no
   * site: a `routes-to` edge is computed from a call node and a route node
   * rather than read off a line of source.
   */
  readonly file?: string;

  /**
   * The **1-based** line of the edge site, on the same convention as
   * {@link CodeNodeBase.line}.
   *
   * Present when {@link CodeEdge.file} is.
   */
  readonly line?: number;

  /**
   * The **1-based** column of the edge site, on the same convention as
   * {@link CodeNodeBase.column}.
   *
   * Present when {@link CodeEdge.file} is.
   */
  readonly column?: number;

  /**
   * The raw module-specifier text, meaningful **only** for `imports` and
   * `exports` edges.
   *
   * `'./widget.js'`, `'../lib/client.js'`, `'@/lib/client'` — as written,
   * before resolution, so an aliased import keeps the evidence of the alias
   * that a resolved path would erase. It lives on the edge so that the
   * extractors need no second shape to record provenance with: the resolved
   * endpoint is in {@link CodeEdge.to}, and what the author actually typed is
   * here. Absent on every other kind, and a consumer must not infer anything
   * from its absence on those.
   */
  readonly specifier?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Index envelope and diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * What an indexed file looked like when it was read.
 *
 * The unit of cache invalidation. `../cache.ts` folds the whole list of these
 * into its cache key — order-insensitively, so a re-ordered file list is not a
 * different project — and compares `mtimeMs` and `size` per file to decide
 * whether a stored index still describes the tree on disk. Those two fields are
 * therefore the ones that matter: they are cheap to collect for every file in a
 * project, and together they catch the edits a developer actually makes.
 */
export interface FileFingerprint {
  /**
   * The file, project-relative POSIX, exactly as {@link CodeNodeBase.file}
   * spells it.
   *
   * The list in a {@link CodeIndex} is **sorted ascending by this field**, with
   * a byte-wise comparison rather than a locale-aware one, so the serialised
   * index is identical on every machine.
   */
  readonly file: string;

  /**
   * The file's last-modification time in **epoch milliseconds**, as the
   * filesystem reported it.
   *
   * Epoch milliseconds throughout the product (the base
   * `@debuggen/shared` time convention), so a fingerprint can be compared with
   * any other timestamp in an index without a unit conversion. Fractional
   * values are kept as the platform gives them rather than truncated: a
   * truncated millisecond is a real edit a cache could miss.
   */
  readonly mtimeMs: number;

  /**
   * The file's size in bytes.
   *
   * The second half of the invalidation pair, and the half that catches the
   * edit a preserved modification time would hide — a checkout, a restore from
   * a backup, a tool that writes with a fixed timestamp.
   */
  readonly size: number;

  /**
   * A content hash of the file, when one was computed.
   *
   * Optional because hashing every file of a large project costs real time and
   * the `mtimeMs`/`size` pair already answers the question for ordinary
   * editing. Where it is present it is decisive — content equality rather than
   * metadata equality — so a consumer that finds it should prefer it, and one
   * that does not must fall back to the pair rather than treating the entry as
   * unverifiable.
   */
  readonly hash?: string;
}

/**
 * How serious a finding from an indexing run is.
 *
 * - `info` — worth recording, nothing to act on: a file deliberately skipped
 *   because it is not indexable.
 * - `warning` — the index is usable but incomplete in a way that can change a
 *   result: an unresolved import, a limit reached, an entry dropped from a
 *   stale cache.
 * - `error` — a part of the index is missing: an extractor threw, so whatever
 *   it would have contributed is absent.
 *
 * No severity aborts an index. A partial graph is the useful outcome —
 * AAP 0.5.5's graceful-failure rule applied to indexing — and these are how it
 * says what it is missing rather than pretending to be complete.
 *
 * Frozen: a read-only vocabulary.
 */
export const INDEX_DIAGNOSTIC_SEVERITIES = Object.freeze(['info', 'warning', 'error'] as const);

/**
 * How serious an {@link IndexDiagnostic} is.
 *
 * Derived from {@link INDEX_DIAGNOSTIC_SEVERITIES}.
 */
export type IndexDiagnosticSeverity = (typeof INDEX_DIAGNOSTIC_SEVERITIES)[number];

/**
 * Every finding an indexing run can report, as a closed readonly tuple, each
 * with exactly one emitter.
 *
 * Naming the emitter is what makes a diagnostic actionable, so the assignment
 * is part of the contract:
 *
 * - `extractor-failed` — `../indexer.ts`, when an extractor throws. The
 *   extractor's contribution for that file is dropped, its
 *   {@link IndexDiagnostic.extractorId} is recorded, and **the run continues**:
 *   the remaining extractors and files are indexed and the resulting graph
 *   stays usable, which is the behaviour the indexer's own test asserts.
 * - `duplicate-node-id` — `./graph.ts`, during construction, when two nodes
 *   claim one id. The first is kept.
 * - `duplicate-edge-id` — `./graph.ts`, likewise for edges.
 * - `dangling-edge` — `./graph.ts`, when an edge names an endpoint no node in
 *   the index provides. The edge is dropped (see {@link CodeEdge.to}).
 * - `unknown-node-kind` — `./graph.ts`, when an entry's kind fails
 *   {@link isCodeNodeKind}, which is what a cache entry written by a different
 *   vocabulary version looks like. The node is dropped.
 * - `unknown-edge-kind` — `./graph.ts`, likewise via {@link isCodeEdgeKind}.
 * - `unresolved-import` — the import extractor, when a specifier resolves
 *   neither to a project file nor to a package. The specifier is recorded in
 *   {@link FileNodeData.externalImports} regardless; this says the graph has no
 *   edge for it.
 * - `file-skipped` — `../indexer.ts`, when a file in the project was not
 *   indexed: unreadable, or excluded by the project loader's rules.
 * - `limit-reached` — `../indexer.ts`, when a bound was hit and collection
 *   stopped early. The index is truncated, and a consumer that presents counts
 *   should say so.
 *
 * ## Privacy constraint
 *
 * **A diagnostic's `message` and `detail` must never embed raw source text,
 * environment values or secret-shaped strings.** They surface in logs, they are
 * persisted with a session, and they can reach model prompt context
 * (AAP 0.5.2) — a diagnostic is the one part of an index nobody thinks of as
 * data, which is exactly why a leak here would go unnoticed. Name the file, the
 * extractor, the symbol and the limit; quote nothing.
 *
 * Frozen: a read-only vocabulary.
 */
export const INDEX_DIAGNOSTIC_CODES = Object.freeze([
  'extractor-failed',
  'duplicate-node-id',
  'duplicate-edge-id',
  'dangling-edge',
  'unknown-node-kind',
  'unknown-edge-kind',
  'unresolved-import',
  'file-skipped',
  'limit-reached',
] as const);

/**
 * Which finding an {@link IndexDiagnostic} reports.
 *
 * Derived from {@link INDEX_DIAGNOSTIC_CODES}, whose documentation names the
 * emitter of each code and the privacy constraint on the accompanying text.
 */
export type IndexDiagnosticCode = (typeof INDEX_DIAGNOSTIC_CODES)[number];

/**
 * Widened view of {@link INDEX_DIAGNOSTIC_CODES} used by
 * {@link isIndexDiagnosticCode}.
 *
 * Annotated for the same reason {@link CODE_NODE_KIND_VALUES} is.
 */
const INDEX_DIAGNOSTIC_CODE_VALUES: readonly string[] = INDEX_DIAGNOSTIC_CODES;

/**
 * Whether a value is an {@link IndexDiagnosticCode}.
 *
 * The third and last membership predicate in this module, and it exists for the
 * same reason as the other two: diagnostics travel inside a cached index, so a
 * code read back from `$DEBUGGEN_HOME/index` is untrusted input that
 * `../cache.ts` checks before it keeps the entry. Total; a non-string is
 * `false`.
 *
 * @param value Any value, typically a field of freshly parsed JSON.
 * @returns `true` when `value` is one of {@link INDEX_DIAGNOSTIC_CODES},
 * narrowing it to {@link IndexDiagnosticCode}.
 */
export function isIndexDiagnosticCode(value: unknown): value is IndexDiagnosticCode {
  return typeof value === 'string' && INDEX_DIAGNOSTIC_CODE_VALUES.includes(value);
}

/**
 * One finding from an indexing run.
 *
 * Carried on the index itself ({@link CodeIndex.diagnostics}) and returned by an
 * extractor ({@link ExtractorResult.diagnostics}), so that "the index is
 * incomplete, and here is how" is a value rather than a log line nobody reads.
 *
 * Re-read the privacy constraint on {@link INDEX_DIAGNOSTIC_CODES} before
 * writing either text field.
 */
export interface IndexDiagnostic {
  /**
   * How serious the finding is. See {@link INDEX_DIAGNOSTIC_SEVERITIES}.
   */
  readonly severity: IndexDiagnosticSeverity;

  /**
   * Which finding this is. See {@link INDEX_DIAGNOSTIC_CODES}, which also names
   * the module that emits each code.
   */
  readonly code: IndexDiagnosticCode;

  /**
   * A short developer-facing sentence describing the finding.
   *
   * **No raw source text, no environment value, no secret-shaped string** — see
   * the privacy note on {@link INDEX_DIAGNOSTIC_CODES}. Names of files,
   * extractors, symbols and limits are the material this field is built from.
   */
  readonly message: string;

  /**
   * The file the finding concerns, project-relative POSIX.
   *
   * Absent for a finding about the run as a whole rather than about one file.
   */
  readonly file?: string;

  /**
   * The {@link Extractor.id} of the extractor the finding concerns.
   *
   * Present on `extractor-failed`, which is what makes a failure attributable
   * to one extractor instead of to indexing in general. Absent for findings
   * raised by `./graph.ts` construction or by the indexer itself.
   */
  readonly extractorId?: string;

  /**
   * Additional detail, when there is more to say than
   * {@link IndexDiagnostic.message} carries.
   *
   * Under the same constraint as `message`, and for the same reason: a stack
   * frame's function names are acceptable, a slice of the developer's source is
   * not.
   */
  readonly detail?: string;
}

/**
 * A complete code index: the serialisable form of the whole graph.
 *
 * This is the envelope `../indexer.ts` produces, `../cache.ts` persists under
 * `$DEBUGGEN_HOME/index` and reads back, `./graph.ts`'s `fromIndex`
 * reconstructs its in-memory view from, and `../route-map.ts`'s
 * `routeMapFromIndex` derives routes from. Four contracts hold for it, and each
 * one is depended upon somewhere:
 *
 * ## It is plain JSON
 *
 * No `Date`, no `Map`, no `Set`, no class instance, no function, and no
 * property whose `undefined` value has to survive a round trip, anywhere in the
 * envelope or in any node, edge, fingerprint or diagnostic it holds. Every
 * optional field means "absent or a value" and never "present and undefined",
 * which is why timestamps are numbers and vocabularies are string literals.
 * `JSON.parse(JSON.stringify(index))` must be indistinguishable from `index`.
 *
 * ## Only one path in it is absolute
 *
 * {@link CodeIndex.projectRoot}. Every other path — every node's `file`, every
 * edge's `file`, every fingerprint's `file`, every diagnostic's `file` — is
 * project-relative POSIX. That is what makes an index **portable** (it stays
 * valid when a project is checked out somewhere else) and node ids **stable
 * across checkouts** (they are derived from those relative paths), and it is
 * what keeps a developer's directory layout out of prompts and user interfaces.
 *
 * ## It is deterministic except for one field
 *
 * Two runs of the same indexer version over an unchanged project produce
 * identical `nodes`, `edges` and `files` — same contents, same order, same ids.
 * {@link CodeIndex.generatedAt} is **the only field that legitimately differs**
 * between them. The indexer's reproducibility assertion is therefore defined
 * over those three arrays, and a caller that needs byte-for-byte equality of
 * the whole envelope must inject or normalise the timestamp rather than expect
 * it to match.
 *
 * ## Its versions are checked before its contents are trusted
 *
 * {@link CodeIndex.schemaVersion} equals {@link CODE_INDEX_SCHEMA_VERSION} for
 * an index this code produced. A different value means the vocabulary has moved
 * and the entry must be rebuilt rather than interpreted.
 */
export interface CodeIndex {
  /**
   * The vocabulary version this index was built against.
   *
   * {@link CODE_INDEX_SCHEMA_VERSION} for an index produced by this code.
   * Typed `number` rather than the literal because a *read* index may
   * legitimately carry an older value — that is the whole point of checking it
   * — and a literal type would make the comparison that detects it impossible
   * to write.
   */
  readonly schemaVersion: number;

  /**
   * The indexed project's root: **absolute POSIX, no trailing separator**, as
   * `LoadedProject.projectRoot` normalised it.
   *
   * The one absolute path in the envelope, and the anchor every relative `file`
   * is resolved against. Take it from the loaded project rather than from the
   * string a caller supplied, which may name the same directory differently.
   */
  readonly projectRoot: string;

  /**
   * The version of the indexer that produced this index.
   *
   * Recorded so a cache entry can be invalidated when the extraction logic
   * changes without the vocabulary changing — a new extractor, a fixed
   * classification — which is a case {@link CodeIndex.schemaVersion} must not
   * be bumped for, because the *shapes* are unchanged.
   */
  readonly indexerVersion: string;

  /**
   * When the index was built, in **epoch milliseconds**.
   *
   * The product's canonical time base (`nowEpochMs` in
   * `packages/shared/src/time.ts` is what upstream should call), and the single
   * field that varies between two runs over an unchanged project — see the
   * determinism contract above.
   */
  readonly generatedAt: number;

  /**
   * Every node, in the deterministic order the indexer emitted them.
   */
  readonly nodes: readonly CodeNode[];

  /**
   * Every edge, in the deterministic order the indexer emitted them.
   *
   * An edge whose `from` or `to` names a node absent from
   * {@link CodeIndex.nodes} is dropped by `./graph.ts` with a `dangling-edge`
   * diagnostic, so a producer that filters nodes must filter their edges too.
   */
  readonly edges: readonly CodeEdge[];

  /**
   * The fingerprint of every file that was read, **sorted ascending by
   * {@link FileFingerprint.file}**.
   *
   * The cache's invalidation input, and the record of what the index covers: a
   * file absent from this list was not indexed, whatever the reason, and a
   * `file-skipped` diagnostic says which reason.
   */
  readonly files: readonly FileFingerprint[];

  /**
   * Findings from the run, when there were any.
   *
   * Optional and absent — rather than an empty array — for a clean run, which
   * keeps a serialised clean index minimal. A consumer reads it as
   * "`diagnostics ?? []`" and never treats its absence as a guarantee of
   * completeness on its own: {@link CodeIndex.files} is what says what was
   * covered.
   */
  readonly diagnostics?: readonly IndexDiagnostic[];
}

/* -------------------------------------------------------------------------------------------------
 * Extractor contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything one extractor is given for one file.
 *
 * `../indexer.ts` builds a context per file and hands the same object to every
 * registered extractor, which is what keeps the eight extractors under
 * `../extractors/` independent of each other and of how the project was opened.
 */
export interface ExtractorContext {
  /**
   * The opened project: the abstract syntax tree, the type checker and module
   * resolution.
   *
   * `../project.ts` is the **only** place a ts-morph `Project` is constructed —
   * it owns the configuration discovery, the file-set bounds and the exclusion
   * rules, including never reading environment files — so an extractor that
   * needs to resolve a specifier or consult the checker uses this handle rather
   * than building a project of its own. Iterate
   * `LoadedProject.sourceFiles()` and not the raw compiler view; the former is
   * the bounded, deterministically ordered set the index is defined over.
   */
  readonly loaded: LoadedProject;

  /**
   * The file currently being visited.
   *
   * One extractor call is scoped to one source file. An extractor may read
   * anything reachable from it, and may resolve into another file through
   * {@link ExtractorContext.loaded}, but it emits nodes for what it found *from
   * here* — the indexer visits every file, so a relation recorded twice from
   * both ends is a duplicate rather than thoroughness.
   */
  readonly sourceFile: SourceFile;

  /**
   * The project-relative POSIX path of {@link ExtractorContext.sourceFile}.
   *
   * **Use this for every node's and edge's `file` field — never
   * `sourceFile.getFilePath()`**, which is absolute and host-specific and would
   * break both the safety refinement on a source location and the determinism
   * of node ids (see {@link CodeNodeBase.file}). The indexer has already
   * computed it through `LoadedProject.projectRelative`, so taking it from here
   * is also the cheaper path.
   */
  readonly file: string;

  /**
   * The project root, absolute POSIX, identical to
   * `LoadedProject.projectRoot` and to {@link CodeIndex.projectRoot}.
   *
   * Supplied directly because an extractor that needs to relativise a path it
   * resolved elsewhere needs the root, and reaching through the loaded project
   * for a field this common is noise.
   */
  readonly projectRoot: string;

  /**
   * The message-first logger from `@debuggen/shared`, scoped by the indexer.
   *
   * For an observation worth a log line but not worth a diagnostic. A finding
   * that changes what the index contains belongs in
   * {@link ExtractorResult.diagnostics} instead, where a user interface can see
   * it — a log line is invisible to the developer being helped. The same
   * privacy constraint applies to both (see {@link INDEX_DIAGNOSTIC_CODES}):
   * fields and messages name things, they do not quote source.
   */
  readonly logger: Logger;
}

/**
 * What one extractor produces for one file.
 *
 * Additive by construction: the indexer concatenates every extractor's result
 * in registration order and lets `./graph.ts` deduplicate and validate. An
 * extractor therefore never needs to know what another extractor emitted, and
 * never removes or rewrites anything.
 */
export interface ExtractorResult {
  /**
   * The nodes found, in a deterministic order — source order is the natural
   * one, and determinism here is what makes an index reproducible.
   *
   * Empty rather than absent when nothing was found, so the indexer can
   * concatenate without a guard.
   */
  readonly nodes: readonly CodeNode[];

  /**
   * The edges found, in a deterministic order.
   *
   * An edge may name a node another extractor emits — that is normal and is why
   * validation happens once, at construction, over the merged set — but an edge
   * whose endpoint no extractor emits is dropped (see {@link CodeEdge.to}).
   */
  readonly edges: readonly CodeEdge[];

  /**
   * Findings worth surfacing, when there are any.
   *
   * Absent rather than empty for a clean extraction. The indexer merges these
   * into {@link CodeIndex.diagnostics}, stamping
   * {@link IndexDiagnostic.extractorId} where the extractor did not.
   */
  readonly diagnostics?: readonly IndexDiagnostic[];
}

/**
 * One unit of extraction: a named, synchronous, side-effect-free function from
 * a file to graph fragments.
 *
 * All eight modules under `../extractors/` implement this and nothing else,
 * which is what makes the set extensible without touching `../indexer.ts`.
 *
 * ## Synchronous, deliberately
 *
 * ts-morph's API is synchronous, so an extractor has nothing to await; making
 * the contract `Promise`-returning would add a microtask per file per extractor
 * and buy nothing. `../indexer.ts` wraps each call in a `try`/`catch` — a throw
 * becomes an `extractor-failed` diagnostic and the run continues — and yields
 * between *files* rather than within one, which is where a large project needs
 * to be interruptible.
 *
 * ## Pure with respect to the project
 *
 * An extractor may read the abstract syntax tree as deeply as it likes. It must
 * **never mutate a node, save a file, emit output, or add or remove a source
 * file from the project**. Every extractor is handed the same
 * {@link ExtractorContext}, so a mutation would silently change what the
 * extractors after it see, and this package indexes a *developer's working
 * tree* — the reversible-instrumentation guarantee lives in
 * `packages/instrumentation`, where a write is recorded, hashed and backed up
 * first, and an unrecorded write from here would sit outside it entirely.
 */
export interface Extractor {
  /**
   * A stable identifier for this extractor, unique among registered ones.
   *
   * It appears in {@link IndexDiagnostic.extractorId}, so it is how a failure
   * becomes attributable, and it is stable across versions: renaming it makes
   * previously reported diagnostics untraceable to their source.
   */
  readonly id: string;

  /**
   * Extract graph fragments from one file.
   *
   * @param ctx The file being visited and the project it belongs to.
   * @returns The nodes, edges and diagnostics found. Throwing is permitted and
   * handled — it becomes an `extractor-failed` diagnostic — but returning an
   * empty result is the better answer when the extractor simply found nothing.
   */
  extract(ctx: ExtractorContext): ExtractorResult;
}

/**
 * What to look for with a {@link ReferenceResolver}: a symbol, and the file
 * that declares it.
 *
 * The file is required rather than optional because a bare name is ambiguous in
 * any project of size — two modules may both export `handleSubmit` — and a
 * resolver that guessed would return references to the wrong one.
 */
export interface ReferenceQuery {
  /**
   * The declaring file, project-relative POSIX, as a node's
   * {@link CodeNodeBase.file} spells it.
   */
  readonly file: string;

  /**
   * The declared symbol's name, as a node's {@link CodeNodeBase.name} or
   * {@link CodeNodeBase.symbol} spells it.
   */
  readonly symbol: string;
}

/**
 * On-demand reference lookup over the opened project.
 *
 * ## Why this is not an indexing-time edge
 *
 * Finding every reference to a symbol means asking the type checker, and the
 * checker is the expensive part of ts-morph: running it for every declaration
 * of a real project at index time would dominate the whole indexing cost, for
 * results that all but a handful of lookups never need. So the indexer does
 * **not** use it — the indexer's own test asserts that the reference search is
 * never invoked during a build — and `../indexer.ts`'s `createReferenceResolver`
 * instead returns an implementation of this interface over the same loaded
 * project, which `./query.ts`'s `whoCalls` is given so it can deepen a result
 * when a caller actually asks for it.
 *
 * The `references` edge kind covers the other case: a reference an extractor
 * already had resolved while doing something else, recorded because it was free
 * (see {@link CODE_EDGE_KINDS}).
 *
 * The interface is a single method precisely so it can be substituted — a test
 * passes a resolver that returns a fixed list, and nothing else in the traversal
 * changes.
 */
export interface ReferenceResolver {
  /**
   * Every place the queried symbol is referenced.
   *
   * @param query The declaring file and symbol name to search for.
   * @returns The reference sites as `SourceLocation` values from
   * `@debuggen/shared` — already project-relative, 1-based and carrying their
   * own `resolvedBy` and `confidence` — so a caller can hand one straight to
   * the source-open path without re-deriving anything. Empty when the symbol is
   * never referenced, when it cannot be found, or when the project was opened
   * without a configuration that makes the lookup meaningful; a resolver
   * reports "nothing" rather than throwing, because an unanswerable lookup must
   * not fail an investigation.
   */
  referencesTo(query: ReferenceQuery): readonly SourceLocation[];
}

/* -------------------------------------------------------------------------------------------------
 * Project summary
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which router conventions a project uses, taken as a whole.
 *
 * - `app` — only the App Router convention is present.
 * - `pages` — only the legacy Pages Router convention is present.
 * - `hybrid` — **both** directory trees are present, which is a supported and
 *   unremarkable state for a project mid-migration, and the case the indexing
 *   test corpus is built to cover.
 * - `none` — neither: a plain React application, or a project whose server side
 *   is elsewhere.
 *
 * Per project, unlike {@link RouterKind}, which is per route. `hybrid` is why
 * both exist: a project-level answer cannot classify an individual route, and a
 * route-level answer cannot describe a project that has both.
 *
 * Frozen: a read-only vocabulary.
 */
export const ROUTER_STYLES = Object.freeze(['app', 'pages', 'hybrid', 'none'] as const);

/**
 * Which router conventions a project uses.
 *
 * Derived from {@link ROUTER_STYLES}.
 */
export type RouterStyle = (typeof ROUTER_STYLES)[number];

/**
 * The frameworks this indexer recognises a project as.
 *
 * - `next` — a framework project: the routers, the route modules, the
 *   server/client component split.
 * - `react` — a React application without that framework.
 * - `unknown` — neither could be established. Reported honestly rather than
 *   guessed: the problem-understanding stage reads this field, and a wrong
 *   framework is worse for it than an absent one.
 *
 * Frozen: a read-only vocabulary.
 */
export const FRAMEWORK_NAMES = Object.freeze(['next', 'react', 'unknown'] as const);

/**
 * Which framework a project was recognised as.
 *
 * Derived from {@link FRAMEWORK_NAMES}.
 */
export type FrameworkName = (typeof FRAMEWORK_NAMES)[number];

/**
 * The framework a project uses, and the version it asks for.
 */
export interface FrameworkInfo {
  /**
   * Which framework. See {@link FRAMEWORK_NAMES}.
   */
  readonly name: FrameworkName;

  /**
   * The **declared range string from the target project's manifest** —
   * `'^16.3.5'`, `'~19.3.0'`, `'latest'` — and **never an installed version**.
   *
   * The distinction is deliberate: reading an installed version would mean
   * resolving into the project's `node_modules`, which may be absent, stale or
   * pruned, and the declared range is what the project actually claims. A
   * consumer that needs to compare versions must parse the range itself and
   * accept that a range is not a version. Absent when the manifest names no
   * such dependency, which is normal for
   * {@link FrameworkName} `'unknown'`.
   */
  readonly version?: string;
}

/**
 * The package managers a project's lockfile or manifest can identify it as
 * using.
 *
 * `unknown` when no lockfile and no declaration settles it. Read by the parts of
 * the product that have to *suggest a command* — the dev-server launcher's hint
 * and the readiness message that tells a developer how to relaunch — so an
 * honest `unknown` is what stops a suggestion that would fail on their machine.
 *
 * Frozen: a read-only vocabulary.
 */
export const PACKAGE_MANAGERS = Object.freeze(['pnpm', 'npm', 'yarn', 'bun', 'unknown'] as const);

/**
 * Which package manager a project uses.
 *
 * Derived from {@link PACKAGE_MANAGERS}.
 */
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/**
 * How a project reaches its database, taken as a whole.
 *
 * - `prisma` — only generated-client calls were found.
 * - `pg` — only driver calls were found.
 * - `both` — both, which is an ordinary shape: a project that uses the client
 *   for most work and hand-written statements for the queries that need them.
 * - `none` — no database call sites were found.
 *
 * Frozen: a read-only vocabulary.
 */
export const DATABASE_ACCESS_STYLES = Object.freeze(['prisma', 'pg', 'both', 'none'] as const);

/**
 * How a project reaches its database.
 *
 * Derived from {@link DATABASE_ACCESS_STYLES}.
 */
export type DatabaseAccessStyle = (typeof DATABASE_ACCESS_STYLES)[number];

/**
 * What the index found out about a project's database access.
 *
 * **Derived from the graph's `db-call` nodes** — specifically their
 * {@link DbCallNodeData.driver} field — and not from a manifest or a
 * configuration file, because what matters is what the code *calls*.
 * `packages/instrumentation`'s adapter detection consumes it: it is how the
 * Prisma and Postgres adapters decide whether they are relevant to a session at
 * all, and therefore whether the dev-server preload is required before capture
 * (AAP 0.7.1 Group 1).
 */
export interface DatabaseAccessInfo {
  /**
   * Which mechanisms are in use. See {@link DATABASE_ACCESS_STYLES}.
   */
  readonly style: DatabaseAccessStyle;

  /**
   * The module that constructs the generated client, project-relative POSIX,
   * when one was identified.
   *
   * The instantiation site rather than a call site: it is the file a developer
   * looks at to see how the client is configured, and the one an adapter
   * inspects to learn which driver it was given. Absent when no client is
   * constructed in the project's own source.
   */
  readonly prismaClientModule?: string;

  /**
   * The module that constructs the driver pool, project-relative POSIX, when one
   * was identified.
   *
   * Absent when the project constructs no pool of its own.
   */
  readonly pgPoolModule?: string;

  /**
   * How many database call sites the index holds — the count of `db-call`
   * nodes.
   *
   * A magnitude, not a list: the summary is bounded (see
   * {@link ProjectSummary}), and "this project touches the database in 240
   * places" is the fact the understanding stage needs, while the places
   * themselves are what a targeted investigation query is for. `0` exactly when
   * {@link DatabaseAccessInfo.style} is `'none'`.
   */
  readonly callSiteCount: number;
}

/**
 * What the target project's TypeScript setup looks like.
 *
 * Every field except `enabled` is optional because a project may have
 * TypeScript without this indexer being able to say more: a configuration that
 * extends a base it cannot read, or no configuration at all.
 */
export interface TypeScriptInfo {
  /**
   * Whether the project uses TypeScript at all.
   *
   * `false` for a JavaScript project, which is indexable — the abstract syntax
   * tree is the same shape — but tells a consumer not to expect type
   * information behind it.
   */
  readonly enabled: boolean;

  /**
   * The **declared range string from the target project's manifest**, on the
   * same terms as {@link FrameworkInfo.version}: never an installed version.
   */
  readonly version?: string;

  /**
   * Whether the configuration in force enables `strict`.
   *
   * Worth reporting because it changes what an instrumentation patch must
   * satisfy to keep the project compiling — the function-timing patch declares
   * its own helper type alias precisely so a strict project type-checks
   * afterwards. Absent when no configuration was read.
   */
  readonly strict?: boolean;

  /**
   * The configuration file whose options are in force, project-relative POSIX.
   *
   * Absent when the project was opened with this package's defaults, which is
   * the same condition `LoadedProject.tsConfigFilePath` reports as `undefined`
   * — and a condition worth acting on, because without a configuration there
   * are no path aliases and an aliased import resolves to nothing.
   */
  readonly tsConfigFile?: string;
}

/**
 * One route, as the project summary reports it.
 *
 * A flattened projection of an `api-route` node: the fields of
 * {@link ApiRouteNodeData} plus the file it was found in, and nothing else — no
 * id, no position, no edges. The summary is prompt input, and a route is only
 * useful there as "this path, these methods, this file".
 */
export interface ProjectSummaryRouteRef {
  /**
   * The URL path, exactly as {@link ApiRouteNodeData.routePath} spells it.
   */
  readonly routePath: string;

  /**
   * Which router convention the module belongs to. See {@link ROUTER_KINDS}.
   */
  readonly router: RouterKind;

  /**
   * Whether the module is a request handler or a page. See
   * {@link API_ROUTE_KINDS}.
   */
  readonly kind: ApiRouteKind;

  /**
   * The route module, project-relative POSIX.
   */
  readonly file: string;

  /**
   * The methods the route answers, including the `'ANY'` case. See
   * {@link ApiRouteNodeData.methods}.
   */
  readonly methods: readonly HttpMethodName[];
}

/**
 * One dependency the target project declares.
 *
 * Declarations only: this is read from the project's manifest, never resolved
 * against its `node_modules`, for the same reason
 * {@link FrameworkInfo.version} is a range.
 */
export interface ProjectDependencyRef {
  /**
   * The package name as declared: `'@scope/package'`, `'some-package'`.
   */
  readonly name: string;

  /**
   * The declared range, verbatim: `'^1.2.3'`, `'workspace:*'`, `'latest'`.
   *
   * Required here, unlike {@link FrameworkInfo.version}, because a dependency
   * entry without a range would not be a dependency entry.
   */
  readonly versionRange: string;

  /**
   * Whether it was declared as a development dependency.
   *
   * The distinction matters to an investigation: a runtime dependency can
   * appear in a captured trace, a development one generally cannot.
   */
  readonly dev: boolean;
}

/**
 * How many nodes of each kind the index holds — one counter per
 * {@link CodeNodeKind}, in the order {@link CODE_NODE_KINDS} declares them.
 *
 * Counts rather than contents, which is what keeps the summary bounded: the
 * magnitudes are what let the understanding stage judge a project's shape and
 * decide what to ask for next, and the nodes themselves are what a targeted
 * query returns.
 */
export interface ProjectSummaryCounts {
  /** `file` nodes: indexable modules. */
  readonly files: number;

  /** `symbol` nodes: named declarations. */
  readonly symbols: number;

  /** `component` nodes. */
  readonly components: number;

  /** `handler` nodes: event handlers bound in markup. */
  readonly handlers: number;

  /** `api-call` nodes: call sites that reach the network. */
  readonly apiCalls: number;

  /** `api-route` nodes: route and page modules. */
  readonly apiRoutes: number;

  /** `server-function` nodes. */
  readonly serverFunctions: number;

  /** `db-call` nodes: call sites that reach the database. */
  readonly dbCalls: number;
}

/**
 * A bounded description of a target project, and the input the pipeline's first
 * stage reasons about.
 *
 * ## What it is for
 *
 * This is the project-shaped context for **Stage 1, problem understanding**
 * (AAP 0.4.2): enough for that stage to know what kind of project it is looking
 * at and what to ask the code graph for next. `../summary.ts`'s
 * `summarizeProject` produces it from a {@link CodeIndex} and the project's own
 * manifest and configuration.
 *
 * ## It is not a repository dump
 *
 * That is the constraint the whole shape follows from, and it has three parts:
 *
 * - **Bounded.** Every list here is capped by `../summary.ts`'s
 *   `PROJECT_SUMMARY_LIMITS`, and {@link ProjectSummary.truncated} is `true`
 *   whenever a cap trimmed anything. The counts in
 *   {@link ProjectSummary.counts} are *not* capped, so a consumer can always
 *   tell how much it is not being shown.
 * - **No contents.** **No file contents, no source excerpts, no environment
 *   values, no secrets** — not in any field, not in any list. The indexer never
 *   reads environment files in the first place, and bounded source excerpts are
 *   Stage 2's business, requested per file through the investigation tools and
 *   redacted on the way out (AAP 0.5.2).
 * - **No host paths.** {@link ProjectSummary.projectRoot} is the only absolute
 *   path; every other path in the object is project-relative POSIX, which keeps
 *   a developer's directory layout out of a prompt and out of anything rendered
 *   from one.
 */
export interface ProjectSummary {
  /**
   * The project root: absolute POSIX, identical to
   * {@link CodeIndex.projectRoot}.
   *
   * The only absolute path in this object.
   */
  readonly projectRoot: string;

  /**
   * The project's name — from its manifest where it declares one, otherwise the
   * root directory's name.
   *
   * A label, for a user interface and for the summary's own prose. Never parsed.
   */
  readonly projectName: string;

  /**
   * The framework and its declared version. See {@link FrameworkInfo}.
   */
  readonly framework: FrameworkInfo;

  /**
   * Which router conventions are present. See {@link ROUTER_STYLES}.
   */
  readonly routerStyle: RouterStyle;

  /**
   * The TypeScript setup. See {@link TypeScriptInfo}.
   */
  readonly typescript: TypeScriptInfo;

  /**
   * The package manager. See {@link PACKAGE_MANAGERS}.
   */
  readonly packageManager: PackageManagerName;

  /**
   * How the project reaches its database. See {@link DatabaseAccessInfo}.
   */
  readonly databaseAccess: DatabaseAccessInfo;

  /**
   * The project's entry points, project-relative POSIX: the root layout and
   * page modules, a client application's mount module, whatever the framework
   * convention makes the way in.
   *
   * Where an investigation starts when nothing more specific is known. Capped;
   * see {@link ProjectSummary.truncated}.
   */
  readonly entryPoints: readonly string[];

  /**
   * The project's routes. See {@link ProjectSummaryRouteRef}.
   *
   * The most directly useful list in the summary — a request seen in the
   * browser is matched against it — and capped like the others, so a consumer
   * that needs every route asks the route map rather than reading it from here.
   */
  readonly routes: readonly ProjectSummaryRouteRef[];

  /**
   * Directories worth knowing about, project-relative POSIX: where components
   * live, where the server layer lives, where shared library code lives.
   *
   * Derived from where the index actually found things rather than from a
   * convention list, so it describes *this* project's layout. Capped.
   */
  readonly notableDirectories: readonly string[];

  /**
   * The project's declared dependencies. See {@link ProjectDependencyRef}.
   *
   * Capped, and ordered so that the entries that tell a reader what kind of
   * project this is come first.
   */
  readonly dependencies: readonly ProjectDependencyRef[];

  /**
   * How many nodes of each kind the index holds. See
   * {@link ProjectSummaryCounts}.
   *
   * Never capped — the counts are how a consumer knows the size of what the
   * capped lists are a sample of.
   */
  readonly counts: ProjectSummaryCounts;

  /**
   * Whether any list in this summary was trimmed by a cap.
   *
   * `true` means at least one of {@link ProjectSummary.entryPoints},
   * {@link ProjectSummary.routes}, {@link ProjectSummary.notableDirectories} or
   * {@link ProjectSummary.dependencies} is a prefix of what the index holds.
   * Reported so that a consumer never reads a capped list as an exhaustive one
   * — "there are no other routes" and "you have not been shown the other
   * routes" lead to opposite conclusions.
   */
  readonly truncated: boolean;

  /**
   * When the summary was built, in **epoch milliseconds** — the same time base
   * as {@link CodeIndex.generatedAt}.
   */
  readonly generatedAt: number;
}
