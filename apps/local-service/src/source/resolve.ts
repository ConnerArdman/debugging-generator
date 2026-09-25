/**
 * The source-location resolver: a captured runtime item in, a project-relative
 * {@link SourceLocation} out — or, when nothing can vouch for one, no location
 * at all.
 *
 * Every row a generated panel renders can become a click that opens the
 * developer's editor at the right line (AAP §0.2.3, §0.4.2 "Source resolution
 * path", §0.8.4 acceptance test 1). The hop this module feeds is
 *
 * ```text
 * TelemetryEvent.source → panel SourceLink → PanelActions.openSource
 *   → service worker → WS source.open → src/source/open.ts → VS Code
 * ```
 *
 * and this module is where `TelemetryEvent.source` gets filled for an item a
 * producer could not stamp itself. `./open.ts` is the click forwarder and does
 * **not** import this module: resolution happens when events are decorated,
 * the click only carries the answer.
 *
 * ## The routes, and why their order is derived
 *
 * A location is produced by the first applicable route that yields a
 * validated, contained answer:
 *
 * 1. **`patch`** — a `function` span emitted by a reversible patch. The line
 *    and column originate in the four-key `meta` object literal
 *    `@debuggen/instrumentation`'s `wrap-template.ts` writes into the patched
 *    file (`PATCH_META_KEYS`: `file`, `line`, `column`, `symbol`), which the
 *    span helper of either tier turns into the only `TelemetryEvent.source`
 *    stamped `resolvedBy: 'patch'`. A `ModificationRecord` carries no
 *    position; its job here is **corroboration** — proof that this session
 *    really instrumented that file. An uncorroborated patch stamp is refused
 *    rather than trusted at confidence 1, and the item falls through to the
 *    later routes.
 * 2. **`route-map`** — `http.server` and `route.handler` spans, resolved by
 *    `@debuggen/code-analysis`'s route map from the span's route pattern or
 *    URL. The matched `RouteEntry.location` (or its per-method handler
 *    location) is already stamped `route-map`.
 * 3. **`code-graph`** — render/state/error spans by component display name,
 *    `db.query` spans by the database call site reachable from their
 *    enclosing function or route handler, and unpatched `function` spans by
 *    symbol. `createCodeQueries` already mints these locations stamped
 *    `code-graph`.
 * 4. **`source-map`** — `fetch`/`xhr` initiator stacks (and browser error
 *    stacks), mapped from generated chunks back to TypeScript by
 *    `resolveStack`, which already stamps `source-map`, discards dependency
 *    and bundler frames, talks only to the loopback dev server through
 *    `fetchSourceMap` and never throws.
 * 5. **`react-owner`** — a selected element, or an event carrying a
 *    component/owner chain, resolved by walking the chain nearest-first
 *    through the code graph. This is the **only** route whose stamp is minted
 *    here: the identification came from a runtime owner chain rather than a
 *    static query, so the location is re-stamped `react-owner` and must not
 *    inherit the `code-graph` confidence.
 *
 * The order is not written down anywhere in this file. {@link SOURCE_ROUTE_ORDER}
 * is `SOURCE_RESOLVED_BY` sorted by `DEFAULT_RESOLUTION_CONFIDENCE`, highest
 * first, so a future change to the shared table reorders this module
 * automatically and the panel's confidence badges and this module's
 * precedence can never disagree.
 *
 * ## Routes 2–4 are delegations
 *
 * Nothing here parses a stack, fetches a chunk, reads a source map, matches a
 * URL against a route tree or walks the AST. The route map, the code queries
 * and the stack resolver arrive injected (the index is built elsewhere and
 * never inside the resolver), and their answers are used as they come — this
 * module only chooses between them, narrows ambiguous candidates with runtime
 * evidence, and validates the result.
 *
 * ## An unresolvable item yields no location rather than a guess
 *
 * Several indistinguishable candidates are reported as `ambiguous`, never
 * settled by picking the first. A miss is an `Ok` carrying
 * `status: 'unresolved'` and the closed {@link SourceResolutionMissReason}
 * that explains it, together with every attempt made
 * ({@link SourceResolutionAttempt}), so the integration suite and the logs can
 * see which routes were tried. An `Err` is reserved for genuine faults: an
 * unparseable input, a cancelled call, a store port that itself failed.
 *
 * ## One location shape, contained three times
 *
 * Every returned location passes through `parseSourceLocation` with the
 * route's own `resolvedBy` and `DEFAULT_RESOLUTION_CONFIDENCE[route]` — no
 * confidence is invented and no local copy of the enumeration, the table or
 * the type exists. Containment is enforced at three independent points: here,
 * where a candidate whose `file` is not a safe project-relative path inside
 * the session's project is **dropped** (never "fixed up"); in `./open.ts`,
 * the click gate; and in the VS Code URI handler. `@debuggen/shared`'s
 * `paths.ts` (`isSafeRelativePath`, `resolveWithinProject`) is the single
 * containment predicate all three use. This module reads no file at all —
 * the code index owns that, and it already refuses every `.env*` file.
 *
 * ## Privacy
 *
 * Logs and errors carry ids, kinds, route names, reasons and counts only —
 * never file contents, a URL, a query value, a SQL statement, an attribute
 * value or a stack (AAP §0.5.2).
 *
 * ## Consumers
 *
 * `src/main.ts` wires {@link createSourceResolver}; `src/telemetry/ingest.ts`
 * and `src/telemetry/attribute.ts` decorate events at ingest,
 * `src/panels/data.ts` fills locations on panel-data rows,
 * `src/analysis/facts.ts` resolves suggested locations for hypotheses, and
 * `src/pipeline/**` resolves the selected target.
 *
 * @module
 */

import {
  CODE_QUERY_LIMITS,
  DB_DRIVERS,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  HTTP_METHOD_NAMES,
  createSourceMapCache,
  resolveStack,
} from '@debuggen/code-analysis';
import type {
  CodeGraph,
  CodeMatch,
  CodeNodeKind,
  CodeNodeOf,
  CodePathEndpoint,
  CodeQueries,
  DbDriver,
  HttpMethodName,
  RouteEntry,
  RouteMap,
  SourceMapCache,
} from '@debuggen/code-analysis';
import {
  PATCH_META_KEYS,
  isOpenModificationStatus,
  parseSelectedTarget,
} from '@debuggen/instrumentation';
import type { ModificationRecord, SelectedTarget } from '@debuggen/instrumentation';
import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  SOURCE_RESOLVED_BY,
  err,
  fromPromise,
  isAbsolutePosix,
  isErr,
  isSafeRelativePath,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  ok,
  parseSourceLocation,
  resolveWithinProject,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result, SourceLocation, SourceResolvedBy } from '@debuggen/shared';
import {
  KIND_ATTRIBUTE_KEYS,
  MAX_CALLER_LOOKUP_HOPS,
  QUERY_KINDS,
  TELEMETRY_KINDS,
  parseTelemetryEvent,
} from '@debuggen/telemetry';
import type {
  DB_QUERY_ATTRIBUTE_KEYS,
  ERROR_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  FUNCTION_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  TelemetryEvent,
  TelemetryKind,
} from '@debuggen/telemetry';

import { subsystemLogger } from '../logging.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary borrowed from the upstream catalogs
 *
 * Every attribute key, kind and patch-meta key below is typed against the
 * tuple that declares it, so a rename upstream is a compile error here rather
 * than a resolver that silently stops matching.
 * ---------------------------------------------------------------------------------------------- */

/** One key of a frozen attribute-key tuple from `@debuggen/telemetry`. */
type KeyOf<Tuple extends readonly string[]> = Tuple[number];

/**
 * The attribute keys this module reads, each checked against the kind tuple
 * that declares it in `@debuggen/telemetry`'s `schema/attributes.ts`.
 */
const ATTRIBUTE = Object.freeze({
  /** A render's (and a state transition's, and a browser error's) component display name. */
  component: 'component' satisfies KeyOf<typeof RENDER_ATTRIBUTE_KEYS>,
  /** A render's owner chain: the owning components, nearest first. */
  ownerChain: 'ownerChain' satisfies KeyOf<typeof RENDER_ATTRIBUTE_KEYS>,
  /** An interaction's component chain above its target element, nearest first. */
  componentChain: 'componentChain' satisfies KeyOf<typeof INTERACTION_ATTRIBUTE_KEYS>,
  /** The call-site stack a `fetch`/`xhr` span captured when the request started. */
  initiator: 'initiator' satisfies KeyOf<typeof FETCH_ATTRIBUTE_KEYS>,
  /** A browser error's stack. */
  errorStack: 'error.stack' satisfies KeyOf<typeof ERROR_ATTRIBUTE_KEYS>,
  /** The request method of a request-shaped span. */
  httpMethod: 'http.method' satisfies KeyOf<typeof HTTP_SERVER_ATTRIBUTE_KEYS>,
  /** The concrete request path of an `http.server` span (query values already redacted). */
  url: 'url' satisfies KeyOf<typeof HTTP_SERVER_ATTRIBUTE_KEYS>,
  /** The framework's route pattern for the request. */
  nextRoute: 'next.route' satisfies KeyOf<typeof ROUTE_HANDLER_ATTRIBUTE_KEYS>,
  /** The semantic-convention route pattern for the request. */
  httpRoute: 'http.route' satisfies KeyOf<typeof ROUTE_HANDLER_ATTRIBUTE_KEYS>,
  /** The wrapped or handling symbol's name. */
  symbol: 'symbol' satisfies KeyOf<typeof FUNCTION_ATTRIBUTE_KEYS>,
  /** A function span's project-relative module path. */
  module: 'module' satisfies KeyOf<typeof FUNCTION_ATTRIBUTE_KEYS>,
  /** The database client library a query span came from (`prisma` or `pg`). */
  dbClient: 'db.client' satisfies KeyOf<typeof DB_QUERY_ATTRIBUTE_KEYS>,
  /** The database system of a query span. */
  dbSystem: 'db.system' satisfies KeyOf<typeof DB_QUERY_ATTRIBUTE_KEYS>,
  /** The operation a query span performed. */
  dbOperation: 'db.operation' satisfies KeyOf<typeof DB_QUERY_ATTRIBUTE_KEYS>,
});

/**
 * The four keys of the patch `meta` literal, destructured from the one tuple
 * that declares them in `@debuggen/instrumentation`'s `wrap-template.ts` so no
 * spelling is restated here.
 */
const [META_FILE, META_LINE, META_COLUMN, META_SYMBOL] = PATCH_META_KEYS;

/** The telemetry kinds this module branches on by name, each checked against the vocabulary. */
const KIND = Object.freeze({
  function: 'function' satisfies TelemetryKind,
  httpServer: 'http.server' satisfies TelemetryKind,
  routeHandler: 'route.handler' satisfies TelemetryKind,
});

/**
 * The kinds the `route-map` route applies to: every kind whose declared
 * attributes include the framework route pattern — `http.server` and
 * `route.handler` — derived from the attribute catalog rather than listed.
 */
const ROUTE_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(ATTRIBUTE.nextRoute)),
);

/**
 * The kinds whose declared attributes carry a component display name — render,
 * state transition and browser error — resolved through the code graph by
 * component name.
 */
const COMPONENT_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(ATTRIBUTE.component)),
);

/** The kinds whose declared attributes carry an initiator stack (`fetch`, `xhr`). */
const INITIATOR_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(ATTRIBUTE.initiator)),
);

/** The kinds whose declared attributes carry an error stack. */
const ERROR_STACK_KINDS: readonly TelemetryKind[] = Object.freeze(
  TELEMETRY_KINDS.filter((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(ATTRIBUTE.errorStack)),
);

/**
 * The parent-span kinds that can own a database query: the first of these met
 * walking up from a `db.query` span is the enclosing application code.
 */
const QUERY_OWNER_KINDS: readonly TelemetryKind[] = Object.freeze([
  KIND.function,
  KIND.routeHandler,
  KIND.httpServer,
]);

/**
 * Code-graph node kinds tried, tier by tier, when a component display name is
 * resolved: a component declaration first, a plain symbol only when the graph
 * classified nothing as a component under that name.
 */
const COMPONENT_NODE_TIERS: readonly (readonly CodeNodeKind[])[] = Object.freeze([
  Object.freeze(['component'] as const),
  Object.freeze(['symbol'] as const),
]);

/**
 * Code-graph node kinds tried, tier by tier, when a function span's symbol is
 * resolved without a declaring file.
 */
const FUNCTION_NODE_TIERS: readonly (readonly CodeNodeKind[])[] = Object.freeze([
  Object.freeze(['server-function'] as const),
  Object.freeze(['symbol'] as const),
  Object.freeze(['component'] as const),
]);

/** The database-call node kind. */
const DB_CALL_NODE_KIND = 'db-call' satisfies CodeNodeKind;

/**
 * How many times a wrapped display name (`Wrapper(Inner)`) is unwrapped
 * before its inner name is looked up.
 */
const MAX_DISPLAY_NAME_UNWRAPS = 3;

/**
 * A wrapped React display name: `Outer(Inner)`, where the inner part is taken
 * as the next name to try. Matches the naming convention React itself uses for
 * memo, forwardRef and higher-order components, and nothing project-specific.
 */
const WRAPPED_DISPLAY_NAME = /^[A-Za-z_$][\w$.]*\((.+)\)$/;

/** The request line shape of an `http.server` span name: `METHOD /path`. */
const REQUEST_LINE_NAME = /^([A-Z]+) (\/\S*)$/;

/**
 * App Router file-convention suffixes a route pattern may carry. Tried only
 * after the pattern as written failed to match, so a real path segment of the
 * same name still resolves first.
 */
const ROUTE_FILE_SUFFIXES: readonly string[] = Object.freeze(['/route', '/page']);

/** An App Router route-group segment, which never appears in a URL. */
const ROUTE_GROUP_SEGMENT = /^\(.*\)$/;

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The resolution routes in precedence order: `SOURCE_RESOLVED_BY` sorted by
 * `DEFAULT_RESOLUTION_CONFIDENCE`, highest first — today
 * `patch → route-map → code-graph → source-map → react-owner`.
 *
 * Derived, never hand-written, so the shared confidence table is the single
 * statement of precedence: change a default there and this order follows. Ties
 * (none exist today) keep `SOURCE_RESOLVED_BY`'s own order, because
 * `Array.prototype.sort` is stable.
 *
 * Consumed by {@link createSourceResolver} and asserted by `resolve.test.ts`.
 */
export const SOURCE_ROUTE_ORDER: readonly SourceResolvedBy[] = Object.freeze(
  [...SOURCE_RESOLVED_BY].sort(
    (left, right) => DEFAULT_RESOLUTION_CONFIDENCE[right] - DEFAULT_RESOLUTION_CONFIDENCE[left],
  ),
);

/**
 * The caps every loop in this module is bounded by.
 *
 * Supplied through {@link SourceResolverDeps.limits}; an override may only
 * **lower** a cap (a non-positive, non-integer or larger value keeps the
 * default), because these bounds protect the ingest path and the panel-data
 * path from a pathological trace or index, and raising one is never what a
 * caller needs to be correct.
 */
export interface SourceResolveLimits {
  /**
   * Candidates requested from one `findByName` lookup. Two is enough to
   * detect ambiguity; more lets de-duplication by position collapse the
   * several graph nodes one declaration can produce.
   */
  readonly maxNameCandidates: number;

  /** Names tried from one component or owner chain, nearest first. */
  readonly maxChainNames: number;

  /** Stack frames mapped for one initiator stack; the resolver's own default. */
  readonly maxStackFrames: number;

  /** Distinct source maps looked up for one initiator stack; the resolver's own default. */
  readonly maxSourceMaps: number;

  /**
   * Parent spans walked up from a `db.query` span looking for its enclosing
   * function or route handler; the same budget the query aggregates use for
   * their caller walk.
   */
  readonly maxParentHops: number;

  /**
   * Database call sites tested for reachability from one enclosing function.
   * Beyond this the answer is `ambiguous` rather than a partial search's guess.
   */
  readonly maxDbCandidates: number;

  /** Route patterns and paths tried for one request span. */
  readonly maxRouteCandidates: number;

  /** Events resolved by one {@link SourceResolver.resolveEvents} call; the largest panel-data page. */
  readonly maxBatchEvents: number;
}

/**
 * The default caps. Frozen: a module-level table read on every resolution.
 *
 * The stack caps are `resolveStack`'s own `DEFAULT_MAX_FRAMES` and
 * `DEFAULT_MAX_MAPS`, the name cap sits well inside `CODE_QUERY_LIMITS`, and
 * the parent-hop cap is the telemetry query aggregates' `MAX_CALLER_LOOKUP_HOPS`,
 * so this module never walks further than the table that renders the same
 * caller does.
 */
export const SOURCE_RESOLVE_LIMITS: SourceResolveLimits = Object.freeze({
  maxNameCandidates: Math.min(8, CODE_QUERY_LIMITS.maxResults),
  maxChainNames: 16,
  maxStackFrames: DEFAULT_MAX_FRAMES,
  maxSourceMaps: DEFAULT_MAX_MAPS,
  maxParentHops: MAX_CALLER_LOOKUP_HOPS,
  maxDbCandidates: 64,
  maxRouteCandidates: 8,
  maxBatchEvents: 5_000,
});

/**
 * Why an item has no location, or why one route's candidate was refused — a
 * closed vocabulary, never a free-form string.
 *
 * - `no-applicable-route` — no route applies to this kind of item.
 * - `index-unavailable` — the route needs a code index, route map or code
 *   graph that has not been built (a legitimate state, not a fault).
 * - `symbol-not-found` — the index holds nothing under the runtime name.
 * - `ambiguous` — several indistinguishable declarations answer; none is
 *   chosen.
 * - `not-corroborated` — a patch stamp names a file no modification record of
 *   the session instrumented.
 * - `no-initiator-stack` — a request span carries no call-site stack.
 * - `dev-server-unknown` — the source-map route has no dev-server origin to pin
 *   its fetches to, so it does not fetch at all.
 * - `unmapped-frame` — no stack frame mapped into the project.
 * - `outside-project` — the candidate's file escapes the project root.
 * - `invalid-location` — the candidate fails the shared location schema, or
 *   carries a stamp from a different route.
 * - `aborted` — the call was cancelled; reported in an `Err`'s
 *   `details.reason`, never as an unresolved outcome.
 */
export const SOURCE_RESOLUTION_MISS_REASONS = Object.freeze([
  'no-applicable-route',
  'index-unavailable',
  'symbol-not-found',
  'ambiguous',
  'not-corroborated',
  'no-initiator-stack',
  'dev-server-unknown',
  'unmapped-frame',
  'outside-project',
  'invalid-location',
  'aborted',
] as const);

/** One member of {@link SOURCE_RESOLUTION_MISS_REASONS}. */
export type SourceResolutionMissReason = (typeof SOURCE_RESOLUTION_MISS_REASONS)[number];

/**
 * Which attempt's reason explains an unresolved item, most informative first.
 *
 * An item usually misses at several routes; the one reported is the reason
 * that tells a developer the most — an ambiguity or a refused candidate says
 * more than "this route did not apply".
 */
const MISS_REASON_PRIORITY: readonly SourceResolutionMissReason[] = Object.freeze([
  'ambiguous',
  'not-corroborated',
  'outside-project',
  'invalid-location',
  'unmapped-frame',
  'no-initiator-stack',
  'dev-server-unknown',
  'symbol-not-found',
  'index-unavailable',
  'no-applicable-route',
]);

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** A value a port may return synchronously (the SQLite repositories) or asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The narrow view of the modification journal the `patch` route corroborates
 * against.
 *
 * `createModificationsRepo` in `src/store/modifications-repo.ts` satisfies it
 * structurally (its `listBySession` takes an optional filter as a second
 * argument and returns a mutable array), as does the instrumentation package's
 * `ModificationJournal`. The resolver only reads: it never updates a record.
 */
export interface ModificationCorroborationPort {
  /** Every modification record of one session, in any status. */
  listBySession(
    sessionId: string,
  ): MaybePromise<Result<readonly ModificationRecord[], DebuggenError>>;
}

/**
 * An event the resolver can place: a persisted {@link TelemetryEvent}, or one
 * that ingest has attributed but the store has not ordered yet.
 *
 * Ingest resolves an event's location **before** it persists the event, so the
 * stored document, the live tail and every later panel-data read carry the
 * same `source`. At that point the store has not assigned `ingestSeq`, and no
 * route reads the ordering key, so both shapes are accepted.
 */
export type ResolvableEvent = Omit<TelemetryEvent, 'ingestSeq'> &
  Partial<Pick<TelemetryEvent, 'ingestSeq'>>;

/**
 * The narrow view of the telemetry store the `db.query` narrowing walks parent
 * spans through. `createTelemetryRepo` in `src/store/telemetry-repo.ts`
 * satisfies it structurally.
 */
export interface ParentEventPort {
  /** The persisted event of one span in one session, or `undefined` when none arrived. */
  getBySpanId(
    sessionId: string,
    spanId: string,
  ): MaybePromise<Result<TelemetryEvent | undefined, DebuggenError>>;
}

/**
 * Everything the resolver may reach, injected by `src/main.ts` (one resolver
 * per session project and code-index generation).
 *
 * Every code-analysis handle is optional: an index that has not been built yet
 * is a legitimate state, and the routes that need one answer
 * `index-unavailable` rather than failing.
 */
export interface SourceResolverDeps {
  /** Absolute root of the session's project (`SessionRecord.projectRoot`). */
  readonly projectRoot: string;

  /** The read-only code queries over the project's index (`createCodeQueries`). */
  readonly queries?: CodeQueries | undefined;

  /** The project's route map (`buildRouteMap` / `routeMapFromIndex`). */
  readonly routeMap?: RouteMap | undefined;

  /**
   * The code graph behind {@link SourceResolverDeps.queries}, used only to
   * enumerate database call sites and read their driver and operation when a
   * `db.query` span is narrowed to its call site; without it that sub-route
   * answers `index-unavailable`.
   */
  readonly graph?: CodeGraph | undefined;

  /** The modification journal the `patch` route corroborates against. */
  readonly modifications: ModificationCorroborationPort;

  /** The telemetry store, for walking a query span's parents. Optional. */
  readonly events?: ParentEventPort | undefined;

  /** The `fetch` the source-map route hands to `resolveStack`; tests inject one. */
  readonly fetchImpl?: typeof fetch | undefined;

  /**
   * A cross-call source-map cache. Absent means one fresh cache per
   * {@link SourceResolver.resolveEvent} call and one per
   * {@link SourceResolver.resolveEvents} batch, so a dev server's rebuilt
   * chunk is never mapped through a stale document.
   */
  readonly sourceMapCache?: SourceMapCache | undefined;

  /** The stack resolver; `resolveStack` from `@debuggen/code-analysis` unless a test injects one. */
  readonly resolveStackImpl?: typeof resolveStack | undefined;

  /**
   * The session's dev-server origin (`SessionRecord.devServerUrl`), forwarded
   * as the source-map fetch pin. Absent means the source-map route does not
   * fetch at all (`dev-server-unknown`).
   */
  readonly devServerOrigin?: string | undefined;

  /** Where diagnostics go; bound to the `source` subsystem. Defaults to silence. */
  readonly logger?: Logger | undefined;

  /** Lowered caps; see {@link SourceResolveLimits}. */
  readonly limits?: Partial<SourceResolveLimits> | undefined;

  /** Cancels every call on this resolver when aborted (for example at service shutdown). */
  readonly signal?: AbortSignal | undefined;
}

/** Per-call options. */
export interface SourceResolveOptions {
  /** Cancels this call; checked between routes and between batch items. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * What one route did for one item.
 *
 * - `hit` — the route produced the returned location.
 * - `miss` — the route applied and found nothing (see `reason`).
 * - `skipped` — the route does not apply to this item.
 * - `rejected` — the route found a candidate and refused it (containment,
 *   schema, or an uncorroborated patch stamp).
 *
 * A route may record more than one attempt: a refused pre-stamped location
 * followed by the route's own computation.
 */
export interface SourceResolutionAttempt {
  /** The route. */
  readonly route: SourceResolvedBy;
  /** What it did. */
  readonly outcome: 'hit' | 'miss' | 'skipped' | 'rejected';
  /** Why it did not hit; absent on a hit. */
  readonly reason?: SourceResolutionMissReason;
}

/**
 * The answer for one item: a validated, contained location and the route that
 * produced it, or the reason there is none. Both carry every attempt made.
 */
export type SourceResolution =
  | {
      readonly status: 'resolved';
      readonly location: SourceLocation;
      readonly route: SourceResolvedBy;
      readonly attempted: readonly SourceResolutionAttempt[];
    }
  | {
      readonly status: 'unresolved';
      readonly reason: SourceResolutionMissReason;
      readonly attempted: readonly SourceResolutionAttempt[];
    };

/**
 * The resolver handle `src/main.ts` wires and the ingest, panel-data, analysis
 * and pipeline modules consume. Every method answers a `Result` and never
 * throws.
 */
export interface SourceResolver {
  /**
   * Resolves one captured event.
   *
   * Used by `src/telemetry/{ingest,attribute}.ts` to decorate an event that
   * arrived without `source`, and by `src/analysis/facts.ts` for the event a
   * hypothesis cites. `Err` only for a malformed event, a cancelled call or a
   * failed store port.
   */
  resolveEvent(
    event: ResolvableEvent,
    options?: SourceResolveOptions,
  ): Promise<Result<SourceResolution, DebuggenError>>;

  /**
   * Resolves a selected element through its React owner chain (the
   * `react-owner` route, the only one a DOM target can use).
   *
   * Used by `src/pipeline/**` when Stage 1 is given a selected target.
   */
  resolveTarget(
    target: SelectedTarget,
    options?: SourceResolveOptions,
  ): Promise<Result<SourceResolution, DebuggenError>>;

  /**
   * Resolves a page of events, keyed by `TelemetryEvent.id`, holding only the
   * events that resolved (in input order).
   *
   * Used by `src/panels/data.ts` to put source links on panel-data rows. One
   * source-map cache, one modification list per session and the page's own
   * events (as parent spans) are shared across the batch; a malformed event is
   * skipped rather than failing the page, while a cancelled call or a failed
   * store port fails it. At most {@link SourceResolveLimits.maxBatchEvents}
   * events are resolved.
   */
  resolveEvents(
    events: readonly ResolvableEvent[],
    options?: SourceResolveOptions,
  ): Promise<Result<ReadonlyMap<string, SourceLocation>, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The lowest `ingestSeq` the persisted schema accepts, supplied **for the check
 * only** when an attributed event has none yet. It never leaves
 * {@link parseResolvableEvent}.
 */
const UNORDERED_INGEST_SEQ = 1;

/**
 * Validates a {@link ResolvableEvent} against the persisted event schema.
 *
 * A persisted event is checked as it is. An attributed event is checked with
 * {@link UNORDERED_INGEST_SEQ} standing in for the ordering key the store has
 * not assigned, so every other rule of the persisted schema — the session and
 * capture ids included — applies unchanged; the stand-in is removed again from
 * the value returned.
 *
 * @param value The event to validate.
 * @returns The validated event, in the shape it arrived in.
 */
function parseResolvableEvent(value: ResolvableEvent): Result<ResolvableEvent, DebuggenError> {
  if (typeof value !== 'object' || value === null || value.ingestSeq !== undefined) {
    return parseTelemetryEvent(value);
  }
  const parsed = parseTelemetryEvent({ ...value, ingestSeq: UNORDERED_INGEST_SEQ });
  if (!parsed.ok) {
    return parsed;
  }
  const attributed: ResolvableEvent = { ...parsed.value };
  delete attributed.ingestSeq;
  return ok(attributed);
}

/** What is being resolved: a captured event, or an element the developer selected. */
type Subject =
  | { readonly type: 'event'; readonly event: ResolvableEvent }
  | { readonly type: 'target'; readonly target: SelectedTarget };

/** One step a route took; a route's steps become its {@link SourceResolutionAttempt}s. */
type RouteStep =
  | { readonly outcome: 'hit'; readonly location: SourceLocation }
  | {
      readonly outcome: 'miss' | 'skipped' | 'rejected';
      readonly reason: SourceResolutionMissReason;
    };

/**
 * A location as some producer described it, before this module vouches for
 * it. Every field is `unknown` on purpose: a pre-stamped `event.source` and a
 * patch `meta` read out of an attribute bag are untrusted input.
 */
interface LocationCandidate {
  readonly file: unknown;
  readonly line: unknown;
  readonly column: unknown;
  readonly symbol?: unknown;
  readonly endLine?: unknown;
  readonly resolvedBy: unknown;
}

/** The result of vouching for a candidate. */
type Vetted =
  | { readonly accepted: true; readonly location: SourceLocation }
  | { readonly accepted: false; readonly reason: 'outside-project' | 'invalid-location' };

/** The enclosing application code of a database query span, as far as it could be told. */
interface QueryOwner {
  /** Project-relative POSIX file of the enclosing function or route module. */
  readonly file: string;
  /** The enclosing symbol, when known. */
  readonly symbol?: string | undefined;
}

/** A matched route and the location to open for it. */
interface RouteHit {
  readonly entry: RouteEntry;
  readonly location: SourceLocation;
}

/** Resolver-wide state: the injected handles, frozen at creation. */
interface ResolverEnv {
  readonly projectRoot: string;
  readonly queries: CodeQueries | undefined;
  readonly routeMap: RouteMap | undefined;
  readonly graph: CodeGraph | undefined;
  readonly modifications: ModificationCorroborationPort;
  readonly events: ParentEventPort | undefined;
  readonly fetchImpl: typeof fetch | undefined;
  readonly resolveStack: typeof resolveStack;
  readonly devServerOrigin: string | undefined;
  readonly logger: Logger;
  readonly limits: SourceResolveLimits;
}

/**
 * Per-call (or per-batch) state: what one resolution — or one page of them —
 * shares, and nothing that outlives it.
 */
interface ResolveScope {
  readonly sourceMapCache: SourceMapCache;
  /** Modification records already read, by session id. */
  readonly modificationsBySession: Map<string, readonly ModificationRecord[]>;
  /** The batch's own events by `(sessionId, spanId)`, consulted before the store. */
  readonly batchEvents: ReadonlyMap<string, ResolvableEvent>;
  /** Parent spans already read from the store; `null` records a span that never arrived. */
  readonly parentCache: Map<string, ResolvableEvent | null>;
  /** Every signal that cancels this call. */
  readonly signals: readonly AbortSignal[];
}

/** One route's implementation. May throw only by bug; the caller converts a throw into an `Err`. */
type RouteImpl = (
  env: ResolverEnv,
  scope: ResolveScope,
  subject: Subject,
) => Promise<Result<readonly RouteStep[], DebuggenError>>;

/** The modification status that means the patch was restored. */
const REVERTED_STATUS = 'reverted' satisfies ModificationRecord['status'];

/** The tier whose error stacks point into dev-server chunks the source-map route can read. */
const BROWSER_TIER = 'browser' satisfies ResolvableEvent['tier'];

/** The subsystem name this module's diagnostics are bound under. */
const LOG_SUBSYSTEM = 'source';

/** The one route whose stamp this module mints itself. */
const OWNER_ROUTE = 'react-owner' satisfies SourceResolvedBy;

/* -------------------------------------------------------------------------------------------------
 * Small pure helpers
 * ---------------------------------------------------------------------------------------------- */

const SKIPPED: RouteStep = Object.freeze({ outcome: 'skipped', reason: 'no-applicable-route' });

function hit(location: SourceLocation): RouteStep {
  return { outcome: 'hit', location };
}

function miss(reason: SourceResolutionMissReason): RouteStep {
  return { outcome: 'miss', reason };
}

function rejected(reason: SourceResolutionMissReason): RouteStep {
  return { outcome: 'rejected', reason };
}

/** A trimmed, non-empty string attribute, or `undefined`. */
function stringAttribute(event: ResolvableEvent, key: string): string | undefined {
  const value = event.attributes[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The non-empty strings of an array attribute, in order, at most `limit` of them. */
function stringListAttribute(event: ResolvableEvent, key: string, limit: number): string[] {
  const value = event.attributes[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value) {
    if (names.length >= limit) {
      break;
    }
    if (typeof item === 'string' && item.trim().length > 0) {
      names.push(item.trim());
    }
  }
  return names;
}

/** The request method a span names, when it is one the route map knows. */
function requestMethod(event: ResolvableEvent): HttpMethodName | undefined {
  const raw = stringAttribute(event, ATTRIBUTE.httpMethod);
  if (raw === undefined) {
    return undefined;
  }
  const upper = raw.toUpperCase();
  return HTTP_METHOD_NAMES.find((method) => method === upper);
}

/** The database driver a query span names, when it names one the code graph knows. */
function driverHint(event: ResolvableEvent): DbDriver | undefined {
  for (const key of [ATTRIBUTE.dbClient, ATTRIBUTE.dbSystem]) {
    const raw = stringAttribute(event, key)?.toLowerCase();
    const driver = DB_DRIVERS.find((candidate) => candidate === raw);
    if (driver !== undefined) {
      return driver;
    }
  }
  return undefined;
}

/** `sessionId` and `spanId` joined into one map key. */
function spanKey(sessionId: string, spanId: string): string {
  return `${sessionId}\u0000${spanId}`;
}

/** The identity of a location for de-duplication: file, line and column. */
function positionKey(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`;
}

/**
 * The names to look a React display name up under: the name itself, then the
 * inner name of each `Wrapper(Inner)` layer, de-duplicated.
 */
function displayNameCandidates(name: string): string[] {
  const names: string[] = [];
  let current = name.trim();
  for (let depth = 0; depth <= MAX_DISPLAY_NAME_UNWRAPS && current.length > 0; depth += 1) {
    if (current.length <= CODE_QUERY_LIMITS.maxNameLength && !names.includes(current)) {
      names.push(current);
    }
    const inner = WRAPPED_DISPLAY_NAME.exec(current)?.[1];
    if (inner === undefined) {
      break;
    }
    current = inner.trim();
  }
  return names;
}

/** A route pattern with its App Router route-group segments removed. */
function withoutRouteGroups(pattern: string): string {
  const segments = pattern.split('/').filter((segment) => !ROUTE_GROUP_SEGMENT.test(segment));
  const joined = segments.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** A route pattern with a trailing App Router file-convention segment removed. */
function withoutRouteFileSuffix(pattern: string): string {
  for (const suffix of ROUTE_FILE_SUFFIXES) {
    if (pattern === suffix) {
      return '/';
    }
    if (pattern.endsWith(suffix)) {
      return pattern.slice(0, -suffix.length);
    }
  }
  return pattern;
}

/**
 * The route patterns a request span names, most specific spelling first: each
 * pattern as written, then its variants without route groups and without a
 * file-convention suffix. Bounded and de-duplicated.
 */
function routePatterns(event: ResolvableEvent, limit: number): string[] {
  const written = [
    stringAttribute(event, ATTRIBUTE.nextRoute),
    stringAttribute(event, ATTRIBUTE.httpRoute),
  ].filter((pattern): pattern is string => pattern !== undefined && pattern.startsWith('/'));

  const patterns: string[] = [];
  const add = (pattern: string): void => {
    if (patterns.length < limit && !patterns.includes(pattern)) {
      patterns.push(pattern);
    }
  };
  for (const pattern of written) {
    add(pattern);
  }
  for (const pattern of written) {
    add(withoutRouteFileSuffix(withoutRouteGroups(pattern)));
  }
  return patterns;
}

/**
 * The concrete request targets a request span names: its `url` attribute and
 * the path of a `METHOD /path` span name. Bounded and de-duplicated.
 */
function requestTargets(event: ResolvableEvent, limit: number): string[] {
  const targets: string[] = [];
  const url = stringAttribute(event, ATTRIBUTE.url);
  if (url !== undefined) {
    targets.push(url);
  }
  const fromName = REQUEST_LINE_NAME.exec(event.name.trim())?.[2];
  if (fromName !== undefined && !targets.includes(fromName)) {
    targets.push(fromName);
  }
  return targets.slice(0, limit);
}

/**
 * Whether an entry answers `method`: a route that declares no method, or one
 * that dispatches every method, answers them all.
 */
function entryAnswers(entry: RouteEntry, method: HttpMethodName | undefined): boolean {
  if (method === undefined || entry.methods.length === 0) {
    return true;
  }
  return entry.methods.some((declared) => declared === method || declared === 'ANY');
}

/** Where to open a matched route: the method's own handler when located, else the module. */
function routeLocation(entry: RouteEntry, method: HttpMethodName | undefined): SourceLocation {
  const byMethod = method === undefined ? undefined : entry.methodLocations?.[method];
  return byMethod ?? entry.location;
}

/** Every cancelling signal of a call, in precedence order. */
function signalsFor(
  deps: SourceResolverDeps,
  options: SourceResolveOptions | undefined,
): AbortSignal[] {
  const signals: AbortSignal[] = [];
  if (deps.signal !== undefined) {
    signals.push(deps.signal);
  }
  if (options?.signal !== undefined) {
    signals.push(options.signal);
  }
  return signals;
}

/** One signal that aborts when any of `signals` does, or `undefined` for none. */
function combinedSignal(signals: readonly AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) {
    return undefined;
  }
  const [only] = signals;
  return signals.length === 1 ? only : AbortSignal.any([...signals]);
}

/** Whether any cancelling signal has fired. */
function isAborted(signals: readonly AbortSignal[]): boolean {
  return signals.some((signal) => signal.aborted);
}

/** The error a cancelled call answers with. */
function abortedError(): DebuggenError {
  const reason: SourceResolutionMissReason = 'aborted';
  return new DebuggenError('INTERNAL', 'Source resolution was cancelled before it finished.', {
    hint: 'Nothing was changed; request the source locations again.',
    details: { reason },
  });
}

/** The reason that best explains an unresolved item, from its attempts. */
function explainMiss(attempts: readonly SourceResolutionAttempt[]): SourceResolutionMissReason {
  for (const reason of MISS_REASON_PRIORITY) {
    if (attempts.some((attempt) => attempt.reason === reason)) {
      return reason;
    }
  }
  return 'no-applicable-route';
}

/**
 * The effective caps: each default, lowered by a valid override. The name cap
 * never drops below two, because a lookup that asks for one candidate cannot
 * see that a name is ambiguous and would return a guess.
 */
function mergeLimits(overrides: Partial<SourceResolveLimits> | undefined): SourceResolveLimits {
  const lowered = (key: keyof SourceResolveLimits, floor: number): number => {
    const fallback = SOURCE_RESOLVE_LIMITS[key];
    const value = overrides?.[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value >= fallback) {
      return fallback;
    }
    return Math.max(floor, value);
  };
  return Object.freeze({
    maxNameCandidates: lowered('maxNameCandidates', 2),
    maxChainNames: lowered('maxChainNames', 1),
    maxStackFrames: lowered('maxStackFrames', 1),
    maxSourceMaps: lowered('maxSourceMaps', 1),
    maxParentHops: lowered('maxParentHops', 1),
    maxDbCandidates: lowered('maxDbCandidates', 1),
    maxRouteCandidates: lowered('maxRouteCandidates', 1),
    maxBatchEvents: lowered('maxBatchEvents', 1),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Containment and validation — the one gate every returned location passes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The project-relative POSIX form of `file`, when it names a file inside the
 * project; otherwise why not.
 *
 * `isSafeRelativePath` and `resolveWithinProject` from `@debuggen/shared` are
 * the whole predicate — the same one `./open.ts` and the VS Code URI handler
 * apply. An absolute path or a traversal is `outside-project`; a backslash, a
 * control character or the project root itself is `invalid-location`. Nothing
 * is repaired: an absolute path inside the root is still refused, because a
 * producer that sent one is not producing the contract.
 */
function containedFile(
  projectRoot: string,
  file: string,
): { readonly file: string } | { readonly reason: 'outside-project' | 'invalid-location' } {
  if (!isSafeRelativePath(file)) {
    const posix = normalizePosix(toPosix(file));
    const escapes =
      isAbsolutePosix(toPosix(file)) ||
      isWindowsAbsolute(file) ||
      posix === '..' ||
      posix.startsWith('../');
    return { reason: escapes ? 'outside-project' : 'invalid-location' };
  }

  const normalized = normalizePosix(file);
  if (normalized === '.' || normalized.length === 0) {
    return { reason: 'invalid-location' };
  }
  if (isErr(resolveWithinProject(projectRoot, normalized))) {
    return { reason: 'outside-project' };
  }
  return { file: normalized };
}

/**
 * Vouches for a candidate as a location of `route`, or refuses it.
 *
 * The candidate must already carry `route`'s stamp (a location stamped by one
 * route is never passed off as another's — the one re-stamp, `react-owner`,
 * is made explicitly by that route before it gets here). Its file must be
 * contained; the confidence is always `DEFAULT_RESOLUTION_CONFIDENCE[route]`,
 * whatever the producer claimed; and the result is parsed by the shared
 * schema, so nothing this module returns was assembled without validation.
 */
function vet(env: ResolverEnv, candidate: LocationCandidate, route: SourceResolvedBy): Vetted {
  if (candidate.resolvedBy !== route || typeof candidate.file !== 'string') {
    return { accepted: false, reason: 'invalid-location' };
  }

  const contained = containedFile(env.projectRoot, candidate.file);
  if ('reason' in contained) {
    return { accepted: false, reason: contained.reason };
  }

  const symbol =
    typeof candidate.symbol === 'string' && candidate.symbol.trim().length > 0
      ? candidate.symbol
      : undefined;

  const parsed = parseSourceLocation({
    file: contained.file,
    line: candidate.line,
    column: candidate.column,
    ...(symbol === undefined ? {} : { symbol }),
    ...(candidate.endLine === undefined ? {} : { endLine: candidate.endLine }),
    resolvedBy: route,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE[route],
  });

  return parsed.ok
    ? { accepted: true, location: parsed.value }
    : { accepted: false, reason: 'invalid-location' };
}

/** The step one vetted candidate amounts to. */
function stepFor(vetted: Vetted): RouteStep {
  return vetted.accepted ? hit(vetted.location) : rejected(vetted.reason);
}

/**
 * The step a set of candidates for one route amounts to.
 *
 * Every candidate is vetted; the accepted ones are de-duplicated by position
 * (one declaration can surface as more than one graph node). Exactly one
 * position is a hit; several are `ambiguous` — never settled by taking the
 * first; none accepted but some refused is that refusal; none at all is
 * `symbol-not-found`.
 */
function choose(
  env: ResolverEnv,
  candidates: readonly LocationCandidate[],
  route: SourceResolvedBy,
): RouteStep {
  const accepted = new Map<string, SourceLocation>();
  let refusal: SourceResolutionMissReason | undefined;

  for (const candidate of candidates) {
    const vetted = vet(env, candidate, route);
    if (vetted.accepted) {
      const key = positionKey(vetted.location);
      if (!accepted.has(key)) {
        accepted.set(key, vetted.location);
      }
    } else {
      refusal ??= vetted.reason;
    }
  }

  const [only, ...others] = accepted.values();
  if (only !== undefined && others.length === 0) {
    return hit(only);
  }
  if (only !== undefined) {
    return miss('ambiguous');
  }
  return refusal === undefined ? miss('symbol-not-found') : rejected(refusal);
}

/**
 * The pre-stamped `event.source` of `route`, vetted, when the event carries
 * one; producers resolve some items themselves, and their answer is taken
 * before this module computes its own — but only after the same validation.
 */
function preStamped(
  env: ResolverEnv,
  subject: Subject,
  route: SourceResolvedBy,
): RouteStep | undefined {
  if (subject.type !== 'event') {
    return undefined;
  }
  const source = subject.event.source;
  if (source?.resolvedBy !== route) {
    return undefined;
  }
  return stepFor(vet(env, source, route));
}

/* -------------------------------------------------------------------------------------------------
 * Ports — every call awaited, every throw and rejection turned into an Err
 * ---------------------------------------------------------------------------------------------- */

/** Calls a port that answers a (possibly promised) `Result`, never letting it throw. */
async function callPort<T>(
  call: () => MaybePromise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError>> {
  const settled = await fromPromise(Promise.resolve().then(call), 'STORE_ERROR');
  return isErr(settled) ? settled : settled.value;
}

/** The session's modification records, read once per call or batch. */
async function modificationsFor(
  env: ResolverEnv,
  scope: ResolveScope,
  sessionId: string,
): Promise<Result<readonly ModificationRecord[], DebuggenError>> {
  const cached = scope.modificationsBySession.get(sessionId);
  if (cached !== undefined) {
    return ok(cached);
  }
  const listed = await callPort(() => env.modifications.listBySession(sessionId));
  if (isErr(listed)) {
    return listed;
  }
  scope.modificationsBySession.set(sessionId, listed.value);
  return listed;
}

/**
 * One parent span: from the batch being resolved first, then from the store,
 * remembered either way. `undefined` when it never arrived or no store was
 * injected.
 */
async function parentEvent(
  env: ResolverEnv,
  scope: ResolveScope,
  sessionId: string,
  spanId: string,
): Promise<Result<ResolvableEvent | undefined, DebuggenError>> {
  const key = spanKey(sessionId, spanId);
  const inBatch = scope.batchEvents.get(key);
  if (inBatch !== undefined) {
    return ok(inBatch);
  }
  const cached = scope.parentCache.get(key);
  if (cached !== undefined) {
    return ok(cached ?? undefined);
  }
  const port = env.events;
  if (port === undefined) {
    return ok(undefined);
  }
  const found = await callPort(() => port.getBySpanId(sessionId, spanId));
  if (isErr(found)) {
    return found;
  }
  scope.parentCache.set(key, found.value ?? null);
  return found;
}

/* -------------------------------------------------------------------------------------------------
 * Route 1 — patch
 * ---------------------------------------------------------------------------------------------- */

/**
 * The patch `meta` an event's attribute bag carries, as a `patch` candidate —
 * for a producer that forwarded the four keys without stamping `source`.
 */
function patchMetaCandidate(event: ResolvableEvent): LocationCandidate | undefined {
  const attributes = event.attributes;
  const file = attributes[META_FILE];
  if (typeof file !== 'string' || attributes[META_LINE] === undefined) {
    return undefined;
  }
  return {
    file,
    line: attributes[META_LINE],
    column: attributes[META_COLUMN],
    symbol: attributes[META_SYMBOL],
    resolvedBy: 'patch' satisfies SourceResolvedBy,
  };
}

/**
 * Whether this session's journal proves `file` was instrumented when `event`
 * ran.
 *
 * A record in an open status — `pending`, `applied`, `failed` or `conflict`,
 * i.e. every non-reverted status — corroborates. So does a `reverted` record
 * applied no later than the span started: cleanup restores the file but the
 * record still proves the patch existed when the span ran, which is what keeps
 * a reopened session's stored function spans at patch precision instead of
 * silently degrading them. Paths are compared in normalised project-relative
 * form; a record whose file is not one never matches.
 */
function corroborates(
  records: readonly ModificationRecord[],
  file: string,
  event: ResolvableEvent,
): boolean {
  return records.some((record) => {
    if (!isSafeRelativePath(record.file) || normalizePosix(record.file) !== file) {
      return false;
    }
    if (isOpenModificationStatus(record.status)) {
      return true;
    }
    return record.status === REVERTED_STATUS && record.appliedAt <= event.startTime;
  });
}

/**
 * Route 1: a span whose position was recorded by the patch that emitted it
 * (confidence 1).
 *
 * Candidates are the pre-stamped `source` (the span helper's) and the raw patch
 * `meta` attributes, in that order. Each must pass {@link vet} **and** be
 * corroborated by the session's modification records; an uncorroborated stamp
 * is `rejected` with `not-corroborated`, and resolution falls through to the
 * later routes rather than keeping an unverified confidence of 1.
 */
const patchRoute: RouteImpl = async (env, scope, subject) => {
  if (subject.type !== 'event') {
    return ok([SKIPPED]);
  }
  const event = subject.event;

  const candidates: LocationCandidate[] = [];
  if (event.source?.resolvedBy === 'patch') {
    candidates.push(event.source);
  }
  const meta = patchMetaCandidate(event);
  if (meta !== undefined) {
    candidates.push(meta);
  }
  if (candidates.length === 0) {
    return ok([SKIPPED]);
  }

  const steps: RouteStep[] = [];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    const vetted = vet(env, candidate, 'patch');
    if (!vetted.accepted) {
      steps.push(rejected(vetted.reason));
      continue;
    }
    const key = positionKey(vetted.location);
    if (tried.has(key)) {
      continue;
    }
    tried.add(key);

    const records = await modificationsFor(env, scope, event.sessionId);
    if (isErr(records)) {
      return records;
    }
    if (corroborates(records.value, vetted.location.file, event)) {
      steps.push(hit(vetted.location));
      return ok(steps);
    }
    steps.push(rejected('not-corroborated'));
  }
  return ok(steps);
};

/* -------------------------------------------------------------------------------------------------
 * Route 2 — route-map
 * ---------------------------------------------------------------------------------------------- */

/** The entry a route map or the code queries resolve one pattern or URL to. */
function resolveRouteEntry(
  env: ResolverEnv,
  target: string,
  method: HttpMethodName | undefined,
): RouteEntry | undefined {
  if (env.routeMap !== undefined) {
    return env.routeMap.resolve(target, method)?.entry;
  }
  const entry = env.queries?.routeForUrl(target)?.match.entry;
  return entry !== undefined && entryAnswers(entry, method) ? entry : undefined;
}

/**
 * The route that answered a request span, and where to open it.
 *
 * Route patterns (`next.route`, `http.route`) are preferred over concrete
 * URLs: a pattern is matched first by equality against the route map's
 * entries — in the map's own deterministic order, keeping the first entry that
 * answers the span's method — then through the map's resolver; the concrete
 * `url` and the span name's request line come last. The per-method handler
 * location is preferred to the module's when the entry recorded one.
 */
function findRoute(env: ResolverEnv, event: ResolvableEvent): RouteHit | undefined {
  const method = requestMethod(event);
  const limit = env.limits.maxRouteCandidates;

  for (const pattern of routePatterns(event, limit)) {
    const exact = env.routeMap?.entries.find(
      (entry) => entry.routePath === pattern && entryAnswers(entry, method),
    );
    const entry = exact ?? resolveRouteEntry(env, pattern, method);
    if (entry !== undefined) {
      return { entry, location: routeLocation(entry, method) };
    }
  }

  for (const target of requestTargets(event, limit)) {
    const entry = resolveRouteEntry(env, target, method);
    if (entry !== undefined) {
      return { entry, location: routeLocation(entry, method) };
    }
  }
  return undefined;
}

/**
 * Route 2: an `http.server` or `route.handler` span, located at the route
 * module (or its method's handler) the route map says answered it
 * (confidence 0.9). The route map's location is used unchanged; this route
 * only vets it.
 */
const routeMapRoute: RouteImpl = (env, _scope, subject) => {
  const steps: RouteStep[] = [];
  const stamped = preStamped(env, subject, 'route-map');
  if (stamped !== undefined) {
    steps.push(stamped);
    if (stamped.outcome === 'hit') {
      return Promise.resolve(ok(steps));
    }
  }

  if (subject.type !== 'event' || !ROUTE_KINDS.includes(subject.event.kind)) {
    return Promise.resolve(ok(steps.length > 0 ? steps : [SKIPPED]));
  }
  if (env.routeMap === undefined && env.queries === undefined) {
    steps.push(miss('index-unavailable'));
    return Promise.resolve(ok(steps));
  }

  const found = findRoute(env, subject.event);
  steps.push(
    found === undefined ? miss('symbol-not-found') : stepFor(vet(env, found.location, 'route-map')),
  );
  return Promise.resolve(ok(steps));
};

/* -------------------------------------------------------------------------------------------------
 * Route 3 — code-graph
 * ---------------------------------------------------------------------------------------------- */

/**
 * Looks `name` up tier by tier (exact, case-sensitive names only) and chooses
 * among the first tier that answers.
 *
 * The locations come from `createCodeQueries` already stamped `code-graph`
 * and are used as they come. For the `react-owner` route — and only for it —
 * they are re-stamped, because that identification came from a runtime owner
 * chain rather than a static query; the confidence then follows the new stamp
 * in {@link vet}. Any other mismatch between a location's stamp and `route`
 * is left for {@link vet} to refuse. A tier that answers with several
 * positions is `ambiguous` and ends the lookup — a later tier is never used to
 * break the tie.
 */
function lookupByName(
  env: ResolverEnv,
  queries: CodeQueries,
  name: string,
  tiers: readonly (readonly CodeNodeKind[])[],
  route: SourceResolvedBy,
): RouteStep {
  for (const kinds of tiers) {
    const matches: readonly CodeMatch[] = queries.findByName(name, {
      kinds,
      exact: true,
      limit: env.limits.maxNameCandidates,
    });
    if (matches.length === 0) {
      continue;
    }
    const candidates: LocationCandidate[] = matches.map((match) =>
      route === OWNER_ROUTE ? { ...match.location, resolvedBy: OWNER_ROUTE } : match.location,
    );
    return choose(env, candidates, route);
  }
  return miss('symbol-not-found');
}

/**
 * Resolves a React display name to its component declaration, trying the
 * inner name of each `Wrapper(Inner)` layer when the name as written matches
 * nothing.
 */
function resolveComponentName(
  env: ResolverEnv,
  queries: CodeQueries,
  displayName: string,
  route: SourceResolvedBy,
): RouteStep {
  for (const name of displayNameCandidates(displayName)) {
    const step = lookupByName(env, queries, name, COMPONENT_NODE_TIERS, route);
    if (step.outcome !== 'miss' || step.reason !== 'symbol-not-found') {
      return step;
    }
  }
  return miss('symbol-not-found');
}

/**
 * An unpatched `function` span, by its symbol: the declaring file's
 * declaration when the span names its module, otherwise the one declaration
 * of that name in the project.
 */
function resolveFunctionSymbol(
  env: ResolverEnv,
  queries: CodeQueries,
  event: ResolvableEvent,
): RouteStep {
  const symbol =
    stringAttribute(event, ATTRIBUTE.symbol) ??
    stringAttribute(event, META_SYMBOL) ??
    (event.name.trim().length > 0 ? event.name.trim() : undefined);
  if (symbol === undefined) {
    return miss('symbol-not-found');
  }

  const file = stringAttribute(event, ATTRIBUTE.module) ?? stringAttribute(event, META_FILE);
  if (file !== undefined) {
    const contained = containedFile(env.projectRoot, file);
    if ('reason' in contained) {
      return rejected(contained.reason);
    }
    const declared = queries.findSymbol(contained.file, symbol);
    if (declared !== undefined) {
      return stepFor(vet(env, declared.location, 'code-graph'));
    }
  }
  return lookupByName(env, queries, symbol, FUNCTION_NODE_TIERS, 'code-graph');
}

/**
 * The enclosing application code a parent span stands for: a function span's
 * declaration, or a request span's route module and handler.
 */
function ownerOf(
  env: ResolverEnv,
  queries: CodeQueries,
  parent: ResolvableEvent,
): QueryOwner | undefined {
  let file: string | undefined;
  let symbol: string | undefined;

  if (parent.kind === KIND.function) {
    const source = parent.source;
    const rawFile =
      source?.file ??
      stringAttribute(parent, META_FILE) ??
      stringAttribute(parent, ATTRIBUTE.module);
    if (rawFile === undefined) {
      return undefined;
    }
    const contained = containedFile(env.projectRoot, rawFile);
    if ('reason' in contained) {
      return undefined;
    }
    file = contained.file;
    symbol =
      source?.symbol ??
      stringAttribute(parent, ATTRIBUTE.symbol) ??
      stringAttribute(parent, META_SYMBOL) ??
      (parent.name.trim().length > 0 ? parent.name.trim() : undefined);
  } else {
    const route = findRoute(env, parent);
    if (route === undefined) {
      return undefined;
    }
    const contained = containedFile(env.projectRoot, route.entry.file);
    if ('reason' in contained) {
      return undefined;
    }
    file = contained.file;
    const method = requestMethod(parent);
    const named = stringAttribute(parent, ATTRIBUTE.symbol);
    symbol = [method, named].find(
      (candidate): candidate is string =>
        candidate !== undefined && queries.hasSymbol(contained.file, candidate),
    );
  }

  return { file, symbol };
}

/**
 * Walks up from a `db.query` span to the first enclosing function, route
 * handler or request span that identifies application code, at most
 * `maxParentHops` hops, stopping at a missing parent, a cycle or a parent in
 * another trace.
 */
async function findQueryOwner(
  env: ResolverEnv,
  scope: ResolveScope,
  queries: CodeQueries,
  event: ResolvableEvent,
): Promise<Result<QueryOwner | undefined, DebuggenError>> {
  const visited = new Set<string>([event.spanId]);
  let current = event;

  for (let hop = 0; hop < env.limits.maxParentHops; hop += 1) {
    const parentSpanId = current.parentSpanId;
    if (parentSpanId === undefined || visited.has(parentSpanId)) {
      break;
    }
    visited.add(parentSpanId);

    const parent = await parentEvent(env, scope, event.sessionId, parentSpanId);
    if (isErr(parent)) {
      return parent;
    }
    if (parent.value === undefined || parent.value.traceId !== event.traceId) {
      break;
    }
    if (QUERY_OWNER_KINDS.includes(parent.value.kind)) {
      const owner = ownerOf(env, queries, parent.value);
      if (owner !== undefined) {
        return ok(owner);
      }
    }
    current = parent.value;
  }
  return ok(undefined);
}

/**
 * Narrows `nodes` to those matching `accepts`, unless none does — a soft
 * preference: runtime evidence may break a tie but never empties the pool.
 */
function prefer<T>(nodes: readonly T[], accepts: ((node: T) => boolean) | undefined): readonly T[] {
  if (accepts === undefined) {
    return nodes;
  }
  const preferred = nodes.filter(accepts);
  return preferred.length > 0 ? preferred : nodes;
}

/**
 * The database call sites reachable from `owner` through the code graph,
 * nearest first: only those at the shortest path length are kept. `undefined`
 * when there are more candidates than the reachability budget, which the
 * caller reports as ambiguity rather than a partial search's answer.
 */
function reachableCalls(
  env: ResolverEnv,
  queries: CodeQueries,
  owner: QueryOwner,
  candidates: readonly CodeNodeOf<'db-call'>[],
): readonly CodeNodeOf<'db-call'>[] | undefined {
  if (candidates.length > env.limits.maxDbCandidates) {
    return undefined;
  }
  // `symbol` rather than `name`: a selector's `symbol` matches a node's
  // `symbol` or its `name`, which seeds the search from every node that stands
  // for the declaration — the declaration itself, and the route node a route
  // module's handler edges leave from (its `symbol` is the method's name).
  const from: CodePathEndpoint =
    owner.symbol === undefined ? { file: owner.file } : { file: owner.file, symbol: owner.symbol };

  let bestDepth = Number.POSITIVE_INFINITY;
  let nearest: CodeNodeOf<'db-call'>[] = [];
  for (const candidate of candidates) {
    const path = queries.pathBetween(from, candidate.id, {
      direction: 'out',
      ...(Number.isFinite(bestDepth) ? { maxDepth: bestDepth } : {}),
    });
    if (path === undefined) {
      continue;
    }
    if (path.depth < bestDepth) {
      bestDepth = path.depth;
      nearest = [candidate];
    } else if (path.depth === bestDepth) {
      nearest.push(candidate);
    }
  }
  return nearest;
}

/**
 * The location of one database call site: the code queries' own location for
 * the node when the name index yields it, otherwise the node's declared
 * position as a `code-graph` candidate for {@link vet}.
 */
function callSiteCandidate(queries: CodeQueries, node: CodeNodeOf<'db-call'>): LocationCandidate {
  const minted = queries
    .findByName(node.name, {
      kinds: [DB_CALL_NODE_KIND],
      exact: true,
      limit: CODE_QUERY_LIMITS.maxResults,
    })
    .find((match) => match.nodeId === node.id);
  if (minted !== undefined) {
    return minted.location;
  }
  return {
    file: node.file,
    line: node.line,
    column: node.column,
    symbol: node.symbol ?? node.name,
    ...(node.endLine !== undefined && node.endLine > node.line ? { endLine: node.endLine } : {}),
    resolvedBy: 'code-graph' satisfies SourceResolvedBy,
  };
}

/**
 * A `db.query` span, located at the `prisma.*` or `pool.query` call site that
 * issued it.
 *
 * Narrowed before it is chosen: the enclosing function or route handler is
 * found by walking parent spans; the call sites that function issues directly
 * are preferred, then those reachable from it at the shortest path length;
 * among those, the span's driver (`db.client`, or `db.system` when it names a
 * driver) and operation break ties softly. Exactly one site is a hit; several
 * indistinguishable ones are `ambiguous`.
 */
async function resolveQueryCallSite(
  env: ResolverEnv,
  scope: ResolveScope,
  queries: CodeQueries,
  graph: CodeGraph,
  event: ResolvableEvent,
): Promise<Result<RouteStep, DebuggenError>> {
  const owner = await findQueryOwner(env, scope, queries, event);
  if (isErr(owner)) {
    return owner;
  }

  const driver = driverHint(event);
  const operation = stringAttribute(event, ATTRIBUTE.dbOperation)?.toLowerCase();
  const byEvidence = (nodes: readonly CodeNodeOf<'db-call'>[]): readonly CodeNodeOf<'db-call'>[] =>
    prefer(
      prefer(nodes, driver === undefined ? undefined : (node) => node.data.driver === driver),
      operation === undefined
        ? undefined
        : (node) => node.data.operation?.toLowerCase() === operation,
    );

  const all = graph.nodesByKind(DB_CALL_NODE_KIND);
  let pool: readonly CodeNodeOf<'db-call'>[] = all;
  if (owner.value !== undefined) {
    const enclosing = owner.value;
    const direct = all.filter(
      (node) =>
        enclosing.symbol !== undefined &&
        node.file === enclosing.file &&
        node.symbol === enclosing.symbol,
    );
    if (direct.length > 0) {
      pool = direct;
    } else {
      // Structural narrowing first, runtime evidence second — except when the
      // project has more call sites than the reachability budget, where the
      // evidence is applied first to bring the search inside it.
      const searched = all.length > env.limits.maxDbCandidates ? byEvidence(all) : all;
      const reachable = reachableCalls(env, queries, enclosing, searched);
      if (reachable === undefined) {
        return ok(miss('ambiguous'));
      }
      pool = reachable;
    }
  }

  pool = byEvidence(pool);
  if (pool.length === 0) {
    return ok(miss('symbol-not-found'));
  }
  if (pool.length > env.limits.maxDbCandidates) {
    return ok(miss('ambiguous'));
  }
  return ok(
    choose(
      env,
      pool.map((node) => callSiteCandidate(queries, node)),
      'code-graph',
    ),
  );
}

/**
 * Route 3: an item the static code graph can name (confidence 0.85) — a
 * render, state transition or browser error by component display name, a
 * database query by its call site, an unpatched function span by its symbol.
 */
const codeGraphRoute: RouteImpl = async (env, scope, subject) => {
  const steps: RouteStep[] = [];
  const stamped = preStamped(env, subject, 'code-graph');
  if (stamped !== undefined) {
    steps.push(stamped);
    if (stamped.outcome === 'hit') {
      return ok(steps);
    }
  }
  if (subject.type !== 'event') {
    return ok(steps.length > 0 ? steps : [SKIPPED]);
  }

  const event = subject.event;
  const component = COMPONENT_KINDS.includes(event.kind)
    ? stringAttribute(event, ATTRIBUTE.component)
    : undefined;
  const isQuery = QUERY_KINDS.includes(event.kind);
  const isFunction = event.kind === KIND.function;
  if (component === undefined && !isQuery && !isFunction) {
    return ok(steps.length > 0 ? steps : [SKIPPED]);
  }

  const queries = env.queries;
  if (queries === undefined) {
    steps.push(miss('index-unavailable'));
    return ok(steps);
  }

  if (component !== undefined) {
    steps.push(resolveComponentName(env, queries, component, 'code-graph'));
  } else if (isQuery) {
    if (env.graph === undefined) {
      steps.push(miss('index-unavailable'));
    } else {
      const step = await resolveQueryCallSite(env, scope, queries, env.graph, event);
      if (isErr(step)) {
        return step;
      }
      steps.push(step.value);
    }
  } else {
    steps.push(resolveFunctionSymbol(env, queries, event));
  }
  return ok(steps);
};

/* -------------------------------------------------------------------------------------------------
 * Route 4 — source-map
 * ---------------------------------------------------------------------------------------------- */

/**
 * The captured stack an event carries for the source-map route, and whether
 * the route applies at all: a request span's initiator stack, or a browser
 * error's stack.
 */
function stackOf(event: ResolvableEvent): { readonly applies: boolean; readonly stack?: string } {
  if (INITIATOR_KINDS.includes(event.kind)) {
    const stack = stringAttribute(event, ATTRIBUTE.initiator);
    return stack === undefined ? { applies: true } : { applies: true, stack };
  }
  if (ERROR_STACK_KINDS.includes(event.kind) && event.tier === BROWSER_TIER) {
    const stack = stringAttribute(event, ATTRIBUTE.errorStack);
    return stack === undefined ? { applies: true } : { applies: true, stack };
  }
  return { applies: false };
}

/**
 * Route 4: a browser item whose call site is known only as a stack of
 * generated-chunk frames (confidence 0.75).
 *
 * Entirely delegated to `resolveStack`: it fetches maps only from the
 * session's loopback dev-server origin, discards dependency and bundler
 * frames, normalises bundler source paths and never throws. The first
 * returned location that passes {@link vet} — the nearest application frame —
 * is the answer. Without a dev-server origin nothing is fetched at all.
 */
const sourceMapRoute: RouteImpl = async (env, scope, subject) => {
  const steps: RouteStep[] = [];
  const stamped = preStamped(env, subject, 'source-map');
  if (stamped !== undefined) {
    steps.push(stamped);
    if (stamped.outcome === 'hit') {
      return ok(steps);
    }
  }
  if (subject.type !== 'event') {
    return ok(steps.length > 0 ? steps : [SKIPPED]);
  }

  const captured = stackOf(subject.event);
  if (!captured.applies) {
    return ok(steps.length > 0 ? steps : [SKIPPED]);
  }
  if (captured.stack === undefined) {
    steps.push(miss('no-initiator-stack'));
    return ok(steps);
  }
  if (env.devServerOrigin === undefined) {
    steps.push(miss('dev-server-unknown'));
    return ok(steps);
  }

  const stack = captured.stack;
  const signal = combinedSignal(scope.signals);
  const located = await fromPromise(
    Promise.resolve().then(() =>
      env.resolveStack(stack, {
        projectRoot: env.projectRoot,
        devServerOrigin: env.devServerOrigin,
        cache: scope.sourceMapCache,
        fetchImpl: env.fetchImpl,
        maxFrames: env.limits.maxStackFrames,
        maxMaps: env.limits.maxSourceMaps,
        signal,
        logger: env.logger,
      }),
    ),
    'INTERNAL',
  );
  if (isErr(located)) {
    return located;
  }

  for (const location of located.value.slice(0, env.limits.maxStackFrames)) {
    const step = stepFor(vet(env, location, 'source-map'));
    steps.push(step);
    if (step.outcome === 'hit') {
      return ok(steps);
    }
  }
  if (located.value.length === 0) {
    steps.push(miss('unmapped-frame'));
  }
  return ok(steps);
};

/* -------------------------------------------------------------------------------------------------
 * Route 5 — react-owner
 * ---------------------------------------------------------------------------------------------- */

/** The component chain a subject carries, nearest first, bounded. */
function chainOf(subject: Subject, limit: number): string[] {
  if (subject.type === 'target') {
    return subject.target.componentChain
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .slice(0, limit);
  }
  const fromInteraction = stringListAttribute(subject.event, ATTRIBUTE.componentChain, limit);
  return fromInteraction.length > 0
    ? fromInteraction
    : stringListAttribute(subject.event, ATTRIBUTE.ownerChain, limit);
}

/**
 * Route 5: a selected element, or an event carrying a component or owner
 * chain, located at the nearest component in the chain the code graph
 * declares exactly once (confidence 0.6).
 *
 * The chain is walked nearest-first; a name several declarations answer is
 * passed over (and the ambiguity remembered) rather than guessed, and the
 * walk continues outward. The location is re-stamped `react-owner` before it
 * is vetted, so it never inherits the code-graph confidence.
 */
const reactOwnerRoute: RouteImpl = (env, _scope, subject) => {
  const steps: RouteStep[] = [];
  const stamped = preStamped(env, subject, OWNER_ROUTE);
  if (stamped !== undefined) {
    steps.push(stamped);
    if (stamped.outcome === 'hit') {
      return Promise.resolve(ok(steps));
    }
  }

  const chain = chainOf(subject, env.limits.maxChainNames);
  if (chain.length === 0) {
    return Promise.resolve(ok(steps.length > 0 ? steps : [SKIPPED]));
  }
  const queries = env.queries;
  if (queries === undefined) {
    steps.push(miss('index-unavailable'));
    return Promise.resolve(ok(steps));
  }

  let sawAmbiguity = false;
  let refusal: SourceResolutionMissReason | undefined;
  for (const name of chain) {
    const step = resolveComponentName(env, queries, name, OWNER_ROUTE);
    if (step.outcome === 'hit') {
      steps.push(step);
      return Promise.resolve(ok(steps));
    }
    if (step.outcome === 'miss' && step.reason === 'ambiguous') {
      sawAmbiguity = true;
    } else if (step.outcome === 'rejected') {
      refusal ??= step.reason;
    }
  }
  if (sawAmbiguity) {
    steps.push(miss('ambiguous'));
  } else {
    steps.push(refusal === undefined ? miss('symbol-not-found') : rejected(refusal));
  }
  return Promise.resolve(ok(steps));
};

/* -------------------------------------------------------------------------------------------------
 * The route table and the driver loop
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every route's implementation, keyed by its stamp. A `Record` over
 * `SourceResolvedBy`, so adding a resolver to the shared enumeration stops
 * this module compiling until it has an implementation here.
 */
const ROUTES: Readonly<Record<SourceResolvedBy, RouteImpl>> = Object.freeze({
  patch: patchRoute,
  'route-map': routeMapRoute,
  'code-graph': codeGraphRoute,
  'source-map': sourceMapRoute,
  'react-owner': reactOwnerRoute,
});

/** Runs one route, converting a thrown bug into an `Err` rather than letting it escape. */
async function runRoute(
  env: ResolverEnv,
  scope: ResolveScope,
  subject: Subject,
  route: SourceResolvedBy,
): Promise<Result<readonly RouteStep[], DebuggenError>> {
  const settled = await fromPromise(
    Promise.resolve().then(() => ROUTES[route](env, scope, subject)),
    'INTERNAL',
  );
  if (isErr(settled)) {
    return err(
      new DebuggenError('INTERNAL', `The ${route} source resolution route failed unexpectedly.`, {
        hint: 'The item was left without a source location; the service log has the cause.',
        details: { route },
        cause: settled.error,
      }),
    );
  }
  return settled.value;
}

/** The attempt a route step is recorded as. */
function attemptOf(route: SourceResolvedBy, step: RouteStep): SourceResolutionAttempt {
  return step.outcome === 'hit'
    ? { route, outcome: 'hit' }
    : { route, outcome: step.outcome, reason: step.reason };
}

/**
 * Resolves one subject: every route in {@link SOURCE_ROUTE_ORDER}, short-
 * circuiting on the first hit, with the cancelling signals checked before
 * each route.
 */
async function resolveSubject(
  env: ResolverEnv,
  scope: ResolveScope,
  subject: Subject,
): Promise<Result<SourceResolution, DebuggenError>> {
  const attempted: SourceResolutionAttempt[] = [];

  for (const route of SOURCE_ROUTE_ORDER) {
    if (isAborted(scope.signals)) {
      return err(abortedError());
    }
    const steps = await runRoute(env, scope, subject, route);
    if (isErr(steps)) {
      return steps;
    }
    for (const step of steps.value) {
      attempted.push(attemptOf(route, step));
      if (step.outcome === 'hit') {
        return ok({
          status: 'resolved',
          location: step.location,
          route,
          attempted: Object.freeze(attempted),
        });
      }
    }
  }

  return ok({
    status: 'unresolved',
    reason: explainMiss(attempted),
    attempted: Object.freeze(attempted),
  });
}

/** The ids-and-reasons-only log fields of one resolution. */
function resolutionFields(subject: Subject, resolution: SourceResolution): Record<string, unknown> {
  const about =
    subject.type === 'event'
      ? { eventId: subject.event.id, kind: subject.event.kind }
      : { target: 'selected-element', chainLength: subject.target.componentChain.length };
  return resolution.status === 'resolved'
    ? {
        ...about,
        status: resolution.status,
        route: resolution.route,
        attempts: resolution.attempted.length,
      }
    : {
        ...about,
        status: resolution.status,
        reason: resolution.reason,
        attempts: resolution.attempted.length,
      };
}

/* -------------------------------------------------------------------------------------------------
 * The factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the source resolver for one project and one code-index generation.
 *
 * Wired by `src/main.ts` once the session's project is known (and re-created
 * when its index is rebuilt); consumed by `src/telemetry/{ingest,attribute}.ts`,
 * `src/panels/data.ts`, `src/analysis/facts.ts` and `src/pipeline/**`.
 * Construction does no work and opens nothing: every handle is injected, and
 * the resolver only reads through them.
 *
 * @param deps The project root, the code-analysis handles, the store ports and
 * the injection seams; see {@link SourceResolverDeps}.
 * @returns The resolver. Its methods answer `Err` only for a genuine fault —
 * a project root that is not absolute, a malformed input, a cancelled call, a
 * failed store port — and `Ok` with `status: 'unresolved'` for an item no route
 * can vouch for.
 *
 * @example
 * ```ts
 * const resolver = createSourceResolver({
 *   projectRoot: session.projectRoot,
 *   queries,
 *   routeMap,
 *   graph,
 *   modifications: modificationsRepo,
 *   events: telemetryRepo,
 *   devServerOrigin: session.devServerUrl,
 *   logger,
 * });
 * const resolution = await resolver.resolveEvent(event);
 * if (resolution.ok && resolution.value.status === 'resolved') {
 *   decorated = { ...event, source: resolution.value.location };
 * }
 * ```
 */
export function createSourceResolver(deps: SourceResolverDeps): SourceResolver {
  const env: ResolverEnv = Object.freeze({
    projectRoot: deps.projectRoot,
    queries: deps.queries,
    routeMap: deps.routeMap,
    graph: deps.graph,
    modifications: deps.modifications,
    events: deps.events,
    fetchImpl: deps.fetchImpl,
    resolveStack: deps.resolveStackImpl ?? resolveStack,
    devServerOrigin: deps.devServerOrigin,
    logger: subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM),
    limits: mergeLimits(deps.limits),
  });

  const rootIsAbsolute =
    typeof deps.projectRoot === 'string' &&
    (isAbsolutePosix(toPosix(deps.projectRoot)) || isWindowsAbsolute(deps.projectRoot));

  const rootError = (): DebuggenError =>
    new DebuggenError(
      'PROJECT_NOT_FOUND',
      'The source resolver was created without an absolute project root, so no location can be contained.',
      { hint: 'Create the resolver with the session record’s absolute projectRoot.' },
    );

  const newScope = (
    options: SourceResolveOptions | undefined,
    batchEvents: ReadonlyMap<string, ResolvableEvent>,
  ): ResolveScope => ({
    sourceMapCache: deps.sourceMapCache ?? createSourceMapCache(),
    modificationsBySession: new Map(),
    batchEvents,
    parentCache: new Map(),
    signals: signalsFor(deps, options),
  });

  const noBatch: ReadonlyMap<string, ResolvableEvent> = new Map();

  async function resolveEvent(
    event: ResolvableEvent,
    options?: SourceResolveOptions,
  ): Promise<Result<SourceResolution, DebuggenError>> {
    if (!rootIsAbsolute) {
      return err(rootError());
    }
    const parsed = parseResolvableEvent(event);
    if (isErr(parsed)) {
      return parsed;
    }
    const subject: Subject = { type: 'event', event: parsed.value };
    const resolution = await resolveSubject(env, newScope(options, noBatch), subject);
    if (resolution.ok) {
      env.logger.trace('source resolution finished', resolutionFields(subject, resolution.value));
    }
    return resolution;
  }

  async function resolveTarget(
    target: SelectedTarget,
    options?: SourceResolveOptions,
  ): Promise<Result<SourceResolution, DebuggenError>> {
    if (!rootIsAbsolute) {
      return err(rootError());
    }
    const parsed = parseSelectedTarget(target);
    if (isErr(parsed)) {
      return parsed;
    }
    const subject: Subject = { type: 'target', target: parsed.value };
    const resolution = await resolveSubject(env, newScope(options, noBatch), subject);
    if (resolution.ok) {
      env.logger.debug('source resolution finished', resolutionFields(subject, resolution.value));
    }
    return resolution;
  }

  async function resolveEvents(
    events: readonly ResolvableEvent[],
    options?: SourceResolveOptions,
  ): Promise<Result<ReadonlyMap<string, SourceLocation>, DebuggenError>> {
    if (!rootIsAbsolute) {
      return err(rootError());
    }

    const considered = events.slice(0, env.limits.maxBatchEvents);
    const valid: ResolvableEvent[] = [];
    let invalid = 0;
    for (const event of considered) {
      const parsed = parseResolvableEvent(event);
      if (parsed.ok) {
        valid.push(parsed.value);
      } else {
        invalid += 1;
      }
    }

    const batchEvents = new Map<string, ResolvableEvent>();
    for (const event of valid) {
      const key = spanKey(event.sessionId, event.spanId);
      if (!batchEvents.has(key)) {
        batchEvents.set(key, event);
      }
    }

    const scope = newScope(options, batchEvents);
    const located = new Map<string, SourceLocation>();
    let unresolved = 0;
    for (const event of valid) {
      if (located.has(event.id)) {
        continue;
      }
      const resolution = await resolveSubject(env, scope, { type: 'event', event });
      if (isErr(resolution)) {
        return resolution;
      }
      if (resolution.value.status === 'resolved') {
        located.set(event.id, resolution.value.location);
      } else {
        unresolved += 1;
      }
    }

    env.logger.debug('source resolution batch finished', {
      events: events.length,
      considered: considered.length,
      invalid,
      resolved: located.size,
      unresolved,
    });
    return ok(located);
  }

  return Object.freeze({ resolveEvent, resolveTarget, resolveEvents });
}
