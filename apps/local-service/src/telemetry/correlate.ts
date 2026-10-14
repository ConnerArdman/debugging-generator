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
 * ## Extend cached trees at ingest; rebuild lazily as the bounded fallback
 *
 * Every event of a trace arrives from one of two independent producers — the
 * MAIN-world browser agent and the dev-server Node preload — over two different
 * transports, in batches whose interleaving nobody controls. A page reload
 * replays an agent buffer; a server span can land before the `fetch` span that
 * caused it; a parent can arrive after its children. The pipeline is persist →
 * correlate incrementally → tail (AAP 0.7.1, Group 2), and correlation must
 * stay proportional to what each batch brought: rereading and re-sorting the
 * whole accumulated trace per batch costs `O(n²/b)` for `n` events arriving in
 * batches of `b`, on the same path that feeds the live tail, and deferring that
 * rebuild to the next read only moves the same cost to a panel that reads after
 * every batch.
 *
 * So {@link TraceCorrelator.onEventsPersisted} **extends each cached tree the
 * batch touched, in place of rebuilding it**, through `@debuggen/telemetry`'s
 * `extendCorrelatedTrace`. That function is exact or silent: it either answers
 * with the very tree `correlateTrace` would build from the scope's complete
 * stored rows — identical down to the key order — or it refuses. What a capture
 * really streams extends: spans under known parents, server spans whose
 * `fetch` has not landed (orphans on the anchor), the late `fetch` that adopts
 * them, and parentless spans that do not outrank the anchor. It refuses only
 * what a full correlation alone reproduces: a batch that moves the trace's
 * anchor (`primary-change` — possible only while the trace has no genuine root,
 * and once per root that outranks the anchor), a span id seen twice, a cycle,
 * the depth guard, and rows that are not the stored ones. A refused scope is
 * dropped, and its next read reloads and correlates the complete stored set
 * once, however many batches landed in between — the lazy rebuild, kept as the
 * bounded fallback, after which the scope extends again. Either way no tree is
 * ever built from a batch alone, and no write to the store leaves a cached tree
 * behind it: an extended tree equals the full correlation by construction, and
 * a dropped one is rebuilt from the store. Rows the store deletes — a retention
 * purge, a session end — reach the cache through
 * {@link TraceCorrelator.invalidate}, as before.
 *
 * The per-scope index an extension needs (span id → node, the spans the
 * trace's orphans are missing) is built lazily, in one `O(n)` walk, the first
 * time a batch touches the cached entry, and kept current by every extension;
 * after that each batch costs its own size plus the orphan subtrees it moves
 * and the paths it touches, and no store read. Scopes that are not cached are
 * not touched at all: nothing is read or built for a tree no reader has asked
 * for.
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
 * interaction cost nothing after the first. Recency is by last **write**, not
 * by read (see {@link TRACE_CACHE_LIMIT}).
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
 * {@link TraceCorrelator.onEventsPersisted} reaches the session-wide tree of
 * every trace a batch touches — with every event of the batch for that session
 * and trace — and that trace's capture-scoped trees for exactly the captures
 * the batch named, each with only that capture's events of the batch. Each of
 * those that is cached is extended, or dropped for a rebuild on its next read.
 * The trees of the captures the batch did not name stay cached as they were:
 * their event sets did not change.
 *
 * ## What bounds the cache, and what a racing read may keep
 *
 * An entry's weight is its tree's node count — plus the extension index's
 * share once a batch has indexed it ({@link TRACE_INDEX_WEIGHT_DIVISOR}) — and
 * a count bound alone does not bound that: one trace may hold up to 100 000
 * nodes, and the same trace can be cached session-wide and once per capture. So
 * two bounds hold together — {@link TRACE_CACHE_LIMIT} entries and
 * {@link TRACE_CACHE_NODE_BUDGET} weight across all of them, evicted
 * oldest-write-first until both are met — and no single entry may weigh more
 * than {@link TRACE_CACHE_MAX_TREE_NODES}: a heavier tree answers its read
 * exactly as any other and is not cached, and an extension that grows a tree
 * past the cap leaves it uncached rather than evicting everything else. The
 * weight is stored on the entry when it is written, and every removal goes
 * through one helper, so the total the budget is checked against is exact.
 *
 * A read that misses registers itself before it loads, and an invalidation of
 * its scope that lands while the load is in flight — a batch, an
 * {@link TraceCorrelator.invalidate} or a {@link TraceCorrelator.close} — marks
 * it stale. A stale read's tree still answers that read, since it is what the
 * store held when the read began, but it is not cached, so no later read can be
 * served a tree that predates rows the store now holds. Only reads in flight are
 * registered, so that bookkeeping is bounded by concurrency, never by history.
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
 * `../panels/data.ts`, which reads its `trace` source through
 * {@link TraceCorrelator.getTrace}, as `../analysis/summarize.ts` does: both are
 * served the upstream {@link TraceTree} this module built from the trace's
 * complete stored set, or extended to exactly the tree that set produces.
 *
 * @example
 * ```ts
 * const correlator = createTraceCorrelator({ telemetry, logger });
 * const stored = telemetry.insertMany(attributed); // ingestSeq assigned here
 * if (isOk(stored)) {
 *   await correlator.onEventsPersisted(stored.value.events); // extends cached trees; no store read
 * }
 * const trace = await correlator.getTrace(sessionId, traceId); // every capture; built once, then cached
 * const window = await correlator.getTraces(sessionId, captureId); // that capture's events only
 * ```
 */

import { DebuggenError, err, isErr, noopLogger, ok } from '@debuggen/shared';
import type { CaptureId, Logger, Result, SessionId, TraceId } from '@debuggen/shared';
import {
  DEFAULT_MAX_DEPTH,
  correlateTrace,
  extendCorrelatedTrace,
  indexTraceForExtension,
} from '@debuggen/telemetry';
import type {
  ExtensionRefusalReason,
  TelemetryEvent,
  TraceExtensionIndex,
  TraceTree,
} from '@debuggen/telemetry';

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
 * The **count** bound. It caps how many entries exist — and so the length of
 * every walk over them, such as {@link TraceCorrelator.invalidate} — while
 * {@link TRACE_CACHE_NODE_BUDGET} caps what they weigh; neither stands in for
 * the other, because one entry holds anything from a single node to
 * {@link TRACE_CACHE_MAX_TREE_NODES}. One interaction produces one trace,
 * cached once per scope it is read in, so 256 holds every trace a developer is
 * likely to revisit across a long session of several captures.
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
 * How much cached weight one correlator keeps, summed over every entry:
 * `50 000` node units.
 *
 * The **weight** bound, and the one that bounds memory. One unit is one cached
 * node: a `TraceNode` plus the reconstructed `TelemetryEvent` it references —
 * the store builds a fresh event object on every read, so the cache is what
 * keeps it alive — which measures about 0.85 KiB on Node 24 for representative
 * events (the identifiers, a name, a handful of redacted attributes and a
 * source location) and is budgeted here at 1 KiB. An entry that a batch has
 * indexed for extension also carries the index's share
 * ({@link TRACE_INDEX_WEIGHT_DIVISOR}). 50 000 units therefore hold the cache
 * near 50 MiB at worst: a ceiling a developer machine carries for the life of
 * the service, and still room for the full {@link TRACE_CACHE_LIMIT} of traces
 * at about 200 nodes each, beyond the tens to hundreds of events a real
 * interaction produces.
 *
 * Entries are evicted oldest-write-first until both this bound and
 * {@link TRACE_CACHE_LIMIT} hold. Override it per correlator with
 * {@link TraceCorrelatorDeps.cacheNodeBudget}; `0` disables caching entirely.
 */
export const TRACE_CACHE_NODE_BUDGET = 50_000;

/**
 * The heaviest entry the cache may hold: `10 000` node units.
 *
 * A single trace may reach {@link MAX_TRACE_EVENTS} (100 000) nodes — about
 * 100 MiB at the per-node estimate of {@link TRACE_CACHE_NODE_BUDGET} — and
 * caching one would evict every other entry to make room for it. Capped at a
 * fifth of the budget (about 10 MiB), no one trace can take more than that share,
 * so the working set of ordinary interactions survives a pathological one. A
 * tree above the cap is correlated and returned to its reader like any other
 * and is not cached: each read of it rebuilds from the store, which has to page
 * that many rows to answer it either way.
 *
 * The cap applies to an entry's **weight** — its nodes, plus the extension
 * index's share once indexed — so that no entry, indexed or not, can outweigh
 * the budget and evict itself. A cached tree too heavy to index within the cap
 * is dropped when a batch touches it, and one an extension grows past the cap
 * is not cached; both rebuild on their next read, as a tree above the cap
 * always does.
 *
 * The cap in force is the smaller of this and the node budget. Override it per
 * correlator with {@link TraceCorrelatorDeps.maxCachedTreeNodes}.
 */
export const TRACE_CACHE_MAX_TREE_NODES = 10_000;

/**
 * What the extension index costs, as a fraction of the tree it indexes: one
 * node unit per `16` indexed nodes, rounded up.
 *
 * An index (`TraceExtensionIndex` in `@debuggen/telemetry`) holds one `Map`
 * entry per node — span id → node, sharing the strings and node objects the
 * tree already keeps alive — plus a map of the few span ids the trace's
 * orphans are missing and three small vocabulary sets. Measured on Node 24
 * over realistic trees of 2 000 to 100 000 nodes, the index adds 31–47 bytes
 * per node, and at most 56 bytes just after the map's hash table has doubled —
 * about 7.5 % of the 750–800 bytes each tree node itself measured. One
 * sixteenth of the 1 KiB a node unit is budgeted at is 64 bytes, which covers
 * that worst case. The placement parent is derived from each node rather than
 * stored in a second map, which is what keeps the share this small.
 *
 * The weight is computed once, when an entry is written, and stored on it, so
 * every removal subtracts exactly what the insertion added.
 */
export const TRACE_INDEX_WEIGHT_DIVISOR = 16;

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
 * The recovery instruction a persisted batch that could not be scanned
 * carries: the rows are stored, and every cached tree was dropped so that each
 * rebuilds from them on its next read.
 */
const BATCH_SCAN_FAILURE_HINT =
  'Report the service log; the batch is stored and every trace rebuilds from the store on its next read.';

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

  /**
   * How much weight the cached entries may carry between them, in node units
   * (see {@link TRACE_CACHE_NODE_BUDGET}). Defaults to
   * {@link TRACE_CACHE_NODE_BUDGET}; `0` disables caching, and a value that is
   * not a non-negative integer is treated as absent.
   */
  readonly cacheNodeBudget?: number | undefined;

  /**
   * The most weight one cached entry may carry — its nodes, plus the extension
   * index's share once indexed; a heavier tree answers its read and is not
   * cached. Defaults to {@link TRACE_CACHE_MAX_TREE_NODES}, never exceeds
   * `cacheNodeBudget`, and a value that is not a non-negative integer is
   * treated as absent.
   */
  readonly maxCachedTreeNodes?: number | undefined;
}

/**
 * What one {@link TraceCorrelator.onEventsPersisted} call did.
 *
 * The ingest path's audit trail: which traces the batch mentioned. No cached
 * tree of any of them predates the batch — each was extended to include it or
 * dropped for a rebuild on its next read. What happened to each entry is
 * counted in {@link CorrelatorStats} rather than here, so this shape stays the
 * one the ingest path builds and reads.
 */
export interface CorrelateUpdate {
  /**
   * The trace ids the batch mentioned, one per distinct `(session, trace)` pair,
   * in first-seen order.
   */
  readonly tracesTouched: readonly TraceId[];
}

/**
 * The cache and build counters of one correlator, for diagnostics and tests.
 *
 * `hits`, `misses`, `rebuilds`, `invalidations`, `extensions` and
 * `extensionNodesBuilt` are cumulative for the correlator's lifetime and are
 * not reset by {@link TraceCorrelator.invalidate} or
 * {@link TraceCorrelator.close}: they describe what the correlator has done,
 * while `cachedTraces`, `cachedNodes` and `cachedWeight` describe what it
 * currently holds.
 */
export interface CorrelatorStats {
  /**
   * How many trees are cached right now — one per `(session, scope, trace)`, so
   * a trace cached session-wide and for two of its captures counts three times.
   */
  readonly cachedTraces: number;
  /** How many tree nodes the cached trees hold between them right now. */
  readonly cachedNodes: number;
  /**
   * The weight the cached entries carry right now: their nodes plus the share
   * of every extension index they hold ({@link TRACE_INDEX_WEIGHT_DIVISOR}) —
   * the total {@link TRACE_CACHE_NODE_BUDGET} bounds. Equal to `cachedNodes`
   * while no entry is indexed.
   */
  readonly cachedWeight: number;
  /** How many reads were served from the cache. */
  readonly hits: number;
  /** How many reads had to load and build. */
  readonly misses: number;
  /**
   * How many trees have been built from the store. Only a read that missed
   * builds one; a tree refused because it did not hold every loaded row is not
   * counted, and neither is an extension.
   */
  readonly rebuilds: number;
  /**
   * How many cached trees were dropped rather than kept current — by a
   * persisted batch the tree could not absorb exactly (or that would have
   * grown it past the per-entry cap), or by {@link TraceCorrelator.invalidate}.
   * Eviction and {@link TraceCorrelator.close} are not counted.
   */
  readonly invalidations: number;
  /**
   * How many times a persisted batch grew a cached tree incrementally instead
   * of dropping it. A batch of replays alone changes nothing and is not
   * counted.
   */
  readonly extensions: number;
  /**
   * The node objects those extensions created between them — the new nodes
   * plus the ancestors copied to hold them: the whole incremental work, which
   * depends on the batches and the paths they touch, never on the size of the
   * trees they grew.
   */
  readonly extensionNodesBuilt: number;
}

/**
 * Incremental trace correlation for one service process.
 *
 * Construct it with {@link createTraceCorrelator}. The ingest path calls
 * {@link TraceCorrelator.onEventsPersisted} as each batch lands, which extends
 * the cached trees it touched (or drops those it cannot extend exactly); the
 * panel-data and analysis paths read through {@link TraceCorrelator.getTrace},
 * {@link TraceCorrelator.getTraces} and {@link TraceCorrelator.listTraceIds},
 * and a read of a dropped or never-cached scope builds it once from the store.
 * No method throws and no method rejects.
 */
export interface TraceCorrelator {
  /**
   * Brings every cached tree a freshly persisted batch touched up to date with
   * it: extended incrementally where that is exact, dropped for a rebuild on
   * its next read where it is not.
   *
   * Call it with the events **returned** by the store's `insertMany`, never
   * with the ingress events: attribution stamps the `sessionId` and `captureId`
   * that name the cache scopes a batch changed, those rows carry the
   * `ingestSeq` the canonical order ends on, and the rows a dropped scope
   * rebuilds from have to be in the store before any read asks for them.
   *
   * The call reads nothing from the store. It scans the batch once; then, for
   * each distinct `(sessionId, traceId)` pair, it takes the trace's
   * session-wide scope with every event of the batch for the pair, and its
   * scopes for exactly the captures the batch named, each with that capture's
   * events. A scope that is cached is extended with those events — its
   * extension index is built on first use, in one walk of the tree, and kept
   * current afterwards — so that the tree stays exactly the correlation of the
   * scope's stored rows — orphans, the late parents that adopt them and roots
   * that leave the anchor in place included; a batch the tree cannot absorb
   * exactly (one that moves the anchor, a reused span id, a cycle, the depth
   * guard), a tree that cannot be indexed, and one that would outgrow the
   * per-entry cap are dropped instead, and the next {@link getTrace} rebuilds
   * that scope from the store once. A scope that is not cached is left alone:
   * nothing is read or built for it. Any read of a reached scope still in
   * flight is marked stale, so that it cannot cache what it loaded before the
   * batch. The trees of captures the batch did not name stay cached as they
   * were. A replayed row — the stored row itself, delivered again — changes
   * nothing, so running it twice on one batch is harmless.
   *
   * @param events The batch as the store now holds it, in any order. An empty
   * batch is a successful no-op that touches neither the store nor the cache.
   * @returns The traces the batch touched. The call fails, with `INTERNAL`, only
   * when the batch itself cannot be scanned; which traces it changed is then
   * unknown, so every cached tree is dropped and every read in flight is marked
   * stale before the error is returned, and nothing stale can be served.
   */
  onEventsPersisted(
    events: readonly TelemetryEvent[],
  ): Promise<Result<CorrelateUpdate, DebuggenError>>;

  /**
   * One correlated trace, from the cache when it is there.
   *
   * A miss loads the scope's complete event set, correlates it and caches the
   * tree — unless the tree exceeds the per-entry cap, or a batch touching the
   * scope (or an invalidation of it) landed while the load was in flight; the
   * tree answers this read in both cases and is not cached (see the module
   * notes).
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
   * alike. A read of any of those scopes still in flight is marked stale, so it
   * answers its caller without caching a tree loaded before this call.
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
   * Every cached tree is dropped and every read in flight is marked stale, so
   * none of them repopulates the cache it was begun against. The correlator
   * owns no connection, timer or listener, so this is idempotent and leaves the
   * instance usable: a read arriving after a shutdown has begun still answers
   * from the store rather than failing, and repopulates the cache it needs. The
   * counters are left alone.
   */
  close(): void;
}

/* -------------------------------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * One `(sessionId, traceId)` pair a persisted batch mentioned, with the
 * session-wide cache key and the batch's events for each scope it changed.
 */
interface TouchedTrace {
  /** The session that owns the trace. */
  readonly sessionId: SessionId;
  /** The trace whose cached trees the batch changed. */
  readonly traceId: TraceId;
  /** The session-wide cache key for the pair, computed once. */
  readonly key: string;
  /**
   * Every event of the batch for the pair, in batch order: what the
   * session-wide scope, which joins every capture, gained.
   */
  readonly events: readonly TelemetryEvent[];
  /**
   * The batch's events for each capture it named for the pair, captures in
   * first-seen order: what each capture-scoped tree of the trace gained.
   */
  readonly captures: ReadonlyMap<CaptureId, readonly TelemetryEvent[]>;
}

/** One cache scope a batch changed, with the events it gained. */
interface ChangedScope {
  /** The scope's cache key. */
  readonly key: string;
  /** The capture it is narrowed to; `undefined` for the session-wide scope. */
  readonly captureId: CaptureId | undefined;
  /** The batch's events that belong to the scope. */
  readonly events: readonly TelemetryEvent[];
}

/**
 * The scope one tree is built for: a trace of a session, narrowed to one
 * capture or joined across all of them.
 *
 * The scope travels with a cached tree and with a read in flight rather than
 * being parsed back out of the key, so deciding which of them belong to a
 * session or to a trace is a comparison of these fields and never depends on
 * what characters an identifier contains.
 */
interface TraceScope {
  /** The session that owns the evidence. */
  readonly sessionId: SessionId;
  /** The capture the tree is narrowed to; `undefined` for the session-wide tree. */
  readonly captureId: CaptureId | undefined;
  /** The trace the tree correlates. */
  readonly traceId: TraceId;
}

/** One cached tree, with the scope it was built for. */
interface CachedTrace extends TraceScope {
  /**
   * The tree itself: exactly what `correlateTrace` builds from the scope's
   * stored rows, whether it was built that way or extended to it.
   */
  readonly tree: TraceTree;
  /**
   * The index that lets a batch extend {@link CachedTrace.tree}, once a batch
   * has touched the entry; `undefined` until then. It always describes this
   * entry's tree, and belongs to this entry alone.
   */
  readonly extension: TraceExtensionIndex | undefined;
  /**
   * What the entry weighs against the node budget — the tree's nodes, plus
   * the index's share when there is one — fixed when the entry was written, so
   * that removing it subtracts exactly what inserting it added.
   */
  readonly weight: number;
}

/** What {@link CachedTrace} holds besides its scope. */
type CachedTraceContent = Pick<CachedTrace, 'tree' | 'extension'>;

/**
 * Why a cached tree a batch reached was dropped rather than extended: the
 * extension's own refusal, or one of the service's two reasons not to try —
 * the tree cannot be indexed for extension, or indexing it (or growing it)
 * would carry it past the per-entry cap.
 */
type DropReason = ExtensionRefusalReason | 'not-extendable' | 'over-cap' | 'extension-failed';

/** What a batch did to one scope it changed. */
type ScopeOutcome =
  | { readonly kind: 'uncached' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'extended'; readonly nodesBuilt: number }
  | { readonly kind: 'dropped'; readonly reason: DropReason };

/**
 * What a cached entry weighs: one unit per node, plus one per
 * {@link TRACE_INDEX_WEIGHT_DIVISOR} nodes, rounded up, when it is indexed.
 *
 * @param nodeCount The tree's node count.
 * @param indexed Whether the entry holds an extension index.
 * @returns The weight in node units.
 */
function entryWeight(nodeCount: number, indexed: boolean): number {
  return indexed ? nodeCount + Math.ceil(nodeCount / TRACE_INDEX_WEIGHT_DIVISOR) : nodeCount;
}

/**
 * One cache miss whose load is in flight: the scope it will cache under, and
 * whether an invalidation of that scope has landed since the load began.
 *
 * Registered before the load starts and removed when it ends, however it ends,
 * so the registry holds only reads in flight — bounded by concurrency, never by
 * history. Invalidation matches a pending read by the same fields, and with the
 * same rules, as it matches a cached tree.
 */
interface PendingRead extends TraceScope {
  /**
   * Set once an invalidation of this scope has landed: the read's tree still
   * answers its caller, and is never cached.
   */
  stale: boolean;
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
 * Every scope one touched trace's batch changed, with the events each gained:
 * the session-wide tree with all of them, then one capture-scoped tree per
 * capture the batch named, with that capture's.
 *
 * @param touched The pair, with its events per scope.
 * @returns The scopes, session-wide first, then in first-seen capture order.
 */
function changedScopes(touched: TouchedTrace): ChangedScope[] {
  const scopes: ChangedScope[] = [
    { key: touched.key, captureId: undefined, events: touched.events },
  ];

  for (const [captureId, events] of touched.captures) {
    scopes.push({
      key: cacheKey(touched.sessionId, touched.traceId, captureId),
      captureId,
      events,
    });
  }

  return scopes;
}

/**
 * Whether a cached tree or a read in flight belongs to one session, or to one
 * trace of it — under any scope, session-wide and per capture alike.
 *
 * The one rule {@link TraceCorrelator.invalidate} applies to both, so a cached
 * tree and a read that is about to cache one can never be matched differently.
 *
 * @param scope The tree's or the read's scope.
 * @param sessionId The session being invalidated.
 * @param traceId One trace of it, or every trace when absent.
 * @returns `true` when the scope is covered.
 */
function isWithin(scope: TraceScope, sessionId: SessionId, traceId: TraceId | undefined): boolean {
  return scope.sessionId === sessionId && (traceId === undefined || scope.traceId === traceId);
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
 * @param deps The telemetry reads, the logger, the depth guard and the three
 * cache bounds; see {@link TraceCorrelatorDeps}.
 * @returns The correlator, whose methods neither throw nor reject.
 */
export function createTraceCorrelator(deps: TraceCorrelatorDeps): TraceCorrelator {
  const repo = deps.telemetry;
  const log = (deps.logger ?? noopLogger).child({ [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM });
  const maxDepth = resolveBound(deps.maxDepth, CORRELATOR_MAX_DEPTH);
  const cacheLimit = resolveBound(deps.cacheLimit, TRACE_CACHE_LIMIT);
  const nodeBudget = resolveBound(deps.cacheNodeBudget, TRACE_CACHE_NODE_BUDGET);
  // A tree above the budget could never be cached without evicting itself, so
  // the per-entry cap is never allowed to exceed it.
  const maxTreeNodes = Math.min(
    resolveBound(deps.maxCachedTreeNodes, TRACE_CACHE_MAX_TREE_NODES),
    nodeBudget,
  );
  const cachingEnabled = cacheLimit > 0 && nodeBudget > 0;

  /**
   * The cached trees, in insertion order of their last write.
   *
   * A `Map` preserves that order, which is what makes eviction a single
   * `keys().next()` — no timestamps, no heap, no bookkeeping on the read path.
   */
  const cache = new Map<string, CachedTrace>();

  /**
   * The reads in flight, by the cache key they will write.
   *
   * A set per key because two reads of one scope can be in flight at once — two
   * panel nodes asking for the same trace — and each must be judged stale on
   * its own. A key leaves the map with its last read, so the map is empty
   * whenever no read is in flight.
   */
  const pending = new Map<string, Set<PendingRead>>();

  /**
   * The node count summed over {@link cache}, reported as
   * {@link CorrelatorStats.cachedNodes}.
   */
  let cachedNodes = 0;
  /**
   * The stored weights summed over {@link cache}: the total
   * {@link TRACE_CACHE_NODE_BUDGET} bounds. Exact because every insertion goes
   * through {@link remember}, every removal through {@link drop}, and both use
   * the weight stored on the entry.
   */
  let cachedWeight = 0;
  let hits = 0;
  let misses = 0;
  let rebuilds = 0;
  let invalidations = 0;
  let extensions = 0;
  let extensionNodesBuilt = 0;

  /**
   * Removes one cached tree and its weight — the only way an entry leaves the
   * cache, which is what keeps {@link cachedNodes} and {@link cachedWeight}
   * exact.
   *
   * @param key The entry's cache key.
   * @returns Whether an entry was removed.
   */
  function drop(key: string): boolean {
    const entry = cache.get(key);

    if (entry === undefined) {
      return false;
    }

    cache.delete(key);
    cachedNodes -= entry.tree.nodeCount;
    cachedWeight -= entry.weight;
    return true;
  }

  /**
   * Caches a tree — freshly built by a read, or extended by a batch — then
   * evicts oldest-write-first until both the count bound and the node budget
   * hold.
   *
   * The key's previous entry is dropped first, and that is load-bearing twice
   * over: re-assigning an existing key in a `Map` leaves it in its original
   * position, so without it a trace rebuilt on every read would keep aging
   * towards eviction while newer, untouched traces stayed; and the tree being
   * cached is at least as fresh as whatever a concurrent read stored under the
   * key meanwhile, so the older one must not outlive it — even when the fresh
   * tree is itself too large to cache. An extension is a write too, so an
   * extended tree moves to the newest position like a rebuilt one.
   *
   * The entry's weight is computed here, once, and stored on it. The eviction
   * loop cannot evict the entry it just inserted: that weight is at most
   * {@link maxTreeNodes}, which never exceeds the budget, and it is the newest
   * entry, so the loop stops by the time it is the only one left.
   *
   * @param key The entry's cache key.
   * @param scope The scope the tree was built for.
   * @param content The tree, and its extension index when it has one.
   * @returns Whether the entry was cached; `false` when caching is disabled or
   * the entry would outweigh the per-entry cap.
   */
  function remember(key: string, scope: TraceScope, content: CachedTraceContent): boolean {
    if (!cachingEnabled) {
      return false;
    }

    drop(key);

    const nodes = content.tree.nodeCount;
    const weight = entryWeight(nodes, content.extension !== undefined);

    if (weight > maxTreeNodes) {
      log.debug('a correlated tree exceeds the largest cache entry; it is not cached', {
        ...traceScopeFields(scope.sessionId, scope.traceId, scope.captureId),
        nodeCount: nodes,
        weight,
        maxTreeNodes,
      });
      return false;
    }

    cache.set(key, {
      sessionId: scope.sessionId,
      captureId: scope.captureId,
      traceId: scope.traceId,
      tree: content.tree,
      extension: content.extension,
      weight,
    });
    cachedNodes += nodes;
    cachedWeight += weight;

    while (cache.size > cacheLimit || cachedWeight > nodeBudget) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      drop(oldest.value);
    }

    return true;
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
  function forget(sessionId: SessionId, traceId: TraceId | undefined): number {
    let removed = 0;

    for (const [key, entry] of [...cache.entries()]) {
      if (isWithin(entry, sessionId, traceId) && drop(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Registers a read that is about to load, so that an invalidation of its
   * scope landing before the load completes can mark it stale.
   *
   * @param key The cache key the read will write.
   * @param scope The read's scope.
   * @returns The registration, to hand back to {@link endRead}.
   */
  function beginRead(key: string, scope: TraceScope): PendingRead {
    const read: PendingRead = { ...scope, stale: false };
    const reads = pending.get(key);

    if (reads === undefined) {
      pending.set(key, new Set([read]));
    } else {
      reads.add(read);
    }

    return read;
  }

  /**
   * Removes a read's registration once its load has ended, however it ended.
   *
   * @param key The cache key the read was registered under.
   * @param read The registration {@link beginRead} returned.
   */
  function endRead(key: string, read: PendingRead): void {
    const reads = pending.get(key);

    if (reads === undefined) {
      return;
    }

    reads.delete(read);
    if (reads.size === 0) {
      pending.delete(key);
    }
  }

  /**
   * Marks every read in flight for exactly one cache key stale.
   *
   * @param key The scope a batch changed.
   * @returns How many reads were newly marked.
   */
  function markKeyStale(key: string): number {
    const reads = pending.get(key);
    let marked = 0;

    if (reads === undefined) {
      return marked;
    }

    for (const read of reads) {
      if (!read.stale) {
        read.stale = true;
        marked += 1;
      }
    }

    return marked;
  }

  /**
   * Marks every read in flight whose scope satisfies `covers` stale.
   *
   * The walk is over reads in flight only, so it is bounded by concurrency.
   *
   * @param covers Which scopes the invalidation reaches.
   * @returns How many reads were newly marked.
   */
  function markReadsStale(covers: (scope: TraceScope) => boolean): number {
    let marked = 0;

    for (const reads of pending.values()) {
      for (const read of reads) {
        if (!read.stale && covers(read)) {
          read.stale = true;
          marked += 1;
        }
      }
    }

    return marked;
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
   * and it is reported as one instead of rejecting the read that asked.
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
   * with its events for the session-wide scope and for every capture the batch
   * named for it.
   *
   * First-seen order, so {@link CorrelateUpdate.tracesTouched} is a function of
   * the batch rather than of a hash iteration. An event whose session or trace
   * id is unusable is counted and skipped: nothing here re-validates a persisted
   * event, and keying a cache entry on an empty string is the one thing that
   * would corrupt the cache. An unusable capture id alone does not skip the
   * event — it still belongs to the pair's session-wide scope — it only names
   * no capture-scoped entry, because no read could have cached one under it.
   * One pass, and memory proportional to the batch.
   */
  function collectTouched(events: readonly TelemetryEvent[]): TouchedBatch {
    // The mutable accumulators are kept beside the published record rather
    // than typed through it, so the record stays read-only to its consumers.
    interface Accumulator {
      readonly touched: TouchedTrace;
      readonly events: TelemetryEvent[];
      readonly captures: Map<CaptureId, TelemetryEvent[]>;
    }

    const traces = new Map<string, Accumulator>();
    let ignored = 0;

    for (const event of events) {
      const { sessionId, traceId, captureId } = event;

      if (!isUsableId(sessionId) || !isUsableId(traceId)) {
        ignored += 1;
        continue;
      }

      const key = cacheKey(sessionId, traceId, undefined);
      let accumulator = traces.get(key);

      if (accumulator === undefined) {
        const pairEvents: TelemetryEvent[] = [];
        const captures = new Map<CaptureId, TelemetryEvent[]>();
        accumulator = {
          touched: { sessionId, traceId, key, events: pairEvents, captures },
          events: pairEvents,
          captures,
        };
        traces.set(key, accumulator);
      }

      accumulator.events.push(event);

      if (isUsableId(captureId)) {
        const captured = accumulator.captures.get(captureId);
        if (captured === undefined) {
          accumulator.captures.set(captureId, [event]);
        } else {
          captured.push(event);
        }
      }
    }

    return { traces: [...traces.values()].map((accumulator) => accumulator.touched), ignored };
  }

  /**
   * Brings one cached scope a batch changed up to date with the events it
   * gained — extended, or dropped for a rebuild — and leaves an uncached scope
   * alone.
   *
   * The extension index is built here the first time a batch reaches the entry
   * (one walk of its tree), unless the indexed entry could not be cached within
   * the per-entry cap, in which case building it would be wasted and the entry
   * is dropped instead. After that, `extendCorrelatedTrace` either returns the
   * tree `correlateTrace` would build from the scope's stored rows — which
   * replaces the entry through {@link remember}, keeping the oldest-write
   * order, the weight accounting and the cap — or refuses, and the entry is
   * dropped. A batch of replays alone leaves the entry as it was, except that
   * an index built for it is kept.
   *
   * `extendCorrelatedTrace` does not throw for rows the store wrote. A throw
   * here can only come from a malformed row, and it drops the entry — the
   * rebuild from the store is always correct — rather than escaping ingest.
   *
   * @param scope The scope and the batch's events for it.
   * @returns What happened to the scope.
   */
  function applyToCached(scope: ChangedScope): ScopeOutcome {
    const entry = cache.get(scope.key);

    if (entry === undefined) {
      return { kind: 'uncached' };
    }

    const dropped = (reason: DropReason): ScopeOutcome => {
      drop(scope.key);
      return { kind: 'dropped', reason };
    };

    try {
      let index = entry.extension;
      const indexedNow = index === undefined;

      if (index === undefined) {
        if (entryWeight(entry.tree.nodeCount, true) > maxTreeNodes) {
          return dropped('over-cap');
        }
        index = indexTraceForExtension(entry.tree, { maxDepth });
        if (index === undefined) {
          return dropped('not-extendable');
        }
      }

      const result = extendCorrelatedTrace(index, scope.events, { maxDepth });

      if (result.kind === 'refused') {
        return dropped(result.reason);
      }

      if (result.added === 0) {
        // Replays only: the stored rows are the ones the tree was built from.
        // A freshly built index is kept, re-weighing the entry.
        if (indexedNow && !remember(scope.key, entry, { tree: entry.tree, extension: index })) {
          return { kind: 'dropped', reason: 'over-cap' };
        }
        return { kind: 'unchanged' };
      }

      if (!remember(scope.key, entry, { tree: result.tree, extension: index })) {
        return { kind: 'dropped', reason: 'over-cap' };
      }

      return { kind: 'extended', nodesBuilt: result.nodesBuilt };
    } catch {
      return dropped('extension-failed');
    }
  }

  /**
   * Drops every cached tree and marks every read in flight stale: what
   * {@link close} does, and what a batch that cannot be scanned forces, since
   * which scopes it changed is then unknown.
   *
   * @returns How many trees were dropped and how many reads were newly marked.
   */
  function releaseEverything(): { readonly dropped: number; readonly staleReads: number } {
    let dropped = 0;

    for (const key of [...cache.keys()]) {
      if (drop(key)) {
        dropped += 1;
      }
    }

    return { dropped, staleReads: markReadsStale(() => true) };
  }

  /*
   * Deliberately not `async`: nothing here awaits, so the whole update — every
   * extension, every drop and every read in flight marked stale — happens
   * synchronously inside the call and is complete before any pending read
   * resumes.
   */
  function onEventsPersisted(
    events: readonly TelemetryEvent[],
  ): Promise<Result<CorrelateUpdate, DebuggenError>> {
    let batch: TouchedBatch;

    try {
      batch = collectTouched(events);
    } catch (thrown) {
      // Only a malformed element — one no store row can produce — makes the
      // scan throw. The batch is persisted, but which traces it changed is
      // unknown, so nothing cached can be trusted to match the store: every
      // tree goes, every read in flight is marked stale, and each scope
      // rebuilds from the store on its next read.
      const released = releaseEverything();

      invalidations += released.dropped;
      log.warn('a persisted batch could not be scanned; every cached trace was dropped', {
        invalidated: released.dropped,
        staleReads: released.staleReads,
        cachedTraces: cache.size,
        cachedNodes,
        cachedWeight,
      });
      return Promise.resolve(
        err(
          asReportableError(
            thrown,
            'INTERNAL',
            'Scanning a persisted telemetry batch for the traces it touched failed.',
            BATCH_SCAN_FAILURE_HINT,
            { operation: 'marking the traces of a persisted batch stale' },
          ),
        ),
      );
    }

    let extended = 0;
    let unchanged = 0;
    let invalidated = 0;
    let nodesBuilt = 0;
    let staleReads = 0;
    const dropReasons: Partial<Record<DropReason, number>> = {};

    // Exactly the scopes whose event sets the batch changed: each touched
    // trace's session-wide tree, and its trees for the captures the batch
    // named. Captures the batch did not name keep theirs untouched.
    for (const touched of batch.traces) {
      for (const scope of changedScopes(touched)) {
        const outcome = applyToCached(scope);

        switch (outcome.kind) {
          case 'extended':
            extended += 1;
            nodesBuilt += outcome.nodesBuilt;
            break;
          case 'unchanged':
            unchanged += 1;
            break;
          case 'dropped':
            invalidated += 1;
            dropReasons[outcome.reason] = (dropReasons[outcome.reason] ?? 0) + 1;
            break;
          case 'uncached':
            break;
        }

        // A read of the scope still in flight loaded the store before this
        // batch, so it must not cache what it loaded, whatever happened above.
        staleReads += markKeyStale(scope.key);
      }
    }

    extensions += extended;
    extensionNodesBuilt += nodesBuilt;
    invalidations += invalidated;

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
      // Counts and the closed refusal vocabulary only — never an event field.
      log.debug('brought the cached traces a persisted batch touched up to date', {
        batchSize: events.length,
        tracesTouched: batch.traces.length,
        extended,
        nodesBuilt,
        unchanged,
        invalidated,
        ...(invalidated > 0 ? { dropReasons } : {}),
        staleReads,
        cachedTraces: cache.size,
        cachedNodes,
        cachedWeight,
      });
    }

    return Promise.resolve(ok({ tracesTouched: batch.traces.map((touched) => touched.traceId) }));
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

    // Registered before the first `await`, so a batch or an invalidation of
    // this scope that lands at any point while the load is in flight marks it;
    // released in the `finally`, however the load ends.
    const read = beginRead(key, { sessionId, captureId, traceId });

    try {
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

      if (read.stale) {
        // The tree is what the store held when this read began, so it answers
        // this read; the store has changed since, so it must not answer a
        // later one. The next read of the scope rebuilds from the store.
        log.debug(
          'the trace changed while it was being read; the tree answered the read uncached',
          {
            ...traceScopeFields(sessionId, traceId, captureId),
            nodeCount: built.value.nodeCount,
          },
        );
        return ok(built.value);
      }

      // Cached without an index: most trees are read and never touched by a
      // later batch, so the index is built only when a batch first needs it.
      remember(key, { sessionId, captureId, traceId }, { tree: built.value, extension: undefined });
      return ok(built.value);
    } finally {
      endRead(key, read);
    }
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
      cachedNodes,
    });

    return ok(trees);
  }

  function invalidate(sessionId: SessionId, traceId?: TraceId): void {
    // Every scope goes: the session-wide tree and each capture-scoped tree of
    // the trace — or of the whole session — alike, and every read in flight
    // for those scopes, matched by the same rule.
    const removed = forget(sessionId, traceId);
    const staleReads = markReadsStale((scope) => isWithin(scope, sessionId, traceId));

    invalidations += removed;

    if (traceId !== undefined) {
      log.debug('invalidated a cached trace', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        traceId,
        removed,
        staleReads,
        cachedTraces: cache.size,
        cachedNodes,
      });
      return;
    }

    log.debug("invalidated a session's cached traces", {
      [LOG_BINDING_KEYS.sessionId]: sessionId,
      removed,
      staleReads,
      cachedTraces: cache.size,
      cachedNodes,
    });
  }

  function stats(): CorrelatorStats {
    return {
      cachedTraces: cache.size,
      cachedNodes,
      cachedWeight,
      hits,
      misses,
      rebuilds,
      invalidations,
      extensions,
      extensionNodesBuilt,
    };
  }

  function close(): void {
    const released = releaseEverything();

    log.debug('released the correlated trace cache', {
      released: released.dropped,
      staleReads: released.staleReads,
      hits,
      misses,
      rebuilds,
      invalidations,
      extensions,
      extensionNodesBuilt,
    });
  }

  return { onEventsPersisted, getTrace, getTraces, listTraceIds, invalidate, stats, close };
}
