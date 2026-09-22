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
 * ## The three call shapes it recognises, and nothing beyond them
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
 *    enclosing function.
 * 3. **A client wrapper** — a call whose callee is a property access whose
 *    member name is an HTTP verb *and* whose first argument is a path-like
 *    string or template. The verb-plus-path shape is what a real project's
 *    HTTP client looks like; a list of client names would be exactly the
 *    hardcoded application knowledge this product may not contain.
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
 * - **A `fetch` always records a method.** A string-literal `method` property
 *   on the second argument wins; otherwise `GET` is recorded, because `GET` is
 *   what the platform API *does* in that case — a documented property of
 *   `fetch`, not a guess. `ApiCallNodeData.method`'s "absent when the call
 *   relies on the default" is honoured for the shape that has no platform
 *   default to state: an XHR whose `open()` method argument is not a literal
 *   records no method at all.
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
 *    (`./event-handlers.ts`);
 * 2. otherwise, in a module that is neither a route/page module nor a
 *    component module, an exported module-level function-valued declaration →
 *    the **server-function** node (`./server-functions.ts`);
 * 3. otherwise any module-level declaration, or a member of a module-level
 *    class → its **symbol** node (`./symbols.ts`);
 * 4. otherwise the **file** node (`./imports.ts`).
 *
 * The walk is over the call's *ancestors*, innermost first, which is why no
 * wrapper peeling is needed: a memoisation call (`useCallback`, `useMemo`,
 * `memo`, `forwardRef`) between the function and its declaration is simply an
 * ancestor that is stepped over. A function-local declaration carries no
 * `symbol` node — `./symbols.ts` records module-level declarations and class
 * members only — so the walk continues past one, and the file node is reached
 * only when *no* enclosing declaration anywhere up the chain is addressable.
 *
 * Step 1 is deliberately **independent of that addressability**, and this is
 * the case the cascade exists for: `const handleClick = useCallback(…)` inside
 * a component body is function-local and has no `symbol` node, yet
 * `./event-handlers.ts` emits a `handler` node for it because the markup binds
 * it. Checking the handler index only for module-level declarations would
 * attribute every memoised handler's requests to the component instead, which
 * is precisely the attribution the product needs to be right.
 *
 * ### Two reconciliations this file documents rather than guesses
 *
 * - **A route module's handlers are attributed to their `symbol` node, not to
 *   an `api-route` node.** The plan's cascade names `api-route` for a call
 *   inside an HTTP-method export, but an `api-route` node's id is built from a
 *   route *path* and a route entry's location, both derived exclusively by
 *   `../route-map.ts` — a module this extractor may not import and whose
 *   derivation it may not duplicate. A re-derived path that differs by one
 *   character would not be a slightly wrong edge, it would be a dropped one.
 *   The HTTP-method export's own `symbol` node is guaranteed by
 *   `./symbols.ts`, and the `file → symbol → api-call` shape is explicitly
 *   sanctioned by the reachability invariant on `CODE_EDGE_KINDS`, so the
 *   route's calls stay reachable through the `declares` hop. The cost is
 *   specificity; the alternative was silence.
 * - **The server-function branch is taken only for the unambiguous shape**: a
 *   module-level, function-valued declaration carrying a plain `export`
 *   keyword. `export { f }` and `export default` fall through to step 3, for
 *   the same asymmetry — a `symbol` node exists for every module-level
 *   declaration, while a `server-function` node exists only where the sibling
 *   extractor agreed, and disagreement costs the edge. Component-module
 *   detection is permissive for the same reason: a call in a component body
 *   falls through to that component's `symbol` node (the cascade has no
 *   `component` step by design), so over-detecting a component module can only
 *   ever move an edge from `server-function` to `symbol`, never delete it.
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
 * - **Abstract-syntax-tree first, no type resolution.** Every judgement is
 *   syntactic. Nothing calls the type checker, resolves a module specifier or
 *   reads a second file — which is what lets the corpus, whose dependencies
 *   are never installed, still yield a complete call-site inventory. The
 *   consequence is stated rather than hidden: a handler imported from another
 *   module cannot own a call site in *this* one (it has none), and a wrapper's
 *   receiver is recorded as written rather than resolved to a client.
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
 * @packageDocumentation
 */

import { Node } from 'ts-morph';
import type {
  CallExpression,
  JsxAttribute,
  NewExpression,
  ObjectLiteralExpression,
  ParameterDeclaration,
  SourceFile,
  Statement,
} from 'ts-morph';

import { isSafeRelativePath } from '@debuggen/shared';

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

/** The assignment operator that binds a construction to an existing name. */
const ASSIGNMENT_OPERATOR = '=';

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

/**
 * The App Router file stems that make a module a route or page module.
 *
 * Used **only** to classify a module, never to derive a URL: every question
 * about what path a file serves belongs to `../route-map.ts`, and this module
 * asks none of them. The classification's only effect is to keep a route
 * module's calls out of the server-function branch of the cascade.
 */
const ROUTE_MODULE_STEMS: readonly string[] = Object.freeze(['route', 'page']);

/** The file extension separator, for taking a basename's stem. */
const EXTENSION_SEPARATOR = '.';

/** The path separator every project-relative path uses. */
const PATH_SEPARATOR = '/';

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
type CallShape = 'fetch' | 'xhr' | 'wrapper';

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

  /** The HTTP method, or `undefined` when the source states none. */
  readonly method: string | undefined;
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
 * call site in the file asks the same three questions.
 */
interface ModuleFacts {
  /** Whether the path makes this a route or page module. */
  readonly routeModule: boolean;

  /** Whether this module looks like a component module. */
  readonly componentModule: boolean;

  /** Handler nodes by the character offset of the node they were derived from. */
  readonly handlers: ReadonlyMap<number, HandlerRef>;
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

  /** Whether it carries a plain `export` keyword (not `export default`). */
  readonly plainlyExported: boolean;

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
  readonly kind: 'handler' | 'server-function' | 'symbol' | 'file';

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
 * An HTTP method normalised to the shared vocabulary's spelling, or
 * `undefined` when the text states none.
 *
 * Upper-cased, because that is how `HTTP_METHOD_NAMES` spells a method and how
 * the runtime evidence records one, and trimmed, because
 * `{ method: ' post ' }` is a method the platform accepts. A method outside
 * the vocabulary (`TRACE`, a project's own verb) is kept as written rather
 * than dropped or coerced: `ApiCallNodeData.method` is documented as "what a
 * call site *wrote*", a plain string precisely so an unusual method is not
 * lost, and inventing a vocabulary member for it is what must not happen.
 *
 * @param raw The method text as written.
 * @returns The normalised method, or `undefined` for empty text.
 */
function normaliseMethod(raw: string): string | undefined {
  const upper = raw.trim().toUpperCase();

  return upper.length === 0 ? undefined : upper;
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
 * The literal method an init object declares, or `undefined`.
 *
 * Only a *literal* method counts. A shorthand (`{ method }`), a computed
 * value (`{ method: verb }`) and a spread (`{ ...options }`) each mean the
 * method is decided at runtime, and none of them is read as one — the caller
 * then records the platform default, which is what the call performs unless
 * something it cannot see says otherwise.
 *
 * @param object The init object literal.
 * @returns The normalised method, or `undefined`.
 */
function literalMethodIn(object: ObjectLiteralExpression): string | undefined {
  for (const property of object.getProperties()) {
    if (!Node.isPropertyAssignment(property)) {
      continue;
    }

    if (propertyNameOf(property.getNameNode()) !== METHOD_PROPERTY_NAME) {
      continue;
    }

    const initializer = property.getInitializer();

    if (initializer === undefined) {
      return undefined;
    }

    const literal = literalTextOf(initializer);

    return literal === undefined ? undefined : normaliseMethod(literal);
  }

  return undefined;
}

/**
 * The method a `fetch` call performs.
 *
 * Always a method, never `undefined`: a literal `method` property on the init
 * object when there is one, and {@link DEFAULT_FETCH_METHOD} otherwise, which
 * is what the platform API does rather than a guess about intent. See the
 * header for how this reconciles with `ApiCallNodeData.method`'s
 * "absent when the call relies on the default".
 *
 * @param init The second argument, or `undefined` when the call has one argument.
 * @returns The method to record.
 */
function fetchMethodOf(init: Node | undefined): string {
  if (init === undefined || !Node.isObjectLiteralExpression(init)) {
    return DEFAULT_FETCH_METHOD;
  }

  return literalMethodIn(init) ?? DEFAULT_FETCH_METHOD;
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
 * Two of the three recognised shapes, tested in this order:
 *
 * 1. **`fetch(url, init?)`** — the target is the first argument and the method
 *    the init object's literal `method`, defaulting to `GET`.
 * 2. **`receiver.verb(url, …)`** — a client wrapper: the member name is an
 *    HTTP verb *and* the first argument is path-like. Both halves are
 *    required, which is what keeps `list.get(3)` and `map.delete(key)` out of
 *    the graph.
 *
 * The node's position is the callee's start in both cases: at `fetch` for a
 * bare call, and at the receiver for a property access (`window.fetch(…)`,
 * `api.get(…)`), which is where a developer's eye and an editor's cursor
 * belong.
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
    return {
      shape: 'fetch',
      name: textOr(callee, FETCH_NAME),
      anchor: callee,
      extent: call,
      expression: call,
      target: targetOf(first),
      method: fetchMethodOf(second),
    };
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  // Shape 3 — `api.get('/x')`, `http.post(`/y/${id}`, body)`. The verb is the
  // method, and the receiver's text is the wrapper the node is named for (the
  // verb would otherwise be recorded twice; see the header).
  const method = wrapperMethodOf(callee.getName());

  if (method === undefined || first === undefined || !isPathLike(first)) {
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
 * How many `XMLHttpRequest` constructions in one scope are bound to a name.
 *
 * More than one means the name is re-bound, so no single construction owns the
 * `.open(…)` calls that follow and pairing is abandoned. Counting is cheaper
 * and more honest than trying to order re-bindings against calls.
 *
 * @param scope The enclosing function or file.
 * @param name The bound name to count constructions for.
 * @returns The number of constructions bound to that name.
 */
function xhrConstructionCount(scope: Node, name: string): number {
  let count = 0;

  scope.forEachDescendant((node) => {
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
 * Every `<name>.open(…)` call in one scope that starts after an offset, in
 * source order.
 *
 * The descendant walk deliberately includes nested functions: an `.open(…)`
 * inside a callback of the same function is still that function's request, and
 * including it costs nothing under the exactly-one rule the caller applies.
 *
 * @param scope The enclosing function or file.
 * @param name The binding the call must be written on.
 * @param afterOffset The construction's end offset.
 * @returns The candidate calls, in source order.
 */
function openCallsOn(scope: Node, name: string, afterOffset: number): readonly CallExpression[] {
  const calls: CallExpression[] = [];

  scope.forEachDescendant((node) => {
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
 * Confident means: the construction binds a plain local name, that name is
 * bound by exactly one construction in the enclosing function, and exactly one
 * `.open(…)` call on it follows. Anything less is unpaired — the prompt's rule
 * and the honest one, since a wrong target is worse than a missing one.
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
    };
  }

  const args = paired.getArguments();
  const methodArgument = args[0];
  const urlArgument = args[1];
  const literalMethod = methodArgument === undefined ? undefined : literalTextOf(methodArgument);

  return {
    shape: 'xhr',
    name,
    anchor: callee,
    extent: paired,
    expression: construction,
    target: targetOf(urlArgument),
    // `open()`'s method argument is required, so a non-literal one means the
    // method is computed — the case `ApiCallNodeData.method` prescribes
    // absence for. There is no platform default to fall back on.
    method: literalMethod === undefined ? undefined : normaliseMethod(literalMethod),
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
            plainlyExported: false,
            classMember: false,
          }
        : undefined;
    }

    return {
      name: declaredName,
      anchor: nameNode,
      functionValued: true,
      plainlyExported: node.hasExportKeyword() && !node.hasDefaultKeyword(),
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
      plainlyExported: node.hasExportKeyword() && !node.hasDefaultKeyword(),
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
      plainlyExported: statement.hasExportKeyword(),
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
      plainlyExported: node.hasExportKeyword(),
      classMember: false,
    };
  }

  if (Node.isConstructorDeclaration(node)) {
    return hasModuleLevelClass(node)
      ? {
          name: CONSTRUCTOR_NAME,
          anchor: node,
          functionValued: true,
          plainlyExported: false,
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
      // so the server-function branch is unreachable for one — `classMember`
      // is what keeps it that way.
      functionValued: !Node.isPropertyDeclaration(node),
      plainlyExported: false,
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
 * The owner of a call site whose innermost addressable declaration is known:
 * the cascade's steps 2 and 3.
 *
 * The server-function branch is taken only for the unambiguous shape — a
 * module-level, function-valued declaration carrying a plain `export` keyword,
 * in a module that is neither a route/page module nor a component module — for
 * the asymmetry the header states: a `symbol` node exists for every
 * module-level declaration, while a `server-function` node exists only where
 * `./server-functions.ts` agreed, and a disagreement costs the edge rather
 * than degrading it.
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
    declaration.plainlyExported
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
 *    call, which the walk simply steps over);
 * 3. the innermost addressable declaration otherwise → its **server-function**
 *    or **symbol** node, per {@link declaredOwner};
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

    const declaration = addressableDeclarationOf(ancestor);

    if (declaration === undefined) {
      continue;
    }

    return declaredOwner(ctx.file, declaration, facts);
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
 * @param method The HTTP method, or `undefined` when the source states none.
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
