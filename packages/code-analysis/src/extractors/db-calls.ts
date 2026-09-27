/**
 * `db-calls` — the database call-site extractor of `@debuggen/code-analysis`,
 * and the eighth entry of `../indexer.ts`'s `DEFAULT_EXTRACTORS`.
 *
 * ## The kinds it owns
 *
 * - The **`db-call` node kind**: one node per call expression in the analysed
 *   source that reaches the database, carrying the required
 *   {@link DbCallNodeData} payload (`driver`, and — as the source allows —
 *   `model`, `operation`, `statementShape`, `dynamic`).
 * - The **`queries` edge kind**, from the enclosing owner of the call site to
 *   that node. The direction is the one the edge table on `CODE_EDGE_KINDS`
 *   fixes ("a call expression that reaches the database, from the function that
 *   contains it"), and it is the direction `../graph/query.ts`'s outward
 *   `pathBetween` traversal depends on for its terminal hop.
 *
 * It owns nothing else: no `file` node, no `symbol`/`server-function` node, and
 * no `references` edge (see *What it deliberately does not emit*).
 *
 * ## Why `driver` is load-bearing well beyond this package
 *
 * `DbCallNodeData.driver` is the field the rest of the product reads out of the
 * graph rather than re-deriving from source text:
 *
 * - `packages/instrumentation`'s Prisma and Postgres adapter detection decides
 *   whether a session must require the dev-server Node preload from which
 *   drivers a project actually *calls* (AAP 0.7.1 Group 1);
 * - `../summary.ts`'s `detectDatabaseAccess` folds the same field into
 *   `DatabaseAccessInfo.style`, so a project calling both mechanisms reports
 *   `'both'` — a user-visible statement in the problem-understanding stage that
 *   is wrong the moment a borrowed pooled connection is misread as a generated
 *   client call, or dropped;
 * - a runtime SQL span resolves back to the `.query`/`prisma.<model>.<op>` call
 *   site through the node emitted here, which is what makes the query table's
 *   rows clickable (AAP 0.4.2's source-resolution path).
 *
 * Note which half of that last point is *not* this module's: the node
 * vocabulary carries no `SourceLocation` field — `CodeNodeBase` carries `file`,
 * `line`, `column`, `endLine` and `symbol` — so **no location and no
 * provenance are minted here**. `../graph/query.ts` is the one place a node
 * becomes a location and the one place that stamps `resolvedBy: 'code-graph'`
 * with that route's default confidence. All this module owes that consumer is a
 * position a location can be built from, which is why `ctx.file` is checked
 * against `isSafeRelativePath` before anything is emitted and why every node's
 * and edge's `file` is that value rather than a path read off the tree.
 *
 * Consumers, in full: `../summary.ts` (`detectDatabaseAccess`, and the index's
 * `dbCalls` count), `packages/instrumentation`'s `PrismaAdapter` and
 * `PostgresAdapter` detection, `../graph/query.ts`'s `pathBetween` terminal hop
 * (`{ kind: 'db-call' }` as the target), and the local service's
 * "Found database dependency" progress message (AAP 0.7.1 Group 2), which is
 * true exactly when this extractor found a call site.
 *
 * ## Handle discovery: structural first, name-shaped last
 *
 * A database call is a member access on a **driver handle**, so recognising one
 * is really recognising the handle. Handles are discovered **from the analysed
 * code**, in this order, and the order is the contract:
 *
 * 1. **Construction (primary).** A variable or class property initialised with
 *    `new PrismaClient(…)` is a generated-client handle; one initialised with
 *    `new Pool(…)` is a pooled-driver handle. `PrismaClient` and `Pool` are
 *    *driver-library class names* — framework-level vocabulary, permitted here
 *    exactly as `fetch` is permitted in `./api-calls.ts` — while no
 *    application's handle, service, model or table name appears in this file
 *    and none may (AAP 0.5.4, enforced by `scripts/check-no-hardcoding.mjs`
 *    over `packages/**`).
 * 2. **Cross-file, through resolved imports (mandatory, not optional).** A
 *    project declares its handles once, in a module of their own, and imports
 *    them where the queries are written — which is exactly what this package's
 *    own corpus does. Construction discovery applied to the current file alone
 *    therefore finds **zero** handles and, with them, zero database calls. So
 *    an imported binding is followed: the specifier is resolved with ts-morph's
 *    `getModuleSpecifierSourceFile()` (module resolution only, which is
 *    alias-aware and extensionless-aware), module-specifier re-exports are
 *    followed up to {@link MAX_RESOLUTION_HOPS} hops with a cycle guard, and
 *    construction discovery is applied to the declaration found there. A
 *    namespace *import* is followed the same way, with the first member of the
 *    access chain treated as the exported name (`ns.pool.query(…)`); a
 *    namespace *export* (`export * as store from './pg'`) re-exports no
 *    individual name and is deliberately not followed, so a handle reached only
 *    through a namespace object is a miss rather than a guess — see
 *    {@link collectExportDeclaration}.
 * 3. **Borrowed client.** A variable initialised from
 *    `await <poolHandle>.connect()` is a connection borrowed from a pool: a
 *    `.query(…)` on it is a pooled-driver call, and a later `.release()` on it
 *    is not a call site at all — only the `query` member is ever a call site,
 *    so `connect`, `release` and `end` yield no node by construction.
 *    `DbCallNodeData` states the rule this implements: both shapes are
 *    `driver: 'pg'`, because "treating the borrowed-client form as something
 *    else would leave exactly the queries a developer hand-wrote for
 *    transactional work outside the analysis".
 *
 *    The generated client lends a connection the same way through an
 *    interactive transaction: in `<clientHandle>.$transaction(async (tx) => …)`
 *    the callback's first parameter is a transaction client with the same
 *    delegates, so `tx.<model>.<operation>(…)` is a generated-client call site
 *    and is recorded like one. The parameter is accepted only when the callback
 *    is the *first argument* of a `$transaction` call whose receiver is itself
 *    proved to be a generated-client handle — the same receiver-first rule the
 *    pooled borrow follows — so a callback parameter of any other API never
 *    becomes a handle, and the statements of every interactive transaction stay
 *    inside the analysis instead of being invisible to it.
 * 4. **Type annotation.** A parameter, variable or class property annotated
 *    `PrismaClient`, `Pool` or `PoolClient` — bare, qualified (`pg.Pool`),
 *    import-qualified (`import('pg').Pool`) or as a member of a union — is a
 *    handle of that driver. Annotations are read as abstract-syntax-tree text;
 *    no type is resolved.
 * 5. **Generic-name heuristic (fallback only).** When every structural step
 *    fails, a receiver whose name is generic driver vocabulary
 *    (`prisma`, `db`, `pool`, `pgPool`, `client`) *combined with* a matching
 *    call shape is accepted as a lower-confidence match, and the node is marked
 *    with {@link HeuristicDbCallNodeData.heuristicHandle} so a downstream
 *    adapter can weigh it. Why it must be last, and never the path a supported
 *    project takes: a name is not evidence. The heuristic exists for a real
 *    project whose handle module cannot be resolved — an uninstalled generated
 *    client, a specifier behind an alias the target project's configuration
 *    does not declare — and it is deliberately narrowed there: a generated-
 *    client delegate call is accepted only when the operation segment *and* the
 *    call's arity have the shape the driver's delegate operations have (see
 *    {@link PRISMA_DELEGATE_OPERATION_PREFIXES}), so a document store's
 *    `db.things.insertOne(doc)` does not become a Prisma call.
 *
 *    That narrowing is a **shape** rule rather than a list of operation names
 *    on purpose. An enumerated list of a driver's method names is indexed
 *    application vocabulary as far as a corpus scanner is concerned — a name
 *    such as a bulk-create operation's is spelled identically by a driver and
 *    by any application that calls it — so naming operations here would make
 *    this module's vocabulary a function of what some other project happens to
 *    call. The driver's operation *verbs* are single framework tokens, they are
 *    what the shape is actually made of, and testing them as prefixes covers
 *    every published spelling (bulk, first, unique, throwing and grouping
 *    variants alike) without this file ever naming one.
 *
 * `DbCallNodeData` has no confidence or provenance field, and this module may
 * not change `../graph/types.ts`. The marker is therefore an **additive,
 * documented boolean** on the emitted payload object — structurally a
 * `DbCallNodeData`, plain JSON, and present *only* on the heuristic path, so a
 * structurally discovered node's payload is exactly the declared shape. Read it
 * with {@link isHeuristicDbCall} rather than by hand.
 *
 * ## Statement shape, never statement data
 *
 * For a pooled-driver `query(…)` and for the generated client's raw escape
 * hatches, the first argument's *shape* is recorded, and only ever a shape
 * (AAP 0.5.2, and the three constraints `DbCallNodeData.statementShape`
 * states):
 *
 * - comments (`-- …`, `/* … *\/`) are dropped, single-quoted and dollar-quoted
 *   string literals become `?`, standalone numeric literals become `?`, and
 *   every template substitution becomes `?`;
 * - `$1`-style parameter placeholders are **preserved**, because they are the
 *   shape — they are what makes two call sites comparable and what proves the
 *   statement is parameterised;
 * - double-quoted identifiers are kept, since they name a table or column
 *   rather than a value;
 * - whitespace is collapsed and the result is capped at
 *   {@link MAX_STATEMENT_SHAPE_LENGTH} characters, silently.
 *
 * What is **never** recorded, in any form: the values array (the second
 * argument is not read at all), a generated-client call's argument object
 * contents, row data, and the text of any literal. A non-literal argument
 * records **no** shape and sets `dynamic: true` instead of a guess. The same
 * rule governs diagnostics: no source text and no statement text reaches a
 * message or a detail, per the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES` — a diagnostic travels into logs, into a persisted
 * session and into model prompt context.
 *
 * ## The owner cascade, and the two reconciliations it forces
 *
 * A `queries` edge is only useful if it starts at the node a developer would
 * look for, and it is only *present* if that node exists: graph assembly
 * **drops** an edge whose endpoint no extractor emitted and reports
 * `dangling-edge`. The cascade takes the **innermost addressable owner** of the
 * call site, walking the call's ancestors innermost-first, which is the same
 * six-step rule `./server-functions.ts` documents
 * (handler → api-route → component → server-function → symbol → file),
 * reconciled with two constraints this file is bound by:
 *
 * - **The `queries` edge table fixes `from` as `symbol | server-function`.**
 *   The handler, api-route and component steps name kinds that table excludes,
 *   so they are not taken. Nothing is lost: `./symbols.ts` inventories *every*
 *   module-level declaration and every member of a module-level class —
 *   including a route module's HTTP-method exports, a component declaration and
 *   a named handler — so the owner those three steps would have named is
 *   reached as its own `symbol` node instead, and the edge stays present, legal
 *   and correctly attributed. In practice the question rarely arises: database
 *   calls live in exported service functions, so the origin is almost always a
 *   `server-function` node, which is exactly what `pathBetween`'s terminal hop
 *   needs.
 * - **An `api-route` node's id may not be re-derived here.** It is built from a
 *   route *path*, whose derivation `../graph/types.ts` assigns exclusively to
 *   `../route-map.ts` — a module this file's binding constraints forbid
 *   importing — and a path that differed by one character would not be a
 *   slightly wrong edge but a dropped one. `./api-calls.ts` reconciles the same
 *   conflict the same way.
 *
 * The remaining steps, in order, with the extractor that guarantees each
 * spelling in brackets:
 *
 * 1. the innermost addressable declaration that is a module-level,
 *    function-valued declaration **leaving its module as a function**, in a
 *    module that is neither a route/page module nor a component module → its
 *    **`server-function`** node (`./server-functions.ts`);
 * 2. any other addressable declaration — module-level, or a member of a
 *    module-level class → its **`symbol`** node (`./symbols.ts`);
 * 3. nothing addressable anywhere up the chain → the **`file`** node
 *    (`./imports.ts`), the same last resort `./api-calls.ts` uses so that a
 *    call site with no enclosing declaration is still connected rather than
 *    silently unreachable.
 *
 * "Leaving its module as a function" is the **export surface** and not the
 * `export` keyword, because the surface is what the node's existence follows:
 * `./server-functions.ts` emits a `server-function` node for every exported
 * module-level function of a server module *as resolved through that module's
 * export surface*, which includes `export { load }`, `export { load as read }`,
 * `export default load` and `export default async () => {}` as much as
 * `export async function load()`. Asking only about the keyword would send the
 * calls of a clause-exported or default-exported service function to a `symbol`
 * node while its `server-function` node sat unused — a legal edge starting at a
 * node a developer does not look for, and the service function missing from
 * `pathBetween`'s terminal hop. {@link collectExportedFunctions} is the whole
 * of that rule, mirroring the sibling's collection shape by shape, and
 * {@link ModuleFacts.exportedFunctions} is how a declaration is matched against
 * it — by identity, so a shadowing local of the same name cannot answer for it.
 *
 * The asymmetry `./api-calls.ts` names governs everything the surface does not
 * settle: a `symbol` node exists for every module-level declaration, while a
 * `server-function` node exists only where the sibling extractor agreed, so a
 * route/page module's exports (framework entry points), a component module's
 * (components), a class member (whose name space is its class's) and a
 * declaration holding no function keep their `symbol` owner — a disagreement
 * costs the edge rather than degrading it. Component-module detection is
 * correspondingly **permissive** for the same reason: over-answering can only
 * move an edge from `server-function` to `symbol`, both of which exist.
 *
 * The chosen step needs no new field to be legible: the edge's `from` is a node
 * id whose first component is that node's kind, which is what makes a cascade
 * misjudgement visible in a diagnostic or a query result. Nothing parses it
 * (`makeNodeId`'s contract); it is read.
 *
 * ## What it deliberately does not emit
 *
 * - **No `file` node.** `./imports.ts` owns that kind and is its only emitter;
 *   this module only *derives* the file node's id, by the convention
 *   `CodeNodeBase.name` documents (the name *is* the project-relative path,
 *   anchored at line 1, column 1), so that its last-resort edge has a real
 *   endpoint.
 * - **No `symbol` or `server-function` node.** Those ids are *spelled* here to
 *   point an edge at them and are emitted by their owners; emitting one here as
 *   well would collide and produce a `duplicate-node-id` diagnostic.
 * - **No `references` edge.** Reference resolution is deliberately lazy and
 *   belongs to `../indexer.ts`'s `createReferenceResolver`; emitting references
 *   at index time would force full type resolution over the whole program.
 * - **No `calls` or `routes-to` edge.** A database call is not an HTTP call and
 *   a `routes-to` edge is derived from two nodes during graph assembly rather
 *   than read off a line of source.
 *
 * ## Contract
 *
 * - **Abstract-syntax-tree first, no type resolution.** Every judgement is
 *   syntactic: a construction's class name, a member-access chain, an
 *   annotation's text, a path convention. The single resolution step is
 *   **module** resolution, which is what an aliased or extensionless specifier
 *   needs and nothing more. No type is consulted, no symbol is resolved through
 *   the checker and no expression is evaluated — which is what lets this
 *   package's corpus, whose driver stand-ins are hand-written local classes and
 *   whose dependencies are never installed, yield a complete call-site
 *   inventory.
 * - **Reads no other extractor's output, and imports no sibling.** The sibling
 *   naming rules the edge depends on are reproduced here as small documented
 *   local helpers, which is the only coupling point; `ExtractorResult` is
 *   additive and validation happens once, over the merged set.
 * - **Reads no file the developer did not import.** Resolution follows module
 *   specifiers only, so an environment file — which the project loader refuses
 *   to load in the first place — is never reachable from here.
 * - **Pure and synchronous.** No filesystem writes, no network, no state beyond
 *   the call it is inside, no mutation of the tree, no source text logged.
 *   `extract` **never throws**: one unreadable construct becomes an
 *   `IndexDiagnostic` while the rest of the file still yields call sites, a
 *   failure that reaches the whole file becomes one diagnostic and an empty
 *   contribution, and even a module resolution that throws on an exotic
 *   specifier is treated as "no module".
 * - **Deterministic.** Nodes and edges are emitted in source order, with no
 *   counter, clock or hash anywhere, so two runs over unchanged source
 *   serialise byte-identically — the reproducibility property `../indexer.ts`
 *   promises and the index cache depends on.
 *
 * @packageDocumentation
 */

import { Node } from 'ts-morph';
import type {
  CallExpression,
  ClassDeclaration,
  ClassExpression,
  ExportAssignment,
  ExportDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  ParameterDeclaration,
  SourceFile,
  TaggedTemplateExpression,
  TypeNode,
  VariableStatement,
} from 'ts-morph';

import { isSafeRelativePath } from '@debuggen/shared';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import type {
  CodeEdge,
  CodeNodeOf,
  DbCallNodeData,
  DbDriver,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';

/* -------------------------------------------------------------------------------------------------
 * Identity and constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * This extractor's {@link Extractor.id}.
 *
 * Exported so that `../indexer.ts`, a diagnostic consumer and a test can name
 * it without repeating a string literal. It travels on every
 * {@link IndexDiagnostic.extractorId} this module emits, which is what makes a
 * finding attributable to database-call extraction rather than to indexing in
 * general, and it is stable across versions by contract: renaming it would make
 * previously reported diagnostics untraceable to their source.
 */
export const DB_CALLS_EXTRACTOR_ID = 'db-calls';

/**
 * The result returned when a file holds no database call site — which is most
 * files of most projects.
 *
 * A single frozen value rather than a fresh object per file: `ExtractorResult`
 * requires `edges` to be empty rather than absent so the indexer can
 * concatenate without a guard, and requires `diagnostics` to be absent rather
 * than empty for a clean extraction — both of which this value is.
 */
const NOTHING_FOUND: ExtractorResult = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
});

/**
 * The generated client's construction class, as a project spells it when it
 * constructs one.
 *
 * Driver-library vocabulary, which is what makes it admissible here: it names a
 * class the *library* exports, never a declaration of the project under
 * analysis. `../summary.ts` recognises the same binding when it reports which
 * module constructs the client, so the two agree by construction.
 */
const PRISMA_CLIENT_CLASS = 'PrismaClient';

/**
 * The pooled driver's construction class, on the same terms as
 * {@link PRISMA_CLIENT_CLASS}.
 */
const PG_POOL_CLASS = 'Pool';

/**
 * The type a connection borrowed from a pool is annotated with.
 *
 * Accepted for annotation discovery only — a type cannot be constructed — which
 * is why it is separate from the two construction classes above.
 *
 * The driver's single-connection class is **deliberately not** recognised: its
 * name is generic enough to belong to any client library in any ecosystem, so
 * matching it would read an unrelated software development kit's handle as a
 * database handle. A project that uses one is served by the annotation of a
 * pooled type, or in the last resort by the name heuristic, which marks itself.
 */
const PG_POOL_CLIENT_TYPE = 'PoolClient';

/**
 * The pooled driver's statement method: the **only** member of a pooled handle
 * or of a borrowed connection that is a call site.
 *
 * Everything else a handle exposes — borrowing a connection, handing one back,
 * ending the pool — is lifecycle rather than access, and is therefore not a
 * database call. That is a consequence of matching exactly this member and not
 * a special case anywhere below.
 */
const PG_QUERY_METHOD = 'query';

/**
 * The member that borrows a connection from a pool, recognised so that the
 * variable it initialises can be discovered as a borrowed connection.
 */
const PG_CONNECT_METHOD = 'connect';

/**
 * The property that carries the statement when a pooled `query(…)` is called
 * with the driver's configuration-object form rather than with a bare string.
 *
 * Driver vocabulary again, and the reason the object form is read at all: a
 * project that names its statements this way would otherwise record every one
 * of them as dynamic, which would be a worse answer than the shape it can have.
 * The sibling `values` property is never read.
 */
const PG_QUERY_CONFIG_TEXT_PROPERTY = 'text';

/**
 * The generated client's raw escape hatches and transaction entry point: the
 * `$`-prefixed members that are database call sites.
 *
 * Frozen and sorted, and closed on purpose. Every other `$`-prefixed member of
 * a generated client is lifecycle or extension (connecting, disconnecting,
 * middleware, extending), so the prefix alone cannot decide the question and a
 * list of the members that *are* access is the honest way to say which.
 */
const PRISMA_RAW_OPERATIONS: readonly string[] = Object.freeze([
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  '$transaction',
]);

/**
 * The subset of {@link PRISMA_RAW_OPERATIONS} whose first argument (or tagged
 * template) **is** a statement, and therefore the only generated-client
 * operations that record a {@link DbCallNodeData.statementShape}.
 *
 * The transaction entry point is excluded: its argument is an array of promises
 * or a callback, never a statement, so reading a shape from it would be reading
 * something that is not one.
 */
const PRISMA_STATEMENT_OPERATIONS: readonly string[] = Object.freeze([
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
]);

/**
 * The generated client's transaction entry point, a member of
 * {@link PRISMA_RAW_OPERATIONS}: the call whose callback form lends the
 * callback a transaction client (discovery step 3, {@link transactionClientHandle}).
 */
const PRISMA_TRANSACTION_OPERATION = '$transaction';

/**
 * The verbs a generated client's delegate operations are spelled with,
 * lower-cased and tested as **prefixes**.
 *
 * Used **only** to narrow the name heuristic (discovery step 5), through
 * {@link hasPrismaDelegateShape}: a structurally discovered handle records
 * whatever operation the source spells, because the handle has already proved
 * what it is, while a handle guessed from its name has not — and requiring the
 * operation to be spelled with one of the driver's own verbs is what stops an
 * unrelated client's `things.insertOne()` from being reported as a database
 * call.
 *
 * Prefixes rather than whole operation names, for two reasons that agree:
 *
 * - **Coverage.** Every published spelling of an operation extends one of these
 *   verbs — bulk variants, first/unique selectors, throwing variants, grouping
 *   and returning variants — so the prefix test needs no maintenance as the
 *   driver adds spellings, and cannot fall behind one.
 * - **Vocabulary hygiene** (AAP 0.5.4). A driver's full method names are also
 *   the names any application that calls them uses, so a list of them here
 *   would be indexed application vocabulary in this module — exactly what a
 *   product file may not carry. These verbs are single framework tokens; they
 *   name no model, table, service or handle of any application.
 *
 * Accepting a near-miss (a member merely *beginning* with a verb) is the
 * intended direction of error on this path: the outcome is a node marked
 * {@link HeuristicDbCallNodeData.heuristicHandle} for a downstream adapter to
 * weigh, never a structural claim. Frozen and sorted.
 */
const PRISMA_DELEGATE_OPERATION_PREFIXES: readonly string[] = Object.freeze([
  'aggregate',
  'count',
  'create',
  'delete',
  'find',
  'group',
  'update',
  'upsert',
]);

/**
 * The greatest number of arguments a generated client's delegate operation
 * takes.
 *
 * Every delegate operation takes a single arguments object, optional for the
 * selectors and required for the writers; none takes a second positional
 * argument. A member called with two or more is therefore not one, whatever it
 * is named — which is the other half of {@link hasPrismaDelegateShape}.
 */
const PRISMA_DELEGATE_MAX_ARGUMENTS = 1;

/**
 * The leading statement keywords a pooled call's
 * {@link DbCallNodeData.operation} may be derived from, lower-cased.
 *
 * A closed set, and deliberately small: these are the statements an application
 * issues, and a keyword outside the set — a schema change, a driver-specific
 * command, or a shape whose leading token was substituted away — leaves the
 * field **unset** rather than reporting a guess. `../summary.ts` and the panel's
 * query table both read the field as a fact.
 */
const SQL_LEADING_KEYWORDS: readonly string[] = Object.freeze([
  'delete',
  'insert',
  'select',
  'update',
  'with',
]);

/**
 * The generic handle vocabulary the name heuristic accepts, lower-cased for a
 * case-insensitive comparison.
 *
 * Generic *driver* words and nothing else: no application's handle name, and no
 * name that would identify a project. Reached only when every structural step
 * has failed, and every node it produces is marked — see discovery step 5 in
 * the module header.
 */
const GENERIC_HANDLE_NAMES: readonly string[] = Object.freeze([
  'client',
  'db',
  'pgpool',
  'pool',
  'prisma',
]);

/**
 * The hard cap on {@link DbCallNodeData.statementShape}, in characters.
 *
 * The value that payload field documents. Truncation is silent, so a consumer
 * must not assume the text is a complete statement; the cap exists because this
 * text reaches prompt context and a user interface, where an unbounded slice of
 * a developer's source is both a cost and a privacy risk (AAP 0.5.2).
 */
const MAX_STATEMENT_SHAPE_LENGTH = 512;

/**
 * How much statement text is tokenised before the shape is built, in
 * characters.
 *
 * A bound on work rather than on output: a generated or machine-assembled
 * statement can be very long, and the shape is capped at
 * {@link MAX_STATEMENT_SHAPE_LENGTH} anyway. Eight times the output cap leaves
 * room for the whitespace and comments the tokeniser removes, so the cap is
 * reached by *output* length in every realistic case rather than by this bound.
 */
const MAX_STATEMENT_SOURCE_LENGTH = MAX_STATEMENT_SHAPE_LENGTH * 8;

/**
 * How many resolution hops are followed while looking for the declaration that
 * constructs a handle.
 *
 * One bound for all three hop kinds — a module-specifier re-export, an import,
 * and a local alias (`const db = prisma`) — because they interleave: a barrel
 * re-exporting a module that re-exports an aliased handle spends one of each.
 * A real project spends one or two; four is generous and, together with the
 * cycle guard in {@link DiscoveryState.pending}, makes a cyclic barrel cost
 * bounded work instead of a stack. The bound is stated because a silent bound
 * is worse than a documented one.
 */
const MAX_RESOLUTION_HOPS = 4;

/**
 * How many transparent wrappers are unwrapped while reading what an expression
 * really is.
 *
 * `(x)`, `x as T`, `x satisfies T`, `x!` and `await x` change nothing about
 * what an expression evaluates to, and a real declaration nests at most a
 * couple of them.
 */
const MAX_WRAPPER_DEPTH = 4;

/**
 * How many member-access segments a receiver chain may hold before it is
 * refused.
 *
 * A database call's callee is two or three segments deep
 * (`pool.query`, `prisma.<model>.<op>`, `this.<handle>.query`). A chain far
 * longer than that is not a driver shape, and the bound keeps a pathological
 * expression from being walked.
 */
const MAX_ACCESS_DEPTH = 8;

/**
 * How deep the statement renderer descends through concatenations and
 * transparent wrappers.
 *
 * A statement assembled from more than a handful of parts is dynamic by any
 * reading, and the renderer says so rather than walking forever.
 */
const MAX_RENDER_DEPTH = 8;

/**
 * The neutral placeholder every removed literal and every template
 * substitution becomes.
 *
 * Deliberately not the removed text, not its length and not its type: the
 * placeholder is what makes a shape unable to carry a value (AAP 0.5.2).
 */
const VALUE_PLACEHOLDER = '?';

/**
 * The receiver text a member access on the enclosing instance presents.
 *
 * A handle held as a class property is reached as `this.<property>`, so the
 * property name joins the receiver key and the remaining segments are the
 * access chain — see {@link receiverRefOf}.
 */
const THIS_RECEIVER_KEY = 'this';

/**
 * The name a default export is recorded under, by the convention
 * `./symbols.ts` fixes and `./server-functions.ts` reuses.
 *
 * Both roles: the export name to look for when following an imported default
 * binding, and the `symbol` node's name for a nameless default-exported
 * function the cascade has to address.
 */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * The reserved member name `./symbols.ts` records a class constructor under,
 * needed when a database call sits inside a constructor and the cascade falls
 * through to the `symbol` step.
 */
const CONSTRUCTOR_NAME = 'constructor';

/**
 * The local name a namespace import binds is recorded under this export name,
 * which is not a legal export name and therefore cannot collide with one.
 *
 * A namespace binding is not a value the module exports — it *is* the module —
 * so the member that follows it is the exported name to resolve.
 */
const NAMESPACE_IMPORT_NAME = '*';

/** The line a `file` node is anchored at, per `CodeNodeBase`'s convention. */
const FILE_NODE_LINE = 1;

/** The column a `file` node is anchored at, per `CodeNodeBase`'s convention. */
const FILE_NODE_COLUMN = 1;

/**
 * The directory a project may root its router trees under, so that both
 * conventional layouts (with and without it) are recognised.
 */
const SOURCE_DIRECTORY = 'src';

/** The App Router's root directory name. */
const APP_ROUTER_DIRECTORY = 'app';

/** The legacy Pages Router's root directory name. */
const PAGES_ROUTER_DIRECTORY = 'pages';

/**
 * The file basenames, without extension, that make a module inside an App
 * Router tree a route or a page module rather than an ordinary one.
 *
 * Used only to decide *module shape* — whether a module's exported functions
 * are service functions or framework entry points — and never to derive a URL,
 * which `../graph/types.ts` assigns exclusively to `../route-map.ts`.
 */
const ROUTE_MODULE_STEMS: readonly string[] = Object.freeze(['page', 'route']);

/* -------------------------------------------------------------------------------------------------
 * The heuristic marker
 * ---------------------------------------------------------------------------------------------- */

/**
 * The payload of a `db-call` node whose driver handle was discovered by the
 * **name heuristic** rather than structurally.
 *
 * `DbCallNodeData` carries no confidence or provenance field and
 * `../graph/types.ts` is not this module's to change, so the marker is an
 * additive boolean on the payload: structurally still a `DbCallNodeData`
 * (nothing reading the declared fields is affected), plain JSON (so a
 * `CodeIndex` round-trips unchanged), and present **only** on the heuristic
 * path — a structurally discovered node's payload is exactly the declared
 * shape, with no marker to ignore.
 *
 * Why it is worth carrying: a heuristic match is a *weaker* statement than a
 * structural one, and the consumers act on the difference.
 * `packages/instrumentation`'s adapter detection can require the dev-server
 * preload on structural evidence and merely prefer it on heuristic evidence,
 * and an investigation can rank a structurally proved call site above a guessed
 * one. Silently equating the two would make a name the same kind of evidence as
 * a construction, which it is not.
 *
 * @see {@link isHeuristicDbCall} — the way to read it.
 */
export interface HeuristicDbCallNodeData extends DbCallNodeData {
  /**
   * Always `true` when present, and absent otherwise.
   *
   * A literal type rather than `boolean` so that "present and false" cannot be
   * expressed: the marker's only meaning is that the handle was matched by
   * name, and there is no third state.
   */
  readonly heuristicHandle: true;
}

/**
 * Whether a `db-call` payload was produced by the name heuristic.
 *
 * Total, and safe against a payload that came back from a serialised index or
 * from an older version of this package: a missing marker, a `false`, a string
 * or any other value all answer `false`.
 *
 * @param data The payload of a `db-call` node.
 * @returns `true` when the node's driver handle was matched by name rather than
 * discovered structurally, narrowing the payload to
 * {@link HeuristicDbCallNodeData}.
 *
 * @example
 * ```ts
 * const confident = graph
 *   .nodesByKind('db-call')
 *   .filter((node) => !isHeuristicDbCall(node.data));
 * ```
 */
export function isHeuristicDbCall(data: DbCallNodeData): data is HeuristicDbCallNodeData {
  const marker: unknown = (data as { readonly heuristicHandle?: unknown }).heuristicHandle;

  return marker === true;
}

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
 * Which discovery step produced a handle, innermost reason first.
 *
 * Kept internally even though only the heuristic case reaches the graph: it is
 * what makes the step order in the module header executable rather than
 * aspirational, and what a failing assertion names when detection regresses.
 */
type HandleDiscovery =
  'construction' | 'import' | 'borrowed' | 'transaction' | 'annotation' | 'heuristic';

/**
 * Where a declaration under inspection came from, which decides how a
 * construction found on it is labelled.
 *
 * `'local'` — the declaration is in the file under extraction, so a
 * construction on it is discovery step 1; `'import'` — it was reached by
 * following a resolved specifier, so the same construction is discovery step 2.
 * The distinction is provenance only: both are structural, and neither is the
 * heuristic.
 */
type HandleOrigin = 'local' | 'import';

/** A discovered driver handle: which driver it is, and how that was established. */
interface DriverHandle {
  /** The driver the handle belongs to. */
  readonly driver: DbDriver;

  /** Which step of the discovery order established it. */
  readonly discovery: HandleDiscovery;
}

/**
 * A call's receiver, reduced to what classification needs: the text the handle
 * is reached by, and the member names that follow it.
 *
 * `key` is `'prisma'` for `prisma.model.findMany(…)` and `'this.store'` for
 * `this.store.query(…)`; `chain` is the remaining member names in source order
 * (`['model', 'findMany']`, `['query']`). `handleName` is the bare name the
 * heuristic compares — the identifier, or the property for a `this` receiver.
 */
interface ReceiverRef {
  /** The receiver text the node's name is built from. */
  readonly key: string;

  /** The bare handle name, for the name heuristic and for a class-member lookup. */
  readonly handleName: string;

  /** Whether the handle is held by the enclosing instance rather than by a binding. */
  readonly viaThis: boolean;

  /** The member names after the handle, in source order. Never empty. */
  readonly chain: readonly string[];
}

/**
 * A resolved handle together with the member names that remain after it.
 *
 * The two differ only for a namespace import, where the first chain segment
 * names the handle *inside* the imported module (`ns.pool.query(…)`) and is
 * therefore consumed by resolution rather than classified as a model.
 */
interface ResolvedHandle {
  /** The handle. */
  readonly handle: DriverHandle;

  /** The member names the classifier must read. */
  readonly chain: readonly string[];
}

/**
 * What the statement renderer could make of an expression: the text it stands
 * for, and whether any part of it was computed.
 *
 * `text` is `undefined` when nothing literal could be read at all — a bare
 * variable, a helper call — in which case no shape is recorded. A partial text
 * with `dynamic: true` is the honest answer for a concatenation or a template:
 * `DbCallNodeData.dynamic` documents that its shape then "holds at best a
 * partial picture".
 */
interface RenderedStatement {
  /** The statement text, before shaping, or `undefined`. */
  readonly text: string | undefined;

  /** Whether any part of the statement was computed rather than written. */
  readonly dynamic: boolean;
}

/** One local binding an import declaration introduces, and what it names upstream. */
interface ImportedBinding {
  /** The import declaration, kept so its specifier can be resolved lazily. */
  readonly declaration: ImportDeclaration;

  /**
   * The name to look for in the imported module: the specifier's imported name
   * for `import { x as y }` (so `x`), {@link DEFAULT_EXPORT_NAME} for a default
   * import, and {@link NAMESPACE_IMPORT_NAME} for a namespace import, whose
   * real export name is the first member of the access chain.
   */
  readonly exportName: string;
}

/**
 * One module-specifier re-export clause, in source order.
 *
 * A named clause (`export { store } from './pg'`) or an **unqualified** star
 * (`export * from './pg'`). The qualified star `export * as store from './pg'`
 * is not one of these and is never recorded — see
 * {@link collectExportDeclaration}.
 */
interface ReexportClause {
  /** The declaration, kept so its specifier can be resolved lazily. */
  readonly declaration: ExportDeclaration;

  /** The name this clause exports, or `undefined` for an unqualified star. */
  readonly exportedAs: string | undefined;

  /**
   * The name to look for in the target module, which differs from
   * {@link ReexportClause.exportedAs} for `export { local as Public } from` and
   * is `'default'` for `export { default as Public } from`. `undefined` for an
   * unqualified star, where the looked-up name is whatever the caller asked
   * for.
   */
  readonly sourceName: string | undefined;
}

/**
 * What one module says about its own value bindings, as far as syntax can tell.
 *
 * Computed once per module per `extract` call and cached in
 * {@link DiscoveryState.surfaces}: several call sites in one file routinely
 * reach the same handle module, and re-reading its statements for each of them
 * would multiply the cost of the only non-trivial thing this extractor does.
 *
 * Only the forms a *handle* can arrive through are collected. A function, class
 * or type declaration is not a handle, and a destructured declarator binds
 * several names none of which is the declarator itself.
 */
interface ModuleSurface {
  /** Declared name → its module-level variable declarator, exported or not. */
  readonly locals: ReadonlyMap<string, Node>;

  /** Export name → the local name it names, for every clause and plain export. */
  readonly exportedNames: ReadonlyMap<string, string>;

  /**
   * Export name → a declaration that is exported *directly*, with no local
   * name of its own: `export default new PrismaClient()`.
   */
  readonly directExports: ReadonlyMap<string, Node>;

  /** The module-specifier re-export clauses, in source order. */
  readonly reexports: readonly ReexportClause[];

  /** Local name → the import binding that introduced it. */
  readonly imports: ReadonlyMap<string, ImportedBinding>;
}

/**
 * The per-`extract` memoisation and cycle guard.
 *
 * Both fields exist for the cross-file walk and neither outlives the call:
 * nothing is cached between files, because the tree a later call sees may
 * differ and a stale surface would be a silently wrong answer.
 */
interface DiscoveryState {
  /** Absolute module path → its surface. */
  readonly surfaces: Map<string, ModuleSurface>;

  /**
   * The `(module, export name)` pairs currently being resolved.
   *
   * The cycle guard: a barrel that re-exports itself, directly or through a
   * ring of modules, terminates here rather than recursing. Keyed on the pair
   * rather than on the module, so two clauses of one barrel looking for
   * *different* names are both still followed.
   */
  readonly pending: Set<string>;
}

/**
 * What the file under extraction's own syntax says, for the owner cascade.
 *
 * Computed **lazily**, on the first database call site found: most modules of a
 * project hold none, and every answer here costs a walk of the tree.
 */
interface ModuleFacts {
  /**
   * Whether this module is a route or page module, in which case its exported
   * functions are framework entry points rather than service functions and the
   * `server-function` step of the cascade must not be taken.
   */
  readonly routeModule: boolean;

  /**
   * Whether this module might declare a React component, judged
   * **permissively** — see {@link declaresComponentName}.
   */
  readonly componentModule: boolean;

  /**
   * The module's **exported-function identity set**: the start offsets of the
   * module-level declarations that leave this module as functions, however they
   * leave it — see {@link collectExportedFunctions}.
   *
   * A start offset is the key because it identifies a node *within one source
   * file* exactly: `Node#getStart()` is that node's offset into the file's
   * text, two distinct nodes of one file that begin at the same offset are
   * always in an ancestor relationship (a statement and its first child), and
   * the only kinds compared here — a module-level function declaration, a
   * module-level variable declarator, an export assignment and, negatively, a
   * class member — can never stand in that relationship to one another. Both
   * sides of the comparison are read from `ctx.sourceFile`, the file under
   * extraction, so the offsets are always in the same text.
   */
  readonly exportedFunctions: ReadonlySet<number>;
}

/** The node a `queries` edge starts at, and the symbol it lends the call site. */
interface Owner {
  /** The owner node's id. */
  readonly id: string;

  /**
   * The owner's declared name, which becomes the db-call node's
   * {@link CodeNodeBase.symbol} — "what a developer needs to see is the
   * function it happens *inside*". `undefined` when the cascade fell through to
   * the file node, which names no function.
   */
  readonly symbol: string | undefined;
}

/**
 * An enclosing declaration the graph holds a node for.
 *
 * "Addressable" is defined by `./symbols.ts`'s scope — module-level
 * declarations and members of module-level class declarations — and
 * {@link addressableDeclarationOf} is the whole of this module's knowledge of
 * it. The anchor is the node whose start position that extractor records, which
 * is the declaration's name node in every case but the three it spells
 * differently: a nameless default-exported function (recorded as `default` at
 * the declaration's own start), a default-exported function *expression*
 * (recorded as `default` at the expression's own start) and a constructor
 * (recorded as `constructor` at the member's own start).
 */
interface AddressableDeclaration {
  /** The name the declaration is recorded under. */
  readonly name: string;

  /** The node its recorded position comes from. */
  readonly anchor: Node;

  /** Whether the declaration holds a function, which a `server-function` node requires. */
  readonly functionValued: boolean;

  /**
   * The declaration's own start offset — its identity within the file under
   * extraction, and the key {@link declaredOwner} looks up in
   * {@link ModuleFacts.exportedFunctions} to decide whether this declaration
   * leaves the module as a function.
   *
   * The *declaration's* offset and not the anchor's: a function-valued
   * declarator is anchored at its name but identified as the declarator, which
   * is the node the export surface is collected from. For a class member it is
   * recorded all the same and simply never matches, because
   * {@link collectExportedFunctions} collects module-level declarations only.
   */
  readonly declarationStart: number;

  /** Whether it is a class member, which can never be a module export. */
  readonly classMember: boolean;
}

/** One classified database call site, before it becomes a node and an edge. */
interface DbCallCandidate {
  /**
   * The callee — the property access, or a tagged template's tag — whose 1-based
   * position anchors the node and the edge site.
   *
   * The callee rather than the whole call expression, so that two calls in one
   * function are distinct in `makeNodeId` and so that the position a developer
   * is taken to is the member access they recognise.
   */
  readonly callee: Node;

  /** The last line of the whole call expression, never before the callee's line. */
  readonly endLine: number;

  /** The node's name: the receiver key and the member chain, dot-joined. */
  readonly name: string;

  /** The payload, which carries the heuristic marker only on the heuristic path. */
  readonly data: DbCallNodeData;
}

/* -------------------------------------------------------------------------------------------------
 * Small syntactic helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 1-based line and column a node starts at, excluding leading trivia.
 *
 * 1-based on both axes, which is the convention `CodeNodeBase.line` fixes for
 * the whole product and which `SourceLocation` shares; the single conversion to
 * an editor's 0-based position happens in the VS Code extension, so nothing
 * between here and there has to remember which convention it holds.
 *
 * @param node The node to locate — a callee, so that the recorded position is
 * the member access a developer expects an editor to jump to.
 * @returns The node's 1-based position.
 */
function positionOf(node: Node): Position {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());

  return { line, column };
}

/**
 * The 1-based position of a node, or the start of the file when reading it
 * throws.
 *
 * Used only from a `catch`, where the node under inspection is by definition
 * one that misbehaved: a diagnostic about it must not itself throw, and line 1
 * column 1 is in range while `0` would not be.
 *
 * @param node The node to locate.
 * @returns Its position, or `{ line: 1, column: 1 }`.
 */
function safePositionOf(node: Node): Position {
  try {
    return positionOf(node);
  } catch {
    return { line: FILE_NODE_LINE, column: FILE_NODE_COLUMN };
  }
}

/**
 * A node's text, or `undefined` when it is empty.
 *
 * An empty name is what a partial parse of broken source produces, and a node
 * named by one would be unfindable by every query in the graph.
 *
 * @param node The node to read.
 * @returns Its text, or `undefined`.
 */
function nonEmptyText(node: Node): string | undefined {
  const text = node.getText();

  return text.length === 0 ? undefined : text;
}

/**
 * The expression inside every transparent wrapper: parentheses, an `as` or
 * `satisfies` assertion, a non-null assertion, and `await`.
 *
 * None of the five changes what an expression evaluates to, and all five sit
 * routinely between a declaration and its construction
 * (`const pool = (new Pool(…)) as Pool`) or between a borrow and its
 * connection (`const client = await pool.connect()`). Bounded by
 * {@link MAX_WRAPPER_DEPTH}.
 *
 * @param expression The expression to unwrap.
 * @returns The innermost wrapped expression, or the input when it is not
 * wrapped.
 */
function unwrapExpression(expression: Node): Node {
  let current: Node = expression;

  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isAwaitExpression(current)
    ) {
      current = current.getExpression();

      continue;
    }

    return current;
  }

  return current;
}

/**
 * Whether a declaration sits directly at module level.
 *
 * The scope `./symbols.ts` records nodes within, and therefore the scope the
 * cascade may point an edge at: a declaration inside a function body, a block,
 * a class expression or a namespace body has no `symbol` node, which is why the
 * cascade walks past one rather than naming a node nobody emits.
 *
 * @param node The declaration or statement to test.
 * @returns `true` when its parent is the source file.
 */
function isModuleLevel(node: Node): boolean {
  return Node.isSourceFile(node.getParent());
}

/**
 * Whether a class member belongs to a module-level class **declaration**.
 *
 * A class expression (`const C = class { … }`) and a class declared inside a
 * function body yield no member nodes, so their members are not addressable
 * owners.
 *
 * @param member The class member.
 * @returns `true` when its class is a module-level class declaration.
 */
function hasModuleLevelClass(member: Node): boolean {
  const owner = member.getParent();

  return Node.isClassDeclaration(owner) && isModuleLevel(owner);
}

/**
 * The name a declaration member is recorded under, or `undefined` when it is
 * not statically known.
 *
 * Reproduces `./symbols.ts`'s name reading: an identifier or private identifier
 * as written, a string-literal member name unquoted, a numeric name as written,
 * and `undefined` for a computed name — which no lookup could ever match, so no
 * edge may point at one.
 *
 * @param nameNode The member's name node.
 * @returns The recorded name, or `undefined`.
 */
function memberName(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) {
    return nonEmptyText(nameNode);
  }

  if (Node.isNumericLiteral(nameNode)) {
    return nonEmptyText(nameNode);
  }

  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    const literal = nameNode.getLiteralValue();

    return literal.length === 0 ? undefined : literal;
  }

  return undefined;
}

/**
 * Whether an initialiser holds a function, which is what a `server-function`
 * node requires of a variable declaration.
 *
 * Transparent wrappers are looked through; a wrapping *call*
 * (`memo(() => …)`, `useCallback(fn)`) deliberately is not, because
 * `./server-functions.ts` reads the same shape the same way and a disagreement
 * would cost the edge.
 *
 * @param initializer The declarator's initialiser, or `undefined`.
 * @returns `true` when it is an arrow function or a function expression.
 */
function isFunctionValued(initializer: Node | undefined): boolean {
  if (initializer === undefined) {
    return false;
  }

  const expression = unwrapExpression(initializer);

  return Node.isArrowFunction(expression) || Node.isFunctionExpression(expression);
}

/**
 * The last path segment of a file, without its extension, or `undefined` when
 * there is none.
 *
 * Spelled locally rather than imported so that this module's only
 * `@debuggen/shared` import stays the path refinement every node depends on;
 * the answer is used for module *shape* only.
 *
 * @param file The project-relative POSIX path.
 * @returns The basename without its extension, or `undefined`.
 */
function basenameStem(file: string): string | undefined {
  const segments = file.split('/');
  const last = segments[segments.length - 1];

  if (last === undefined || last.length === 0) {
    return undefined;
  }

  const dot = last.lastIndexOf('.');

  return dot <= 0 ? last : last.slice(0, dot);
}

/**
 * Whether a module is a route or page module of either router convention.
 *
 * The roots are the conventional four (`app/`, `src/app/`, `pages/`,
 * `src/pages/`). Every module under the legacy Pages Router is a page or an
 * API route; under the App Router it is the file's stem that settles it.
 *
 * This is a question about **module shape**, not about URLs: it decides whether
 * a module's exported functions are service functions or framework entry
 * points. What URL a file serves has exactly one owner, `../route-map.ts`, and
 * nothing here attempts to answer it.
 *
 * @param file The module's project-relative POSIX path.
 * @returns `true` when the module is a route or page module.
 */
function isRouteOrPageModule(file: string): boolean {
  const segments = file.split('/');
  const rootIndex = segments[0] === SOURCE_DIRECTORY ? 1 : 0;
  const root = segments[rootIndex];

  if (root === PAGES_ROUTER_DIRECTORY) {
    return segments.length > rootIndex + 1;
  }

  if (root !== APP_ROUTER_DIRECTORY) {
    return false;
  }

  const stem = basenameStem(file);

  return stem !== undefined && ROUTE_MODULE_STEMS.includes(stem);
}

/**
 * Whether a module-level declaration's name has the component shape: a leading
 * upper-case letter.
 *
 * @param name The declared name.
 * @returns `true` when the name starts with an upper-case letter.
 */
function hasComponentName(name: string): boolean {
  const initial = name.charAt(0);

  return initial.length > 0 && initial !== initial.toLowerCase();
}

/**
 * Whether a module declares anything that *could* be a React component.
 *
 * Deliberately **permissive**: a module-level upper-case-named declaration, or
 * any `export default` expression, is enough. This is not component
 * *detection* — `./react-components.ts` owns that, with a stricter
 * "returns markup" rule — it is the guard that keeps the cascade's
 * server-function branch away from a module whose exported functions are
 * components. Over-answering `true` can only move an edge from a
 * `server-function` node to a `symbol` node, both of which exist;
 * under-answering could point an edge at a `server-function` node nobody emits,
 * which graph assembly would drop.
 *
 * @param sourceFile The module to inspect.
 * @returns `true` when the module declares a possible component.
 */
function declaresComponentName(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.getStatements()) {
    // `export default <expression>` names no declaration of its own, and an
    // anonymous default export is the one component shape with no name to test.
    if (Node.isExportAssignment(statement)) {
      return true;
    }

    if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) {
      const name = statement.getName();

      if (name === undefined ? statement.hasDefaultKeyword() : hasComponentName(name)) {
        return true;
      }

      continue;
    }

    if (!Node.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();

      if (Node.isIdentifier(nameNode) && hasComponentName(nameNode.getText())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Whether a module contains markup anywhere.
 *
 * The other half of the permissive component-module guard, stopped at the first
 * element found: this is a question about the module, not an inventory.
 *
 * @param sourceFile The module to scan.
 * @returns `true` when the module contains a markup element or fragment.
 */
function containsJsx(sourceFile: SourceFile): boolean {
  let found = false;

  sourceFile.forEachDescendant((node, traversal) => {
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)) {
      found = true;
      traversal.stop();
    }
  });

  return found;
}

/**
 * The start offsets of the module-level declarations that leave this module
 * **as functions** — its exported-function identity set, and the whole of the
 * `server-function` step's evidence.
 *
 * A `server-function` node exists for a declaration exactly when
 * `./server-functions.ts` resolved it through its module's *export surface*, so
 * that surface — not the `export` keyword — is what the cascade has to ask
 * about. The forms collected here are the forms that extractor collects, and
 * the reason each one counts:
 *
 * - a module-level **function declaration** exported by keyword
 *   (`export function load() {}`), by `export default`
 *   (`export default function load() {}`, and the nameless
 *   `export default function () {}`), or named by a local export clause
 *   (`export { load }`, `export { load as read }`, `export { load as default }`);
 * - a module-level **function-valued variable declarator** exported by keyword
 *   (`export const load = async () => {}`) or named by a local export clause,
 *   judged by {@link isFunctionValued} so that the two extractors read one
 *   initialiser the same way;
 * - the identifier form `export default load`, which exports a declaration
 *   written elsewhere in the module;
 * - `export default <function expression>`, where the export statement *is* the
 *   declaration — see {@link addressableDeclarationOf} for the one shape of it
 *   this module claims.
 *
 * Two passes, because a clause or a default assignment may precede the
 * declaration it names: the first records every module-level function under its
 * declared name and marks the keyword and `export default` exports, the second
 * applies the clause and default intents to the names they resolve to. A clause
 * carrying a module specifier (`export { load } from './x'`) declares nothing
 * local and is ignored; a type-only clause or specifier exports no value and is
 * ignored by {@link collectExportDeclaration} itself. `export =` is a
 * TypeScript-only form no ECMAScript import can bind.
 *
 * What is deliberately **not** collected is a declaration that is exported but
 * is not a function (a `const` holding a handle, a class), because the
 * `server-function` step also requires {@link AddressableDeclaration.functionValued},
 * and a class member, which shares its class's name space rather than the
 * module's.
 *
 * @param sourceFile The file under extraction.
 * @returns The start offsets of its exported functions.
 */
function collectExportedFunctions(sourceFile: SourceFile): ReadonlySet<number> {
  const exported = new Set<number>();

  /** Declared name → the start offset of the module-level function it names. */
  const declared = new Map<string, number>();
  const clauses: { readonly localName: string; readonly exportedAs: string }[] = [];
  const defaultIntents: string[] = [];

  // Filled by the shared clause reader and discarded with this walk: a
  // module-specifier re-export names a *target module's* binding, so it can
  // never mark a declaration of this file.
  const foreignReexports: ReexportClause[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      collectExportedFunctionDeclaration(statement, declared, exported);

      continue;
    }

    if (Node.isVariableStatement(statement)) {
      collectExportedDeclarators(statement, declared, exported);

      continue;
    }

    if (Node.isExportDeclaration(statement)) {
      collectExportDeclaration(statement, clauses, foreignReexports);

      continue;
    }

    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      collectExportedDefault(statement, defaultIntents, exported);
    }
  }

  // Second pass. `export { load }`, `export { load as read }` and
  // `export default load` differ only in the *name* the function leaves under,
  // which this set does not record, so all three are the same intent here: the
  // declaration they name leaves the module as a function.
  for (const clause of clauses) {
    const start = declared.get(clause.localName);

    if (start !== undefined) {
      exported.add(start);
    }
  }

  for (const name of defaultIntents) {
    const start = declared.get(name);

    if (start !== undefined) {
      exported.add(start);
    }
  }

  return exported;
}

/**
 * Records one module-level function declaration in the export-identity walk:
 * always under its declared name, and as an export when the declaration itself
 * says so.
 *
 * A later declaration of the same name replaces an earlier one, which is what
 * makes an **overloaded** function resolve to its implementation — the
 * declaration a call site actually sits inside, and the one
 * `./server-functions.ts` anchors its node at. A nameless declaration that is
 * not a default export is what the parser produces for broken source
 * (`export function {`); it names nothing a clause could reach and holds no
 * node.
 *
 * @param declaration The function declaration.
 * @param declared The module's function declarations by name, appended to.
 * @param exported The export-identity set, appended to.
 */
function collectExportedFunctionDeclaration(
  declaration: FunctionDeclaration,
  declared: Map<string, number>,
  exported: Set<number>,
): void {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode === undefined ? undefined : memberName(nameNode);
  const start = declaration.getStart();

  if (declaredName !== undefined) {
    declared.set(declaredName, start);
  }

  // `export default function () {}` and `export default function load() {}`
  // both leave the module, the first under no name of its own.
  if (declaration.hasDefaultKeyword()) {
    exported.add(start);

    return;
  }

  if (declaration.hasExportKeyword() && declaredName !== undefined) {
    exported.add(start);
  }
}

/**
 * Records the function-valued declarators of one module-level variable
 * statement in the export-identity walk.
 *
 * A destructured declarator binds several names and none of them is the
 * declarator, so it can hold no function this cascade could name; a declarator
 * whose initialiser is not a function is not a `server-function` whatever
 * exports it.
 *
 * @param statement The variable statement.
 * @param declared The module's function declarations by name, appended to.
 * @param exported The export-identity set, appended to.
 */
function collectExportedDeclarators(
  statement: VariableStatement,
  declared: Map<string, number>,
  exported: Set<number>,
): void {
  const hasKeyword = statement.hasExportKeyword();

  for (const declaration of statement.getDeclarations()) {
    const nameNode = declaration.getNameNode();

    if (!Node.isIdentifier(nameNode) || !isFunctionValued(declaration.getInitializer())) {
      continue;
    }

    const declaredName = memberName(nameNode);

    if (declaredName === undefined) {
      continue;
    }

    const start = declaration.getStart();

    declared.set(declaredName, start);

    if (hasKeyword) {
      exported.add(start);
    }
  }
}

/**
 * Records one `export default <expression>` statement in the export-identity
 * walk.
 *
 * The expression either **names** a declaration written elsewhere in the module
 * — recorded as an intent and applied in the second pass, since it may precede
 * that declaration — or **is** a function, in which case the export statement
 * is itself the declaration and is recorded under its own start offset.
 *
 * Only a *directly* written function expression is recorded, which is the same
 * narrowing {@link addressableDeclarationOf} applies and for the reason stated
 * there: a wrapped form is anchored differently by the two extractors whose
 * node ids this module spells, and a node id that differs by one column is a
 * dropped edge rather than an imprecise one.
 *
 * @param statement The export assignment, known not to be `export =`.
 * @param defaultIntents Identifier intents, appended to.
 * @param exported The export-identity set, appended to.
 */
function collectExportedDefault(
  statement: ExportAssignment,
  defaultIntents: string[],
  exported: Set<number>,
): void {
  const expression = statement.getExpression();

  if (Node.isIdentifier(expression)) {
    const name = nonEmptyText(expression);

    if (name !== undefined) {
      defaultIntents.push(name);
    }

    return;
  }

  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    exported.add(statement.getStart());
  }
}

/**
 * What the file under extraction's own syntax says, for the owner cascade.
 *
 * @param ctx The file being visited.
 * @returns The module's facts.
 */
function moduleFactsOf(ctx: ExtractorContext): ModuleFacts {
  return {
    routeModule: isRouteOrPageModule(ctx.file),
    componentModule: containsJsx(ctx.sourceFile) && declaresComponentName(ctx.sourceFile),
    exportedFunctions: collectExportedFunctions(ctx.sourceFile),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Statement shape — the privacy boundary of this module
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a character is an ASCII digit.
 *
 * Spelled as a comparison rather than a regular expression because the
 * tokeniser asks it per character, and because a Unicode digit is not part of
 * a numeric literal any statement dialect accepts.
 *
 * @param char A single character.
 * @returns `true` for `0`–`9`.
 */
function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/**
 * Whether a character can appear inside an identifier, for the purpose of
 * deciding whether a digit begins a numeric literal.
 *
 * `col1` and `t2.c` hold digits that are part of a name, not values, so a digit
 * preceded by one of these characters is left alone.
 *
 * @param char A single character, or the empty string at the start of input.
 * @returns `true` when the character can be part of an identifier or a
 * qualified name.
 */
function isIdentifierChar(char: string): boolean {
  return (
    isDigit(char) ||
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    char === '_' ||
    char === '$' ||
    char === '.'
  );
}

/**
 * Whether a character is statement whitespace.
 *
 * @param char A single character.
 * @returns `true` for a space, tab, carriage return, line feed or form feed.
 */
function isStatementWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f';
}

/**
 * The index just past a single-quoted string literal that starts at `start`.
 *
 * Two escape conventions are both honoured — a doubled quote (`''`, the
 * standard form) and a backslash escape (the form some dialects and some
 * configurations accept) — because the two disagree about where a literal ends
 * and this function must not end one **early**. Consuming too much collapses a
 * little more of the statement into a placeholder; consuming too little would
 * emit the tail of a literal as statement text, which is exactly the leak this
 * whole function exists to prevent. An unterminated literal consumes to the end
 * of the text, for the same reason.
 *
 * @param text The statement text.
 * @param start The index of the opening quote.
 * @returns The index just past the closing quote, or the text's length.
 */
function skipSingleQuoted(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length) {
    const char = text.charAt(index);

    if (char === '\\') {
      index += 2;

      continue;
    }

    if (char !== "'") {
      index += 1;

      continue;
    }

    // A doubled quote is an escaped quote and the literal continues.
    if (text.charAt(index + 1) === "'") {
      index += 2;

      continue;
    }

    return index + 1;
  }

  return text.length;
}

/**
 * The index just past a double-quoted identifier that starts at `start`.
 *
 * A doubled quote inside one is an escaped quote, the same rule the standard
 * fixes for delimited identifiers.
 *
 * @param text The statement text.
 * @param start The index of the opening quote.
 * @returns The index just past the closing quote, or the text's length.
 */
function skipDoubleQuoted(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length) {
    if (text.charAt(index) !== '"') {
      index += 1;

      continue;
    }

    if (text.charAt(index + 1) === '"') {
      index += 2;

      continue;
    }

    return index + 1;
  }

  return text.length;
}

/**
 * The index just past the opening tag of a dollar-quoted string literal, or
 * `-1` when `start` does not begin one.
 *
 * `$$` and `$tag$` both open one, and the same tag closes it. Recognising the
 * form matters because its body is a *value* — dollar quoting is how a
 * statement embeds text that would otherwise need escaping — so it must become
 * a placeholder rather than survive as statement text.
 *
 * @param text The statement text.
 * @param start The index of the leading `$`.
 * @returns The index just past the opening tag, or `-1`.
 */
function dollarQuoteTagEnd(text: string, start: number): number {
  let index = start + 1;
  let first = true;

  while (index < text.length) {
    const char = text.charAt(index);

    if (char === '$') {
      return index + 1;
    }

    // A tag is an identifier — a letter or underscore, then letters, digits or
    // underscores — and anything else means this `$` opens no literal.
    const letter = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';

    if (!(letter || (!first && isDigit(char)))) {
      return -1;
    }

    first = false;
    index += 1;
  }

  return -1;
}

/**
 * The index just past a numeric literal that starts at `start`.
 *
 * Digits, at most one decimal point, and an optional exponent — enough to
 * consume the numeric forms a statement can hold as a whole rather than leaving
 * a fragment of one behind.
 *
 * @param text The statement text.
 * @param start The index of the first digit.
 * @returns The index just past the literal.
 */
function skipNumber(text: string, start: number): number {
  let index = start;
  let seenPoint = false;

  while (index < text.length) {
    const char = text.charAt(index);

    if (isDigit(char)) {
      index += 1;

      continue;
    }

    if (char === '.' && !seenPoint && isDigit(text.charAt(index + 1))) {
      seenPoint = true;
      index += 2;

      continue;
    }

    if ((char === 'e' || char === 'E') && index > start) {
      const next = text.charAt(index + 1);
      const afterSign = text.charAt(index + 2);

      if (isDigit(next)) {
        index += 2;

        continue;
      }

      if ((next === '+' || next === '-') && isDigit(afterSign)) {
        index += 3;

        continue;
      }
    }

    break;
  }

  return index;
}

/**
 * The **shape** of a statement: what the source says about its structure, with
 * every value removed.
 *
 * The single place `DbCallNodeData.statementShape` is produced, and the single
 * place this module's privacy rule is enforced (AAP 0.5.2). One pass of a small
 * tokeniser rather than a chain of regular expressions, because the constructs
 * overlap — a comment can contain a quote, a literal can contain `--`, a
 * placeholder and a dollar-quoted literal both start with `$` — and a chain of
 * patterns gets exactly those cases wrong, in the direction that leaks.
 *
 * What the pass does, per construct:
 *
 * - **comments** (`-- …` to end of line, `/* … *\/`) — dropped entirely,
 *   because a comment is prose a developer wrote and prose can hold anything;
 * - **single-quoted and dollar-quoted literals** — replaced by
 *   {@link VALUE_PLACEHOLDER}, whatever they contain and however they are
 *   escaped;
 * - **standalone numeric literals** — replaced by the same placeholder, while a
 *   digit inside a name (`col1`) is left alone;
 * - **`$1`-style parameter placeholders** — **preserved verbatim**: they are the
 *   shape, they are what makes two call sites comparable, and they are the
 *   evidence that a statement is parameterised at all;
 * - **double-quoted identifiers** — preserved, since a delimited identifier
 *   names a table or a column rather than a value;
 * - **whitespace** — collapsed to single spaces, and trimmed at both ends.
 *
 * The result is capped at {@link MAX_STATEMENT_SHAPE_LENGTH} characters, the cap
 * that payload field documents; truncation is silent, so a consumer must not
 * assume the text is a complete statement. An input longer than
 * {@link MAX_STATEMENT_SOURCE_LENGTH} is cut before tokenising, which bounds the
 * work rather than the answer. A shape that reduces to nothing — an empty
 * statement, or one that was only a comment — is reported as `undefined`, since
 * an empty string says less than an absent field.
 *
 * @param text The statement text, already resolved from literals and
 * substitutions by {@link renderStatement}, or `undefined`.
 * @returns The shape, or `undefined` when there is none to record.
 */
function statementShapeOf(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  const source =
    text.length > MAX_STATEMENT_SOURCE_LENGTH ? text.slice(0, MAX_STATEMENT_SOURCE_LENGTH) : text;
  const parts: string[] = [];
  let pendingSpace = false;
  let index = 0;

  /**
   * Appends one piece of shape, inserting a single space for any whitespace run
   * that preceded it. A leading run is dropped (nothing precedes it) and a
   * trailing one never reaches this function, which is the whole of the
   * collapse rule.
   */
  const push = (value: string): void => {
    if (pendingSpace && parts.length > 0) {
      parts.push(' ');
    }

    pendingSpace = false;
    parts.push(value);
  };

  while (index < source.length) {
    const char = source.charAt(index);

    if (isStatementWhitespace(char)) {
      pendingSpace = true;
      index += 1;

      continue;
    }

    // A line comment: dropped, and treated as whitespace so the tokens either
    // side do not run together.
    if (char === '-' && source.startsWith('--', index)) {
      let end = index + 2;

      while (end < source.length && source.charAt(end) !== '\n' && source.charAt(end) !== '\r') {
        end += 1;
      }

      pendingSpace = true;
      index = end;

      continue;
    }

    // A block comment, on the same terms. An unterminated one runs to the end.
    if (char === '/' && source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);

      pendingSpace = true;
      index = close === -1 ? source.length : close + 2;

      continue;
    }

    if (char === "'") {
      index = skipSingleQuoted(source, index);
      push(VALUE_PLACEHOLDER);

      continue;
    }

    if (char === '"') {
      const end = skipDoubleQuoted(source, index);

      push(source.slice(index, end));
      index = end;

      continue;
    }

    if (char === '$') {
      // `$1` … `$n`: a parameter placeholder, kept exactly as written.
      let digitsEnd = index + 1;

      while (digitsEnd < source.length && isDigit(source.charAt(digitsEnd))) {
        digitsEnd += 1;
      }

      if (digitsEnd > index + 1) {
        push(source.slice(index, digitsEnd));
        index = digitsEnd;

        continue;
      }

      // `$$…$$` or `$tag$…$tag$`: a literal, and therefore a placeholder.
      const tagEnd = dollarQuoteTagEnd(source, index);

      if (tagEnd !== -1) {
        const tag = source.slice(index, tagEnd);
        const close = source.indexOf(tag, tagEnd);

        push(VALUE_PLACEHOLDER);
        index = close === -1 ? source.length : close + tag.length;

        continue;
      }

      push(char);
      index += 1;

      continue;
    }

    if (isDigit(char) && !isIdentifierChar(index === 0 ? '' : source.charAt(index - 1))) {
      index = skipNumber(source, index);
      push(VALUE_PLACEHOLDER);

      continue;
    }

    push(char);
    index += 1;
  }

  const shape = parts.join('').trim();

  if (shape.length === 0) {
    return undefined;
  }

  return shape.length > MAX_STATEMENT_SHAPE_LENGTH
    ? shape.slice(0, MAX_STATEMENT_SHAPE_LENGTH)
    : shape;
}

/**
 * The text a template literal stands for, with every substitution replaced by
 * {@link VALUE_PLACEHOLDER}.
 *
 * A substitution is a value by definition — it is the part of the statement the
 * source does not contain — so it never contributes text, and a template with
 * even one substitution is `dynamic`.
 *
 * @param template The template literal, with or without substitutions.
 * @returns The rendered text and whether anything was substituted.
 */
function renderTemplate(template: Node): RenderedStatement {
  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    return { text: template.getLiteralValue(), dynamic: false };
  }

  if (!Node.isTemplateExpression(template)) {
    return { text: undefined, dynamic: true };
  }

  const parts: string[] = [template.getHead().getLiteralText()];

  for (const span of template.getTemplateSpans()) {
    parts.push(VALUE_PLACEHOLDER, span.getLiteral().getLiteralText());
  }

  return { text: parts.join(''), dynamic: true };
}

/**
 * What the source says a statement expression is.
 *
 * Four forms are read, and everything else answers "no text, and dynamic":
 *
 * - a **string literal** or a substitution-free template — the statement, in
 *   full, as the decoded literal *value* so that an escape sequence resolves to
 *   the character the driver receives;
 * - a **template with substitutions** — its literal spans, with each
 *   substitution replaced by a placeholder;
 * - a **concatenation** of the above — rendered part by part, with a part that
 *   cannot be read contributing a placeholder, which is how a statement
 *   assembled from a constant prefix and a computed clause keeps the half the
 *   source does state;
 * - the driver's **configuration-object** form — its `text` property, read by
 *   the same rules. The sibling `values` property is never looked at.
 *
 * A bare variable, a helper call, a member access: no text and `dynamic: true`,
 * which is `DbCallNodeData.dynamic`'s "a variable, a helper call" case and the
 * reason no shape is recorded for one. Bounded by {@link MAX_RENDER_DEPTH}.
 *
 * @param expression The first argument of the call, or `undefined` when the
 * call has none.
 * @param depth The current recursion depth.
 * @returns The rendered statement.
 */
function renderStatement(expression: Node | undefined, depth = 0): RenderedStatement {
  if (expression === undefined || depth >= MAX_RENDER_DEPTH) {
    return { text: undefined, dynamic: true };
  }

  const node = unwrapExpression(expression);

  if (Node.isStringLiteral(node)) {
    return { text: node.getLiteralValue(), dynamic: false };
  }

  if (Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node)) {
    return renderTemplate(node);
  }

  if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '+') {
    const left = renderStatement(node.getLeft(), depth + 1);
    const right = renderStatement(node.getRight(), depth + 1);
    const text = `${left.text ?? VALUE_PLACEHOLDER}${right.text ?? VALUE_PLACEHOLDER}`;

    return {
      text,
      dynamic: left.dynamic || right.dynamic || left.text === undefined || right.text === undefined,
    };
  }

  if (Node.isObjectLiteralExpression(node)) {
    const property = node.getProperty(PG_QUERY_CONFIG_TEXT_PROPERTY);

    if (property !== undefined && Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();

      if (initializer !== undefined) {
        return renderStatement(initializer, depth + 1);
      }
    }

    return { text: undefined, dynamic: true };
  }

  return { text: undefined, dynamic: true };
}

/**
 * The operation a statement shape names, when its leading keyword is one this
 * module reports.
 *
 * The first alphabetic word of the shape — so a parenthesised statement is read
 * as well — lower-cased, and accepted only if it is in
 * {@link SQL_LEADING_KEYWORDS}. A shape whose leading token was substituted away
 * leaves the field unset, which is the honest answer: the source does not say
 * what the statement does.
 *
 * @param shape The statement shape, or `undefined`.
 * @returns The operation, or `undefined`.
 */
function leadingStatementOperation(shape: string | undefined): string | undefined {
  if (shape === undefined) {
    return undefined;
  }

  for (const word of shape.split(/[^A-Za-z]+/)) {
    if (word.length === 0) {
      continue;
    }

    const keyword = word.toLowerCase();

    return SQL_LEADING_KEYWORDS.includes(keyword) ? keyword : undefined;
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Discovery step 1 — construction, and step 4 — annotation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The name a construction constructs, or `undefined` when it cannot be read.
 *
 * Both spellings of a class reference: the bare identifier (`new Pool(…)`) and
 * a qualified one (`new pg.Pool(…)`), for which the **member** name is the
 * class. A computed or otherwise exotic callee answers `undefined`; no type is
 * resolved and no import is followed, so the judgement is the same whether or
 * not the target project's dependencies are installed.
 *
 * @param callee The `new` expression's callee.
 * @returns The constructed class's name, or `undefined`.
 */
function constructedClassName(callee: Node): string | undefined {
  if (Node.isIdentifier(callee)) {
    return nonEmptyText(callee);
  }

  if (Node.isPropertyAccessExpression(callee)) {
    return memberName(callee.getNameNode());
  }

  return undefined;
}

/**
 * **Discovery step 1.** The driver an expression constructs, or `undefined`
 * when it constructs no handle.
 *
 * The primary step, and the one the other structural steps lead back to: a
 * variable or class property initialised with `new PrismaClient(…)` holds a
 * generated-client handle, one initialised with `new Pool(…)` holds a pooled
 * handle. Both names are the *driver library's* own classes, which is what
 * makes matching them framework-level rather than application knowledge.
 *
 * @param expression The initialiser to read.
 * @returns The driver, or `undefined`.
 */
function constructedDriver(expression: Node): DbDriver | undefined {
  const node = unwrapExpression(expression);

  if (!Node.isNewExpression(node)) {
    return undefined;
  }

  const name = constructedClassName(node.getExpression());

  if (name === PRISMA_CLIENT_CLASS) {
    return 'prisma';
  }

  return name === PG_POOL_CLASS ? 'pg' : undefined;
}

/**
 * **Discovery step 4.** The handle a type annotation declares, or `undefined`
 * when it declares none.
 *
 * Every spelling a project reaches for, read as abstract-syntax-tree text and
 * never through the checker: bare (`Pool`), qualified (`pg.Pool`),
 * import-qualified (`import('pg').Pool`), and any member of a union
 * (`PoolClient | undefined`, which is what a lazily borrowed connection looks
 * like). Type arguments are ignored, so `Promise<PoolClient>` is correctly *not*
 * a handle: a promise of a connection is not a connection.
 *
 * This step is what makes a function that *receives* a handle analysable —
 * `function load(db: PrismaClient)` — which is the shape a project uses when it
 * passes the client rather than importing it.
 *
 * @param typeNode The annotation, or `undefined` when there is none.
 * @returns The handle, or `undefined`.
 */
function annotatedHandle(typeNode: TypeNode | undefined): DriverHandle | undefined {
  if (typeNode === undefined) {
    return undefined;
  }

  if (Node.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.getTypeNodes()) {
      const handle = annotatedHandle(member);

      if (handle !== undefined) {
        return handle;
      }
    }

    return undefined;
  }

  const text = typeNode.getText();
  const withoutArguments = text.includes('<') ? text.slice(0, text.indexOf('<')) : text;
  const segments = withoutArguments.trim().split('.');
  const name = segments[segments.length - 1]?.trim();

  if (name === PRISMA_CLIENT_CLASS) {
    return { driver: 'prisma', discovery: 'annotation' };
  }

  return name === PG_POOL_CLASS || name === PG_POOL_CLIENT_TYPE
    ? { driver: 'pg', discovery: 'annotation' }
    : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Module surfaces — what a module binds, for the cross-file walk
 * ---------------------------------------------------------------------------------------------- */

/**
 * The module a specifier resolves to, or `undefined` when it resolves to
 * nothing.
 *
 * The one place this extractor asks for resolution, and the reason discovery
 * step 2 works at all: `getModuleSpecifierSourceFile()` applies the target
 * project's own configuration, so an aliased (`@/lib/store`) or extensionless
 * specifier resolves exactly as the project's own tooling resolves it, and
 * nothing here has to re-implement module resolution.
 *
 * Wrapped in a `try` because resolution is the one step that can throw on an
 * exotic specifier — a malformed path, an unsupported protocol — and an
 * unresolved specifier is a perfectly ordinary state: every dependency of an
 * uninstalled project is one. It is therefore treated as "no module" rather
 * than as a failure, which is also what keeps `extract` from throwing when
 * resolution does.
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
 * Records the local bindings one import declaration introduces.
 *
 * Named, default and namespace bindings are all recorded, because a handle
 * arrives through each of them in real projects
 * (`import { pool } from …`, `import prisma from …`,
 * `import * as store from …`). A type-only declaration or specifier binds
 * nothing at run time and is skipped: a module that imports a client's *types*
 * constructs nothing. The first binding of a name wins, which is the language's
 * own rule for a duplicate.
 *
 * @param declaration The import declaration.
 * @param bindings The map to append to.
 */
function collectImportBindings(
  declaration: ImportDeclaration,
  bindings: Map<string, ImportedBinding>,
): void {
  if (declaration.isTypeOnly()) {
    return;
  }

  const defaultImport = declaration.getDefaultImport();

  if (defaultImport !== undefined) {
    const local = nonEmptyText(defaultImport);

    if (local !== undefined && !bindings.has(local)) {
      bindings.set(local, Object.freeze({ declaration, exportName: DEFAULT_EXPORT_NAME }));
    }
  }

  const namespaceImport = declaration.getNamespaceImport();

  if (namespaceImport !== undefined) {
    const local = nonEmptyText(namespaceImport);

    if (local !== undefined && !bindings.has(local)) {
      bindings.set(local, Object.freeze({ declaration, exportName: NAMESPACE_IMPORT_NAME }));
    }
  }

  for (const specifier of declaration.getNamedImports()) {
    if (specifier.isTypeOnly()) {
      continue;
    }

    // `import { pool as store }` — `pool` is the name to look for upstream,
    // `store` is what this module calls it.
    const exportName = specifier.getName();
    const local = specifier.getAliasNode()?.getText() ?? exportName;

    if (exportName.length > 0 && local.length > 0 && !bindings.has(local)) {
      bindings.set(local, Object.freeze({ declaration, exportName }));
    }
  }
}

/**
 * Records one `export { … }` or `export … from` statement.
 *
 * Only the forms that can carry a *value* are recorded: a type-only clause or
 * specifier re-exports nothing a call can be made on. A clause without a module
 * specifier names a local binding and is resolved in a second pass, because it
 * may precede the declaration it names.
 *
 * The two star forms are **not** the same statement and are not recorded alike:
 *
 * - `export * from './store'` re-exports every name of its target under that
 *   same name, so a lookup for any name is worth following through it;
 * - `export * as store from './store'` binds **one namespace object** under one
 *   name and re-exports no individual name at all, so a lookup for a name is
 *   deliberately a **miss** here. Following it would resolve `pool` through a
 *   module that never binds `pool`, and a `db-call` node would then claim a
 *   driver on evidence the source does not contain. Leaving it unresolved
 *   costs, at worst, a handle reached only through a namespace object — an
 *   under-detection, never a wrong driver, which is the trade the header's
 *   "structural first" order fixes for every discovery step.
 *
 * `./server-functions.ts`'s own `collectExportDeclaration` draws the same
 * distinction for the same reason, and the two read alike on purpose.
 *
 * @param declaration The export declaration.
 * @param clauses Local clause intents, appended to.
 * @param reexports Module-specifier re-export clauses, appended to.
 */
function collectExportDeclaration(
  declaration: ExportDeclaration,
  clauses: { readonly localName: string; readonly exportedAs: string }[],
  reexports: ReexportClause[],
): void {
  if (declaration.isTypeOnly()) {
    return;
  }

  const hasSpecifier = declaration.getModuleSpecifier() !== undefined;

  // ts-morph answers `isNamespaceExport()` with "this clause holds no named
  // exports", which is true of both star forms, so it cannot be the question
  // on its own: `getNamespaceExport()` is the node that tells them apart and is
  // present only for the qualified `export * as store from` form.
  if (declaration.isNamespaceExport()) {
    if (hasSpecifier && declaration.getNamespaceExport() === undefined) {
      reexports.push(Object.freeze({ declaration, exportedAs: undefined, sourceName: undefined }));
    }

    return;
  }

  for (const specifier of declaration.getNamedExports()) {
    if (specifier.isTypeOnly()) {
      continue;
    }

    const sourceName = specifier.getName();
    const exportedAs = specifier.getAliasNode()?.getText() ?? sourceName;

    if (sourceName.length === 0 || exportedAs.length === 0) {
      continue;
    }

    if (hasSpecifier) {
      reexports.push(Object.freeze({ declaration, exportedAs, sourceName }));

      continue;
    }

    clauses.push(Object.freeze({ localName: sourceName, exportedAs }));
  }
}

/**
 * What one module binds, read once and cached.
 *
 * Module-level variable declarators (the only declaration form a handle can
 * live in), the export names those are reachable under, module-specifier
 * re-exports, and the module's own import bindings — which is what lets the
 * walk cross a module that merely passes a handle through
 * (`import { pool } from './pg'; export { pool };`).
 *
 * @param module The module to read.
 * @returns Its surface.
 */
function collectSurface(module: SourceFile): ModuleSurface {
  const locals = new Map<string, Node>();
  const exportedNames = new Map<string, string>();
  const directExports = new Map<string, Node>();
  const reexports: ReexportClause[] = [];
  const imports = new Map<string, ImportedBinding>();
  const clauses: { readonly localName: string; readonly exportedAs: string }[] = [];

  for (const statement of module.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      const exported = statement.hasExportKeyword();

      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();

        // A destructured declarator binds several names and none of them is the
        // declarator, so it can hold no handle this walk could name.
        if (!Node.isIdentifier(nameNode)) {
          continue;
        }

        const name = nonEmptyText(nameNode);

        if (name === undefined || locals.has(name)) {
          continue;
        }

        locals.set(name, declaration);

        if (exported) {
          exportedNames.set(name, name);
        }
      }

      continue;
    }

    if (Node.isImportDeclaration(statement)) {
      collectImportBindings(statement, imports);

      continue;
    }

    if (Node.isExportDeclaration(statement)) {
      collectExportDeclaration(statement, clauses, reexports);

      continue;
    }

    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      const expression = statement.getExpression();
      const local = Node.isIdentifier(expression) ? nonEmptyText(expression) : undefined;

      if (local === undefined) {
        // `export default new PrismaClient()` — the declaration *is* the export.
        directExports.set(DEFAULT_EXPORT_NAME, statement);
      } else {
        exportedNames.set(DEFAULT_EXPORT_NAME, local);
      }
    }
  }

  // Second pass: a clause may name a declaration or an import that follows it.
  for (const clause of clauses) {
    if (locals.has(clause.localName) || imports.has(clause.localName)) {
      exportedNames.set(clause.exportedAs, clause.localName);
    }
  }

  return Object.freeze({
    locals,
    exportedNames,
    directExports,
    reexports: Object.freeze(reexports),
    imports,
  });
}

/**
 * A module's surface, computed once per `extract` call.
 *
 * @param state The per-call memoisation.
 * @param module The module to read.
 * @returns Its surface.
 */
function surfaceOf(state: DiscoveryState, module: SourceFile): ModuleSurface {
  const key = module.getFilePath();
  const cached = state.surfaces.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const surface = collectSurface(module);

  state.surfaces.set(key, surface);

  return surface;
}

/** A fresh per-`extract` discovery state. */
function newDiscoveryState(): DiscoveryState {
  return { surfaces: new Map<string, ModuleSurface>(), pending: new Set<string>() };
}

/* -------------------------------------------------------------------------------------------------
 * Discovery steps 2 and 3 — the resolution walk
 * ---------------------------------------------------------------------------------------------- */

/**
 * The declaration a name resolves to in the enclosing scopes of a site,
 * innermost first, or `undefined` when no enclosing scope declares it.
 *
 * The language's own scoping order, and the reason a function-local binding is
 * never confused with a module-level or imported one of the same name: a
 * `const client = await pool.connect()` inside one function is that function's
 * connection, and a same-named local in another function is a different one.
 * Statements are examined before parameters at each level, because a `const` in
 * a function body shadows a parameter of the same name.
 *
 * The module scope is included — a source file is statemented — so a
 * module-level declaration resolves here too. Import declarations are *not*
 * statements of that kind, so an imported binding correctly resolves to nothing
 * here and is looked up in the module's surface instead.
 *
 * Only variable declarators and parameters are considered: those are the forms
 * a handle can be bound by, and a function or class declaration of the same
 * name is not one.
 *
 * @param site The use site the walk starts at.
 * @param name The name to look for.
 * @returns The declaration node, or `undefined`.
 */
function declarationInScopes(site: Node, name: string): Node | undefined {
  for (const ancestor of site.getAncestors()) {
    if (Node.isStatemented(ancestor)) {
      for (const statement of ancestor.getStatements()) {
        if (!Node.isVariableStatement(statement)) {
          continue;
        }

        for (const declaration of statement.getDeclarations()) {
          const nameNode = declaration.getNameNode();

          if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
            return declaration;
          }
        }
      }
    }

    if (Node.isFunctionLikeDeclaration(ancestor)) {
      for (const parameter of ancestor.getParameters()) {
        const nameNode = parameter.getNameNode();

        if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
          return parameter;
        }
      }
    }
  }

  return undefined;
}

/**
 * The class a `this` receiver refers to at a site, or `undefined` when the site
 * is not inside one.
 *
 * The innermost enclosing class, whether declared or an expression: both can
 * hold a handle as a property, and which of the two it is only matters to the
 * owner cascade, never to discovery.
 *
 * @param site The use site.
 * @returns The class, or `undefined`.
 */
function enclosingClassOf(site: Node): ClassDeclaration | ClassExpression | undefined {
  for (const ancestor of site.getAncestors()) {
    if (Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor)) {
      return ancestor;
    }

    if (Node.isSourceFile(ancestor)) {
      return undefined;
    }
  }

  return undefined;
}

/**
 * The property declaration or constructor parameter property a class holds
 * under a name, or `undefined` when it holds none.
 *
 * Both forms a class binds a handle through: a property with an initialiser or
 * an annotation, and a constructor parameter property
 * (`constructor(private readonly store: PrismaClient) {}`), which is a
 * declaration and an assignment at once and is how a class that is handed its
 * handle declares it.
 *
 * @param declaration The enclosing class.
 * @param name The property name.
 * @returns The declaration, or `undefined`.
 */
function classMemberNamed(
  declaration: ClassDeclaration | ClassExpression,
  name: string,
): Node | undefined {
  for (const property of declaration.getProperties()) {
    if (memberName(property.getNameNode()) === name) {
      return property;
    }
  }

  for (const constructorDeclaration of declaration.getConstructors()) {
    for (const parameter of constructorDeclaration.getParameters()) {
      // Only a parameter *property* declares a member; a plain parameter is
      // local to the constructor body.
      if (parameter.getModifiers().length === 0) {
        continue;
      }

      const nameNode = parameter.getNameNode();

      if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
        return parameter;
      }
    }
  }

  return undefined;
}

/**
 * The handle a declaration holds, by the structural steps, or `undefined` when
 * it holds none.
 *
 * The steps are applied in the module header's order, and the order is what
 * makes the answer meaningful rather than merely present:
 *
 * 1. an initialiser that **constructs** a driver class — the primary evidence;
 * 2. an initialiser that **borrows** a connection from something that is itself
 *    a pooled handle;
 * 3. an initialiser that is an **alias** of another binding (`const db = store`
 *    — a re-binding, not a wrapper), resolved through the same walk;
 * 4. failing all of those, the declaration's **annotation**.
 *
 * `origin` only decides how a construction is *labelled* — step 1 for a
 * declaration in the file under extraction, step 2 for one reached through a
 * resolved import — because both are structural and neither is the heuristic.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the declaration belongs to, which is the scope an
 * alias is resolved in.
 * @param declaration The declaration to read.
 * @param origin Where the declaration was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function handleFromDeclaration(
  state: DiscoveryState,
  module: SourceFile,
  declaration: Node,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  if (hops > MAX_RESOLUTION_HOPS) {
    return undefined;
  }

  if (Node.isVariableDeclaration(declaration) || Node.isPropertyDeclaration(declaration)) {
    const initializer = declaration.getInitializer();

    if (initializer !== undefined) {
      const constructed = constructedDriver(initializer);

      if (constructed !== undefined) {
        return {
          driver: constructed,
          discovery: origin === 'import' ? 'import' : 'construction',
        };
      }

      const borrowed = borrowedConnectionHandle(state, module, initializer, origin, hops);

      if (borrowed !== undefined) {
        return borrowed;
      }

      const aliased = expressionHandle(state, module, initializer, origin, hops + 1);

      if (aliased !== undefined) {
        return aliased;
      }
    }

    return annotatedHandle(declaration.getTypeNode());
  }

  if (Node.isParameterDeclaration(declaration)) {
    return (
      annotatedHandle(declaration.getTypeNode()) ??
      transactionClientHandle(state, module, declaration, origin, hops)
    );
  }

  if (Node.isExportAssignment(declaration) && !declaration.isExportEquals()) {
    const expression = declaration.getExpression();
    const constructed = constructedDriver(expression);

    if (constructed !== undefined) {
      return { driver: constructed, discovery: origin === 'import' ? 'import' : 'construction' };
    }

    return expressionHandle(state, module, expression, origin, hops + 1);
  }

  return undefined;
}

/**
 * **Discovery step 3.** The handle a `<pool>.connect()` initialiser produces,
 * or `undefined` when the initialiser is not one.
 *
 * `const client = await pool.connect()` borrows a connection from a pool, so
 * the variable holds a **pooled-driver** handle: `client.query(…)` is a
 * database call on the same driver, and `client.release()` — like `connect`
 * itself and like `end` — is not a call site, because only the statement member
 * ever is.
 *
 * The borrow is only accepted when the receiver of `connect()` is itself proved
 * to be a pooled handle. That is what keeps an unrelated `connect()` — a socket,
 * a message broker, a cache client — from producing a database handle, and it is
 * why this step depends on step 1 or step 2 having succeeded first.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the initialiser belongs to.
 * @param initializer The declarator's initialiser.
 * @param origin Where the declaration was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The borrowed handle, or `undefined`.
 */
function borrowedConnectionHandle(
  state: DiscoveryState,
  module: SourceFile,
  initializer: Node,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  const call = unwrapExpression(initializer);

  if (!Node.isCallExpression(call)) {
    return undefined;
  }

  const callee = call.getExpression();

  if (
    !Node.isPropertyAccessExpression(callee) ||
    memberName(callee.getNameNode()) !== PG_CONNECT_METHOD
  ) {
    return undefined;
  }

  const source = expressionHandle(state, module, callee.getExpression(), origin, hops + 1);

  return source?.driver === 'pg' ? { driver: 'pg', discovery: 'borrowed' } : undefined;
}

/**
 * **Discovery step 3, generated-client form.** The handle an interactive
 * transaction lends its callback, or `undefined` when `parameter` is not that
 * callback's transaction client.
 *
 * `await prisma.$transaction(async (tx) => { await tx.order.create(…) })` runs
 * the callback with a transaction client whose delegates are the generated
 * client's own, so the statements written on `tx` are generated-client call
 * sites. Three structural facts are required, and nothing about the
 * parameter's name is read:
 *
 * 1. `parameter` is the **first** parameter of an arrow function or function
 *    expression;
 * 2. that function is the **first argument** of a call whose callee is a
 *    `$transaction` member access (parentheses and type assertions around the
 *    function are looked through, as {@link unwrapExpression} does for a
 *    receiver);
 * 3. the member access's receiver is itself proved — by construction, import,
 *    annotation or an enclosing transaction — to be a **generated-client**
 *    handle.
 *
 * The third is what keeps a callback of an unrelated `$transaction` method (a
 * document store's, a hand-written unit-of-work) from producing a handle, the
 * same receiver-first rule {@link borrowedConnectionHandle} applies to a pooled
 * borrow. A nested transaction on a transaction client resolves through the
 * enclosing one, within the shared hop budget.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the parameter belongs to.
 * @param parameter The parameter declaration the name resolved to.
 * @param origin Where the declaration was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The transaction-client handle, or `undefined`.
 */
function transactionClientHandle(
  state: DiscoveryState,
  module: SourceFile,
  parameter: ParameterDeclaration,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  if (hops > MAX_RESOLUTION_HOPS) {
    return undefined;
  }

  const callback = parameter.getParent();

  if (
    !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) ||
    callback.getParameters()[0] !== parameter
  ) {
    return undefined;
  }

  // Walk out through the wrappers `unwrapExpression` looks through, so
  // `$transaction((async (tx) => …))` and a callback under a type assertion
  // are the same callback.
  let argument: Node = callback;
  let call = argument.getParent();

  for (
    let depth = 0;
    call !== undefined && depth < MAX_WRAPPER_DEPTH && unwrapExpression(call) === callback;
    depth += 1
  ) {
    argument = call;
    call = call.getParent();
  }

  if (call === undefined || !Node.isCallExpression(call) || call.getArguments()[0] !== argument) {
    return undefined;
  }

  const callee = call.getExpression();

  if (
    !Node.isPropertyAccessExpression(callee) ||
    memberName(callee.getNameNode()) !== PRISMA_TRANSACTION_OPERATION
  ) {
    return undefined;
  }

  const source = expressionHandle(state, module, callee.getExpression(), origin, hops + 1);

  return source?.driver === 'prisma' ? { driver: 'prisma', discovery: 'transaction' } : undefined;
}

/**
 * The handle an expression evaluates to, when the expression is a plain
 * reference to a binding.
 *
 * The two forms a reference takes — an identifier and `this.<property>` — and
 * nothing else: a call, an element access or a computed member is a value
 * question this module does not ask (see the abstract-syntax-tree-first
 * contract in the header). It is the shared entry point of alias resolution and
 * of the borrow check, which is why both cost a hop.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the expression belongs to.
 * @param expression The expression to read.
 * @param origin Where the enclosing declaration was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function expressionHandle(
  state: DiscoveryState,
  module: SourceFile,
  expression: Node,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  if (hops > MAX_RESOLUTION_HOPS) {
    return undefined;
  }

  const node = unwrapExpression(expression);

  if (Node.isIdentifier(node)) {
    const name = nonEmptyText(node);

    return name === undefined ? undefined : handleForName(state, module, node, name, origin, hops);
  }

  if (Node.isPropertyAccessExpression(node) && Node.isThisExpression(node.getExpression())) {
    const property = memberName(node.getNameNode());

    return property === undefined
      ? undefined
      : thisPropertyHandle(state, module, node, property, origin, hops);
  }

  return undefined;
}

/**
 * The handle a name refers to at a site: the local scopes first, then the
 * module's own surface.
 *
 * The order is the language's: a declaration found in an enclosing scope
 * **settles** the question, whether or not it turns out to hold a handle, so a
 * local binding that shadows an imported handle does not inherit its meaning.
 * Only when no scope declares the name is the module's surface consulted, which
 * is where a module-level declaration and an import binding live.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the site belongs to.
 * @param site The use site, for the scope walk.
 * @param name The name to resolve.
 * @param origin Where the site was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function handleForName(
  state: DiscoveryState,
  module: SourceFile,
  site: Node,
  name: string,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  const declared = declarationInScopes(site, name);

  if (declared !== undefined) {
    return handleFromDeclaration(state, module, declared, origin, hops);
  }

  return handleDeclaredIn(state, module, name, origin, hops);
}

/**
 * The handle a module binds under a local name: its own declaration, or the
 * import that introduced it.
 *
 * **Discovery step 2** lives in the second half: an imported binding is
 * followed to the module it comes from, which is the step the corpus — and
 * every project that declares its handles in one module — depends on.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module to look in.
 * @param name The local name.
 * @param origin Where the lookup was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function handleDeclaredIn(
  state: DiscoveryState,
  module: SourceFile,
  name: string,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  const surface = surfaceOf(state, module);
  const local = surface.locals.get(name);

  if (local !== undefined) {
    const handle = handleFromDeclaration(state, module, local, origin, hops);

    if (handle !== undefined) {
      return handle;
    }
  }

  const imported = surface.imports.get(name);

  if (imported === undefined || imported.exportName === NAMESPACE_IMPORT_NAME) {
    return undefined;
  }

  const target = resolvedModuleOf(imported.declaration);

  return target === undefined
    ? undefined
    : handleExportedBy(state, target, imported.exportName, hops + 1);
}

/**
 * The handle a module exports under a name, following module-specifier
 * re-exports.
 *
 * The other half of **discovery step 2**, and the walk the header describes:
 * a direct export (`export default new Pool()`), an export name that maps to a
 * local binding (`export const store = …`, `export { store }`, and the
 * pass-through case where that local is itself an import), then every
 * module-specifier clause that could carry the name — a matching named clause,
 * or any star clause.
 *
 * Bounded twice over, as the header promises: by {@link MAX_RESOLUTION_HOPS},
 * and by a cycle guard keyed on **module and name together**, so a ring of
 * barrels terminates while two clauses of one barrel looking for different
 * names are both still followed.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module to look in.
 * @param exportName The export name to look for.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function handleExportedBy(
  state: DiscoveryState,
  module: SourceFile,
  exportName: string,
  hops: number,
): DriverHandle | undefined {
  if (hops > MAX_RESOLUTION_HOPS) {
    return undefined;
  }

  const key = `${module.getFilePath()}\u0000${exportName}`;

  if (state.pending.has(key)) {
    return undefined;
  }

  state.pending.add(key);

  try {
    const surface = surfaceOf(state, module);
    const direct = surface.directExports.get(exportName);

    if (direct !== undefined) {
      const handle = handleFromDeclaration(state, module, direct, 'import', hops);

      if (handle !== undefined) {
        return handle;
      }
    }

    const local = surface.exportedNames.get(exportName);

    if (local !== undefined) {
      const handle = handleDeclaredIn(state, module, local, 'import', hops);

      if (handle !== undefined) {
        return handle;
      }
    }

    for (const clause of surface.reexports) {
      if (clause.exportedAs !== undefined && clause.exportedAs !== exportName) {
        continue;
      }

      const target = resolvedModuleOf(clause.declaration);

      if (target === undefined) {
        continue;
      }

      const found = handleExportedBy(state, target, clause.sourceName ?? exportName, hops + 1);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  } finally {
    state.pending.delete(key);
  }
}

/**
 * The handle a class holds under a property name, reached through `this`.
 *
 * A property initialised with a construction, aliased from another binding, or
 * merely annotated — and a constructor parameter property, which is the shape a
 * class that receives its handle declares. A class with no such member answers
 * `undefined`, and the receiver falls to the name heuristic like any other.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The module the site belongs to.
 * @param site The use site, for finding the enclosing class.
 * @param property The property name.
 * @param origin Where the site was reached from.
 * @param hops How many resolution hops have been spent.
 * @returns The handle, or `undefined`.
 */
function thisPropertyHandle(
  state: DiscoveryState,
  module: SourceFile,
  site: Node,
  property: string,
  origin: HandleOrigin,
  hops: number,
): DriverHandle | undefined {
  const enclosing = enclosingClassOf(site);

  if (enclosing === undefined) {
    return undefined;
  }

  const member = classMemberNamed(enclosing, property);

  return member === undefined
    ? undefined
    : handleFromDeclaration(state, module, member, origin, hops);
}

/* -------------------------------------------------------------------------------------------------
 * Receivers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The receiver of a call, or `undefined` when the callee is not a member access
 * on a plain reference.
 *
 * A database call is always a member access on a handle, so the callee is
 * walked down to its root: an identifier (`pool.query(…)`,
 * `prisma.model.findMany(…)`) or `this` (`this.store.query(…)`), where the first
 * member joins the receiver key because the handle is the *property*.
 *
 * Deliberately refused, each for the same reason — the receiver would not be
 * statically known, and a guess is worse than a miss:
 *
 * - an **element access** (`prisma['model'].findMany(…)`), whose member name is
 *   computed;
 * - a **call** or any other expression at the root
 *   (`(await pool.connect()).query(…)`, `getPool().query(…)`), whose value
 *   would need the type checker this package does not run at index time;
 * - a chain deeper than {@link MAX_ACCESS_DEPTH}.
 *
 * @param callee The call's callee, or a tagged template's tag.
 * @returns The receiver, or `undefined`.
 */
function receiverRefOf(callee: Node): ReceiverRef | undefined {
  const names: string[] = [];
  let current: Node = callee;

  for (let depth = 0; depth <= MAX_ACCESS_DEPTH; depth += 1) {
    if (Node.isPropertyAccessExpression(current)) {
      const name = memberName(current.getNameNode());

      if (name === undefined) {
        return undefined;
      }

      names.unshift(name);
      current = current.getExpression();

      continue;
    }

    if (Node.isIdentifier(current)) {
      const key = nonEmptyText(current);

      if (key === undefined || names.length === 0) {
        return undefined;
      }

      return { key, handleName: key, viaThis: false, chain: names };
    }

    if (Node.isThisExpression(current)) {
      const property = names[0];

      // `this.query(…)` binds no handle: the receiver is the instance itself,
      // and a method of it is a wrapper this module does not resolve.
      if (property === undefined || names.length < 2) {
        return undefined;
      }

      return {
        key: `${THIS_RECEIVER_KEY}.${property}`,
        handleName: property,
        viaThis: true,
        chain: names.slice(1),
      };
    }

    return undefined;
  }

  return undefined;
}

/**
 * The handle a receiver refers to, by the structural steps, together with the
 * member names that remain to be classified.
 *
 * Three routes, in order: a handle held by the enclosing instance, a handle a
 * binding refers to (which covers a local, a module-level declaration and an
 * import), and — last — a handle reached *through* a namespace import, where
 * the first member of the chain names the export rather than a model.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The file under extraction.
 * @param site The callee, for scope and class lookups.
 * @param receiver The receiver.
 * @returns The handle and the remaining chain, or `undefined` when no
 * structural step succeeds.
 */
function resolveReceiverHandle(
  state: DiscoveryState,
  module: SourceFile,
  site: Node,
  receiver: ReceiverRef,
): ResolvedHandle | undefined {
  if (receiver.viaThis) {
    const handle = thisPropertyHandle(state, module, site, receiver.handleName, 'local', 0);

    return handle === undefined ? undefined : { handle, chain: receiver.chain };
  }

  const direct = handleForName(state, module, site, receiver.handleName, 'local', 0);

  if (direct !== undefined) {
    return { handle: direct, chain: receiver.chain };
  }

  return namespaceReceiverHandle(state, module, site, receiver);
}

/**
 * The handle reached through a namespace import, or `undefined` when the
 * receiver is not one.
 *
 * `import * as store from './datastore'` followed by `store.pool.query(…)` is
 * an ordinary way to reach a handle, and without this route the first member
 * would be read as a model of a handle nobody found. The binding is only
 * accepted when no enclosing scope declares the name — a local of the same name
 * shadows the import — and the member is resolved as an *export* of the
 * imported module, which spends a hop.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The file under extraction.
 * @param site The callee, for the scope check.
 * @param receiver The receiver.
 * @returns The handle and the remaining chain, or `undefined`.
 */
function namespaceReceiverHandle(
  state: DiscoveryState,
  module: SourceFile,
  site: Node,
  receiver: ReceiverRef,
): ResolvedHandle | undefined {
  const exportName = receiver.chain[0];

  if (exportName === undefined || receiver.chain.length < 2) {
    return undefined;
  }

  if (declarationInScopes(site, receiver.handleName) !== undefined) {
    return undefined;
  }

  const imported = surfaceOf(state, module).imports.get(receiver.handleName);

  if (imported === undefined || imported.exportName !== NAMESPACE_IMPORT_NAME) {
    return undefined;
  }

  const target = resolvedModuleOf(imported.declaration);

  if (target === undefined) {
    return undefined;
  }

  const handle = handleExportedBy(state, target, exportName, 1);

  return handle === undefined ? undefined : { handle, chain: receiver.chain.slice(1) };
}

/**
 * **Discovery step 5.** Whether a receiver name is generic driver vocabulary
 * the name heuristic may accept.
 *
 * Compared case-insensitively against {@link GENERIC_HANDLE_NAMES}, so that
 * `Prisma`, `pgPool` and `PGPool` are all the same word. Reached only when
 * every structural step has failed.
 *
 * @param name The receiver's bare name.
 * @returns `true` when the name is generic driver vocabulary.
 */
function isGenericHandleName(name: string): boolean {
  return GENERIC_HANDLE_NAMES.includes(name.toLowerCase());
}

/* -------------------------------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------------------------------- */

/**
 * The statement a call site states, for the forms that carry one.
 *
 * A call's **first argument** (never its second — the values array is not read,
 * AAP 0.5.2) or a tagged template's template, rendered by
 * {@link renderStatement} and shaped by {@link statementShapeOf}.
 *
 * @param node The call expression or tagged template.
 * @returns The rendered statement.
 */
function statementOf(node: CallExpression | TaggedTemplateExpression): RenderedStatement {
  if (Node.isTaggedTemplateExpression(node)) {
    return renderTemplate(node.getTemplate());
  }

  return renderStatement(node.getArguments()[0]);
}

/**
 * The payload of a statement-bearing call: the shape, and whether it is
 * partial.
 *
 * `dynamic` is `true` whenever the source does not state the whole statement —
 * a substitution, a concatenated computed part, or no readable text at all —
 * which is exactly `DbCallNodeData.dynamic`'s contract. A shape is recorded
 * only when there is one; a call whose argument is a variable reference records
 * none and says so through `dynamic` instead.
 *
 * @param node The call expression or tagged template.
 * @returns The shape and the dynamic flag.
 */
function statementFieldsOf(node: CallExpression | TaggedTemplateExpression): {
  readonly statementShape: string | undefined;
  readonly dynamic: boolean;
} {
  const rendered = statementOf(node);
  const statementShape = statementShapeOf(rendered.text);

  return { statementShape, dynamic: rendered.dynamic || statementShape === undefined };
}

/**
 * Whether a member call has the shape a generated client's delegate operation
 * has: an operation spelled with one of the driver's verbs
 * ({@link PRISMA_DELEGATE_OPERATION_PREFIXES}) and an arity no greater than a
 * delegate operation's ({@link PRISMA_DELEGATE_MAX_ARGUMENTS}).
 *
 * The narrowing of discovery step 5, and nothing else consults it: a handle
 * proved by construction, by a resolved import, by borrowing or by an
 * annotation records the operation the source spells without passing through
 * here.
 *
 * @param operation The operation segment as written.
 * @param argumentCount The number of arguments at the call.
 * @returns `true` when both the spelling and the arity fit.
 */
function hasPrismaDelegateShape(operation: string, argumentCount: number): boolean {
  if (argumentCount > PRISMA_DELEGATE_MAX_ARGUMENTS) {
    return false;
  }

  return PRISMA_DELEGATE_OPERATION_PREFIXES.some((verb) => operation.startsWith(verb));
}

/**
 * The payload of a generated-client call, or `undefined` when the member chain
 * is not one of the client's access shapes.
 *
 * Two shapes, and nothing else:
 *
 * - **a delegate call** — `<handle>.<model>.<operation>(…)`, recorded with the
 *   model segment and the operation segment **as written**, because the handle
 *   has already proved what it is and the source is the authority on the names.
 *   Neither segment may be `$`-prefixed (that is the client's own namespace,
 *   not a model), and the shape must be a call: a tagged template on a delegate
 *   is not a client form. No statement is recorded, because there is none — the
 *   argument is a filter object, whose contents are never read (AAP 0.5.2).
 * - **a raw escape hatch or the transaction entry point** —
 *   `<handle>.$queryRaw…`, `$executeRaw…`, `$transaction`, recorded as the
 *   `$`-prefixed operation with no model. The raw statement forms carry a
 *   statement and are shaped; the transaction entry point does not and is not.
 *
 * The heuristic narrowing is applied here and only here: when the handle itself
 * was matched by name, a delegate call must additionally have the shape a
 * delegate operation has (see {@link hasPrismaDelegateShape}).
 *
 * @param node The call expression or tagged template.
 * @param chain The member names after the handle.
 * @param heuristic Whether the handle was matched by name.
 * @returns The payload, or `undefined`.
 */
function prismaCallData(
  node: CallExpression | TaggedTemplateExpression,
  chain: readonly string[],
  heuristic: boolean,
): DbCallNodeData | undefined {
  const first = chain[0];

  if (first === undefined) {
    return undefined;
  }

  if (chain.length === 1) {
    if (!PRISMA_RAW_OPERATIONS.includes(first)) {
      return undefined;
    }

    const bearsStatement = PRISMA_STATEMENT_OPERATIONS.includes(first);

    // A tagged template is only the raw *statement* forms' shape; a tagged
    // transaction entry point is not a driver form at all.
    if (Node.isTaggedTemplateExpression(node) && !bearsStatement) {
      return undefined;
    }

    if (!bearsStatement) {
      return { driver: 'prisma', operation: first, dynamic: false };
    }

    const { statementShape, dynamic } = statementFieldsOf(node);

    return {
      driver: 'prisma',
      operation: first,
      ...(statementShape === undefined ? {} : { statementShape }),
      dynamic,
    };
  }

  const operation = chain[1];

  if (chain.length !== 2 || operation === undefined) {
    return undefined;
  }

  if (!Node.isCallExpression(node) || first.startsWith('$') || operation.startsWith('$')) {
    return undefined;
  }

  // Discovery step 5's narrowing: a handle matched by name has proved nothing,
  // so the call itself must look like a delegate operation before it counts.
  if (heuristic && !hasPrismaDelegateShape(operation, node.getArguments().length)) {
    return undefined;
  }

  return { driver: 'prisma', model: first, operation, dynamic: false };
}

/**
 * The payload of a pooled-driver call, or `undefined` when the member chain is
 * not one.
 *
 * One shape: `<handle>.query(…)`, whether the handle is a pool or a connection
 * borrowed from one — `DbCallNodeData` fixes both as `driver: 'pg'`, since
 * "they are the same access from the graph's point of view". `model` is absent
 * (the statement names its own tables and no model layer is involved) and
 * `operation` is derived from the statement's leading keyword when the source
 * states one, and left unset otherwise.
 *
 * Every other member of a pooled handle — borrowing a connection, releasing
 * one, ending the pool — matches nothing here and therefore produces no node,
 * which is what the borrowed-connection sequence requires: `connect`, `query`,
 * `release`, and only the middle one is a call site.
 *
 * A tagged template is refused: a template tag is a statement *builder*, not
 * the driver's statement method, and reading one as a pooled call would invent
 * a call site for any project whose helper happens to be named for the member.
 *
 * @param node The call expression or tagged template.
 * @param chain The member names after the handle.
 * @param heuristic Whether the handle was matched by name.
 * @returns The payload, or `undefined`.
 */
function pgCallData(
  node: CallExpression | TaggedTemplateExpression,
  chain: readonly string[],
  heuristic: boolean,
): DbCallNodeData | undefined {
  if (chain.length !== 1 || chain[0] !== PG_QUERY_METHOD || !Node.isCallExpression(node)) {
    return undefined;
  }

  // A name-matched handle needs the call to look like a statement call as well:
  // a no-argument `query()` is not evidence of a database call on its own.
  if (heuristic && node.getArguments().length === 0) {
    return undefined;
  }

  const { statementShape, dynamic } = statementFieldsOf(node);
  const operation = leadingStatementOperation(statementShape);

  return {
    driver: 'pg',
    ...(operation === undefined ? {} : { operation }),
    ...(statementShape === undefined ? {} : { statementShape }),
    dynamic,
  };
}

/**
 * The payload for a handle of a known driver.
 *
 * @param node The call expression or tagged template.
 * @param driver The handle's driver.
 * @param chain The member names after the handle.
 * @param heuristic Whether the handle was matched by name.
 * @returns The payload, or `undefined` when the chain is not an access shape of
 * that driver.
 */
function callDataFor(
  node: CallExpression | TaggedTemplateExpression,
  driver: DbDriver,
  chain: readonly string[],
  heuristic: boolean,
): DbCallNodeData | undefined {
  return driver === 'prisma'
    ? prismaCallData(node, chain, heuristic)
    : pgCallData(node, chain, heuristic);
}

/**
 * The payload of a call whose handle was matched by name, with the marker
 * attached.
 *
 * Both drivers are tried — the *shape* decides which one a generically named
 * receiver belongs to, since a name like `db` says nothing about the mechanism
 * — with the generated client's delegate-shape narrowing in force. The marker is
 * added through a typed value rather than an inline field so the addition is
 * declared once, in {@link HeuristicDbCallNodeData}, and stays plain JSON.
 *
 * @param node The call expression or tagged template.
 * @param chain The member names after the handle.
 * @returns The marked payload, or `undefined` when no shape matches.
 */
function heuristicCallData(
  node: CallExpression | TaggedTemplateExpression,
  chain: readonly string[],
): HeuristicDbCallNodeData | undefined {
  const data = prismaCallData(node, chain, true) ?? pgCallData(node, chain, true);

  return data === undefined ? undefined : { ...data, heuristicHandle: true };
}

/**
 * The database call one expression is, or `undefined` when it is not one.
 *
 * The whole classification in one place, in the order the header states:
 * parse the receiver, resolve it structurally, and only then — if nothing
 * structural answered — consider its name. Everything else about the call
 * (which driver, which shape, which statement) follows from the handle, which
 * is what keeps recognition a property of the analysed code rather than of a
 * list of names.
 *
 * @param state The per-call memoisation and cycle guard.
 * @param module The file under extraction.
 * @param node The call expression or tagged template to classify.
 * @returns The candidate, or `undefined`.
 */
function dbCallCandidate(
  state: DiscoveryState,
  module: SourceFile,
  node: CallExpression | TaggedTemplateExpression,
): DbCallCandidate | undefined {
  const callee = Node.isCallExpression(node) ? node.getExpression() : node.getTag();
  const receiver = receiverRefOf(callee);

  if (receiver === undefined) {
    return undefined;
  }

  const resolved = resolveReceiverHandle(state, module, callee, receiver);
  const data =
    resolved === undefined
      ? isGenericHandleName(receiver.handleName)
        ? heuristicCallData(node, receiver.chain)
        : undefined
      : callDataFor(node, resolved.handle.driver, resolved.chain, false);

  if (data === undefined) {
    return undefined;
  }

  return {
    callee,
    endLine: Math.max(node.getEndLineNumber(), callee.getStartLineNumber()),
    // The source spelling of what the call site calls, assembled from the
    // receiver and its member chain so the name is whitespace-free and
    // deterministic however the expression was laid out across lines.
    name: [receiver.key, ...receiver.chain].join('.'),
    data,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The owner cascade
 * ---------------------------------------------------------------------------------------------- */

/**
 * The addressable declaration an ancestor is, or `undefined` when the graph
 * holds no node for it.
 *
 * "Addressable" is defined by `./symbols.ts`'s scope, and this function is the
 * whole of this module's knowledge of it: module-level function, class and
 * variable declarations, and members of module-level class declarations.
 * Everything else answers `undefined` and the walk continues outward — a
 * function-local declaration, an object-literal method, a class expression's
 * member, a destructured declarator (which binds several names, none of them
 * *the* owner) and an anonymous class.
 *
 * A nameless class declaration is deliberately left to the walk: this module
 * does not reproduce how the symbol extractor anchors one, and an edge to a
 * node spelled differently would be dropped rather than merely imprecise.
 *
 * `export default <function expression>` is claimed — the export statement is
 * the only declaration that shape has — but **only** when the exported
 * expression is directly an arrow function or a function expression. In that
 * spelling `./server-functions.ts` (which anchors at the export assignment's
 * expression) and `./symbols.ts` (which anchors at the *unwrapped* expression)
 * name the same node, so whichever branch {@link declaredOwner} then takes, the
 * id is right. In a wrapped spelling (`export default (fn as T)`,
 * `export default memo(fn)`) the two anchor differently, so the shape is left
 * to the walk exactly as before: an id that differs by one column is not a
 * degraded edge but a `dangling-edge` diagnostic and no edge at all, whereas
 * falling through costs only precision.
 *
 * @param node The ancestor to classify.
 * @returns The declaration, or `undefined`.
 */
function addressableDeclarationOf(node: Node): AddressableDeclaration | undefined {
  if (Node.isFunctionDeclaration(node)) {
    if (!isModuleLevel(node)) {
      return undefined;
    }

    const nameNode = node.getNameNode();
    const declaredName = nameNode === undefined ? undefined : memberName(nameNode);

    // `export default function () {}` — legal, nameless, and recorded under the
    // default-export name at the declaration's own start.
    if (declaredName === undefined || nameNode === undefined) {
      return node.hasDefaultKeyword()
        ? {
            name: DEFAULT_EXPORT_NAME,
            anchor: node,
            functionValued: true,
            declarationStart: node.getStart(),
            classMember: false,
          }
        : undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: true,
      declarationStart: node.getStart(),
      classMember: false,
    };
  }

  if (Node.isClassDeclaration(node)) {
    const nameNode = node.getNameNode();
    const declaredName = nameNode === undefined ? undefined : memberName(nameNode);

    if (!isModuleLevel(node) || nameNode === undefined || declaredName === undefined) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: false,
      declarationStart: node.getStart(),
      classMember: false,
    };
  }

  if (Node.isVariableDeclaration(node)) {
    const statement = node.getVariableStatement();
    const nameNode = node.getNameNode();

    if (statement === undefined || !isModuleLevel(statement) || !Node.isIdentifier(nameNode)) {
      return undefined;
    }

    const declaredName = memberName(nameNode);

    if (declaredName === undefined) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: isFunctionValued(node.getInitializer()),
      // The declarator rather than its statement: one `export const` statement
      // may declare several functions, and each is its own node.
      declarationStart: node.getStart(),
      classMember: false,
    };
  }

  if (Node.isExportAssignment(node)) {
    const expression = node.getExpression();

    // `export = <expression>` is the TypeScript form for a CommonJS module's
    // single export rather than a declaration, and a wrapped default export is
    // anchored differently by the two extractors this module names nodes from.
    if (
      node.isExportEquals() ||
      !(Node.isArrowFunction(expression) || Node.isFunctionExpression(expression))
    ) {
      return undefined;
    }

    return {
      name: DEFAULT_EXPORT_NAME,
      anchor: expression,
      functionValued: true,
      declarationStart: node.getStart(),
      classMember: false,
    };
  }

  if (Node.isConstructorDeclaration(node)) {
    return hasModuleLevelClass(node)
      ? {
          name: CONSTRUCTOR_NAME,
          anchor: node,
          functionValued: true,
          declarationStart: node.getStart(),
          classMember: true,
        }
      : undefined;
  }

  if (
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    if (!hasModuleLevelClass(node)) {
      return undefined;
    }

    const declaredName = memberName(node.getNameNode());

    if (declaredName === undefined) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: node.getNameNode(),
      // A class member is not a module export, whatever its class's status is,
      // so the server-function branch is unreachable for one — `classMember` is
      // what keeps it that way.
      functionValued: !Node.isPropertyDeclaration(node),
      declarationStart: node.getStart(),
      classMember: true,
    };
  }

  return undefined;
}

/**
 * The owner of a call site whose innermost addressable declaration is known.
 *
 * The `server-function` branch is taken for a module-level, function-valued
 * declaration that **leaves its module as a function** — by keyword, by a local
 * export clause, or as the default export, all four of which
 * {@link ModuleFacts.exportedFunctions} records by declaration identity — in a
 * module that is neither a route/page module nor a component module. Export
 * *identity* rather than the `export` keyword, because that is what the node's
 * existence follows: `./server-functions.ts` emits a `server-function` node for
 * every exported module-level function resolved through its module's export
 * surface, so `export { load }`, `export { load as read }`,
 * `export default load` and `export default async () => {}` all have one, and
 * attributing their database calls to a `symbol` node instead would start the
 * `queries` edge at a node a developer never looks for — costing
 * `../graph/query.ts`'s `pathBetween` its terminal hop's service function and
 * `whoCalls` the caller that issues the query.
 *
 * The asymmetry the header states still governs every *other* conjunct, and
 * each one keeps a `symbol` owner: a route or page module's exports are
 * framework entry points, a component module's are components, a class member
 * shares its class's name space rather than its module's, and a declaration
 * holding no function is no `server-function` however it is exported. A
 * `symbol` node exists for all of them (`./symbols.ts` inventories every
 * module-level declaration and every member of a module-level class), and both
 * kinds are what the `queries` edge table sanctions as a `from`, so either
 * answer is a legal, present edge.
 *
 * @param file The module's project-relative POSIX path.
 * @param declaration The innermost addressable declaration.
 * @param facts What this module's own syntax says.
 * @returns The owner.
 */
function declaredOwner(
  file: string,
  declaration: AddressableDeclaration,
  facts: ModuleFacts,
): Owner {
  const { line, column } = positionOf(declaration.anchor);
  const { name } = declaration;

  if (
    !facts.routeModule &&
    !facts.componentModule &&
    !declaration.classMember &&
    declaration.functionValued &&
    facts.exportedFunctions.has(declaration.declarationStart)
  ) {
    return {
      id: makeNodeId({ kind: 'server-function', file, name, line, column }),
      symbol: name,
    };
  }

  return { id: makeNodeId({ kind: 'symbol', file, name, line, column }), symbol: name };
}

/**
 * The owner of a call site no enclosing declaration can address: the cascade's
 * last resort.
 *
 * The `file` node's id is spelled by the convention `CodeNodeBase.name`
 * documents and `./imports.ts` emits — the name *is* the project-relative path,
 * anchored at line 1, column 1 — so the edge has a real endpoint. The node
 * carries no `symbol`, because there is no function to name.
 *
 * Reached only by a database call written outside every declaration, which is a
 * module-level statement with no binding of its own. Logged at `debug` rather
 * than reported as a diagnostic: the attribution is correct and complete, it is
 * simply the least specific one available, and a diagnostic is the channel for
 * an index that is *missing* something. The fields name a file, a position and a
 * vocabulary word — never source text.
 *
 * @param ctx The file being visited.
 * @param site The call site, for the logged position.
 * @returns The file owner.
 */
function fileOwner(ctx: ExtractorContext, site: Position): Owner {
  ctx.logger.debug('Database call site attributed to its module rather than to a declaration', {
    extractorId: DB_CALLS_EXTRACTOR_ID,
    file: ctx.file,
    line: site.line,
    column: site.column,
  });

  return {
    id: makeNodeId({
      kind: 'file',
      file: ctx.file,
      name: ctx.file,
      line: FILE_NODE_LINE,
      column: FILE_NODE_COLUMN,
    }),
    symbol: undefined,
  };
}

/**
 * The node a call site's `queries` edge starts at.
 *
 * One walk of the call's ancestors, innermost-first, returning at the first
 * addressable declaration — which is what "innermost addressable owner" means
 * operationally, and what lets a call written in an anonymous callback inside
 * an exported service function still belong to that function. No wrapper
 * peeling is needed: a memoisation or wrapper call between a function and its
 * declaration is simply an ancestor the walk steps over.
 *
 * The handler, api-route and component steps of `./server-functions.ts`'s
 * cascade are not taken here, for the two reasons the header gives — the
 * `queries` edge table fixes `from` as `symbol | server-function`, and an
 * `api-route` node's id may not be re-derived outside `../route-map.ts` — and
 * nothing is lost, because `./symbols.ts` inventories every declaration those
 * steps would have named.
 *
 * @param ctx The file being visited.
 * @param callee The call site's callee.
 * @param position The callee's 1-based position.
 * @param facts What this module's own syntax says.
 * @returns The owner.
 */
function ownerOf(
  ctx: ExtractorContext,
  callee: Node,
  position: Position,
  facts: ModuleFacts,
): Owner {
  for (const ancestor of callee.getAncestors()) {
    const declaration = addressableDeclarationOf(ancestor);

    if (declaration !== undefined) {
      return declaredOwner(ctx.file, declaration, facts);
    }
  }

  return fileOwner(ctx, position);
}

/* -------------------------------------------------------------------------------------------------
 * Nodes and edges
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `db-call` node of one classified call site.
 *
 * Positioned at the **callee**, which is what discriminates two calls in one
 * function in `makeNodeId` and what an editor opens; `endLine` covers the whole
 * call expression, so a multi-line statement reveals as a unit. `symbol` is the
 * enclosing owner's name and is **omitted** — not set to `undefined` — when the
 * cascade fell through to the module, which is what `exactOptionalPropertyTypes`
 * requires and what keeps a `CodeIndex` round-trippable through JSON.
 *
 * @param file The module, project-relative POSIX.
 * @param candidate The classified call site.
 * @param position The callee's 1-based position.
 * @param owner The node the `queries` edge will start at.
 * @returns The node.
 */
function dbCallNode(
  file: string,
  candidate: DbCallCandidate,
  position: Position,
  owner: Owner,
): CodeNodeOf<'db-call'> {
  return {
    id: makeNodeId({
      kind: 'db-call',
      file,
      name: candidate.name,
      line: position.line,
      column: position.column,
    }),
    kind: 'db-call',
    name: candidate.name,
    file,
    line: position.line,
    column: position.column,
    endLine: Math.max(candidate.endLine, position.line),
    ...(owner.symbol === undefined ? {} : { symbol: owner.symbol }),
    data: candidate.data,
  };
}

/**
 * The `queries` edge from an owner to one `db-call` node.
 *
 * The edge's **site** is the call expression's callee, which is the position a
 * developer wants to be taken to when they ask why a function and a query are
 * connected, and it is part of the edge's identity — so the same owner reaching
 * the same kind of call twice is two edges, which is both true to the source and
 * what a fan-out query reports as two call sites.
 *
 * @param file The module, project-relative POSIX.
 * @param owner The owner node.
 * @param nodeId The `db-call` node's id.
 * @param position The call site's 1-based position.
 * @returns The edge.
 */
function queriesEdge(file: string, owner: Owner, nodeId: string, position: Position): CodeEdge {
  return {
    id: makeEdgeId({
      kind: 'queries',
      from: owner.id,
      to: nodeId,
      line: position.line,
      column: position.column,
    }),
    kind: 'queries',
    from: owner.id,
    to: nodeId,
    file,
    line: position.line,
    column: position.column,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * A thrown value described by its class name alone.
 *
 * **Never the message**: an abstract-syntax-tree library routinely embeds the
 * offending source text in one, and a diagnostic is persisted with a session,
 * written to logs and can reach model prompt context (the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES`). A class name is a name.
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
 * The diagnostic for one call site that could not be read.
 *
 * Severity `warning`: one call site is missing from the index and the rest of
 * the file is complete, which is a degraded answer rather than an absent one.
 * The position is carried in `detail` — the diagnostic shape has no position
 * field — and a position is a number, not source text.
 *
 * @param file The module, project-relative POSIX.
 * @param position The call site's 1-based position.
 * @param cause The value the failure threw.
 * @returns The diagnostic, carrying no source text and no statement text.
 */
function callSiteDiagnostic(file: string, position: Position, cause: unknown): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `A database call site could not be read; it contributes no db-call node (${describeCause(cause)}).`,
    file,
    extractorId: DB_CALLS_EXTRACTOR_ID,
    detail: `line ${String(position.line)}, column ${String(position.column)}`,
  };
}

/**
 * The diagnostic for a module this extractor could not read at all.
 *
 * Severity `error` because a part of the index is missing: this module's
 * database call sites and the edges into them are absent, so a query about the
 * data-access tier reports nothing rather than something wrong.
 * `extractorId` is stamped here rather than left to the indexer, so the finding
 * stays attributable even when a caller runs this extractor directly.
 *
 * @param file The module, project-relative POSIX.
 * @param cause The value the failure threw.
 * @returns The diagnostic, carrying no source text.
 */
function moduleDiagnostic(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `Reading database calls failed; this module contributes no db-call node and no queries edge (${describeCause(cause)}).`,
    file,
    extractorId: DB_CALLS_EXTRACTOR_ID,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `db-calls` extractor: the `db-call` nodes of one module, and the
 * `queries` edge from the owner of each call site to the node it produced.
 *
 * Synchronous, and pure with respect to the project and the machine: it reads
 * the abstract syntax tree of the file it was handed and of the modules that
 * file imports, writes no file, opens no socket, keeps no state beyond the call
 * it is inside, mutates no node and adds no source file to the project. Its
 * output is deterministic — nodes and edges in the order their call sites appear
 * — so two runs over unchanged source produce identical results, which is what
 * `../indexer.ts`'s reproducibility promise rests on.
 *
 * It never throws. One unreadable call site becomes a `warning` diagnostic and
 * the rest of the file is still indexed; a failure that reaches the whole module
 * becomes an `error` diagnostic and an empty contribution, which is the same
 * observable outcome as an escaping throw with the run continuing. Module
 * resolution that throws on an exotic specifier is absorbed where it happens and
 * treated as "no module".
 *
 * @example
 * ```ts
 * const result = dbCallsExtractor.extract(ctx);
 *
 * result.nodes[0]?.data.driver; // 'prisma' | 'pg' — what adapter detection reads
 * result.nodes[0]?.data.statementShape; // a shape with `$n` kept and values gone
 * result.edges.filter((edge) => edge.kind === 'queries'); // owner → db-call
 * ```
 */
export const dbCallsExtractor: Extractor = Object.freeze({
  id: DB_CALLS_EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    try {
      // Defence in depth on the invariant every node and edge field shares. The
      // indexer computes this path through `LoadedProject.projectRelative`, so
      // it cannot fail today; were it ever to, the graph would drop the
      // contribution anyway, and declining here keeps the reason attributable.
      if (!isSafeRelativePath(ctx.file)) {
        ctx.logger.warn('Module skipped: its path is not a safe project-relative path', {
          extractorId: DB_CALLS_EXTRACTOR_ID,
          file: ctx.file,
        });

        return NOTHING_FOUND;
      }

      const state = newDiscoveryState();
      const nodes: CodeNodeOf<'db-call'>[] = [];
      const edges: CodeEdge[] = [];
      const diagnostics: IndexDiagnostic[] = [];
      const emittedNodes = new Set<string>();
      const emittedEdges = new Set<string>();

      // The owner cascade's module facts cost a walk of the tree each — the
      // markup scan, the component-name scan and the export surface — and most
      // modules of a project hold no database call at all, so they are computed
      // on the first call site found and reused for the rest of the file.
      let facts: ModuleFacts | undefined;

      ctx.sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node) && !Node.isTaggedTemplateExpression(node)) {
          return;
        }

        try {
          const candidate = dbCallCandidate(state, ctx.sourceFile, node);

          if (candidate === undefined) {
            return;
          }

          const position = positionOf(candidate.callee);

          facts ??= moduleFactsOf(ctx);

          const owner = ownerOf(ctx, candidate.callee, position, facts);
          const dbCall = dbCallNode(ctx.file, candidate, position, owner);

          // Two call sites cannot share a callee position, so a repeat here
          // would be a bug rather than a duplicate in the source; skipping it
          // keeps this extractor's own contribution free of the
          // `duplicate-node-id` diagnostic graph assembly would otherwise emit.
          if (emittedNodes.has(dbCall.id)) {
            return;
          }

          emittedNodes.add(dbCall.id);
          nodes.push(dbCall);

          const edge = queriesEdge(ctx.file, owner, dbCall.id, position);

          if (!emittedEdges.has(edge.id)) {
            emittedEdges.add(edge.id);
            edges.push(edge);
          }
        } catch (cause) {
          diagnostics.push(callSiteDiagnostic(ctx.file, safePositionOf(node), cause));
        }
      });

      if (nodes.length === 0 && edges.length === 0 && diagnostics.length === 0) {
        return NOTHING_FOUND;
      }

      // `diagnostics` is absent rather than empty for a clean extraction, which
      // is what `ExtractorResult` requires.
      return diagnostics.length === 0 ? { nodes, edges } : { nodes, edges, diagnostics };
    } catch (cause) {
      return { nodes: [], edges: [], diagnostics: [moduleDiagnostic(ctx.file, cause)] };
    }
  },
});
