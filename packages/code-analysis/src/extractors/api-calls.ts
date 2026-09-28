/**
 * `api-calls` — the API call-site extractor of `@debuggen/code-analysis`, and
 * the sixth entry of `../indexer.ts`'s `DEFAULT_EXTRACTORS`.
 *
 * ## The kinds it owns
 *
 * - The **`api-call` node kind**: one node per outbound HTTP call site written
 *   in the analysed source.
 * - The **`calls` edge kind, from the enclosing function or handler to that
 *   node** — the direction the edge table on `CODE_EDGE_KINDS` fixes, and the
 *   direction `../graph/query.ts`'s backwards search along `calls` depends on.
 *
 * It owns nothing else. In particular it does **not** emit the `routes-to`
 * edge that joins a call site to the route it reaches: that edge is derived
 * during graph assembly from two nodes rather than read off a line of source,
 * so no single extractor can produce it.
 *
 * ## Why the two facts it records are load-bearing
 *
 * This module is the client-side half of the product's cross-tier story.
 *
 * - The **literal URL** is what lets a browser `fetch` span be joined to the
 *   route that served it: `../route-map.ts` matches `ApiCallNodeData.url`
 *   against a route path, and a URL normalised, query-stripped or guessed here
 *   would join to the wrong route with full confidence. The target is
 *   therefore recorded exactly as written, or declared dynamic and not
 *   recorded at all — never partially.
 * - The **call site** is what a runtime fetch event resolves back to for
 *   click-to-source: a node's `file`/`line`/`column` is the position
 *   `../graph/query.ts` mints a `'code-graph'` `SourceLocation` from, and its
 *   `symbol` is the enclosing function a developer recognises.
 *
 * Note which half of that second point is *not* this module's: the node
 * vocabulary has no `SourceLocation` field — `CodeNodeBase` carries `file`,
 * `line`, `column`, `endLine` and `symbol` — so **no location and no
 * provenance are minted here**. `../graph/query.ts`'s `locationOf` is the one
 * place a node becomes a location, and it is what stamps `resolvedBy:
 * 'code-graph'` and that route's default confidence, preferring a node's
 * `symbol` over its `name` for exactly the reason the next section gives. All
 * this module owes that consumer is a position a location can be built from,
 * which is why the `file` refinement is checked before anything is emitted.
 *
 * Consumers: `../graph/query.ts` (`pathBetween`, `whoCalls`, and the
 * `SourceLocation` it mints from these nodes), `../route-map.ts` (URL-to-route
 * joining), `../summary.ts` (the project's API-call count) and, downstream of
 * the index, the duplicate-request analysis of the local service.
 *
 * ## The four call shapes it recognises, and nothing beyond them
 *
 * Detection matches **framework-level syntax**, never an application's
 * vocabulary (AAP 0.5.4, enforced by `scripts/check-no-hardcoding.mjs` over
 * `packages/**`). No route path, client name, hook or component of any
 * particular project appears in this file, and none may:
 *
 * 1. **`fetch`** — a call whose callee is the identifier `fetch`, or a
 *    property access named `fetch` on `window`, `globalThis` or `self`.
 * 2. **`XMLHttpRequest`** — a `new XMLHttpRequest()` construction paired with
 *    the `.open(method, url)` call on the same local binding in the same
 *    function **body**. Pairing does not cross into a nested function, where a
 *    separate body runs at a time of its own and may re-declare the name, and
 *    it is abandoned unless the name has exactly one binding in that body and
 *    that binding is the construction's own: a block, `for` head or `catch`
 *    clause re-declaring it, or an assignment or increment of it, each make a
 *    later `.open(…)` some other object's. An unpaired construction is still a
 *    request, with an unknown target.
 * 3. **A client wrapper** — a call whose callee is a property access whose
 *    member name is an HTTP verb *and* whose first argument is a path-like
 *    string or template. The verb-plus-path shape is what a real project's
 *    HTTP client looks like; a list of client names would be exactly the
 *    hardcoded application knowledge this product may not contain.
 *
 * 4. **A forwarding wrapper** — a call whose callee resolves (through the
 *    type checker, across modules) to a function of the analysed project that
 *    forwards its first parameter into the URL argument of a `fetch` in its
 *    own body, directly or through a local binding, *and* whose first argument
 *    is path-like. That is what a project's own HTTP client function is —
 *    `request('/x', { method: 'POST' })` — recognised by what the function
 *    does rather than by what it is called. The parameter, and every local a
 *    URL is built through, is identified by its **binding** — the compiler's
 *    symbol for the declaration a name refers to — and never by its spelling:
 *    a re-declaration of the same name in a block, a `catch` clause or a
 *    nested function's parameter list is a binding of its own and never
 *    counts, while a nested closure that captures the parameter reads the
 *    parameter itself and does. The literal path is recorded at the call
 *    site, where it is written, so the site joins to its route; the `fetch`
 *    inside the wrapper stays a node of its own with a dynamic target.
 *
 * The wrapper rule is deliberately generic, and its one known consequence is
 * that a server-side router registration written with the same shape
 * (`router.get('/x', handler)`) is recorded as a call site. That is the
 * accepted cost of not naming libraries: such a node is still a true statement
 * about the source — this path is written here — and no adapter for that
 * framework is in scope (AAP 0.9.2).
 *
 * ## Two call sites that share a URL are two nodes, always
 *
 * **Nothing in this module de-duplicates by URL.** `ApiCallNodeData` states
 * the rule and the reason: the duplicate-request investigation exists to tell
 * one initiator from another, so a graph that merged two sites requesting the
 * same path would have thrown the answer away before the analysis started.
 * Every call expression gets its own node, discriminated in `makeNodeId` by
 * its position, and the indexing corpus deliberately contains the same literal
 * path at two different sites to pin that behaviour.
 *
 * ## Recorded decisions a consumer (and `./api-calls.test.ts`) can rely on
 *
 * - **`name` is what the call site *calls*, not the URL.** `CodeNodeBase.name`
 *   is "the source spelling", and `../graph/query.ts` documents an `api-call`
 *   node as "named for what it calls, carrying the function it sits inside".
 *   So: the callee text for a `fetch` (`fetch`, `window.fetch`), the
 *   constructor text for an XHR (`XMLHttpRequest`), and — for a wrapper — the
 *   **receiver's** source text (`api` for `api.get('/x')`), because the verb is
 *   already recorded as the method and the receiver is the non-redundant
 *   remainder. The URL lives in `data.url`, never in the name.
 * - **`symbol` is the enclosing function's name**, and is omitted when the
 *   owner cascade below falls through to the file node.
 * - **Every method recorded is a member of the shared vocabulary.**
 *   `HTTP_METHOD_NAMES` minus `ANY` is the closed set a *route* declares, and
 *   a call site's method is only comparable with a route's if it is drawn from
 *   the same set — so a literal the set lacks (`TRACE`, `CONNECT`, a
 *   project's own verb) records **no** method, and no vocabulary member is
 *   ever invented for it. The omission is logged once per site, and it is
 *   deliberately *not* the platform default: a `TRACE` request recorded as a
 *   `GET` would be a confident wrong answer, which is worse than a missing
 *   field.
 * - **A `fetch` records a method whenever the source states none.** A
 *   string-literal `method` property on the second argument wins; with no
 *   statically known method `GET` is recorded, because `GET` is what the
 *   platform API *does* in that case — a documented property of `fetch`, not a
 *   guess. `ApiCallNodeData.method`'s "absent when the call relies on the
 *   default" is honoured for the shape that has no platform default to state:
 *   an XHR whose `open()` method argument is not a literal records no method
 *   at all.
 * - **A literal target is recorded as its decoded literal *value***
 *   (`getLiteralValue()`), so an escape sequence resolves to the path the
 *   request is actually made to, which is what a route match needs. A dynamic
 *   target is recorded as its **raw source text**, whitespace-collapsed and
 *   capped at {@link MAX_SOURCE_TEXT_LENGTH} characters — the hard cap
 *   `ApiCallNodeData.urlExpression` fixes. That text is *source*, never
 *   captured data (AAP 0.5.2), and truncation is silent.
 * - **An unpaired XHR construction records neither URL nor expression**, just
 *   `dynamic: true`: the request exists, and guessing its target from a
 *   construction that names none would be worse than saying nothing.
 *
 * ## The owner cascade, and why it exists
 *
 * A `calls` edge is only useful if it starts at the node a developer would
 * look for, and it is only *present* if that node exists — graph assembly
 * **drops** an edge whose endpoint no extractor emitted and reports
 * `dangling-edge`. Each step below therefore names a node kind whose spelling
 * is guaranteed by the extractor in brackets, and the cascade takes the
 * **innermost addressable owner** of the call site:
 *
 * 1. the enclosing declaration is referenced by an `on[A-Z]` markup attribute
 *    in this file (or *is* the inline function in one) → the **handler** node
 *    (`./event-handlers.ts`). A named **function-local delegate** that only
 *    one inline handler of this file ever calls counts as bound by that
 *    handler, so a request written in `send` — declared in the component body
 *    and called only from `onSubmit={(event) => { void send(event); }}` — is
 *    the inline handler's request (the delegate rule, {@link delegateHandlerOf},
 *    kept in step with `./server-functions.ts`'s);
 * 2. otherwise, in a request-handling route module, the declaration that
 *    answers the route — an HTTP-method export under the App Router, the
 *    default export of a legacy `pages/api/**` module → the **api-route**
 *    node (`./api-routes.ts`);
 * 3. otherwise, in a module that is neither a route/page module nor a
 *    component module, a module-level function-valued declaration the module
 *    exports → the **server-function** node (`./server-functions.ts`);
 * 4. otherwise any module-level declaration, or a member of a module-level
 *    class → its **symbol** node (`./symbols.ts`);
 * 5. otherwise the **file** node (`./imports.ts`).
 *
 * The walk is over the call's *ancestors*, innermost first, which is why no
 * wrapper peeling is needed: a memoisation call (`useCallback`, `useMemo`,
 * `memo`, `forwardRef`) between the function and its declaration is simply an
 * ancestor that is stepped over. A function-local declaration carries no
 * `symbol` node — `./symbols.ts` records module-level declarations and class
 * members only — so the walk continues past one, and the file node is reached
 * only when *no* enclosing declaration anywhere up the chain is addressable.
 *
 * One shape reaches steps 2 to 4 without a declaration at all:
 * `export default <function>`, which binds no name. It is addressable
 * regardless — a legacy `pages/api/**` module's default export *is* the route,
 * a server module's is one of its exported functions, and `./symbols.ts` mints
 * a `default` node for any default export that names no declaration — so
 * {@link defaultExportOwner} answers for it at the same three steps rather
 * than letting the walk run past to the file node.
 *
 * Step 1 is deliberately **independent of that addressability**, and this is
 * the case the cascade exists for: `const handleClick = useCallback(…)` inside
 * a component body is function-local and has no `symbol` node, yet
 * `./event-handlers.ts` emits a `handler` node for it because the markup binds
 * it. Checking the handler index only for module-level declarations would
 * attribute every memoised handler's requests to the component instead, which
 * is precisely the attribution the product needs to be right. The delegate
 * rule is independent of it for the same reason: a delegate is function-local
 * too, and the inline arrow that calls it is the only node that says which
 * interaction issues its requests.
 *
 * ### How steps 2 and 3 name a node this module may not ask about
 *
 * Both of those node ids are built from facts another module owns, and neither
 * may be imported (see the contract below). The rule is therefore *reproduced*
 * here, which is the same coupling point `./event-handlers.ts`'s and
 * `./symbols.ts`'s naming rules are reproduced at, and it is reproduced
 * **strictly**: where the reproduction cannot vouch for its answer it declines,
 * and the cascade falls through to a node that certainly exists.
 *
 * - **Step 2 needs a route path and a route entry's position**, both derived
 *   exclusively by `../route-map.ts`. {@link routeIdentityOf} reproduces that
 *   derivation from the same `@debuggen/shared` path primitives, over the same
 *   two conventional router directories `./api-routes.ts` probes, for the two
 *   request-handling conventions only — an App Router `route.*` module and a
 *   legacy `pages/api/**` module. Anything it cannot read the same way
 *   (a private `_folder`, an intercepting route, a malformed bracket segment,
 *   a misplaced catch-all, an unsupported extension, a tree in a
 *   non-conventional directory) yields no route identity, and the call is
 *   attributed to the handler's own `symbol` node instead. So a re-derivation
 *   that differs cannot produce a dropped edge: it produces the less specific
 *   edge this module used to produce for every route, and the
 *   `file → symbol → api-call` shape stays sanctioned by the reachability
 *   invariant on `CODE_EDGE_KINDS`.
 * - **Step 3 needs the module's export surface**, because a
 *   `server-function` node exists for every *exported* function however it is
 *   exported: with the keyword, by a clause (`export { load }`,
 *   `export { load as fetchAll }`) or by a default assignment
 *   (`export default load`). All three are read here, and the id is spelled
 *   under the declaration's **own** name at its own position, which is how
 *   `./server-functions.ts` names the node for each of them — an alias is a
 *   fact about the export, not about the function. A default export with no
 *   declaration at all (`export default async () => {}`) is that sibling's
 *   `default` node, positioned at the assignment's own expression, wrappers
 *   included; the `symbol` fallback for the same shape is positioned at the
 *   *peeled* expression instead, which is why {@link defaultExportOwner}
 *   takes that last step only when no wrapper stands in between and the two
 *   positions coincide. Component-module detection stays permissive: a call in
 *   a component body falls through to that component's `symbol` node (the
 *   cascade has no `component` step by design), so over-detecting a component
 *   module can only ever move an edge from `server-function` to `symbol`,
 *   never delete it.
 *
 * The chosen step is legible without a new field: the edge's `from` is a node
 * id whose first component is that node's kind, which is what makes a wrong
 * cascade decision visible in a diagnostic or a query result. Nothing parses
 * it (`makeNodeId`'s contract); it is read.
 *
 * ## What it deliberately does not emit
 *
 * - **No `file` node.** `./imports.ts` owns that kind and is its only emitter;
 *   this module only *derives* the file node's id, by the convention
 *   `CodeNodeBase.name` documents, so that its fallback edge has a real
 *   endpoint.
 * - **No `references` edge.** Resolving who references a declaration is the
 *   lazy `ReferenceResolver`'s job and must never run during a build.
 * - **No `symbol`, `handler`, `server-function` or `api-route` node.** Those
 *   ids are *spelled* here to point an edge at them and are emitted by their
 *   owners; emitting one here as well would collide and produce a
 *   `duplicate-node-id` diagnostic.
 *
 * ## Contract
 *
 * - **Abstract-syntax-tree first; symbols for shape 4 only.** Every judgement
 *   is syntactic except shape 4's, which asks the compiler's symbol resolution
 *   two questions within the analysed project: which function a callee is,
 *   across an import to another of the project's modules, and which names in
 *   that function read its first parameter. No type is inferred, nothing
 *   outside the project (a declaration file, a dependency) is ever judged a
 *   wrapper, and a callee or a name the checker cannot resolve is declined as
 *   an ordinary call or a read of nothing — which is what lets the corpus,
 *   whose dependencies are never installed, still yield a complete call-site
 *   inventory. The consequence is stated rather than hidden: a handler
 *   imported from another module cannot own a call site in *this* one (it has
 *   none), and a client wrapper's receiver is recorded as written rather than
 *   resolved to a client.
 * - **Reads no other extractor's output.** The sibling naming rules the edge
 *   depends on are reproduced here as small local helpers, which is the only
 *   coupling point and is kept explicit; `ExtractorResult` is additive and
 *   validation happens once, over the merged set.
 * - **Pure and synchronous.** No filesystem access, no network, no caching, no
 *   mutation of the tree, and no logging of source text. `extract` never
 *   throws: one unreadable construct becomes an `IndexDiagnostic` while the
 *   rest of the file still yields call sites.
 * - **Deterministic.** Nodes and edges are emitted in source order, so two
 *   runs over unchanged source serialise byte-identically — the
 *   reproducibility property `../indexer.ts` promises and the index cache
 *   depends on.
 *
 * ## Findings, and the one diagnostic code used
 *
 * The single code this module emits is `extractor-failed`, always at
 * `warning`, in three situations: a construct that could not be read (its own
 * node is missing, the rest of the file is indexed), a file-level failure
 * (this file's call sites are missing, every other file is indexed), and a
 * file the *parser* could not read in full — a broken module does not make
 * ts-morph throw, it yields a partial tree, and the call sites in the region
 * it gave up on are silently absent unless that is reported. Diagnostic text
 * names files, extractors, syntax kinds, counts and positions, and **quotes no
 * source**, per the privacy constraint on `INDEX_DIAGNOSTIC_CODES`; a thrown
 * message is never repeated, because an abstract-syntax-tree library routinely
 * embeds the developer's source in one.
 *
 * Two observations are **logged rather than diagnosed**, because in neither
 * case is an item missing from the index: a call attributed to its file node
 * (the least specific owner, at `debug`), and a method literal outside the
 * shared vocabulary, where the node exists and one optional field does not.
 * `IndexDiagnostic` is the channel for an index that is *incomplete*, and a
 * closed code vocabulary has no member meaning "an extractor found something
 * odd". Both log lines carry the same constraint the diagnostics do: they name
 * a file, a call shape and a position, and quote no source — the rejected verb
 * itself is never a field.
 *
 * @packageDocumentation
 */

import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import type {
  CallExpression,
  ExportAssignment,
  Identifier,
  JsxAttribute,
  NewExpression,
  ObjectLiteralExpression,
  ParameterDeclaration,
  SourceFile,
  Statement,
  Symbol as BindingSymbol,
  VariableDeclaration,
} from 'ts-morph';

import {
  basenamePosix,
  extnamePosix,
  isSafeRelativePath,
  joinPosix,
  normalizePosix,
  toPosix,
} from '@debuggen/shared';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import { HTTP_METHOD_NAMES } from '../graph/types.js';
import type {
  ApiCallNodeData,
  CodeEdge,
  CodeNodeOf,
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
 * it without repeating a string literal. Stable across versions: renaming it
 * would make previously reported diagnostics untraceable to their source.
 */
export const API_CALLS_EXTRACTOR_ID = 'api-calls';

/**
 * The global request function this extractor recognises, and the member name
 * it accepts on a global receiver.
 *
 * Framework-level syntax, not an application's vocabulary — see the header.
 */
const FETCH_NAME = 'fetch';

/**
 * The receivers a `fetch` property access may be written on.
 *
 * `window.fetch(…)`, `globalThis.fetch(…)` and `self.fetch(…)` are the same
 * call as the bare identifier; any other receiver is a *different* function
 * whose behaviour this module cannot know, so `client.fetch(…)` is not matched
 * by the `fetch` rule (and `fetch` is not an HTTP verb, so it is not matched by
 * the wrapper rule either).
 */
const GLOBAL_RECEIVER_NAMES: readonly string[] = Object.freeze(['window', 'globalThis', 'self']);

/**
 * The legacy request constructor, and the method that gives a construction its
 * target.
 *
 * `new XMLHttpRequest()` says a request object exists; `open(method, url)` says
 * what it will request. Both are needed for a complete node, which is why
 * {@link pairedOpenCall} exists.
 */
const XHR_CONSTRUCTOR_NAME = 'XMLHttpRequest';

/** The `XMLHttpRequest` method that carries the method and URL. */
const XHR_OPEN_NAME = 'open';

/** The property name a `fetch` init object declares its method under. */
const METHOD_PROPERTY_NAME = 'method';

/**
 * The method a `fetch` call performs when its init object declares none.
 *
 * A documented property of the platform API rather than an inference, which is
 * why recording it is a statement about what the call does. See the header.
 */
const DEFAULT_FETCH_METHOD = 'GET';

/**
 * The member of `HTTP_METHOD_NAMES` that a *call site* can never be written
 * with.
 *
 * `ANY` is what a **route** reports when one entry point serves every method
 * (the legacy Pages-Router shape). A client call always names one method, so
 * this member is excluded from the verb vocabulary below — deriving the
 * exclusion from the shared vocabulary rather than re-listing seven verbs
 * keeps the two in step by construction.
 */
const WILDCARD_METHOD = 'ANY';

/**
 * The HTTP methods a call site can be written with: `HTTP_METHOD_NAMES` minus
 * {@link WILDCARD_METHOD}.
 *
 * Doubles as the wrapper rule's verb vocabulary — a member name is a verb when
 * its upper-cased form is in here — so a method recorded by this module is
 * always a member of the shared vocabulary, never an invented spelling.
 */
const CALL_SITE_METHODS: readonly string[] = Object.freeze(
  HTTP_METHOD_NAMES.filter((method) => method !== WILDCARD_METHOD),
);

/**
 * The hard cap on any raw source text this module records, in characters.
 *
 * Fixed at 200 by `ApiCallNodeData.urlExpression`, and applied to every piece
 * of source text a node carries (the expression *and* the name), because both
 * reach prompt context and a user interface: an unbounded slice of a
 * developer's source is a cost and a privacy risk (AAP 0.5.2). Truncation is
 * silent, so a consumer must not assume the text is syntactically complete.
 */
const MAX_SOURCE_TEXT_LENGTH = 200;

/**
 * How many transparent wrappers the handler-binding classification peels.
 *
 * `(fn)`, `fn as T`, `fn satisfies T`, `fn!` and `fn.bind(…)` are transparent —
 * none changes what is bound — but the peeling has to terminate on
 * pathological input. Four is past anything a real binding nests, and matches
 * the bound `./event-handlers.ts` applies to the same classification.
 */
const MAX_UNWRAP_DEPTH = 4;

/**
 * The property-name shape of a markup event binding: `on` followed by an
 * upper-case letter.
 *
 * The same test `./event-handlers.ts` applies, reproduced because the handler
 * index below has to agree with that module's node ids and therefore with its
 * notion of which attributes are bindings at all.
 */
const EVENT_PROP_PATTERN = /^on[A-Z]/;

/** The identifier that binds no handler: `onClick={undefined}`. */
const UNDEFINED_IDENTIFIER = 'undefined';

/** The method whose result is the receiving function itself. */
const BIND_METHOD_NAME = 'bind';

/**
 * The React hooks whose result **is** the function they are handed, which is
 * what lets the delegate rule read `const send = useCallback(async () => …,
 * [deps])` as a declaration of that function.
 *
 * Deliberately not every call the ancestor walk steps over: the value
 * `useMemo(() => …)` holds is what the callback *returns*, and the callback
 * itself runs while the component renders, so a request written inside it is
 * never issued by whichever handler later calls the memoised value. Matched by
 * name only, bare or qualified — the same list `./server-functions.ts` keeps
 * for the same rule.
 */
const MEMOISED_CALLBACK_NAMES: readonly string[] = Object.freeze(['useCallback']);

/** The assignment operator that binds a construction to an existing name. */
const ASSIGNMENT_OPERATOR = '=';

/**
 * The operators that end in `=` without assigning anything.
 *
 * The exclusion list behind {@link isAssignmentOperator}, which recognises the
 * assignment family by its shape rather than by enumerating it.
 */
const COMPARISON_OPERATORS: readonly string[] = Object.freeze([
  '==',
  '===',
  '!=',
  '!==',
  '<=',
  '>=',
]);

/**
 * The prefix operators that replace what a name holds.
 *
 * `!xhr` and `-xhr` read the binding without changing it; `++xhr` and `--xhr`
 * leave it holding a number, which is no longer a request object.
 */
const UPDATE_OPERATORS: readonly SyntaxKind[] = Object.freeze([
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

/**
 * A target is path-like when it starts with this, or matches
 * {@link URL_SCHEME_PATTERN}.
 *
 * The whole of the wrapper rule's second half: a verb-named method call is a
 * request only when its first argument looks like a request target, which is
 * what separates `api.get('/x')` from `list.get(3)` and `map.delete(key)` —
 * the rule's main false-positive risk.
 */
const PATH_PREFIX = '/';

/** An absolute URL's scheme, as a target may be written with one. */
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;

/** Every run of whitespace, collapsed to a single space in recorded text. */
const WHITESPACE_RUN = /\s+/g;

/** The single space a collapsed whitespace run becomes. */
const SINGLE_SPACE = ' ';

/**
 * The name `./symbols.ts` records a nameless default export under, and the one
 * this module spells when it points an edge at such a declaration.
 */
const DEFAULT_EXPORT_NAME = 'default';

/** The name `./symbols.ts` records a class constructor under. */
const CONSTRUCTOR_NAME = 'constructor';

/**
 * The namespace name `./symbols.ts` skips, and therefore the one this module
 * must never point an edge at.
 *
 * A `declare global { … }` block yields no symbol node. It also contains no
 * function bodies and so no call sites, which makes this purely defensive —
 * but an edge to a node nobody emits is dropped, and the check costs one
 * comparison.
 */
const GLOBAL_MODULE_NAME = 'global';

/** The App Router's directory name, as a path segment. */
const APP_ROUTER_DIRECTORY = 'app';

/** The Pages Router's directory name, as a path segment. */
const PAGES_ROUTER_DIRECTORY = 'pages';

/** The one directory a router directory may be nested under. */
const SOURCE_DIRECTORY = 'src';

/** The App Router file stem whose module answers requests rather than renders. */
const APP_HANDLER_STEM = 'route';

/** The App Router file stem whose module renders a document. */
const APP_PAGE_STEM = 'page';

/**
 * The App Router file stems that make a module a route or page module.
 *
 * Used **only** to classify a module for the cascade's server-function branch,
 * never to derive a URL. The stricter reading that *does* produce a route path
 * is {@link routeIdentityOf}, and it is deliberately separate: this
 * classification is allowed to over-answer, and that one is not.
 */
const ROUTE_MODULE_STEMS: readonly string[] = Object.freeze([APP_HANDLER_STEM, APP_PAGE_STEM]);

/** The file extension separator, for taking a basename's stem. */
const EXTENSION_SEPARATOR = '.';

/** The path separator every project-relative path uses. */
const PATH_SEPARATOR = '/';

/**
 * Where an App Router tree lives, in probe order.
 *
 * The **conventional** locations, and only those, because `../route-map.ts` is
 * asked for a route by `./api-routes.ts` without options and therefore probes
 * exactly these two. A project whose tree lives elsewhere gets no `api-route`
 * node at all, so the route step of the cascade must not claim one either —
 * which it cannot, since it reads the same two names.
 */
const APP_DIRECTORY_CANDIDATES: readonly string[] = Object.freeze([
  APP_ROUTER_DIRECTORY,
  `${SOURCE_DIRECTORY}/${APP_ROUTER_DIRECTORY}`,
]);

/** Where a Pages Router tree lives, in probe order, on the same terms. */
const PAGES_DIRECTORY_CANDIDATES: readonly string[] = Object.freeze([
  PAGES_ROUTER_DIRECTORY,
  `${SOURCE_DIRECTORY}/${PAGES_ROUTER_DIRECTORY}`,
]);

/**
 * The extensions an App Router `route.*` module may carry.
 *
 * The set `../route-map.ts` accepts, reproduced rather than narrowed: a route
 * module written in JavaScript is ordinary in a project mid-migration, and
 * refusing one here would attribute its handler's calls to a `symbol` node
 * while the route node exists.
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
 * The extensions a Pages Router module may carry.
 *
 * Narrower than the App Router set, because the framework's default page
 * extensions are these four and a `.mjs`/`.cjs` module under `pages/` is not
 * served — the same asymmetry `../route-map.ts` encodes.
 */
const PAGES_ROUTE_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.tsx', '.js', '.jsx']);

/** The Pages Router file stem that collapses to its own directory. */
const PAGES_INDEX_STEM = 'index';

/** The Pages Router file stem that intercepts requests instead of serving one. */
const PAGES_MIDDLEWARE_STEM = 'middleware';

/** The directory under a Pages Router tree whose modules answer requests. */
const PAGES_API_SEGMENT = 'api';

/** The route path of a route with no URL segment of its own. */
const ROOT_ROUTE_PATH = '/';

/** The prefix that opts a directory, and its whole subtree, out of routing. */
const PRIVATE_SEGMENT_PREFIX = '_';

/** The prefix of a parallel-route slot, which organises the tree without appearing in the URL. */
const SLOT_SEGMENT_PREFIX = '@';

/** A route group's delimiters: a directory that organises the tree and contributes no segment. */
const GROUP_SEGMENT_OPEN = '(';

/** The closing delimiter of a route group. */
const GROUP_SEGMENT_CLOSE = ')';

/**
 * An intercepting-route marker at the start of a segment: `(.)`, `(..)`,
 * `(...)` and, by the same prefix, `(..)(..)`.
 *
 * Such a route's served URL depends on where it is rendered from, which a path
 * cannot know, so `../route-map.ts` refuses the file — and so must this
 * module, or it would point an edge at a node that extractor never emitted.
 */
const INTERCEPTING_SEGMENT_PREFIX = /^\(\.{1,3}\)/;

/**
 * A usable dynamic-parameter name: anything but a separator, a bracket, a dot
 * or whitespace.
 *
 * The same permissive rule `../route-map.ts` applies — a parameter reaches
 * application code as an object key, so a hyphen or a non-ASCII letter is
 * legal — rejecting only spellings that would make the segment ambiguous.
 */
const ROUTE_PARAM_NAME = /^[^[\].\s/]+$/;

/** The opening of an optional catch-all segment, `[[...param]]`. */
const OPTIONAL_CATCH_ALL_OPEN = '[[...';

/** The closing of an optional catch-all segment. */
const OPTIONAL_CATCH_ALL_CLOSE = ']]';

/** The opening of a catch-all segment, `[...param]`. */
const CATCH_ALL_OPEN = '[...';

/** The opening of a dynamic segment, `[param]`. */
const DYNAMIC_OPEN = '[';

/**
 * The doubled opening that tells a dynamic segment from an optional catch-all.
 *
 * `[[…` can only begin the optional form, so a name starting with it is never
 * read as a plain `[param]` — the disambiguation `../route-map.ts` makes with
 * the same test.
 */
const OPTIONAL_DYNAMIC_OPEN = '[[';

/** The closing of a dynamic or catch-all segment. */
const DYNAMIC_CLOSE = ']';

/**
 * What {@link classifyRouteDirectory} answers for a directory that is legal but
 * contributes no URL segment.
 *
 * A distinct sentinel rather than `undefined`, which already means "this file
 * serves no URL": conflating the two would turn every route group into a
 * module with no route at all.
 */
const SKIPPED_SEGMENT = Symbol('debuggen.api-calls.skipped-segment');

/** The export-name list of a declaration no clause and no assignment exports. */
const NO_EXPORT_NAMES: readonly string[] = Object.freeze([]);

/** The export surface of a module whose statements could not be read. */
const EMPTY_EXPORTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>();

/** The line a `file` node is anchored at, by the convention `./imports.ts` uses. */
const FILE_NODE_LINE = 1;

/** The column a `file` node is anchored at, by the same convention. */
const FILE_NODE_COLUMN = 1;

/**
 * The node list of a result that found nothing: empty rather than absent, as
 * `ExtractorResult` requires so the indexer can concatenate without a guard.
 */
const EMPTY_NODES: readonly CodeNodeOf<'api-call'>[] = Object.freeze([]);

/** The edge list of a result that found nothing. */
const EMPTY_EDGES: readonly CodeEdge[] = Object.freeze([]);

/** The call-site list of a file whose scan could not run. */
const EMPTY_SITES: readonly CallSite[] = Object.freeze([]);

/**
 * The result for a file this extractor cannot index at all: no nodes, no
 * edges, and no diagnostics — `diagnostics` is absent rather than empty for a
 * clean extraction.
 */
const EMPTY_RESULT: ExtractorResult = Object.freeze({
  nodes: EMPTY_NODES,
  edges: EMPTY_EDGES,
});

/**
 * The module facts of a file whose scan threw: no router convention, no
 * component declaration, no handler bindings.
 *
 * Every field is the conservative answer. With no handlers the cascade falls
 * through to a declaration, and with `routeModule`/`componentModule` false the
 * server-function branch stays *available* — which is the right default for a
 * file the scan could not classify, since the branch additionally requires an
 * exported module-level function-valued declaration.
 */
const EMPTY_FACTS: ModuleFacts = Object.freeze({
  routeModule: false,
  componentModule: false,
  handlers: new Map<number, HandlerRef>(),
  route: undefined,
  exports: EMPTY_EXPORTS,
});

/**
 * The target of a request whose URL the source does not state: dynamic, with
 * nothing recorded.
 *
 * `urlExpression`'s presence implies `dynamic`, never the reverse — an unpaired
 * `XMLHttpRequest` construction and an `open()` call with no URL argument both
 * land here.
 */
const UNKNOWN_TARGET: RequestTarget = Object.freeze({
  url: undefined,
  dynamic: true,
  urlExpression: undefined,
});

/** The method reading for source that states no method at all. */
const ABSENT_METHOD: MethodReading = Object.freeze({ kind: 'absent' });

/** The method reading for a literal the shared vocabulary does not contain. */
const UNSUPPORTED_METHOD: MethodReading = Object.freeze({ kind: 'unsupported' });

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/** A 1-based source position, the convention `CodeNodeBase.line` fixes. */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/**
 * Which syntax a call site was recognised by.
 *
 * Internal: it selects the node's name and extent and appears in log fields,
 * and it is a fixed vocabulary word rather than source text, so it is safe to
 * log. It is deliberately *not* stored on the node — `ApiCallNodeData` is
 * closed, and the shape is legible from the name and method the node carries.
 */
type CallShape = 'fetch' | 'xhr' | 'wrapper' | 'forwarder';

/**
 * What the source says about a request's target.
 *
 * The three fields are the payload's three target fields, pre-decided: exactly
 * one of `url` and `urlExpression` can be set, and `dynamic` is `false` only
 * when `url` is set. Declared with explicit `undefined` rather than optional
 * properties because this is an internal working shape, and the omission
 * `exactOptionalPropertyTypes` requires happens once, in {@link apiCallData}.
 */
interface RequestTarget {
  /** The decoded literal target, when the source states one statically. */
  readonly url: string | undefined;

  /** Whether the target is built from anything other than a single literal. */
  readonly dynamic: boolean;

  /** The capped raw source text of a dynamic target. */
  readonly urlExpression: string | undefined;
}

/**
 * What a piece of source says about a request's HTTP method.
 *
 * Three outcomes, and keeping them apart is the whole point: "the source
 * states no method" and "the source states a method the shared vocabulary does
 * not contain" have to lead to *different* recorded values, because collapsing
 * them is how a `TRACE` request comes to be recorded as a `GET`.
 *
 * - `absent` — nothing statically known: no `method` property, a computed one,
 *   a non-literal `open()` argument. The caller applies whatever default the
 *   platform API documents for that shape, if there is one.
 * - `unsupported` — a literal method outside {@link CALL_SITE_METHODS}. No
 *   method is recorded and no platform default is substituted: the call
 *   performs the method it wrote, which this vocabulary cannot name.
 * - `method` — a member of the shared vocabulary, in its spelling.
 */
type MethodReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'method'; readonly method: string };

/**
 * What a `fetch` call's node records about its method.
 *
 * Two fields rather than one, because "no method" has two causes that the node
 * and the log treat differently: the platform default covers the absent case,
 * so a missing method here always means the source stated a verb the shared
 * vocabulary lacks.
 */
interface FetchMethod {
  /** The method to record, or `undefined` when none may be. */
  readonly method: string | undefined;

  /** Whether the source stated a literal method outside the vocabulary. */
  readonly unsupported: boolean;
}

/**
 * One recognised call site, before ownership is resolved.
 *
 * The four node references it carries are each used for one thing, and keeping
 * them apart is what makes an `XMLHttpRequest` site — whose target is stated
 * by a *different* expression than the one that creates it — describable at
 * all.
 */
interface CallSite {
  /** Which syntax recognised it. */
  readonly shape: CallShape;

  /** The node's name: see the header's recorded decisions. */
  readonly name: string;

  /** The node whose start position the node records: the callee. */
  readonly anchor: Node;

  /** The node whose end line bounds the site. */
  readonly extent: Node;

  /** The call or construction itself, where the owner walk starts. */
  readonly expression: Node;

  /** What the source says about the target. */
  readonly target: RequestTarget;

  /** The HTTP method, or `undefined` when the source states none this vocabulary contains. */
  readonly method: string | undefined;

  /**
   * Whether the source stated a literal method the shared vocabulary does not
   * contain, so none was recorded.
   *
   * Internal, and the reason the omission is observable rather than silent:
   * the extractor logs one line per such site (see
   * {@link extractApiCalls}). It is deliberately not a node field —
   * `ApiCallNodeData` is closed — and it is a boolean rather than the verb
   * itself, because the verb is source text and a log field may not carry any.
   */
  readonly unsupportedMethod: boolean;
}

/**
 * The handler node one markup binding points at, reduced to what an edge and a
 * node's `symbol` need.
 *
 * Built by the local reproduction of `./event-handlers.ts`'s naming rule, and
 * keyed by the character offset of the node it was derived from, so a call
 * site's enclosing declaration is matched by *identity of position* rather
 * than by a second, independently derived name.
 */
interface HandlerRef {
  /** The handler node's id, spelled by the reproduced rule. */
  readonly id: string;

  /** The handler node's name, used as the api-call node's `symbol`. */
  readonly name: string;
}

/**
 * What one file's own syntax says, computed once per extraction because every
 * call site in the file asks the same questions.
 */
interface ModuleFacts {
  /** Whether the path makes this a route or page module. */
  readonly routeModule: boolean;

  /** Whether this module looks like a component module. */
  readonly componentModule: boolean;

  /** Handler nodes by the character offset of the node they were derived from. */
  readonly handlers: ReadonlyMap<number, HandlerRef>;

  /**
   * The `api-route` node of this module, when it is a request-handling route
   * module whose identity is unambiguous — otherwise `undefined`.
   */
  readonly route: RouteIdentity | undefined;

  /**
   * The names this module exports each of its declarations under, by the
   * declaration's own declared name.
   *
   * Only the export *clauses* and the `export default <identifier>` assignment
   * are recorded here, because those are the ones a declaration cannot be
   * asked about directly; a declaration's own `export`/`default` keyword is
   * read from the declaration itself in {@link exportNamesOf}.
   */
  readonly exports: ReadonlyMap<string, readonly string[]>;
}

/**
 * Which router convention a route module belongs to.
 *
 * The two `../route-map.ts` derives, and the discriminator the cascade's route
 * step needs: an App Router handler module is addressed by its HTTP-method
 * exports, while a legacy Pages Router API module *is* its default export.
 */
type RouterConvention = 'app' | 'pages';

/**
 * The `api-route` node of one request-handling route module, reduced to what
 * the cascade needs.
 *
 * Present only when this module's route identity is unambiguous — see
 * {@link routeIdentityOf} — so a value here is a node `./api-routes.ts`
 * emitted for the same file.
 */
interface RouteIdentity {
  /** The `api-route` node's id, spelled as that extractor spells it. */
  readonly id: string;

  /** Which convention decides what counts as this route's handler. */
  readonly router: RouterConvention;
}

/**
 * A declaration the graph can address, reduced to what the cascade needs to
 * spell its node id and decide which kind of node that is.
 *
 * "Addressable" means `./symbols.ts` emits a node for it: a module-level
 * declaration, or a member of a module-level class declaration. A
 * function-local declaration is not addressable, and the walk continues past
 * it.
 */
interface AddressableDeclaration {
  /** The name `./symbols.ts` records it under. */
  readonly name: string;

  /** The node whose start position that module records. */
  readonly anchor: Node;

  /** Whether its value is a function, written as one. */
  readonly functionValued: boolean;

  /**
   * Whether it carries a plain `export` keyword, which exports it under its
   * own declared name.
   *
   * One of the three ways a declaration can leave its module, and the only one
   * legible from the declaration alone. The other two — an export clause and a
   * default assignment — are recorded on {@link ModuleFacts.exports}, because
   * either may be written anywhere in the module, including above the
   * declaration it names.
   */
  readonly keywordExported: boolean;

  /**
   * Whether it carries a `default` keyword, which exports it as `default`
   * rather than under its declared name.
   */
  readonly defaultExported: boolean;

  /** Whether it is a member of a module-level class rather than a module-level declaration. */
  readonly classMember: boolean;
}

/**
 * Which node a `calls` edge starts at, and what the call site's `symbol`
 * should say.
 *
 * `kind` is the cascade step that was taken. It reaches no node field —
 * `CodeEdge` has none for it and `ApiCallNodeData` is closed — and is not
 * needed as one: the id's first component *is* the kind, which is what makes
 * the decision legible in a diagnostic or a query result.
 */
interface Owner {
  /** The cascade step taken. */
  readonly kind: 'handler' | 'api-route' | 'server-function' | 'symbol' | 'file';

  /** The owning node's id. */
  readonly id: string;

  /** The owning declaration's name, or `undefined` for the file node. */
  readonly symbol: string | undefined;
}

/**
 * What one markup binding binds, syntactically.
 *
 * The classification `./event-handlers.ts` performs, reduced to the cases that
 * can own a call site *in this file*: an inline function, or a name whose
 * declaration in-file scope can produce. A binding whose declaration lives in
 * another module is deliberately absent — it cannot contain a call site here.
 */
type HandlerBinding =
  | { readonly inline: true; readonly fn: Node }
  | {
      readonly inline: false;
      readonly name: string;
      readonly site: Node;
      readonly member: string | undefined;
    };

/** One file's markup facts, collected in a single traversal. */
interface JsxScan {
  /** Whether the file contains any markup at all. */
  readonly hasJsx: boolean;

  /** Every attribute whose name has the event-binding shape, in source order. */
  readonly attributes: readonly JsxAttribute[];
}

/* -------------------------------------------------------------------------------------------------
 * Positions and recorded text
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 1-based line and column a node starts at.
 *
 * 1-based on both axes, which is the convention `CodeNodeBase.line` fixes for
 * the whole product; the single conversion to an editor's 0-based position
 * happens in the VS Code extension.
 *
 * @param node Any node.
 * @returns Its start position.
 */
function positionOf(node: Node): Position {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());

  return { line, column };
}

/**
 * The position of a node, or `undefined` when it cannot be computed.
 *
 * The failure-path counterpart of {@link positionOf}: it runs while a
 * diagnostic is being built, where assuming any further call succeeds is how
 * one failure becomes two.
 *
 * @param node The node in question.
 * @returns Its 1-based position, or `undefined`.
 */
function safePositionOf(node: Node): Position | undefined {
  try {
    return positionOf(node);
  } catch {
    return undefined;
  }
}

/**
 * Source text reduced to what a node may carry: whitespace collapsed, trimmed,
 * and capped at {@link MAX_SOURCE_TEXT_LENGTH}.
 *
 * Collapsing runs of whitespace — newlines included — is what keeps a
 * multi-line expression a single readable line in a table, and the cap is the
 * hard privacy bound the header states. `undefined` for text that is empty
 * once trimmed, so a caller never records a nameless node or an empty
 * expression.
 *
 * @param text The raw source text.
 * @returns The recordable form, or `undefined` when there is nothing to record.
 */
function condense(text: string): string | undefined {
  const collapsed = text.replace(WHITESPACE_RUN, SINGLE_SPACE).trim();

  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length <= MAX_SOURCE_TEXT_LENGTH
    ? collapsed
    : collapsed.slice(0, MAX_SOURCE_TEXT_LENGTH);
}

/**
 * A node's condensed source text, with a fixed fallback for text that reduces
 * to nothing.
 *
 * Used for a node's name, which `makeNodeId` needs and which must never be
 * empty. The fallback is a vocabulary word (the shape's own spelling), not a
 * guess about the source.
 *
 * @param node The node whose text to record.
 * @param fallback The name to use when the text reduces to nothing.
 * @returns The name to record.
 */
function textOr(node: Node, fallback: string): string {
  return condense(node.getText()) ?? fallback;
}

/**
 * The decoded value of a fully static string, or `undefined` for anything
 * else.
 *
 * A string literal and a **no-substitution** template literal are both fully
 * static, and both are recorded as their decoded `getLiteralValue()` rather
 * than their raw text: an escape sequence resolves to the path the request is
 * actually made to, which is what a route match needs, and the surrounding
 * quotes or backticks are syntax rather than part of the target. An
 * empty-string literal is still a literal, which is why callers compare
 * against `undefined` rather than testing truthiness.
 *
 * @param node The node to read.
 * @returns The decoded literal value, or `undefined` when the node is not one.
 */
function literalTextOf(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Targets and methods
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the source says about a request's target.
 *
 * Three outcomes, and the whole of this module's URL policy:
 *
 * - **a literal** (a string or a substitution-free template) — recorded
 *   verbatim as its decoded value, with no normalisation and no query
 *   stripping, because matching a URL against a route is `../route-map.ts`'s
 *   business and a URL rewritten here would join to the wrong route;
 * - **anything computed** — a template with substitutions, a concatenation, a
 *   variable, a call — recorded as capped raw source text and flagged dynamic,
 *   which is the honest statement that this site issues a request whose target
 *   only the runtime knows;
 * - **nothing at all** (no argument) — {@link UNKNOWN_TARGET}.
 *
 * @param node The target argument, or `undefined` when the call states none.
 * @returns The target.
 */
function targetOf(node: Node | undefined): RequestTarget {
  if (node === undefined) {
    return UNKNOWN_TARGET;
  }

  const literal = literalTextOf(node);

  if (literal !== undefined) {
    return { url: literal, dynamic: false, urlExpression: undefined };
  }

  const raw = condense(node.getText());

  return raw === undefined ? UNKNOWN_TARGET : { url: undefined, dynamic: true, urlExpression: raw };
}

/**
 * Whether text looks like a request target: an absolute path, or an absolute
 * URL.
 *
 * The test that keeps the wrapper rule honest. It is about *shape* only — no
 * path of any particular application appears here or may — and it is
 * deliberately strict about relative targets: `api.get('user')` is
 * indistinguishable from a collection lookup, and a false api-call node is
 * worse than a missed one, because the analysis would then hunt for a request
 * that never happens.
 *
 * @param text The candidate target text.
 * @returns `true` when it is path-like.
 */
function looksLikePath(text: string): boolean {
  return text.startsWith(PATH_PREFIX) || URL_SCHEME_PATTERN.test(text);
}

/**
 * Whether an argument is a path-like string or template.
 *
 * A literal is tested on its decoded value; a template with substitutions is
 * tested on its **head** — the text before the first `${…}` — which is where a
 * request target's leading slash or scheme is always written. Any other
 * expression is not path-like: nothing syntactic says what a variable holds.
 *
 * @param node The first argument of a verb-named call.
 * @returns `true` when the argument is path-like.
 */
function isPathLike(node: Node): boolean {
  const literal = literalTextOf(node);

  if (literal !== undefined) {
    return looksLikePath(literal);
  }

  if (Node.isTemplateExpression(node)) {
    return looksLikePath(node.getHead().getLiteralText());
  }

  return false;
}

/**
 * An HTTP method read from a literal and checked against the shared
 * vocabulary.
 *
 * Upper-cased, because that is how `HTTP_METHOD_NAMES` spells a method and how
 * the runtime evidence records one, and trimmed, because
 * `{ method: ' post ' }` is a method the platform accepts. Membership of
 * {@link CALL_SITE_METHODS} is then required rather than assumed: the method a
 * node carries has to be a member of the closed vocabulary a route declares —
 * that is what lets a captured request be compared with a route's methods at
 * all — so a verb the vocabulary lacks (`TRACE`, `CONNECT`, a project's own)
 * is reported as {@link UNSUPPORTED_METHOD} and recorded as no method, never
 * admitted as an invented member and never coerced into a neighbouring one.
 *
 * @param raw The method text as written.
 * @returns The reading: a vocabulary member, unsupported, or absent for empty
 * text.
 */
function readMethod(raw: string): MethodReading {
  const upper = raw.trim().toUpperCase();

  if (upper.length === 0) {
    return ABSENT_METHOD;
  }

  return CALL_SITE_METHODS.includes(upper) ? { kind: 'method', method: upper } : UNSUPPORTED_METHOD;
}

/**
 * The HTTP method a verb-named member implies, or `undefined` when the member
 * is not a verb.
 *
 * Both halves of the wrapper rule's first test at once: membership of
 * {@link CALL_SITE_METHODS} decides whether the call is recognised, and the
 * matched member *is* the method, so a wrapper call can only ever record a
 * spelling the shared vocabulary already contains. Case-insensitive, because a
 * client's method is conventionally lower-case (`api.get`) while the
 * vocabulary is upper-case.
 *
 * @param memberName The property name after the dot.
 * @returns The method, or `undefined` when the member names no HTTP verb.
 */
function wrapperMethodOf(memberName: string): string | undefined {
  const upper = memberName.toUpperCase();

  return CALL_SITE_METHODS.includes(upper) ? upper : undefined;
}

/**
 * The name a property's name node spells, or `undefined` when it is not
 * statically known.
 *
 * Covers the two spellings an init object's `method` property can have —
 * `{ method: 'POST' }` and `{ 'method': 'POST' }` — and answers `undefined`
 * for a computed name, which no static read can resolve.
 *
 * @param nameNode The property's name node.
 * @returns The property name, or `undefined`.
 */
function propertyNameOf(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode)) {
    const text = nameNode.getText();

    return text.length === 0 ? undefined : text;
  }

  return literalTextOf(nameNode);
}

/**
 * What an init object says about the method.
 *
 * Only a *literal* method is read. A shorthand (`{ method }`), a computed
 * value (`{ method: verb }`) and a spread (`{ ...options }`) each mean the
 * method is decided at runtime, so each reads as {@link ABSENT_METHOD} and the
 * caller applies the platform default — which is what the call performs unless
 * something it cannot see says otherwise. A literal outside the shared
 * vocabulary reads as {@link UNSUPPORTED_METHOD} instead, which is *not* the
 * same as absent: the platform default must not be substituted for a method
 * the source states.
 *
 * @param object The init object literal.
 * @returns The reading.
 */
function literalMethodIn(object: ObjectLiteralExpression): MethodReading {
  for (const property of object.getProperties()) {
    if (!Node.isPropertyAssignment(property)) {
      continue;
    }

    if (propertyNameOf(property.getNameNode()) !== METHOD_PROPERTY_NAME) {
      continue;
    }

    const initializer = property.getInitializer();

    if (initializer === undefined) {
      return ABSENT_METHOD;
    }

    const literal = literalTextOf(initializer);

    return literal === undefined ? ABSENT_METHOD : readMethod(literal);
  }

  return ABSENT_METHOD;
}

/**
 * The method a `fetch` call performs, and whether the source stated one this
 * vocabulary cannot name.
 *
 * Two of the three readings produce a method: an init object's literal
 * `method` when it is a vocabulary member, and {@link DEFAULT_FETCH_METHOD}
 * when the source states none — which is what the platform API does rather
 * than a guess about intent, and how this reconciles with
 * `ApiCallNodeData.method`'s "absent when the call relies on the default".
 *
 * The third produces none. A literal the vocabulary lacks means the call
 * performs neither that method (it cannot be recorded) nor `GET` (it is not
 * what the call does), so the node records no method and says so through
 * `unsupported`, which the caller surfaces once per site.
 *
 * @param init The second argument, or `undefined` when the call has one argument.
 * @returns The method to record, or `undefined` with `unsupported` set.
 */
function fetchMethodOf(init: Node | undefined): FetchMethod {
  const reading =
    init === undefined || !Node.isObjectLiteralExpression(init)
      ? ABSENT_METHOD
      : literalMethodIn(init);

  switch (reading.kind) {
    case 'method':
      return { method: reading.method, unsupported: false };
    case 'unsupported':
      return { method: undefined, unsupported: true };
    default:
      return { method: DEFAULT_FETCH_METHOD, unsupported: false };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Shape 4 — forwarding wrappers
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many local variables are followed from a `fetch` URL argument back to
 * the wrapper's parameter: `const url = `${base}${path}``, then `fetch(url)`,
 * is one hop.
 *
 * A hop goes to the declaration the name actually binds to (see
 * {@link localInitializersOf}): a `const`, `let` or `var` declared with a
 * plain identifier and an initializer, anywhere inside the wrapper — nested
 * closures included — and what is followed is that initializer. Two hops cover
 * a URL assembled in two steps without turning the check into general
 * data-flow analysis, so a later reassignment of the variable is not tracked.
 */
const MAX_FORWARDING_HOPS = 2;

/**
 * The verdict for each function-like declaration: whether it forwards its
 * first parameter into the URL of a `fetch` call. Keyed by the declaration
 * node, so a wrapper called from many sites is analysed once per project run
 * and nothing outlives the ts-morph project that owns the node.
 */
const forwardingVerdicts = new WeakMap<Node, boolean>();

/**
 * The function a declaration binds: a function declaration or method, or a
 * variable initialised with an arrow function or function expression.
 *
 * @param declaration One declaration of the callee's symbol.
 * @returns The function-like node, or `undefined` for anything else.
 */
function functionLikeOf(declaration: Node): Node | undefined {
  if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) {
    return declaration;
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    ) {
      return initializer;
    }
  }
  return undefined;
}

/**
 * The binding an identifier names, as the compiler resolved it: the symbol of
 * the declaration that name refers to in the scope it is written in.
 *
 * This is what makes shape 4 lexical rather than textual. A block `const`, a
 * `catch` clause and a nested function's parameter that re-declare a name each
 * declare a symbol of their own, so a read of the re-declared name resolves to
 * that symbol and not to the parameter it shadows; a closure that *captures*
 * the parameter resolves to the parameter's own symbol.
 *
 * One position needs the other half of the answer. The name of a shorthand
 * property (`{ path }`) is at once the new object's property and a read of the
 * variable it copies, and the compiler answers the *property* for the name, so
 * the property's value symbol is asked for instead.
 *
 * A lookup the compiler cannot answer — or one that throws, which the program
 * of a broken project may — yields `undefined`, and every caller reads that as
 * "a binding this module cannot vouch for": never the parameter, never
 * followed.
 *
 * @param identifier An identifier inside a wrapper candidate.
 * @returns The binding's symbol, or `undefined` when it cannot be resolved.
 */
function bindingOf(identifier: Identifier): BindingSymbol | undefined {
  try {
    const parent = identifier.getParent();

    return Node.isShorthandPropertyAssignment(parent) &&
      parent.getNameNode().compilerNode === identifier.compilerNode
      ? parent.getValueSymbol()
      : identifier.getSymbol();
  } catch {
    return undefined;
  }
}

/**
 * Whether two symbols are one binding.
 *
 * Compared on the compiler's own symbol, because that is the identity the
 * checker guarantees; a ts-morph wrapper is a cache entry over it, and one
 * symbol is not promised a single wrapper.
 *
 * @param left One binding.
 * @param right The other.
 * @returns `true` when both name the same declaration.
 */
function isSameBinding(left: BindingSymbol, right: BindingSymbol): boolean {
  return left.compilerSymbol === right.compilerSymbol;
}

/**
 * The binding of a function's first parameter, when it is a plain identifier.
 *
 * @param fn A function-like node from {@link functionLikeOf}.
 * @returns The parameter's symbol, or `undefined` for no parameter, a
 * destructuring pattern, or a symbol the compiler cannot resolve.
 */
function firstParameterBindingOf(fn: Node): BindingSymbol | undefined {
  if (
    !Node.isFunctionDeclaration(fn) &&
    !Node.isMethodDeclaration(fn) &&
    !Node.isArrowFunction(fn) &&
    !Node.isFunctionExpression(fn)
  ) {
    return undefined;
  }
  const nameNode = fn.getParameters()[0]?.getNameNode();
  return nameNode !== undefined && Node.isIdentifier(nameNode) ? bindingOf(nameNode) : undefined;
}

/**
 * Whether an identifier is written in a *name* position — a property name after
 * a dot, a property assignment's key — where it names a member rather than
 * reading a binding.
 *
 * A fast path, not the rule: such a name resolves to a property symbol, which
 * is never the parameter's, so skipping it only spares a symbol lookup.
 * Whether a name reads the parameter is decided by {@link bindingOf}.
 *
 * @param identifier The identifier.
 * @returns `true` when it does not read a binding.
 */
function isNamePosition(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (parent === undefined) {
    return false;
  }
  if (Node.isPropertyAccessExpression(parent)) {
    return parent.getNameNode() === identifier;
  }
  if (Node.isPropertyAssignment(parent)) {
    return parent.getNameNode() === identifier;
  }
  return false;
}

/**
 * Whether a node lies inside a function: the function itself or any node
 * beneath it, nested closures included.
 *
 * Compared on the compiler's nodes, for the reason {@link isSameBinding}
 * compares the compiler's symbols.
 *
 * @param node The node.
 * @param fn The function.
 * @returns `true` when `fn` is `node` or one of its ancestors.
 */
function isInside(node: Node, fn: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.getParent()) {
    if (current.compilerNode === fn.compilerNode) {
      return true;
    }
  }
  return false;
}

/**
 * The initializers a hop may follow from a binding: those of its declarations
 * that are local variables of the wrapper.
 *
 * A declaration qualifies when it is a `const`, `let` or `var` declared with a
 * plain identifier and an initializer, and lies inside `fn` — at any depth, so
 * a local of a nested closure that builds the URL from the captured parameter
 * is followed. Everything else declines: a destructured name, a declaration
 * without an initializer (a `catch` clause's binding is one), a parameter, a
 * function, an import, and any declaration outside the wrapper. `var` is the
 * one binding that can carry several declarations, and each qualifying one is
 * returned.
 *
 * @param binding The symbol an identifier resolved to.
 * @param fn The wrapper function.
 * @returns The initializers, in declaration order; empty when none qualifies.
 */
function localInitializersOf(binding: BindingSymbol, fn: Node): readonly Node[] {
  const initializers: Node[] = [];
  for (const declaration of binding.getDeclarations()) {
    if (!Node.isVariableDeclaration(declaration) || !Node.isIdentifier(declaration.getNameNode())) {
      continue;
    }
    const initializer = declaration.getInitializer();
    if (initializer !== undefined && isInside(declaration, fn)) {
      initializers.push(initializer);
    }
  }
  return initializers;
}

/**
 * Whether an expression reads the wrapper's first parameter, directly or
 * through at most `hops` local variables of the wrapper.
 *
 * An identifier reads the parameter exactly when {@link bindingOf} resolves it
 * to the parameter's own symbol; its spelling is irrelevant. An identifier
 * bound to anything else is followed, while hops remain, through
 * {@link localInitializersOf} — the declaration it actually binds to, never the
 * first declaration that happens to share its name. One whose binding cannot
 * be resolved reads nothing.
 *
 * @param expression The `fetch` URL argument, or an initializer it leads to.
 * @param parameter The binding of the wrapper's first parameter.
 * @param fn The wrapper function.
 * @param hops How many more local variables may be followed.
 * @returns `true` when the parameter reaches the expression.
 */
function readsBinding(expression: Node, parameter: BindingSymbol, fn: Node, hops: number): boolean {
  const identifiers = Node.isIdentifier(expression)
    ? [expression]
    : expression.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const identifier of identifiers) {
    if (isNamePosition(identifier)) {
      continue;
    }
    const binding = bindingOf(identifier);
    if (binding === undefined) {
      continue;
    }
    if (isSameBinding(binding, parameter)) {
      return true;
    }
    if (
      hops > 0 &&
      localInitializersOf(binding, fn).some((initializer) =>
        readsBinding(initializer, parameter, fn, hops - 1),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Judges a function afresh: whether any `fetch` in its body, nested closures
 * included, is given a URL that reads the function's first parameter.
 *
 * A failure anywhere in the judgement — the tree or the checker throwing on a
 * project it cannot fully read — is a verdict of "not a wrapper": this is a
 * classification, and a call through a function it cannot vouch for is an
 * ordinary call.
 *
 * @param fn A function-like node from {@link functionLikeOf}.
 * @returns `true` when the function is a forwarding wrapper.
 */
function judgeForwarding(fn: Node): boolean {
  try {
    const parameter = firstParameterBindingOf(fn);
    return (
      parameter !== undefined &&
      fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
        const url = call.getArguments()[0];
        return (
          isFetchCallee(call.getExpression()) &&
          url !== undefined &&
          readsBinding(url, parameter, fn, MAX_FORWARDING_HOPS)
        );
      })
    );
  } catch {
    return false;
  }
}

/**
 * Whether a function forwards its first parameter into the URL of a `fetch`
 * call in its own body — the defining property of a project's own HTTP client
 * function, and a property of the code rather than of any name.
 *
 * "Its first parameter" is that parameter's binding, not its spelling (see
 * {@link bindingOf}), and each verdict is judged once per declaration and kept
 * in {@link forwardingVerdicts}.
 *
 * @param fn A function-like node from {@link functionLikeOf}.
 * @returns `true` when the function is a forwarding wrapper.
 */
function forwardsToFetch(fn: Node): boolean {
  const known = forwardingVerdicts.get(fn);
  if (known !== undefined) {
    return known;
  }
  const verdict = judgeForwarding(fn);
  forwardingVerdicts.set(fn, verdict);
  return verdict;
}

/**
 * Whether a callee resolves to a forwarding wrapper declared in the analysed
 * project (never a declaration file or a dependency).
 *
 * Resolution goes through the type checker, including an import alias, so a
 * wrapper imported from another module is recognised at every call site. A
 * callee the checker cannot resolve is simply not a wrapper: this is a
 * classification, and an unresolvable callee is an ordinary call.
 *
 * @param callee The called expression.
 * @returns `true` when the call is made through a forwarding wrapper.
 */
function isForwardingWrapperCallee(callee: Node): boolean {
  try {
    const symbol = callee.getSymbol();
    if (symbol === undefined) {
      return false;
    }
    const resolved = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
    for (const declaration of resolved.getDeclarations()) {
      const fn = functionLikeOf(declaration);
      if (fn === undefined) {
        continue;
      }
      const sourceFile = fn.getSourceFile();
      if (sourceFile.isDeclarationFile() || sourceFile.isInNodeModules()) {
        continue;
      }
      if (forwardsToFetch(fn)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The method a forwarding-wrapper call states: an options object's literal
 * `method`, read as a `fetch` init is. With none stated the node records no
 * method, because the wrapper's own default is not something the call site
 * says (and {@link DEFAULT_FETCH_METHOD} is the platform's default, not the
 * wrapper's).
 *
 * @param options The call's second argument.
 * @returns The method to record, or `undefined` with `unsupported` set.
 */
function forwardedMethodOf(options: Node | undefined): FetchMethod {
  const reading =
    options === undefined || !Node.isObjectLiteralExpression(options)
      ? ABSENT_METHOD
      : literalMethodIn(options);
  switch (reading.kind) {
    case 'method':
      return { method: reading.method, unsupported: false };
    case 'unsupported':
      return { method: undefined, unsupported: true };
    default:
      return { method: undefined, unsupported: false };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Shape 1 and 3 — `fetch` and client wrappers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a receiver is one of the globals the platform's `fetch` lives on.
 *
 * @param receiver The expression before the dot.
 * @returns `true` for `window`, `globalThis` or `self`.
 */
function isGlobalReceiver(receiver: Node): boolean {
  return Node.isIdentifier(receiver) && GLOBAL_RECEIVER_NAMES.includes(receiver.getText());
}

/**
 * Whether a callee is the platform's `fetch`.
 *
 * The bare identifier, or the member `fetch` on a global receiver. A `fetch`
 * member on anything else is a different function — the shape a wrapper client
 * or a mock is written with — and is deliberately not matched here; see
 * {@link GLOBAL_RECEIVER_NAMES}.
 *
 * @param callee The called expression.
 * @returns `true` when the call is a platform `fetch`.
 */
function isFetchCallee(callee: Node): boolean {
  if (Node.isIdentifier(callee)) {
    return callee.getText() === FETCH_NAME;
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }

  return callee.getName() === FETCH_NAME && isGlobalReceiver(callee.getExpression());
}

/**
 * The call site a call expression is, or `undefined` when it is not a request.
 *
 * Three of the four recognised shapes, tested in this order:
 *
 * 1. **`fetch(url, init?)`** — the target is the first argument and the method
 *    the init object's literal `method`, defaulting to `GET`.
 * 2. **`receiver.verb(url, …)`** — a client wrapper: the member name is an
 *    HTTP verb *and* the first argument is path-like. Both halves are
 *    required, which is what keeps `list.get(3)` and `map.delete(key)` out of
 *    the graph.
 * 3. **`wrapper(url, options?)`** — a forwarding wrapper: the first argument
 *    is path-like and the callee resolves to a project function that forwards
 *    its first parameter into a `fetch` URL ({@link isForwardingWrapperCallee}).
 *    The method is the options object's literal `method`, or none.
 *
 * The node's position is the callee's start in every case: at `fetch` or the
 * wrapper for a bare call, and at the receiver for a property access
 * (`window.fetch(…)`, `api.get(…)`), which is where a developer's eye and an
 * editor's cursor belong.
 *
 * @param call The call expression to classify.
 * @returns The call site, or `undefined`.
 */
function classifyCall(call: CallExpression): CallSite | undefined {
  const callee = call.getExpression();
  const args = call.getArguments();
  const first = args[0];
  const second = args[1];

  // Shape 1 — `fetch('/x')`, `window.fetch('/x', { method: 'POST' })`.
  if (isFetchCallee(callee)) {
    const { method, unsupported } = fetchMethodOf(second);

    return {
      shape: 'fetch',
      name: textOr(callee, FETCH_NAME),
      anchor: callee,
      extent: call,
      expression: call,
      target: targetOf(first),
      method,
      unsupportedMethod: unsupported,
    };
  }

  if (first === undefined || !isPathLike(first)) {
    return undefined;
  }

  // Shape 3 — `api.get('/x')`, `http.post(`/y/${id}`, body)`. The verb is the
  // method, and the receiver's text is the wrapper the node is named for (the
  // verb would otherwise be recorded twice; see the header).
  const method = Node.isPropertyAccessExpression(callee)
    ? wrapperMethodOf(callee.getName())
    : undefined;

  if (method === undefined || !Node.isPropertyAccessExpression(callee)) {
    // Shape 4 — `request('/x', { method: 'POST' })`, where `request` is a
    // function of this project that forwards its first parameter into a
    // `fetch` URL. Named for the callee as written, like a `fetch`.
    if (
      (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) &&
      isForwardingWrapperCallee(callee)
    ) {
      const forwarded = forwardedMethodOf(second);

      return {
        shape: 'forwarder',
        name: textOr(callee, callee.getText()),
        anchor: callee,
        extent: call,
        expression: call,
        target: targetOf(first),
        method: forwarded.method,
        unsupportedMethod: forwarded.unsupported,
      };
    }

    return undefined;
  }

  return {
    shape: 'wrapper',
    name: textOr(callee.getExpression(), callee.getName()),
    anchor: callee,
    extent: call,
    expression: call,
    target: targetOf(first),
    method,
    // A wrapper call is recognised *by* its verb being a vocabulary member, so
    // this shape can never carry an unsupported one.
    unsupportedMethod: false,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Shape 2 — `XMLHttpRequest`
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a construction's callee is `XMLHttpRequest`.
 *
 * The bare identifier or the member on a global receiver, on the same terms as
 * {@link isFetchCallee}.
 *
 * @param callee The constructed expression.
 * @returns `true` when the construction creates an `XMLHttpRequest`.
 */
function isXhrCallee(callee: Node): boolean {
  if (Node.isIdentifier(callee)) {
    return callee.getText() === XHR_CONSTRUCTOR_NAME;
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }

  return callee.getName() === XHR_CONSTRUCTOR_NAME && isGlobalReceiver(callee.getExpression());
}

/**
 * The local name a construction is bound to, or `undefined` when it is bound
 * to nothing a later `.open(…)` call could name.
 *
 * Two shapes bind a name simply enough to pair on: `const xhr = new …` and
 * `xhr = new …`. Anything else — a property assignment, an argument, a
 * returned expression, a destructuring — is not paired, and the caller then
 * records the construction with an unknown target rather than reaching for a
 * heuristic.
 *
 * @param construction The `new` expression.
 * @returns The bound identifier's text, or `undefined`.
 */
function boundNameOf(construction: NewExpression): string | undefined {
  const parent = construction.getParent();

  if (Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();

    return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
  }

  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getText() === ASSIGNMENT_OPERATOR
  ) {
    const left = parent.getLeft();

    return Node.isIdentifier(left) ? left.getText() : undefined;
  }

  return undefined;
}

/**
 * The function a node sits in, or the file itself when it sits in none.
 *
 * The scope `XMLHttpRequest` pairing is confined to: a construction in one
 * function and an `.open(…)` on the same name in another are not the same
 * request, and treating them as one would attach a target to a site that never
 * requests it.
 *
 * @param node The node to find the enclosing function of.
 * @returns The enclosing function-like node, or the source file.
 */
function scopeOf(node: Node): Node {
  return (
    node.getAncestors().find((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) ??
    node.getSourceFile()
  );
}

/**
 * Visits every descendant of a scope that belongs to **its own** body, never a
 * nested function's.
 *
 * The traversal every question about an `XMLHttpRequest` binding is asked
 * through, and the reason is lifetime rather than tidiness: a nested function
 * is a separate body that runs at a time of its own and may re-declare the
 * name, so a construction there and an `.open(…)` here (or the reverse) are
 * two different objects however alike the source looks. Descending into
 * blocks, loops and conditionals is still correct — those are the same body —
 * which is why the skip is specifically of function-like nodes.
 *
 * The scope node itself is not visited, which is what `forEachDescendant`
 * already does, so a function-like scope does not skip its own body.
 *
 * @param scope The enclosing function or file.
 * @param visit Called for each node of that scope's own body.
 */
function forEachInBody(scope: Node, visit: (node: Node) => void): void {
  scope.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();

      return;
    }

    visit(node);
  });
}

/**
 * How many `XMLHttpRequest` constructions in one body are bound to a name.
 *
 * More than one means the name is re-bound within the same body, so no single
 * construction owns the `.open(…)` calls that follow and pairing is abandoned.
 * Counting is cheaper and more honest than trying to order re-bindings against
 * calls. Constructions inside nested functions are *not* counted — they bind
 * their own name in their own body, and counting them would make a shadowing
 * construction elsewhere cost this one its target.
 *
 * @param scope The enclosing function or file.
 * @param name The bound name to count constructions for.
 * @returns The number of constructions bound to that name in this body.
 */
function xhrConstructionCount(scope: Node, name: string): number {
  let count = 0;

  forEachInBody(scope, (node) => {
    if (
      Node.isNewExpression(node) &&
      isXhrCallee(node.getExpression()) &&
      boundNameOf(node) === name
    ) {
      count += 1;
    }
  });

  return count;
}

/**
 * The declaration and the assignment that bind a construction to its name, as
 * far as one of them does.
 *
 * Exactly one is present for a construction {@link boundNameOf} named: the
 * declarator of `const xhr = new XMLHttpRequest()`, or the assignment of
 * `xhr = new XMLHttpRequest()`. They are the *permitted* binding events for
 * that name; {@link bindingRebound} treats every other one as a re-binding.
 *
 * @param construction The `new` expression.
 * @returns Its own binding events.
 */
function ownBindingOf(construction: NewExpression): {
  readonly declaration: Node | undefined;
  readonly assignment: Node | undefined;
} {
  const parent = construction.getParent();

  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === construction) {
    return { declaration: parent, assignment: undefined };
  }

  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getText() === ASSIGNMENT_OPERATOR &&
    parent.getRight() === construction
  ) {
    return { declaration: undefined, assignment: parent };
  }

  return { declaration: undefined, assignment: undefined };
}

/**
 * Whether an operator token replaces what its left-hand side holds.
 *
 * Every assignment form, not only `=`: `xhr = other`, `xhr ??= other` and
 * `xhr &&= other` all leave the name holding something this construction did
 * not create, and a compound arithmetic assignment leaves it holding a value
 * that is not a request object at all. The test is "ends with `=` and is not a
 * comparison", which covers the whole family — including one added to the
 * language later — without enumerating it.
 *
 * @param operator The operator token's source text.
 * @returns `true` for an assignment of any form.
 */
function isAssignmentOperator(operator: string): boolean {
  return operator.endsWith(ASSIGNMENT_OPERATOR) && !COMPARISON_OPERATORS.includes(operator);
}

/**
 * Whether a declaration is the `let xhr;` of a `let xhr; xhr = new …` pair.
 *
 * The one declaration that binds the name and is still the construction's own
 * binding, recognised by three facts rather than by its spelling: it declares
 * no value of its own, the statement list it belongs to encloses the
 * assignment, and it is written before that assignment. A declarator in a
 * nested block, a `for` head or a `catch` clause satisfies none of them, which
 * is what makes each of those a shadow.
 *
 * @param declaration A declaration that binds the construction's name.
 * @param ownAssignment The assignment that bound the construction, if one did.
 * @returns `true` when the declaration is that assignment's own binding.
 */
function declaresOwnBinding(
  declaration: VariableDeclaration,
  ownAssignment: Node | undefined,
): boolean {
  if (ownAssignment === undefined || declaration.getInitializer() !== undefined) {
    return false;
  }

  const statement = declaration.getVariableStatement();
  const container = statement?.getParent();

  if (statement === undefined || container === undefined) {
    return false;
  }

  return (
    container.getStart() <= ownAssignment.getStart() &&
    container.getEnd() >= ownAssignment.getEnd() &&
    statement.getEnd() <= ownAssignment.getStart()
  );
}

/**
 * Whether anything in one body binds a name other than as this construction's
 * own binding.
 *
 * Lexical honesty, and deliberately **conservative**: pairing is abandoned
 * unless the name has exactly one binding in the body and that binding is this
 * construction's. Every other binding event counts, whatever its shape —
 *
 * - a declaration of the name that is not this construction's, **including one
 *   that declares no value**: `{ let xhr; xhr.open(…) }` in a nested block,
 *   a `for (const xhr of …)` head, a `catch (xhr)` clause and a destructured
 *   `const { xhr } = …` each bind a *different* object for every use inside
 *   their scope. The one exception is the `let xhr; xhr = new XMLHttpRequest()`
 *   pair, which {@link declaresOwnBinding} recognises;
 * - an assignment of any form — `=`, `??=`, `&&=`, `+=` — other than the one
 *   that bound this construction;
 * - an increment or decrement of the name, which leaves it holding a number.
 *
 * That strictness is what lets {@link openCallsOn} match an `.open(…)`
 * receiver by its identifier text: when this returns `false`, the name has one
 * binding in the body and the text therefore *is* the binding.
 *
 * @param scope The enclosing function or file.
 * @param name The construction's bound name.
 * @param construction The construction whose binding is in question.
 * @returns `true` when the name is bound anywhere else in this body.
 */
function bindingRebound(scope: Node, name: string, construction: NewExpression): boolean {
  const own = ownBindingOf(construction);
  let rebound = false;
  let permitted = 0;

  forEachInBody(scope, (node) => {
    if (rebound) {
      return;
    }

    if (Node.isVariableDeclaration(node)) {
      if (boundIdentifier(node.getNameNode(), name) === undefined || node === own.declaration) {
        return;
      }

      if (declaresOwnBinding(node, own.assignment)) {
        permitted += 1;
        // Two initialiser-free declarations of one name leave no single binding
        // the assignment can be said to have bound.
        rebound = permitted > 1;

        return;
      }

      rebound = true;

      return;
    }

    rebound = assignsName(node, name, own.assignment);
  });

  return rebound;
}

/**
 * Whether a node assigns, increments or decrements a name other than as the
 * construction's own binding.
 *
 * The expression half of {@link bindingRebound}, separated so each shape is a
 * single expression rather than an assignment whose correctness depends on the
 * order of the walk.
 *
 * @param node The node to test.
 * @param name The construction's bound name.
 * @param ownAssignment The assignment that bound the construction, if one did.
 * @returns `true` when this node rebinds the name.
 */
function assignsName(node: Node, name: string, ownAssignment: Node | undefined): boolean {
  if (Node.isBinaryExpression(node) && isAssignmentOperator(node.getOperatorToken().getText())) {
    const left = node.getLeft();

    return Node.isIdentifier(left) && left.getText() === name && node !== ownAssignment;
  }

  if (Node.isPostfixUnaryExpression(node)) {
    // `xhr++` and `xhr--`, the only postfix operators there are.
    return Node.isIdentifier(node.getOperand()) && node.getOperand().getText() === name;
  }

  if (Node.isPrefixUnaryExpression(node) && UPDATE_OPERATORS.includes(node.getOperatorToken())) {
    return Node.isIdentifier(node.getOperand()) && node.getOperand().getText() === name;
  }

  return false;
}

/**
 * Every `<name>.open(…)` call in one body that starts after an offset, in
 * source order.
 *
 * Confined to the scope's own body by {@link forEachInBody}: an `.open(…)`
 * written inside a callback is that callback's statement, made at a time this
 * module cannot order against the construction, and pairing across that
 * boundary is the mixing of lifetimes the caller's confidence rule exists to
 * refuse. Such a construction records an unknown target instead, which is the
 * honest answer rather than a lost one.
 *
 * @param scope The enclosing function or file.
 * @param name The binding the call must be written on.
 * @param afterOffset The construction's end offset.
 * @returns The candidate calls, in source order.
 */
function openCallsOn(scope: Node, name: string, afterOffset: number): readonly CallExpression[] {
  const calls: CallExpression[] = [];

  forEachInBody(scope, (node) => {
    if (!Node.isCallExpression(node) || node.getStart() < afterOffset) {
      return;
    }

    const callee = node.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== XHR_OPEN_NAME) {
      return;
    }

    const receiver = callee.getExpression();

    if (Node.isIdentifier(receiver) && receiver.getText() === name) {
      calls.push(node);
    }
  });

  return calls;
}

/**
 * The `.open(method, url)` call that states a construction's target, or
 * `undefined` when the pairing is not unambiguous.
 *
 * Confident means all four of these, and the last two are what keep one
 * request's target off another request's node:
 *
 * 1. the construction binds a plain local name;
 * 2. that name is bound by exactly one construction **in the same body**;
 * 3. nothing else in that body binds the name (see {@link bindingRebound});
 * 4. exactly one `.open(…)` call on it follows, in that same body.
 *
 * Anything less is unpaired — the prompt's rule and the honest one, since a
 * wrong target is worse than a missing one.
 *
 * @param construction The `new XMLHttpRequest()` expression.
 * @returns The paired call, or `undefined`.
 */
function pairedOpenCall(construction: NewExpression): CallExpression | undefined {
  const name = boundNameOf(construction);

  if (name === undefined) {
    return undefined;
  }

  const scope = scopeOf(construction);

  if (xhrConstructionCount(scope, name) !== 1) {
    return undefined;
  }

  if (bindingRebound(scope, name, construction)) {
    return undefined;
  }

  const calls = openCallsOn(scope, name, construction.getEnd());

  return calls.length === 1 ? calls[0] : undefined;
}

/**
 * The call site an `XMLHttpRequest` construction is, or `undefined` when the
 * construction is something else.
 *
 * The node is anchored at the constructor — the construction is where the
 * request originates and what a developer searches for — while its target and
 * method come from the paired `.open(…)` call and its extent stretches to
 * whichever of the two ends later. An unpaired construction still yields a
 * node: a request object was created here, which is evidence, and its target
 * is simply unknown.
 *
 * @param construction The `new` expression to classify.
 * @returns The call site, or `undefined`.
 */
function classifyConstruction(construction: NewExpression): CallSite | undefined {
  const callee = construction.getExpression();

  if (!isXhrCallee(callee)) {
    return undefined;
  }

  const name = textOr(callee, XHR_CONSTRUCTOR_NAME);
  const paired = pairedOpenCall(construction);

  if (paired === undefined) {
    return {
      shape: 'xhr',
      name,
      anchor: callee,
      extent: construction,
      expression: construction,
      target: UNKNOWN_TARGET,
      method: undefined,
      unsupportedMethod: false,
    };
  }

  const args = paired.getArguments();
  const methodArgument = args[0];
  const urlArgument = args[1];
  const literalMethod = methodArgument === undefined ? undefined : literalTextOf(methodArgument);
  // `open()`'s method argument is required, so a non-literal one means the
  // method is computed — the case `ApiCallNodeData.method` prescribes absence
  // for. There is no platform default to fall back on, so an unsupported
  // literal is recorded the same way an absent one is: as no method, with the
  // omission reported.
  const reading = literalMethod === undefined ? ABSENT_METHOD : readMethod(literalMethod);

  return {
    shape: 'xhr',
    name,
    anchor: callee,
    extent: paired,
    expression: construction,
    target: targetOf(urlArgument),
    method: reading.kind === 'method' ? reading.method : undefined,
    unsupportedMethod: reading.kind === 'unsupported',
  };
}

/* -------------------------------------------------------------------------------------------------
 * Collecting one file's call sites
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every recognised call site of one file, in source order.
 *
 * One pre-order traversal, so emission order is document order and two runs
 * serialise identically. Each classification is guarded on its own: an
 * expression that cannot be read costs its own node and nothing else, which is
 * the degradation rule `../indexer.ts` applies at the file level applied here
 * at the construct level.
 *
 * A call nested inside another recognised call (`fetch(api.get('/x'))`) yields
 * two nodes, because there are two requests.
 *
 * @param sourceFile The module to scan.
 * @param file That module's project-relative POSIX path.
 * @param diagnostics Collector for per-construct findings.
 * @returns The call sites, in source order.
 */
function collectCallSites(
  sourceFile: SourceFile,
  file: string,
  diagnostics: IndexDiagnostic[],
): readonly CallSite[] {
  const sites: CallSite[] = [];

  sourceFile.forEachDescendant((node) => {
    try {
      if (Node.isCallExpression(node)) {
        const site = classifyCall(node);

        if (site !== undefined) {
          sites.push(site);
        }
      } else if (Node.isNewExpression(node)) {
        const site = classifyConstruction(node);

        if (site !== undefined) {
          sites.push(site);
        }
      }
    } catch (cause) {
      diagnostics.push(constructFailure(file, node, cause));
    }
  });

  return sites;
}

/* -------------------------------------------------------------------------------------------------
 * Module facts: router convention, component shape, markup bindings
 * ---------------------------------------------------------------------------------------------- */

/**
 * The stem of a path's last segment: its basename without the extension.
 *
 * @param file A project-relative POSIX path.
 * @returns The basename's stem, or `undefined` for a path with no segment.
 */
function basenameStem(file: string): string | undefined {
  const segments = file.split(PATH_SEPARATOR);
  const basename = segments[segments.length - 1];

  if (basename === undefined || basename.length === 0) {
    return undefined;
  }

  const separator = basename.lastIndexOf(EXTENSION_SEPARATOR);

  return separator <= 0 ? basename : basename.slice(0, separator);
}

/**
 * Whether a path makes its module a route or page module of either Next.js
 * router.
 *
 * **This derives no URL and must not.** Every question about what path a file
 * serves — route groups, dynamic segments, catch-alls, index collapsing,
 * special files — belongs to `../route-map.ts`, which owns the one
 * implementation. This is a *classification*: `app/**\/route.*` and
 * `app/**\/page.*` under the App Router, and everything under `pages/`, with
 * one optional `src/` prefix. Its only effect is to keep a route module's
 * handlers out of the cascade's server-function branch, which is a decision
 * about which node kind an edge starts at and never a statement about a URL.
 *
 * A misclassification is therefore cheap in both directions: a route module
 * read as an ordinary module attributes its calls to a `server-function` node
 * instead of a `symbol` node, and the reverse attributes them to a `symbol`
 * node instead. Both nodes exist for an exported module-level function.
 *
 * @param file The module's project-relative POSIX path.
 * @returns `true` when the module belongs to a router convention.
 */
function isRouteModulePath(file: string): boolean {
  const segments = file.split(PATH_SEPARATOR);
  const rootIndex = segments[0] === SOURCE_DIRECTORY ? 1 : 0;
  const root = segments[rootIndex];

  if (root === PAGES_ROUTER_DIRECTORY) {
    // Every module under the Pages Router is a page or an API route, including
    // its special files, so the path alone settles it.
    return segments.length > rootIndex + 1;
  }

  if (root !== APP_ROUTER_DIRECTORY) {
    return false;
  }

  const stem = basenameStem(file);

  return stem !== undefined && ROUTE_MODULE_STEMS.includes(stem);
}

/**
 * Whether a module-level declaration's name has the component shape: a
 * leading upper-case letter.
 *
 * @param name The declared name.
 * @returns `true` when the name starts with an upper-case letter.
 */
function hasComponentName(name: string): boolean {
  const initial = name.charAt(0);

  return initial.length > 0 && initial !== initial.toLowerCase();
}

/**
 * Whether a module declares anything that could be a component.
 *
 * Deliberately **permissive**, and the header says why: a module-level
 * upper-case-named declaration, or a nameless default export, is enough. This
 * is not component *detection* — `./react-components.ts` owns that, with a
 * stricter "returns markup" rule — it is the guard that keeps the cascade's
 * server-function branch away from a module whose exported functions are
 * components. Over-answering `true` can only move an edge from a
 * `server-function` node to a `symbol` node, both of which exist; under-
 * answering could point an edge at a `server-function` node nobody emits,
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

/* -------------------------------------------------------------------------------------------------
 * Route identity, reproduced from `../route-map.ts`
 * ---------------------------------------------------------------------------------------------- */

/**
 * What one URL-contributing directory or file name contributes to a route
 * path, or nothing at all.
 *
 * Three outcomes: the segment as written, {@link SKIPPED_SEGMENT} for a
 * directory that organises the tree without appearing in the URL, and
 * `undefined` for a spelling that makes the file non-routable — which stops
 * the whole derivation rather than dropping one segment.
 *
 * Only the *legal* dynamic spellings are recognised, longest form first, and
 * any other bracketed name is refused: a segment whose URL contribution is
 * unknowable has no honest reading, and inventing one would spell a route path
 * `../route-map.ts` never derived and therefore an `api-route` node id nobody
 * emitted.
 *
 * @param raw The directory or file name, exactly as written on disk.
 * @returns The segment text, the skip marker, or `undefined`.
 */
function classifyRouteSegment(raw: string): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }

  if (raw.startsWith(OPTIONAL_CATCH_ALL_OPEN) && raw.endsWith(OPTIONAL_CATCH_ALL_CLOSE)) {
    return ROUTE_PARAM_NAME.test(
      raw.slice(OPTIONAL_CATCH_ALL_OPEN.length, -OPTIONAL_CATCH_ALL_CLOSE.length),
    )
      ? raw
      : undefined;
  }

  if (
    raw.startsWith(CATCH_ALL_OPEN) &&
    raw.endsWith(DYNAMIC_CLOSE) &&
    !raw.endsWith(OPTIONAL_CATCH_ALL_CLOSE)
  ) {
    return ROUTE_PARAM_NAME.test(raw.slice(CATCH_ALL_OPEN.length, -DYNAMIC_CLOSE.length))
      ? raw
      : undefined;
  }

  if (
    raw.startsWith(DYNAMIC_OPEN) &&
    raw.endsWith(DYNAMIC_CLOSE) &&
    !raw.startsWith(OPTIONAL_DYNAMIC_OPEN)
  ) {
    return ROUTE_PARAM_NAME.test(raw.slice(DYNAMIC_OPEN.length, -DYNAMIC_CLOSE.length))
      ? raw
      : undefined;
  }

  if (raw.includes(DYNAMIC_OPEN) || raw.includes(DYNAMIC_CLOSE)) {
    return undefined;
  }

  return raw;
}

/**
 * What one directory above an App Router module contributes to its URL.
 *
 * The App Router's three organisational forms come first — a private
 * `_folder` opts its subtree out of routing entirely, an intercepting-route
 * marker makes the served URL unknowable from the path, and a `(group)` or an
 * `@slot` contributes nothing — and an ordinary name then falls through to
 * {@link classifyRouteSegment}.
 *
 * @param raw The directory name, exactly as written on disk.
 * @returns The segment text, the skip marker, or `undefined` when the file is
 * not routable.
 */
function classifyRouteDirectory(raw: string): string | typeof SKIPPED_SEGMENT | undefined {
  if (raw.startsWith(PRIVATE_SEGMENT_PREFIX) || INTERCEPTING_SEGMENT_PREFIX.test(raw)) {
    return undefined;
  }

  if (raw.startsWith(GROUP_SEGMENT_OPEN) && raw.endsWith(GROUP_SEGMENT_CLOSE)) {
    return SKIPPED_SEGMENT;
  }

  if (raw.startsWith(SLOT_SEGMENT_PREFIX)) {
    return SKIPPED_SEGMENT;
  }

  return classifyRouteSegment(raw);
}

/**
 * Whether a segment consumes the remainder of a request path.
 *
 * @param raw The segment as written.
 * @returns `true` for `[...param]` and `[[...param]]`.
 */
function isCatchAllSegment(raw: string): boolean {
  return raw.startsWith(CATCH_ALL_OPEN) || raw.startsWith(OPTIONAL_CATCH_ALL_OPEN);
}

/**
 * The route path a list of segments spells, or `undefined` when a catch-all
 * sits anywhere but last.
 *
 * The one cross-segment rule of the convention: a catch-all consumes every
 * remaining segment, so anything after it could never match and the framework
 * rejects such a tree outright. `joinPosix` does the separator arithmetic, as
 * `../route-map.ts` has it do, so the two spell the same path for the same
 * segments rather than merely similar ones.
 *
 * @param segments The URL segments, in URL order, as written.
 * @returns The route path, or `undefined` for a misplaced catch-all.
 */
function routePathOf(segments: readonly string[]): string | undefined {
  for (const [index, segment] of segments.entries()) {
    if (isCatchAllSegment(segment) && index !== segments.length - 1) {
      return undefined;
    }
  }

  return segments.length === 0 ? ROOT_ROUTE_PATH : joinPosix(PATH_SEPARATOR, ...segments);
}

/**
 * The part of a path below a directory, or `undefined` when it is not below
 * it.
 *
 * A segment-boundary test rather than a string prefix test, so
 * `application/route.ts` is not below `app`.
 *
 * @param file A normalised project-relative path.
 * @param directory A project-relative directory path.
 * @returns The remainder, with no leading separator, or `undefined`.
 */
function belowDirectory(file: string, directory: string): string | undefined {
  const prefix = `${directory}${PATH_SEPARATOR}`;

  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

/** The non-empty segments of a POSIX path, in order. */
function pathSegmentsOf(path: string): readonly string[] {
  return path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * The route path of an App Router **request-handler** module, or `undefined`.
 *
 * `route.*` only: a `page.*` module renders a document, and the cascade's
 * route step is about the function that *answers* a request (see
 * {@link declaredOwner}), so a page's route identity is deliberately not
 * derived here. The URL is the directory the module sits in, which is the
 * whole idea of the convention.
 *
 * @param rest The part of the path below the app directory.
 * @returns The route path, or `undefined` when the module serves no URL this
 * step can claim.
 */
function appRoutePathOf(rest: string): string | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);

  if (!APP_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  if (basenamePosix(base, extension) !== APP_HANDLER_STEM) {
    return undefined;
  }

  const segments: string[] = [];

  for (const raw of pathSegmentsOf(rest).slice(0, -1)) {
    const classified = classifyRouteDirectory(raw);

    if (classified === undefined) {
      return undefined;
    }

    if (classified !== SKIPPED_SEGMENT) {
      segments.push(classified);
    }
  }

  return routePathOf(segments);
}

/**
 * The route path of a legacy Pages Router **API** module, or `undefined`.
 *
 * `pages/api/**` only, for the same reason `appRoutePathOf` takes `route.*`
 * only: a page renders. Unlike the App Router the file name is part of the
 * URL, `index` collapses to its own directory, and parentheses carry no
 * meaning in this convention — a parenthesised directory is an ordinary static
 * segment.
 *
 * @param rest The part of the path below the pages directory.
 * @returns The route path, or `undefined`.
 */
function pagesRoutePathOf(rest: string): string | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);

  if (!PAGES_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const stem = basenamePosix(base, extension);

  // `_app`, `_document`, `_error` and any other underscore-prefixed module are
  // framework hooks; a dotfile is not served; `middleware` intercepts requests
  // rather than answering one.
  if (
    stem.startsWith(PRIVATE_SEGMENT_PREFIX) ||
    stem.startsWith(EXTENSION_SEPARATOR) ||
    stem === PAGES_MIDDLEWARE_STEM
  ) {
    return undefined;
  }

  const directories = pathSegmentsOf(rest).slice(0, -1);

  // Everything outside `api/` renders a document rather than answering a
  // request, so it is not a case for the cascade's route step.
  if (directories[0] !== PAGES_API_SEGMENT) {
    return undefined;
  }

  const segments: string[] = [];

  for (const raw of directories) {
    if (raw.startsWith(PRIVATE_SEGMENT_PREFIX)) {
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

  return routePathOf(segments);
}

/**
 * The 1-based position of the **first** HTTP-method handler an App Router
 * module declares, or `undefined` when it declares none.
 *
 * This is the position `../route-map.ts` gives a handler module's route entry,
 * and therefore half of the `api-route` node's id — so the three export
 * shapes and their anchors are reproduced exactly as that module reads them:
 *
 * - `export function GET` — the declaration's own start, which is its `export`
 *   keyword. `isExported()` rather than `hasExportKeyword()`, because a
 *   function declared locally and exported through a clause is exported too;
 *   a default export is excluded, since a default is not a method.
 * - `export const POST = …` — the statement's start for a single-declarator
 *   statement, which is where a developer expects to land, and the binding's
 *   own name for a statement declaring several.
 * - `export { handler as PUT }` — the specifier's own start, including for a
 *   re-export from another module, so the position is always inside the route
 *   module a developer clicked.
 *
 * The **earliest** of those positions is the entry's, which is why only a
 * minimum is tracked: that module orders its handlers by position and then
 * drops each method's later duplicates, and dropping later entries cannot
 * change which one comes first.
 *
 * @param sourceFile The route module to read.
 * @returns The first handler's position, or `undefined`.
 */
function appHandlerPosition(sourceFile: SourceFile): Position | undefined {
  let earliest: number | undefined;

  const record = (offset: number): void => {
    if (earliest === undefined || offset < earliest) {
      earliest = offset;
    }
  };

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();

    if (name === undefined || !declaration.isExported() || declaration.isDefaultExport()) {
      continue;
    }

    if (CALL_SITE_METHODS.includes(name)) {
      record(declaration.getStart());
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) {
      continue;
    }

    const declarations = statement.getDeclarations();
    const single = declarations.length === 1;

    for (const declaration of declarations) {
      if (!CALL_SITE_METHODS.includes(declaration.getName())) {
        continue;
      }

      record(single ? statement.getStart() : declaration.getNameNode().getStart());
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    for (const specifier of exportDeclaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();

      if (CALL_SITE_METHODS.includes(exportedName)) {
        record(specifier.getStart());
      }
    }
  }

  if (earliest === undefined) {
    return undefined;
  }

  const { line, column } = sourceFile.getLineAndColumnAtPos(earliest);

  return { line, column };
}

/**
 * The 1-based position of a module's default export, or `undefined` when it
 * has none.
 *
 * The position `../route-map.ts` gives a legacy Pages Router API module's
 * route entry, in the same probe order: `export default function`,
 * `export default class`, `export default <expression>` and
 * `export { X as default }`. `export =` is skipped — a CommonJS-only form no
 * supported router serves.
 *
 * @param sourceFile The route module to read.
 * @returns The default export's position, or `undefined`.
 */
function defaultExportPosition(sourceFile: SourceFile): Position | undefined {
  const offset = defaultExportOffset(sourceFile);

  if (offset === undefined) {
    return undefined;
  }

  const { line, column } = sourceFile.getLineAndColumnAtPos(offset);

  return { line, column };
}

/**
 * The character offset a module's default export starts at, probed in
 * `../route-map.ts`'s order.
 *
 * Split from {@link defaultExportPosition} so the probe can return at its
 * first hit — the behaviour that module has — rather than collecting every
 * candidate and choosing afterwards.
 *
 * @param sourceFile The module to read.
 * @returns The offset, or `undefined` when the module has no default export.
 */
function defaultExportOffset(sourceFile: SourceFile): number | undefined {
  for (const declaration of sourceFile.getFunctions()) {
    if (declaration.isDefaultExport()) {
      return declaration.getStart();
    }
  }

  for (const declaration of sourceFile.getClasses()) {
    if (declaration.isDefaultExport()) {
      return declaration.getStart();
    }
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    if (!assignment.isExportEquals()) {
      return assignment.getStart();
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    for (const specifier of exportDeclaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();

      if (exportedName === DEFAULT_EXPORT_NAME) {
        return specifier.getStart();
      }
    }
  }

  return undefined;
}

/**
 * The `api-route` node of one module, when that module is a request-handling
 * route module whose identity is unambiguous.
 *
 * **A reproduced sibling rule, not a second derivation.** The `api-route`
 * node's id is built from a route *path* and a route entry's position, both of
 * which `../route-map.ts` owns and this module may not import (see the
 * header's contract). The rule is therefore reproduced here in the same way
 * `./event-handlers.ts`'s and `./symbols.ts`'s naming rules are — from the
 * same `@debuggen/shared` path primitives that module uses, over the same two
 * conventional router directories `./api-routes.ts` probes — and it is
 * reproduced **strictly**: every spelling the derivation cannot vouch for
 * (a private folder, an intercepting route, a malformed bracket segment, a
 * misplaced catch-all, an unsupported extension, a tree in a non-conventional
 * directory) answers `undefined`, and the cascade then falls through to the
 * `symbol` node that exists for the declaration regardless. The failure
 * direction is a less specific edge, never a dangling one.
 *
 * Only the two request-handling conventions are derived, because they are the
 * two the cascade's route step names: an App Router `route.*` module and a
 * legacy `pages/api/**` module. A `page.*` module's default export renders a
 * document rather than answering a request, so its calls keep the owner the
 * declaration itself provides.
 *
 * @param file The module's project-relative POSIX path, as `ExtractorContext`
 * spells it.
 * @param sourceFile The module, for the position its route entry carries.
 * @returns The route identity, or `undefined`.
 */
function routeIdentityOf(file: string, sourceFile: SourceFile): RouteIdentity | undefined {
  const normalized = normalizePosix(toPosix(file));

  // The same refinement `./api-routes.ts` applies before emitting a node, so
  // this step cannot claim a node that extractor declined to emit.
  if (!isSafeRelativePath(normalized)) {
    return undefined;
  }

  for (const directory of APP_DIRECTORY_CANDIDATES) {
    const rest = belowDirectory(normalized, directory);

    if (rest === undefined) {
      continue;
    }

    const routePath = appRoutePathOf(rest);

    return routePath === undefined
      ? undefined
      : {
          id: apiRouteNodeId(normalized, routePath, appHandlerPosition(sourceFile)),
          router: 'app',
        };
  }

  for (const directory of PAGES_DIRECTORY_CANDIDATES) {
    const rest = belowDirectory(normalized, directory);

    if (rest === undefined) {
      continue;
    }

    const routePath = pagesRoutePathOf(rest);

    return routePath === undefined
      ? undefined
      : {
          id: apiRouteNodeId(normalized, routePath, defaultExportPosition(sourceFile)),
          router: 'pages',
        };
  }

  return undefined;
}

/**
 * The id of the `api-route` node `./api-routes.ts` emits for one route.
 *
 * Spelled exactly as that extractor spells it: the node's `name` is the route
 * path and its position is the route entry's, which is the first handler
 * declaration (or the default export) of the module. A module whose handler
 * could not be located is anchored at the start of the file — the fallback
 * `../route-map.ts` uses, and the reason this takes an optional position
 * rather than refusing one.
 *
 * @param file The module's project-relative POSIX path, normalised.
 * @param routePath The URL the module answers.
 * @param position The route entry's position, or `undefined` for the fallback.
 * @returns The node id.
 */
function apiRouteNodeId(file: string, routePath: string, position: Position | undefined): string {
  return makeNodeId({
    kind: 'api-route',
    file,
    name: routePath,
    line: position?.line ?? FILE_NODE_LINE,
    column: position?.column ?? FILE_NODE_COLUMN,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The module's export surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * The names a module exports each of its own declarations under, by declared
 * name.
 *
 * The two export forms a declaration cannot be asked about directly, because
 * either may be written anywhere in the module — including above the
 * declaration it names:
 *
 * - `export { load }` and `export { load as fetchAll }` — a **local** clause,
 *   which is the one `./server-functions.ts` resolves against its own
 *   declarations. A clause carrying a module specifier exports something this
 *   module does not declare, so it contributes nothing here, and a type-only
 *   clause or specifier contributes nothing either: a type vanishes at run
 *   time, so it can never own a call site.
 * - `export default load` — a default assignment naming a local declaration.
 *   A `default` **keyword** on the declaration itself is read from the
 *   declaration, and `export = load` is skipped, which is what that sibling
 *   does: it is a CommonJS-only form, and no `server-function` node exists for
 *   one.
 *
 * Keyed by the declared name because that is the key that sibling resolves a
 * clause through, so the two agree on which declaration a clause exports.
 *
 * @param sourceFile The module to read.
 * @returns Exported names by declared name; empty for a module that exports
 * nothing this way.
 */
function localExportNamesOf(sourceFile: SourceFile): ReadonlyMap<string, readonly string[]> {
  const names = new Map<string, string[]>();

  const record = (localName: string, exportedAs: string): void => {
    if (localName.length === 0 || exportedAs.length === 0) {
      return;
    }

    const existing = names.get(localName);

    if (existing === undefined) {
      names.set(localName, [exportedAs]);
    } else if (!existing.includes(exportedAs)) {
      existing.push(exportedAs);
    }
  };

  for (const statement of sourceFile.getStatements()) {
    if (Node.isExportDeclaration(statement)) {
      if (statement.isTypeOnly() || statement.getModuleSpecifier() !== undefined) {
        continue;
      }

      for (const specifier of statement.getNamedExports()) {
        if (specifier.isTypeOnly()) {
          continue;
        }

        record(specifier.getName(), specifier.getAliasNode()?.getText() ?? specifier.getName());
      }

      continue;
    }

    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      const expression = statement.getExpression();

      if (Node.isIdentifier(expression)) {
        record(expression.getText(), DEFAULT_EXPORT_NAME);
      }
    }
  }

  return names;
}

/**
 * Every name one declaration leaves its module under: none, its own, or
 * `default`.
 *
 * The whole of this module's export reading, and the reason it is a list
 * rather than a flag: the cascade asks two different questions of it — "is
 * this declaration exported at all" for the server-function step, and "is it
 * exported under an HTTP method's name" for the route step — and both need the
 * names rather than the fact.
 *
 * Precise about which name each form contributes, because the route step turns
 * on it: a declaration carrying `export default` leaves the module as
 * `default` and **not** under its declared name, so
 * `export default function GET() {}` in a handler module is a default export
 * rather than a `GET` handler — which is exactly what the framework and
 * `../route-map.ts` both make of it.
 *
 * @param declaration The innermost addressable declaration.
 * @param facts What this module's own syntax says, for its export clauses.
 * @returns The exported names, in a deterministic order; empty when the
 * declaration stays inside its module.
 */
function exportNamesOf(declaration: AddressableDeclaration, facts: ModuleFacts): readonly string[] {
  const clauseNames = facts.exports.get(declaration.name) ?? NO_EXPORT_NAMES;

  if (declaration.defaultExported) {
    return clauseNames.includes(DEFAULT_EXPORT_NAME)
      ? clauseNames
      : [DEFAULT_EXPORT_NAME, ...clauseNames];
  }

  if (declaration.keywordExported) {
    return clauseNames.includes(declaration.name)
      ? clauseNames
      : [declaration.name, ...clauseNames];
  }

  return clauseNames;
}

/**
 * One file's markup facts, in a single traversal.
 *
 * Both answers come from the same walk because both are needed once per file
 * and the walk is the expensive part: whether the module contains markup at
 * all (half of the component-module guard) and every attribute whose name has
 * the event-binding shape (the input to the handler index). A namespaced
 * attribute name is not an identifier and can never have the shape, so it is
 * filtered here — the same rule `./event-handlers.ts` applies.
 *
 * @param sourceFile The module to scan.
 * @returns The markup facts.
 */
function scanJsx(sourceFile: SourceFile): JsxScan {
  const attributes: JsxAttribute[] = [];
  let hasJsx = false;

  sourceFile.forEachDescendant((node) => {
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)) {
      hasJsx = true;
    } else if (Node.isJsxAttribute(node)) {
      const nameNode = node.getNameNode();

      if (Node.isIdentifier(nameNode) && EVENT_PROP_PATTERN.test(nameNode.getText())) {
        attributes.push(node);
      }
    }
  });

  return { hasJsx, attributes };
}

/* -------------------------------------------------------------------------------------------------
 * The handler-naming rule, reproduced from `./event-handlers.ts`
 * ---------------------------------------------------------------------------------------------- */

/**
 * The identifier a declaration name binds under a given name, or `undefined`.
 *
 * Two shapes: a plain identifier, compared directly, and a destructuring
 * pattern, searched for a binding element of that name (nested patterns
 * included). **Reproduced from `./event-handlers.ts`** so the offset this
 * module looks a handler up by is the offset that module anchored its node at;
 * a sibling extractor may not be imported, and a second *spelling* of the
 * handler's id — rather than a second copy of the rule that produces it — is
 * what would make the edge dangle.
 *
 * @param nameNode The declarator's or parameter's name node.
 * @param name The name to look for.
 * @returns The identifier node, or `undefined`.
 */
function boundIdentifier(nameNode: Node, name: string): Node | undefined {
  if (Node.isIdentifier(nameNode)) {
    return nameNode.getText() === name ? nameNode : undefined;
  }

  if (!Node.isObjectBindingPattern(nameNode) && !Node.isArrayBindingPattern(nameNode)) {
    return undefined;
  }

  let found: Node | undefined;

  nameNode.forEachDescendant((node, traversal) => {
    if (!Node.isBindingElement(node)) {
      return;
    }

    const elementName = node.getNameNode();

    if (Node.isIdentifier(elementName) && elementName.getText() === name) {
      found = elementName;
      traversal.stop();
    }
  });

  return found;
}

/**
 * The anchor of a name declared among a scope's statements, or `undefined`.
 *
 * The three statement forms that declare a value a handler can be — a function
 * declaration, a class declaration and a variable statement, the last
 * including a destructured declarator. Type-level declarations are not
 * considered: none of them is callable.
 *
 * @param statements The scope's statements.
 * @param name The name to look for.
 * @returns The declaration's anchor node, or `undefined`.
 */
function declarationInStatements(statements: readonly Statement[], name: string): Node | undefined {
  for (const statement of statements) {
    // `function handleSubmit() { … }`
    if (Node.isFunctionDeclaration(statement) && statement.getName() === name) {
      return statement.getNameNode() ?? statement;
    }

    // `class Handlers { … }` — a class is a value, so a binding may name it.
    if (Node.isClassDeclaration(statement) && statement.getName() === name) {
      return statement.getNameNode() ?? statement;
    }

    // `const handleSubmit = useCallback(…)`, `const { onPick } = props;`
    if (!Node.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.getDeclarations()) {
      const anchor = boundIdentifier(declaration.getNameNode(), name);

      if (anchor !== undefined) {
        return anchor;
      }
    }
  }

  return undefined;
}

/**
 * The anchor of a name bound by a function's parameters, or `undefined`.
 *
 * A parameter is where a handler passed down from a parent arrives. It can
 * never *contain* a call site — the function it holds is declared in the
 * caller — so it only ever matches when this module is asking whether some
 * other declaration is the handler, and answering honestly keeps the lookup
 * equivalent to `./event-handlers.ts`'s.
 *
 * @param parameters The parameters to inspect.
 * @param name The name to look for.
 * @returns The parameter's anchor node, or `undefined`.
 */
function declarationInParameters(
  parameters: readonly ParameterDeclaration[],
  name: string,
): Node | undefined {
  for (const parameter of parameters) {
    const anchor = boundIdentifier(parameter.getNameNode(), name);

    if (anchor !== undefined) {
      return anchor;
    }
  }

  return undefined;
}

/**
 * The anchor of a name declared in the enclosing scopes of a use site,
 * innermost first.
 *
 * The language's own scoping order, and what makes a handler declared inside a
 * component body — `const handleSubmit = useCallback(…)`, the memoised shape
 * every real component uses — resolve to *that* declaration rather than to a
 * module-level one of the same name. Statements before parameters, because a
 * `const` in a function body shadows a parameter of the same name.
 *
 * In-file only: a handler imported from another module has no declaration
 * here, so no call site in this file can sit inside it, and the cascade's
 * later steps answer for such a binding instead.
 *
 * @param site The use site the walk starts at.
 * @param name The name to look for.
 * @returns The declaration's anchor node, or `undefined`.
 */
function resolveInScopes(site: Node, name: string): Node | undefined {
  for (const ancestor of site.getAncestors()) {
    if (Node.isStatemented(ancestor)) {
      const declared = declarationInStatements(ancestor.getStatements(), name);

      if (declared !== undefined) {
        return declared;
      }
    }

    if (Node.isParametered(ancestor)) {
      const bound = declarationInParameters(ancestor.getParameters(), name);

      if (bound !== undefined) {
        return bound;
      }
    }
  }

  return undefined;
}

/**
 * The anchor of a `this` member in the class that encloses a use site, or
 * `undefined`.
 *
 * Methods before properties, which is the order `./event-handlers.ts` tries
 * them in: a method is the form a class component's handler normally takes,
 * and an arrow-initialised property is the other.
 *
 * @param site The `this` expression the reference was written on.
 * @param member The member name after the dot.
 * @returns The member's name node, or `undefined`.
 */
function classMemberAnchor(site: Node, member: string): Node | undefined {
  const owner = site.getFirstAncestor(
    (ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor),
  );

  if (owner === undefined || (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner))) {
    return undefined;
  }

  const method = owner.getMethod(member);

  if (method !== undefined) {
    return method.getNameNode();
  }

  const property = owner.getProperty(member);

  return property === undefined ? undefined : property.getNameNode();
}

/**
 * What a markup binding binds, with transparent wrappers peeled.
 *
 * The branches, in the order they are tested:
 *
 * 1. `(fn)`, `fn as T`, `fn satisfies T`, `fn!` — transparent, so peeling
 *    continues, bounded by {@link MAX_UNWRAP_DEPTH};
 * 2. `() => …`, `function () {}` — an inline function, which *is* the handler;
 * 3. `handleSubmit` — a named handler, resolved through the enclosing scopes
 *    (`undefined` binds nothing and yields nothing);
 * 4. `this.onPress` — a class member, resolved in the enclosing class. Any
 *    other receiver is a value question this module does not ask, so it yields
 *    nothing: such a binding has no declaration here to own a call site;
 * 5. `makeHandler(id)`, `fn.bind(this)` — a call, classified through
 *    {@link classifyCallee}.
 *
 * @param expression The bound expression, or an inner one during peeling.
 * @param depth How many wrappers have already been peeled.
 * @returns The binding, or `undefined`.
 */
function classifyBinding(expression: Node, depth: number): HandlerBinding | undefined {
  if (
    depth < MAX_UNWRAP_DEPTH &&
    (Node.isParenthesizedExpression(expression) ||
      Node.isAsExpression(expression) ||
      Node.isSatisfiesExpression(expression) ||
      Node.isNonNullExpression(expression))
  ) {
    return classifyBinding(expression.getExpression(), depth + 1);
  }

  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return { inline: true, fn: expression };
  }

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();

    if (name === UNDEFINED_IDENTIFIER) {
      return undefined;
    }

    return { inline: false, name, site: expression, member: undefined };
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const receiver = expression.getExpression();

    if (!Node.isThisExpression(receiver)) {
      return undefined;
    }

    return {
      inline: false,
      name: expression.getName(),
      site: receiver,
      member: expression.getName(),
    };
  }

  if (Node.isCallExpression(expression)) {
    return classifyCallee(expression.getExpression(), depth);
  }

  return undefined;
}

/**
 * The binding a call's callee expresses.
 *
 * `makeHandler(id)` is classified as a reference to `makeHandler` — the name a
 * developer searches for, and the rule `./event-handlers.ts` states — while
 * `fn.bind(…)` is looked *through* to the receiving function, which is the one
 * call whose result is a function declared elsewhere in the source.
 *
 * @param callee The called expression.
 * @param depth How many wrappers have already been looked through.
 * @returns The binding, or `undefined`.
 */
function classifyCallee(callee: Node, depth: number): HandlerBinding | undefined {
  if (Node.isIdentifier(callee)) {
    return { inline: false, name: callee.getText(), site: callee, member: undefined };
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  // `this.handleSelect.bind(this)`, `handleSelect.bind(null, id)`.
  if (callee.getName() === BIND_METHOD_NAME && depth < MAX_UNWRAP_DEPTH) {
    return classifyBinding(callee.getExpression(), depth + 1);
  }

  const receiver = callee.getExpression();

  if (!Node.isThisExpression(receiver)) {
    return undefined;
  }

  return { inline: false, name: callee.getName(), site: receiver, member: callee.getName() };
}

/**
 * Records the handler node one markup binding points at, keyed by the offset
 * of the node it was derived from.
 *
 * The id is spelled exactly as `./event-handlers.ts` spells it — kind, file,
 * the declaration's own name, and the 1-based position of its anchor — and
 * only what the id depends on is reproduced: the payload facts that module
 * also records (`event`, `boundTo`, `inline`) take no part in
 * {@link makeNodeId}, and re-deriving them would be a second chance to
 * disagree for no benefit.
 *
 * First binding wins, which matches that module's own de-duplication: one
 * declaration bound at several places is one handler node.
 *
 * @param refs The index to append to.
 * @param file The module's project-relative POSIX path.
 * @param anchor The node the handler node is positioned at.
 * @param name The name the handler node is recorded under.
 */
function registerHandler(
  refs: Map<number, HandlerRef>,
  file: string,
  anchor: Node,
  name: string,
): void {
  const start = anchor.getStart();

  if (refs.has(start)) {
    return;
  }

  const { line, column } = positionOf(anchor);

  refs.set(start, {
    id: makeNodeId({ kind: 'handler', file, name, line, column }),
    name,
  });
}

/**
 * Appends one markup binding's handler to the index, when it names or holds a
 * function declared in this file.
 *
 * An inline function is keyed by its own start — the position
 * `./event-handlers.ts` anchors an inline handler at — and named for the
 * property as written, which is the derived label `CodeNodeBase.name` allows.
 * A named binding is keyed by its declaration's anchor and named for that
 * declaration, so an import alias is a fact about the binding rather than
 * about the function.
 *
 * @param attribute The event-binding attribute.
 * @param file The module's project-relative POSIX path.
 * @param refs The index to append to.
 */
function appendHandlerRef(
  attribute: JsxAttribute,
  file: string,
  refs: Map<number, HandlerRef>,
): void {
  const nameNode = attribute.getNameNode();

  if (!Node.isIdentifier(nameNode)) {
    return;
  }

  const initializer = attribute.getInitializer();

  if (initializer === undefined || !Node.isJsxExpression(initializer)) {
    return;
  }

  const expression = initializer.getExpression();

  if (expression === undefined) {
    return;
  }

  const binding = classifyBinding(expression, 0);

  if (binding === undefined) {
    return;
  }

  if (binding.inline) {
    registerHandler(refs, file, binding.fn, nameNode.getText());

    return;
  }

  const anchor =
    binding.member === undefined
      ? resolveInScopes(binding.site, binding.name)
      : classMemberAnchor(binding.site, binding.member);

  if (anchor === undefined) {
    return;
  }

  // The anchor is the declaration's identifier wherever it has one, so this is
  // the declaration's own name rather than the name written at the binding
  // site — the rule `./event-handlers.ts` states for an aliased import.
  const declaredName = Node.isIdentifier(anchor) ? anchor.getText() : binding.name;

  registerHandler(refs, file, anchor, declaredName);
}

/**
 * Every handler node one file's markup binds, by the offset of the node it was
 * derived from.
 *
 * Keyed by *position* rather than by name, which is what makes the owner
 * cascade's step 1 an identity check: a call site's enclosing declaration is
 * the handler when that declaration is the very node a binding resolved to,
 * not when it happens to share a name with one.
 *
 * Per-binding failures are contained: a binding that cannot be read costs its
 * own index entry, so a call site inside a *different* handler still gets its
 * edge.
 *
 * @param attributes The event-binding attributes, in source order.
 * @param file The module's project-relative POSIX path.
 * @param diagnostics Collector for per-construct findings.
 * @returns The handler index.
 */
function handlerRefsOf(
  attributes: readonly JsxAttribute[],
  file: string,
  diagnostics: IndexDiagnostic[],
): ReadonlyMap<number, HandlerRef> {
  const refs = new Map<number, HandlerRef>();

  for (const attribute of attributes) {
    try {
      appendHandlerRef(attribute, file, refs);
    } catch (cause) {
      diagnostics.push(constructFailure(file, attribute, cause));
    }
  }

  return refs;
}

/* -------------------------------------------------------------------------------------------------
 * The owner cascade
 * ---------------------------------------------------------------------------------------------- */

/**
 * The expression a declaration really initialises to, with the wrappers that
 * do not change its shape removed.
 *
 * `const f = (() => {}) satisfies Fn` declares a function as much as
 * `const f = () => {}` does, and the distinction between function-valued and
 * not is what the cascade's server-function branch turns on, so the wrappers
 * are peeled rather than allowed to hide the initialiser.
 *
 * @param expression The initialiser as written.
 * @param depth How many wrappers have already been peeled.
 * @returns The innermost expression within {@link MAX_UNWRAP_DEPTH} wrappers.
 */
function unwrapExpression(expression: Node, depth: number): Node {
  if (
    depth < MAX_UNWRAP_DEPTH &&
    (Node.isParenthesizedExpression(expression) ||
      Node.isAsExpression(expression) ||
      Node.isSatisfiesExpression(expression) ||
      Node.isNonNullExpression(expression))
  ) {
    return unwrapExpression(expression.getExpression(), depth + 1);
  }

  return expression;
}

/**
 * Whether a declaration's value is a function, written as one.
 *
 * Syntactic only: `const f = () => {}` and `const f = function () {}` are
 * function-valued, while `const f = makeHandler()` is not — nothing syntactic
 * says what a call returns. Under-answering is the safe direction here, since
 * it moves the cascade from the server-function branch to the symbol branch.
 *
 * @param expression The initialiser, or `undefined` for a declaration without one.
 * @returns `true` when the value is a function expression.
 */
function isFunctionValued(expression: Node | undefined): boolean {
  if (expression === undefined) {
    return false;
  }

  const inner = unwrapExpression(expression, 0);

  return Node.isArrowFunction(inner) || Node.isFunctionExpression(inner);
}

/**
 * Whether a statement-like declaration sits directly in its module.
 *
 * "Module-level" means exactly what `./symbols.ts` means by it, because that
 * module is the one whose nodes these edges point at: the declaration's
 * statement is a statement *of the source file*. A declaration inside a
 * function body, a block, a class expression or a namespace body is not
 * module-level and gets no symbol node, which is why the cascade walks past
 * one instead of pointing an edge at a node nobody emits.
 *
 * @param statement The statement to test.
 * @returns `true` when its parent is the source file.
 */
function isModuleLevel(statement: Node): boolean {
  return Node.isSourceFile(statement.getParent());
}

/**
 * Whether a class member belongs to a module-level class *declaration*.
 *
 * The scope `./symbols.ts` records members within. A class expression
 * (`const C = class { … }`) and a class declared inside a function body yield
 * no member nodes, so their members are not addressable owners.
 *
 * @param member The class member.
 * @returns `true` when its class is a module-level class declaration.
 */
function hasModuleLevelClass(member: Node): boolean {
  const owner = member.getParent();

  return Node.isClassDeclaration(owner) && isModuleLevel(owner);
}

/**
 * The name a class member is recorded under, or `undefined` when it is not
 * statically known.
 *
 * Reproduces `./symbols.ts`'s name reading: an identifier or private
 * identifier as written, a string-literal member name unquoted, a numeric name
 * as written, and `undefined` for a computed name — which no lookup could ever
 * match, so no edge may point at one.
 *
 * @param nameNode The member's name node.
 * @returns The recorded name, or `undefined`.
 */
function memberName(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) {
    const text = nameNode.getText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isNumericLiteral(nameNode)) {
    return nameNode.getText();
  }

  const literal = literalTextOf(nameNode);

  return literal === undefined || literal.length === 0 ? undefined : literal;
}

/**
 * The addressable declaration an ancestor is, or `undefined` when the graph
 * holds no node for it.
 *
 * "Addressable" is defined by `./symbols.ts`'s scope, and this function is the
 * whole of the cascade's knowledge of it: module-level function, class,
 * variable and namespace declarations, and members of module-level class
 * declarations. Everything else answers `undefined` and the walk continues
 * outward — a function-local declaration, an object-literal method, a class
 * expression's member, a namespace body's declaration, a destructured
 * declarator (which binds several names, none of them *the* owner), and an
 * anonymous class.
 *
 * The anchor is the node whose start position `./symbols.ts` records, which is
 * the declaration's name node in every case but two it spells differently: a
 * nameless default-exported function (recorded as `default` at the
 * declaration's own start) and a constructor (recorded as `constructor` at the
 * member's own start).
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

    // `export default function () {}` — legal and nameless.
    if (declaredName === undefined || nameNode === undefined) {
      return node.hasDefaultKeyword()
        ? {
            name: DEFAULT_EXPORT_NAME,
            anchor: node,
            functionValued: true,
            keywordExported: false,
            defaultExported: true,
            classMember: false,
          }
        : undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: true,
      keywordExported: node.hasExportKeyword(),
      defaultExported: node.hasDefaultKeyword(),
      classMember: false,
    };
  }

  if (Node.isClassDeclaration(node)) {
    const nameNode = node.getNameNode();
    const declaredName = nameNode === undefined ? undefined : memberName(nameNode);

    // A nameless class declaration is left to the walk: this module does not
    // reproduce how `./symbols.ts` anchors one, and an edge to a node spelled
    // differently would be dropped rather than merely imprecise.
    if (!isModuleLevel(node) || nameNode === undefined || declaredName === undefined) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: false,
      keywordExported: node.hasExportKeyword(),
      defaultExported: node.hasDefaultKeyword(),
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
      keywordExported: statement.hasExportKeyword(),
      defaultExported: false,
      classMember: false,
    };
  }

  if (Node.isModuleDeclaration(node)) {
    const nameNode = node.getNameNode();

    if (!isModuleLevel(node) || !Node.isIdentifier(nameNode)) {
      return undefined;
    }

    const declaredName = nameNode.getText();

    // See `GLOBAL_MODULE_NAME`: `declare global { … }` yields no symbol node.
    if (declaredName.length === 0 || declaredName === GLOBAL_MODULE_NAME) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: false,
      keywordExported: node.hasExportKeyword(),
      defaultExported: node.hasDefaultKeyword(),
      classMember: false,
    };
  }

  if (Node.isConstructorDeclaration(node)) {
    return hasModuleLevelClass(node)
      ? {
          name: CONSTRUCTOR_NAME,
          anchor: node,
          functionValued: true,
          keywordExported: false,
          defaultExported: false,
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

    const nameNode = node.getNameNode();
    const declaredName = memberName(nameNode);

    if (declaredName === undefined) {
      return undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      // A class member is not a module export, whatever its class's status is,
      // so neither the route step nor the server-function step is reachable
      // for one — `classMember` is what keeps it that way.
      functionValued: !Node.isPropertyDeclaration(node),
      keywordExported: false,
      defaultExported: false,
      classMember: true,
    };
  }

  return undefined;
}

/**
 * The node whose start offset a declaration would be *anchored* at, whatever
 * its scope — or `undefined` for a form that has no single anchor.
 *
 * The handler-index key, and deliberately **not** subject to
 * {@link addressableDeclarationOf}'s module-level rule: a handler declared
 * inside a component body has no `symbol` node yet does have a `handler` node,
 * so the cascade's first step has to be able to recognise it. Only the anchor
 * is produced here; what kind of node that anchor belongs to is the handler
 * index's answer, never this function's.
 *
 * A destructured declarator is deliberately excluded: it binds several names,
 * and its value comes from the caller rather than from a function body here,
 * so no call site can sit inside one.
 *
 * @param node The ancestor to read.
 * @returns The anchor node, or `undefined`.
 */
function declarationAnchorOf(node: Node): Node | undefined {
  if (Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node)) {
    const nameNode = node.getNameNode();

    return Node.isIdentifier(nameNode) ? nameNode : undefined;
  }

  if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) {
    return node.getNameNode();
  }

  if (
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return node.getNameNode();
  }

  return undefined;
}

/**
 * A declaration with the shape of a delegate, reduced to what the delegate
 * rule reads: the function it declares, its name and the block it is declared
 * in.
 */
interface DelegateShape {
  /** The function the declaration holds: the declaration itself, or its initialiser's function. */
  readonly fn: Node;

  /** The declared identifier, which is also the anchor {@link resolveInScopes} answers with. */
  readonly nameNode: Identifier;

  /** The block the declaration sits directly in: the scope of every reference to it. */
  readonly block: Node;
}

/**
 * The function a delegate's initialiser holds: the expression itself, looked
 * through the transparent wrappers and a {@link MEMOISED_CALLBACK_NAMES} call's
 * first argument, bounded by {@link MAX_UNWRAP_DEPTH}.
 *
 * @param expression The initialiser, or an inner expression while unwrapping.
 * @param depth How many wrappers have already been unwrapped.
 * @returns The function node, or `undefined` when the initialiser is not one.
 */
function delegatedFunctionOf(expression: Node, depth: number): Node | undefined {
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return expression;
  }

  if (depth >= MAX_UNWRAP_DEPTH) {
    return undefined;
  }

  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    return delegatedFunctionOf(expression.getExpression(), depth + 1);
  }

  if (Node.isCallExpression(expression)) {
    const callee = expression.getExpression();
    const calleeName = Node.isIdentifier(callee)
      ? callee.getText()
      : Node.isPropertyAccessExpression(callee)
        ? callee.getName()
        : undefined;
    const [first] = expression.getArguments();

    return calleeName !== undefined &&
      MEMOISED_CALLBACK_NAMES.includes(calleeName) &&
      first !== undefined
      ? delegatedFunctionOf(first, depth + 1)
      : undefined;
  }

  return undefined;
}

/**
 * The delegate shape of a walk ancestor, or `undefined` when it has none.
 *
 * The two ways a component body declares a named function, each directly in a
 * block — the body of the component or of any function or statement in it:
 *
 * - a **function declaration** that is not exported (so a namespace cannot
 *   publish it to callers the block does not contain);
 * - a **`const` or `let` declarator** named by a plain identifier and
 *   initialised with a function, directly or through
 *   {@link delegatedFunctionOf}'s wrappers. A `var` declarator is refused: it
 *   is scoped to the whole enclosing function rather than to its block, so a
 *   reference outside the block would go unseen.
 *
 * A module-level declaration is never a delegate — its parent is the source
 * file, not a block — because the graph already names it.
 *
 * @param node The ancestor to read.
 * @returns The shape, or `undefined`.
 */
function delegateShapeOf(node: Node): DelegateShape | undefined {
  if (Node.isFunctionDeclaration(node)) {
    const nameNode = node.getNameNode();
    const parent = node.getParent();

    return nameNode !== undefined && !node.hasExportKeyword() && Node.isBlock(parent)
      ? { fn: node, nameNode, block: parent }
      : undefined;
  }

  if (!Node.isVariableDeclaration(node)) {
    return undefined;
  }

  const nameNode = node.getNameNode();
  const statement = node.getVariableStatement();
  const parent = statement?.getParent();

  if (
    !Node.isIdentifier(nameNode) ||
    statement === undefined ||
    !Node.isBlock(parent) ||
    statement.getDeclarationKind() === VariableDeclarationKind.Var
  ) {
    return undefined;
  }

  const initializer = node.getInitializer();
  const fn = initializer === undefined ? undefined : delegatedFunctionOf(initializer, 0);

  return fn === undefined ? undefined : { fn, nameNode, block: parent };
}

/**
 * Whether an identifier names a member rather than reading a binding: a
 * property after a dot or in a qualified type name, the key of a property
 * assignment, a markup attribute, a class, object or interface member, an enum
 * member, or the property side of a destructuring element.
 *
 * `form.send()` calls a property that merely shares a delegate's spelling, and
 * counting it as a reference would refuse every delegate named like a common
 * method. Everything not listed here that resolves to the delegate counts as a
 * reference, which is the direction that refuses rather than claims. The same
 * list `./server-functions.ts` applies to the same rule.
 *
 * @param identifier The identifier.
 * @returns `true` when it is a member name.
 */
function isMemberNamePosition(identifier: Node): boolean {
  const parent = identifier.getParent();

  if (parent === undefined) {
    return false;
  }

  if (Node.isPropertyAccessExpression(parent)) {
    return parent.getNameNode().compilerNode === identifier.compilerNode;
  }

  if (Node.isQualifiedName(parent)) {
    return parent.getRight().compilerNode === identifier.compilerNode;
  }

  if (Node.isBindingElement(parent)) {
    return parent.getPropertyNameNode()?.compilerNode === identifier.compilerNode;
  }

  if (
    Node.isPropertyAssignment(parent) ||
    Node.isJsxAttribute(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isPropertyDeclaration(parent) ||
    Node.isGetAccessorDeclaration(parent) ||
    Node.isSetAccessorDeclaration(parent) ||
    Node.isPropertySignature(parent) ||
    Node.isMethodSignature(parent) ||
    Node.isEnumMember(parent)
  ) {
    return parent.getNameNode().compilerNode === identifier.compilerNode;
  }

  return false;
}

/**
 * Whether a function expression is *declared*: the initialiser of a declarator
 * with a plain name, a class property's value, or an `export default`'s
 * expression — looked through the transparent wrappers and any call it is an
 * argument of, which is how `useCallback(() => …)` reaches its declarator.
 *
 * `./server-functions.ts`'s candidate for a function expression answers the
 * same question the same way; a function expression this answers `false` for
 * is an anonymous callback, which owns nothing of its own.
 *
 * @param fn The arrow function or function expression.
 * @returns `true` when a declaration names it.
 */
function isDeclaredFunctionExpression(fn: Node): boolean {
  let current: Node = fn;

  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth += 1) {
    const parent = current.getParent();

    if (parent === undefined) {
      return false;
    }

    if (Node.isVariableDeclaration(parent)) {
      return Node.isIdentifier(parent.getNameNode());
    }

    if (Node.isPropertyDeclaration(parent)) {
      return true;
    }

    if (Node.isExportAssignment(parent)) {
      return !parent.isExportEquals();
    }

    const child = current;
    const transparent =
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      (Node.isCallExpression(parent) &&
        parent.getArguments().some((argument) => argument.compilerNode === child.compilerNode));

    if (!transparent) {
      return false;
    }

    current = parent;
  }

  return false;
}

/**
 * The inline handler a reference to a delegate is called from, or `undefined`
 * when it is not called from exactly one.
 *
 * The reference must be the callee of a call. From that call the enclosing
 * functions are walked innermost first: an anonymous callback
 * ({@link isDeclaredFunctionExpression} answers `false`) is stepped over, and
 * the first inline handler of this file's markup is the answer — an arrow or
 * function expression's own start is only ever an inline handler's key in
 * {@link ModuleFacts.handlers}, since a named binding is keyed by an
 * identifier. Any named function in between — a declaration, a declared arrow,
 * a method, an accessor, a constructor — owns the call itself, so the walk
 * refuses rather than skip past it.
 *
 * @param reference The identifier that resolved to the delegate.
 * @param facts What this module's own syntax says.
 * @returns The inline handler's index entry, or `undefined`.
 */
function inlineHandlerCalling(reference: Node, facts: ModuleFacts): HandlerRef | undefined {
  const call = reference.getParent();

  if (
    !Node.isCallExpression(call) ||
    call.getExpression().compilerNode !== reference.compilerNode
  ) {
    return undefined;
  }

  for (const ancestor of call.getAncestors()) {
    if (Node.isSourceFile(ancestor)) {
      return undefined;
    }

    if (!Node.isFunctionLikeDeclaration(ancestor)) {
      continue;
    }

    if (
      (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor)) ||
      isDeclaredFunctionExpression(ancestor)
    ) {
      return undefined;
    }

    const inline = facts.handlers.get(ancestor.getStart());

    if (inline !== undefined) {
      return inline;
    }
  }

  return undefined;
}

/**
 * The delegate rule of the cascade's first step: the inline handler that owns
 * a function-local declaration because it is the only code that calls it, or
 * `undefined` when the rule declines.
 *
 * `onSubmit={(event) => { void send(event); }}`, with `send` declared in the
 * component body, is the ordinary shape of a form whose submit logic is too
 * long for markup. A request `send` issues used to fall through to the
 * component's `symbol` node, because `send` is function-local and no node
 * exists for it — so the handler node `./event-handlers.ts` emits for the
 * arrow had no outgoing edge, and no path through the interaction could hold
 * it. When the arrow is the only caller, the request is issued exactly when
 * the handler runs, so it is the handler's.
 *
 * Claimed only when every one of these holds, each read from syntax alone —
 * the conditions `./server-functions.ts` applies to the same rule:
 *
 * 1. the ancestor has a delegate's shape ({@link delegateShapeOf}) and the
 *    site lies inside the function it declares — a request in a dependency
 *    list next to a `useCallback` argument is not the function's;
 * 2. every identifier of the declaring block that resolves to it through
 *    {@link resolveInScopes} — excluding its own name and member names
 *    ({@link isMemberNamePosition}) — is the **callee of a call**, so a
 *    markup binding, a value use, an argument or a dependency-list entry
 *    declines;
 * 3. every such call lies inside **one and the same inline** handler of this
 *    file, reached through anonymous callbacks only
 *    ({@link inlineHandlerCalling});
 * 4. there is at least one such call.
 *
 * Anything else declines and the walk continues outward exactly as before, to
 * a node that certainly exists. One level only: a delegate that only another
 * delegate calls falls through. A file holds few request sites, so the block
 * is read once per site that sits in a delegate rather than memoised.
 *
 * @param ancestor One ancestor of the call site.
 * @param site The call site.
 * @param facts What this module's own syntax says.
 * @returns The inline handler's index entry, or `undefined`.
 */
function delegateHandlerOf(
  ancestor: Node,
  site: CallSite,
  facts: ModuleFacts,
): HandlerRef | undefined {
  const delegate = delegateShapeOf(ancestor);

  if (delegate === undefined || !isInside(site.expression, delegate.fn)) {
    return undefined;
  }

  const name = delegate.nameNode.getText();
  const own = delegate.nameNode.compilerNode;
  let handler: HandlerRef | undefined;

  for (const identifier of delegate.block.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (
      identifier.getText() !== name ||
      identifier.compilerNode === own ||
      isMemberNamePosition(identifier)
    ) {
      continue;
    }

    // A parameter or nested local of the same name shadows the delegate, so
    // an identifier resolving elsewhere is simply not a reference to it.
    if (resolveInScopes(identifier, name)?.compilerNode !== own) {
      continue;
    }

    const caller = inlineHandlerCalling(identifier, facts);

    if (caller === undefined || (handler !== undefined && handler.id !== caller.id)) {
      return undefined;
    }

    handler = caller;
  }

  return handler;
}

/**
 * Whether one declaration is the request handler of this route module.
 *
 * The convention decides what counts, which is why
 * {@link RouteIdentity.router} is carried at all:
 *
 * - **App Router** — a declaration this module exports under the name of an
 *   HTTP method (`export async function GET`, `export const POST = …`,
 *   `export { handler as PUT }`). The name *is* the method, which is the whole
 *   of the framework's rule and of `../route-map.ts`'s reading of it.
 * - **Legacy Pages Router** — the module's default export, which *is* the
 *   route: one function dispatching on the request method, with nothing
 *   per-method to enumerate.
 *
 * A class member is never a handler whatever its name, because a route module
 * exports functions and a member is not an export.
 *
 * @param route This module's route identity.
 * @param declaration The innermost addressable declaration.
 * @param exportNames The names that declaration leaves the module under.
 * @returns `true` when the declaration answers this route's requests.
 */
function servesRoute(
  route: RouteIdentity,
  declaration: AddressableDeclaration,
  exportNames: readonly string[],
): boolean {
  if (declaration.classMember) {
    return false;
  }

  return route.router === 'pages'
    ? exportNames.includes(DEFAULT_EXPORT_NAME)
    : exportNames.some((exported) => CALL_SITE_METHODS.includes(exported));
}

/**
 * The owner of a call site whose innermost addressable declaration is known:
 * the cascade's steps 2, 3 and 4.
 *
 * Most specific first, and each step names a node kind whose spelling is
 * guaranteed by the extractor in brackets:
 *
 * 1. the declaration answers this module's route → the **api-route** node
 *    (`./api-routes.ts`), claimed only where {@link routeIdentityOf} could
 *    vouch for the route's identity;
 * 2. otherwise, in a module that is neither a route/page module nor a
 *    component module, an exported function-valued declaration → the
 *    **server-function** node (`./server-functions.ts`);
 * 3. otherwise its **symbol** node (`./symbols.ts`).
 *
 * "Exported" is the module's whole export surface and not a keyword: a
 * declaration exported by a clause (`export { load }`, `export { load as
 * fetchAll }`) or by a default assignment (`export default load`) is as much a
 * `server-function` node as one carrying the keyword, because that is what
 * `./server-functions.ts` emits for each of them — under the declaration's own
 * name, at its own position, which is what the id spelled here reproduces.
 * Both steps therefore claim a node that exists; the asymmetry that remains is
 * the safe one, since the `symbol` node of step 3 exists for every
 * module-level declaration and is reached whenever either of the more specific
 * steps declines.
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
  const { name } = declaration;
  const exportNames = exportNamesOf(declaration, facts);

  if (facts.route !== undefined && servesRoute(facts.route, declaration, exportNames)) {
    // The route node is named for a URL and positioned at the route entry, so
    // the call site's `symbol` still names the function it sits inside — the
    // handler — rather than the route path. The declaration's own position is
    // not needed, and is deliberately not computed on this path.
    return { kind: 'api-route', id: facts.route.id, symbol: name };
  }

  const { line, column } = positionOf(declaration.anchor);

  if (
    !facts.routeModule &&
    !facts.componentModule &&
    !declaration.classMember &&
    declaration.functionValued &&
    exportNames.length > 0
  ) {
    return {
      kind: 'server-function',
      id: makeNodeId({ kind: 'server-function', file, name, line, column }),
      symbol: name,
    };
  }

  return {
    kind: 'symbol',
    id: makeNodeId({ kind: 'symbol', file, name, line, column }),
    symbol: name,
  };
}

/**
 * Whether an expression is a wrapper that changes nothing about what it
 * encloses.
 *
 * `(fn)`, `fn as T`, `fn satisfies T`, `fn!` and `<T>fn` — the set
 * `./symbols.ts` peels when it positions a default export's node. The set is
 * *tested* rather than peeled here, because the two siblings this module
 * points at disagree about which node a wrapped default export is anchored at:
 * `./server-functions.ts` positions it at the assignment's own expression and
 * `./symbols.ts` at the peeled one. A wrapper therefore rules the `symbol`
 * step out (see {@link defaultExportOwner}) rather than being read through.
 *
 * @param expression The default export's expression.
 * @returns `true` when a wrapper stands between the assignment and its value.
 */
function isTransparentWrapper(expression: Node): boolean {
  return (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isNonNullExpression(expression) ||
    Node.isTypeAssertion(expression)
  );
}

/**
 * The owner of a call site written inside an `export default <expression>`
 * assignment, or `undefined` when that assignment addresses no node.
 *
 * The default-export shape has no declaration of its own — there is no name to
 * hang one on — so {@link addressableDeclarationOf} answers nothing for it and
 * the ancestor walk would otherwise run past it to the file node. Three nodes
 * *are* addressable for it, and which one applies is the cascade's own order:
 *
 * 1. a legacy `pages/api/**` module's default export **is** the route, so a
 *    call inside it belongs to the **api-route** node — the same step
 *    {@link declaredOwner} takes for a named default-exported handler;
 * 2. in a server module, a default-exported function is one of its exports, so
 *    the **server-function** node `./server-functions.ts` emits for it applies.
 *    That node is named `default` and positioned at the assignment's own
 *    expression, wrappers included, which is what is spelled here;
 * 3. otherwise the **symbol** node `./symbols.ts` mints for a default export
 *    that names no declaration — also `default`, but positioned at the
 *    *peeled* expression, so this step is taken only when no wrapper stands in
 *    between and the two positions coincide.
 *
 * `export =` addresses nothing: it is the TypeScript form for a CommonJS
 * module's single export, and neither sibling records a default export for it.
 * A bare identifier addresses nothing here either — it names a declaration
 * that owns its own calls, and a call site inside that declaration reaches it
 * earlier in the walk.
 *
 * @param file The module's project-relative POSIX path.
 * @param facts What this module's own syntax says.
 * @param assignment The `export default` statement.
 * @returns The owner, or `undefined` when the walk should continue.
 */
function defaultExportOwner(
  file: string,
  facts: ModuleFacts,
  assignment: ExportAssignment,
): Owner | undefined {
  if (assignment.isExportEquals()) {
    return undefined;
  }

  const expression = assignment.getExpression();

  if (Node.isIdentifier(expression)) {
    return undefined;
  }

  const { line, column } = positionOf(expression);

  if (isFunctionValued(expression)) {
    if (facts.route?.router === 'pages') {
      return { kind: 'api-route', id: facts.route.id, symbol: DEFAULT_EXPORT_NAME };
    }

    if (!facts.routeModule && !facts.componentModule) {
      return {
        kind: 'server-function',
        id: makeNodeId({
          kind: 'server-function',
          file,
          name: DEFAULT_EXPORT_NAME,
          line,
          column,
        }),
        symbol: DEFAULT_EXPORT_NAME,
      };
    }
  }

  if (isTransparentWrapper(expression)) {
    return undefined;
  }

  return {
    kind: 'symbol',
    id: makeNodeId({ kind: 'symbol', file, name: DEFAULT_EXPORT_NAME, line, column }),
    symbol: DEFAULT_EXPORT_NAME,
  };
}

/**
 * The owner of a call site no enclosing declaration can address: the cascade's
 * last step.
 *
 * The `file` node's id is spelled by the convention `CodeNodeBase.name`
 * documents and `./imports.ts` emits — `name` is the project-relative path,
 * anchored at the start of the file — so the edge has a real endpoint. The
 * node carries no `symbol`, because there is no function to name.
 *
 * Logged at `debug` rather than reported as a diagnostic: the attribution is
 * correct and complete, it is simply the least specific one available, and a
 * diagnostic is the channel for an index that is *missing* something. Fields
 * name a file, a position and a vocabulary word — never source text.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param site The call site.
 * @returns The file owner.
 */
function fileOwner(ctx: ExtractorContext, site: CallSite): Owner {
  const id = makeNodeId({
    kind: 'file',
    file: ctx.file,
    name: ctx.file,
    line: FILE_NODE_LINE,
    column: FILE_NODE_COLUMN,
  });

  ctx.logger.debug('API call attributed to its file: no enclosing declaration is addressable', {
    extractorId: API_CALLS_EXTRACTOR_ID,
    file: ctx.file,
    shape: site.shape,
    line: safePositionOf(site.anchor)?.line,
  });

  return { kind: 'file', id, symbol: undefined };
}

/**
 * The node a call site's `calls` edge starts at.
 *
 * The cascade, in one walk of the call's ancestors innermost-first, which is
 * what "innermost addressable owner" means operationally:
 *
 * 1. a function-like ancestor that *is* an inline handler in this file's
 *    markup → the **handler** node;
 * 2. a declaration — of *any* scope, see {@link declarationAnchorOf} — whose
 *    anchor a markup binding resolved to → the **handler** node (this is the
 *    memoised shape: the declaration is reached *through* the `useCallback`
 *    call, which the walk simply steps over), or a function-local delegate
 *    only one inline handler calls → that inline **handler** node
 *    ({@link delegateHandlerOf});
 * 3. the innermost addressable declaration otherwise → its **api-route**,
 *    **server-function** or **symbol** node, per {@link declaredOwner};
 * 4. nothing addressable anywhere up the chain → the **file** node.
 *
 * Returning at the first addressable declaration is what makes step 3
 * innermost-wins; continuing past a non-addressable one is what lets a call in
 * an anonymous callback inside an exported function still belong to that
 * function.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param site The call site.
 * @param facts What this module's own syntax says.
 * @returns The owner.
 */
function ownerOf(ctx: ExtractorContext, site: CallSite, facts: ModuleFacts): Owner {
  for (const ancestor of site.expression.getAncestors()) {
    if (Node.isFunctionLikeDeclaration(ancestor)) {
      const inline = facts.handlers.get(ancestor.getStart());

      if (inline !== undefined) {
        return { kind: 'handler', id: inline.id, symbol: inline.name };
      }
    }

    const anchor = declarationAnchorOf(ancestor);

    if (anchor !== undefined) {
      const named = facts.handlers.get(anchor.getStart());

      if (named !== undefined) {
        return { kind: 'handler', id: named.id, symbol: named.name };
      }
    }

    const delegated = delegateHandlerOf(ancestor, site, facts);

    if (delegated !== undefined) {
      return { kind: 'handler', id: delegated.id, symbol: delegated.name };
    }

    const declaration = addressableDeclarationOf(ancestor);

    if (declaration !== undefined) {
      return declaredOwner(ctx.file, declaration, facts);
    }

    // `export default <function>` declares nothing, so the step above answers
    // nothing for it — and three nodes are addressable for it anyway.
    if (Node.isExportAssignment(ancestor)) {
      const exported = defaultExportOwner(ctx.file, facts, ancestor);

      if (exported !== undefined) {
        return exported;
      }
    }
  }

  return fileOwner(ctx, site);
}

/* -------------------------------------------------------------------------------------------------
 * Nodes and edges
 * ---------------------------------------------------------------------------------------------- */

/**
 * The payload of one call site.
 *
 * The single place `ApiCallNodeData` is built, and the single place the
 * omission `exactOptionalPropertyTypes` requires happens: an absent field is
 * absent, never present and `undefined`, which is what keeps a `CodeIndex`
 * round-trippable through JSON.
 *
 * @param target What the source says about the request's target.
 * @param method The HTTP method, or `undefined` when none may be recorded —
 * the source stated none and the shape has no platform default, or it stated a
 * verb outside the shared vocabulary.
 * @returns The payload.
 */
function apiCallData(target: RequestTarget, method: string | undefined): ApiCallNodeData {
  return {
    dynamic: target.dynamic,
    ...(target.url === undefined ? {} : { url: target.url }),
    ...(target.urlExpression === undefined ? {} : { urlExpression: target.urlExpression }),
    ...(method === undefined ? {} : { method }),
  };
}

/**
 * The `api-call` node for one call site.
 *
 * The single place such a node is constructed and therefore the single place
 * its id is derived. Two sites that request the same URL differ in position,
 * so their ids differ — which is the mechanism behind the never-de-duplicate
 * rule, rather than a check that has to remember to be performed. `endLine` is
 * clamped to at least `line` so a span is never inverted for a construct whose
 * parser-assigned end precedes its callee.
 *
 * @param file The module's project-relative POSIX path.
 * @param site The call site.
 * @param owner The node the `calls` edge will start at.
 * @returns The node.
 */
function apiCallNode(file: string, site: CallSite, owner: Owner): CodeNodeOf<'api-call'> {
  const { line, column } = positionOf(site.anchor);
  const node = {
    id: makeNodeId({ kind: 'api-call', file, name: site.name, line, column }),
    kind: 'api-call',
    name: site.name,
    file,
    line,
    column,
    endLine: Math.max(site.extent.getEndLineNumber(), line),
    data: apiCallData(site.target, site.method),
  } as const satisfies CodeNodeOf<'api-call'>;

  // `CodeNodeBase.symbol` is the function a call site sits inside, and it is
  // omitted rather than set to `undefined` when the cascade reached the file
  // node — there is no function to name, and under
  // `exactOptionalPropertyTypes` the two are different types.
  return owner.symbol === undefined ? node : { ...node, symbol: owner.symbol };
}

/**
 * The `calls` edge from a call site's owner to its node.
 *
 * Direction is fixed by the edge table on `CODE_EDGE_KINDS`: caller → callee,
 * never the reverse, because `whoCalls` is a backwards search along `calls`
 * and only works because `from` is reliably the caller.
 *
 * The edge is sited at the node's own position — the line that writes the
 * request — which keeps every edge of a file distinct without a second
 * position to keep in step: two call sites have two node ids and two sites.
 *
 * @param node The api-call node the edge points at.
 * @param from The owner node's id.
 * @returns The edge.
 */
function callsEdge(node: CodeNodeOf<'api-call'>, from: string): CodeEdge {
  return {
    id: makeEdgeId({ kind: 'calls', from, to: node.id, line: node.line, column: node.column }),
    kind: 'calls',
    from,
    to: node.id,
    file: node.file,
    line: node.line,
    column: node.column,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * What can safely be said about a thrown value: its type name only.
 *
 * A thrown *message* is not safe to repeat — an abstract-syntax-tree library
 * routinely embeds the text of the node it choked on in its message, and that
 * text is the developer's source, which a diagnostic must never carry (see the
 * privacy constraint on `INDEX_DIAGNOSTIC_CODES`).
 *
 * @param cause Whatever was thrown.
 * @returns A short, quote-free description.
 */
function failureDetail(cause: unknown): string {
  if (cause instanceof Error) {
    return `threw ${cause.name.length > 0 ? cause.name : 'Error'}`;
  }

  return `threw a non-error value of type ${typeof cause}`;
}

/**
 * The syntax kind of a node, or a placeholder when even that cannot be read.
 *
 * A syntax kind name is a fixed vocabulary word (`CallExpression`,
 * `JsxAttribute`) and never source text, so it is safe in a diagnostic. The
 * guard exists because this runs on the failure path, where assuming a further
 * call succeeds is how one failure becomes two.
 *
 * @param node The node in question.
 * @returns Its syntax kind name, or `'construct'`.
 */
function safeKindName(node: Node): string {
  try {
    return node.getKindName();
  } catch {
    return 'construct';
  }
}

/**
 * The diagnostic for one construct this extractor could not read.
 *
 * Severity `warning` rather than `error`: the file still yielded everything
 * else, so the index is usable and merely incomplete at one position. The
 * message names the syntax kind and the 1-based position — `IndexDiagnostic`
 * carries no position fields of its own — and quotes nothing.
 *
 * @param file The module's project-relative POSIX path.
 * @param node The construct that could not be read.
 * @param cause Whatever was thrown.
 * @returns The diagnostic.
 */
function constructFailure(file: string, node: Node, cause: unknown): IndexDiagnostic {
  const position = safePositionOf(node);
  const where =
    position === undefined
      ? 'at an unknown position'
      : `at line ${position.line}, column ${position.column}`;

  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${API_CALLS_EXTRACTOR_ID} could not read a ${safeKindName(node)} ${where}; the rest of the file was indexed`,
    file,
    extractorId: API_CALLS_EXTRACTOR_ID,
    detail: failureDetail(cause),
  };
}

/**
 * How many syntax errors a file has and where the first one starts, or
 * `undefined` for a file that parsed cleanly.
 *
 * **Syntactic** diagnostics only: they come from the parser, not the type
 * checker, so asking for them respects the abstract-syntax-tree-first
 * contract — a project whose dependencies are not installed has no semantic
 * diagnostics worth reading and is not broken. The same check
 * `./react-components.ts` performs, for the same reason.
 *
 * Any failure of the check itself is silent: a missing diagnostic is a far
 * smaller problem than an extractor that fails while reporting a failure.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The summary, or `undefined`.
 */
function syntaxErrorSummary(
  ctx: ExtractorContext,
): { count: number; first: Position | undefined } | undefined {
  try {
    const syntactic = ctx.loaded.project.getProgram().getSyntacticDiagnostics(ctx.sourceFile);

    if (syntactic.length === 0) {
      return undefined;
    }

    const start = syntactic[0]?.getStart();

    if (start === undefined) {
      return { count: syntactic.length, first: undefined };
    }

    const { line, column } = ctx.sourceFile.getSourceFile().getLineAndColumnAtPos(start);

    return { count: syntactic.length, first: { line, column } };
  } catch {
    return undefined;
  }
}

/**
 * The diagnostic for a file the parser could not read in full, or `undefined`
 * for a file that parsed cleanly.
 *
 * A broken module does not make ts-morph throw: it yields a partial tree, and
 * the call sites in the region the parser gave up on are simply absent. That
 * is an *incomplete index*, which is exactly what `IndexDiagnostic` exists to
 * report — so the finding is raised from the parser's own count rather than
 * from an exception that never happens. Severity `warning`: what was parsed is
 * still true.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The diagnostic, or `undefined`.
 */
function syntaxFailure(ctx: ExtractorContext): IndexDiagnostic | undefined {
  const summary = syntaxErrorSummary(ctx);

  if (summary === undefined) {
    return undefined;
  }

  const { count, first } = summary;
  const where = first === undefined ? '' : ` from line ${first.line}, column ${first.column}`;
  const errors = count === 1 ? 'syntax error' : 'syntax errors';

  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${API_CALLS_EXTRACTOR_ID} read a file with ${count} ${errors}${where}; an API call site in an unparsed region would have been missed`,
    file: ctx.file,
    extractorId: API_CALLS_EXTRACTOR_ID,
  };
}

/**
 * The diagnostic for a failure that cost the whole file rather than one
 * construct.
 *
 * Raised when scanning the module's markup or collecting its call sites threw,
 * which leaves no position to report and no partial output to keep.
 *
 * @param file The module's project-relative POSIX path.
 * @param cause Whatever was thrown.
 * @returns The diagnostic.
 */
function fileFailure(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${API_CALLS_EXTRACTOR_ID} could not index this file; no API call site was recorded for it`,
    file,
    extractorId: API_CALLS_EXTRACTOR_ID,
    detail: failureDetail(cause),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * Extracts every API call site of one file, with the `calls` edge that
 * attributes it.
 *
 * Three stages, in this order, so a failure in one costs only what it is
 * about: the module's own facts are collected (router convention, component
 * shape, markup bindings), its call sites are classified, and each site is
 * turned into a node and an edge. Nodes and edges are appended in source
 * order and in step with each other, so the result is deterministic and every
 * node has exactly one edge.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The api-call nodes, the `calls` edges, and any diagnostics.
 */
function extractApiCalls(ctx: ExtractorContext): ExtractorResult {
  // `ExtractorContext.file` is produced by the indexer through
  // `LoadedProject.projectRelative`, so this can only fail if a caller built a
  // context by hand. It is checked anyway: every node's `file` must satisfy
  // the same refinement `SourceLocation` applies, or a graph node cannot
  // become a location a user interface opens (see `CodeNodeBase.file`).
  if (!isSafeRelativePath(ctx.file)) {
    ctx.logger.warn('API call extraction skipped: the file path is not project-relative', {
      extractorId: API_CALLS_EXTRACTOR_ID,
    });

    return EMPTY_RESULT;
  }

  const diagnostics: IndexDiagnostic[] = [];
  let facts = EMPTY_FACTS;
  let sites: readonly CallSite[] = EMPTY_SITES;

  // Reported first, because it is a statement about the *input*: a region the
  // parser gave up on holds call sites nothing below can see.
  const unparsed = syntaxFailure(ctx);

  if (unparsed !== undefined) {
    diagnostics.push(unparsed);
  }

  try {
    const jsx = scanJsx(ctx.sourceFile);

    facts = {
      routeModule: isRouteModulePath(ctx.file),
      componentModule: jsx.hasJsx && declaresComponentName(ctx.sourceFile),
      handlers: handlerRefsOf(jsx.attributes, ctx.file, diagnostics),
      route: routeIdentityOf(ctx.file, ctx.sourceFile),
      exports: localExportNamesOf(ctx.sourceFile),
    };
    sites = collectCallSites(ctx.sourceFile, ctx.file, diagnostics);
  } catch (cause) {
    diagnostics.push(fileFailure(ctx.file, cause));
  }

  const nodes: CodeNodeOf<'api-call'>[] = [];
  const edges: CodeEdge[] = [];

  for (const site of sites) {
    try {
      const owner = ownerOf(ctx, site, facts);
      const node = apiCallNode(ctx.file, site, owner);

      // The one case where a node is deliberately less complete than the
      // source: a literal method outside the shared vocabulary. Logged rather
      // than raised as a diagnostic — the index is not missing an item, one
      // item is missing an optional field — and the verb itself is not named,
      // because it is source text.
      if (site.unsupportedMethod) {
        ctx.logger.debug(
          'API call method not recorded: the literal is outside the HTTP vocabulary',
          {
            extractorId: API_CALLS_EXTRACTOR_ID,
            file: ctx.file,
            shape: site.shape,
            line: node.line,
            column: node.column,
          },
        );
      }

      nodes.push(node);
      edges.push(callsEdge(node, owner.id));
    } catch (cause) {
      // One unattributable site costs its own node and edge; every other site
      // in the file still produces both.
      diagnostics.push(constructFailure(ctx.file, site.expression, cause));
    }
  }

  const collectedNodes = nodes.length === 0 ? EMPTY_NODES : nodes;
  const collectedEdges = edges.length === 0 ? EMPTY_EDGES : edges;

  // `diagnostics` is absent rather than empty for a clean extraction, which is
  // what `ExtractorResult` documents and what lets the indexer concatenate
  // without a guard.
  return diagnostics.length === 0
    ? { nodes: collectedNodes, edges: collectedEdges }
    : { nodes: collectedNodes, edges: collectedEdges, diagnostics };
}

/**
 * The `api-calls` extractor: one `api-call` node per recognised request site,
 * each with the `calls` edge from the innermost addressable owner of that
 * site.
 *
 * Synchronous, and pure with respect to the project and the machine: it reads
 * the abstract syntax tree of the one file it was handed, writes no file,
 * opens no socket, caches nothing, mutates no node and adds no source file to
 * the project. Its output is deterministic — source order, ids derived only
 * from kind, file, name and position — so two runs over unchanged source
 * produce identical results, which is what `../indexer.ts`'s reproducibility
 * promise rests on.
 *
 * It never throws. A construct that cannot be read becomes a `warning`
 * diagnostic and costs only its own node; a file-level failure costs the
 * file's call sites and no other file's.
 *
 * @example
 * ```ts
 * const result = apiCallsExtractor.extract(ctx);
 * result.nodes[0]?.data.url; // '/api/items' — only when fully literal
 * result.nodes[0]?.data.dynamic; // false
 * result.edges[0]?.kind; // 'calls' — from the handler or function it sits in
 * ```
 */
export const apiCallsExtractor: Extractor = Object.freeze({
  id: API_CALLS_EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    return extractApiCalls(ctx);
  },
});
