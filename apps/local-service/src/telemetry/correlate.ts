/**
 * Service-side trace correlation: the cache and the loader around the pure
 * correlator.
 *
 * `@debuggen/telemetry`'s `correlateTrace` is a pure function over a flat list
 * of persisted events (AAP 0.4.2). This module is the half of the correlation
 * path that the *service* owns: it decides **which** events that function is
 * handed, **when** a tree is rebuilt, and **where** the result is kept between
 * the moment a batch is persisted and the moment the DevTools panel asks for it
 * with `POST /sessions/:id/panel-data { source: 'trace', filter: { traceId } }`
 * (AAP 0.8.1, slice 7). Nothing about the tree itself is decided here.
 *
 * ## Rebuild per touched trace, never patch in place
 *
 * Every event of a trace arrives from one of two independent producers — the
 * MAIN-world browser agent and the dev-server Node preload — over two different
 * transports, in batches whose interleaving nobody controls. A page reload
 * replays an agent buffer; a server span can land before the `fetch` span that
 * caused it; a parent can arrive after its children.
 *
 * So {@link TraceCorrelator.onEventsPersisted} does not merge a batch into a
 * cached tree. For each `(sessionId, traceId)` pair the batch mentions it loads
 * the trace's **complete** persisted event set and correlates that from
 * scratch. The reason is that rebuilding is idempotent and permutation
 * invariant — `correlateTrace`'s own guarantee — so out-of-order arrival, a
 * replayed buffer and a late parent all converge on exactly the same tree,
 * whereas an in-place patch would have to re-parent, re-sort and re-count a
 * subtree and would leave a tree that depends on arrival order. The cost is one
 * indexed read and one `O(n log n)` pass per touched trace per batch, over the
 * handful of traces one interaction produces; the alternative is a structure
 * that two clients can disagree about.
 *
 * A tree is therefore **never** built from a batch alone. A batch names traces;
 * the store supplies their events.
 *
 * ## Ordering is delegated, in full
 *
 * This file contains no comparator, and must not grow one. The canonical order
 * is parent before child (structural, from the tree shape), then `startTime`,
 * then `(producerId, seq)`, then `ingestSeq` — the store-assigned, always
 * distinct final tie-break, which is what makes the order *total* when the two
 * producers' clocks land in the same millisecond (AAP 0.2.3). Two halves
 * implement it and neither is reimplemented here: the store's
 * `CANONICAL_ORDER_BY` orders the rows this module reads, and `correlateTrace`
 * applies parent-before-child and orders siblings with
 * `compareEventsCanonical`. Correlation is permutation invariant, so the load
 * order is not what makes the *tree* deterministic — but it is what makes
 * **paging** safe, which is why every page below is read in that order.
 *
 * ## Pass-through fidelity
 *
 * What the correlator produces is what callers get, unaltered:
 *
 * - **Orphans are preserved.** An event whose parent never arrived is attached
 *   to the trace root with `orphaned`, `orphanReason` and
 *   `missingParentSpanId` set. This module never filters a node out, never
 *   clears a flag and never re-parents anything; the invariant it checks
 *   instead is `tree.nodeCount === rows.length`, which is the mechanical proof
 *   that nothing was dropped — a missing span would silently remove all the
 *   work underneath it from every duration in the capture (AAP 0.4.2) — and a
 *   tree that fails it is refused, never returned or cached.
 * - **Lineage is untouched.** The `lineage`, `lineageAmbiguous` and
 *   `lineageCandidates` attributes are written by the browser agent's
 *   continuation tracker and read only by `lineageOf` inside the correlator.
 *   Nothing here writes, deletes or second-guesses them: `Timeline` draws a
 *   dashed edge from an ambiguous attribution, and a guess dressed up as a
 *   certainty is the one thing that display exists to prevent.
 *
 * ## The cache, and what `captureId` scopes
 *
 * A bounded, insertion-ordered `Map` holds the last tree built for each
 * `(sessionId, scope, traceId)` triple, so the panel's repeated reads of one
 * interaction cost nothing after the capture that produced it. Recency is by
 * last **write**, not by read (see {@link TRACE_CACHE_LIMIT}).
 *
 * The scope is the `captureId` a read named, or the whole session when it named
 * none. When given, `captureId` narrows **both** the enumeration of trace ids
 * ({@link TraceCorrelator.listTraceIds}, {@link TraceCorrelator.getTraces}) and
 * the events loaded for each trace ({@link TraceCorrelator.getTrace}), and it is
 * part of the cache key, so the capture-scoped tree and the session-wide tree of
 * one trace id are two entries that never stand in for each other. That is
 * required rather than tidy: a trace id is minted by a producer and is not
 * guaranteed unique across the captures of a session, so a capture-narrowed
 * read that loaded its traces session-wide would mix another capture's events
 * into the interaction it was asked about. Narrowing loses nothing of the join
 * the correlator exists for — a trace is precisely the join between the browser
 * agent's spans and the preload's spans (AAP 0.4.2) — because attribution
 * stamps both producers' spans with the session's **active** capture, and a
 * capture survives a page reload with its `captureId` intact (AAP 0.5.5): a
 * capture-scoped tree is the complete interaction as that capture recorded it.
 * Omitting `captureId` gives the session-wide join, over every capture.
 *
 * {@link TraceCorrelator.onEventsPersisted} rebuilds the session-wide tree of
 * every trace a batch touches and drops that trace's capture-scoped trees for
 * exactly the captures the batch named, which the next capture-scoped read
 * rebuilds. The trees of the captures the batch did not name stay cached: their
 * event sets did not change.
 *
 * ## Failure, privacy and what this module is not
 *
 * Every operation returns `Result<T, DebuggenError>` and **nothing throws** — a
 * store failure, and even a throw from a supplied test double, arrives as an
 * `Err` carrying a code from the closed vocabulary. An unknown `traceId` is
 * `ok(undefined)` rather than an error: a trace purged by retention, or one
 * whose events have not arrived yet, is an ordinary outcome. A trace whose
 * rows cannot all be read or correlated — larger than one correlation reads,
 * served by a store whose paging does not advance, holding stored rows this
 * build cannot reconstruct, or yielding a tree with fewer nodes than the rows
 * it was built from — is an error and never a partial tree, and no tree is
 * cached for it: a partial tree would pass for the whole interaction on every
 * later read. Logging goes
 * through the injected `Logger` and carries **counts and identifiers only** —
 * never an event name, an attribute value, a SQL statement or a URL (AAP
 * 0.5.2) — and no caught value is ever echoed into a log record or an error
 * payload.
 *
 * It computes trees and nothing else. Metrics belong to `@debuggen/telemetry`'s
 * `aggregate/*`, facts to `../analysis/`, and the assembly of a `DataResult` to
 * `../panels/data.ts` — which calls `correlateTrace` directly for its `trace`
 * source and deliberately does not depend on this cache, so the two paths
 * return the same upstream {@link TraceTree} shape and can never disagree.
 *
 * @example
 * ```ts
 * const correlator = createTraceCorrelator({ telemetry, logger });
 * const stored = telemetry.insertMany(attributed); // ingestSeq assigned here
 * if (isOk(stored)) {
 *   await correlator.onEventsPersisted(stored.value.events);
 * }
 * const trace = await correlator.getTrace(sessionId, traceId); // every capture
 * const window = await correlator.getTraces(sessionId, captureId); // that capture's events only
 * ```
 */

import { DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, Logger, Result, SessionId, TraceId } from '@debuggen/shared';
import { DEFAULT_MAX_DEPTH, correlateTrace } from '@debuggen/telemetry';
import type { TelemetryEvent, TraceTree } from '@debuggen/telemetry';

import { LOG_BINDING_KEYS } from '../logging.js';
import { TELEMETRY_QUERY_MAX_LIMIT } from '../store/telemetry-repo.js';
import type { TelemetryPage, TelemetryReadOptions } from '../store/telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this module carries.
 *
 * One of the four standardised binding names of `../logging.ts`, so a whole
 * session's correlation activity is greppable by one field.
 */
const SUBSYSTEM = 'telemetry.correlate';

/**
 * The default depth guard passed to `correlateTrace`: `1024`.
 *
 * Initialised from the correlator's own `DEFAULT_MAX_DEPTH` rather than
 * restated as a literal, so the service cannot drift from the bound the tree
 * builder documents. A real correlated trace is a handful of levels deep
 * (interaction → fetch → server → route handler → function → query); a chain
 * longer than this means malformed parentage, and the correlator lifts the
 * offending node to the trace root and flags it rather than dropping it.
 *
 * Override it per correlator with {@link TraceCorrelatorDeps.maxDepth}.
 */
export const CORRELATOR_MAX_DEPTH: number = DEFAULT_MAX_DEPTH;

/**
 * How many correlated traces one correlator keeps in memory: `256`.
 *
 * The bound is generous on purpose and still small: a cached entry is one
 * {@link TraceTree} whose nodes *reference* the event objects the store already
 * reconstructed, so an entry costs a few hundred small objects rather than a
 * copy of the capture, and one interaction produces one trace — a long session
 * across several captures rarely reaches three figures. 256 therefore holds
 * every trace a developer is likely to revisit while keeping the ceiling
 * bounded and predictable.
 *
 * Eviction is oldest-**write**-first: a rebuild re-inserts its key, so the
 * victim is always the least recently *built* trace. A cache hit deliberately
 * does not reorder the map — read recency would make eviction depend on which
 * panel node happened to query, and the eviction order is a property callers
 * reason about (and {@link CorrelatorStats} exposes).
 *
 * Override it per correlator with {@link TraceCorrelatorDeps.cacheLimit}; `0`
 * is legal and disables caching entirely.
 */
export const TRACE_CACHE_LIMIT = 256;

/**
 * How many rows one page of a trace load asks for: the store's ceiling.
 *
 * Reading at the maximum makes the common trace — tens to a few hundred
 * events — a single statement, and the store clamps rather than refuses, so
 * this can never become an invalid request. Taken from the repository's own
 * bound instead of a literal so the two cannot drift.
 */
const TRACE_PAGE_SIZE = TELEMETRY_QUERY_MAX_LIMIT;

/**
 * How many pages one trace load will read before it stops: `20`.
 *
 * At {@link TRACE_PAGE_SIZE} that is {@link MAX_TRACE_EVENTS} — 100 000 events
 * in a single trace, orders of magnitude beyond any real interaction. The bound
 * exists to make the paging loop provably finite even if a supplied repository
 * answers with a `nextOffset` that never reaches the end.
 *
 * Reaching it with pages still unread is a **failure**, not a truncation: the
 * load is reported at `warn` with counts and answers `STORE_ERROR` with reason
 * `trace-too-large`, and nothing is correlated or cached. A tree built from the
 * first 100 000 rows would omit whatever the unread pages held — a late server
 * span, the query under it, the parent of an orphan — and would be
 * indistinguishable from the whole interaction to every duration derived from
 * it.
 */
const MAX_TRACE_PAGES = 20;

/**
 * The most events one trace load will correlate: {@link MAX_TRACE_PAGES}
 * pages of {@link TRACE_PAGE_SIZE} rows, stated once so the refusal's hint and
 * the bound cannot drift apart.
 */
const MAX_TRACE_EVENTS = MAX_TRACE_PAGES * TRACE_PAGE_SIZE;

/** The operation phrase every trace-load failure reports. */
const TRACE_LOAD_OPERATION = 'reading a trace for correlation';

/** The recovery instruction a store failure carries to the user interface. */
const STORE_FAILURE_HINT =
  'Check the service log and retry; the session and its capture are intact.';

/** The recovery instruction an unexpected correlation failure carries. */
const CORRELATE_FAILURE_HINT =
  'Reload the panel to request the trace again; the captured events are stored and unaffected.';

/**
 * The recovery instruction a refused tree carries when correlation did not keep
 * every loaded event.
 *
 * Not {@link CORRELATE_FAILURE_HINT}: the same rows correlate the same way on
 * every read, so reloading the panel cannot help, and what the user can act on
 * is the report.
 */
const TRACE_NODES_DROPPED_HINT =
  'Report the trace id with the service log; the captured events are stored and unaffected.';

/* -------------------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * A value, or a promise of one.
 *
 * Used only for {@link TelemetryRepoLike}'s return types: the production
 * repository is synchronous, and accepting either form is what lets this
 * module's asynchronous API sit over it without forcing a test double to be
 * synchronous too.
 *
 * @typeParam T The awaited type.
 */
type MaybePromise<T> = T | PromiseLike<T>;

/**
 * The telemetry reads this module performs — the whole of its coupling to the
 * store.
 *
 * A consumer-side structural port, narrowed to the two methods actually called,
 * rather than the full repository interface. Two consequences, both intended: a
 * suite supplies a plain object with two functions instead of an open database,
 * and a method added to the repository cannot silently become a dependency of
 * correlation.
 *
 * Both members mirror the production signatures exactly except for the return
 * type, which additionally accepts a promise (see {@link MaybePromise}), so the
 * real repository satisfies this port by construction.
 *
 * @see The production implementation this port narrows is `TelemetryRepo` in
 * `../store/telemetry-repo.ts`, whose `CANONICAL_ORDER_BY` supplies the
 * store-side half of the canonical order. It is named here rather than imported
 * for a `{@link}`: a type imported solely for a documentation reference is an
 * unused import under this repository's lint gate, and the only other value
 * this module takes from that module — `TELEMETRY_QUERY_MAX_LIMIT` — is
 * imported because it is used.
 */
export interface TelemetryRepoLike {
  /**
   * One page of the events of a single correlated interaction.
   *
   * @param sessionId The session that owns the evidence.
   * @param traceId The correlation id shared by every event of the interaction.
   * @param options Ordering and paging, and — for a capture-scoped read — the
   * `captureId` that must narrow the trace to that capture's events, with
   * `total` and `nextOffset` computed over them alone. This module reads in
   * canonical order and names a capture only when its caller did.
   * @returns The page, or the store's refusal.
   */
  listByTrace(
    sessionId: SessionId,
    traceId: string,
    options?: TelemetryReadOptions,
  ): MaybePromise<Result<TelemetryPage, DebuggenError>>;

  /**
   * The distinct trace ids of a session, ordered by each trace's earliest
   * event.
   *
   * @param sessionId The session to enumerate.
   * @param captureId Narrow to one capture window; absent means every capture.
   * @returns The ids, or the store's refusal.
   */
  listTraceIds(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): MaybePromise<Result<readonly string[], DebuggenError>>;
}

/**
 * What {@link createTraceCorrelator} is constructed from.
 *
 * Everything the module touches arrives here: there is no module-level state,
 * no clock is read and no logger is chosen for the host process. Each optional
 * member is declared `| undefined` so a caller may forward an optional
 * configuration value straight through (`{ maxDepth: config.maxDepth }`) under
 * this repository's `exactOptionalPropertyTypes`.
 */
export interface TraceCorrelatorDeps {
  /** The telemetry reads correlation performs. */
  readonly telemetry: TelemetryRepoLike;

  /**
   * Where this module's records go. Defaults to `noopLogger`, so a correlator
   * constructed without one is silent rather than broken.
   */
  readonly logger?: Logger | undefined;

  /**
   * The depth guard handed to every correlation. Defaults to
   * {@link CORRELATOR_MAX_DEPTH}; a value that is not a non-negative integer is
   * treated as absent.
   */
  readonly maxDepth?: number | undefined;

  /**
   * How many trees to keep. Defaults to {@link TRACE_CACHE_LIMIT}; `0` disables
   * caching, and a value that is not a non-negative integer is treated as
   * absent.
   */
  readonly cacheLimit?: number | undefined;
}

/**
 * What one {@link TraceCorrelator.onEventsPersisted} call did.
 *
 * The counts are the ingest path's audit trail: `tracesTouched.length` is how
 * many distinct traces the batch mentioned, `rebuilt` how many trees were
 * actually built (a touched trace with no persisted rows contributes to the
 * first and not the second), and `orphanCount` how much parentage had to be
 * repaired across them — a count only, never the affected spans.
 */
export interface CorrelateUpdate {
  /** The trace ids the batch mentioned, in first-seen order. */
  readonly tracesTouched: readonly TraceId[];
  /** How many trees were rebuilt and cached. */
  readonly rebuilt: number;
  /** How many nodes were re-attached, summed over the rebuilt trees. */
  readonly orphanCount: number;
}

/**
 * The cache and build counters of one correlator, for diagnostics and tests.
 *
 * `hits`, `misses` and `rebuilds` are cumulative for the correlator's lifetime
 * and are not reset by {@link TraceCorrelator.invalidate} or
 * {@link TraceCorrelator.close}: they describe what the correlator has done,
 * while `cachedTraces` describes what it currently holds.
 */
export interface CorrelatorStats {
  /**
   * How many trees are cached right now — one per `(session, scope, trace)`, so
   * a trace cached session-wide and for two of its captures counts three times.
   */
  readonly cachedTraces: number;
  /** How many reads were served from the cache. */
  readonly hits: number;
  /** How many reads had to load and build. */
  readonly misses: number;
  /**
   * How many trees have been built, by ingest and by cache misses alike. A
   * tree refused because it did not hold every loaded row is not counted.
   */
  readonly rebuilds: number;
}

/**
 * Incremental trace correlation for one service process.
 *
 * Construct it with {@link createTraceCorrelator}. The ingest path calls
 * {@link TraceCorrelator.onEventsPersisted} as each batch lands; the panel-data
 * and analysis paths read through {@link TraceCorrelator.getTrace},
 * {@link TraceCorrelator.getTraces} and
 * {@link TraceCorrelator.listTraceIds}. No method throws and no method rejects.
 */
export interface TraceCorrelator {
  /**
   * Rebuilds every trace a freshly persisted batch mentions.
   *
   * Call it with the events **returned** by the store's `insertMany`, never
   * with the ingress events: `ingestSeq` is assigned by the store and is the
   * final ordering tie-break, so a batch that has not been through persistence
   * carries no such number to order by.
   *
   * Each touched trace is reloaded in full and correlated from scratch, which
   * makes the call idempotent: running it twice on the same batch, or retrying
   * it after a store failure, converges on the same trees.
   *
   * What is rebuilt is each touched trace's **session-wide** tree. Its
   * capture-scoped trees are dropped for exactly the captures the batch named
   * for it — their event sets changed — and rebuilt by the next capture-scoped
   * read; the trees of captures the batch did not name are left cached.
   *
   * @param events The batch as the store now holds it, in any order. An empty
   * batch is a successful no-op that touches neither the store nor the cache.
   * @returns What was rebuilt, or the first failure encountered — in which case
   * the traces already rebuilt keep their fresh trees, the failing trace and
   * every touched trace after it lose the trees cached before the batch
   * (session-wide and for the captures the batch named) so none is served
   * stale, and a retry is safe.
   */
  onEventsPersisted(
    events: readonly TelemetryEvent[],
  ): Promise<Result<CorrelateUpdate, DebuggenError>>;

  /**
   * One correlated trace, from the cache when it is there.
   *
   * @param sessionId The session that owns the evidence.
   * @param traceId The interaction to resolve.
   * @param captureId Narrow the trace to one capture window: only that
   * capture's events are loaded and correlated, and the tree is cached under
   * that capture. Absent means the session-wide join over every capture (see
   * the module notes).
   * @returns The tree, or `ok(undefined)` when the scope holds no event with
   * that trace id — an ordinary outcome for a trace that retention has purged
   * or whose events have not arrived yet, and therefore not an error. A trace
   * whose rows cannot all be read or correlated is an `Err` instead of a
   * partial tree, and nothing is cached for it (see the module notes).
   */
  getTrace(
    sessionId: SessionId,
    traceId: TraceId,
    captureId?: CaptureId,
  ): Promise<Result<TraceTree | undefined, DebuggenError>>;

  /**
   * Every correlated trace of a session, or of one capture window.
   *
   * @param sessionId The session to read.
   * @param captureId Narrow to one capture: both the enumeration of trace ids
   * and the events loaded for each trace, so every tree is built from that
   * capture's events alone even when a trace id recurs in another capture.
   * Absent means every trace of the session, each joined across every capture.
   * @returns The trees, in the store's trace order (earliest event first), or
   * the failure of the first trace that could not be read or correlated: a set
   * missing one of its traces is not the capture.
   */
  getTraces(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Promise<Result<readonly TraceTree[], DebuggenError>>;

  /**
   * The distinct trace ids of a session, or of one capture window.
   *
   * A pass-through read: it consults neither the cache nor the correlator, so
   * it is the cheapest way to ask what a capture contains.
   *
   * @param sessionId The session to enumerate.
   * @param captureId Narrow to one capture window.
   * @returns The ids, ordered by each trace's earliest event.
   */
  listTraceIds(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Promise<Result<readonly TraceId[], DebuggenError>>;

  /**
   * Drops cached trees so the next read rebuilds from the store.
   *
   * Every scope is dropped: the session-wide tree and each capture-scoped tree
   * alike.
   *
   * @param sessionId The session whose entries to drop.
   * @param traceId One trace, under every scope it is cached in, or every
   * trace of the session when absent — what a retention purge or a session end
   * calls.
   */
  invalidate(sessionId: SessionId, traceId?: TraceId): void;

  /** The cache and build counters; see {@link CorrelatorStats}. */
  stats(): CorrelatorStats;

  /**
   * Releases the cache.
   *
   * The correlator owns no connection, timer or listener, so this is idempotent
   * and leaves the instance usable: a read arriving after a shutdown has begun
   * still answers from the store rather than failing, and repopulates the cache
   * it needs. The counters are left alone.
   */
  close(): void;
}

/* -------------------------------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * One `(sessionId, traceId)` pair a persisted batch mentioned, with the
 * session-wide cache key and the captures the batch named for it.
 */
interface TouchedTrace {
  /** The session that owns the trace. */
  readonly sessionId: SessionId;
  /** The trace to rebuild. */
  readonly traceId: TraceId;
  /** The session-wide cache key for the pair, computed once. */
  readonly key: string;
  /**
   * The distinct captures the batch named for the pair, in first-seen order:
   * the capture-scoped trees of the trace whose event sets the batch changed.
   */
  readonly captureIds: ReadonlySet<CaptureId>;
}

/**
 * One cached tree, with the scope it was built for.
 *
 * The scope travels with the tree rather than being parsed back out of the key,
 * so deciding which entries belong to a session or to a trace is a comparison
 * of the fields below and never depends on what characters an identifier
 * contains.
 */
interface CachedTrace {
  /** The session that owns the evidence. */
  readonly sessionId: SessionId;
  /** The capture the tree is narrowed to; `undefined` for the session-wide tree. */
  readonly captureId: CaptureId | undefined;
  /** The trace the tree correlates. */
  readonly traceId: TraceId;
  /** The tree itself, exactly as the correlator built it. */
  readonly tree: TraceTree;
}

/** What one batch scan found. */
interface TouchedBatch {
  /** The distinct pairs, in first-seen order. */
  readonly traces: readonly TouchedTrace[];
  /** How many events carried no usable session or trace id and were skipped. */
  readonly ignored: number;
}

/**
 * Whether a value can key a cache entry and scope a store read.
 *
 * Declared over `unknown` rather than `string` on purpose: these ids arrive
 * from another process's batch by way of the store, and a guard that would
 * itself throw on a malformed value defeats the point of having one. It tests
 * shape only — an id's *format* is the schema's business, and re-validating it
 * here would be a second interpretation of the same rule.
 *
 * @param value The candidate identifier.
 * @returns `true` for a non-empty string.
 */
function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The cache key of one `(session, scope, trace)` triple.
 *
 * The key is the JSON text of the triple, with `null` standing for the
 * session-wide scope. JSON quoting makes the key injective over any three
 * strings — no character inside one part can move the boundary to the next,
 * which a separator would only promise for identifiers that happen not to
 * contain it — and `null` is not a string, so no capture id, whatever its
 * format, can collide with the session-wide scope. The key is only ever
 * compared for equality: which entries belong to a session or a trace is read
 * off the {@link CachedTrace} itself.
 *
 * @param sessionId The session that owns the evidence.
 * @param traceId The trace.
 * @param captureId The capture the tree is narrowed to, or `undefined` for the
 * session-wide tree.
 * @returns The key.
 */
function cacheKey(
  sessionId: SessionId,
  traceId: TraceId,
  captureId: CaptureId | undefined,
): string {
  return JSON.stringify([sessionId, captureId ?? null, traceId]);
}

/**
 * The identifying fields of a record about one trace read: the standard
 * session binding, the standard capture binding when the read was
 * capture-scoped, and the trace id — identifiers only (AAP 0.5.2).
 *
 * @param sessionId The session that owns the evidence.
 * @param traceId The trace.
 * @param captureId The capture the read was narrowed to, if any.
 * @returns The fields, ready to spread into a log record or error details.
 */
function traceScopeFields(
  sessionId: SessionId,
  traceId: TraceId,
  captureId: CaptureId | undefined,
): Record<string, string> {
  return {
    [LOG_BINDING_KEYS.sessionId]: sessionId,
    ...(captureId !== undefined ? { [LOG_BINDING_KEYS.captureId]: captureId } : {}),
    traceId,
  };
}

/**
 * Resolves an optional numeric bound against its default.
 *
 * @param requested The caller's value, possibly absent or nonsensical.
 * @param fallback The default to apply when it is either.
 * @returns `requested` when it is a non-negative safe integer, else `fallback`.
 */
function resolveBound(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < 0) {
    return fallback;
  }
  return requested;
}

/**
 * Turns a caught value into a reportable error without echoing it.
 *
 * A value that already is a `DebuggenError` is returned as it stands, so a
 * refusal raised by the store keeps its own code and its own curated message.
 * Anything else becomes a fresh error whose message is written here and whose
 * details carry identifiers and counts only; the caught value is attached as
 * `cause`, which `toPayload` does not forward — so it is reachable in a local
 * stack trace and cannot reach a log record, a user interface or the wire.
 *
 * @param thrown The caught value.
 * @param code The code to apply when `thrown` carries none.
 * @param message The complete sentence describing what failed.
 * @param hint The developer's next step.
 * @param details Identifiers and counts only.
 * @returns The error to return inside an `Err`.
 */
function asReportableError(
  thrown: unknown,
  code: 'INTERNAL' | 'STORE_ERROR',
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>>,
): DebuggenError {
  if (DebuggenError.is(thrown)) {
    return thrown;
  }
  return new DebuggenError(code, message, { hint, details, cause: thrown });
}

/**
 * The error for a trace load that could not supply every row of its trace, and
 * therefore must not produce a tree of it.
 *
 * Three loads end that way, and each has its own reason:
 *
 * - `trace-too-large` — {@link MAX_TRACE_PAGES} pages were read and the store
 *   still reports more.
 * - `trace-page-stalled` — the store answered with a `nextOffset` that does not
 *   advance, which only a repository breaking its own paging contract produces.
 * - `trace-rows-unreadable` — the walk reached its end, but the store reported
 *   rows of the trace it could not reconstruct (`TelemetryPage.skipped`): a
 *   database written by another build, or an altered file.
 *
 * All three are `STORE_ERROR` because in each the store cannot hand over the
 * trace's rows in full, and all three are refusals rather than truncations: a
 * tree built from the rows that were read would pass for the whole interaction
 * while omitting the rest, and a cached one would keep doing so on every later
 * read. The unreadable case is refused although a flat panel page is not — the
 * repository still serves the readable rows of such a page, counted in
 * `skipped`, because a list with one row missing is still the rest of the list.
 * A tree is not: one missing row reparents its children to the trace root as
 * orphans and removes its whole subtree's work from every duration derived
 * from it, so correlation cannot proceed on the remainder.
 *
 * @param reason Which load failed.
 * @param details The scope and the counts of the walk — identifiers and
 * numbers only (AAP 0.5.2).
 * @returns The coded error.
 */
function incompleteTraceError(
  reason: 'trace-too-large' | 'trace-page-stalled' | 'trace-rows-unreadable',
  details: Readonly<Record<string, unknown>>,
): DebuggenError {
  const coded = { operation: TRACE_LOAD_OPERATION, ...details, reason };

  switch (reason) {
    case 'trace-too-large':
      return new DebuggenError(
        'STORE_ERROR',
        'A trace holds more events than one correlation reads, so its tree would be incomplete and was not built.',
        {
          hint: `Correlation reads at most ${MAX_TRACE_EVENTS} events of one trace. Reproduce the interaction in a shorter capture and read the trace narrowed to that capture; the captured events are stored and unaffected.`,
          details: coded,
        },
      );

    case 'trace-page-stalled':
      return new DebuggenError(
        'STORE_ERROR',
        'The telemetry store did not advance while paging a trace, so its tree would be incomplete and was not built.',
        {
          hint: 'Retry the read, and report the trace id with the service log if it persists; the captured events are stored and unaffected.',
          details: coded,
        },
      );

    case 'trace-rows-unreadable':
      return new DebuggenError(
        'STORE_ERROR',
        'The telemetry store holds rows of this trace that this build cannot reconstruct, so its tree would be incomplete and was not built.',
        {
          hint: "The unreadable rows were written by another build or altered on disk; the readable events remain available to the panel's event views. Report the trace id with the service log.",
          details: coded,
        },
      );
  }
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the trace correlator one service process uses.
 *
 * Constructing it performs no I/O, opens nothing and reads no clock: the first
 * store access happens inside the first call.
 *
 * @param deps The telemetry reads, the logger and the two bounds; see
 * {@link TraceCorrelatorDeps}.
 * @returns The correlator, whose methods neither throw nor reject.
 */
export function createTraceCorrelator(deps: TraceCorrelatorDeps): TraceCorrelator {
  const repo = deps.telemetry;
  const log = (deps.logger ?? noopLogger).child({ [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM });
  const maxDepth = resolveBound(deps.maxDepth, CORRELATOR_MAX_DEPTH);
  const cacheLimit = resolveBound(deps.cacheLimit, TRACE_CACHE_LIMIT);

  /**
   * The cached trees, in insertion order of their last write.
   *
   * A `Map` preserves that order, which is what makes eviction a single
   * `keys().next()` — no timestamps, no heap, no bookkeeping on the read path.
   */
  const cache = new Map<string, CachedTrace>();

  let hits = 0;
  let misses = 0;
  let rebuilds = 0;

  /**
   * Caches a freshly built tree and evicts down to {@link cacheLimit}.
   *
   * The `delete` before the `set` is load-bearing: re-assigning an existing key
   * in a `Map` leaves it in its original position, so without it a trace that
   * is rebuilt on every batch would keep aging towards eviction while newer,
   * untouched traces stayed.
   */
  function remember(key: string, entry: CachedTrace): void {
    if (cacheLimit === 0) {
      return;
    }

    cache.delete(key);
    cache.set(key, entry);

    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
  }

  /**
   * Drops every cached tree of one session, or of one of its traces, under
   * every scope — session-wide and per capture alike.
   *
   * The keys are snapshotted before the deletions: a `Map` tolerates removal
   * during iteration, but a snapshot makes the intent — "every entry that
   * matched when the call was made" — explicit. The walk is bounded by
   * {@link cacheLimit}, so it costs at most a few hundred comparisons.
   *
   * @param sessionId The session whose entries to drop.
   * @param traceId One trace of it, or every trace when absent.
   * @returns How many entries were dropped.
   */
  function forget(sessionId: SessionId, traceId?: TraceId): number {
    let removed = 0;

    for (const [key, entry] of [...cache.entries()]) {
      const matches =
        entry.sessionId === sessionId && (traceId === undefined || entry.traceId === traceId);

      if (matches && cache.delete(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Drops the capture-scoped trees of one touched trace for exactly the
   * captures the batch named for it: their event sets changed, so the next
   * capture-scoped read has to rebuild them.
   *
   * @param touched The pair, with the captures the batch named.
   * @returns How many entries were dropped.
   */
  function forgetTouchedCaptures(touched: TouchedTrace): number {
    let removed = 0;

    for (const captureId of touched.captureIds) {
      if (cache.delete(cacheKey(touched.sessionId, touched.traceId, captureId))) {
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Drops every entry one touched trace made stale: its session-wide tree and
   * its trees for the captures the batch named.
   *
   * What a failed rebuild leaves behind for a trace it could not refresh. The
   * trees of captures the batch did not name are kept, because their events
   * did not change.
   *
   * @param touched The pair, with the captures the batch named.
   * @returns How many entries were dropped.
   */
  function forgetTouched(touched: TouchedTrace): number {
    const sessionWide = cache.delete(touched.key) ? 1 : 0;

    return sessionWide + forgetTouchedCaptures(touched);
  }

  /**
   * Awaits one store read and converts any throw or rejection into an `Err`.
   *
   * The production repository returns a `Result` and does not throw, so this
   * exists for the two cases that are not it: a supplied double that throws,
   * and a future asynchronous store whose promise rejects. Either way the
   * caller sees a `Result` and this module's "nothing throws" guarantee holds.
   */
  async function readStore<T>(
    operation: string,
    read: () => MaybePromise<Result<T, DebuggenError>>,
  ): Promise<Result<T, DebuggenError>> {
    try {
      return await read();
    } catch (thrown) {
      return err(
        asReportableError(
          thrown,
          'STORE_ERROR',
          `The telemetry store failed while ${operation}.`,
          STORE_FAILURE_HINT,
          { operation },
        ),
      );
    }
  }

  /**
   * Loads every persisted event of one trace, paging until the store says the
   * walk is over.
   *
   * Paging in canonical order is what makes the walk safe — the order is total,
   * so no row is read twice or missed across a page boundary — and it is the
   * only reason order matters here: correlation itself is permutation
   * invariant, so the tree would be identical from any permutation of these
   * rows.
   *
   * The scope is the session, narrowed to one capture when `captureId` is
   * given: the store is then asked for that capture's events of the trace and
   * no other, so a trace id that recurs in another capture of the session
   * contributes nothing to the tree (see the module notes). Absent, the load is
   * the session-wide join over every capture.
   *
   * The load answers with **every** row of that scope or with an error, never
   * with a subset of them. A store whose `nextOffset` does not advance, and a
   * trace that still has pages unread after {@link MAX_TRACE_PAGES}, both end
   * the walk with `STORE_ERROR` (reasons `trace-page-stalled` and
   * `trace-too-large`). So does a walk that reaches its end with rows the
   * store reported as unreadable (reason `trace-rows-unreadable`): no read can
   * ever return those rows, and the tree of the remainder would be missing
   * whatever they were. Each is logged at `warn` with counts, so no caller can
   * correlate or cache a partial trace as if it were the interaction.
   */
  async function loadTraceEvents(
    sessionId: SessionId,
    traceId: TraceId,
    captureId: CaptureId | undefined,
  ): Promise<Result<TelemetryEvent[], DebuggenError>> {
    const rows: TelemetryEvent[] = [];
    const options: TelemetryReadOptions = {
      sort: 'start_asc',
      limit: TRACE_PAGE_SIZE,
      ...(captureId !== undefined ? { captureId } : {}),
    };
    const scope = traceScopeFields(sessionId, traceId, captureId);
    let offset = 0;
    let pages = 0;
    let unreadable = 0;

    for (;;) {
      const page = await readStore(TRACE_LOAD_OPERATION, () =>
        repo.listByTrace(sessionId, traceId, { ...options, offset }),
      );

      if (isErr(page)) {
        log.warn('reading a trace for correlation failed', {
          ...scope,
          code: page.error.code,
          pages,
          rows: rows.length,
        });
        return page;
      }

      pages += 1;
      for (const row of page.value.rows) {
        rows.push(row);
      }
      if (page.value.skipped !== undefined) {
        unreadable += page.value.skipped;
      }

      const nextOffset = page.value.nextOffset;

      // An absent `nextOffset` is the ordinary end of the walk: this page was
      // the last one.
      if (nextOffset === undefined) {
        break;
      }

      // An offset that does not advance cannot be followed — doing so would
      // re-read the same rows forever — and only a repository that does not
      // honour its own paging contract produces one. The rows read so far are
      // not the trace, so the load fails rather than hand them on: a tree built
      // from them would be cached and served as the whole interaction.
      if (nextOffset <= offset) {
        const counts = { pages, rows: rows.length };

        log.warn('a trace page did not advance its offset; the trace was not correlated', {
          ...scope,
          ...counts,
        });
        return err(incompleteTraceError('trace-page-stalled', { ...scope, ...counts }));
      }

      // The page bound, with pages still unread: the same refusal, for the
      // same reason — the unread pages may hold any span of the interaction.
      if (pages >= MAX_TRACE_PAGES) {
        const counts = { pages, rows: rows.length, maxPages: MAX_TRACE_PAGES };

        log.warn('stopped paging a trace at the page bound; the trace was not correlated', {
          ...scope,
          ...counts,
        });
        return err(incompleteTraceError('trace-too-large', { ...scope, ...counts }));
      }

      offset = nextOffset;
    }

    // Every page was read, but the store reported rows of this trace it could
    // not reconstruct; it has already logged them with their arrival numbers.
    // The rows it did return are not the trace: the missing ones may be any
    // parent in it, and correlating without them would reparent their children
    // as orphans and drop their subtrees' work from every duration. So the load
    // fails, and nothing is correlated or cached from the remainder.
    if (unreadable > 0) {
      const counts = { pages, rows: rows.length, unreadable };

      log.warn('stored rows of a trace could not be reconstructed; the trace was not correlated', {
        ...scope,
        ...counts,
      });
      return err(incompleteTraceError('trace-rows-unreadable', { ...scope, ...counts }));
    }

    return ok(rows);
  }

  /**
   * Correlates one trace's rows into a tree.
   *
   * `correlateTrace` is pure and total over schema-valid events, so the
   * `try`/`catch` covers exactly one thing: rows that are not schema-valid,
   * which only a supplied double or a database written by another build can
   * produce. That is an internal invariant failure rather than a store failure,
   * and it is reported as one instead of crashing an ingest batch.
   *
   * A tree that does not hold every loaded row is refused the same way, as
   * `INTERNAL` with reason `trace-nodes-dropped`: it is neither returned nor
   * counted as a rebuild, so no caller can cache it. Only an empty row set is
   * an absent trace.
   */
  function correlate(
    sessionId: SessionId,
    traceId: TraceId,
    captureId: CaptureId | undefined,
    rows: readonly TelemetryEvent[],
  ): Result<TraceTree | undefined, DebuggenError> {
    let tree: TraceTree | undefined;

    try {
      tree = correlateTrace(rows, traceId, { maxDepth });
    } catch (thrown) {
      return err(
        asReportableError(
          thrown,
          'INTERNAL',
          'Correlating a trace failed.',
          CORRELATE_FAILURE_HINT,
          { ...traceScopeFields(sessionId, traceId, captureId), rows: rows.length },
        ),
      );
    }

    // The "nothing is dropped" invariant, checked rather than assumed: the
    // correlator repairs unresolvable parentage by attaching the node to the
    // trace root, so every loaded row must be present at some depth. A
    // shortfall means a loaded row did not become a node — the store answered
    // with a row of another trace, which `correlateTrace` does not consider, or
    // the correlator has a defect. Either way the tree is not the interaction:
    // a missing span removes all the work underneath it from every duration in
    // the capture. So it is refused rather than returned, and the one check
    // also covers rows that produced no tree at all, which would otherwise pass
    // for a trace the store does not hold.
    const nodeCount = tree?.nodeCount ?? 0;

    if (nodeCount !== rows.length) {
      const fields = {
        ...traceScopeFields(sessionId, traceId, captureId),
        nodeCount,
        rows: rows.length,
      };

      log.warn(
        'correlated node count does not match the loaded row count; the tree was not used',
        fields,
      );
      return err(
        new DebuggenError(
          'INTERNAL',
          'The correlated tree of a trace does not hold every loaded event, so it was not used.',
          {
            hint: TRACE_NODES_DROPPED_HINT,
            details: { ...fields, reason: 'trace-nodes-dropped' },
          },
        ),
      );
    }

    if (tree === undefined) {
      return ok(undefined);
    }

    // Counted only here, once the tree has passed the invariant: a refused tree
    // was never built as far as any caller or cache is concerned.
    rebuilds += 1;

    return ok(tree);
  }

  /**
   * Loads and correlates one trace, bypassing the cache on the way in.
   *
   * `captureId` scopes the load exactly as {@link loadTraceEvents} describes;
   * `undefined` rebuilds the session-wide tree.
   */
  async function rebuild(
    sessionId: SessionId,
    traceId: TraceId,
    captureId: CaptureId | undefined,
  ): Promise<Result<TraceTree | undefined, DebuggenError>> {
    const loaded = await loadTraceEvents(sessionId, traceId, captureId);
    if (isErr(loaded)) {
      return loaded;
    }
    return correlate(sessionId, traceId, captureId, loaded.value);
  }

  /**
   * Collects the distinct `(sessionId, traceId)` pairs a batch mentions, each
   * with the distinct captures the batch named for it.
   *
   * First-seen order, so the rebuild order — and therefore
   * {@link CorrelateUpdate.tracesTouched} — is a function of the batch rather
   * than of a hash iteration. An event whose session or trace id is unusable is
   * counted and skipped: nothing here re-validates a persisted event, and
   * keying a cache entry on an empty string is the one thing that would corrupt
   * the cache. An unusable capture id alone does not skip the event — the pair
   * is still rebuilt session-wide — it only names no capture-scoped entry,
   * because no read could have cached one under it.
   */
  function collectTouched(events: readonly TelemetryEvent[]): TouchedBatch {
    const traces = new Map<string, TouchedTrace & { readonly captureIds: Set<CaptureId> }>();
    let ignored = 0;

    for (const event of events) {
      const { sessionId, traceId, captureId } = event;

      if (!isUsableId(sessionId) || !isUsableId(traceId)) {
        ignored += 1;
        continue;
      }

      const key = cacheKey(sessionId, traceId, undefined);
      let touched = traces.get(key);

      if (touched === undefined) {
        touched = { sessionId, traceId, key, captureIds: new Set<CaptureId>() };
        traces.set(key, touched);
      }

      if (isUsableId(captureId)) {
        touched.captureIds.add(captureId);
      }
    }

    return { traces: [...traces.values()], ignored };
  }

  async function onEventsPersisted(
    events: readonly TelemetryEvent[],
  ): Promise<Result<CorrelateUpdate, DebuggenError>> {
    const batch = collectTouched(events);
    const tracesTouched: TraceId[] = [];
    let rebuilt = 0;
    let orphanCount = 0;
    let absent = 0;
    let dropped = 0;

    // Sequential by design. The production store is synchronous, so there is
    // no latency to hide, and rebuilding several traces at once would hold
    // several full event sets in memory during a capture that is already
    // producing them as fast as the page can.
    for (const [position, touched] of batch.traces.entries()) {
      const built = await rebuild(touched.sessionId, touched.traceId, undefined);

      if (isErr(built)) {
        // Fail fast, and safely. The traces rebuilt before this point are
        // cached with fresh trees. This trace and every touched trace after it
        // lose the trees cached before the batch: those predate events the
        // store now holds, and serving one would present a stale interaction
        // as current. A rebuild reloads the whole trace, so retrying the same
        // batch converges on the same result.
        const pending = batch.traces.slice(position);
        let staleDropped = 0;

        for (const stale of pending) {
          staleDropped += forgetTouched(stale);
        }

        log.debug('dropped the cached trees a failed rebuild left stale', {
          batchSize: events.length,
          rebuilt,
          pending: pending.length,
          dropped: staleDropped,
          code: built.error.code,
          cachedTraces: cache.size,
        });
        return built;
      }

      tracesTouched.push(touched.traceId);

      if (built.value === undefined) {
        // The batch named a trace the store holds no rows for — retention
        // purged it, or the rows were deleted between the insert and this
        // call. No capture of the session holds any either, so every scope of
        // the trace is dropped rather than served when it no longer reflects
        // the store.
        dropped += forget(touched.sessionId, touched.traceId);
        absent += 1;
        continue;
      }

      // The batch changed the event set of every capture it named for this
      // trace, so those captures' trees are stale; the next capture-scoped read
      // rebuilds them. Captures the batch did not name keep theirs.
      dropped += forgetTouchedCaptures(touched);
      rebuilt += 1;
      orphanCount += built.value.orphanCount;
      remember(touched.key, {
        sessionId: touched.sessionId,
        captureId: undefined,
        traceId: touched.traceId,
        tree: built.value,
      });
    }

    if (batch.ignored > 0) {
      // Reported unconditionally, and at `warn`: every persisted event carries
      // a session and a trace id, so an absent one means evidence that cannot
      // be correlated at all — and a batch of nothing but such events would
      // leave the summary below unwritten.
      log.warn('persisted events carried no usable session or trace id and were not correlated', {
        batchSize: events.length,
        ignored: batch.ignored,
      });
    }

    if (batch.traces.length > 0) {
      log.debug('rebuilt the traces a persisted batch touched', {
        batchSize: events.length,
        tracesTouched: tracesTouched.length,
        rebuilt,
        absent,
        dropped,
        orphanCount,
        cachedTraces: cache.size,
      });
    }

    return ok({ tracesTouched, rebuilt, orphanCount });
  }

  async function getTrace(
    sessionId: SessionId,
    traceId: TraceId,
    captureId?: CaptureId,
  ): Promise<Result<TraceTree | undefined, DebuggenError>> {
    // The scope is part of the key, so a capture-scoped read can never be
    // answered with the session-wide tree of the same trace id, nor the
    // reverse.
    const key = cacheKey(sessionId, traceId, captureId);
    const cached = cache.get(key);

    if (cached !== undefined) {
      hits += 1;
      return ok(cached.tree);
    }

    misses += 1;

    const built = await rebuild(sessionId, traceId, captureId);
    if (isErr(built)) {
      return built;
    }

    if (built.value === undefined) {
      // Not an error: a trace can be purged by retention, and a trace whose
      // events have not arrived yet is the ordinary state of a capture in
      // flight. The absence is not cached, so the next read sees the events
      // the moment they land.
      log.debug(
        'no persisted events for the requested trace',
        traceScopeFields(sessionId, traceId, captureId),
      );
      return ok(undefined);
    }

    remember(key, { sessionId, captureId, traceId, tree: built.value });
    return ok(built.value);
  }

  async function listTraceIds(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Promise<Result<readonly TraceId[], DebuggenError>> {
    const ids = await readStore('listing the trace ids of a session', () =>
      repo.listTraceIds(sessionId, captureId),
    );

    if (isErr(ids)) {
      log.warn('listing the trace ids of a session failed', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        ...(captureId !== undefined ? { [LOG_BINDING_KEYS.captureId]: captureId } : {}),
        code: ids.error.code,
      });
      return ids;
    }

    return ok(ids.value);
  }

  async function getTraces(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): Promise<Result<readonly TraceTree[], DebuggenError>> {
    const ids = await listTraceIds(sessionId, captureId);
    if (isErr(ids)) {
      return ids;
    }

    const trees: TraceTree[] = [];

    for (const traceId of ids.value) {
      // The same capture narrows each trace's events as it narrowed the
      // enumeration: a trace id recurring in another capture of the session
      // must not bring that capture's events into this one's tree.
      const trace = await getTrace(sessionId, traceId, captureId);
      if (isErr(trace)) {
        return trace;
      }
      // A trace enumerated a moment ago can have been purged since; that is an
      // absence, not a hole to fill with a placeholder tree.
      if (trace.value !== undefined) {
        trees.push(trace.value);
      }
    }

    log.debug('correlated every trace of a session', {
      [LOG_BINDING_KEYS.sessionId]: sessionId,
      ...(captureId !== undefined ? { [LOG_BINDING_KEYS.captureId]: captureId } : {}),
      enumerated: ids.value.length,
      returned: trees.length,
      cachedTraces: cache.size,
    });

    return ok(trees);
  }

  function invalidate(sessionId: SessionId, traceId?: TraceId): void {
    // Every scope goes: the session-wide tree and each capture-scoped tree of
    // the trace — or of the whole session — alike.
    const removed = forget(sessionId, traceId);

    if (traceId !== undefined) {
      log.debug('invalidated a cached trace', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        traceId,
        removed,
        cachedTraces: cache.size,
      });
      return;
    }

    log.debug("invalidated a session's cached traces", {
      [LOG_BINDING_KEYS.sessionId]: sessionId,
      removed,
      cachedTraces: cache.size,
    });
  }

  function stats(): CorrelatorStats {
    return { cachedTraces: cache.size, hits, misses, rebuilds };
  }

  function close(): void {
    const released = cache.size;
    cache.clear();
    log.debug('released the correlated trace cache', { released, hits, misses, rebuilds });
  }

  return { onEventsPersisted, getTrace, getTraces, listTraceIds, invalidate, stats, close };
}
