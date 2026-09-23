/**
 * The read-only query surface the code-investigation stage puts in front of a
 * model (AAP 0.4.2, Stage 2).
 *
 * The design the plan states is the whole of this module's contract: *"model
 * proposes queries, deterministic code executes them; no repository dump."* A
 * stage hands the model a catalogue of the queries below, the model answers
 * with the query it wants and the arguments it wants, and
 * `apps/local-service/src/pipeline/tools/code-tools.ts` executes it here. Three
 * properties follow from that, and every function in this file is written to
 * keep them:
 *
 * - **Read-only.** Nothing here writes, spawns, fetches or reads an environment
 *   variable. The graph and the loaded project are inputs; the results are
 *   plain objects. The only filesystem-adjacent operation is reading text that
 *   `../project.ts` has *already* loaded into a ts-morph project, through that
 *   handle and never through `node:fs`.
 * - **Bounded.** Every query has a ceiling, declared once in
 *   {@link CODE_QUERY_LIMITS}, and a caller can only ask for *less*. These are
 *   prompt-budget constraints: a result from this module is serialised into a
 *   prompt, so an unbounded query here is an unbounded prompt, and the useful
 *   answer to "give me everything" is a capped answer rather than a stage that
 *   runs out of context. The single query that could otherwise return a whole
 *   file — {@link CodeQueries.excerpt} — is the one the plan calls out as
 *   *"bounded excerpts"*, and it clamps its window rather than widening it.
 * - **Deterministic.** Every result is ordered by a documented key with the
 *   node or edge `id` as the final tie-break, compared byte-wise and never
 *   with `localeCompare`, so two runs over the same graph — and two graphs
 *   built independently from the same source — produce the identical answer.
 *   The same reasoning `./graph.ts` records for its canonical order applies
 *   here, one layer up.
 *
 * ## Location provenance: two routes, never conflated
 *
 * `SourceLocation` carries the mechanism that produced it, and this module
 * produces or forwards exactly two of the five (AAP 0.2.3):
 *
 * - `'code-graph'` for anything minted from a {@link CodeNode} or from an
 *   edge's call site, with `DEFAULT_RESOLUTION_CONFIDENCE['code-graph']`. The
 *   constant is imported, never transcribed as a number: four resolvers in
 *   three packages fill `confidence`, and they agree only because they all read
 *   that one table.
 * - `'route-map'` for anything `../route-map.ts` produced —
 *   {@link CodeQueries.routeForUrl} and the fallback half of
 *   {@link CodeQueries.handlersFor} forward `RouteEntry.location` and
 *   `RouteEntry.methodLocations` **unchanged**. Rewriting one of those to
 *   `'code-graph'` would erase the distinction the schema exists to record.
 *
 * ## Route matching is delegated, not reimplemented
 *
 * `../route-map.ts` is the single source of URL-to-route resolution: it owns
 * route groups, dynamic, catch-all and optional-catch-all segments, specificity
 * ordering, percent-decoding and the collision rule between the two routers.
 * The two route queries here bound their input, call `matchRoute`, and enrich
 * the match with the graph's own node. There is deliberately no second
 * matching algorithm in this folder.
 *
 * ## Position in the package graph
 *
 * This module imports `./types.js`, `./graph.js`, `../route-map.js`,
 * `../project.js` and `@debuggen/shared` — and nothing else. In particular it
 * does **not** import `../indexer.ts`: the expensive ts-morph reference
 * resolver that module builds is *injected* through
 * {@link CodeQueryOptions.references} and typed from `./types.js`, which is
 * what lets {@link CodeQueries.whoCalls} stay a static graph read by default
 * and reach for `findReferences` only when a caller asks for it.
 * `@debuggen/shared` is the only `@debuggen` dependency this package has, and
 * an upward import would close a cycle with `packages/instrumentation`, which
 * depends on this package.
 *
 * @example
 * ```ts
 * const queries = createCodeQueries(graph, { loaded, logger });
 *
 * queries.findByName('handleSubmit');                  // ranked candidates
 * queries.hasSymbol('src/server/items.ts', 'listItems'); // feasibility gate
 * queries.routeForUrl('http://localhost:3000/api/items?page=2');
 * queries.pathBetween({ name: 'WidgetList' }, { kind: 'db-call' });
 * ```
 *
 * @packageDocumentation
 */

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  toPosix,
} from '@debuggen/shared';
import type { Logger, SourceLocation } from '@debuggen/shared';

import { isEnvFilePath } from '../project.js';
import type { LoadedProject } from '../project.js';
import { matchRoute, routeMapFromIndex } from '../route-map.js';
import type { RouteEntry, RouteEntryKind, RouteMatch } from '../route-map.js';

import type { CodeGraph } from './graph.js';
import { isCodeEdgeKind, isCodeNodeKind } from './types.js';
import type {
  CodeEdge,
  CodeEdgeKind,
  CodeNode,
  CodeNodeKind,
  HttpMethodName,
  ReferenceResolver,
  RouterKind,
  SymbolDeclarationKind,
} from './types.js';

/* -------------------------------------------------------------------------------------------------
 * Limits
 * ---------------------------------------------------------------------------------------------- */

/**
 * The ceilings every query in this module enforces, and the defaults it applies
 * when a caller does not narrow them.
 *
 * Each member is a **hard ceiling**: the matching per-call option can only ask
 * for less, and a larger value is clamped rather than honoured (see
 * {@link CodeQueryOptions.limits}). The reason is the one stated on this
 * module — a result here becomes part of a model prompt, and the budget for
 * that prompt belongs to the stage assembling it, not to the model proposing
 * the query.
 */
export interface CodeQueryLimits {
  /**
   * The greatest number of entries any list-returning query may return (50).
   *
   * Fifty candidates already fill a screen and a substantial block of a prompt;
   * past that the marginal result stops being evidence and starts being noise,
   * and a query matching more than fifty nodes is telling the caller to ask a
   * narrower question.
   */
  readonly maxResults: number;

  /**
   * The greatest number of call sites {@link CodeQueries.whoCalls} may return
   * (50).
   *
   * Its own ceiling rather than {@link CodeQueryLimits.maxResults}, because
   * callers are the one result set that legitimately grows with the popularity
   * of a symbol: a shared helper can have hundreds, and the investigation needs
   * a representative, deterministically ordered prefix of them rather than all.
   */
  readonly maxCallers: number;

  /**
   * The greatest number of edges a {@link CodeQueries.pathBetween} result may
   * traverse (8).
   *
   * A flow the investigation stage renders — interaction, handler, request,
   * route, service, query — is five or six hops, so eight leaves room for an
   * intermediate module without letting a breadth-first search wander across
   * an application. It bounds cost as much as output: the frontier of a code
   * graph grows quickly, and depth is the term that multiplies.
   */
  readonly maxPathDepth: number;

  /**
   * The greatest number of nodes one {@link CodeQueries.pathBetween} search may
   * expand (32).
   *
   * The budget that bounds a search which will never succeed. Without it, an
   * unreachable target costs a traversal of the whole graph for a `undefined`;
   * with it, the search gives up early and says so through
   * {@link CodePath.truncated}.
   */
  readonly maxPathNodes: number;

  /**
   * The greatest number of lines one {@link CodeQueries.excerpt} may return
   * (40).
   *
   * Forty lines shows a function and its immediate context whole, which is what
   * makes an excerpt evidence. A caller that needs more of a module needs a
   * different query, not a longer excerpt.
   */
  readonly maxExcerptLines: number;

  /**
   * The greatest length of one {@link CodeQueries.excerpt}, in characters
   * (4 000).
   *
   * The second half of the excerpt budget, and the one that matters for
   * generated or minified text: forty lines of ordinary TypeScript is well
   * under this, while forty lines of a bundled module could be hundreds of
   * kilobytes.
   */
  readonly maxExcerptChars: number;

  /**
   * The greatest length of a name, symbol or file argument, in characters
   * (200).
   *
   * Two hundred characters is far beyond any identifier or project-relative
   * path a stage should be proposing, so a longer argument is a malformed query
   * rather than an ambitious one. It is answered with an empty result rather
   * than an exception, because these arguments arrive from a model and this
   * surface must never crash the pipeline.
   */
  readonly maxNameLength: number;

  /**
   * The greatest length of a URL argument, in characters (2 048).
   *
   * The conventional practical ceiling for a URL, applied before the value
   * reaches `matchRoute`. A longer value resolves to no route rather than
   * throwing, for the same reason {@link CodeQueryLimits.maxNameLength} does.
   */
  readonly maxUrlLength: number;
}

/**
 * The frozen default limits, and simultaneously the hard ceilings of
 * {@link CodeQueryLimits}.
 *
 * Frozen because it is read on every query: a mutation would silently re-budget
 * every prompt in the process.
 */
export const CODE_QUERY_LIMITS: CodeQueryLimits = Object.freeze({
  maxResults: 50,
  maxCallers: 50,
  maxPathDepth: 8,
  maxPathNodes: 32,
  maxExcerptLines: 40,
  maxExcerptChars: 4_000,
  maxNameLength: 200,
  maxUrlLength: 2_048,
});

/**
 * How many lines of context an excerpt includes on either side of its anchor
 * when the caller does not say (3).
 *
 * Three lines is enough to show a signature above a body and a closing brace
 * below a statement without spending the line budget of
 * {@link CodeQueryLimits.maxExcerptLines} on context.
 */
const DEFAULT_EXCERPT_CONTEXT_LINES = 3;

/**
 * The score {@link CodeQueries.findByName} reports for each match tier, highest
 * first.
 *
 * A number rather than an enumeration because it is handed to a model, which
 * weighs candidates rather than switching on them. The values are the ranking
 * the plan states — exact, then case-insensitive exact, then prefix, then
 * substring — expressed so that a descending sort reproduces it.
 */
const MATCH_SCORES = Object.freeze({
  exact: 1,
  caseInsensitive: 0.75,
  prefix: 0.5,
  substring: 0.25,
});

/* -------------------------------------------------------------------------------------------------
 * Result shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * One node of the code graph, reduced to what a prompt and a user interface
 * need.
 *
 * The uniform node reference of this module: {@link CallerRef},
 * {@link ComponentRef}, {@link RouteQueryResult} and {@link CodePath} all
 * surface a node as one of these rather than as a raw {@link CodeNode}, so a
 * consumer learns one shape. Plain and JSON-serialisable by construction —
 * every field is a string, a number or a {@link SourceLocation}, which is
 * itself plain — because these objects are serialised into prompts and into the
 * service's tool responses.
 */
export interface CodeMatch {
  /**
   * The node's `id` in the graph it came from.
   *
   * Opaque: it is a handle to pass back into another query (as a
   * {@link CodeQueries.pathBetween} endpoint or a {@link CodeQueries.excerpt}
   * target), never a string to parse. `./graph.ts` documents why.
   */
  readonly nodeId: string;

  /** The node's kind, so a caller can tell a component from a route handler. */
  readonly kind: CodeNodeKind;

  /** The node's name as written in the source. */
  readonly name: string;

  /** The node's file: project-relative, POSIX separators. */
  readonly file: string;

  /**
   * Where the declaration is, with `resolvedBy: 'code-graph'`.
   *
   * Always present: a match whose file could not be vouched for as a
   * project-relative path is dropped from the result rather than reported with
   * an unusable location.
   */
  readonly location: SourceLocation;

  /**
   * How well the node matched, from `0` to `1`, when the query ranked its
   * candidates.
   *
   * Set by {@link CodeQueries.findByName} alone — see {@link MATCH_SCORES} for
   * the tiers — and absent everywhere else, where the result set is defined by
   * a relationship rather than by a resemblance and a score would be a number
   * with no meaning.
   */
  readonly score?: number;
}

/**
 * A **declaration** matched by file and symbol name, with the facts an
 * instrumentation plan needs about it.
 *
 * The result of {@link CodeQueries.findSymbol}, and the reason that query is a
 * public export rather than an internal helper:
 * `packages/instrumentation/src/feasibility.ts` rejects a plan action naming a
 * file or symbol the graph does not contain, and the patcher that would wrap
 * the function needs to know whether it is exported, whether it is `async` and
 * whether the declaration is nested before it can choose a template.
 *
 * Every match describes a node that **declares** the name in that file — a
 * `symbol`, a `component` or a `server-function`. A node that merely *mentions*
 * the name, which is what a `handler` node (a binding site) and an `api-call`
 * or `db-call` node (a call site inside a function of that name) do, is not a
 * declaration and never produces a match; see
 * {@link CodeQueries.findSymbol} for why that equivalence is load-bearing.
 */
export interface CodeSymbolMatch extends CodeMatch {
  /**
   * The symbol name that matched — the value the caller passed, which for a
   * match is always the matched node's own `name`.
   */
  readonly symbol: string;

  /**
   * Whether the declaration is exported from its file.
   *
   * `false` rather than absent when the graph does not say: a consumer deciding
   * whether another module can reach this symbol needs an answer, and "not
   * known to be exported" is the safe one.
   */
  readonly exported: boolean;

  /**
   * Whether the function is declared `async`, when the graph knows.
   *
   * Present for a `server-function` node, whose payload records it, and absent
   * for every other kind — where the question is either meaningless (a `file`)
   * or unanswered by the extractor that produced the node.
   */
  readonly isAsync?: boolean;

  /**
   * The named declarations this one is nested inside, outermost first, when it
   * is nested at all.
   *
   * Forwarded from `SymbolNodeData.enclosing` — see that field for the exact
   * semantics, including why `[]` differs from absence. Two consequences for a
   * caller:
   *
   * - **Present means "not importable".** The declaration exists, a
   *   function-timing action can address it, and no other module can reach it
   *   whatever {@link CodeSymbolMatch.exported} says.
   * - **It is how a plan disambiguates.** Two nested declarations in one file
   *   can share a bare name, and the patcher refuses an ambiguous one rather
   *   than guessing; a planner qualifies the spelling from this chain
   *   (`CheckoutForm.submitOrder`).
   *
   * Absent for a module-level declaration, for a class member (whose owner is
   * in {@link CodeMatch}'s location `symbol` instead) and for a `component` or
   * `server-function` match, whose payloads record no chain.
   */
  readonly enclosing?: readonly string[];
}

/**
 * How a caller of a symbol was found: from an edge already in the graph, or
 * from a ts-morph reference search run on demand.
 *
 * Reported on every {@link CallerRef} because the two carry different weight. An
 * `'edge'` result was produced by an extractor that understood the call
 * expression; a `'references'` result is the type checker's answer to "where is
 * this identifier used", which includes uses that are not calls.
 */
export type CallerProvenance = 'edge' | 'references';

/** One place a symbol is called from. */
export interface CallerRef {
  /** The node the call was made from. */
  readonly caller: CodeMatch;

  /** How this call site was found. See {@link CallerProvenance}. */
  readonly via: CallerProvenance;

  /**
   * Where the call is, with `resolvedBy: 'code-graph'`.
   *
   * The **call site** rather than the caller's declaration whenever the edge
   * recorded one, which is the position a developer wants to open: the line
   * that makes the call, not the top of the function containing it. It falls
   * back to {@link CallerRef.caller}'s own position for a derived edge that has
   * no site.
   */
  readonly location: SourceLocation;
}

/**
 * The route that answers a URL, and the graph's own node for it.
 *
 * `routePath`, `router`, `kind`, `methods`, `params` and `file` are lifted out
 * of the underlying {@link RouteMatch} so a prompt or a tool response can read
 * them without walking into `match.entry`, and `match` is kept so a caller that
 * needs the full entry — its segments, its per-method locations — has it.
 */
export interface RouteQueryResult {
  /** The raw match `../route-map.ts` produced, unmodified. */
  readonly match: RouteMatch;

  /** The route's URL with its dynamic segments in bracket form. */
  readonly routePath: string;

  /** Which router convention the module belongs to. */
  readonly router: RouterKind;

  /** Whether the module answers requests or renders a document. */
  readonly kind: RouteEntryKind;

  /**
   * The methods the route answers, in the order `../route-map.ts` derived them.
   *
   * `['ANY']` for a legacy Pages API module, whose single default-exported
   * handler serves every method, and empty for a module whose handlers could
   * not be located — which is a finding rather than a route that answers
   * nothing.
   */
  readonly methods: readonly HttpMethodName[];

  /**
   * The parameters the URL captured: a string per dynamic segment, an array per
   * catch-all, percent-decoded.
   */
  readonly params: Readonly<Record<string, string | readonly string[]>>;

  /** The route module's file: project-relative, POSIX separators. */
  readonly file: string;

  /**
   * Where to open the route, **with `resolvedBy: 'route-map'` preserved**.
   *
   * Forwarded from `RouteEntry.location` exactly as produced. The route map is
   * the resolver here, and stamping this as a code-graph location would
   * misreport how it was found.
   */
  readonly location: SourceLocation;

  /**
   * The `api-route` node of the graph for this module, when the graph has one.
   *
   * Absent when the routes were supplied by a caller that indexed more of the
   * project than this graph holds, or when the module produced no node. Its
   * `location` is the `'code-graph'` view of the same module, which is why both
   * are available: they were found by different mechanisms and are worth
   * different amounts.
   */
  readonly node?: CodeMatch;
}

/** One HTTP method of a route, and where its handler is declared. */
export interface HandlerRef {
  /** The method this entry describes. `'ANY'` for a single dispatching handler. */
  readonly method: HttpMethodName;

  /**
   * The name of the handling declaration, when the graph knows it.
   *
   * The method name itself for an App Router module (whose handlers are
   * exported under those names) and the declared name of the default export for
   * a legacy Pages handler. Absent when the graph holds no declaration for the
   * route file, in which case {@link HandlerRef.location} is the route map's.
   */
  readonly symbol?: string;

  /**
   * Where the handler is.
   *
   * `resolvedBy: 'code-graph'` when a declaration node was found, and the route
   * map's own location — `resolvedBy: 'route-map'`, forwarded unchanged —
   * otherwise. The distinction is deliberate and is asserted by this folder's
   * tests.
   */
  readonly location: SourceLocation;
}

/** One component that renders another, and the element that renders it. */
export interface ComponentRef {
  /** The rendering component: the *parent*. See {@link CodeQueries.componentsRendering}. */
  readonly component: CodeMatch;

  /**
   * Where the element is, with `resolvedBy: 'code-graph'`.
   *
   * The position of the JSX element in the parent when the render edge recorded
   * one — the line to open to see why the child renders — falling back to the
   * parent's own declaration.
   */
  readonly location: SourceLocation;
}

/**
 * One hop of a {@link CodePath}.
 *
 * `from` and `to` are the **edge's own** endpoints — the direction the
 * relationship is written in — which for a hop taken by an undirected search
 * (`direction: 'both'`) can be the reverse of the direction the path travels.
 * The traversal order is {@link CodePath.nodes}; this records what the
 * relationship actually says, and
 * {@link CodePathEdge.traversedAgainstDirection} says which of the two applies.
 */
export interface CodePathEdge {
  /** The relationship this hop followed. */
  readonly kind: CodeEdgeKind;

  /** The `nodeId` the relationship starts at. */
  readonly from: string;

  /** The `nodeId` the relationship points to. */
  readonly to: string;

  /**
   * Whether the path travelled this relationship **backwards**: from its `to`
   * endpoint to its `from` endpoint.
   *
   * Always `false` on a path found by the default downstream search, and
   * possibly `true` on any hop of an undirected one (`direction: 'both'`),
   * where "are these two things related at all" is answered by following an
   * edge either way round.
   *
   * It exists because the alternative is a result that reads as something it is
   * not. `edges[i]` always joins `nodes[i]` to `nodes[i + 1]`, so a consumer
   * that chained the hops by `edges[i].to === edges[i + 1].from` — the natural
   * reading of a call flow — saw that check fail at a reversed hop and had no
   * way to tell a genuine flow from an undirected relation. A reversed hop
   * means the relationship points *towards* the earlier node: two functions
   * joined through a helper they both call are related without either calling
   * the other, and a summary that presented that as a chain of calls would
   * assert a flow the code does not contain. Walk {@link CodePath.nodes} for
   * the traversal and read this field for what each hop actually states.
   */
  readonly traversedAgainstDirection: boolean;

  /**
   * Where the relationship is written, when the edge recorded a site.
   *
   * Absent for a derived edge — one computed from two nodes rather than read
   * off a line of source — and `resolvedBy: 'code-graph'` when present. The
   * site belongs to the edge's own `from`, whichever way the path travelled it.
   */
  readonly location?: SourceLocation;
}

/**
 * A traversal from one node to another: the flow the investigation stage
 * renders.
 */
export interface CodePath {
  /**
   * The nodes in traversal order, from the `from` endpoint to the `to`
   * endpoint, each with its `'code-graph'` location.
   *
   * At least one entry: a path from a node to itself is that node alone, with
   * no edges and depth `0`.
   */
  readonly nodes: readonly CodeMatch[];

  /**
   * The hops between them, so `edges[i]` joins `nodes[i]` to `nodes[i + 1]`.
   *
   * Exactly one shorter than {@link CodePath.nodes}, and ordered as a walk of
   * that list rather than as a chain of the edges' own endpoints — which is the
   * same thing for a downstream path and is not for an undirected one, where
   * {@link CodePathEdge.traversedAgainstDirection} marks each hop the walk took
   * backwards.
   */
  readonly edges: readonly CodePathEdge[];

  /** The number of hops: `edges.length`, and never more than `maxPathDepth`. */
  readonly depth: number;

  /**
   * Whether the search that found this path was undirected
   * ({@link PathBetweenOptions.direction} `'both'`).
   *
   * The one field that answers "may I read this as a flow?" without inspecting
   * every hop: `false` means every hop points downstream, so the node list is a
   * genuine call/render/query chain; `true` means the path establishes that the
   * endpoints are *connected*, and only
   * {@link CodePathEdge.traversedAgainstDirection} per hop says how. A caller
   * rendering evidence for a developer or a prompt should say "related to"
   * rather than "calls" for an undirected path, and this is the field that
   * decides which.
   */
  readonly undirected: boolean;

  /**
   * Whether a bound stopped the search before its frontier was exhausted.
   *
   * Never a statement about the path itself: a returned path is always complete
   * and always the shortest one, so this is a fact about the *search*.
   *
   * It is consequently `false` on every path the current bounds can return.
   * Breadth-first order dequeues every shallower node before a node at the
   * depth limit, and the node budget stops the search outright, so a search a
   * bound did bite answers `undefined` — "not reachable within these bounds" —
   * rather than with a path. The field is part of the shape because the shape
   * is what a prompt and a panel read, and because a bound that applies
   * per-branch rather than per-search (an edge fan-out cap, say) would surface
   * here instead of in a new field.
   */
  readonly truncated: boolean;
}

/**
 * A bounded window of source text.
 *
 * This is the *"bounded excerpts"* tool of AAP 0.4.2: how the model is shown
 * code without being handed a repository. Its contents may therefore reach a
 * model prompt, which is why the window is clamped here and why `.env*` files
 * can never be its subject (see {@link CodeQueries.excerpt}). Redacting what
 * survives that — a credential a developer wrote into a source file — is
 * `packages/model-provider/src/redact-guard.ts`'s responsibility, on the way
 * out.
 */
export interface CodeExcerpt {
  /** The file the text came from: project-relative, POSIX separators. */
  readonly file: string;

  /** The **1-based** line the excerpt starts on. */
  readonly startLine: number;

  /** The **1-based** line the excerpt ends on, always at least `startLine`. */
  readonly endLine: number;

  /**
   * The text of those lines, joined with `'\n'`.
   *
   * Never the whole file: a request whose window exceeds the excerpt budget is
   * clamped to it, and `\r\n` line endings are normalised so the line count and
   * the text agree.
   */
  readonly text: string;

  /**
   * Whether the requested window was clipped — by the line budget, by the
   * character budget, or by both.
   *
   * `false` when the caller got exactly the lines it asked for. A window that
   * simply ran past the end of the file is not truncation: the file ended.
   */
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------------------------------
 * Argument shapes
 * ---------------------------------------------------------------------------------------------- */

/*
 * Every optional member below spells `| undefined` explicitly. The repository
 * compiles with `exactOptionalPropertyTypes`, and these are the arguments a
 * stage forwards straight out of a decoded model query — a value it holds as
 * `number | undefined` has to pass through without the call site branching on
 * it first.
 */

/** How to narrow {@link CodeQueries.findByName}. */
export interface FindByNameOptions {
  /**
   * Keep only nodes of these kinds.
   *
   * Omitted means every kind, which is the right default for a model that knows
   * the name it is looking for but not what kind of thing bears it. An empty
   * array is treated as "no kind is acceptable" and yields no results, because
   * that is what it says.
   */
  readonly kinds?: readonly CodeNodeKind[] | undefined;

  /**
   * Require an exact, case-sensitive name match.
   *
   * `true` takes the constant-time path through the graph's name index and
   * scans nothing, which is what a caller resolving a name it read out of
   * another result wants. Anything else admits the case-insensitive, prefix and
   * substring tiers.
   */
  readonly exact?: boolean | undefined;

  /**
   * Return at most this many matches, clamped to
   * {@link CodeQueryLimits.maxResults}.
   */
  readonly limit?: number | undefined;
}

/**
 * A symbol to find the callers of, qualified by the file that declares it.
 *
 * The qualified form of {@link CodeQueries.whoCalls}'s argument: a bare string
 * matches the symbol wherever it is declared, which is ambiguous in a project
 * where two modules export the same name.
 */
export interface WhoCallsTarget {
  /**
   * The declaring file: project-relative, POSIX separators.
   *
   * Omitted means "wherever it is declared", making the target equivalent to
   * the bare string form.
   */
  readonly file?: string | undefined;

  /** The declared symbol name. */
  readonly symbol: string;
}

/** How to run {@link CodeQueries.whoCalls}. */
export interface WhoCallsOptions {
  /** Return at most this many call sites, clamped to {@link CodeQueryLimits.maxCallers}. */
  readonly limit?: number | undefined;

  /**
   * Consult the injected reference resolver even when the graph already
   * answered.
   *
   * Off by default, and deliberately so: the resolver runs ts-morph's
   * `findReferences`, which type-checks the program and is orders of magnitude
   * more expensive than reading the edges an extractor already recorded. It is
   * consulted anyway — without this flag — when the static answer is empty,
   * since a symbol with no recorded callers is exactly the case where the
   * expensive answer is worth having. With no resolver injected the flag has no
   * effect.
   */
  readonly useReferences?: boolean | undefined;
}

/** How to narrow {@link CodeQueries.handlersFor}. */
export interface HandlersForOptions {
  /**
   * Keep only this method.
   *
   * A route that serves `'ANY'` — a single dispatching handler — is reported
   * for any requested method, because it does answer it.
   */
  readonly method?: HttpMethodName | undefined;
}

/** How to bound {@link CodeQueries.componentsRendering}. */
export interface ComponentsRenderingOptions {
  /** Return at most this many rendering sites, clamped to {@link CodeQueryLimits.maxResults}. */
  readonly limit?: number | undefined;
}

/**
 * A description of the node a {@link CodeQueries.pathBetween} endpoint means.
 *
 * Every member is optional and all given members must match, so a selector is
 * as precise as the caller can be: `{ file, symbol }` names one declaration,
 * `{ name }` names it wherever it is, and `{ kind: 'db-call' }` names *any*
 * database call site — which is how "does this route reach the database at all"
 * is asked. A selector matching nothing makes the search fail with `undefined`
 * rather than an error.
 */
export interface CodeNodeSelector {
  /** The declaring file: project-relative, POSIX separators. */
  readonly file?: string | undefined;

  /** The declared symbol name, matched against a node's `symbol` or its `name`. */
  readonly symbol?: string | undefined;

  /** The node's name as written in the source. */
  readonly name?: string | undefined;

  /** The node's kind. */
  readonly kind?: CodeNodeKind | undefined;
}

/**
 * A {@link CodeQueries.pathBetween} endpoint: a `nodeId` from an earlier result,
 * or a description of the node to look for.
 */
export type CodePathEndpoint = string | CodeNodeSelector;

/** How to run {@link CodeQueries.pathBetween}. */
export interface PathBetweenOptions {
  /**
   * Follow only these edge kinds.
   *
   * Omitted means **all** of them, which is the documented default and not an
   * oversight: a route node may reach a service function directly through a
   * `calls` edge or through a `declares` hop to the exported method symbol that
   * calls it, and a path that survives either shape has to be allowed to mix
   * them. Narrowing is for a caller asking a more specific question, such as a
   * pure call chain.
   */
  readonly edgeKinds?: readonly CodeEdgeKind[] | undefined;

  /**
   * Which way to traverse: `'out'` downstream (the default) or `'both'` for an
   * undirected search.
   *
   * `'out'` answers "what does this reach", which is the direction a flow is
   * read in. `'both'` answers "are these two things related at all" and is
   * markedly more expensive, since every node's incoming edges join the
   * frontier as well.
   */
  readonly direction?: CodePathDirection | undefined;

  /** Allow at most this many hops, clamped to {@link CodeQueryLimits.maxPathDepth}. */
  readonly maxDepth?: number | undefined;

  /** Expand at most this many nodes, clamped to {@link CodeQueryLimits.maxPathNodes}. */
  readonly maxNodes?: number | undefined;
}

/** The traversal directions {@link CodeQueries.pathBetween} supports. */
export type CodePathDirection = 'out' | 'both';

/**
 * A region of a file to excerpt.
 *
 * The alternative to a `nodeId`, for a caller that has a location — from a
 * telemetry event, from a plan action — rather than a node.
 */
export interface CodeExcerptRegion {
  /** The file: project-relative, POSIX separators. */
  readonly file: string;

  /** The **1-based** line to centre the window on. */
  readonly line: number;

  /**
   * The **1-based** last line of interest.
   *
   * When given, the window ends there rather than `contextLines` past `line` —
   * so a caller holding a function's extent gets the function, clamped to the
   * excerpt budget.
   */
  readonly endLine?: number | undefined;
}

/** A {@link CodeQueries.excerpt} target: a `nodeId`, or an explicit region. */
export type CodeExcerptTarget = string | CodeExcerptRegion;

/** How to bound {@link CodeQueries.excerpt}. */
export interface ExcerptOptions {
  /**
   * How many lines of context to include before the anchor, and after it when
   * no `endLine` was given.
   *
   * Defaults to three. Clamped so the window can never exceed
   * {@link CodeQueryLimits.maxExcerptLines}.
   */
  readonly contextLines?: number | undefined;

  /** Return at most this many characters, clamped to {@link CodeQueryLimits.maxExcerptChars}. */
  readonly maxChars?: number | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The query surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * The read-only queries the code-investigation stage may run, as an interface
 * so `apps/local-service/src/pipeline/tools/code-tools.ts` depends on the
 * contract rather than on this implementation.
 *
 * Every method is total, and total over *values* rather than over types: an
 * argument that is malformed, over-long, of the wrong type altogether —
 * `undefined`, `null`, a number, an object where a name was declared — or that
 * simply matches nothing yields that query's empty answer (`[]`, `undefined`,
 * `false`), never an exception. The arguments come from a model (AAP 0.4.2 has
 * it propose the queries this surface executes), so a call that does not match
 * the declared signature is an ordinary event, and a stage that crashed on one
 * would have turned a recoverable answer into a failed session (AAP 0.5.5).
 * Refusals are recorded at debug level, naming the query and the argument;
 * see the *Argument admission* section of this module for the per-shape rules,
 * including the one repair it makes (a single kind name where a list of kinds
 * was declared).
 */
export interface CodeQueries {
  /**
   * The limits actually in force, after the caller's overrides were clamped.
   *
   * Exposed so the stage that describes these tools to a model can state the
   * real bounds instead of restating {@link CODE_QUERY_LIMITS} and drifting
   * from it.
   */
  readonly limits: CodeQueryLimits;

  /**
   * Finds the nodes a name could refer to, best match first.
   *
   * The entry point of an investigation: the model has a name from the
   * developer's question — a component, a function, a route — and needs the
   * declarations it might mean.
   *
   * Ranking is exact, then case-insensitive exact, then prefix, then substring,
   * reported as {@link CodeMatch.score}; within a tier, nodes are ordered by
   * `id`, so the answer is identical on every run. The exact tier is a
   * constant-time index read; the other tiers scan the graph's nodes in
   * canonical order.
   *
   * **The whole scan is ranked, and only then truncated.** A name matching more
   * of a large project than the budget allows yields the `limit` *best-ranked*
   * candidates and not the first `limit` the scan reached, so a substring hit
   * on an early node id never displaces a case-insensitive exact or prefix hit
   * on a later one. That costs no memory: the ranked candidates held are capped
   * at `limit` however many nodes match, and a candidate that cannot beat the
   * ones already held — on its score, or on its `id` at an equal score — is
   * rejected by that comparison alone, before any location is minted for it.
   *
   * Bound: {@link CodeQueryLimits.maxResults}, lowerable per call. An empty
   * name, a name longer than {@link CodeQueryLimits.maxNameLength} and an empty
   * `kinds` array all yield `[]`.
   *
   * @param name The name to look for.
   * @param options Kind filter, exactness and limit.
   * @returns The matches, best first, capped.
   *
   * @example
   * ```ts
   * queries.findByName('WidgetList', { kinds: ['component'] });
   * ```
   */
  findByName(name: string, options?: FindByNameOptions): readonly CodeMatch[];

  /**
   * Resolves one `(file, symbol)` pair to the **declaration** the graph holds
   * for it.
   *
   * The existence lookup the rest of the product asks before it acts on a name:
   * `packages/instrumentation/src/feasibility.ts` rejects a plan action whose
   * file or symbol is absent from the graph, and the patcher needs the
   * `exported`, `isAsync` and `enclosing` facts this returns before it can wrap
   * the function. The question is therefore not "does this name occur in this
   * file" but **"does this file declare a symbol an instrumentation action can
   * address"**, and the two answers have to agree with the patcher's: a symbol
   * this affirms is one `FunctionTimingPatcher` resolves to a declaration, and
   * one it denies is one the patcher would refuse with
   * `PATCH_TARGET_NOT_FOUND`.
   *
   * What follows from that, and what a caller can rely on:
   *
   * - **Only a node that declares the name answers.** The kinds that do are
   *   `symbol`, `component` and `server-function`, matched on
   *   {@link CodeNodeBase.name}. A match through {@link CodeNodeBase.symbol} is
   *   deliberately impossible here, which excludes two whole classes of false
   *   affirmation: a `handler` node, which is a record of a *binding* and
   *   carries the referenced function's name even when the declaration lives in
   *   the caller or in another file, and an `api-call` or `db-call` node, which
   *   carries the name of the function it sits *inside*. Both remain matchable
   *   by {@link CodeQueries.whoCalls} and {@link CodeQueries.findByName}, whose
   *   question is the wider one.
   * - **A type-level `symbol` node does not answer.** `type`, `interface` and
   *   `enum` declarations vanish at runtime, and `unknown` (a namespace, an
   *   unresolvable default export) says nothing about a body, so none of them
   *   is a declaration to instrument.
   * - **A nested declaration does answer**, with
   *   {@link CodeSymbolMatch.enclosing} naming the declarations that contain it
   *   — `submitOrder` inside `CheckoutForm` is addressable, and that is exactly
   *   the shape AAP §6's canonical plan names.
   *
   * `file` is normalised to a POSIX project-relative path and rejected if it is
   * not one, so an absolute path, a traversal or a backslash path answers
   * `undefined` rather than matching by accident. Among several declarations of
   * the name in one file the most specific wins — `server-function`, then
   * `component`, then `symbol` — with ties broken on position and then `id`.
   *
   * Bound: constant work per file, one index read and a scan of that file's
   * nodes.
   *
   * @param file The declaring file: project-relative, POSIX separators.
   * @param symbol The declared symbol name.
   * @returns The declaration, or `undefined` when the file declares no such
   * addressable symbol.
   */
  findSymbol(file: string, symbol: string): CodeSymbolMatch | undefined;

  /**
   * Whether `file` declares an addressable `symbol`.
   *
   * Exactly `findSymbol(file, symbol) !== undefined`, as a predicate for the
   * many call sites that need the answer and not the facts — so it carries the
   * same semantics, including that a `handler` node never answers it and that a
   * nested declaration does.
   *
   * @param file The declaring file: project-relative, POSIX separators.
   * @param symbol The declared symbol name.
   * @returns `true` when the file declares the symbol.
   */
  hasSymbol(file: string, symbol: string): boolean;

  /**
   * Finds the places a symbol is called or referenced from.
   *
   * **Static first, and by default static only.** The answer is read from the
   * `calls` and `references` edges an extractor already recorded, which is a
   * map lookup per target node. The injected reference resolver — ts-morph's
   * `findReferences`, which type-checks the program — is consulted only when
   * {@link WhoCallsOptions.useReferences} is set or the static answer is empty,
   * and only when one was injected at all. That laziness is the contract:
   * `../indexer.ts` deliberately never runs `findReferences` while building,
   * and this is the query that decides when it runs instead.
   *
   * Each result records which mechanism found it, in
   * {@link CallerRef.via}, and points at the **call site** rather than at the
   * caller's declaration wherever the edge recorded one. Results are
   * de-duplicated by position and ordered by file, then line, then column, then
   * caller `id`.
   *
   * Bound: {@link CodeQueryLimits.maxCallers}, lowerable per call. When the
   * answer is capped the result holds exactly that many entries and the drop is
   * logged at `debug`; a caller that needs to know whether more exist asks for
   * one more than it can use.
   *
   * @param target A symbol name, or a `{ file, symbol }` pair to disambiguate
   * it.
   * @param options Limit and reference-resolver opt-in.
   * @returns The call sites, ordered and capped.
   */
  whoCalls(target: string | WhoCallsTarget, options?: WhoCallsOptions): readonly CallerRef[];

  /**
   * Resolves a URL to the route module that answers it.
   *
   * Matching is delegated entirely to `../route-map.ts`, which owns route
   * groups, dynamic and catch-all segments, specificity ordering, decoding and
   * the rule for a path both routers claim. This query bounds the input at
   * {@link CodeQueryLimits.maxUrlLength}, hands the raw value over — an
   * absolute URL, a bare pathname, a query string, a fragment and a trailing
   * slash are all handled there — and enriches the match with the graph's own
   * `api-route` node.
   *
   * {@link RouteQueryResult.location} keeps `resolvedBy: 'route-map'`.
   *
   * Bound: one pass over the route list, which is derived from this graph once
   * and reused.
   *
   * @param url An absolute URL or a bare pathname.
   * @returns The route, or `undefined` when nothing answers the URL or the
   * input is unusable.
   *
   * @example
   * ```ts
   * queries.routeForUrl('http://localhost:3000/api/items?page=2')?.routePath;
   * ```
   */
  routeForUrl(url: string): RouteQueryResult | undefined;

  /**
   * Lists the handlers of the route that answers a URL, one per HTTP method.
   *
   * A route exporting `GET` and `POST` yields two entries with **distinct
   * locations** — the declaration of each handler, not the top of the module —
   * which is what makes the result usable as a plan target. A legacy Pages API
   * module yields one entry for `'ANY'`, pointing at its default export.
   *
   * Each entry's location is the declaration's own `'code-graph'` location when
   * the graph holds a node for it, and the route map's `'route-map'` location
   * forwarded unchanged when it does not.
   *
   * Bound: one {@link CodeQueries.routeForUrl} resolution plus a scan of the
   * route file's nodes, capped at {@link CodeQueryLimits.maxResults}.
   *
   * @param url An absolute URL or a bare pathname.
   * @param options Method filter.
   * @returns One entry per matching method, in the route's method order, or
   * `[]` when no route answers.
   */
  handlersFor(url: string, options?: HandlersForOptions): readonly HandlerRef[];

  /**
   * Finds the components that render the named component.
   *
   * **The direction is upward**: given `'WidgetList'`, the answer is the
   * components whose markup contains a `WidgetList` element — its parents — and
   * never the components `WidgetList` itself renders. That is the direction an
   * excessive-render investigation needs, because the cause of a child
   * re-rendering is a decision its parent made.
   *
   * Each result points at the JSX element in the parent when the render edge
   * recorded its position, falling back to the parent's declaration. Results
   * are de-duplicated by position and ordered by file, then line, then column,
   * then `id`. When no `component` node bears the name, component nodes whose
   * display name matches are tried, which catches a component declared through
   * a wrapper such as a memo helper.
   *
   * Bound: {@link CodeQueryLimits.maxResults}, lowerable per call.
   *
   * @param component The rendered component's name.
   * @param options Limit.
   * @returns The rendering components and their element sites.
   */
  componentsRendering(
    component: string,
    options?: ComponentsRenderingOptions,
  ): readonly ComponentRef[];

  /**
   * Finds the shortest chain of relationships from one node to another.
   *
   * This is what the investigation stage renders as a flow — an interaction, the
   * handler it triggers, the request it makes, the route that answers it, the
   * service function behind it, the query that function issues — and it is a
   * breadth-first search over **all** edge kinds by default, for the reason
   * {@link PathBetweenOptions.edgeKinds} records.
   *
   * Deterministic: endpoint candidates are seeded in `id` order and each
   * frontier node's edges are expanded in the graph's canonical edge-`id` order,
   * so the first complete path found is the same path on every run and in every
   * process, including for two graphs built independently from the same source.
   * Cycles are excluded by a visited set, and a node reached twice keeps its
   * first, shortest predecessor.
   *
   * Bounds: {@link CodeQueryLimits.maxPathDepth} hops and
   * {@link CodeQueryLimits.maxPathNodes} expansions, both lowerable per call.
   * Unreachable within those bounds is `undefined`; reachable but with a bound
   * hit during the search sets {@link CodePath.truncated}.
   *
   * **A path is only a flow when it is a downstream one.** The default
   * `direction: 'out'` answers "what does this reach", and every hop of the
   * result then points the way the path travels. An undirected search
   * (`direction: 'both'`) answers the weaker "are these related at all", and
   * its result says so in two places rather than looking like the first:
   * {@link CodePath.undirected} is `true`, and every hop the walk took
   * backwards carries {@link CodePathEdge.traversedAgainstDirection}. Both
   * kinds of result are read the same way — walk {@link CodePath.nodes}, where
   * `edges[i]` is the hop from `nodes[i]` to `nodes[i + 1]`.
   *
   * An argument that is neither a `nodeId` string nor a selector naming at
   * least one of `file`, `symbol`, `name` or `kind` resolves to nothing, which
   * is `undefined` rather than a throw: these queries are executed on a model's
   * behalf (AAP 0.4.2), so a malformed endpoint is an expected input.
   *
   * @param from The endpoint to start at.
   * @param to The endpoint to reach.
   * @param options Edge-kind filter, direction and bounds.
   * @returns The path, or `undefined` when either endpoint resolves to nothing
   * or no path exists within the bounds.
   */
  pathBetween(
    from: CodePathEndpoint,
    to: CodePathEndpoint,
    options?: PathBetweenOptions,
  ): CodePath | undefined;

  /**
   * Reads a bounded window of source text around a node or a location.
   *
   * The only query that returns code, and therefore the one the "no repository
   * dump" rule is really about: the window is clamped to
   * {@link CodeQueryLimits.maxExcerptLines} lines and
   * {@link CodeQueryLimits.maxExcerptChars} characters, on a line boundary, and
   * a request for an unbounded region is clamped rather than honoured.
   *
   * Text is read **only** through the {@link LoadedProject} handed to
   * {@link createCodeQueries} — the ts-morph project `../project.ts` opened,
   * which has already excluded `node_modules`, build output and every `.env*`
   * file. There is no filesystem access here and no path arithmetic against a
   * project root. Two independent guards run before the project is touched at
   * all: a path that `isEnvFilePath` recognises is refused, and so is one that
   * is not a safe project-relative POSIX path. Without a loaded project the
   * query returns `undefined` rather than failing, so a session that never
   * opened one degrades to "no excerpts" instead of a broken stage.
   *
   * Cost: one lookup of the source file in the loaded project and one split of
   * its text. Prompt cost is the budget above.
   *
   * The returned text may reach a model prompt. Redaction of what it contains
   * is applied on the way out, by
   * `packages/model-provider/src/redact-guard.ts`; the contract of *this*
   * helper is that the window is bounded and is never an environment file.
   *
   * @param target A `nodeId` from an earlier result, or an explicit region.
   * @param options Context lines and character budget.
   * @returns The excerpt, or `undefined` when there is no loaded project, the
   * target cannot be resolved, or the path is refused.
   */
  excerpt(target: CodeExcerptTarget, options?: ExcerptOptions): CodeExcerpt | undefined;
}

/** What {@link createCodeQueries} may be given besides the graph. */
export interface CodeQueryOptions {
  /**
   * The loaded project the excerpt helper reads text through.
   *
   * Optional: every other query answers from the graph alone, and a caller that
   * only has a cached index — reconstructed with `CodeGraph.fromIndex` and no
   * project open — gets every query but {@link CodeQueries.excerpt}, which
   * returns `undefined`.
   */
  readonly loaded?: LoadedProject | undefined;

  /**
   * The project's routes, when the caller already built them.
   *
   * Omitted, they are derived from this graph's `api-route` nodes on the first
   * route query and reused thereafter. The derivation is lazy because it
   * materialises an index envelope, and most investigations never ask a route
   * question. Passing a map built by `buildRouteMap` from a loaded project is
   * strictly better where one exists: it carries the per-method handler
   * locations that a map rebuilt from an index cannot know.
   */
  readonly routes?: readonly RouteEntry[] | undefined;

  /**
   * The reference resolver {@link CodeQueries.whoCalls} may deepen with.
   *
   * Optional, and consulted only as {@link WhoCallsOptions.useReferences}
   * describes. Injected rather than imported so this module does not depend on
   * `../indexer.ts`, and so a caller can decide whether a session is allowed to
   * spend a type-checking pass at all.
   */
  readonly references?: ReferenceResolver | undefined;

  /**
   * Lower ceilings than {@link CODE_QUERY_LIMITS}.
   *
   * Shallow-merged over the defaults and clamped member by member, so a value
   * above a default is the default: a caller may tighten the prompt budget,
   * never widen it.
   */
  readonly limits?: Partial<CodeQueryLimits> | undefined;

  /**
   * Where to report what was refused and what was capped.
   *
   * Defaults to `noopLogger`. Names, paths, route paths and counts are logged;
   * **source text never is**, because an excerpt is prompt material and a log
   * line is not the place to copy it.
   */
  readonly logger?: Logger | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Shared empties and ordering
 * ---------------------------------------------------------------------------------------------- */

/*
 * One frozen empty array per result type, returned by every miss. Sharing the
 * instance keeps a miss allocation-free — these queries are run in a loop by a
 * stage resolving a batch of model-proposed lookups — and freezing states that
 * a caller must not treat a result as scratch space.
 */
const EMPTY_NODES: readonly CodeNode[] = Object.freeze([]);
const EMPTY_MATCHES: readonly CodeMatch[] = Object.freeze([]);
const EMPTY_CALLERS: readonly CallerRef[] = Object.freeze([]);
const EMPTY_HANDLERS: readonly HandlerRef[] = Object.freeze([]);
const EMPTY_COMPONENTS: readonly ComponentRef[] = Object.freeze([]);

/**
 * Every line terminator TypeScript itself counts as one, so a split on this
 * produces the same line numbers the compiler — and therefore every node in the
 * graph — reports.
 */
const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Which declaration wins when several nodes in one file bear the same symbol
 * name, most specific first.
 *
 * A function that a route delegates to is described by a `server-function`
 * node, a component by a `component` node and an event handler by a `handler`
 * node; the `symbol` node for the same declaration is the generic fallback, and
 * anything else — an `api-call` or `db-call` node that merely records the
 * symbol it sits *inside* — is last. The order is what makes
 * {@link CodeQueries.findSymbol} answer with the node an instrumentation plan
 * can act on rather than with an arbitrary one.
 */
const SYMBOL_KIND_PREFERENCE: readonly CodeNodeKind[] = Object.freeze([
  'server-function',
  'component',
  'handler',
  'symbol',
]);

/**
 * The node kinds whose presence in a file asserts that the file **declares** a
 * name, and the only kinds {@link CodeQueries.findSymbol} answers from.
 *
 * `symbol` is the declaration inventory itself (`../extractors/symbols.ts`
 * emits one node per declaration, module-level, class member or nested);
 * `component` and `server-function` describe declarations too, and are listed
 * because a file whose component extraction succeeded while symbol extraction
 * dropped a construct must still resolve its own component.
 *
 * Three kinds are pointedly **absent**, each a false affirmation the graph used
 * to make: a `handler` node records a *binding* and carries the referenced
 * function's name even when the declaration is a parameter, a destructured prop
 * or another module's export; an `api-call` and a `db-call` node carry the name
 * of the function they sit *inside*. None of the three says "this file declares
 * this name", which is the question a feasibility check is asking.
 *
 * Frozen: a read-only vocabulary, and deliberately separate from
 * {@link SYMBOL_KIND_PREFERENCE}, which orders candidates for *every* symbol
 * lookup — including {@link CodeQueries.whoCalls}, whose wider question the
 * excluded kinds are legitimate answers to.
 */
const DECLARING_NODE_KINDS: readonly CodeNodeKind[] = Object.freeze([
  'symbol',
  'component',
  'server-function',
]);

/**
 * The `symbol` declaration kinds that declare nothing an instrumentation action
 * can address.
 *
 * `type`, `interface` and `enum` vanish at compilation, so no patch could wrap
 * one and no span could ever be produced for one; `unknown` is what
 * `../extractors/symbols.ts` records for a namespace or a default export it
 * could not classify, which says nothing about a body being present. A
 * `variable` is **not** here on purpose: a module-level `const` holding a
 * non-function is a declaration the patcher resolves and then refuses on its
 * shape, which is a different and more informative answer than "no such
 * symbol".
 *
 * Frozen: a read-only vocabulary.
 */
const NON_ADDRESSABLE_DECLARATIONS: readonly SymbolDeclarationKind[] = Object.freeze([
  'type',
  'interface',
  'enum',
  'unknown',
]);

/**
 * Byte-wise lexicographic comparison, never `localeCompare`.
 *
 * The reason `./graph.ts` gives for its own comparator applies verbatim: a
 * locale-aware comparison depends on the machine's collation settings, so two
 * developers running the same query over the same graph would get results in
 * different orders — and one of them would be looking at a different "first
 * candidate" than the other.
 *
 * @param left The first string.
 * @param right The second string.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * Orders two positions in the same or different files: file, then line, then
 * column.
 *
 * @param left The first location.
 * @param right The second location.
 * @returns The comparison, or `0` when the two are the same position.
 */
function compareLocations(left: SourceLocation, right: SourceLocation): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.column - right.column;
}

/**
 * The de-duplication key of a position.
 *
 * `NUL`-separated because it cannot occur in a path that
 * `isSafeRelativePath` accepts, so no pair of distinct positions can collide
 * on it.
 *
 * @param location The position.
 * @returns A key unique to `(file, line, column)`.
 */
function locationKey(location: SourceLocation): string {
  return `${location.file}\u0000${location.line}\u0000${location.column}`;
}

/**
 * Where a kind sits in {@link SYMBOL_KIND_PREFERENCE}.
 *
 * @param kind The node kind.
 * @returns Its rank, or one past the end for a kind the table does not list.
 */
function symbolKindRank(kind: CodeNodeKind): number {
  const rank = SYMBOL_KIND_PREFERENCE.indexOf(kind);
  return rank === -1 ? SYMBOL_KIND_PREFERENCE.length : rank;
}

/**
 * Orders the nodes of one file that bear the same symbol name: most specific
 * kind, then earliest position, then `id`.
 *
 * @param left The first node.
 * @param right The second node.
 * @returns The comparison.
 */
function compareSymbolCandidates(left: CodeNode, right: CodeNode): number {
  const byKind = symbolKindRank(left.kind) - symbolKindRank(right.kind);
  if (byKind !== 0) {
    return byKind;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  if (left.column !== right.column) {
    return left.column - right.column;
  }

  return compareStrings(left.id, right.id);
}

/**
 * Orders ranked name matches: best score first, then `nodeId`.
 *
 * @param left The first match.
 * @param right The second match.
 * @returns The comparison.
 */
function compareMatches(left: CodeMatch, right: CodeMatch): number {
  const byScore = (right.score ?? 0) - (left.score ?? 0);
  if (byScore !== 0) {
    return byScore;
  }

  return compareStrings(left.nodeId, right.nodeId);
}

/**
 * A bounded, ranked accumulator of name matches.
 *
 * The structure behind {@link CodeQueries.findByName}, and the reason its answer
 * is the *best* `limit` matches rather than the first `limit` a scan happened to
 * reach. Both name tiers offer every candidate they find to one of these; it
 * holds at most `limit` matches, keeps them in {@link compareMatches} order at
 * all times, and drops the worst held match the moment a better one arrives.
 * Ranking therefore happens **before** truncation while the scan stays bounded,
 * so a substring hit at a low node id can no longer displace a case-insensitive
 * exact or prefix hit at a high one — which is the ranking
 * {@link MATCH_SCORES} and {@link CodeMatch.score} promise a caller, and the
 * order a model reasons over the candidates in.
 *
 * Two properties are worth stating, because the obvious alternatives each lose
 * one of them:
 *
 * - **Memory is bounded by `limit`, never by the number of matching nodes.**
 *   Collecting every candidate and sorting at the end would rank correctly too,
 *   but it would allocate a {@link CodeMatch} — and mint a
 *   {@link SourceLocation} — per matching node, and a short needle matches a
 *   large share of a large project's names. Both pieces of state here are
 *   bounded: the held matches by `limit`, and the set of ids that de-duplicates
 *   offers by the same, because an evicted match's id leaves the set with it.
 * - **A hopeless candidate stays cheap.** {@link RankedMatches.admits} is a
 *   score comparison and, at an equal score, a string comparison of the node
 *   id — the whole of {@link compareMatches} against the worst held match — and
 *   is what a scan tests *before* asking for a conversion. So a node that
 *   cannot earn a place costs one tier test and one comparison and never
 *   reaches `locationOf`, however many of its kind the graph holds.
 */
interface RankedMatches {
  /**
   * Whether this candidate could still earn a place.
   *
   * `true` while fewer than `limit` matches are held. Once the accumulator is
   * full it answers the *whole* of {@link compareMatches}: a better score wins,
   * an equal score wins only when `nodeId` sorts before the worst held match's,
   * and anything else is refused. Taking the tie-break into account here rather
   * than after conversion is what keeps the accumulator's cost proportional to
   * `limit` instead of to the number of matching nodes — a needle matching a
   * whole score tier of a large project would otherwise mint a
   * {@link SourceLocation} for every one of them only to discard it.
   *
   * @param score The candidate's tier score.
   * @param nodeId The candidate's node id, which breaks a tie on score.
   * @returns `true` when the candidate is worth converting.
   */
  admits(score: number, nodeId: string): boolean;

  /**
   * Offers one node at one score.
   *
   * A node that is already held is ignored, which is what stops the loose tier
   * re-reporting — or silently downgrading to a lower tier — a node the exact
   * tier already contributed. A node that was held and has since been evicted
   * is not remembered, and does not need to be: the tiers offer a node at a
   * strictly lower score each time, so a re-offer of an evicted node is refused
   * by {@link RankedMatches.admits} on its own merits. The candidate is
   * re-tested against that predicate here, so a scan may use it as a pre-filter
   * but never has to.
   *
   * A node whose conversion is refused — its file is not a safe
   * project-relative path — is dropped without consuming any of the budget,
   * exactly like a node that never matched.
   *
   * @param node The matching node.
   * @param score The tier score, from {@link MATCH_SCORES}.
   */
  offer(node: CodeNode, score: number): void;

  /**
   * The matches held, already ordered and frozen.
   *
   * @returns The ranked matches, best first, or {@link EMPTY_MATCHES} when none
   * was kept.
   */
  drain(): readonly CodeMatch[];
}

/**
 * Builds a {@link RankedMatches} over one node-to-match conversion.
 *
 * Insertion into a sorted array of at most `limit` entries — at most
 * {@link CodeQueryLimits.maxResults}, so at most fifty — deliberately rather
 * than a heap: at that size the linear insert beats a heap's bookkeeping, it
 * leaves the held matches in their final order so {@link RankedMatches.drain}
 * needs no sort, and the tiers arrive in roughly descending score order, which
 * makes the common insertion a comparison or two at the tail.
 *
 * @param limit The greatest number of matches to hold, at least `1` — every
 * caller passes a {@link clampCap} result.
 * @param convert The node-to-match conversion, which answers `undefined` for a
 * node that must be skipped.
 * @returns The accumulator, frozen.
 */
function createRankedMatches(
  limit: number,
  convert: (node: CodeNode, score: number) => CodeMatch | undefined,
): RankedMatches {
  /** The held matches, in {@link compareMatches} order, never more than `limit`. */
  const held: CodeMatch[] = [];

  /**
   * The id of every node currently held, so an offer is never counted twice.
   *
   * Exactly the ids in `held`, added when a match is placed and removed when it
   * is evicted, which is what keeps this set bounded by `limit` alongside the
   * array it mirrors. It exists as a set rather than as a scan of `held`
   * because both tiers offer into the accumulator for every node they visit,
   * and that lookup is the hot path.
   */
  const heldIds = new Set<string>();

  const admits = (score: number, nodeId: string): boolean => {
    if (held.length < limit) {
      return true;
    }

    const worst = held[held.length - 1];
    if (worst === undefined) {
      return true;
    }

    const worstScore = worst.score ?? 0;
    if (score !== worstScore) {
      return score > worstScore;
    }

    // Equal scores are ordered by `nodeId`, so a candidate takes the last place
    // only by sorting before the match holding it. Deciding that here — rather
    // than by inserting and popping — is what stops a whole score tier being
    // converted into matches the accumulator immediately discards.
    return compareStrings(nodeId, worst.nodeId) < 0;
  };

  /**
   * Places a match in rank order, then discards the overflow.
   *
   * A backwards linear scan, because an admitted candidate usually belongs at
   * or near the tail. Every match reaching here has already been admitted
   * against the worst held match, so the overflow it displaces is another
   * match and never itself.
   *
   * @param match The match to place.
   */
  const insert = (match: CodeMatch): void => {
    let at = held.length;
    while (at > 0) {
      const previous = held[at - 1];
      if (previous === undefined || compareMatches(previous, match) <= 0) {
        break;
      }
      at -= 1;
    }

    held.splice(at, 0, match);
    heldIds.add(match.nodeId);

    if (held.length > limit) {
      const evicted = held.pop();
      if (evicted !== undefined) {
        heldIds.delete(evicted.nodeId);
      }
    }
  };

  const offer = (node: CodeNode, score: number): void => {
    if (heldIds.has(node.id) || !admits(score, node.id)) {
      return;
    }

    const match = convert(node, score);
    if (match === undefined) {
      return;
    }

    insert(match);
  };

  const drain = (): readonly CodeMatch[] =>
    held.length === 0 ? EMPTY_MATCHES : Object.freeze([...held]);

  return Object.freeze({ admits, offer, drain });
}

/**
 * Orders call sites: position, then the calling node's `id`.
 *
 * @param left The first call site.
 * @param right The second call site.
 * @returns The comparison.
 */
function compareCallerRefs(left: CallerRef, right: CallerRef): number {
  const byLocation = compareLocations(left.location, right.location);
  if (byLocation !== 0) {
    return byLocation;
  }

  return compareStrings(left.caller.nodeId, right.caller.nodeId);
}

/**
 * Orders rendering sites: position, then the rendering component's `id`.
 *
 * @param left The first site.
 * @param right The second site.
 * @returns The comparison.
 */
function compareComponentRefs(left: ComponentRef, right: ComponentRef): number {
  const byLocation = compareLocations(left.location, right.location);
  if (byLocation !== 0) {
    return byLocation;
  }

  return compareStrings(left.component.nodeId, right.component.nodeId);
}

/* -------------------------------------------------------------------------------------------------
 * Clamping and path safety
 * ---------------------------------------------------------------------------------------------- */

/**
 * Brings a caller-supplied cap into a usable range.
 *
 * Clamped, never rejected, and identically for every numeric cap: a value that
 * is not a finite number becomes the ceiling, a fractional value is floored,
 * anything below `1` becomes `1`, and anything above the ceiling becomes the
 * ceiling. A caller can therefore only ever ask for *less* than
 * {@link CODE_QUERY_LIMITS} allows.
 *
 * Clamping rather than failing is the right response to a budget hint from a
 * caller that is itself assembling a prompt: the useful answer to "give me ten
 * thousand callers" is fifty callers, not a lost investigation.
 *
 * @param value The caller's value, or `undefined` to take the default.
 * @param ceiling The ceiling for this cap, which is also its default.
 * @returns An integer in `[1, ceiling]`.
 */
function clampCap(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return ceiling;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return 1;
  }

  return floored > ceiling ? ceiling : floored;
}

/**
 * Brings a context-line count into range.
 *
 * Distinct from {@link clampCap} in exactly one way that matters: `0` is a
 * legitimate request — "the anchor line and nothing around it" — so the floor
 * is zero rather than one, and an absent value takes
 * {@link DEFAULT_EXCERPT_CONTEXT_LINES} rather than the ceiling, because an
 * excerpt defaults to a little context and not to the largest window allowed.
 *
 * @param value The caller's value, or `undefined` for the default.
 * @param ceiling The line ceiling in force.
 * @returns An integer in `[0, ceiling]`.
 */
function clampContextLines(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXCERPT_CONTEXT_LINES;
  }

  const floored = Math.floor(value);
  if (floored < 0) {
    return 0;
  }

  return floored > ceiling ? ceiling : floored;
}

/**
 * Brings a line or column number into the 1-based integer range the
 * `SourceLocation` schema requires.
 *
 * A node built by a well-behaved extractor is already in range; this exists so
 * that a graph reconstructed from a stale or hand-edited cache can never make
 * this module emit a location its own schema would reject.
 *
 * @param value The candidate position.
 * @returns A positive integer, defaulting to `1`.
 */
function clampPosition(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/**
 * Normalises a path and vouches for it as a project-relative POSIX path.
 *
 * The gate every file this module reports or reads passes through. It is the
 * same check the `SourceLocation` schema applies, applied *before* a location is
 * minted, so a malformed path becomes a dropped result rather than an invalid
 * object that fails validation three processes later.
 *
 * **Normalisation is lexical only, never a repair.** Redundant `.` and `..`
 * segments are resolved because two spellings of one project-relative path are
 * the same path, but a separator is not converted: a backslash path is refused
 * rather than rewritten, exactly as the shared schema refuses it. That is the
 * fail-closed direction for a value arriving from a model or from another
 * process — a path this module cannot vouch for character-for-character is one
 * it must not pass on, and quietly reinterpreting the separators of an
 * unfamiliar path is how a lookup silently resolves to the wrong file.
 *
 * @param file A path from a caller or from a graph node.
 * @returns The normalised project-relative POSIX path, or `undefined` when the
 * value is absolute, escapes the project, or carries a backslash or a control
 * character.
 */
function safeRelative(file: string): string | undefined {
  if (file.length === 0) {
    return undefined;
  }

  const normalized = normalizePosix(file);
  return isSafeRelativePath(normalized) ? normalized : undefined;
}

/**
 * Mints a `'code-graph'` location.
 *
 * The single place this module stamps `resolvedBy` and `confidence` for a
 * location of its own, and the reason the invariant cannot drift: the
 * confidence is read from {@link DEFAULT_RESOLUTION_CONFIDENCE} rather than
 * written as a number, positions are clamped into the schema's range, and an
 * `endLine` that would sit before its `line` is lifted to it.
 *
 * @param file The file: project-relative POSIX, already vouched for.
 * @param line The 1-based line.
 * @param column The 1-based column.
 * @param symbol The enclosing or declared symbol name, when known.
 * @param endLine The last line of the declaration, when known.
 * @returns The location.
 */
function codeGraphLocation(
  file: string,
  line: number,
  column: number,
  symbol: string | undefined,
  endLine: number | undefined,
): SourceLocation {
  const safeLine = clampPosition(line);
  const safeColumn = clampPosition(column);
  const safeEndLine =
    endLine === undefined ? undefined : Math.max(clampPosition(endLine), safeLine);

  return Object.freeze({
    file,
    line: safeLine,
    column: safeColumn,
    ...(symbol !== undefined && symbol.length > 0 ? { symbol } : {}),
    ...(safeEndLine !== undefined && safeEndLine > safeLine ? { endLine: safeEndLine } : {}),
    resolvedBy: 'code-graph' as const,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
  });
}

/**
 * The `'code-graph'` location of a node's declaration.
 *
 * The helper the plan asks for, with one deliberate widening of its signature:
 * it returns `undefined` for a node whose file is not a safe project-relative
 * path, which is the *skip* signal every caller here honours. Minting a
 * location for such a node would produce an object the shared schema rejects,
 * and the call path from a panel click to an editor is not the place to discover
 * that.
 *
 * The node's `symbol` is preferred over its `name` for the location's `symbol`,
 * because that is the field that keeps a call site attributable: an `api-call`
 * node is *named* for what it calls and carries the function it sits inside.
 *
 * @param node The node.
 * @returns Its location, or `undefined` when the node must be skipped.
 */
function locationOf(node: CodeNode): SourceLocation | undefined {
  const file = safeRelative(node.file);
  if (file === undefined) {
    return undefined;
  }

  return codeGraphLocation(file, node.line, node.column, node.symbol ?? node.name, node.endLine);
}

/**
 * The `'code-graph'` location of an edge's site — the line that writes the
 * relationship.
 *
 * The position a developer actually wants for a call or a rendered element: the
 * call expression, not the top of the function containing it. A derived edge
 * carries no site and yields `undefined`, which every caller answers by falling
 * back to the node's own declaration.
 *
 * @param edge The edge.
 * @param within The node the site belongs to, for the symbol name.
 * @returns The site's location, or `undefined` when the edge has no usable
 * site.
 */
function edgeLocation(edge: CodeEdge, within: CodeNode): SourceLocation | undefined {
  if (edge.file === undefined || edge.line === undefined) {
    return undefined;
  }

  const file = safeRelative(edge.file);
  if (file === undefined) {
    return undefined;
  }

  return codeGraphLocation(
    file,
    edge.line,
    edge.column ?? 1,
    within.symbol ?? within.name,
    undefined,
  );
}

/**
 * Whether a node declares the given symbol name.
 *
 * Both fields are checked because a declaration is found under its `name` while
 * a call site records the function it sits inside under `symbol`, and a caller
 * asking about a symbol means either.
 *
 * @param node The node.
 * @param symbol The symbol name.
 * @returns `true` when the node bears the name.
 */
function nodeBearsSymbol(node: CodeNode, symbol: string): boolean {
  return node.name === symbol || node.symbol === symbol;
}

/**
 * Whether a node is a **declaration of** the given symbol name — the narrower
 * test {@link CodeQueries.findSymbol} and {@link CodeQueries.hasSymbol} are
 * built on.
 *
 * Three conditions, and each one closes a way the graph previously affirmed a
 * symbol no patch could reach:
 *
 * 1. The name must be the node's own {@link CodeNodeBase.name}. A match through
 *    {@link CodeNodeBase.symbol} is what let a `handler` node answer for a
 *    function declared in a parent component, and an `api-call` or `db-call`
 *    node answer for the function it sits inside.
 * 2. The kind must be one of {@link DECLARING_NODE_KINDS}.
 * 3. For a `symbol` node, the declaration kind must not be one of
 *    {@link NON_ADDRESSABLE_DECLARATIONS}. A node with **no payload at all**
 *    passes: the classification is unknown rather than known to be type-level,
 *    and the honest answer for "this file declares this name" is still yes —
 *    the patcher resolves it and refuses it on its shape if there is no body.
 *
 * Deliberately *not* used by {@link CodeQueries.whoCalls}, which asks the wider
 * question "what does this name refer to here" and for which a call site
 * bearing the name is a legitimate answer.
 *
 * @param node The node.
 * @param symbol The symbol name.
 * @returns `true` when the node declares the name.
 */
function nodeDeclaresSymbol(node: CodeNode, symbol: string): boolean {
  if (node.name !== symbol || !DECLARING_NODE_KINDS.includes(node.kind)) {
    return false;
  }

  if (node.kind !== 'symbol') {
    return true;
  }

  const declaration = node.data?.declaration;

  return declaration === undefined || !NON_ADDRESSABLE_DECLARATIONS.includes(declaration);
}

/**
 * Orders two declarations of one name in one file for
 * {@link CodeQueries.findSymbol}: module scope first, then
 * {@link compareSymbolCandidates}'s kind, position and id.
 *
 * The extra tier exists so that this query and
 * `packages/instrumentation/src/patch/function-timing.ts` name the **same**
 * declaration when a file declares one name twice — a module-level
 * `function apply()` and a nested one inside a component, say. That patcher
 * resolves a bare name at module scope first and only descends into function
 * bodies when module scope yields nothing, so the outer declaration is the one
 * a bare `(file, symbol)` action patches; ordering by position alone would
 * report the nested declaration whenever it happens to be written earlier in
 * the file, and a planner would be told a location no patch would touch. A
 * nested declaration stays reachable in its own right — `findByName` lists it,
 * and its match carries the `enclosing` chain that qualifies the spelling.
 *
 * Applied to the `findSymbol`/`hasSymbol` candidate set only; every other query
 * keeps `compareSymbolCandidates` unchanged.
 *
 * @param left The first declaration.
 * @param right The second declaration.
 * @returns A negative number, zero, or a positive number.
 */
function compareDeclarationCandidates(left: CodeNode, right: CodeNode): number {
  const byScope = declarationScopeRank(left) - declarationScopeRank(right);

  return byScope === 0 ? compareSymbolCandidates(left, right) : byScope;
}

/**
 * `0` for a declaration at module scope or on a class, `1` for one nested
 * inside another declaration.
 *
 * Read from `SymbolNodeData.enclosing`, whose presence is the graph's statement
 * that the declaration is nested (see the field's own documentation); a kind
 * that cannot be nested — `component`, `server-function` — is module scope by
 * construction.
 *
 * @param node The declaration node.
 * @returns Its scope rank.
 */
function declarationScopeRank(node: CodeNode): number {
  return enclosingOf(node) === undefined ? 0 : 1;
}

/**
 * The enclosing named declarations of a matched node, when its payload records
 * them.
 *
 * Only a `symbol` node carries `SymbolNodeData.enclosing`, so every other kind
 * answers `undefined` — absent rather than `[]`, which would assert "nested
 * inside unnamed declarations", a claim no other extractor makes.
 *
 * @param node The node.
 * @returns The chain, outermost first, or `undefined` when the node is not a
 * nested declaration or does not record one.
 */
function enclosingOf(node: CodeNode): readonly string[] | undefined {
  return node.kind === 'symbol' ? node.data?.enclosing : undefined;
}

/**
 * Whether a declaration is exported from its file.
 *
 * The base field when the extractor filled it, the per-kind payload when it
 * did, and `false` otherwise — never `undefined`, because a consumer deciding
 * whether another module can reach this symbol needs an answer and "not known
 * to be exported" is the safe one.
 *
 * @param node The node.
 * @returns `true` when the declaration is exported.
 */
function exportedOf(node: CodeNode): boolean {
  if (node.exported !== undefined) {
    return node.exported;
  }

  switch (node.kind) {
    case 'server-function':
      return node.data.exported;
    case 'component':
      return node.data.isDefaultExport;
    case 'symbol':
      return node.data?.isDefaultExport ?? false;
    default:
      return false;
  }
}

/**
 * Whether a function is declared `async`, when the graph records it.
 *
 * Only a `server-function` node carries the fact, so every other kind answers
 * `undefined` — absent rather than `false`, which would assert something the
 * graph never said.
 *
 * @param node The node.
 * @returns `true` or `false` for a server function, `undefined` otherwise.
 */
function asyncOf(node: CodeNode): boolean | undefined {
  return node.kind === 'server-function' ? node.data.isAsync : undefined;
}

/**
 * Whether a node is the default export of its file, as far as the graph knows.
 *
 * Used to find the single dispatching handler of a legacy Pages API module,
 * whose method is reported as `'ANY'` because one function answers all of them.
 *
 * @param node The node.
 * @returns `true` when the node is a default export.
 */
function isDefaultExport(node: CodeNode): boolean {
  switch (node.kind) {
    case 'symbol':
      return node.data?.isDefaultExport ?? false;
    case 'component':
      return node.data.isDefaultExport;
    default:
      return false;
  }
}

/**
 * The tier a non-exact name match falls into, or `undefined` when the name does
 * not match at all.
 *
 * Case-insensitive throughout: the argument comes from a model reading a
 * developer's question, where the capitalisation of an identifier is the least
 * reliable part of it.
 *
 * @param candidate The node's name.
 * @param needle The lower-cased query name.
 * @returns The score for the tier, or `undefined`.
 */
function looseMatchScore(candidate: string, needle: string): number | undefined {
  const lowered = candidate.toLowerCase();

  if (lowered === needle) {
    return MATCH_SCORES.caseInsensitive;
  }

  if (lowered.startsWith(needle)) {
    return MATCH_SCORES.prefix;
  }

  return lowered.includes(needle) ? MATCH_SCORES.substring : undefined;
}

/**
 * The node kinds that can stand for a route's handler declaration.
 *
 * A route handler is described by a `server-function` node when the extractor
 * recognised it as one, by a `symbol` node otherwise, and by a `handler` node in
 * the unusual case of a module that registers one. A `component` is deliberately
 * absent: a page module's default export is a component, and reporting it as the
 * handler of the page's `GET` would conflate rendering with answering.
 */
const HANDLER_NODE_KINDS: readonly CodeNodeKind[] = Object.freeze([
  'server-function',
  'symbol',
  'handler',
]);

/** One entry of the breadth-first frontier of {@link CodeQueries.pathBetween}. */
interface FrontierStep {
  /** The node to expand. */
  readonly node: CodeNode;

  /** How many hops from the nearest `from` endpoint it sits. */
  readonly depth: number;
}

/** How a node was first reached, so a completed search can be walked back. */
interface PathLink {
  /** The edge that reached it. */
  readonly edge: CodeEdge;

  /** The `nodeId` the edge was traversed from, which is not always `edge.from`. */
  readonly from: string;
}

/**
 * Merges caller overrides onto {@link CODE_QUERY_LIMITS}, clamping each member
 * to its default as a ceiling.
 *
 * Shallow and exhaustive: every member is named, so adding a limit to
 * {@link CodeQueryLimits} stops this function compiling until it is handled
 * rather than silently defaulting to `undefined`.
 *
 * @param overrides The caller's partial limits, if any.
 * @returns The effective limits, frozen.
 */
function resolveLimits(overrides: Partial<CodeQueryLimits> | undefined): CodeQueryLimits {
  if (overrides === undefined) {
    return CODE_QUERY_LIMITS;
  }

  return Object.freeze({
    maxResults: clampCap(overrides.maxResults, CODE_QUERY_LIMITS.maxResults),
    maxCallers: clampCap(overrides.maxCallers, CODE_QUERY_LIMITS.maxCallers),
    maxPathDepth: clampCap(overrides.maxPathDepth, CODE_QUERY_LIMITS.maxPathDepth),
    maxPathNodes: clampCap(overrides.maxPathNodes, CODE_QUERY_LIMITS.maxPathNodes),
    maxExcerptLines: clampCap(overrides.maxExcerptLines, CODE_QUERY_LIMITS.maxExcerptLines),
    maxExcerptChars: clampCap(overrides.maxExcerptChars, CODE_QUERY_LIMITS.maxExcerptChars),
    maxNameLength: clampCap(overrides.maxNameLength, CODE_QUERY_LIMITS.maxNameLength),
    maxUrlLength: clampCap(overrides.maxUrlLength, CODE_QUERY_LIMITS.maxUrlLength),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Argument admission
 *
 * Every function below turns an argument of unknown provenance into either the
 * value this module can act on or `undefined`. They exist because this surface
 * is executed on a **model's** behalf: AAP 0.4.2 has the model propose queries
 * and `apps/local-service/src/pipeline/tools/code-tools.ts` execute them, so
 * `{"name": null}` or `{"kinds": 123}` is an ordinary input rather than a
 * programming error, and AAP 0.5.5 requires the stage to degrade rather than
 * fail. TypeScript states the intended shapes and cannot enforce them at that
 * boundary; these do, and the declared signatures stay exactly as they are so
 * an in-process caller sees no difference.
 *
 * The rule they share: an argument that is not the shape it claims produces the
 * query's **empty answer** — `[]`, `undefined`, `false` — never a throw and
 * never a partial guess. The one place a shape is repaired rather than refused
 * is a single kind name where a list was declared, which is unambiguous.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A value as a non-empty string, or `undefined`.
 *
 * Length is *not* bounded here: the internal length rule
 * ({@link CodeQueryLimits.maxNameLength}, {@link CodeQueryLimits.maxUrlLength})
 * stays where it is, so a too-long name keeps logging the reason it was
 * refused.
 *
 * @param value Any value.
 * @returns The string, or `undefined` when it is not a non-empty string.
 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A value as a plain object whose members can be read, or `undefined`.
 *
 * An array is refused: every options and selector shape on this surface is a
 * record, and an array reaching one of those positions is a caller error rather
 * than an empty record. A function is refused for the same reason.
 *
 * @param value Any value.
 * @returns The value as a readable record, or `undefined`.
 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * A value as a finite number, or `undefined`.
 *
 * Only finiteness is checked; the clamping the internal helpers apply
 * ({@link clampCap}, {@link clampPosition}) is what brings a number into range,
 * and it stays there so a caller's out-of-range hint keeps being clamped rather
 * than refused.
 *
 * @param value Any value.
 * @returns The number, or `undefined`.
 */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A kind filter as a list of known node kinds.
 *
 * Three outcomes, and the middle one is the only repair on this surface:
 *
 * - **absent** → `undefined`, which is the documented "no filter";
 * - **one kind name where a list was declared** (`kinds: 'component'`) → that
 *   one kind, because the intent is unambiguous and a model writing JSON gets
 *   this wrong routinely;
 * - **anything else** → the known kinds it contains, which for a malformed
 *   value is none. An empty list is the documented "matches nothing", so an
 *   unhonourable narrowing fails **closed** rather than quietly widening the
 *   answer to every kind.
 *
 * @param value The caller's `kinds` member.
 * @returns The filter, or `undefined` for no filter.
 */
function asNodeKinds(value: unknown): readonly CodeNodeKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isCodeNodeKind(value)) {
    return Object.freeze([value]);
  }

  const candidates: readonly unknown[] = Array.isArray(value) ? value : [];

  return Object.freeze(candidates.filter((candidate) => isCodeNodeKind(candidate)));
}

/**
 * An edge-kind filter as a list of known edge kinds, with the node-kind rules
 * of {@link asNodeKinds}.
 *
 * @param value The caller's `edgeKinds` member.
 * @returns The filter, or `undefined` for no filter.
 */
function asEdgeKinds(value: unknown): readonly CodeEdgeKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isCodeEdgeKind(value)) {
    return Object.freeze([value]);
  }

  const candidates: readonly unknown[] = Array.isArray(value) ? value : [];

  return Object.freeze(candidates.filter((candidate) => isCodeEdgeKind(candidate)));
}

/**
 * A {@link CodeQueries.whoCalls} target as either a symbol name or a
 * `(file, symbol)` pair.
 *
 * @param value The caller's target.
 * @returns The target, or `undefined` when it names no symbol.
 */
function asCallTarget(value: unknown): string | WhoCallsTarget | undefined {
  const name = asText(value);
  if (name !== undefined) {
    return name;
  }

  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const symbol = asText(record.symbol);
  if (symbol === undefined) {
    return undefined;
  }

  const file = asText(record.file);

  return file === undefined ? { symbol } : { file, symbol };
}

/**
 * A {@link CodePathEndpoint} as a `nodeId` or a selector with at least one
 * usable member.
 *
 * A selector whose every member is absent or ill-typed is refused rather than
 * widened: the internal resolver treats a fully empty selector as "no nodes",
 * and an endpoint the caller cannot describe must not silently become "every
 * node in the graph".
 *
 * @param value The caller's endpoint.
 * @returns The endpoint, or `undefined`.
 */
function asEndpoint(value: unknown): CodePathEndpoint | undefined {
  const nodeId = asText(value);
  if (nodeId !== undefined) {
    return nodeId;
  }

  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const file = asText(record.file);
  const symbol = asText(record.symbol);
  const name = asText(record.name);
  const kind = isCodeNodeKind(record.kind) ? record.kind : undefined;

  if (file === undefined && symbol === undefined && name === undefined && kind === undefined) {
    return undefined;
  }

  return {
    ...(file !== undefined ? { file } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
}

/**
 * A {@link CodeExcerptTarget} as a `nodeId` or a file region.
 *
 * A region needs a file and nothing more: an absent or ill-typed `line` becomes
 * line 1, which is what {@link clampPosition} has always done with one, so a
 * caller that names a file without a position still gets the top of it.
 *
 * @param value The caller's target.
 * @returns The target, or `undefined` when it names no file or node.
 */
function asExcerptTarget(value: unknown): CodeExcerptTarget | undefined {
  const nodeId = asText(value);
  if (nodeId !== undefined) {
    return nodeId;
  }

  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const file = asText(record.file);
  if (file === undefined) {
    return undefined;
  }

  const endLine = asFiniteNumber(record.endLine);

  return {
    file,
    line: asFiniteNumber(record.line) ?? 1,
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/**
 * A description of a rejected argument that is safe to log: what kind of value
 * arrived, never the value itself.
 *
 * Queries carry names a developer wrote and, in the excerpt case, paths — so a
 * log line that echoed the argument would put caller data in a log this package
 * does not own. The type is enough to debug a malformed call.
 *
 * @param value The rejected argument.
 * @returns A short type description.
 */
function describeArgument(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the query surface over one code graph.
 *
 * The returned object holds no state of the caller's data and writes nothing
 * anywhere: the graph, the loaded project and the reference resolver are inputs
 * it reads, and the single piece of internal state is the route list, derived
 * from the graph on the first route query and reused thereafter (see
 * {@link CodeQueryOptions.routes}). Two surfaces built over the same graph
 * therefore answer identically, and one can be discarded at any time.
 *
 * @param graph The indexed graph to answer from.
 * @param options The loaded project, prebuilt routes, reference resolver,
 * tightened limits and logger — every one optional.
 * @returns The query surface, frozen.
 *
 * @example
 * ```ts
 * const queries = createCodeQueries(graph, {
 *   loaded,
 *   references: createReferenceResolver(loaded),
 *   limits: { maxResults: 10 },
 *   logger,
 * });
 * ```
 */
export function createCodeQueries(graph: CodeGraph, options?: CodeQueryOptions): CodeQueries {
  const logger = options?.logger ?? noopLogger;
  const loaded = options?.loaded;
  const references = options?.references;
  const limits = resolveLimits(options?.limits);

  /*
   * The one mutable binding in this module, and the only state the plan permits:
   * the route list, either handed in by the caller or derived once from the
   * graph. The derivation materialises an index envelope, and most
   * investigations never ask a route question, so it is deferred rather than
   * paid for up front.
   */
  let routes: readonly RouteEntry[] | undefined = options?.routes;

  const routeEntries = (): readonly RouteEntry[] => {
    if (routes === undefined) {
      const derived = routeMapFromIndex(graph.toIndex()).entries;
      routes = derived;
      logger.debug('derived the route map from the code graph', { routes: derived.length });
    }

    return routes;
  };

  /** Whether a name, symbol or file argument is within the length bound. */
  const usableName = (value: string): boolean =>
    value.length > 0 && value.length <= limits.maxNameLength;

  /** A node as a {@link CodeMatch}, or `undefined` when the node must be skipped. */
  const toMatch = (node: CodeNode, score?: number): CodeMatch | undefined => {
    const location = locationOf(node);
    if (location === undefined) {
      logger.debug('dropped a node whose file is not a safe project-relative path', {
        nodeId: node.id,
        file: node.file,
      });
      return undefined;
    }

    return Object.freeze({
      nodeId: node.id,
      kind: node.kind,
      name: node.name,
      file: location.file,
      location,
      ...(score !== undefined ? { score } : {}),
    });
  };

  /** The nodes of one file that bear a symbol name, most specific first. */
  const symbolCandidates = (file: string, symbol: string): readonly CodeNode[] => {
    const normalized = safeRelative(file);
    if (normalized === undefined) {
      logger.debug('rejected a file argument that is not a safe project-relative path', { file });
      return EMPTY_NODES;
    }

    const matched = graph.nodesByFile(normalized).filter((node) => nodeBearsSymbol(node, symbol));
    return matched.length === 0 ? EMPTY_NODES : matched.sort(compareSymbolCandidates);
  };

  /**
   * The nodes of one file that **declare** a symbol name, most specific first —
   * the candidate set of {@link CodeQueries.findSymbol} and
   * {@link CodeQueries.hasSymbol}, and of nothing else.
   *
   * Separate from `symbolCandidates` rather than a narrowing of it because the
   * two answer different questions: this one asks "does this file declare a
   * symbol an instrumentation action can address" (see
   * {@link nodeDeclaresSymbol}), while `symbolCandidates` asks "which nodes of
   * this file bear this name", which is what `callTargets` needs and must keep.
   * The file guard, the normalisation and the ordering are the same, so a
   * caller sees the same behaviour for an unusable path and the same
   * "most specific kind, then position, then id" winner among the survivors —
   * after {@link compareDeclarationCandidates} has put a module-scope
   * declaration ahead of a nested one, so that a shadowed name resolves to the
   * declaration the function-timing patcher wraps for it.
   */
  const declarationCandidates = (file: string, symbol: string): readonly CodeNode[] => {
    const normalized = safeRelative(file);
    if (normalized === undefined) {
      logger.debug('rejected a file argument that is not a safe project-relative path', { file });
      return EMPTY_NODES;
    }

    const matched = graph
      .nodesByFile(normalized)
      .filter((node) => nodeDeclaresSymbol(node, symbol));
    return matched.length === 0 ? EMPTY_NODES : matched.sort(compareDeclarationCandidates);
  };

  /**
   * The ranked candidates for a name — see {@link CodeQueries.findByName} for
   * the contract.
   *
   * Both tiers offer into one {@link RankedMatches}, which is what keeps the
   * answer ranked while the work stays bounded: the accumulator holds at most
   * `limit` matches and orders them as they arrive, so the whole bounded node
   * set is ranked and only then truncated. Neither loop breaks at the cap —
   * breaking would decide the *membership* of the answer by node id, which is
   * the tie-break and not the ranking.
   */
  const findByName = (name: string, queryOptions?: FindByNameOptions): readonly CodeMatch[] => {
    if (!usableName(name)) {
      logger.debug('rejected a name argument outside the length bound', {
        length: name.length,
        maxNameLength: limits.maxNameLength,
      });
      return EMPTY_MATCHES;
    }

    const kinds = queryOptions?.kinds;
    if (kinds !== undefined && kinds.length === 0) {
      return EMPTY_MATCHES;
    }

    const limit = clampCap(queryOptions?.limit, limits.maxResults);
    const acceptable = (node: CodeNode): boolean =>
      kinds === undefined || kinds.includes(node.kind);
    const ranked = createRankedMatches(limit, toMatch);

    // The exact tier is a single index read; it is also the only tier a caller
    // asking for `exact` gets. Every hit here scores the same, so which of them
    // survives the cap is decided by the `nodeId` tie-break inside the
    // accumulator rather than by this index's arrival order.
    for (const node of graph.nodesByName(name)) {
      if (!acceptable(node)) {
        continue;
      }
      ranked.offer(node, MATCH_SCORES.exact);
    }

    if (queryOptions?.exact !== true) {
      // The loose tiers genuinely scan, in node-id order. The admission test is
      // what keeps that scan cheap: a candidate that cannot beat the worst held
      // match — on its score, or on its node id at an equal score — costs one
      // `looseMatchScore` call and one comparison, and is never converted into
      // a match or a location.
      const needle = name.toLowerCase();
      for (const node of graph.nodes()) {
        if (!acceptable(node)) {
          continue;
        }
        const score = looseMatchScore(node.name, needle);
        if (score === undefined || !ranked.admits(score, node.id)) {
          continue;
        }
        ranked.offer(node, score);
      }
    }

    return ranked.drain();
  };

  const findSymbol = (file: string, symbol: string): CodeSymbolMatch | undefined => {
    if (!usableName(file) || !usableName(symbol)) {
      return undefined;
    }

    for (const node of declarationCandidates(file, symbol)) {
      const location = locationOf(node);
      if (location === undefined) {
        logger.debug('dropped a node whose file is not a safe project-relative path', {
          nodeId: node.id,
          file: node.file,
        });
        continue;
      }

      const isAsync = asyncOf(node);
      const enclosing = enclosingOf(node);
      return Object.freeze({
        nodeId: node.id,
        kind: node.kind,
        name: node.name,
        file: location.file,
        location,
        symbol,
        exported: exportedOf(node),
        ...(isAsync !== undefined ? { isAsync } : {}),
        // Forwarded only when the node records it: absence is the statement
        // "module scope or a class member", which a `[]` here would contradict
        // (and `exactOptionalPropertyTypes` keeps the two apart).
        ...(enclosing !== undefined ? { enclosing } : {}),
      });
    }

    return undefined;
  };

  const hasSymbol = (file: string, symbol: string): boolean =>
    findSymbol(file, symbol) !== undefined;

  /** The declaration nodes a {@link CodeQueries.whoCalls} target names. */
  const callTargets = (target: string | WhoCallsTarget): readonly CodeNode[] => {
    const symbol = typeof target === 'string' ? target : target.symbol;
    if (!usableName(symbol)) {
      return EMPTY_NODES;
    }

    const file = typeof target === 'string' ? undefined : target.file;
    if (file === undefined) {
      return graph.nodesByName(symbol);
    }

    return usableName(file) ? symbolCandidates(file, symbol) : EMPTY_NODES;
  };

  /**
   * The innermost declaration containing a line, for attributing a reference to
   * a caller.
   *
   * Nearest declaration at or above the line whose extent, where the extractor
   * recorded one, still covers it; ties on the line prefer the more specific
   * kind, then the first node in canonical `id` order. The file node is the last
   * resort, so a reference in a module the extractors produced no declaration
   * for is still attributable to that module.
   */
  const enclosingNodeAt = (file: string, line: number): CodeNode | undefined => {
    const nodes = graph.nodesByFile(file);
    let best: CodeNode | undefined;

    for (const node of nodes) {
      if (node.kind === 'file' || node.line > line) {
        continue;
      }
      if (node.endLine !== undefined && node.endLine < line) {
        continue;
      }
      if (best === undefined || node.line > best.line) {
        best = node;
        continue;
      }
      if (node.line === best.line && symbolKindRank(node.kind) < symbolKindRank(best.kind)) {
        best = node;
      }
    }

    return best ?? nodes.find((node) => node.kind === 'file');
  };

  /**
   * Adds the resolver's answers to a caller set already built from edges.
   *
   * The expensive half of {@link CodeQueries.whoCalls}: one `findReferences`
   * pass per distinct `(file, symbol)` target. Each answer is re-minted as a
   * `'code-graph'` location anchored to the declaration that contains it, so
   * every location this module returns reports the mechanism that found it
   * uniformly, and a resolver that throws degrades to the static answer instead
   * of failing the stage.
   */
  const collectReferenceCallers = (
    targets: readonly CodeNode[],
    resolver: ReferenceResolver,
    collected: Map<string, CallerRef>,
  ): void => {
    const asked = new Set<string>();

    for (const target of targets) {
      const file = safeRelative(target.file);
      if (file === undefined) {
        continue;
      }

      const symbol = target.symbol ?? target.name;
      const askedKey = `${file}\u0000${symbol}`;
      if (asked.has(askedKey)) {
        continue;
      }
      asked.add(askedKey);

      let found: readonly SourceLocation[];
      try {
        found = resolver.referencesTo({ file, symbol });
      } catch (error) {
        logger.debug('reference resolution failed; keeping the static answer', {
          file,
          symbol,
          reason: error instanceof Error ? error.message : 'unknown error',
        });
        continue;
      }

      for (const reference of found) {
        const referenceFile = safeRelative(reference.file);
        if (referenceFile === undefined) {
          continue;
        }
        // The declaration is not one of its own callers.
        if (referenceFile === file && reference.line === target.line) {
          continue;
        }

        const enclosing = enclosingNodeAt(referenceFile, reference.line);
        if (enclosing === undefined) {
          continue;
        }

        const location = codeGraphLocation(
          referenceFile,
          reference.line,
          reference.column,
          enclosing.symbol ?? enclosing.name,
          undefined,
        );
        const key = locationKey(location);
        if (collected.has(key)) {
          continue;
        }

        const match = toMatch(enclosing);
        if (match === undefined) {
          continue;
        }
        collected.set(key, Object.freeze({ caller: match, via: 'references' as const, location }));
      }
    }
  };

  const whoCalls = (
    target: string | WhoCallsTarget,
    queryOptions?: WhoCallsOptions,
  ): readonly CallerRef[] => {
    const resolved = callTargets(target);
    if (resolved.length === 0) {
      return EMPTY_CALLERS;
    }

    const limit = clampCap(queryOptions?.limit, limits.maxCallers);
    const collected = new Map<string, CallerRef>();

    for (const node of resolved) {
      const incoming = [
        ...graph.incoming(node.id, 'calls'),
        ...graph.incoming(node.id, 'references'),
      ];
      for (const edge of incoming) {
        const caller = graph.nodeById(edge.from);
        if (caller === undefined) {
          continue;
        }
        const match = toMatch(caller);
        if (match === undefined) {
          continue;
        }
        const location = edgeLocation(edge, caller) ?? match.location;
        const key = locationKey(location);
        if (collected.has(key)) {
          continue;
        }
        collected.set(key, Object.freeze({ caller: match, via: 'edge' as const, location }));
      }
    }

    if (
      references !== undefined &&
      (queryOptions?.useReferences === true || collected.size === 0)
    ) {
      collectReferenceCallers(resolved, references, collected);
    }

    if (collected.size === 0) {
      return EMPTY_CALLERS;
    }

    const ordered = [...collected.values()].sort(compareCallerRefs);
    if (ordered.length <= limit) {
      return Object.freeze(ordered);
    }

    logger.debug('whoCalls result was capped', { found: ordered.length, limit });
    return Object.freeze(ordered.slice(0, limit));
  };

  const routeForUrl = (url: string): RouteQueryResult | undefined => {
    if (url.length === 0 || url.length > limits.maxUrlLength) {
      logger.debug('rejected a url argument outside the length bound', {
        length: url.length,
        maxUrlLength: limits.maxUrlLength,
      });
      return undefined;
    }

    // Matching, decoding and specificity all belong to ../route-map.ts; this
    // query contributes the bound above and the graph node below, and nothing
    // in between.
    const match = matchRoute(routeEntries(), url);
    if (match === undefined) {
      return undefined;
    }

    const entry = match.entry;
    const routeNode = graph.nodesByFile(entry.file).find((node) => node.kind === 'api-route');
    const node = routeNode === undefined ? undefined : toMatch(routeNode);

    return Object.freeze({
      match,
      routePath: entry.routePath,
      router: entry.router,
      kind: entry.kind,
      methods: entry.methods,
      params: match.params,
      file: entry.file,
      // Forwarded exactly as ../route-map.ts produced it, `resolvedBy:
      // 'route-map'` included: that module is the resolver here.
      location: entry.location,
      ...(node !== undefined ? { node } : {}),
    });
  };

  /** The declaration node standing for one method of a route, when the graph has one. */
  const handlerNodeFor = (
    file: string,
    method: HttpMethodName,
    declaredName: string | undefined,
  ): CodeNode | undefined => {
    const candidates = graph
      .nodesByFile(file)
      .filter((node) => HANDLER_NODE_KINDS.includes(node.kind));

    // An App Router module exports one function per method under the method's
    // own name; a legacy Pages module has a single default export, whose
    // declared name the route map recorded on the location it resolved.
    const wanted = method === 'ANY' ? declaredName : method;
    if (wanted !== undefined) {
      const named = candidates.filter((node) => node.name === wanted).sort(compareSymbolCandidates);
      const first = named[0];
      if (first !== undefined) {
        return first;
      }
    }

    if (method !== 'ANY') {
      return undefined;
    }

    return candidates.filter(isDefaultExport).sort(compareSymbolCandidates)[0];
  };

  const handlersFor = (url: string, queryOptions?: HandlersForOptions): readonly HandlerRef[] => {
    const route = routeForUrl(url);
    if (route === undefined) {
      return EMPTY_HANDLERS;
    }

    const wanted = queryOptions?.method;
    const handlers: HandlerRef[] = [];

    for (const method of route.methods) {
      if (handlers.length >= limits.maxResults) {
        logger.debug('handlersFor result was capped', {
          routePath: route.routePath,
          limit: limits.maxResults,
        });
        break;
      }
      // A single dispatching handler answers every method, so it survives any
      // method filter.
      if (wanted !== undefined && method !== wanted && method !== 'ANY') {
        continue;
      }

      const routeMapLocation = route.match.entry.methodLocations?.[method] ?? route.location;
      const node = handlerNodeFor(route.file, method, routeMapLocation.symbol);
      const declaration = node === undefined ? undefined : locationOf(node);

      handlers.push(
        Object.freeze({
          method,
          ...(node !== undefined && declaration !== undefined ? { symbol: node.name } : {}),
          location: declaration ?? routeMapLocation,
        }),
      );
    }

    return handlers.length === 0 ? EMPTY_HANDLERS : Object.freeze(handlers);
  };

  /**
   * The `component` nodes a name refers to: the declaration named that, the
   * declarations whose runtime display name is that, and the wrappers whose
   * implementation is that — de-duplicated, in the graph's canonical node order.
   *
   * A **union** rather than a first-match cascade, because a wrapped component
   * is known by two names and a captured render event carries only one of them.
   * `const Widget = memo(WidgetBody)` puts the `renders` edges on `Widget`
   * (that is the binding other modules render) while React may report either
   * name depending on whether the wrapper carries an explicit display name — so
   * a cascade that stopped at the first name match answered "nothing renders
   * this" for whichever half the caller happened not to name. Both halves now
   * lead to the same parents.
   */
  const componentNodesNamed = (component: string): readonly CodeNode[] => {
    const collected = new Map<string, CodeNode>();

    for (const node of graph.nodesByName(component)) {
      if (node.kind === 'component') {
        collected.set(node.id, node);
      }
    }

    for (const node of graph.nodesByKind('component')) {
      if (node.data.displayName === component || node.data.implementation === component) {
        collected.set(node.id, node);
      }
    }

    if (collected.size === 0) {
      return EMPTY_NODES;
    }

    // `nodesByKind` is already in canonical id order and `nodesByName` is a
    // subset of the same set, so sorting by id restores one deterministic order
    // over the union whichever tier contributed a node first.
    return [...collected.values()].sort((left, right) => compareStrings(left.id, right.id));
  };

  const componentsRendering = (
    component: string,
    queryOptions?: ComponentsRenderingOptions,
  ): readonly ComponentRef[] => {
    if (!usableName(component)) {
      return EMPTY_COMPONENTS;
    }

    const limit = clampCap(queryOptions?.limit, limits.maxResults);
    const collected = new Map<string, ComponentRef>();

    for (const target of componentNodesNamed(component)) {
      if (collected.size >= limit) {
        break;
      }

      // Incoming `renders` edges: the components that render this one. The
      // outgoing direction would answer the opposite question.
      for (const edge of graph.incoming(target.id, 'renders')) {
        if (collected.size >= limit) {
          break;
        }
        const parent = graph.nodeById(edge.from);
        if (parent === undefined) {
          continue;
        }
        const match = toMatch(parent);
        if (match === undefined) {
          continue;
        }
        const location = edgeLocation(edge, parent) ?? match.location;
        const key = `${match.nodeId}\u0000${locationKey(location)}`;
        if (collected.has(key)) {
          continue;
        }
        collected.set(key, Object.freeze({ component: match, location }));
      }
    }

    if (collected.size === 0) {
      return EMPTY_COMPONENTS;
    }

    return Object.freeze([...collected.values()].sort(compareComponentRefs));
  };

  /** The nodes a {@link CodePathEndpoint} names, in canonical `id` order. */
  const resolveEndpoint = (endpoint: CodePathEndpoint): readonly CodeNode[] => {
    if (typeof endpoint === 'string') {
      const byId = graph.nodeById(endpoint);
      return byId === undefined ? EMPTY_NODES : Object.freeze([byId]);
    }

    const { file, name, symbol, kind } = endpoint;
    if (file === undefined && name === undefined && symbol === undefined && kind === undefined) {
      return EMPTY_NODES;
    }

    let candidates: readonly CodeNode[];
    if (file !== undefined) {
      const normalized = safeRelative(file);
      if (normalized === undefined || !usableName(file)) {
        logger.debug('rejected an endpoint file that is not a safe project-relative path', {
          file,
        });
        return EMPTY_NODES;
      }
      candidates = graph.nodesByFile(normalized);
    } else if (name !== undefined) {
      candidates = usableName(name) ? graph.nodesByName(name) : EMPTY_NODES;
    } else if (kind !== undefined) {
      candidates = graph.nodesByKind(kind);
    } else {
      candidates = graph.nodes();
    }

    const matched = candidates.filter(
      (node) =>
        (name === undefined || node.name === name) &&
        (symbol === undefined || nodeBearsSymbol(node, symbol)) &&
        (kind === undefined || node.kind === kind),
    );

    if (matched.length <= limits.maxResults) {
      return matched;
    }

    logger.debug('endpoint selector matched more nodes than the limit', {
      matched: matched.length,
      limit: limits.maxResults,
    });
    return matched.slice(0, limits.maxResults);
  };

  /**
   * The edges to expand from one node, in the graph's canonical edge-`id` order.
   *
   * The canonical order is what makes the search's outcome reproducible: the
   * frontier is extended in the same sequence on every run, so the first
   * complete path found is always the same path.
   */
  const expansionEdges = (
    nodeId: string,
    direction: CodePathDirection,
    edgeKinds: readonly CodeEdgeKind[] | undefined,
  ): readonly CodeEdge[] => {
    const outgoing = graph.outgoing(nodeId);
    const candidates =
      direction === 'both' ? [...outgoing, ...graph.incoming(nodeId)] : [...outgoing];
    const filtered =
      edgeKinds === undefined
        ? candidates
        : candidates.filter((edge) => edgeKinds.includes(edge.kind));

    return filtered.sort((left, right) => compareStrings(left.id, right.id));
  };

  /**
   * A resolved node and edge sequence as a {@link CodePath}.
   *
   * `nodes` is the traversal and `edges[i]` is the hop from `nodes[i]` to
   * `nodes[i + 1]`, so each hop's orientation is decided here — by comparing
   * the edge's own `from` with the node the walk arrived from — rather than
   * left for a consumer to infer from a chain that does not always chain.
   */
  const buildPath = (
    nodes: readonly CodeNode[],
    edges: readonly CodeEdge[],
    direction: CodePathDirection,
    truncated: boolean,
  ): CodePath | undefined => {
    const matches: CodeMatch[] = [];
    for (const node of nodes) {
      const match = toMatch(node);
      if (match === undefined) {
        // A path with a hole in it would misrepresent the flow, so the whole
        // answer is withheld rather than partially reported.
        return undefined;
      }
      matches.push(match);
    }

    const hops: CodePathEdge[] = [];
    for (const [position, edge] of edges.entries()) {
      const site = graph.nodeById(edge.from);
      const location = site === undefined ? undefined : edgeLocation(edge, site);
      const travelledFrom = nodes[position];
      hops.push(
        Object.freeze({
          kind: edge.kind,
          from: edge.from,
          to: edge.to,
          // A hop whose `from` is not the node the walk left is one the walk
          // took backwards. The `undefined` case cannot arise — `edges` is
          // always one shorter than `nodes` — and is answered `false` rather
          // than asserted, because a fabricated orientation is worse than a
          // conservative one.
          traversedAgainstDirection: travelledFrom !== undefined && edge.from !== travelledFrom.id,
          ...(location !== undefined ? { location } : {}),
        }),
      );
    }

    return Object.freeze({
      nodes: Object.freeze(matches),
      edges: Object.freeze(hops),
      depth: hops.length,
      undirected: direction === 'both',
      truncated,
    });
  };

  /** Walks the predecessor map back from a reached target to its source. */
  const reconstructPath = (
    target: CodeNode,
    links: ReadonlyMap<string, PathLink>,
    maxDepth: number,
    direction: CodePathDirection,
    truncated: boolean,
  ): CodePath | undefined => {
    const nodes: CodeNode[] = [target];
    const edges: CodeEdge[] = [];
    let current = target.id;

    for (let hop = 0; hop < maxDepth; hop += 1) {
      const link = links.get(current);
      if (link === undefined) {
        break;
      }
      const previous = graph.nodeById(link.from);
      if (previous === undefined) {
        return undefined;
      }
      nodes.push(previous);
      edges.push(link.edge);
      current = link.from;
    }

    nodes.reverse();
    edges.reverse();
    return buildPath(nodes, edges, direction, truncated);
  };

  const pathBetween = (
    from: CodePathEndpoint,
    to: CodePathEndpoint,
    queryOptions?: PathBetweenOptions,
  ): CodePath | undefined => {
    const edgeKinds = queryOptions?.edgeKinds;
    if (edgeKinds !== undefined && edgeKinds.length === 0) {
      return undefined;
    }

    const maxDepth = clampCap(queryOptions?.maxDepth, limits.maxPathDepth);
    const maxNodes = clampCap(queryOptions?.maxNodes, limits.maxPathNodes);
    const direction: CodePathDirection = queryOptions?.direction === 'both' ? 'both' : 'out';

    const sources = resolveEndpoint(from);
    const targets = resolveEndpoint(to);
    if (sources.length === 0 || targets.length === 0) {
      return undefined;
    }

    const targetIds = new Set<string>(targets.map((node) => node.id));
    const links = new Map<string, PathLink>();
    const visited = new Set<string>();
    const frontier: FrontierStep[] = [];

    for (const source of sources) {
      if (targetIds.has(source.id)) {
        // The endpoints name the same node: a path of one node and no hops.
        return buildPath([source], [], direction, false);
      }
      if (!visited.has(source.id)) {
        visited.add(source.id);
        frontier.push({ node: source, depth: 0 });
      }
    }

    let expanded = 0;
    let truncated = false;

    for (let head = 0; head < frontier.length; head += 1) {
      const step = frontier[head];
      if (step === undefined) {
        continue;
      }
      if (step.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      if (expanded >= maxNodes) {
        truncated = true;
        break;
      }
      expanded += 1;

      for (const edge of expansionEdges(step.node.id, direction, edgeKinds)) {
        const nextId = edge.from === step.node.id ? edge.to : edge.from;
        if (visited.has(nextId)) {
          continue;
        }
        const next = graph.nodeById(nextId);
        if (next === undefined) {
          continue;
        }
        visited.add(nextId);
        links.set(nextId, { edge, from: step.node.id });

        if (targetIds.has(nextId)) {
          return reconstructPath(next, links, maxDepth, direction, truncated);
        }
        frontier.push({ node: next, depth: step.depth + 1 });
      }
    }

    logger.debug('pathBetween found no path within the bounds', {
      direction,
      maxDepth,
      maxNodes,
      expanded,
      sources: sources.length,
      targets: targets.length,
      truncated,
    });
    return undefined;
  };

  /** A {@link CodeExcerptTarget} as an explicit region, or `undefined`. */
  const excerptRegion = (target: CodeExcerptTarget): CodeExcerptRegion | undefined => {
    if (typeof target !== 'string') {
      return usableName(target.file) ? target : undefined;
    }

    const node = graph.nodeById(target);
    if (node === undefined) {
      return undefined;
    }

    return {
      file: node.file,
      line: node.line,
      ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
    };
  };

  const excerpt = (
    target: CodeExcerptTarget,
    queryOptions?: ExcerptOptions,
  ): CodeExcerpt | undefined => {
    if (loaded === undefined) {
      logger.debug('excerpt requested without a loaded project');
      return undefined;
    }

    const region = excerptRegion(target);
    if (region === undefined) {
      return undefined;
    }

    const file = safeRelative(region.file);
    if (file === undefined) {
      logger.debug('excerpt refused a path that is not a safe project-relative path', {
        file: region.file,
      });
      return undefined;
    }

    // The privacy control of AAP 0.5.2, applied here a second time and
    // independently of ../project.ts's own exclusion: an environment file is
    // never read, never excerpted and therefore never promptable.
    if (isEnvFilePath(file)) {
      logger.debug('excerpt refused an environment file', { file });
      return undefined;
    }

    const sourceFile = loaded.project.getSourceFile(
      (candidate) => loaded.projectRelative(toPosix(candidate.getFilePath())) === file,
    );
    if (sourceFile === undefined) {
      logger.debug('excerpt found no such file in the loaded project', { file });
      return undefined;
    }

    const lines = sourceFile.getFullText().split(LINE_BREAK);
    const lastLine = Math.max(lines.length, 1);
    // The leading context is capped one line below the line budget, not at it:
    // the window is `[startLine, startLine + maxExcerptLines - 1]`, so leading
    // context equal to the whole budget would push the budget's end above the
    // anchor and return an excerpt that does not contain the line it was asked
    // about.
    const contextLines = clampContextLines(
      queryOptions?.contextLines,
      Math.max(limits.maxExcerptLines - 1, 0),
    );
    const maxChars = clampCap(queryOptions?.maxChars, limits.maxExcerptChars);

    const anchor = Math.min(clampPosition(region.line), lastLine);
    const startLine = Math.max(anchor - contextLines, 1);
    const requestedEnd =
      region.endLine === undefined
        ? anchor + contextLines
        : Math.max(clampPosition(region.endLine), anchor);
    const withinFile = Math.min(requestedEnd, lastLine);
    const withinBudget = Math.min(withinFile, startLine + limits.maxExcerptLines - 1);

    // Clipping by the line budget is truncation; a window that simply ran past
    // the end of the file is not — the file ended.
    let truncated = withinBudget < withinFile;

    const selected = lines.slice(startLine - 1, withinBudget);
    const kept: string[] = [];
    let used = 0;

    for (const line of selected) {
      const cost = kept.length === 0 ? line.length : line.length + 1;
      if (used + cost > maxChars) {
        if (kept.length === 0) {
          // A single line longer than the whole budget is the one case where the
          // cut cannot fall on a line boundary; an empty excerpt would be worse
          // than a clipped one.
          kept.push(line.slice(0, maxChars));
        }
        truncated = true;
        break;
      }
      kept.push(line);
      used += cost;
    }

    return Object.freeze({
      file,
      startLine,
      endLine: startLine + Math.max(kept.length, 1) - 1,
      text: kept.join('\n'),
      truncated,
    });
  };

  /**
   * Records a refused argument and answers with the query's empty result.
   *
   * The debug line names the query and the argument, which is what a developer
   * debugging a malformed model-proposed call needs, and describes the value by
   * type only (see {@link describeArgument}).
   *
   * @param query The query that was called.
   * @param argument The parameter that was not usable.
   * @param value The value that arrived.
   * @param empty The empty answer for that query.
   * @returns `empty`.
   */
  const refuse = <T>(query: string, argument: string, value: unknown, empty: T): T => {
    logger.debug('refused a query argument that is not the shape the query declares', {
      query,
      argument,
      received: describeArgument(value),
    });

    return empty;
  };

  /*
   * The published surface. Each entry admits its arguments (see the *Argument
   * admission* section) and then calls the implementation above, so the
   * implementations stay written against the types they declare while the
   * boundary stays total for the model-proposed calls of AAP 0.4.2.
   */
  return Object.freeze({
    limits,

    findByName: (name: string, queryOptions?: FindByNameOptions): readonly CodeMatch[] => {
      const wanted = asText(name);
      if (wanted === undefined) {
        return refuse('findByName', 'name', name, EMPTY_MATCHES);
      }

      const options = asRecord(queryOptions);
      const kinds = asNodeKinds(options?.kinds);

      return findByName(wanted, {
        ...queryOptions,
        ...(kinds !== undefined ? { kinds } : {}),
      });
    },

    findSymbol: (file: string, symbol: string): CodeSymbolMatch | undefined => {
      const wantedFile = asText(file);
      const wantedSymbol = asText(symbol);
      if (wantedFile === undefined) {
        return refuse('findSymbol', 'file', file, undefined);
      }
      if (wantedSymbol === undefined) {
        return refuse('findSymbol', 'symbol', symbol, undefined);
      }

      return findSymbol(wantedFile, wantedSymbol);
    },

    hasSymbol: (file: string, symbol: string): boolean => {
      const wantedFile = asText(file);
      const wantedSymbol = asText(symbol);
      if (wantedFile === undefined) {
        return refuse('hasSymbol', 'file', file, false);
      }
      if (wantedSymbol === undefined) {
        return refuse('hasSymbol', 'symbol', symbol, false);
      }

      return hasSymbol(wantedFile, wantedSymbol);
    },

    whoCalls: (
      target: string | WhoCallsTarget,
      queryOptions?: WhoCallsOptions,
    ): readonly CallerRef[] => {
      const wanted = asCallTarget(target);
      if (wanted === undefined) {
        return refuse('whoCalls', 'target', target, EMPTY_CALLERS);
      }

      return whoCalls(wanted, queryOptions);
    },

    routeForUrl: (url: string): RouteQueryResult | undefined => {
      const wanted = asText(url);

      return wanted === undefined
        ? refuse('routeForUrl', 'url', url, undefined)
        : routeForUrl(wanted);
    },

    handlersFor: (url: string, queryOptions?: HandlersForOptions): readonly HandlerRef[] => {
      const wanted = asText(url);

      return wanted === undefined
        ? refuse('handlersFor', 'url', url, EMPTY_HANDLERS)
        : handlersFor(wanted, queryOptions);
    },

    componentsRendering: (
      component: string,
      queryOptions?: ComponentsRenderingOptions,
    ): readonly ComponentRef[] => {
      const wanted = asText(component);

      return wanted === undefined
        ? refuse('componentsRendering', 'component', component, EMPTY_COMPONENTS)
        : componentsRendering(wanted, queryOptions);
    },

    pathBetween: (
      from: CodePathEndpoint,
      to: CodePathEndpoint,
      queryOptions?: PathBetweenOptions,
    ): CodePath | undefined => {
      const source = asEndpoint(from);
      const destination = asEndpoint(to);
      if (source === undefined) {
        return refuse('pathBetween', 'from', from, undefined);
      }
      if (destination === undefined) {
        return refuse('pathBetween', 'to', to, undefined);
      }

      const options = asRecord(queryOptions);
      const edgeKinds = asEdgeKinds(options?.edgeKinds);

      return pathBetween(source, destination, {
        ...queryOptions,
        ...(edgeKinds !== undefined ? { edgeKinds } : {}),
      });
    },

    excerpt: (
      target: CodeExcerptTarget,
      queryOptions?: ExcerptOptions,
    ): CodeExcerpt | undefined => {
      const wanted = asExcerptTarget(target);

      return wanted === undefined
        ? refuse('excerpt', 'target', target, undefined)
        : excerpt(wanted, queryOptions);
    },
  });
}
